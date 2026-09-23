// SPDX-License-Identifier: AGPL-3.0-or-later

//! Short-time energy, spectral flux and zero-crossing analysis.
//!
//! Produces the loudness and transient evidence that segmentation, blob display and
//! consonant handling read, on the same uniform hop grid as the pitch track.

use rustfft::num_complex::Complex;
use rustfft::FftPlanner;
use serde::{Deserialize, Serialize};
use std::ops::Range;

use crate::{limits, AxysError, Result};

/// Decibel value reported for silence.
const DB_FLOOR: f32 = -120.0;

/// Longest accepted analysis window, in seconds.
const MAX_FRAME_SECONDS: f64 = 1.0;

/// Longest accepted hop, in seconds.
const MAX_HOP_SECONDS: f64 = 1.0;

/// Lowest frame RMS that can still be a consonant rather than silence.
const CONSONANT_RMS_FLOOR: f32 = 0.002;

/// Lowest zero-crossing rate that reads as fricative or sibilant noise.
const CONSONANT_ZCR_FLOOR: f32 = 0.15;

/// Short-time energy and onset evidence on the same hop grid as a pitch track.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyTrack {
    /// Spacing between frames, in seconds.
    pub hop_seconds: f64,
    /// Frame centres in source seconds, ascending.
    pub times: Vec<f64>,
    /// Frame root mean square, 0.0..=1.0 for unclipped source.
    pub rms: Vec<f32>,
    /// Frame level in decibels, `20*log10(rms)` floored at -120.
    pub rms_db: Vec<f32>,
    /// Half-wave rectified spectral difference between successive frames, normalised to 0.0..=1.0.
    pub spectral_flux: Vec<f32>,
    /// Fraction of adjacent sample pairs in the frame that change sign, 0.0..=1.0.
    pub zero_crossing_rate: Vec<f32>,
}

impl EnergyTrack {
    /// Span covered by the frame grid, in seconds.
    pub fn duration(&self) -> f64 {
        self.times.len() as f64 * self.hop_seconds
    }

    /// Times of local flux peaks above `threshold`, at least `min_separation` seconds apart.
    ///
    /// Where peaks crowd each other the stronger one survives.
    pub fn onsets(&self, threshold: f32, min_separation: f64) -> Vec<f64> {
        let n = self.spectral_flux.len().min(self.times.len());
        if n == 0 || !threshold.is_finite() {
            return Vec::new();
        }
        let separation = if min_separation.is_finite() && min_separation > 0.0 {
            min_separation
        } else {
            0.0
        };

        let mut candidates: Vec<usize> = (0..n)
            .filter(|&i| {
                let v = self.spectral_flux[i];
                if !v.is_finite() || v < threshold {
                    return false;
                }
                let before = if i == 0 {
                    f32::NEG_INFINITY
                } else {
                    self.spectral_flux[i - 1]
                };
                let after = if i + 1 >= n {
                    f32::NEG_INFINITY
                } else {
                    self.spectral_flux[i + 1]
                };
                v > before && v >= after
            })
            .collect();

        candidates.sort_by(|&a, &b| {
            self.spectral_flux[b]
                .partial_cmp(&self.spectral_flux[a])
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.cmp(&b))
        });

        let mut kept: Vec<f64> = Vec::new();
        for i in candidates {
            let time = self.times[i];
            if kept.iter().any(|&t| (t - time).abs() < separation) {
                continue;
            }
            kept.push(time);
        }
        kept.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        kept
    }
}

/// Computes energy, spectral flux and zero-crossing rate with an FFT of `frame_seconds`.
///
/// Frames are centred on multiples of the hop, so frame `i` reports on the source at
/// `i * hop_seconds` with the window running half its length either side. The stored
/// `hop_seconds` is the requested hop quantised to whole samples.
pub fn analyse_energy(
    samples: &[f32],
    sample_rate: f64,
    frame_seconds: f64,
    hop_seconds: f64,
) -> Result<EnergyTrack> {
    let grid = EnergyGrid::new(samples.len(), sample_rate, frame_seconds, hop_seconds)?;
    let frames = observe_energy(&grid, samples, 0, 0..grid.count())?;
    grid.finish(frames)
}

/// Frame layout of one energy analysis over a source buffer.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnergyGrid {
    sample_rate: f64,
    len: usize,
    hop_len: usize,
    win_len: usize,
    count: usize,
}

impl EnergyGrid {
    /// Lays out the frames for a source buffer of `len` samples.
    ///
    /// # Errors
    /// A sample rate, window, hop or duration outside the accepted range.
    pub fn new(len: usize, sample_rate: f64, frame_seconds: f64, hop_seconds: f64) -> Result<Self> {
        if !sample_rate.is_finite()
            || sample_rate < f64::from(limits::MIN_SAMPLE_RATE)
            || sample_rate > f64::from(limits::MAX_SAMPLE_RATE)
        {
            return Err(AxysError::Invalid(format!(
                "sample rate {sample_rate} outside {}..={}",
                limits::MIN_SAMPLE_RATE,
                limits::MAX_SAMPLE_RATE
            )));
        }
        if !frame_seconds.is_finite() || frame_seconds <= 0.0 || frame_seconds > MAX_FRAME_SECONDS {
            return Err(AxysError::Invalid(format!(
                "frame seconds {frame_seconds} outside 0..={MAX_FRAME_SECONDS}"
            )));
        }
        if !hop_seconds.is_finite() || hop_seconds <= 0.0 || hop_seconds > MAX_HOP_SECONDS {
            return Err(AxysError::Invalid(format!(
                "hop seconds {hop_seconds} outside 0..={MAX_HOP_SECONDS}"
            )));
        }
        if len as f64 / sample_rate > limits::MAX_AUDIO_SECONDS {
            return Err(AxysError::Invalid(format!(
                "audio longer than {} seconds",
                limits::MAX_AUDIO_SECONDS
            )));
        }
        let hop_len = ((hop_seconds * sample_rate).round() as usize).max(1);
        let win_len = ((frame_seconds * sample_rate).round() as usize).max(2);
        Ok(Self {
            sample_rate,
            len,
            hop_len,
            win_len,
            count: len.div_ceil(hop_len),
        })
    }

    /// Frames the buffer yields.
    pub fn count(&self) -> usize {
        self.count
    }

    /// The source samples the frames in `frames` read, including those of the frame before the
    /// first, whose spectrum the first frame's flux is measured against.
    pub fn samples_for(&self, frames: Range<usize>) -> Range<usize> {
        if frames.is_empty() {
            return 0..0;
        }
        let start =
            (frames.start.saturating_sub(1) * self.hop_len).saturating_sub(self.win_len / 2);
        let end = ((frames.end - 1) * self.hop_len + self.win_len - self.win_len / 2).min(self.len);
        start.min(end)..end
    }

    /// Builds the track from the measurements of every frame, normalising the flux over the run.
    ///
    /// # Errors
    /// Measurements for other than exactly the grid's frames.
    pub fn finish(&self, frames: EnergyFrames) -> Result<EnergyTrack> {
        if frames.len() != self.count {
            return Err(AxysError::Invalid(format!(
                "{} frames of energy for a run of {} frames",
                frames.len(),
                self.count
            )));
        }
        let EnergyFrames { rms, mut flux, zcr } = frames;
        normalise(&mut flux);
        Ok(EnergyTrack {
            hop_seconds: self.hop_len as f64 / self.sample_rate,
            times: (0..self.count)
                .map(|frame| (frame * self.hop_len) as f64 / self.sample_rate)
                .collect(),
            rms_db: rms.iter().map(|value| to_db(*value)).collect(),
            rms,
            spectral_flux: flux,
            zero_crossing_rate: zcr,
        })
    }
}

/// Energy measurements for a span of frames, before the flux is normalised over the whole run.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EnergyFrames {
    rms: Vec<f32>,
    flux: Vec<f32>,
    zcr: Vec<f32>,
}

impl EnergyFrames {
    fn with_capacity(frames: usize) -> Self {
        Self {
            rms: Vec::with_capacity(frames),
            flux: Vec::with_capacity(frames),
            zcr: Vec::with_capacity(frames),
        }
    }

    /// Rebuilds measurements from one array per quantity.
    ///
    /// # Errors
    /// Arrays of different lengths, or a non-finite or negative value.
    pub fn from_parts(rms: Vec<f32>, flux: Vec<f32>, zcr: Vec<f32>) -> Result<Self> {
        if flux.len() != rms.len() || zcr.len() != rms.len() {
            return Err(AxysError::Invalid(format!(
                "{} RMS, {} flux and {} zero-crossing values",
                rms.len(),
                flux.len(),
                zcr.len()
            )));
        }
        if !rms
            .iter()
            .chain(&flux)
            .chain(&zcr)
            .all(|v| v.is_finite() && *v >= 0.0)
        {
            return Err(AxysError::Invalid(
                "energy contains a non-finite or negative value".into(),
            ));
        }
        Ok(Self { rms, flux, zcr })
    }

    /// Joins the measurements for the frames that follow this span's last.
    pub fn append(&mut self, next: EnergyFrames) {
        self.rms.extend(next.rms);
        self.flux.extend(next.flux);
        self.zcr.extend(next.zcr);
    }

    /// Frame RMS.
    pub fn rms(&self) -> &[f32] {
        &self.rms
    }

    /// Unnormalised half-wave rectified spectral difference from the frame before.
    pub fn flux(&self) -> &[f32] {
        &self.flux
    }

    /// Zero-crossing rate per frame.
    pub fn zcr(&self) -> &[f32] {
        &self.zcr
    }

    /// Frames held.
    pub fn len(&self) -> usize {
        self.rms.len()
    }

    /// True when no frames are held.
    pub fn is_empty(&self) -> bool {
        self.rms.is_empty()
    }
}

/// Measures the frames in `frames`, before the flux is normalised.
///
/// `source` holds source samples starting at sample `offset` and must cover
/// [`EnergyGrid::samples_for`] of the same frames. Spans measured apart and joined in order with
/// [`EnergyFrames::append`] finish exactly as one run over the whole buffer.
///
/// # Errors
/// Frames past the grid, a source that does not cover them, or a non-finite sample.
pub fn observe_energy(
    grid: &EnergyGrid,
    source: &[f32],
    offset: usize,
    frames: Range<usize>,
) -> Result<EnergyFrames> {
    if frames.start > frames.end || frames.end > grid.count {
        return Err(AxysError::Invalid(format!(
            "frames {}..{} outside the run's {} frames",
            frames.start, frames.end, grid.count
        )));
    }
    let needed = grid.samples_for(frames.clone());
    if needed.start < offset || needed.end > offset + source.len() {
        return Err(AxysError::Invalid(format!(
            "samples {}..{} do not cover the {}..{} the frames read",
            offset,
            offset + source.len(),
            needed.start,
            needed.end
        )));
    }
    if source.iter().any(|s| !s.is_finite()) {
        return Err(AxysError::Invalid(
            "samples contain a non-finite value".into(),
        ));
    }

    let mut out = EnergyFrames::with_capacity(frames.len());
    if frames.is_empty() {
        return Ok(out);
    }

    let win_len = grid.win_len;
    let fft_size = win_len.next_power_of_two();
    let window = hann(win_len);

    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(fft_size);
    let mut scratch = vec![Complex::new(0.0f32, 0.0f32); fft.get_inplace_scratch_len()];
    let mut buffer = vec![Complex::new(0.0f32, 0.0f32); fft_size];
    let bins = fft_size / 2 + 1;
    let mut magnitude = vec![0.0f32; bins];
    let mut previous = vec![0.0f32; bins];

    // The frame before the span is measured only for its spectrum, so the first frame's flux
    // compares against the same neighbour it would in one run over the whole buffer.
    for frame in frames.start.saturating_sub(1)..frames.end {
        let centre = frame * grid.hop_len;
        let start = centre as isize - (win_len / 2) as isize;

        let mut sum_squares = 0.0f64;
        let mut valid = 0usize;
        let mut crossings = 0usize;
        let mut pairs = 0usize;
        let mut last: Option<f32> = None;

        for (index, slot) in buffer.iter_mut().enumerate().take(win_len) {
            let at = start + index as isize;
            if at >= 0 && (at as usize) < grid.len {
                let value = source[at as usize - offset];
                *slot = Complex::new(value * window[index], 0.0);
                sum_squares += f64::from(value) * f64::from(value);
                valid += 1;
                if let Some(prev) = last {
                    pairs += 1;
                    if (prev < 0.0) != (value < 0.0) {
                        crossings += 1;
                    }
                }
                last = Some(value);
            } else {
                *slot = Complex::new(0.0, 0.0);
                last = None;
            }
        }
        for slot in buffer.iter_mut().skip(win_len) {
            *slot = Complex::new(0.0, 0.0);
        }

        fft.process_with_scratch(&mut buffer, &mut scratch);
        let mut flux = 0.0f32;
        for (bin, slot) in magnitude.iter_mut().enumerate() {
            let value = buffer[bin].norm();
            *slot = value;
            if frame > 0 {
                let rise = value - previous[bin];
                if rise > 0.0 {
                    flux += rise;
                }
            }
        }
        previous.copy_from_slice(&magnitude);
        if frame < frames.start {
            continue;
        }

        let rms = if valid == 0 {
            0.0f32
        } else {
            (sum_squares / valid as f64).sqrt() as f32
        };
        let zcr = if pairs == 0 {
            0.0f32
        } else {
            crossings as f32 / pairs as f32
        };
        out.rms.push(rms);
        out.flux.push(flux);
        out.zcr.push(zcr);
    }
    Ok(out)
}

/// Classifies a frame as likely unvoiced consonant material.
///
/// High zero-crossing rate with usable energy and no stable F0 indicates a sibilant or
/// fricative rather than silence.
pub fn is_unvoiced_consonant(rms: f32, zcr: f32, voiced: bool) -> bool {
    if voiced || !rms.is_finite() || !zcr.is_finite() {
        return false;
    }
    rms >= CONSONANT_RMS_FLOOR && zcr >= CONSONANT_ZCR_FLOOR
}

/// Builds a periodic Hann window of `len` samples.
fn hann(len: usize) -> Vec<f32> {
    if len == 0 {
        return Vec::new();
    }
    (0..len)
        .map(|i| {
            let phase = std::f64::consts::TAU * i as f64 / len as f64;
            (0.5 - 0.5 * phase.cos()) as f32
        })
        .collect()
}

/// Converts an amplitude to decibels, floored at -120.
fn to_db(amplitude: f32) -> f32 {
    if amplitude <= 0.0 || !amplitude.is_finite() {
        return DB_FLOOR;
    }
    (20.0 * f64::from(amplitude).log10()).max(f64::from(DB_FLOOR)) as f32
}

/// Scales `values` so the largest becomes 1.0, leaving an all-zero slice alone.
fn normalise(values: &mut [f32]) {
    let max = values.iter().copied().fold(0.0f32, f32::max);
    if max <= 0.0 || !max.is_finite() {
        return;
    }
    for value in values.iter_mut() {
        *value = (*value / max).clamp(0.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 16_000.0;
    const FRAME: f64 = 0.0464;
    const HOP: f64 = 0.005;

    #[test]
    fn spans_measured_apart_finish_as_one_run() {
        let mut audio = sine(220.0, 0.6, 0.4);
        audio.extend(noise(0.3, 0.2));
        audio.extend(sine(330.0, 0.4, 0.6));
        let short = sine(220.0, 0.02, 0.4);
        for audio in [&audio, &short] {
            let whole = analyse_energy(audio, SR, FRAME, HOP).unwrap();
            let grid = EnergyGrid::new(audio.len(), SR, FRAME, HOP).unwrap();
            let count = grid.count();
            for pieces in [1, 2, 5] {
                let mut joined = EnergyFrames::default();
                for piece in 0..pieces {
                    let frames = count * piece / pieces..count * (piece + 1) / pieces;
                    let span = grid.samples_for(frames.clone());
                    joined.append(
                        observe_energy(&grid, &audio[span.clone()], span.start, frames).unwrap(),
                    );
                }
                assert_eq!(grid.finish(joined).unwrap(), whole, "{pieces} pieces");
            }
        }
    }

    fn sine(hz: f64, seconds: f64, amplitude: f32) -> Vec<f32> {
        let n = (seconds * SR) as usize;
        (0..n)
            .map(|i| {
                let phase = std::f64::consts::TAU * hz * i as f64 / SR;
                amplitude * phase.sin() as f32
            })
            .collect()
    }

    fn assert_times(got: &[f64], expected: &[f64]) {
        assert_eq!(got.len(), expected.len(), "got {got:?} want {expected:?}");
        for (a, b) in got.iter().zip(expected) {
            assert!((a - b).abs() < 1e-9, "got {got:?} want {expected:?}");
        }
    }

    fn silence(seconds: f64) -> Vec<f32> {
        vec![0.0f32; (seconds * SR) as usize]
    }

    fn noise(seconds: f64, amplitude: f32) -> Vec<f32> {
        let n = (seconds * SR) as usize;
        let mut state: u32 = 0x1234_5678;
        (0..n)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let unit = (state >> 8) as f32 / 8_388_608.0 - 1.0;
                amplitude * unit
            })
            .collect()
    }

    #[test]
    fn flux_peaks_at_a_step_onset() {
        let mut samples = silence(0.4);
        samples.extend(sine(440.0, 0.4, 0.5));
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");

        let onsets = track.onsets(0.5, 0.05);
        assert!(!onsets.is_empty(), "expected an onset at the step");
        let nearest = onsets
            .iter()
            .copied()
            .min_by(|a, b| (a - 0.4).abs().total_cmp(&(b - 0.4).abs()))
            .expect("onset");
        assert!(
            (nearest - 0.4).abs() < FRAME,
            "onset at {nearest} should sit within a window of 0.4"
        );

        let peak = track
            .spectral_flux
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .expect("peak");
        assert!((track.times[peak.0] - 0.4).abs() < FRAME);
        assert!((peak.1 - 1.0).abs() < 1e-6, "flux is normalised to 1.0");
    }

    #[test]
    fn steady_tone_has_little_flux_after_its_attack() {
        let samples = sine(300.0, 0.6, 0.4);
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        let late: Vec<f32> = track
            .times
            .iter()
            .zip(&track.spectral_flux)
            .filter(|(t, _)| **t > 0.2 && **t < 0.4)
            .map(|(_, f)| *f)
            .collect();
        assert!(!late.is_empty());
        assert!(
            late.iter().all(|f| *f < 0.2),
            "sustained tone should not keep producing flux: {late:?}"
        );
    }

    #[test]
    fn rms_db_floors_at_minus_120() {
        let samples = silence(0.2);
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        assert!(!track.rms_db.is_empty());
        assert!(track.rms.iter().all(|r| *r == 0.0));
        assert!(track.rms_db.iter().all(|d| (*d - DB_FLOOR).abs() < 1e-6));
        assert_eq!(to_db(0.0), DB_FLOOR);
        assert_eq!(to_db(-1.0), DB_FLOOR);
        assert_eq!(to_db(f32::NAN), DB_FLOOR);
        assert!((to_db(1.0) - 0.0).abs() < 1e-6);
        assert!((to_db(0.1) + 20.0).abs() < 1e-4);
    }

    #[test]
    fn rms_tracks_amplitude() {
        let samples = sine(200.0, 0.5, 0.5);
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        let mid = track
            .times
            .iter()
            .position(|t| *t >= 0.25)
            .expect("mid frame");
        let expected = 0.5 / 2.0f32.sqrt();
        assert!(
            (track.rms[mid] - expected).abs() < 0.02,
            "rms {} vs {expected}",
            track.rms[mid]
        );
        assert!((track.rms_db[mid] + 9.03).abs() < 0.5);
    }

    #[test]
    fn onsets_respect_min_separation() {
        let track = EnergyTrack {
            hop_seconds: 0.01,
            times: (0..10).map(|i| i as f64 * 0.01).collect(),
            rms: vec![0.0; 10],
            rms_db: vec![DB_FLOOR; 10],
            spectral_flux: vec![0.0, 0.9, 0.0, 0.7, 0.0, 0.0, 0.8, 0.0, 0.6, 0.0],
            zero_crossing_rate: vec![0.0; 10],
        };

        assert_times(&track.onsets(0.5, 0.005), &[0.01, 0.03, 0.06, 0.08]);
        assert_times(&track.onsets(0.5, 0.03), &[0.01, 0.06]);
        assert_times(&track.onsets(0.85, 0.0), &[0.01]);

        assert!(track.onsets(2.0, 0.01).is_empty());
        assert!(track.onsets(f32::NAN, 0.01).is_empty());
        assert!((track.duration() - 0.1).abs() < 1e-12);
    }

    #[test]
    fn onsets_keep_the_stronger_of_two_crowded_peaks() {
        let track = EnergyTrack {
            hop_seconds: 0.01,
            times: (0..5).map(|i| i as f64 * 0.01).collect(),
            rms: vec![0.0; 5],
            rms_db: vec![DB_FLOOR; 5],
            spectral_flux: vec![0.0, 0.6, 0.0, 1.0, 0.0],
            zero_crossing_rate: vec![0.0; 5],
        };
        assert_times(&track.onsets(0.5, 0.05), &[0.03]);
    }

    #[test]
    fn onsets_on_an_empty_track_are_empty() {
        let track = EnergyTrack::default();
        assert!(track.onsets(0.1, 0.05).is_empty());
        assert_eq!(track.duration(), 0.0);
    }

    #[test]
    fn zero_crossing_rate_separates_noise_from_a_sine() {
        let tone = analyse_energy(&sine(220.0, 0.4, 0.5), SR, FRAME, HOP).expect("tone");
        let hiss = analyse_energy(&noise(0.4, 0.5), SR, FRAME, HOP).expect("noise");

        let mid = tone.times.iter().position(|t| *t >= 0.2).expect("frame");
        let tone_zcr = tone.zero_crossing_rate[mid];
        let noise_zcr = hiss.zero_crossing_rate[mid];

        assert!(tone_zcr < 0.05, "sine zcr {tone_zcr} should be low");
        assert!(noise_zcr > 0.3, "noise zcr {noise_zcr} should be high");
        assert!(noise_zcr <= 1.0);
        assert!((tone_zcr - 2.0 * 220.0 / SR as f32).abs() < 0.01);
    }

    #[test]
    fn unvoiced_consonant_separates_sibilance_from_silence_and_vowels() {
        let hiss = analyse_energy(&noise(0.3, 0.4), SR, FRAME, HOP).expect("noise");
        let quiet = analyse_energy(&silence(0.3), SR, FRAME, HOP).expect("silence");
        let vowel = analyse_energy(&sine(180.0, 0.3, 0.5), SR, FRAME, HOP).expect("vowel");
        let mid = 30;

        assert!(is_unvoiced_consonant(
            hiss.rms[mid],
            hiss.zero_crossing_rate[mid],
            false
        ));
        assert!(!is_unvoiced_consonant(
            quiet.rms[mid],
            quiet.zero_crossing_rate[mid],
            false
        ));
        assert!(!is_unvoiced_consonant(
            vowel.rms[mid],
            vowel.zero_crossing_rate[mid],
            true
        ));
        assert!(
            !is_unvoiced_consonant(vowel.rms[mid], vowel.zero_crossing_rate[mid], false),
            "a low zero-crossing vowel is not consonant material even when unvoiced"
        );
    }

    #[test]
    fn unvoiced_consonant_rejects_nonsense() {
        assert!(!is_unvoiced_consonant(f32::NAN, 0.5, false));
        assert!(!is_unvoiced_consonant(0.5, f32::NAN, false));
        assert!(!is_unvoiced_consonant(f32::INFINITY, 0.5, false));
        assert!(!is_unvoiced_consonant(-1.0, 0.5, false));
        assert!(!is_unvoiced_consonant(0.5, 0.5, true));
        assert!(is_unvoiced_consonant(
            CONSONANT_RMS_FLOOR,
            CONSONANT_ZCR_FLOOR,
            false
        ));
    }

    #[test]
    fn grid_matches_the_requested_hop() {
        let samples = sine(200.0, 1.0, 0.3);
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        assert!((track.hop_seconds - HOP).abs() < 1e-9);
        assert_eq!(track.times.len(), 200);
        assert_eq!(track.rms.len(), track.times.len());
        assert_eq!(track.rms_db.len(), track.times.len());
        assert_eq!(track.spectral_flux.len(), track.times.len());
        assert_eq!(track.zero_crossing_rate.len(), track.times.len());
        assert_eq!(track.spectral_flux[0], 0.0);
        for pair in track.times.windows(2) {
            assert!((pair[1] - pair[0] - HOP).abs() < 1e-9);
        }
        assert!(track.spectral_flux.iter().all(|f| (0.0..=1.0).contains(f)));
        assert!((track.duration() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn empty_input_produces_an_empty_track() {
        let track = analyse_energy(&[], SR, FRAME, HOP).expect("analysis");
        assert!(track.times.is_empty());
        assert!(track.rms.is_empty());
        assert!((track.hop_seconds - HOP).abs() < 1e-9);
    }

    #[test]
    fn a_single_sample_produces_one_frame() {
        let track = analyse_energy(&[0.5], SR, FRAME, HOP).expect("analysis");
        assert_eq!(track.times.len(), 1);
        assert_eq!(track.spectral_flux[0], 0.0);
        assert_eq!(track.zero_crossing_rate[0], 0.0);
        assert!(track.rms[0] > 0.0);
    }

    #[test]
    fn invalid_parameters_are_rejected() {
        assert!(analyse_energy(&[0.0], 0.0, FRAME, HOP).is_err());
        assert!(analyse_energy(&[0.0], f64::NAN, FRAME, HOP).is_err());
        assert!(analyse_energy(&[0.0], 1e9, FRAME, HOP).is_err());
        assert!(analyse_energy(&[0.0], SR, 0.0, HOP).is_err());
        assert!(analyse_energy(&[0.0], SR, -1.0, HOP).is_err());
        assert!(analyse_energy(&[0.0], SR, 60.0, HOP).is_err());
        assert!(analyse_energy(&[0.0], SR, FRAME, 0.0).is_err());
        assert!(analyse_energy(&[0.0], SR, FRAME, f64::INFINITY).is_err());
        assert!(analyse_energy(&[0.0, f32::NAN], SR, FRAME, HOP).is_err());
        assert!(analyse_energy(&[f32::INFINITY], SR, FRAME, HOP).is_err());
    }

    #[test]
    fn a_hop_shorter_than_a_sample_still_yields_a_grid() {
        let samples = sine(200.0, 0.01, 0.3);
        let track = analyse_energy(&samples, SR, 0.001, 1e-9).expect("analysis");
        assert!((track.hop_seconds - 1.0 / SR).abs() < 1e-12);
        assert_eq!(track.times.len(), samples.len());
    }

    #[test]
    fn dc_offset_has_no_zero_crossings() {
        let samples = vec![0.4f32; (0.2 * SR) as usize];
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        let mid = track.times.iter().position(|t| *t >= 0.1).expect("frame");
        assert_eq!(track.zero_crossing_rate[mid], 0.0);
        assert!((track.rms[mid] - 0.4).abs() < 1e-5);
    }

    #[test]
    fn alternating_samples_cross_on_every_pair() {
        let samples: Vec<f32> = (0..(0.2 * SR) as usize)
            .map(|i| if i % 2 == 0 { 0.5 } else { -0.5 })
            .collect();
        let track = analyse_energy(&samples, SR, FRAME, HOP).expect("analysis");
        let mid = track.times.iter().position(|t| *t >= 0.1).expect("frame");
        assert!((track.zero_crossing_rate[mid] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn hann_window_is_periodic() {
        let w = hann(8);
        assert_eq!(w.len(), 8);
        assert!(w[0].abs() < 1e-6);
        assert!((w[4] - 1.0).abs() < 1e-6);
        assert!((w[1] - w[7]).abs() < 1e-6);
        assert!(hann(0).is_empty());
    }

    #[test]
    fn normalise_leaves_silence_alone() {
        let mut values = vec![0.0f32; 4];
        normalise(&mut values);
        assert_eq!(values, vec![0.0; 4]);

        let mut values = vec![0.5f32, 2.0, 1.0];
        normalise(&mut values);
        assert_eq!(values, vec![0.25, 1.0, 0.5]);
    }
}
