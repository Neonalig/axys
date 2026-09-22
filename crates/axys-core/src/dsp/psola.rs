// SPDX-License-Identifier: AGPL-3.0-or-later

//! Time-domain pitch-synchronous overlap-add, and the pitch marks it runs on.
//!
//! The synthesiser is TD-PSOLA as described by Moulines and Charpentier, "Pitch-synchronous
//! waveform processing techniques for text-to-speech synthesis using diphones" (Speech
//! Communication 9(5-6), 1990): the source is cut into Hann-windowed grains spanning two
//! local periods and centred on glottal pulses, and those grains are overlap-added at the
//! period the target asks for.
//!
//! Every grain is a function of its output sample position alone. The grain phase is
//! recomputed by integrating the target period from output sample 0 on each call rather
//! than carried in state, so rendering `[a, b)` as one call and as many calls yields
//! byte-identical samples. The cost of that guarantee is a seek proportional to
//! `out_start`; see [`Psola::render`].

use std::f64::consts::TAU;

use crate::analysis::f0::PitchTrack;
use crate::dsp::formant::FormantMode;
use crate::dsp::resample::sample_at;

/// Longest grain half-width, in seconds.
const MAX_GRAIN_HALF_SECONDS: f64 = 0.05;
/// Shortest local period accepted from an epoch map, in samples.
const MIN_PERIOD_SAMPLES: f64 = 2.0;
/// Narrowest pitch multiplier honoured, below which the target is clamped.
const MIN_RATIO: f64 = 0.25;
/// Widest pitch multiplier honoured, above which the target is clamped.
const MAX_RATIO: f64 = 4.0;
/// Narrowest grain content resampling step, one octave down.
const MIN_CONTENT_STEP: f64 = 0.5;
/// Widest grain content resampling step, one octave up.
const MAX_CONTENT_STEP: f64 = 2.0;
/// Overlap weight below which a sample is left un-normalised instead of amplified.
const WINDOW_SUM_FLOOR: f32 = 0.05;
/// Absolute ceiling applied to rendered samples so a bad plan cannot produce wild output.
const OUTPUT_CLAMP: f32 = 4.0;
/// Fraction of a period searched either side of a predicted mark when peak picking.
const PEAK_SEARCH_FRACTION: f64 = 0.25;

/// Pitch marks and their local periods for one source buffer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EpochMap {
    /// Sample rate the positions and periods are expressed in.
    pub sample_rate: f64,
    /// Ascending sample positions of glottal pulses, including synthetic marks across
    /// unvoiced material so the grain stream never gaps.
    pub positions: Vec<u32>,
    /// Local period in samples at each position.
    pub periods: Vec<f32>,
    /// Whether each mark sits in voiced material.
    pub voiced: Vec<bool>,
}

impl EpochMap {
    /// Index of the last mark at or before `position`.
    pub fn index_at(&self, position: f64) -> Option<usize> {
        if self.positions.is_empty() || !position.is_finite() {
            return None;
        }
        if (self.positions[0] as f64) > position {
            return None;
        }
        let found = self.positions.partition_point(|&p| (p as f64) <= position);
        Some(found.saturating_sub(1))
    }

    /// Interpolated local period in samples at `position`.
    ///
    /// Zero when the map is empty. Clamped to the end marks outside the mapped range.
    pub fn period_at(&self, position: f64) -> f32 {
        if self.periods.is_empty() {
            return 0.0;
        }
        let last = self.periods.len() - 1;
        let index = match self.index_at(position) {
            Some(i) => i,
            None => return self.periods[0],
        };
        if index >= last || index >= self.positions.len() - 1 {
            return self.periods[last.min(self.periods.len() - 1)];
        }
        let left = self.positions[index] as f64;
        let right = self.positions[index + 1] as f64;
        let span = right - left;
        if span <= 0.0 {
            return self.periods[index];
        }
        let t = ((position - left) / span).clamp(0.0, 1.0) as f32;
        self.periods[index] + (self.periods[index + 1] - self.periods[index]) * t
    }

    /// Whether the map is internally consistent and usable for synthesis.
    fn is_usable(&self) -> bool {
        !self.positions.is_empty()
            && self.positions.len() == self.periods.len()
            && self.positions.len() == self.voiced.len()
    }
}

/// Places pitch marks from the detected pitch track by peak picking inside each period.
///
/// Voiced regions get marks on the strongest local energy peak within a search window
/// around the predicted next mark, which keeps grains phase-coherent. Unvoiced regions
/// get evenly spaced marks at `unvoiced_period_seconds`.
pub fn build_epochs(
    samples: &[f32],
    sample_rate: f64,
    track: &PitchTrack,
    unvoiced_period_seconds: f64,
) -> EpochMap {
    let mut map = EpochMap {
        sample_rate,
        ..EpochMap::default()
    };
    if samples.is_empty() || !sample_rate.is_finite() || sample_rate <= 0.0 {
        return map;
    }
    let count = samples.len().min(u32::MAX as usize);
    let max_period = (MAX_GRAIN_HALF_SECONDS * sample_rate).max(MIN_PERIOD_SAMPLES * 2.0);
    let unvoiced_period = {
        let raw = unvoiced_period_seconds * sample_rate;
        if raw.is_finite() {
            raw.clamp(MIN_PERIOD_SAMPLES, max_period)
        } else {
            (0.01 * sample_rate).clamp(MIN_PERIOD_SAMPLES, max_period)
        }
    };

    let energy = SquaredPrefix::new(&samples[..count]);
    let mut predicted = 0.0f64;
    let mut previous: Option<u32> = None;

    while predicted < count as f64 {
        let time = predicted / sample_rate;
        let (period, voiced) = match track.hz_at(time) {
            Some(hz) if hz.is_finite() && hz > 0.0 => (
                (sample_rate / hz).clamp(MIN_PERIOD_SAMPLES, max_period),
                true,
            ),
            _ => (unvoiced_period, false),
        };

        let candidate = if voiced {
            let half_window = ((period / 16.0) as usize).max(1);
            // The first mark searches a whole period forward, because a window centred on
            // sample zero is truncated and would lock the grain stream to a false peak.
            let (from, to) = match previous {
                None => (predicted, predicted + period),
                Some(_) => {
                    let radius = (period * PEAK_SEARCH_FRACTION).max(1.0);
                    (predicted - radius, predicted + radius)
                }
            };
            energy.argmax(from, to, half_window, count)
        } else {
            predicted.round().clamp(0.0, (count - 1) as f64) as usize
        };

        let mut mark = candidate.min(count - 1);
        if let Some(last) = previous {
            let floor = last as usize + 1;
            if mark < floor {
                mark = floor;
            }
            if mark >= count {
                break;
            }
        }

        map.positions.push(mark as u32);
        map.periods.push(period as f32);
        map.voiced.push(voiced);
        previous = Some(mark as u32);
        predicted = mark as f64 + period;
    }

    map
}

/// Prefix sums of squared samples, for locating the strongest local energy in a window.
struct SquaredPrefix {
    sums: Vec<f64>,
}

impl SquaredPrefix {
    fn new(samples: &[f32]) -> Self {
        let mut sums = Vec::with_capacity(samples.len() + 1);
        let mut total = 0.0f64;
        sums.push(0.0);
        for &s in samples {
            let v = s as f64;
            if v.is_finite() {
                total += v * v;
            }
            sums.push(total);
        }
        Self { sums }
    }

    fn energy(&self, centre: usize, half_window: usize) -> f64 {
        let last = self.sums.len().saturating_sub(1);
        let lo = centre.saturating_sub(half_window).min(last);
        let hi = centre.saturating_add(half_window + 1).min(last);
        self.sums[hi] - self.sums[lo]
    }

    /// Index of the strongest local energy in `[from, to]`, clamped to `0..count`.
    fn argmax(&self, from: f64, to: f64, half_window: usize, count: usize) -> usize {
        if count == 0 {
            return 0;
        }
        let lo = from.max(0.0).min((count - 1) as f64) as usize;
        let hi = to.max(0.0).min((count - 1) as f64) as usize;
        let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
        let mut best = lo;
        let mut best_energy = f64::NEG_INFINITY;
        for i in lo..=hi {
            let e = self.energy(i, half_window);
            if e > best_energy {
                best_energy = e;
                best = i;
            }
        }
        best
    }
}

/// A deterministic time-domain PSOLA synthesiser.
///
/// Rendering any output range produces the same samples regardless of how the range is
/// split, because every grain is derived from the output sample position alone. This is
/// what lets the realtime worklet and the offline export share one interpretation.
pub struct Psola<'a> {
    source: &'a [f32],
    epochs: &'a EpochMap,
    sample_rate: f64,
}

impl<'a> Psola<'a> {
    /// Binds a source buffer to the epoch map built from it.
    pub fn new(source: &'a [f32], epochs: &'a EpochMap) -> Self {
        let sample_rate = if epochs.sample_rate.is_finite() && epochs.sample_rate > 0.0 {
            epochs.sample_rate
        } else {
            48_000.0
        };
        Self {
            source,
            epochs,
            sample_rate,
        }
    }

    /// Renders `out.len()` samples starting at output sample `out_start`.
    ///
    /// `source_at` maps an output sample index to a fractional source sample position and
    /// must be non-decreasing. `pitch_ratio_at` gives the frequency multiplier to apply at
    /// that output position; 1.0 leaves pitch unchanged. Unvoiced grains are copied without
    /// repitching so consonants keep their character.
    ///
    /// The grain phase is integrated from output sample 0 on every call, so the work done
    /// grows with `out_start`. An empty source, an empty epoch map or a zero-length request
    /// falls back to silence or to a plain interpolated copy rather than failing.
    pub fn render(
        &self,
        out_start: u64,
        out: &mut [f32],
        source_at: &dyn Fn(u64) -> f64,
        pitch_ratio_at: &dyn Fn(u64) -> f64,
        formant: FormantMode,
    ) {
        for s in out.iter_mut() {
            *s = 0.0;
        }
        if out.is_empty() || self.source.is_empty() {
            return;
        }
        if !self.epochs.is_usable() {
            for (i, slot) in out.iter_mut().enumerate() {
                let position = finite(source_at(out_start.saturating_add(i as u64)));
                *slot = sanitise(sample_at(self.source, position));
            }
            return;
        }

        let max_half = (MAX_GRAIN_HALF_SECONDS * self.sample_rate).max(MIN_PERIOD_SAMPLES * 2.0);
        let positions = &self.epochs.positions;
        let mut weights = vec![0.0f32; out.len()];

        let block_start = out_start as i64;
        let block_end = block_start.saturating_add(out.len() as i64);

        let origin = finite(source_at(0));
        let step = {
            let delta = finite(source_at(1)) - origin;
            if delta.is_finite() && delta > 1e-6 {
                delta
            } else {
                1.0
            }
        };
        let mut mark = {
            let seed = (positions[0] as f64 - origin) / step;
            if seed.is_finite() {
                seed.max(0.0)
            } else {
                0.0
            }
        };

        let limit = block_end as f64 + max_half;
        let mut cursor = 0usize;

        while mark < limit {
            let mark_index = mark.clamp(0.0, u64::MAX as f64).round() as u64;
            let position = finite(source_at(mark_index));

            while cursor + 1 < positions.len() && (positions[cursor + 1] as f64) <= position {
                cursor += 1;
            }
            let mut epoch = cursor;
            if cursor + 1 < positions.len() {
                let here = (position - positions[cursor] as f64).abs();
                let next = (positions[cursor + 1] as f64 - position).abs();
                if next < here {
                    epoch = cursor + 1;
                }
            }

            let voiced = self.epochs.voiced[epoch];
            let period = clamp_finite(
                self.epochs.periods[epoch] as f64,
                MIN_PERIOD_SAMPLES,
                max_half,
                MIN_PERIOD_SAMPLES,
            );
            let ratio = if voiced {
                clamp_finite(pitch_ratio_at(mark_index), MIN_RATIO, MAX_RATIO, 1.0)
            } else {
                1.0
            };
            let content_step = if voiced {
                let raw = match formant {
                    FormantMode::Follow => ratio,
                    FormantMode::Preserve => 1.0,
                    FormantMode::Shift(semitones) => clamp_finite(
                        2.0f64.powf(semitones / 12.0),
                        MIN_CONTENT_STEP,
                        MAX_CONTENT_STEP,
                        1.0,
                    ),
                };
                clamp_finite(raw, MIN_CONTENT_STEP, MAX_CONTENT_STEP, 1.0)
            } else {
                1.0
            };

            let half = clamp_finite(
                period / content_step,
                MIN_PERIOD_SAMPLES,
                max_half,
                MIN_PERIOD_SAMPLES,
            );
            let centre = positions[epoch] as f64;

            let lo = (mark - half).ceil().clamp(i64::MIN as f64, i64::MAX as f64) as i64;
            let hi = (mark + half)
                .floor()
                .clamp(i64::MIN as f64, i64::MAX as f64) as i64;
            let begin = lo.max(block_start);
            let end = hi.min(block_end - 1);
            if begin <= end {
                let span = 2.0 * half;
                for j in begin..=end {
                    let index = (j - block_start) as usize;
                    if index >= out.len() {
                        break;
                    }
                    let offset = j as f64 - mark;
                    let phase = ((offset + half) / span).clamp(0.0, 1.0);
                    let weight = (0.5 - 0.5 * (TAU * phase).cos()) as f32;
                    let value = sample_at(self.source, centre + offset * content_step);
                    if weight.is_finite() && value.is_finite() {
                        out[index] += weight * value;
                        weights[index] += weight;
                    }
                }
            }

            let advance = clamp_finite(
                if voiced { period / ratio } else { period },
                MIN_PERIOD_SAMPLES,
                max_half * 2.0,
                MIN_PERIOD_SAMPLES,
            );
            mark += advance;
        }

        for (slot, weight) in out.iter_mut().zip(weights.iter()) {
            if *weight > WINDOW_SUM_FLOOR {
                *slot /= *weight;
            }
            *slot = sanitise(*slot);
        }
    }
}

/// Replaces a non-finite position with zero.
fn finite(value: f64) -> f64 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

/// Clamps `value` into `lo..=hi`, substituting `fallback` when it is not finite.
fn clamp_finite(value: f64, lo: f64, hi: f64, fallback: f64) -> f64 {
    if value.is_finite() {
        value.clamp(lo, hi)
    } else {
        fallback.clamp(lo, hi)
    }
}

/// Bounds a rendered sample and turns a non-finite one into silence.
fn sanitise(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-OUTPUT_CLAMP, OUTPUT_CLAMP)
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::f0::PitchFrame;
    use crate::dsp::window::{normalised_correlation, peak, rms};

    const SR: f64 = 48_000.0;

    fn saw(freq: f64, sample_rate: f64, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| {
                let t = i as f64 / sample_rate;
                let mut v = 0.0f64;
                for k in 1..=10 {
                    v += (TAU * freq * k as f64 * t).sin() / k as f64;
                }
                (v * 0.12) as f32
            })
            .collect()
    }

    fn noise(frames: usize) -> Vec<f32> {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        (0..frames)
            .map(|_| {
                state = state
                    .wrapping_mul(6_364_136_223_846_793_005)
                    .wrapping_add(1);
                ((state >> 33) as f32 / u32::MAX as f32) * 0.5 - 0.25
            })
            .collect()
    }

    fn track(sample_rate: f64, duration: f64, f0: f64, voiced: bool) -> PitchTrack {
        let hop = 0.005;
        let count = (duration / hop).ceil() as usize + 1;
        let frames = (0..count)
            .map(|i| PitchFrame {
                time: i as f64 * hop,
                f0: if voiced { f0 } else { 0.0 },
                midi: if voiced {
                    69.0 + 12.0 * (f0 / 440.0).log2()
                } else {
                    f64::NAN
                },
                confidence: if voiced { 0.9 } else { 0.0 },
                rms: 0.2,
                voiced,
            })
            .collect();
        PitchTrack {
            sample_rate,
            hop_seconds: hop,
            frames,
        }
    }

    fn identity(n: u64) -> f64 {
        n as f64
    }

    /// YIN-style cumulative mean normalised difference, returning the estimated period.
    fn estimate_period(signal: &[f32], min_lag: usize, max_lag: usize) -> f64 {
        let window = signal.len() / 2;
        let max_lag = max_lag.min(window.saturating_sub(1));
        if window == 0 || min_lag >= max_lag {
            return 0.0;
        }
        let mut diff = vec![0.0f64; max_lag + 1];
        for (lag, slot) in diff.iter_mut().enumerate().take(max_lag + 1).skip(1) {
            let mut sum = 0.0f64;
            for i in 0..window {
                let d = signal[i] as f64 - signal[i + lag] as f64;
                sum += d * d;
            }
            *slot = sum;
        }
        let mut running = 0.0f64;
        let mut normalised = vec![1.0f64; max_lag + 1];
        for lag in 1..=max_lag {
            running += diff[lag];
            normalised[lag] = if running > 0.0 {
                diff[lag] * lag as f64 / running
            } else {
                1.0
            };
        }
        let mut best = min_lag;
        for lag in min_lag..=max_lag {
            if normalised[lag] < 0.2 {
                let mut local = lag;
                while local < max_lag && normalised[local + 1] < normalised[local] {
                    local += 1;
                }
                return local as f64;
            }
            if normalised[lag] < normalised[best] {
                best = lag;
            }
        }
        best as f64
    }

    #[test]
    fn epoch_lookup_handles_ends_and_gaps() {
        let map = EpochMap {
            sample_rate: SR,
            positions: vec![10, 250, 500],
            periods: vec![240.0, 250.0, 260.0],
            voiced: vec![true, true, false],
        };
        assert_eq!(map.index_at(0.0), None);
        assert_eq!(map.index_at(10.0), Some(0));
        assert_eq!(map.index_at(249.0), Some(0));
        assert_eq!(map.index_at(250.0), Some(1));
        assert_eq!(map.index_at(10_000.0), Some(2));
        assert_eq!(map.index_at(f64::NAN), None);

        assert!((map.period_at(-5.0) - 240.0).abs() < 1e-5);
        assert!((map.period_at(10.0) - 240.0).abs() < 1e-5);
        assert!((map.period_at(130.0) - 245.0).abs() < 0.5);
        assert!((map.period_at(9_999.0) - 260.0).abs() < 1e-5);
    }

    #[test]
    fn empty_epoch_map_reports_nothing() {
        let map = EpochMap::default();
        assert_eq!(map.index_at(5.0), None);
        assert_eq!(map.period_at(5.0), 0.0);
    }

    #[test]
    fn epochs_follow_the_detected_period() {
        let frames = SR as usize / 2;
        let source = saw(200.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 200.0, true), 0.01);
        assert!(map.positions.len() > 80, "got {}", map.positions.len());
        assert!(map.voiced.iter().all(|&v| v));
        for pair in map.positions.windows(2) {
            let spacing = pair[1] as f64 - pair[0] as f64;
            assert!(spacing > 0.0);
            assert!((spacing - 240.0).abs() < 70.0, "spacing {spacing}");
        }
        let mean: f64 = map
            .positions
            .windows(2)
            .map(|p| p[1] as f64 - p[0] as f64)
            .sum::<f64>()
            / (map.positions.len() - 1) as f64;
        assert!((mean - 240.0).abs() < 2.0, "mean spacing {mean}");
    }

    #[test]
    fn unvoiced_epochs_are_evenly_spaced() {
        let source = noise(24_000);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 0.0, false), 0.01);
        assert!(!map.positions.is_empty());
        assert!(map.voiced.iter().all(|&v| !v));
        for pair in map.positions.windows(2) {
            assert_eq!(pair[1] - pair[0], 480);
        }
    }

    #[test]
    fn epoch_positions_are_strictly_ascending() {
        let source = saw(900.0, SR, 12_000);
        let map = build_epochs(&source, SR, &track(SR, 0.25, 900.0, true), 0.01);
        for pair in map.positions.windows(2) {
            assert!(pair[1] > pair[0], "{:?}", pair);
        }
    }

    #[test]
    fn epochs_survive_empty_and_malformed_input() {
        let empty = build_epochs(&[], SR, &track(SR, 0.1, 200.0, true), 0.01);
        assert!(empty.positions.is_empty());

        let bad_rate = build_epochs(&[0.1, 0.2], 0.0, &PitchTrack::default(), 0.01);
        assert!(bad_rate.positions.is_empty());

        let nans = vec![f32::NAN; 4_800];
        let map = build_epochs(&nans, SR, &track(SR, 0.1, 200.0, true), 0.01);
        for pair in map.positions.windows(2) {
            assert!(pair[1] > pair[0]);
        }

        let silly = build_epochs(&noise(4_800), SR, &PitchTrack::default(), f64::NAN);
        assert!(!silly.positions.is_empty());
    }

    #[test]
    fn unit_ratio_reproduces_the_source() {
        let frames = SR as usize / 2;
        let source = saw(200.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 200.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let mut out = vec![0.0f32; frames];
        psola.render(0, &mut out, &identity, &|_| 1.0, FormantMode::Preserve);

        let a = &source[2_000..20_000];
        let b = &out[2_000..20_000];
        let correlation = normalised_correlation(a, b);
        assert!(correlation > 0.99, "correlation {correlation}");
        let level = rms(b) / rms(a);
        assert!((0.8..1.25).contains(&level), "level ratio {level}");
    }

    #[test]
    fn octave_up_doubles_the_rendered_pitch() {
        let frames = SR as usize / 2;
        let source = saw(200.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 200.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let mut out = vec![0.0f32; frames];
        psola.render(0, &mut out, &identity, &|_| 2.0, FormantMode::Preserve);

        let body = &out[4_000..20_000];
        assert!(rms(body) > 0.01, "rendered level {}", rms(body));
        let period = estimate_period(body, 40, 480);
        let hz = SR / period;
        assert!(
            (hz - 400.0).abs() < 20.0,
            "detected {hz} Hz at lag {period}"
        );
    }

    #[test]
    fn block_split_rendering_is_bit_identical() {
        let frames = 30_000usize;
        let source = saw(180.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.7, 180.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let ratio = |n: u64| 1.0 + 0.3 * ((n as f64) / 8_000.0).sin();

        let mut whole = vec![0.0f32; 12_000];
        psola.render(5_000, &mut whole, &identity, &ratio, FormantMode::Preserve);

        let mut pieced = vec![0.0f32; 12_000];
        let mut offset = 0usize;
        for size in [128usize, 377, 1, 4_096, 999].iter().cycle() {
            if offset >= pieced.len() {
                break;
            }
            let end = (offset + size).min(pieced.len());
            psola.render(
                5_000 + offset as u64,
                &mut pieced[offset..end],
                &identity,
                &ratio,
                FormantMode::Preserve,
            );
            offset = end;
        }
        assert_eq!(whole, pieced);
    }

    #[test]
    fn block_split_is_identical_with_a_stretching_time_map() {
        let frames = 20_000usize;
        let source = saw(220.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 220.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let stretched = |n: u64| n as f64 * 0.7;

        let mut whole = vec![0.0f32; 6_000];
        psola.render(2_048, &mut whole, &stretched, &|_| 1.2, FormantMode::Follow);

        let mut pieced = vec![0.0f32; 6_000];
        for (block, chunk) in pieced.chunks_mut(512).enumerate() {
            psola.render(
                2_048 + (block * 512) as u64,
                chunk,
                &stretched,
                &|_| 1.2,
                FormantMode::Follow,
            );
        }
        assert_eq!(whole, pieced);
    }

    #[test]
    fn output_stays_within_a_sane_bound() {
        let frames = 24_000usize;
        let source = saw(150.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 150.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let source_peak = peak(&source);
        for ratio in [0.3f64, 0.5, 1.0, 1.7, 3.9] {
            for mode in [
                FormantMode::Preserve,
                FormantMode::Follow,
                FormantMode::Shift(4.0),
                FormantMode::Shift(-4.0),
            ] {
                let mut out = vec![0.0f32; frames];
                psola.render(0, &mut out, &identity, &|_| ratio, mode);
                let got = peak(&out);
                assert!(
                    got <= source_peak * 3.0 + 0.05,
                    "ratio {ratio} mode {mode:?} peaked at {got} against {source_peak}"
                );
                assert!(out.iter().all(|s| s.is_finite()));
            }
        }
    }

    #[test]
    fn unvoiced_material_passes_through() {
        let frames = 24_000usize;
        let source = noise(frames);
        let map = build_epochs(&source, SR, &track(SR, 0.5, 0.0, false), 0.01);
        let psola = Psola::new(&source, &map);
        let mut out = vec![0.0f32; frames];
        psola.render(0, &mut out, &identity, &|_| 2.0, FormantMode::Preserve);

        let a = &source[2_000..20_000];
        let b = &out[2_000..20_000];
        let correlation = normalised_correlation(a, b);
        assert!(correlation > 0.95, "correlation {correlation}");
    }

    #[test]
    fn a_boundary_between_voiced_and_unvoiced_stays_continuous() {
        let frames = 24_000usize;
        let mut source = saw(200.0, SR, frames);
        for s in source.iter_mut().skip(frames / 2) {
            *s *= 0.9;
        }
        let mut pitch = track(SR, 0.5, 200.0, true);
        for frame in pitch.frames.iter_mut() {
            if frame.time > 0.25 {
                frame.voiced = false;
                frame.f0 = 0.0;
                frame.midi = f64::NAN;
            }
        }
        let map = build_epochs(&source, SR, &pitch, 0.01);
        let psola = Psola::new(&source, &map);
        let mut out = vec![0.0f32; frames];
        psola.render(0, &mut out, &identity, &|_| 1.25, FormantMode::Preserve);

        let biggest = out
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        let reference = source
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f32, f32::max);
        assert!(
            biggest < reference * 4.0 + 0.02,
            "step {biggest} against source step {reference}"
        );
    }

    #[test]
    fn empty_source_and_empty_request_do_not_panic() {
        let map = EpochMap::default();
        let psola = Psola::new(&[], &map);
        let mut nothing: [f32; 0] = [];
        psola.render(0, &mut nothing, &identity, &|_| 1.0, FormantMode::Preserve);

        let mut out = vec![0.5f32; 64];
        psola.render(1_000, &mut out, &identity, &|_| 1.0, FormantMode::Preserve);
        assert!(out.iter().all(|&s| s == 0.0));

        let source = saw(200.0, SR, 4_800);
        let filled = Psola::new(&source, &map);
        let mut copy = vec![0.0f32; 512];
        filled.render(0, &mut copy, &identity, &|_| 1.0, FormantMode::Preserve);
        assert!(normalised_correlation(&copy, &source[..512]) > 0.99);

        let mut zero: [f32; 0] = [];
        filled.render(9_999, &mut zero, &identity, &|_| 1.0, FormantMode::Preserve);
    }

    #[test]
    fn hostile_closures_cannot_break_the_renderer() {
        let frames = 8_000usize;
        let source = saw(200.0, SR, frames);
        let map = build_epochs(&source, SR, &track(SR, 0.2, 200.0, true), 0.01);
        let psola = Psola::new(&source, &map);
        let mut out = vec![0.0f32; 1_024];

        psola.render(
            0,
            &mut out,
            &|_| f64::NAN,
            &|_| f64::NAN,
            FormantMode::Preserve,
        );
        assert!(out.iter().all(|s| s.is_finite()));

        psola.render(
            0,
            &mut out,
            &|n| -(n as f64) * 1e9,
            &|_| 0.0,
            FormantMode::Shift(f64::INFINITY),
        );
        assert!(out.iter().all(|s| s.is_finite()));

        psola.render(
            1_000_000,
            &mut out[..8],
            &|_| 1e18,
            &|_| 1e18,
            FormantMode::Follow,
        );
        assert!(out[..8].iter().all(|s| s.is_finite()));
    }
}
