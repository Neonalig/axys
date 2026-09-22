// SPDX-License-Identifier: AGPL-3.0-or-later

//! Spectral envelope estimation and correction, used to keep timbre steady while pitch moves.
//!
//! The envelope is the slow part of the log magnitude spectrum: the resonances of the vocal
//! tract, without the harmonic comb the fundamental produces. Cepstral liftering separates the
//! two by low-pass filtering the log spectrum along quefrency. Frames are expected to be
//! windowed by the caller.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Smallest magnitude fed to the logarithm, which bounds the dynamic range of the envelope.
const LOG_FLOOR: f64 = 1e-12;

/// Largest exponent restored after liftering, which keeps a degenerate frame finite.
const MAX_LOG_ENVELOPE: f64 = 60.0;

/// Largest per-bin gain a correction may apply, in either direction.
const MAX_CORRECTION_GAIN: f32 = 32.0;

/// How formants are treated while pitch moves.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormantMode {
    /// Formants ride with pitch, as a plain resampling would do.
    Follow,
    /// The spectral envelope is held while pitch moves.
    #[default]
    Preserve,
    /// The envelope is held and then shifted by a user amount in semitones.
    Shift(f64),
}

/// Reusable FFT plans for envelope work at one fixed frame length.
///
/// Holding one of these keeps the planner and its scratch out of a per-frame hot path. The
/// free functions in this module are the same operations with the plans built on demand.
pub struct FormantProcessor {
    len: usize,
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    buffer: Vec<Complex<f64>>,
}

impl FormantProcessor {
    /// Builds plans for frames of exactly `len` samples.
    pub fn new(len: usize) -> Self {
        let mut planner = FftPlanner::<f64>::new();
        let plan_len = len.max(1);
        FormantProcessor {
            len,
            forward: planner.plan_fft_forward(plan_len),
            inverse: planner.plan_fft_inverse(plan_len),
            buffer: vec![Complex::new(0.0, 0.0); plan_len],
        }
    }

    /// Frame length these plans serve.
    pub fn len(&self) -> usize {
        self.len
    }

    /// True when the processor was built for an empty frame.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Number of bins in a magnitude spectrum of this frame length.
    pub fn spectrum_len(&self) -> usize {
        spectrum_len(self.len)
    }

    /// Estimates the spectral envelope of `frame` with a quefrency cutoff of `order` bins.
    pub fn envelope(&mut self, frame: &[f32], order: usize) -> Vec<f32> {
        let n = self.len;
        let half = spectrum_len(n);
        if n == 0 || frame.len() != n || !frame.iter().all(|s| s.is_finite()) {
            return vec![0.0; half];
        }

        for (slot, &sample) in self.buffer.iter_mut().zip(frame) {
            *slot = Complex::new(f64::from(sample), 0.0);
        }
        self.forward.process(&mut self.buffer);

        for slot in &mut self.buffer {
            let magnitude = slot.norm().max(LOG_FLOOR);
            *slot = Complex::new(magnitude.ln(), 0.0);
        }

        // The log spectrum is real and even, so a forward transform yields the real cepstrum
        // scaled by n. Liftering keeps the low-quefrency part, which is the envelope.
        self.forward.process(&mut self.buffer);
        let cut = order.min(n / 2);
        for (q, slot) in self.buffer.iter_mut().enumerate() {
            if q <= cut || q >= n - cut {
                *slot = Complex::new(slot.re, 0.0);
            } else {
                *slot = Complex::new(0.0, 0.0);
            }
        }
        self.forward.process(&mut self.buffer);

        let scale = 1.0 / n as f64;
        self.buffer[..half]
            .iter()
            .map(|bin| {
                let log_magnitude = (bin.re * scale).clamp(-MAX_LOG_ENVELOPE, MAX_LOG_ENVELOPE);
                log_magnitude.exp() as f32
            })
            .collect()
    }

    /// Re-imposes `target_envelope` on `frame`, which already carries `source_envelope`.
    pub fn correct(&mut self, frame: &mut [f32], source_envelope: &[f32], target_envelope: &[f32]) {
        let n = self.len;
        let half = spectrum_len(n);
        if n == 0
            || frame.len() != n
            || source_envelope.len() != half
            || target_envelope.len() != half
            || !frame.iter().all(|s| s.is_finite())
        {
            return;
        }

        for (slot, &sample) in self.buffer.iter_mut().zip(frame.iter()) {
            *slot = Complex::new(f64::from(sample), 0.0);
        }
        self.forward.process(&mut self.buffer);

        for k in 0..half {
            let gain = f64::from(bin_gain(source_envelope[k], target_envelope[k]));
            self.buffer[k] *= gain;
            let mirror = n - k;
            if k > 0 && mirror >= half && mirror < n {
                self.buffer[mirror] *= gain;
            }
        }

        self.inverse.process(&mut self.buffer);
        let scale = 1.0 / n as f64;
        for (sample, bin) in frame.iter_mut().zip(self.buffer.iter()) {
            let value = bin.re * scale;
            *sample = if value.is_finite() { value as f32 } else { 0.0 };
        }
    }
}

/// Estimates a spectral envelope by cepstral liftering.
///
/// `order` is the quefrency cutoff in bins; 40 suits speech at 48 kHz.
pub fn spectral_envelope(frame: &[f32], order: usize) -> Vec<f32> {
    let mut processor = FormantProcessor::new(frame.len());
    processor.envelope(frame, order)
}

/// Re-imposes `target_envelope` on `frame`, which already carries `source_envelope`.
///
/// Both envelopes are magnitude spectra of the same length as the frame's rFFT output.
pub fn apply_envelope_correction(
    frame: &mut [f32],
    source_envelope: &[f32],
    target_envelope: &[f32],
) {
    let mut processor = FormantProcessor::new(frame.len());
    processor.correct(frame, source_envelope, target_envelope);
}

/// Warps a magnitude envelope by `ratio` along frequency, resampling linearly.
pub fn warp_envelope(envelope: &[f32], ratio: f64) -> Vec<f32> {
    let n = envelope.len();
    if n == 0 {
        return Vec::new();
    }
    if !ratio.is_finite() || ratio <= 0.0 || ratio == 1.0 {
        return envelope.to_vec();
    }

    let last = (n - 1) as f64;
    (0..n)
        .map(|bin| {
            let position = bin as f64 / ratio;
            if position <= 0.0 {
                envelope[0]
            } else if position >= last {
                envelope[n - 1]
            } else {
                let lower = position.floor();
                let fraction = (position - lower) as f32;
                let index = lower as usize;
                envelope[index] + (envelope[index + 1] - envelope[index]) * fraction
            }
        })
        .collect()
}

/// Number of bins a real frame of `len` samples produces.
fn spectrum_len(len: usize) -> usize {
    if len == 0 {
        0
    } else {
        len / 2 + 1
    }
}

/// Correction factor for one bin, falling back to unity where the source carries nothing.
fn bin_gain(source: f32, target: f32) -> f32 {
    if !source.is_finite() || !target.is_finite() || source <= 0.0 || target < 0.0 {
        return 1.0;
    }
    let gain = target / source;
    if !gain.is_finite() {
        return 1.0;
    }
    gain.clamp(1.0 / MAX_CORRECTION_GAIN, MAX_CORRECTION_GAIN)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    const SAMPLE_RATE: f64 = 48_000.0;
    const FRAME: usize = 2048;

    fn hann(len: usize) -> Vec<f64> {
        (0..len)
            .map(|i| 0.5 - 0.5 * (TAU * i as f64 / len as f64).cos())
            .collect()
    }

    fn resonance(freq: f64, centre: f64, width: f64) -> f64 {
        let x = (freq - centre) / width;
        (-0.5 * x * x).exp()
    }

    /// Harmonics of `f0` shaped by two Gaussian formants, windowed and ready for analysis.
    fn two_formant_frame(f0: f64, first: f64, second: f64) -> Vec<f32> {
        let window = hann(FRAME);
        let mut out = vec![0.0f32; FRAME];
        let mut harmonic = 1;
        while (harmonic as f64) * f0 < SAMPLE_RATE / 2.0 - f0 {
            let freq = harmonic as f64 * f0;
            let amplitude =
                resonance(freq, first, 140.0) + 0.7 * resonance(freq, second, 200.0) + 0.01;
            let phase_step = TAU * freq / SAMPLE_RATE;
            for (i, sample) in out.iter_mut().enumerate() {
                *sample += (amplitude * (phase_step * i as f64).sin() * window[i]) as f32;
            }
            harmonic += 1;
        }
        out
    }

    fn bin_of(freq: f64) -> usize {
        (freq * FRAME as f64 / SAMPLE_RATE).round() as usize
    }

    fn freq_of(bin: usize) -> f64 {
        bin as f64 * SAMPLE_RATE / FRAME as f64
    }

    fn argmax(values: &[f32], from: usize, to: usize) -> usize {
        let mut best = from;
        for bin in from..to.min(values.len()) {
            if values[bin] > values[best] {
                best = bin;
            }
        }
        best
    }

    #[test]
    fn envelope_peaks_near_the_formants() {
        let frame = two_formant_frame(125.0, 700.0, 2200.0);
        let envelope = spectral_envelope(&frame, 40);
        assert_eq!(envelope.len(), FRAME / 2 + 1);
        assert!(envelope.iter().all(|v| v.is_finite() && *v >= 0.0));

        let first = argmax(&envelope, bin_of(300.0), bin_of(1300.0));
        let second = argmax(&envelope, bin_of(1500.0), bin_of(3000.0));
        assert!(
            (freq_of(first) - 700.0).abs() < 250.0,
            "first formant found at {} Hz",
            freq_of(first)
        );
        assert!(
            (freq_of(second) - 2200.0).abs() < 300.0,
            "second formant found at {} Hz",
            freq_of(second)
        );
    }

    #[test]
    fn envelope_dips_between_the_formants() {
        let frame = two_formant_frame(125.0, 700.0, 2200.0);
        let envelope = spectral_envelope(&frame, 40);
        let valley = argmax(&envelope, bin_of(1400.0), bin_of(1500.0));
        assert!(envelope[bin_of(700.0)] > envelope[valley]);
        assert!(envelope[bin_of(2200.0)] > envelope[valley]);
        assert!(envelope[bin_of(2200.0)] > envelope[bin_of(6000.0)]);
    }

    #[test]
    fn envelope_ignores_the_harmonic_comb() {
        // Two frames differing only in fundamental should share an envelope shape.
        let low = spectral_envelope(&two_formant_frame(110.0, 700.0, 2200.0), 40);
        let high = spectral_envelope(&two_formant_frame(190.0, 700.0, 2200.0), 40);
        let peak_low = argmax(&low, bin_of(300.0), bin_of(1300.0));
        let peak_high = argmax(&high, bin_of(300.0), bin_of(1300.0));
        assert!((freq_of(peak_low) - freq_of(peak_high)).abs() < 200.0);
    }

    #[test]
    fn low_order_flattens_the_envelope() {
        let frame = two_formant_frame(125.0, 700.0, 2200.0);
        let flat = spectral_envelope(&frame, 0);
        let first = flat[0];
        assert!(flat
            .iter()
            .all(|v| (v - first).abs() < 1e-6 * first.max(1.0)));
    }

    #[test]
    fn envelope_rejects_bad_input() {
        assert!(spectral_envelope(&[], 40).is_empty());
        let nan = vec![f32::NAN; 64];
        assert_eq!(spectral_envelope(&nan, 8), vec![0.0; 33]);
        let infinite = vec![f32::INFINITY; 64];
        assert_eq!(spectral_envelope(&infinite, 8), vec![0.0; 33]);
        let silence = spectral_envelope(&vec![0.0f32; 64], 8);
        assert!(silence.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn envelope_tolerates_odd_lengths_and_huge_order() {
        let frame: Vec<f32> = (0..101)
            .map(|i| (TAU * 7.0 * i as f64 / 101.0).sin() as f32)
            .collect();
        let envelope = spectral_envelope(&frame, usize::MAX);
        assert_eq!(envelope.len(), 51);
        assert!(envelope.iter().all(|v| v.is_finite()));
    }

    #[test]
    fn warping_by_one_is_identity() {
        let envelope: Vec<f32> = (0..64).map(|i| (i as f32 * 0.37).sin() + 2.0).collect();
        assert_eq!(warp_envelope(&envelope, 1.0), envelope);
    }

    #[test]
    fn warping_by_two_doubles_the_peak_bin() {
        let mut envelope = vec![0.1f32; 128];
        for (offset, value) in [(-2isize, 0.4f32), (-1, 0.8), (0, 1.0), (1, 0.8), (2, 0.4)] {
            envelope[(20 + offset) as usize] = value;
        }
        let warped = warp_envelope(&envelope, 2.0);
        assert_eq!(warped.len(), envelope.len());
        assert_eq!(argmax(&warped, 0, warped.len()), 40);

        let squeezed = warp_envelope(&envelope, 0.5);
        assert_eq!(argmax(&squeezed, 0, squeezed.len()), 10);
    }

    #[test]
    fn warping_holds_the_edges_and_rejects_bad_ratios() {
        let envelope: Vec<f32> = (0..16).map(|i| i as f32).collect();
        let stretched = warp_envelope(&envelope, 4.0);
        assert!((stretched[15] - 15.0 / 4.0).abs() < 1e-5);
        let squashed = warp_envelope(&envelope, 0.25);
        assert_eq!(squashed[15], 15.0);

        assert_eq!(warp_envelope(&envelope, 0.0), envelope);
        assert_eq!(warp_envelope(&envelope, -2.0), envelope);
        assert_eq!(warp_envelope(&envelope, f64::NAN), envelope);
        assert_eq!(warp_envelope(&envelope, f64::INFINITY), envelope);
        assert!(warp_envelope(&[], 2.0).is_empty());
        assert_eq!(warp_envelope(&[5.0], 2.0), vec![5.0]);
    }

    #[test]
    fn equal_envelopes_leave_a_frame_unchanged() {
        let original = two_formant_frame(125.0, 700.0, 2200.0);
        let envelope = spectral_envelope(&original, 40);
        let mut frame = original.clone();
        apply_envelope_correction(&mut frame, &envelope, &envelope);
        for (before, after) in original.iter().zip(&frame) {
            assert!(
                (before - after).abs() < 1e-5,
                "{before} became {after} under a unity correction"
            );
        }
    }

    #[test]
    fn correction_moves_energy_towards_the_target_envelope() {
        let frame_source = two_formant_frame(125.0, 700.0, 2200.0);
        let source = spectral_envelope(&frame_source, 40);
        let target = warp_envelope(&source, 1.25);

        let mut frame = frame_source.clone();
        apply_envelope_correction(&mut frame, &source, &target);
        assert!(frame.iter().all(|s| s.is_finite()));

        let corrected = spectral_envelope(&frame, 40);
        let moved = argmax(&corrected, bin_of(300.0), bin_of(1600.0));
        let started = argmax(&source, bin_of(300.0), bin_of(1600.0));
        assert!(
            freq_of(moved) > freq_of(started) + 50.0,
            "peak moved from {} Hz to {} Hz",
            freq_of(started),
            freq_of(moved)
        );
    }

    #[test]
    fn correction_is_a_no_op_on_mismatched_or_bad_input() {
        let original = vec![0.25f32, -0.5, 0.75, 1.0, -0.25, 0.5, 0.0, -1.0];
        let half = original.len() / 2 + 1;

        let mut frame = original.clone();
        apply_envelope_correction(&mut frame, &vec![1.0; half - 1], &vec![1.0; half]);
        assert_eq!(frame, original);

        let mut frame = original.clone();
        apply_envelope_correction(&mut frame, &vec![1.0; half], &[]);
        assert_eq!(frame, original);

        let mut frame: Vec<f32> = Vec::new();
        apply_envelope_correction(&mut frame, &[], &[]);
        assert!(frame.is_empty());

        let mut frame = vec![f32::NAN; original.len()];
        apply_envelope_correction(&mut frame, &vec![1.0; half], &vec![2.0; half]);
        assert!(frame.iter().all(|s| s.is_nan()));
    }

    #[test]
    fn correction_clamps_extreme_gains() {
        let original: Vec<f32> = (0..64)
            .map(|i| (TAU * 4.0 * i as f64 / 64.0).sin() as f32)
            .collect();
        let half = 33;
        let mut frame = original.clone();
        apply_envelope_correction(&mut frame, &vec![1e-30; half], &vec![1.0; half]);
        assert!(frame.iter().all(|s| s.is_finite()));
        let loudest = frame.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        let quietest = original.iter().fold(0.0f32, |acc, s| acc.max(s.abs()));
        assert!(loudest <= quietest * MAX_CORRECTION_GAIN + 1e-3);
    }

    #[test]
    fn zero_source_bins_pass_through_unchanged() {
        assert_eq!(bin_gain(0.0, 4.0), 1.0);
        assert_eq!(bin_gain(f32::NAN, 1.0), 1.0);
        assert_eq!(bin_gain(1.0, f32::NAN), 1.0);
        assert_eq!(bin_gain(1.0, -1.0), 1.0);
        assert_eq!(bin_gain(2.0, 1.0), 0.5);
        assert_eq!(bin_gain(1.0, 1e9), MAX_CORRECTION_GAIN);
        assert_eq!(bin_gain(1e9, 1.0), 1.0 / MAX_CORRECTION_GAIN);
    }

    #[test]
    fn processor_matches_the_free_functions() {
        let frame = two_formant_frame(150.0, 650.0, 1900.0);
        let mut processor = FormantProcessor::new(frame.len());
        assert_eq!(processor.len(), FRAME);
        assert!(!processor.is_empty());
        assert_eq!(processor.spectrum_len(), FRAME / 2 + 1);
        assert_eq!(
            processor.envelope(&frame, 40),
            spectral_envelope(&frame, 40)
        );

        let wrong_length = vec![0.0f32; FRAME - 1];
        assert_eq!(
            processor.envelope(&wrong_length, 40),
            vec![0.0; FRAME / 2 + 1]
        );

        let empty = FormantProcessor::new(0);
        assert!(empty.is_empty());
        assert_eq!(empty.spectrum_len(), 0);
    }

    #[test]
    fn formant_mode_defaults_to_preserve_and_round_trips() {
        assert_eq!(FormantMode::default(), FormantMode::Preserve);
        for mode in [
            FormantMode::Follow,
            FormantMode::Preserve,
            FormantMode::Shift(-3.5),
        ] {
            let json = serde_json::to_string(&mode).expect("serialise");
            let back: FormantMode = serde_json::from_str(&json).expect("deserialise");
            assert_eq!(mode, back);
        }
    }
}
