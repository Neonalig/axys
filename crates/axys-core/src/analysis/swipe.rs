// SPDX-License-Identifier: AGPL-3.0-or-later

//! SWIPE', pitch as the strength of a harmonic kernel over the loudness spectrum.
//!
//! Camacho and Harris, "A sawtooth waveform inspired pitch estimator for speech and music"
//! (JASA 124(3), 2008). For each pitch candidate a kernel of cosine lobes sits on the
//! candidate's first and prime harmonics, and the candidate's strength is the kernel's inner
//! product with the square root of the magnitude spectrum on an ERB-spaced grid. Each candidate
//! is measured with the window whose length best suits it, eight periods, blended between the two
//! power-of-two lengths either side, which is what lets one pass read low and high voices alike.
//!
//! Each frame is measured from its own window alone, decimated to at most [`ANALYSIS_RATE`] Hz
//! first, so spans observed apart decode exactly as one run.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::f64::consts::TAU;
use std::sync::Arc;

use super::f0::{F0Candidates, F0Params};
use crate::{AxysError, Result};

/// Highest rate the spectrum is measured at. Vocal pitch needs nothing above its eighth harmonic.
const ANALYSIS_RATE: f64 = 16_000.0;

/// Pitch candidates per octave.
const CANDIDATES_PER_OCTAVE: f64 = 32.0;

/// Spacing of the loudness grid, in ERB-rate units.
const ERB_STEP: f64 = 0.2;

/// Periods of a candidate its ideal window holds.
const PERIODS_PER_WINDOW: f64 = 8.0;

/// Taps of the decimation filter.
const DECIMATION_TAPS: usize = 48;

/// Most candidates one frame reports.
const FRAME_CANDIDATES: usize = 8;

/// One window length's transform and the loudness it measures.
struct Band {
    size: usize,
    fft: Arc<dyn Fft<f64>>,
    window: Vec<f64>,
    buffer: Vec<Complex<f64>>,
    magnitude: Vec<f64>,
    loudness: Vec<f64>,
    /// Whether any candidate reads this band, so an unread band is never transformed.
    used: bool,
}

/// Reusable SWIPE' state for one run.
pub(super) struct Swipe {
    factor: usize,
    rate: f64,
    filter: Vec<f64>,
    decimated: Vec<f64>,
    /// Log2 of the shortest window length.
    first_power: i32,
    bands: Vec<Band>,
    /// Loudness grid frequencies, in Hz.
    grid: Vec<f64>,
    /// Candidate pitches in Hz, ascending.
    pitches: Vec<f64>,
    /// Per candidate: the lower band it reads, the weight on the upper one, and its kernel.
    reads: Vec<(usize, f64)>,
    kernels: Vec<Vec<f32>>,
    strengths: Vec<f64>,
}

impl Swipe {
    /// Decimation factor and analysis rate for a source rate.
    fn rates(sample_rate: f64) -> (usize, f64) {
        let factor = ((sample_rate / ANALYSIS_RATE).floor() as usize).max(1);
        (factor, sample_rate / factor as f64)
    }

    /// Log2 of the shortest and longest window lengths the pitch range needs.
    fn powers(rate: f64, params: &F0Params) -> (i32, i32) {
        let power = |hz: f64| (PERIODS_PER_WINDOW * rate / hz).log2().round() as i32;
        (power(params.max_hz).max(4), power(params.min_hz).max(5))
    }

    /// Source samples one frame reads: the longest window, decimated, plus the filter's reach.
    pub(super) fn frame_len(sample_rate: f64, params: &F0Params) -> usize {
        let (factor, rate) = Self::rates(sample_rate);
        let (_, last) = Self::powers(rate, params);
        (1usize << (last + 1)) * factor + DECIMATION_TAPS
    }

    pub(super) fn new(sample_rate: f64, frame_len: usize, params: &F0Params) -> Result<Self> {
        let (factor, rate) = Self::rates(sample_rate);
        let (first, last) = Self::powers(rate, params);
        if params.min_hz <= 0.0 || params.max_hz <= params.min_hz || params.max_hz >= rate / 2.0 {
            return Err(AxysError::Invalid(format!(
                "pitch range {}..{} Hz does not fit a {rate} Hz analysis",
                params.min_hz, params.max_hz
            )));
        }
        // One band past each end, so every candidate has a band either side to blend between.
        let mut planner = FftPlanner::<f64>::new();
        let bands: Vec<Band> = (first - 1..=last + 1)
            .map(|power| {
                let size = 1usize << power.max(2);
                Band {
                    size,
                    fft: planner.plan_fft_forward(size),
                    window: (0..size)
                        .map(|i| 0.5 - 0.5 * (TAU * (i as f64 + 0.5) / size as f64).cos())
                        .collect(),
                    buffer: vec![Complex::new(0.0, 0.0); size],
                    magnitude: vec![0.0; size / 2 + 1],
                    loudness: Vec::new(),
                    used: false,
                }
            })
            .collect();

        let erb = |hz: f64| 21.4 * (1.0 + hz / 229.0).log10();
        let from_erb = |value: f64| (10f64.powf(value / 21.4) - 1.0) * 229.0;
        let mut grid = Vec::new();
        let mut value = erb(params.min_hz / 4.0);
        let top = erb(rate / 2.0);
        while value <= top {
            grid.push(from_erb(value));
            value += ERB_STEP;
        }

        let octaves = (params.max_hz / params.min_hz).log2();
        let count = (octaves * CANDIDATES_PER_OCTAVE).ceil() as usize + 1;
        let pitches: Vec<f64> = (0..count)
            .map(|i| params.min_hz * 2f64.powf(i as f64 / CANDIDATES_PER_OCTAVE))
            .filter(|hz| *hz <= params.max_hz * 1.0001)
            .collect();

        let mut swipe = Self {
            factor,
            rate,
            filter: lowpass(0.45 / factor as f64, DECIMATION_TAPS),
            decimated: vec![0.0; frame_len.saturating_sub(DECIMATION_TAPS) / factor],
            first_power: first - 1,
            bands,
            grid,
            pitches,
            reads: Vec::new(),
            kernels: Vec::new(),
            strengths: Vec::new(),
        };
        let last_band = swipe.bands.len() - 1;
        for index in 0..swipe.pitches.len() {
            let pitch = swipe.pitches[index];
            let ideal = (PERIODS_PER_WINDOW * swipe.rate / pitch).log2() - swipe.first_power as f64;
            let lower = (ideal.floor().max(0.0) as usize).min(last_band - 1);
            let upper = (ideal - lower as f64).clamp(0.0, 1.0);
            swipe.bands[lower].used = true;
            swipe.bands[lower + 1].used = true;
            swipe.reads.push((lower, upper));
            swipe.kernels.push(kernel(pitch, &swipe.grid));
        }
        swipe.strengths = vec![0.0; swipe.pitches.len()];
        Ok(swipe)
    }

    /// Measures one frame from its window and pushes its candidates.
    pub(super) fn observe(&mut self, window: &[f32], params: &F0Params, out: &mut F0Candidates) {
        let rms = window_rms(window);
        out.begin_frame(rms);
        if rms < params.voiced_rms_floor {
            out.set_unvoiced(0.0);
            out.end_frame();
            return;
        }
        self.decimate(window);
        let centre = self.decimated.len() / 2;
        for band in self.bands.iter_mut().filter(|band| band.used) {
            band.measure(&self.decimated, centre, self.rate, &self.grid);
        }
        for (index, strength) in self.strengths.iter_mut().enumerate() {
            let (lower, upper) = self.reads[index];
            let kernel = &self.kernels[index];
            let low = dot(kernel, &self.bands[lower].loudness);
            let high = dot(kernel, &self.bands[lower + 1].loudness);
            *strength = low * (1.0 - upper) + high * upper;
        }
        self.push_peaks(out, params);
        out.end_frame();
    }

    /// Low-passes and decimates the frame's window into `decimated`, zero past its end.
    fn decimate(&mut self, window: &[f32]) {
        let factor = self.factor;
        for (index, slot) in self.decimated.iter_mut().enumerate() {
            let start = index * factor;
            let mut sum = 0.0;
            for (tap, weight) in self.filter.iter().enumerate() {
                if let Some(sample) = window.get(start + tap) {
                    sum += f64::from(*sample) * weight;
                }
            }
            *slot = sum;
        }
    }

    /// Pushes the strongest local maxima of strength over the candidate grid.
    fn push_peaks(&self, out: &mut F0Candidates, params: &F0Params) {
        let strengths = &self.strengths;
        let mut peaks: Vec<(usize, f64)> = (0..strengths.len())
            .filter(|&i| {
                let here = strengths[i];
                let left = if i > 0 { strengths[i - 1] } else { f64::MIN };
                let right = strengths.get(i + 1).copied().unwrap_or(f64::MIN);
                here > left && here >= right
            })
            .map(|i| (i, strengths[i]))
            .collect();
        peaks.sort_by(|a, b| b.1.total_cmp(&a.1));
        peaks.truncate(FRAME_CANDIDATES);
        for (index, strength) in peaks {
            let pitch = self.refine(index);
            let strength = strength.clamp(-1.0, 1.0);
            out.push_candidate(pitch, 1.0 - strength, 1.0 - strength);
        }
        out.set_unvoiced(1.0 - params.strength.clamp(-1.0, 1.0));
    }

    /// Parabolic interpolation of the strength peak in log pitch.
    fn refine(&self, index: usize) -> f64 {
        let pitch = self.pitches[index];
        if index == 0 || index + 1 >= self.strengths.len() {
            return pitch;
        }
        let (prev, here, next) = (
            self.strengths[index - 1],
            self.strengths[index],
            self.strengths[index + 1],
        );
        let denom = prev - 2.0 * here + next;
        if denom.abs() < 1e-12 {
            return pitch;
        }
        let shift = (0.5 * (prev - next) / denom).clamp(-1.0, 1.0);
        pitch * 2f64.powf(shift / CANDIDATES_PER_OCTAVE)
    }
}

impl Band {
    /// Measures the normalised loudness of the window of this band's length centred on `centre`.
    fn measure(&mut self, signal: &[f64], centre: usize, rate: f64, grid: &[f64]) {
        let size = self.size;
        let start = centre as isize - (size / 2) as isize;
        for (i, slot) in self.buffer.iter_mut().enumerate() {
            let at = start + i as isize;
            let sample = if at >= 0 {
                signal.get(at as usize).copied().unwrap_or(0.0)
            } else {
                0.0
            };
            *slot = Complex::new(sample * self.window[i], 0.0);
        }
        self.fft.process(&mut self.buffer);
        for (slot, bin) in self.magnitude.iter_mut().zip(&self.buffer) {
            *slot = bin.norm();
        }
        let bin_hz = rate / size as f64;
        self.loudness.clear();
        let mut total = 0.0;
        for hz in grid {
            let position = hz / bin_hz;
            let below = position.floor() as usize;
            let fraction = position - below as f64;
            let a = self.magnitude.get(below).copied().unwrap_or(0.0);
            let b = self.magnitude.get(below + 1).copied().unwrap_or(0.0);
            let value = (a + (b - a) * fraction).max(0.0).sqrt();
            total += value * value;
            self.loudness.push(value);
        }
        let norm = total.sqrt();
        if norm > 0.0 {
            for value in &mut self.loudness {
                *value /= norm;
            }
        }
    }
}

/// The kernel of cosine lobes on a candidate's first and prime harmonics, over the grid.
///
/// Positive lobes sit on the harmonics and half-weight negative lobes between them, each
/// harmonic decaying as the square root of its frequency, scaled so the positive part has unit
/// norm.
fn kernel(pitch: f64, grid: &[f64]) -> Vec<f32> {
    let top = grid.last().copied().unwrap_or(0.0);
    let harmonics = ((top / pitch) - 0.75).floor().max(1.0) as usize;
    let mut values = vec![0.0f64; grid.len()];
    for harmonic in (1..=harmonics).filter(|h| *h == 1 || is_prime(*h)) {
        for (slot, hz) in values.iter_mut().zip(grid) {
            let q = hz / pitch;
            let distance = (q - harmonic as f64).abs();
            if distance < 0.25 {
                *slot = (TAU * q).cos();
            } else if distance < 0.75 {
                *slot += (TAU * q).cos() / 2.0;
            }
        }
    }
    for (slot, hz) in values.iter_mut().zip(grid) {
        *slot *= (1.0 / hz).sqrt();
    }
    let norm = values
        .iter()
        .filter(|v| **v > 0.0)
        .map(|v| v * v)
        .sum::<f64>()
        .sqrt();
    if norm > 0.0 {
        for slot in &mut values {
            *slot /= norm;
        }
    }
    values.into_iter().map(|v| v as f32).collect()
}

fn is_prime(n: usize) -> bool {
    n >= 2 && (2..).take_while(|d| d * d <= n).all(|d| n % d != 0)
}

fn dot(kernel: &[f32], loudness: &[f64]) -> f64 {
    kernel
        .iter()
        .zip(loudness)
        .map(|(k, l)| f64::from(*k) * l)
        .sum()
}

fn window_rms(window: &[f32]) -> f32 {
    if window.is_empty() {
        return 0.0;
    }
    let sum: f64 = window.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
    (sum / window.len() as f64).sqrt() as f32
}

/// A Hann-windowed sinc low-pass of `taps` taps at `cutoff` cycles per sample, unity at DC.
fn lowpass(cutoff: f64, taps: usize) -> Vec<f64> {
    let middle = (taps - 1) as f64 / 2.0;
    let mut filter: Vec<f64> = (0..taps)
        .map(|i| {
            let x = i as f64 - middle;
            let sinc = if x.abs() < 1e-12 {
                2.0 * cutoff
            } else {
                (TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let hann = 0.5 - 0.5 * (TAU * (i as f64 + 0.5) / taps as f64).cos();
            sinc * hann
        })
        .collect();
    let total: f64 = filter.iter().sum();
    for weight in &mut filter {
        *weight /= total;
    }
    filter
}
