// SPDX-License-Identifier: AGPL-3.0-or-later

//! Turns a compiled [`RenderPlan`] into audio, for both the realtime worklet and the export.
//!
//! The plan is two independent statements: a [`TimeMap`] saying which source moment each
//! output moment shows, and a pitch ratio curve indexed by source time. This module feeds
//! both to the PSOLA synthesiser as closures of the output sample index, which is what makes
//! a render a pure function of its output position: the same range comes back identical
//! whether the worklet asks for it in 128-sample blocks or the exporter asks for it once.
//!
//! [`Quality::Offline`] adds a short-time envelope pass on top, aligned to a frame grid
//! anchored at output sample 0 so that purity survives it.

use std::cell::RefCell;

use serde::{Deserialize, Serialize};

use crate::analysis::f0::PitchTrack;
use crate::dsp::formant::{warp_envelope, FormantMode, FormantProcessor};
use crate::dsp::psola::{build_epochs, EpochMap, MarkState, Psola};
use crate::dsp::resample::sample_at;
use crate::dsp::window::hann;
use crate::limits::MAX_AUDIO_SECONDS;
use crate::target::RenderPlan;

/// Mark spacing used across unvoiced material when the epoch map is built, in seconds.
const UNVOICED_PERIOD_SECONDS: f64 = 0.01;
/// Sample rate assumed when neither the plan nor the track states a usable one.
const FALLBACK_SAMPLE_RATE: f64 = 48_000.0;
/// Longest block handed to the synthesiser in one call on the preview path.
const PREVIEW_BLOCK_FRAMES: usize = 4_096;
/// Quefrency cutoff of the offline envelope estimate, in cepstral bins.
const ENVELOPE_ORDER: usize = 40;
/// Nominal envelope frame length, in seconds, before rounding to a power of two.
const ENVELOPE_FRAME_SECONDS: f64 = 0.03;
/// Shortest envelope frame, in samples.
const MIN_ENVELOPE_FRAME: usize = 256;
/// Longest envelope frame, in samples.
const MAX_ENVELOPE_FRAME: usize = 4_096;
/// Frame RMS below which the envelope pass leaves a frame alone.
const ENVELOPE_RMS_FLOOR: f32 = 1e-5;
/// Window-power sum below which an overlap-added sample keeps its uncorrected value.
const NORM_FLOOR: f32 = 1e-4;
/// Widest formant shift honoured, as a frequency multiplier.
const MAX_FORMANT_RATIO: f64 = 2.0;
/// Absolute ceiling on a rendered sample, matching the synthesiser's own guard.
const OUTPUT_CLAMP: f32 = 4.0;
/// Output samples between grain-phase checkpoints.
///
/// Roughly a third of a second at 48 kHz. A checkpoint is 24 bytes, so an hour of output
/// costs about 250 kB, and the walk from one checkpoint to the block that follows it is
/// around 70 mark steps at ordinary speech periods, each of them a handful of arithmetic
/// operations and no grain synthesis. The hard ceiling is half the interval, reached only
/// if every local period sits on the synthesiser's two-sample floor.
const CHECKPOINT_INTERVAL: u64 = 16_384;

/// Quality tier of a render.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Quality {
    /// Bounded work per block, for the realtime path.
    Preview,
    /// Slower path with formant correction fully applied, for export.
    Offline,
}

/// Renders a project's edits into audio.
///
/// Holds the source PCM, the epoch map and a compiled plan. `render_range` is pure with
/// respect to the output position, so the realtime worklet and the offline export produce
/// identical samples for the same range.
pub struct Renderer {
    source: Vec<f32>,
    epochs: EpochMap,
    plan: RenderPlan,
    quality: Quality,
    sample_rate: f64,
    checkpoints: RefCell<Vec<(u64, MarkState)>>,
}

impl Renderer {
    /// Builds a renderer. `source` is mono at `plan.sample_rate`.
    ///
    /// The epoch map is built once here, so a later plan is rendered at the rate this
    /// renderer was constructed with.
    pub fn new(source: Vec<f32>, track: &PitchTrack, plan: RenderPlan, quality: Quality) -> Self {
        let sample_rate = resolve_rate(plan.sample_rate, track.sample_rate);
        let epochs = build_epochs(&source, sample_rate, track, UNVOICED_PERIOD_SECONDS);
        Self {
            source,
            epochs,
            plan,
            quality,
            sample_rate,
            checkpoints: RefCell::new(Vec::new()),
        }
    }

    /// Replaces the plan without rebuilding the epoch map.
    pub fn set_plan(&mut self, plan: RenderPlan) {
        self.plan = plan;
        // The grain-mark sequence is a function of the plan, so the checkpoints no longer
        // describe anything.
        self.checkpoints.borrow_mut().clear();
    }

    /// The plan this renderer is currently interpreting.
    pub fn plan(&self) -> &RenderPlan {
        &self.plan
    }

    /// Total output length in samples.
    pub fn output_frames(&self) -> u64 {
        let duration = self.plan.time_map.output_duration();
        if !duration.is_finite() || duration <= 0.0 {
            return 0;
        }
        let frames = (duration * self.sample_rate).round();
        if frames <= 0.0 {
            0
        } else {
            frames.min(self.frame_ceiling() as f64) as u64
        }
    }

    /// Renders `out.len()` samples starting at output sample `out_start`.
    ///
    /// Positions past the end of the source read as silence rather than failing, and the
    /// result depends only on `out_start`, never on how earlier ranges were requested.
    pub fn render_range(&self, out_start: u64, out: &mut [f32]) {
        for slot in out.iter_mut() {
            *slot = 0.0;
        }
        if out.is_empty() || self.source.is_empty() {
            return;
        }
        // A plan that asks for nothing is a copy: resynthesising an unedited take would return
        // something inaudibly but measurably different from the file that was imported.
        if self.plan.is_identity() {
            self.render_copy(out_start, out);
            return;
        }
        match self.quality {
            Quality::Preview => {
                let mut offset = 0usize;
                while offset < out.len() {
                    let end = (offset + PREVIEW_BLOCK_FRAMES).min(out.len());
                    let start = out_start.saturating_add(offset as u64);
                    self.render_psola(start, &mut out[offset..end]);
                    offset = end;
                }
            }
            Quality::Offline => self.render_offline(out_start, out),
        }
        self.mask_outside_source(out_start, out);
    }

    /// Renders the whole output, or the given output-second range.
    ///
    /// A range beyond the plan is filled with silence, and the request is capped at the
    /// longest audio the core accepts.
    pub fn render_all(&self, range: Option<(f64, f64)>) -> Vec<f32> {
        let (start, end) = match range {
            Some((from, to)) => (self.seconds_to_frame(from), self.seconds_to_frame(to)),
            None => (0, self.output_frames()),
        };
        let (start, end) = if start <= end {
            (start, end)
        } else {
            (end, start)
        };
        let len = (end - start).min(self.frame_ceiling()) as usize;
        let mut out = vec![0.0f32; len];
        self.render_range(start, &mut out);
        out
    }

    /// Silences output whose source time falls outside the source buffer.
    ///
    /// Grain synthesis clamps to the nearest pitch mark, so without this an output range
    /// past the end of the audio would repeat the final grain instead of running out.
    fn mask_outside_source(&self, out_start: u64, out: &mut [f32]) {
        let last = self.source.len() as f64;
        for (i, slot) in out.iter_mut().enumerate() {
            let out_seconds = (out_start.saturating_add(i as u64)) as f64 / self.sample_rate;
            let position = self.plan.time_map.source_at(out_seconds) * self.sample_rate;
            if !position.is_finite() || position < -1.0 || position >= last {
                *slot = 0.0;
            }
        }
    }

    /// Copies the source through the time map with interpolation and no repitching.
    fn render_copy(&self, out_start: u64, out: &mut [f32]) {
        for (i, slot) in out.iter_mut().enumerate() {
            let out_seconds = (out_start.saturating_add(i as u64)) as f64 / self.sample_rate;
            let source_seconds = self.plan.time_map.source_at(out_seconds);
            *slot = sample_at(&self.source, source_seconds * self.sample_rate);
        }
    }

    /// Runs the synthesiser over one block with the plan's two closures.
    fn render_psola(&self, out_start: u64, out: &mut [f32]) {
        let rate = self.sample_rate;
        let plan = &self.plan;
        let source_at = |index: u64| -> f64 { plan.time_map.source_at(index as f64 / rate) * rate };
        let pitch_ratio_at = |index: u64| -> f64 {
            let source_seconds = plan.time_map.source_at(index as f64 / rate);
            f64::from(plan.pitch_ratio.at(source_seconds))
        };
        let psola = Psola::new(&self.source, &self.epochs);
        let start = self.seed_marks(&psola, out_start, &source_at, &pitch_ratio_at);
        psola.render_from(
            start,
            out_start,
            out,
            &source_at,
            &pitch_ratio_at,
            plan.formant,
        );
    }

    /// Grain-mark state to start a block at, extending the checkpoint table to cover it.
    ///
    /// The table memoises an integration that depends only on the plan and the epoch map,
    /// so seeding a block from it cannot change a rendered sample. It grows to the furthest
    /// output position rendered so far and is dropped whenever the plan changes.
    fn seed_marks(
        &self,
        psola: &Psola<'_>,
        out_start: u64,
        source_at: &dyn Fn(u64) -> f64,
        pitch_ratio_at: &dyn Fn(u64) -> f64,
    ) -> MarkState {
        let mut table = self.checkpoints.borrow_mut();
        if table.is_empty() {
            table.push((0, psola.mark_origin(source_at)));
        }
        let ceiling = self.frame_ceiling();
        while let Some(&(at, state)) = table.last() {
            let next = at.saturating_add(CHECKPOINT_INTERVAL);
            if next > out_start || next > ceiling {
                break;
            }
            table.push((
                next,
                psola.advance_marks(state, next as f64, source_at, pitch_ratio_at),
            ));
        }
        let index = (out_start / CHECKPOINT_INTERVAL) as usize;
        match table.get(index).or_else(|| table.last()) {
            Some(&(_, state)) => {
                psola.advance_marks(state, out_start as f64, source_at, pitch_ratio_at)
            }
            None => psola.mark_origin(source_at),
        }
    }

    /// Synthesises the block, then re-imposes the source spectral envelope frame by frame.
    fn render_offline(&self, out_start: u64, out: &mut [f32]) {
        let target_ratio = match self.plan.formant {
            FormantMode::Follow => {
                self.render_psola(out_start, out);
                return;
            }
            FormantMode::Preserve => 1.0,
            FormantMode::Shift(semitones) => {
                let raw = 2.0f64.powf(semitones / 12.0);
                if raw.is_finite() {
                    raw.clamp(1.0 / MAX_FORMANT_RATIO, MAX_FORMANT_RATIO)
                } else {
                    1.0
                }
            }
        };

        let frame_len = self.envelope_frame_len();
        let hop = frame_len / 4;
        let block_start = out_start as i64;
        let block_end = block_start.saturating_add(out.len() as i64);
        let first = div_floor(block_start - frame_len as i64, hop as i64) + 1;
        let first = first.max(0);
        let last = div_floor(block_end - 1, hop as i64);
        if last < first {
            self.render_psola(out_start, out);
            return;
        }

        let padded_start = first * hop as i64;
        let padded_end = last * hop as i64 + frame_len as i64;
        let padded_len = (padded_end - padded_start) as usize;
        let mut rendered = vec![0.0f32; padded_len];
        self.render_psola(padded_start as u64, &mut rendered);

        let window = hann(frame_len);
        let mut processor = FormantProcessor::new(frame_len);
        let mut accumulated = vec![0.0f32; padded_len];
        let mut weights = vec![0.0f32; padded_len];
        let mut frame = vec![0.0f32; frame_len];
        let mut source_frame = vec![0.0f32; frame_len];

        for index in first..=last {
            let offset = (index * hop as i64 - padded_start) as usize;
            for (k, slot) in frame.iter_mut().enumerate() {
                *slot = rendered[offset + k] * window[k];
            }
            if frame_rms(&frame) > ENVELOPE_RMS_FLOOR {
                self.fill_source_frame(
                    index * hop as i64 + (frame_len / 2) as i64,
                    &window,
                    &mut source_frame,
                );
                if frame_rms(&source_frame) > ENVELOPE_RMS_FLOOR {
                    let rendered_envelope = processor.envelope(&frame, ENVELOPE_ORDER);
                    let mut target = processor.envelope(&source_frame, ENVELOPE_ORDER);
                    if target_ratio != 1.0 {
                        target = warp_envelope(&target, target_ratio);
                    }
                    match_gain(&mut target, &rendered_envelope);
                    let level = frame_rms(&frame);
                    processor.correct(&mut frame, &rendered_envelope, &target);
                    restore_level(&mut frame, level);
                }
            }
            for (k, &value) in frame.iter().enumerate() {
                accumulated[offset + k] += value * window[k];
                weights[offset + k] += window[k] * window[k];
            }
        }

        let skip = (block_start - padded_start) as usize;
        for (i, slot) in out.iter_mut().enumerate() {
            let at = skip + i;
            let weight = weights[at];
            let value = if weight > NORM_FLOOR {
                accumulated[at] / weight
            } else {
                rendered[at]
            };
            *slot = if value.is_finite() {
                value.clamp(-OUTPUT_CLAMP, OUTPUT_CLAMP)
            } else {
                0.0
            };
        }
    }

    /// Reads a windowed source frame centred on the source time behind an output sample.
    fn fill_source_frame(&self, centre_out: i64, window: &[f32], frame: &mut [f32]) {
        let out_seconds = centre_out as f64 / self.sample_rate;
        let centre = self.plan.time_map.source_at(out_seconds) * self.sample_rate;
        let half = (frame.len() / 2) as f64;
        for (k, slot) in frame.iter_mut().enumerate() {
            let position = centre + (k as f64 - half);
            *slot = sample_at(&self.source, position) * window[k];
        }
    }

    /// Envelope frame length in samples, a power of two near [`ENVELOPE_FRAME_SECONDS`].
    fn envelope_frame_len(&self) -> usize {
        let nominal = (ENVELOPE_FRAME_SECONDS * self.sample_rate).max(1.0) as usize;
        let mut len = MIN_ENVELOPE_FRAME;
        while len * 2 <= nominal && len * 2 <= MAX_ENVELOPE_FRAME {
            len *= 2;
        }
        len
    }

    /// Largest render length this renderer will produce in one call, in samples.
    fn frame_ceiling(&self) -> u64 {
        (MAX_AUDIO_SECONDS * self.sample_rate) as u64
    }

    /// Output sample index of an output time, clamped to a non-negative whole sample.
    fn seconds_to_frame(&self, seconds: f64) -> u64 {
        if !seconds.is_finite() || seconds <= 0.0 {
            return 0;
        }
        let frame = (seconds * self.sample_rate).round();
        if frame <= 0.0 {
            0
        } else {
            frame.min(self.frame_ceiling() as f64) as u64
        }
    }
}

/// Picks a usable sample rate from the plan, the track, then the fallback.
fn resolve_rate(plan_rate: f64, track_rate: f64) -> f64 {
    for rate in [plan_rate, track_rate] {
        if rate.is_finite() && rate > 0.0 {
            return rate;
        }
    }
    FALLBACK_SAMPLE_RATE
}

/// Scales `frame` back to the RMS it held before its envelope was reshaped.
///
/// The envelope pass replaces a frame's spectral shape, and the two envelopes are matched
/// on their log means rather than their energy, so the reshaping can move a frame's level
/// by tens of percent where the rendered and source spectra differ. Level belongs to the
/// synthesiser and the plan, so it is put back. A frame that comes out silent is left
/// alone rather than amplified.
fn restore_level(frame: &mut [f32], level: f32) {
    let now = frame_rms(frame);
    if now <= ENVELOPE_RMS_FLOOR {
        return;
    }
    let scale = level / now;
    if !scale.is_finite() {
        return;
    }
    for slot in frame.iter_mut() {
        *slot *= scale;
    }
}

/// Root mean square of a frame, zero when it holds a non-finite sample.
fn frame_rms(frame: &[f32]) -> f32 {
    if frame.is_empty() {
        return 0.0;
    }
    let mut sum = 0.0f64;
    for &value in frame {
        if !value.is_finite() {
            return 0.0;
        }
        sum += f64::from(value) * f64::from(value);
    }
    (sum / frame.len() as f64).sqrt() as f32
}

/// Rescales `target` so its mean log magnitude equals `reference`'s.
///
/// Only the shape of the envelope is a formant statement; its overall level belongs to the
/// rendered frame, so transferring the level as well would fight fades and time edits.
fn match_gain(target: &mut [f32], reference: &[f32]) {
    if target.is_empty() || target.len() != reference.len() {
        return;
    }
    let mean = |values: &[f32]| -> f64 {
        let sum: f64 = values
            .iter()
            .map(|&v| f64::from(v).max(1e-12).ln())
            .filter(|v| v.is_finite())
            .sum();
        sum / values.len() as f64
    };
    let scale = (mean(reference) - mean(target)).exp();
    if !scale.is_finite() || scale <= 0.0 {
        return;
    }
    let scale = scale as f32;
    for value in target.iter_mut() {
        *value *= scale;
    }
}

/// Floor division for signed values, which `/` does not provide.
fn div_floor(value: i64, divisor: i64) -> i64 {
    if divisor == 0 {
        return 0;
    }
    let quotient = value / divisor;
    if value % divisor != 0 && ((value < 0) != (divisor < 0)) {
        quotient - 1
    } else {
        quotient
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::f0::{detect_f0, F0Params, PitchFrame};
    use crate::target::{SampledCurve, TimeMap};
    use std::f64::consts::TAU;

    const SR: f64 = 48_000.0;

    fn saw(freq: f64, frames: usize) -> Vec<f32> {
        (0..frames)
            .map(|i| {
                let t = i as f64 / SR;
                let mut v = 0.0f64;
                for k in 1..=12 {
                    v += (TAU * freq * k as f64 * t).sin() / k as f64;
                }
                (v * 0.14) as f32
            })
            .collect()
    }

    fn analysed(samples: &[f32]) -> PitchTrack {
        detect_f0(samples, SR, &F0Params::default()).expect("analysis")
    }

    fn flat_track(duration: f64, f0: f64) -> PitchTrack {
        let hop = 0.005;
        let count = (duration / hop) as usize + 1;
        PitchTrack {
            sample_rate: SR,
            hop_seconds: hop,
            frames: (0..count)
                .map(|i| PitchFrame {
                    time: i as f64 * hop,
                    f0,
                    midi: 69.0 + 12.0 * (f0 / 440.0).log2(),
                    confidence: 0.9,
                    rms: 0.2,
                    voiced: true,
                })
                .collect(),
        }
    }

    fn plan(duration: f64, ratio: f32) -> RenderPlan {
        let mut plan = RenderPlan::passthrough(SR, duration);
        plan.pitch_ratio = SampledCurve::constant(ratio, 0.0, duration.max(0.001), 2);
        plan
    }

    fn correlation(a: &[f32], b: &[f32]) -> f64 {
        let n = a.len().min(b.len());
        let (mut xy, mut xx, mut yy) = (0.0f64, 0.0f64, 0.0f64);
        for i in 0..n {
            let (x, y) = (f64::from(a[i]), f64::from(b[i]));
            xy += x * y;
            xx += x * x;
            yy += y * y;
        }
        if xx <= 0.0 || yy <= 0.0 {
            0.0
        } else {
            xy / (xx * yy).sqrt()
        }
    }

    fn median_hz(samples: &[f32]) -> f64 {
        let track = analysed(samples);
        let mut voiced: Vec<f64> = track
            .frames
            .iter()
            .filter(|f| f.voiced && f.f0 > 0.0)
            .map(|f| f.f0)
            .collect();
        voiced.sort_by(|a, b| a.partial_cmp(b).unwrap());
        assert!(!voiced.is_empty(), "no voiced frames detected");
        voiced[voiced.len() / 2]
    }

    #[test]
    fn passthrough_reproduces_the_source() {
        let duration = 0.5;
        let source = saw(220.0, (SR * duration) as usize);
        let track = analysed(&source);
        let renderer = Renderer::new(
            source.clone(),
            &track,
            plan(duration, 1.0),
            Quality::Preview,
        );
        let out = renderer.render_all(None);
        assert_eq!(out.len(), source.len());

        // Ignore the first and last grain, where the overlap is incomplete by construction.
        let skip = 1_000;
        let a = &source[skip..source.len() - skip];
        let b = &out[skip..out.len() - skip];
        assert!(
            correlation(a, b) > 0.999,
            "correlation {}",
            correlation(a, b)
        );
        let error: f64 = a
            .iter()
            .zip(b)
            .map(|(x, y)| f64::from(x - y).powi(2))
            .sum::<f64>()
            / a.len() as f64;
        let signal: f64 = a.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>() / a.len() as f64;
        assert!(
            (error / signal).sqrt() < 0.05,
            "relative error {}",
            (error / signal).sqrt()
        );
    }

    #[test]
    fn block_split_matches_a_single_call() {
        for quality in [Quality::Preview, Quality::Offline] {
            let duration = 0.3;
            let source = saw(180.0, (SR * duration) as usize);
            let track = analysed(&source);
            let renderer = Renderer::new(source, &track, plan(duration, 1.5), quality);
            let total = 8_000usize;
            let mut whole = vec![0.0f32; total];
            renderer.render_range(1_500, &mut whole);

            let mut pieces = vec![0.0f32; total];
            let mut offset = 0usize;
            for size in [128usize, 1, 999, 2_048, 300].iter().cycle() {
                if offset >= total {
                    break;
                }
                let end = (offset + size).min(total);
                renderer.render_range(1_500 + offset as u64, &mut pieces[offset..end]);
                offset = end;
            }
            assert_eq!(whole, pieces, "split mismatch for {quality:?}");
        }
    }

    #[test]
    fn an_octave_up_raises_detected_pitch() {
        let duration = 0.8;
        let source = saw(220.0, (SR * duration) as usize);
        let track = analysed(&source);
        let renderer = Renderer::new(source, &track, plan(duration, 2.0), Quality::Preview);
        let out = renderer.render_all(None);
        let detected = median_hz(&out);
        assert!(
            (detected / 440.0).log2().abs() < 0.08,
            "detected {detected} Hz"
        );
    }

    #[test]
    fn a_double_length_time_map_stretches_without_repitching() {
        let duration = 0.6;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let mut stretched = plan(duration, 1.0);
        stretched.time_map =
            TimeMap::from_points(vec![(0.0, 0.0), (duration * 2.0, duration)]).expect("map");
        let renderer = Renderer::new(source.clone(), &track, stretched, Quality::Preview);

        let expected = (duration * 2.0 * SR).round() as u64;
        assert_eq!(renderer.output_frames(), expected);
        let out = renderer.render_all(None);
        assert_eq!(out.len() as u64, expected);
        let detected = median_hz(&out);
        assert!(
            (detected / 200.0).log2().abs() < 0.05,
            "detected {detected}"
        );
    }

    #[test]
    fn rendering_past_the_end_is_silent() {
        let duration = 0.1;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let renderer = Renderer::new(source, &track, plan(duration, 1.2), Quality::Offline);
        let mut out = vec![1.0f32; 2_000];
        renderer.render_range(renderer.output_frames() + 48_000, &mut out);
        assert!(out.iter().all(|s| s.abs() < 1e-6), "tail is not silent");
    }

    #[test]
    fn equal_inputs_render_equal_output() {
        let duration = 0.3;
        let source = saw(210.0, (SR * duration) as usize);
        let track = analysed(&source);
        let first = Renderer::new(
            source.clone(),
            &track,
            plan(duration, 1.3),
            Quality::Offline,
        );
        let second = Renderer::new(source, &track, plan(duration, 1.3), Quality::Offline);
        assert_eq!(first.render_all(None), second.render_all(None));
    }

    #[test]
    fn set_plan_changes_the_render_without_rebuilding_epochs() {
        let duration = 0.2;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let mut renderer = Renderer::new(source, &track, plan(duration, 1.0), Quality::Preview);
        let flat = renderer.render_all(None);
        renderer.set_plan(plan(duration, 1.6));
        assert!((renderer.plan().pitch_ratio.values[0] - 1.6).abs() < 1e-6);
        let shifted = renderer.render_all(None);
        assert_ne!(flat, shifted);
    }

    #[test]
    fn a_range_renders_only_that_span() {
        let duration = 0.4;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let renderer = Renderer::new(source, &track, plan(duration, 1.1), Quality::Preview);
        let part = renderer.render_all(Some((0.1, 0.2)));
        assert_eq!(part.len(), (0.1 * SR) as usize);
        let mut direct = vec![0.0f32; part.len()];
        renderer.render_range((0.1 * SR) as u64, &mut direct);
        assert_eq!(part, direct);
    }

    #[test]
    fn a_reversed_range_is_read_in_order() {
        let duration = 0.2;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let renderer = Renderer::new(source, &track, plan(duration, 1.0), Quality::Preview);
        assert_eq!(
            renderer.render_all(Some((0.15, 0.05))).len(),
            (0.1 * SR) as usize
        );
    }

    #[test]
    fn degenerate_input_does_not_panic() {
        let track = PitchTrack::default();
        let renderer = Renderer::new(Vec::new(), &track, plan(0.1, 1.0), Quality::Offline);
        let mut out = vec![0.5f32; 64];
        renderer.render_range(0, &mut out);
        assert!(out.iter().all(|s| *s == 0.0));
        assert!(renderer.render_all(Some((f64::NAN, f64::INFINITY))).len() <= 1);

        let source = saw(200.0, 4_800);
        let broken = RenderPlan {
            sample_rate: f64::NAN,
            ..plan(0.1, 1.0)
        };
        let renderer = Renderer::new(source, &flat_track(0.1, 200.0), broken, Quality::Offline);
        let mut out = vec![0.0f32; 512];
        renderer.render_range(0, &mut out);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn a_formant_shift_stays_finite_and_deterministic() {
        let duration = 0.3;
        let source = saw(200.0, (SR * duration) as usize);
        let track = analysed(&source);
        let mut shifted = plan(duration, 1.4);
        shifted.formant = FormantMode::Shift(4.0);
        let renderer = Renderer::new(source, &track, shifted, Quality::Offline);
        let out = renderer.render_all(None);
        assert!(out.iter().all(|s| s.is_finite() && s.abs() <= 4.0));
        let mut half = vec![0.0f32; out.len() / 2];
        renderer.render_range(0, &mut half);
        assert_eq!(&out[..half.len()], &half[..]);
    }

    /// Builds two renderers over the same several-second buffer and plan.
    fn pair(duration: f64, ratio: f32, quality: Quality) -> (Renderer, Renderer) {
        let source = saw(200.0, (SR * duration) as usize);
        let track = flat_track(duration, 200.0);
        (
            Renderer::new(source.clone(), &track, plan(duration, ratio), quality),
            Renderer::new(source, &track, plan(duration, ratio), quality),
        )
    }

    #[test]
    fn a_cold_render_matches_a_warmed_one() {
        let (cold, warm) = pair(1.0, 1.3, Quality::Preview);
        let mut scratch = vec![0.0f32; 4_000];
        for start in (0..40_000u64).step_by(4_000) {
            warm.render_range(start, &mut scratch);
        }

        let mut from_cold = vec![0.0f32; 3_000];
        let mut from_warm = vec![0.0f32; 3_000];
        cold.render_range(44_000, &mut from_cold);
        warm.render_range(44_000, &mut from_warm);
        assert_eq!(from_cold, from_warm);
    }

    #[test]
    fn worklet_sized_blocks_match_one_render_all() {
        let duration = 1.0;
        let (whole, blocked) = pair(duration, 1.4, Quality::Preview);
        let expected = whole.render_all(None);

        let mut got = vec![0.0f32; expected.len()];
        for (index, block) in got.chunks_mut(128).enumerate() {
            blocked.render_range((index * 128) as u64, block);
        }
        assert_eq!(expected, got);
    }

    #[test]
    fn scattered_blocks_match_blocks_rendered_in_order() {
        let duration = 1.0;
        let (ordered, scattered) = pair(duration, 0.8, Quality::Preview);
        let blocks = 300usize;

        let mut forwards = vec![0.0f32; blocks * 128];
        for (index, block) in forwards.chunks_mut(128).enumerate() {
            ordered.render_range((index * 128) as u64, block);
        }

        // A fixed permutation, so a failure is reproducible.
        let mut backwards = vec![0.0f32; blocks * 128];
        let mut index = 0usize;
        for _ in 0..blocks {
            index = (index + 173) % blocks;
            let at = index * 128;
            scattered.render_range(at as u64, &mut backwards[at..at + 128]);
        }
        assert_eq!(forwards, backwards);
    }

    #[test]
    fn set_plan_drops_the_checkpoints() {
        let duration = 1.0;
        let (mut reused, mut fresh) = pair(duration, 1.0, Quality::Preview);
        let mut scratch = vec![0.0f32; 4_000];
        for start in (0..40_000u64).step_by(4_000) {
            reused.render_range(start, &mut scratch);
        }

        reused.set_plan(plan(duration, 1.75));
        let mut after = vec![0.0f32; 2_000];
        reused.render_range(45_000, &mut after);

        fresh.set_plan(plan(duration, 1.75));
        let mut expected = vec![0.0f32; 2_000];
        fresh.render_range(45_000, &mut expected);
        assert_eq!(expected, after);
    }

    #[test]
    fn seeking_late_in_a_long_buffer_is_bounded() {
        use crate::dsp::psola::{marks_visited, reset_marks_visited};

        let duration = 6.0;
        let (cold, warm) = pair(duration, 1.2, Quality::Preview);
        let last = (SR * duration) as u64 - 128;

        reset_marks_visited();
        let mut from_cold = vec![0.0f32; 128];
        cold.render_range(last, &mut from_cold);
        let cold_marks = marks_visited();

        let mut scratch = vec![0.0f32; 128];
        for start in (0..last).step_by(128) {
            warm.render_range(start, &mut scratch);
        }
        reset_marks_visited();
        let mut from_warm = vec![0.0f32; 128];
        warm.render_range(last, &mut from_warm);
        let warm_marks = marks_visited();

        assert_eq!(from_cold, from_warm);
        assert!(
            warm_marks * 8 < cold_marks,
            "warm {warm_marks} against cold {cold_marks}"
        );
        // The plan asks for 200 Hz at a 1.2 ratio, so 200 output samples per mark, and the
        // warm walk starts at the checkpoint below the block. That ceiling is a property of
        // the interval alone: it does not move as the block gets further into the output.
        let ceiling = CHECKPOINT_INTERVAL / 200 * 2;
        assert!(warm_marks < ceiling, "warm {warm_marks} against {ceiling}");
    }

    #[test]
    fn div_floor_rounds_towards_negative_infinity() {
        assert_eq!(div_floor(7, 4), 1);
        assert_eq!(div_floor(-1, 4), -1);
        assert_eq!(div_floor(-8, 4), -2);
        assert_eq!(div_floor(5, 0), 0);
    }
}
