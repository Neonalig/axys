// SPDX-License-Identifier: AGPL-3.0-or-later

//! The edit model: how detected pitch, scale correction, MIDI guidance, blob moves,
//! drawn anchors and modulation compose into one deterministic render plan.
//!
//! A plan is expressed as a pitch ratio indexed by source time plus a monotone map from
//! output time to source time. Preview and export read the same plan, which is what makes
//! the two agree sample for sample.

use serde::{Deserialize, Serialize};

use crate::analysis::f0::PitchTrack;
use crate::blob::{Blob, BlobSet};
use crate::dsp::formant::FormantMode;
use crate::midi::{GuideMode, GuideSelection, MidiNote, NoteMapping};
use crate::timeline::TimelineMap;
use crate::{AxysError, Result};

/// Smallest plan resolution accepted, in seconds.
const MIN_HOP: f64 = 1e-4;
/// Largest plan resolution accepted, in seconds.
const MAX_HOP: f64 = 1.0;
/// Largest plan grid accepted, in samples.
const MAX_PLAN_POINTS: usize = 4_000_000;
/// Smallest separation between adjacent time-map points, in seconds.
const TIME_EPS: f64 = 1e-9;
/// Widest frequency multiplier a plan may ask for.
const MAX_RATIO: f64 = 4.0;

/// A curve sampled on a uniform grid in source seconds.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampledCurve {
    /// Source seconds of the first sample.
    pub start: f64,
    /// Spacing between samples, in seconds.
    pub hop: f64,
    /// Sample values in grid order.
    pub values: Vec<f32>,
}

impl SampledCurve {
    /// A curve holding one value across `len` samples.
    pub fn constant(value: f32, start: f64, hop: f64, len: usize) -> Self {
        Self {
            start,
            hop,
            values: vec![value; len],
        }
    }

    /// Linearly interpolated value at `time`, clamped at both ends. Returns 0.0 when empty.
    pub fn at(&self, time: f64) -> f32 {
        if self.values.is_empty() {
            return 0.0;
        }
        let last = self.values.len() - 1;
        if !time.is_finite() || !self.hop.is_finite() || self.hop <= 0.0 {
            return self.values[0];
        }
        let pos = (time - self.start) / self.hop;
        if pos <= 0.0 {
            return self.values[0];
        }
        if pos >= last as f64 {
            return self.values[last];
        }
        let i = pos.floor() as usize;
        let frac = (pos - i as f64) as f32;
        let a = self.values[i];
        let b = self.values[(i + 1).min(last)];
        a + (b - a) * frac
    }

    /// Source seconds of the last sample.
    pub fn end(&self) -> f64 {
        match self.values.len() {
            0 => self.start,
            n => self.start + self.hop * (n - 1) as f64,
        }
    }
}

/// A monotone piecewise-linear map from output time to source time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeMap {
    /// Ascending (output seconds, source seconds) pairs. Always has at least two points.
    pub points: Vec<(f64, f64)>,
}

impl TimeMap {
    /// An identity map covering `0..duration`.
    pub fn identity(duration: f64) -> Self {
        let d = if duration.is_finite() && duration > 0.0 {
            duration
        } else {
            MIN_HOP
        };
        Self {
            points: vec![(0.0, 0.0), (d, d)],
        }
    }

    /// Whether the map reads source time as output time everywhere.
    pub fn is_identity(&self) -> bool {
        self.points
            .iter()
            .all(|(output, source)| (output - source).abs() <= f64::EPSILON * output.abs().max(1.0))
    }

    /// Builds a map from ascending points.
    ///
    /// Both coordinates must increase strictly, so the map stays invertible.
    pub fn from_points(points: Vec<(f64, f64)>) -> Result<Self> {
        if points.len() < 2 {
            return Err(AxysError::Invalid("time map needs two points".into()));
        }
        if points.len() > MAX_PLAN_POINTS {
            return Err(AxysError::Invalid("time map too long".into()));
        }
        for w in points.windows(2) {
            let (o0, s0) = w[0];
            let (o1, s1) = w[1];
            if !o0.is_finite() || !s0.is_finite() || !o1.is_finite() || !s1.is_finite() {
                return Err(AxysError::Invalid("time map point is not finite".into()));
            }
            if o1 <= o0 || s1 <= s0 {
                return Err(AxysError::Invalid(
                    "time map is not strictly ascending".into(),
                ));
            }
        }
        Ok(Self { points })
    }

    /// Source seconds at an output time, extrapolating the end segments.
    pub fn source_at(&self, out: f64) -> f64 {
        Self::map(&self.points, out, true)
    }

    /// Output seconds at a source time; the inverse of `source_at`.
    pub fn output_at(&self, source: f64) -> f64 {
        Self::map(&self.points, source, false)
    }

    /// Local playback rate, source seconds per output second.
    pub fn rate_at(&self, out: f64) -> f64 {
        let pts = &self.points;
        if pts.len() < 2 {
            return 1.0;
        }
        let i = Self::segment(pts, out, true);
        let (o0, s0) = pts[i];
        let (o1, s1) = pts[i + 1];
        let span = o1 - o0;
        if span <= 0.0 {
            1.0
        } else {
            (s1 - s0) / span
        }
    }

    /// Length of the mapped output, in seconds.
    pub fn output_duration(&self) -> f64 {
        match (self.points.first(), self.points.last()) {
            (Some(a), Some(b)) => b.0 - a.0,
            _ => 0.0,
        }
    }

    /// Index of the segment whose domain holds `value`, clamped to the end segments.
    fn segment(pts: &[(f64, f64)], value: f64, forward: bool) -> usize {
        let key = |p: &(f64, f64)| if forward { p.0 } else { p.1 };
        let last = pts.len() - 2;
        if !value.is_finite() || value <= key(&pts[0]) {
            return 0;
        }
        if value >= key(&pts[pts.len() - 1]) {
            return last;
        }
        let mut lo = 0usize;
        let mut hi = last;
        while lo < hi {
            let mid = (lo + hi).div_ceil(2);
            if key(&pts[mid]) <= value {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo
    }

    fn map(pts: &[(f64, f64)], value: f64, forward: bool) -> f64 {
        if pts.len() < 2 {
            return value;
        }
        if !value.is_finite() {
            return if forward { pts[0].1 } else { pts[0].0 };
        }
        let i = Self::segment(pts, value, forward);
        let (o0, s0) = pts[i];
        let (o1, s1) = pts[i + 1];
        let (from0, from1, to0, to1) = if forward {
            (o0, o1, s0, s1)
        } else {
            (s0, s1, o0, o1)
        };
        let span = from1 - from0;
        if span <= 0.0 {
            return to0;
        }
        to0 + (value - from0) / span * (to1 - to0)
    }
}

/// Key and scale used by pitch-scale correction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleSettings {
    /// Pitch class of the tonic, 0 = C.
    pub root: u8,
    /// Allowed pitch classes relative to the root, ascending, e.g. major is 0,2,4,5,7,9,11.
    pub degrees: Vec<u8>,
    /// How strongly detected pitch is pulled to the nearest allowed note, 0.0..=1.0.
    pub strength: f64,
    /// Pitch classes the user has excluded from correction.
    pub excluded: Vec<u8>,
}

impl Default for ScaleSettings {
    fn default() -> Self {
        Self {
            root: 0,
            degrees: (0u8..12).collect(),
            strength: 0.0,
            excluded: Vec::new(),
        }
    }
}

impl ScaleSettings {
    /// Nearest allowed MIDI value to `midi`, or `midi` itself when no degree qualifies.
    ///
    /// A pitch class listed in `excluded` is never a target, and a pitch already sitting on
    /// an excluded class is left where it is. Exact ties resolve downwards.
    pub fn quantise(&self, midi: f64) -> f64 {
        if !midi.is_finite() || self.degrees.is_empty() {
            return midi;
        }
        let nearest = midi.round();
        if nearest.is_finite() && self.is_excluded(nearest) {
            return midi;
        }
        let base = midi.floor() as i64;
        let mut best: Option<(f64, f64)> = None;
        for n in (base - 12)..=(base + 12) {
            let candidate = n as f64;
            if !self.allows(candidate) {
                continue;
            }
            let distance = (candidate - midi).abs();
            match best {
                Some((d, _)) if d <= distance => {}
                _ => best = Some((distance, candidate)),
            }
        }
        best.map(|(_, c)| c).unwrap_or(midi)
    }

    /// Whether `midi` sits on an allowed, non-excluded pitch class.
    fn allows(&self, midi: f64) -> bool {
        if self.is_excluded(midi) {
            return false;
        }
        let relative = pitch_class(midi - self.root as f64);
        self.degrees.iter().any(|d| (*d % 12) as i64 == relative)
    }

    fn is_excluded(&self, midi: f64) -> bool {
        let absolute = pitch_class(midi);
        self.excluded.iter().any(|e| (*e % 12) as i64 == absolute)
    }
}

/// Pitch class of an integer-rounded MIDI value, in 0..12.
fn pitch_class(midi: f64) -> i64 {
    let n = midi.round();
    if !n.is_finite() {
        return 0;
    }
    let n = n.clamp(-1_000.0, 1_000.0) as i64;
    n.rem_euclid(12)
}

/// Controls over expressive modulation retained through correction.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModulationSettings {
    /// 1.0 keeps all slow drift, 0.0 removes it.
    pub drift: f64,
    /// 1.0 keeps vibrato at its detected depth, 0.0 removes it, 2.0 doubles it.
    pub vibrato_depth: f64,
    /// Boundary in Hz between drift and vibrato when the contour is split.
    pub vibrato_split_hz: f64,
}

impl Default for ModulationSettings {
    fn default() -> Self {
        Self {
            drift: 1.0,
            vibrato_depth: 1.0,
            vibrato_split_hz: 3.0,
        }
    }
}

impl ModulationSettings {
    /// Whether the settings leave the detected contour alone.
    fn is_neutral(&self) -> bool {
        self.drift == 1.0 && self.vibrato_depth == 1.0
    }
}

/// Everything needed to interpret a project's edits as audio, shared by preview and export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    /// Sample rate the plan is rendered at, in Hz.
    pub sample_rate: f64,
    /// Output time to source time.
    pub time_map: TimeMap,
    /// Frequency multiplier indexed by **source** time. 1.0 leaves pitch unchanged.
    pub pitch_ratio: SampledCurve,
    /// Pitch the plan produces, in fractional MIDI, indexed by **source** time.
    ///
    /// 0.0 where the plan leaves pitch alone, which no sung target ever is. Published so the
    /// editor can draw what will be heard instead of reconstructing it from its own copy of the
    /// detected track, which disagrees with this one wherever the detection is uncertain.
    ///
    /// Read by the editor and never by the renderer, so a plan written by hand may omit it.
    #[serde(default)]
    pub target_midi: SampledCurve,
    /// How the spectral envelope is treated while pitch moves.
    pub formant: FormantMode,
}

impl RenderPlan {
    /// Whether the plan asks for nothing: no time move, no repitch, no formant move.
    ///
    /// A project with no edits compiles to such a plan, and rendering one is a copy rather than
    /// a resynthesis, so an untouched take comes back out of the editor as the take that went in.
    /// Preserving formants is not a move: it only has an effect where pitch does.
    pub fn is_identity(&self) -> bool {
        let formant_moves =
            matches!(self.formant, FormantMode::Shift(semitones) if semitones != 0.0);
        !formant_moves
            && self.time_map.is_identity()
            && self.pitch_ratio.values.iter().all(|ratio| *ratio == 1.0)
    }

    /// A plan that reproduces the source exactly.
    pub fn passthrough(sample_rate: f64, duration: f64) -> Self {
        let span = if duration.is_finite() && duration > 0.0 {
            duration
        } else {
            MIN_HOP
        };
        Self {
            sample_rate,
            time_map: TimeMap::identity(span),
            pitch_ratio: SampledCurve::constant(1.0, 0.0, span, 2),
            target_midi: SampledCurve::constant(0.0, 0.0, span, 2),
            formant: FormantMode::default(),
        }
    }
}

/// Inputs the compiler reads to produce a plan.
#[derive(Debug, Clone, Copy)]
pub struct PlanInputs<'a> {
    /// Detected pitch, the immutable evidence every stage starts from.
    pub track: &'a PitchTrack,
    /// The editable segmentation and its per-blob edits.
    pub blobs: &'a BlobSet,
    /// Render sample rate, in Hz.
    pub sample_rate: f64,
    /// Source duration, in seconds.
    pub duration: f64,
    /// Key and scale correction settings.
    pub scale: &'a ScaleSettings,
    /// Drift and vibrato retention settings.
    pub modulation: &'a ModulationSettings,
    /// How the spectral envelope is treated while pitch moves.
    pub formant: FormantMode,
    /// MIDI guidance, when a guide is selected.
    pub guide: Option<GuideInputs<'a>>,
    /// Plan resolution in seconds; 0.005 matches the analysis hop.
    pub hop: f64,
}

/// Guide data supplied to the plan compiler.
#[derive(Debug, Clone, Copy)]
pub struct GuideInputs<'a> {
    /// The guide note list mappings index into.
    pub notes: &'a [MidiNote],
    /// Blob-to-note relationships.
    pub mappings: &'a [NoteMapping],
    /// Tempo and meter map placing guide notes in source seconds.
    pub timeline: &'a TimelineMap,
    /// Which track, mode and strength the guide contributes with.
    pub selection: &'a GuideSelection,
}

/// Compiles all active edits into one deterministic render plan.
///
/// Intent composes in a fixed order, later stages seeing the result of the earlier ones:
/// detected pitch, then scale correction, then MIDI pitch guidance, then blob pitch offset,
/// then drawn curve anchors, then modulation. A blob's `excluded` flag skips scale correction
/// and MIDI guidance for that blob. Blob timing offsets and scales, plus MIDI timing guidance,
/// build the time map.
pub fn compile_plan(inputs: &PlanInputs<'_>) -> Result<RenderPlan> {
    validate(inputs)?;

    let hop = inputs.hop;
    let count = ((inputs.duration / hop).floor() as usize).saturating_add(1);
    if count > MAX_PLAN_POINTS {
        return Err(AxysError::Invalid("plan resolution too fine".into()));
    }

    let mut ratios = vec![1.0f32; count];
    let mut targets = vec![0.0f32; count];
    let mut pitch_edited = false;
    for blob in inputs.blobs.blobs() {
        if apply_blob_pitch(inputs, blob, hop, count, &mut ratios, &mut targets) {
            pitch_edited = true;
        }
    }

    let (pitch_ratio, target_midi) = if pitch_edited {
        (
            SampledCurve {
                start: 0.0,
                hop,
                values: ratios,
            },
            SampledCurve {
                start: 0.0,
                hop,
                values: targets,
            },
        )
    } else {
        let span = hop.max(inputs.duration);
        (
            SampledCurve::constant(1.0, 0.0, span, 2),
            SampledCurve::constant(0.0, 0.0, span, 2),
        )
    };

    Ok(RenderPlan {
        sample_rate: inputs.sample_rate,
        time_map: build_time_map(inputs)?,
        pitch_ratio,
        target_midi,
        formant: inputs.formant,
    })
}

/// Rejects inputs that would produce an unbounded or meaningless plan.
fn validate(inputs: &PlanInputs<'_>) -> Result<()> {
    let rate = inputs.sample_rate;
    if !rate.is_finite()
        || rate < f64::from(crate::limits::MIN_SAMPLE_RATE)
        || rate > f64::from(crate::limits::MAX_SAMPLE_RATE)
    {
        return Err(AxysError::Invalid("sample rate out of range".into()));
    }
    if !inputs.duration.is_finite()
        || inputs.duration < 0.0
        || inputs.duration > crate::limits::MAX_AUDIO_SECONDS
    {
        return Err(AxysError::Invalid("duration out of range".into()));
    }
    if !inputs.hop.is_finite() || inputs.hop < MIN_HOP || inputs.hop > MAX_HOP {
        return Err(AxysError::Invalid("plan hop out of range".into()));
    }
    if !inputs.scale.strength.is_finite() {
        return Err(AxysError::Invalid("scale strength is not finite".into()));
    }
    let m = inputs.modulation;
    if !m.drift.is_finite()
        || !m.vibrato_depth.is_finite()
        || !(m.vibrato_split_hz.is_finite() && m.vibrato_split_hz > 0.0)
    {
        return Err(AxysError::Invalid(
            "modulation settings out of range".into(),
        ));
    }
    if let Some(guide) = &inputs.guide {
        if !guide.selection.strength.is_finite() {
            return Err(AxysError::Invalid("guide strength is not finite".into()));
        }
    }
    Ok(())
}

/// Grid indices covering `[start, end]`, or None when the span falls between samples.
fn index_range(start: f64, end: f64, hop: f64, count: usize) -> Option<(usize, usize)> {
    if count == 0 || !start.is_finite() || !end.is_finite() || end < start {
        return None;
    }
    let first = (start / hop).ceil();
    let last = (end / hop).floor();
    if !first.is_finite() || !last.is_finite() || last < 0.0 {
        return None;
    }
    let lo = first.max(0.0) as usize;
    let hi = (last.max(0.0) as usize).min(count - 1);
    if lo > hi {
        None
    } else {
        Some((lo, hi))
    }
}

/// Writes one blob's pitch ratios into the grid, returning whether any value moved.
fn apply_blob_pitch(
    inputs: &PlanInputs<'_>,
    blob: &Blob,
    hop: f64,
    count: usize,
    ratios: &mut [f32],
    targets: &mut [f32],
) -> bool {
    let Some((lo, hi)) = index_range(blob.start, blob.end, hop, count) else {
        return false;
    };

    let scale_offset = if blob.excluded {
        0.0
    } else {
        scale_offset(inputs.scale, blob.detected_center)
    };
    let guide_offset = if blob.excluded {
        0.0
    } else {
        guide_pitch_offset(inputs, blob, blob.detected_center + scale_offset)
    };
    let constant_offset = scale_offset + guide_offset + blob.pitch_offset;
    let drawn = !blob.curve.is_empty();
    let modulated = !inputs.modulation.is_neutral();
    if constant_offset == 0.0 && !drawn && !modulated {
        return false;
    }

    let detected: Vec<f64> = (lo..=hi)
        .map(|i| inputs.track.midi_at(i as f64 * hop).unwrap_or(f64::NAN))
        .collect();
    let modulation = if modulated {
        modulation_deltas(&detected, hop, inputs.modulation)
    } else {
        vec![0.0f64; detected.len()]
    };

    let mut moved = false;
    for (k, index) in (lo..=hi).enumerate() {
        let time = index as f64 * hop;
        let base = detected[k];
        if !base.is_finite() {
            continue;
        }
        let target = match blob.curve.eval(time) {
            Some(drawn) if drawn.is_finite() => drawn + blob.pitch_offset,
            _ => base + constant_offset,
        } + modulation[k];
        let delta = target - base;
        if delta == 0.0 || !delta.is_finite() {
            continue;
        }
        let ratio = (delta / 12.0).exp2().clamp(1.0 / MAX_RATIO, MAX_RATIO);
        ratios[index] = ratio as f32;
        targets[index] = target as f32;
        moved = true;
    }
    moved
}

/// Semitones scale correction moves a blob centre by.
fn scale_offset(scale: &ScaleSettings, center: f64) -> f64 {
    let strength = scale.strength.clamp(0.0, 1.0);
    if strength == 0.0 || !center.is_finite() {
        return 0.0;
    }
    (scale.quantise(center) - center) * strength
}

/// Semitones MIDI pitch guidance moves a blob by, after scale correction.
fn guide_pitch_offset(inputs: &PlanInputs<'_>, blob: &Blob, corrected_center: f64) -> f64 {
    let Some(guide) = &inputs.guide else {
        return 0.0;
    };
    if !matches!(
        guide.selection.mode,
        GuideMode::PitchOnly | GuideMode::Combined
    ) {
        return 0.0;
    }
    let Some(note) = mapped_note(guide, blob) else {
        return 0.0;
    };
    let strength = guide.selection.strength.clamp(0.0, 1.0);
    if strength == 0.0 {
        return 0.0;
    }
    (f64::from(note.key) - corrected_center) * strength
}

/// The guide note a blob is mapped to, if any.
fn mapped_note<'a>(guide: &GuideInputs<'a>, blob: &Blob) -> Option<&'a MidiNote> {
    let mapping = guide.mappings.iter().find(|m| m.blob == blob.id)?;
    if mapping.opted_out {
        return None;
    }
    guide.notes.get(mapping.note?)
}

/// Semitone deltas that reweight drift and vibrato of a detected contour.
fn modulation_deltas(detected: &[f64], hop: f64, settings: &ModulationSettings) -> Vec<f64> {
    let n = detected.len();
    if n == 0 {
        return Vec::new();
    }
    let filled = fill_gaps(detected);
    let (drift, vibrato) = split_modulation(&filled, hop, settings.vibrato_split_hz);
    let mean = drift.iter().map(|v| f64::from(*v)).sum::<f64>() / n as f64;
    let dg = settings.drift - 1.0;
    let vg = settings.vibrato_depth - 1.0;
    (0..n)
        .map(|i| (f64::from(drift[i]) - mean) * dg + f64::from(vibrato[i]) * vg)
        .collect()
}

/// Replaces unvoiced holes with the nearest known value so the filter has no steps.
fn fill_gaps(values: &[f64]) -> Vec<f32> {
    let mut out = vec![0.0f32; values.len()];
    let mut last = 0.0f32;
    for (slot, value) in out.iter_mut().zip(values.iter()) {
        if value.is_finite() {
            last = *value as f32;
        }
        *slot = last;
    }
    if let Some(first) = values.iter().position(|v| v.is_finite()) {
        let lead = values[first] as f32;
        for slot in out.iter_mut().take(first) {
            *slot = lead;
        }
    }
    out
}

/// Builds the output-to-source map from blob timing edits and MIDI timing guidance.
fn build_time_map(inputs: &PlanInputs<'_>) -> Result<TimeMap> {
    let duration = inputs.duration;
    let mut spans: Vec<(f64, f64, f64, f64)> = Vec::new();
    let mut edited = false;
    for blob in inputs.blobs.blobs() {
        let (src_start, src_end) = (blob.start, blob.end);
        if !src_start.is_finite() || !src_end.is_finite() || src_end <= src_start {
            continue;
        }
        let (out_start, out_end) = output_span(inputs, blob);
        if out_start != src_start || out_end != src_end {
            edited = true;
        }
        spans.push((out_start, out_end, src_start, src_end));
    }
    if !edited {
        return Ok(TimeMap::identity(duration));
    }

    let mut points: Vec<(f64, f64)> = vec![(0.0, 0.0)];
    for (out_start, out_end, src_start, src_end) in spans {
        push_point(&mut points, out_start, src_start);
        push_point(&mut points, out_end, src_end);
    }
    let last = *points.last().unwrap_or(&(0.0, 0.0));
    let tail = (duration - last.1).max(0.0);
    push_point(&mut points, last.0 + tail, last.1 + tail);
    TimeMap::from_points(points)
}

/// Output span of one blob after its own timing edits and any MIDI timing guidance.
fn output_span(inputs: &PlanInputs<'_>, blob: &Blob) -> (f64, f64) {
    let mut start = blob.edited_start();
    let mut end = blob.edited_end();
    if !start.is_finite() || !end.is_finite() || end <= start {
        start = blob.start;
        end = blob.end;
    }
    if let Some(guide) = &inputs.guide {
        if matches!(
            guide.selection.mode,
            GuideMode::TimingOnly | GuideMode::Combined
        ) {
            if let Some(note) = mapped_note(guide, blob) {
                let strength = guide.selection.strength.clamp(0.0, 1.0);
                let note_start = guide.timeline.tick_to_seconds(note.start_tick as f64);
                let note_end = guide.timeline.tick_to_seconds(note.end_tick as f64);
                if note_start.is_finite() && note_end.is_finite() && note_end > note_start {
                    let s = start + (note_start - start) * strength;
                    let e = end + (note_end - end) * strength;
                    if e > s {
                        start = s;
                        end = e;
                    }
                }
            }
        }
    }
    (start, end)
}

/// Appends a point, forcing both coordinates strictly past the previous one.
fn push_point(points: &mut Vec<(f64, f64)>, out: f64, source: f64) {
    let last = *points.last().unwrap_or(&(0.0, 0.0));
    let o = if out.is_finite() {
        out.max(last.0 + TIME_EPS)
    } else {
        last.0 + TIME_EPS
    };
    let s = if source.is_finite() {
        source.max(last.1 + TIME_EPS)
    } else {
        last.1 + TIME_EPS
    };
    points.push((o, s));
}

/// Second-order low-pass section in direct form I.
struct Biquad {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Biquad {
    /// A Butterworth low-pass at `cutoff` Hz for a grid sampled at `rate` Hz.
    fn low_pass(cutoff: f64, rate: f64) -> Self {
        let fc = cutoff.clamp(rate * 1e-6, rate * 0.45);
        let w0 = 2.0 * std::f64::consts::PI * fc / rate;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / std::f64::consts::SQRT_2;
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 - cos_w0) / 2.0 / a0,
            b1: (1.0 - cos_w0) / a0,
            b2: (1.0 - cos_w0) / 2.0 / a0,
            a1: -2.0 * cos_w0 / a0,
            a2: (1.0 - alpha) / a0,
        }
    }

    /// Filters `signal` in place, starting from the steady state of its first sample.
    fn run(&self, signal: &mut [f64]) {
        let Some(&first) = signal.first() else {
            return;
        };
        let (mut x1, mut x2, mut y1, mut y2) = (first, first, first, first);
        for sample in signal.iter_mut() {
            let x0 = *sample;
            let y0 = self.b0 * x0 + self.b1 * x1 + self.b2 * x2 - self.a1 * y1 - self.a2 * y2;
            x2 = x1;
            x1 = x0;
            y2 = y1;
            y1 = y0;
            *sample = y0;
        }
    }
}

/// Splits a detected contour into slow drift and fast vibrato about `split_hz`.
///
/// Returns (drift, vibrato) sampled on the same grid as the input. A Butterworth low-pass
/// runs forward then backward so the split adds no phase shift, and the two parts sum back
/// to the input.
pub fn split_modulation(values: &[f32], hop: f64, split_hz: f64) -> (Vec<f32>, Vec<f32>) {
    let n = values.len();
    if n == 0 {
        return (Vec::new(), Vec::new());
    }
    if !hop.is_finite() || hop <= 0.0 || !split_hz.is_finite() || split_hz <= 0.0 {
        return (values.to_vec(), vec![0.0; n]);
    }

    // The forward and backward passes multiply, so the pole is widened to keep the
    // combined -3 dB point at split_hz.
    const CASCADE_COMPENSATION: f64 = 1.25;
    let filter = Biquad::low_pass(split_hz * CASCADE_COMPENSATION, 1.0 / hop);

    let mut work = vec![0.0f64; n];
    let mut last = f64::from(values[0]);
    if !last.is_finite() {
        last = 0.0;
    }
    for (slot, value) in work.iter_mut().zip(values.iter()) {
        let x = f64::from(*value);
        if x.is_finite() {
            last = x;
        }
        *slot = last;
    }
    filter.run(&mut work);
    work.reverse();
    filter.run(&mut work);
    work.reverse();

    let drift: Vec<f32> = work
        .iter()
        .map(|v| if v.is_finite() { *v as f32 } else { 0.0 })
        .collect();
    let vibrato: Vec<f32> = values
        .iter()
        .zip(drift.iter())
        .map(|(v, d)| if v.is_finite() { v - d } else { 0.0 })
        .collect();
    (drift, vibrato)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::f0::PitchFrame;
    use crate::blob::BlobId;
    use crate::curve::{Anchor, PitchCurve};

    const HOP: f64 = 0.005;

    fn track_from(midi: &[f64]) -> PitchTrack {
        let frames = midi
            .iter()
            .enumerate()
            .map(|(i, m)| PitchFrame {
                time: i as f64 * HOP,
                f0: 440.0 * ((m - 69.0) / 12.0).exp2(),
                midi: *m,
                confidence: 0.9,
                rms: 0.2,
                voiced: true,
            })
            .collect();
        PitchTrack {
            sample_rate: 48_000.0,
            hop_seconds: HOP,
            frames,
        }
    }

    fn flat_track(midi: f64, seconds: f64) -> PitchTrack {
        let n = (seconds / HOP) as usize + 1;
        track_from(&vec![midi; n])
    }

    fn blob(id: u32, start: f64, end: f64, center: f64) -> Blob {
        Blob::new(BlobId(id), start, end, center)
    }

    fn inputs<'a>(
        track: &'a PitchTrack,
        blobs: &'a BlobSet,
        scale: &'a ScaleSettings,
        modulation: &'a ModulationSettings,
        duration: f64,
    ) -> PlanInputs<'a> {
        PlanInputs {
            track,
            blobs,
            sample_rate: 48_000.0,
            duration,
            scale,
            modulation,
            formant: FormantMode::Preserve,
            guide: None,
            hop: HOP,
        }
    }

    #[test]
    fn sampled_curve_interpolates_and_clamps() {
        let c = SampledCurve {
            start: 1.0,
            hop: 0.5,
            values: vec![0.0, 2.0, 4.0],
        };
        assert_eq!(c.at(0.0), 0.0);
        assert_eq!(c.at(1.0), 0.0);
        assert_eq!(c.at(1.25), 1.0);
        assert_eq!(c.at(1.5), 2.0);
        assert_eq!(c.at(99.0), 4.0);
        assert_eq!(c.end(), 2.0);
        assert_eq!(SampledCurve::constant(1.0, 0.0, 0.1, 0).at(3.0), 0.0);
    }

    #[test]
    fn time_map_identity_and_inverse() {
        let map = TimeMap::identity(4.0);
        assert_eq!(map.source_at(1.25), 1.25);
        assert_eq!(map.output_duration(), 4.0);

        let map = TimeMap::from_points(vec![(0.0, 0.0), (1.0, 2.0), (3.0, 2.5), (4.0, 6.0)])
            .expect("valid map");
        for out in [0.0, 0.3, 1.0, 2.2, 3.0, 3.9, 4.0] {
            let source = map.source_at(out);
            assert!(
                (map.output_at(source) - out).abs() < 1e-9,
                "round trip failed at {out}"
            );
        }
        assert!((map.rate_at(0.5) - 2.0).abs() < 1e-12);
        assert!((map.rate_at(2.0) - 0.25).abs() < 1e-12);
        // Extrapolation past the ends keeps the end segment slope.
        assert!((map.source_at(5.0) - 9.5).abs() < 1e-9);
        assert!((map.source_at(-1.0) + 2.0).abs() < 1e-9);
    }

    #[test]
    fn time_map_rejects_bad_points() {
        assert!(TimeMap::from_points(vec![(0.0, 0.0)]).is_err());
        assert!(TimeMap::from_points(vec![(0.0, 0.0), (1.0, 0.0), (2.0, 1.0)]).is_err());
        assert!(TimeMap::from_points(vec![(0.0, 0.0), (0.0, 1.0)]).is_err());
        assert!(TimeMap::from_points(vec![(0.0, 0.0), (f64::NAN, 1.0)]).is_err());
    }

    #[test]
    fn scale_quantises_to_nearest_allowed_note() {
        let major = ScaleSettings {
            root: 0,
            degrees: vec![0, 2, 4, 5, 7, 9, 11],
            strength: 1.0,
            excluded: Vec::new(),
        };
        assert_eq!(major.quantise(60.6), 60.0);
        assert_eq!(major.quantise(61.4), 62.0);
        assert_eq!(major.quantise(67.2), 67.0);
        // A pitch class the user excluded is a target for nobody and is itself left alone.
        let guarded = ScaleSettings {
            excluded: vec![0],
            ..major.clone()
        };
        assert_eq!(guarded.quantise(60.1), 60.1);
        assert_eq!(guarded.quantise(60.6), 62.0);
        // An empty scale never moves anything.
        let empty = ScaleSettings {
            degrees: Vec::new(),
            ..major
        };
        assert_eq!(empty.quantise(60.6), 60.6);
    }

    #[test]
    fn no_edits_gives_a_passthrough_plan() {
        let track = flat_track(60.3, 1.0);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.1, 0.9, 60.3)]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        assert!(plan.pitch_ratio.values.iter().all(|r| *r == 1.0));
        for t in [0.0, 0.25, 0.5, 0.99] {
            assert_eq!(plan.pitch_ratio.at(t), 1.0);
            assert!((plan.time_map.source_at(t) - t).abs() < 1e-12);
        }
        assert_eq!(plan.time_map, TimeMap::identity(1.0));
    }

    #[test]
    fn blob_pitch_offset_applies_inside_the_blob_only() {
        let track = flat_track(60.0, 1.0);
        let mut b = blob(1, 0.2, 0.6, 60.0);
        b.pitch_offset = 2.0;
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        let expected = (2.0f64 / 12.0).exp2() as f32;
        assert!((plan.pitch_ratio.at(0.4) - expected).abs() < 1e-6);
        assert_eq!(plan.pitch_ratio.at(0.1), 1.0);
        assert_eq!(plan.pitch_ratio.at(0.8), 1.0);
        assert_eq!(plan.time_map, TimeMap::identity(1.0));
    }

    #[test]
    fn scale_strength_moves_halfway() {
        let track = flat_track(60.6, 1.0);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.1, 0.9, 60.6)]).expect("blobs");
        let scale = ScaleSettings {
            root: 0,
            degrees: vec![0, 2, 4, 5, 7, 9, 11],
            strength: 0.5,
            excluded: Vec::new(),
        };
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        let expected = (-0.3f64 / 12.0).exp2() as f32;
        assert!((plan.pitch_ratio.at(0.5) - expected).abs() < 1e-6);
    }

    #[test]
    fn excluded_blob_skips_scale_but_keeps_its_offset() {
        let track = flat_track(60.6, 1.0);
        let mut b = blob(1, 0.1, 0.9, 60.6);
        b.excluded = true;
        b.pitch_offset = 1.0;
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings {
            root: 0,
            degrees: vec![0, 2, 4, 5, 7, 9, 11],
            strength: 1.0,
            excluded: Vec::new(),
        };
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        let expected = (1.0f64 / 12.0).exp2() as f32;
        assert!((plan.pitch_ratio.at(0.5) - expected).abs() < 1e-6);
    }

    #[test]
    fn drawn_anchors_override_scale_correction() {
        let track = flat_track(60.0, 1.0);
        let mut b = blob(1, 0.1, 0.9, 60.0);
        b.curve = PitchCurve::from_anchors(vec![Anchor::new(0.1, 64.0), Anchor::new(0.9, 64.0)])
            .expect("curve");
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings {
            root: 0,
            degrees: vec![0, 7],
            strength: 1.0,
            excluded: Vec::new(),
        };
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        let expected = (4.0f64 / 12.0).exp2() as f32;
        assert!(
            (plan.pitch_ratio.at(0.5) - expected).abs() < 1e-6,
            "drawn target should win, got {}",
            plan.pitch_ratio.at(0.5)
        );
    }

    #[test]
    fn modulation_depth_zero_flattens_vibrato_and_keeps_drift() {
        // A rising line with 6 Hz vibrato on top of it.
        let n = 401;
        let midi: Vec<f64> = (0..n)
            .map(|i| {
                let t = i as f64 * HOP;
                60.0 + t * 2.0 + 0.5 * (2.0 * std::f64::consts::PI * 8.0 * t).sin()
            })
            .collect();
        let track = track_from(&midi);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.0, 2.0, 61.0)]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings {
            drift: 1.0,
            vibrato_depth: 0.0,
            vibrato_split_hz: 3.0,
        };
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 2.0)).expect("plan");

        // Resulting target = detected + delta; the wobble should be gone but the ramp kept.
        let mut targets = Vec::new();
        for (i, detected) in midi.iter().enumerate().take(n - 20).skip(20) {
            let ratio = f64::from(plan.pitch_ratio.at(i as f64 * HOP));
            targets.push(detected + 12.0 * ratio.log2());
        }
        let ripple = targets
            .windows(2)
            .map(|w| (w[1] - w[0]).abs())
            .fold(0.0f64, f64::max);
        assert!(ripple < 0.02, "vibrato survived, ripple {ripple}");
        let rise = targets[targets.len() - 1] - targets[0];
        assert!(rise > 3.0, "drift was flattened too, rise {rise}");
    }

    #[test]
    fn modulation_neutral_settings_change_nothing() {
        let n = 201;
        let midi: Vec<f64> = (0..n)
            .map(|i| 60.0 + 0.4 * (i as f64 * HOP * 30.0).sin())
            .collect();
        let track = track_from(&midi);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.0, 1.0, 60.0)]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");
        assert!(plan.pitch_ratio.values.iter().all(|r| *r == 1.0));
    }

    #[test]
    fn blob_time_offset_shifts_the_time_map_monotonically() {
        let track = flat_track(60.0, 2.0);
        let mut b = blob(1, 0.5, 1.0, 60.0);
        b.time_offset = 0.25;
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 2.0)).expect("plan");

        for w in plan.time_map.points.windows(2) {
            assert!(w[1].0 > w[0].0 && w[1].1 > w[0].1, "map is not ascending");
        }
        assert!((plan.time_map.source_at(0.75) - 0.5).abs() < 1e-9);
        assert!((plan.time_map.source_at(1.25) - 1.0).abs() < 1e-9);
        assert!(plan.time_map.source_at(0.2) < 0.2);
        assert!(plan.pitch_ratio.values.iter().all(|r| *r == 1.0));
    }

    #[test]
    fn compile_plan_rejects_bad_inputs() {
        let track = flat_track(60.0, 1.0);
        let blobs = BlobSet::new();
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();

        let mut i = inputs(&track, &blobs, &scale, &modulation, 1.0);
        i.sample_rate = 10.0;
        assert!(compile_plan(&i).is_err());

        let mut i = inputs(&track, &blobs, &scale, &modulation, 1.0);
        i.hop = 0.0;
        assert!(compile_plan(&i).is_err());

        let i = inputs(&track, &blobs, &scale, &modulation, f64::NAN);
        assert!(compile_plan(&i).is_err());

        let mut i = inputs(&track, &blobs, &scale, &modulation, 1.0);
        i.duration = 1.0e9;
        assert!(compile_plan(&i).is_err());

        let bad = ModulationSettings {
            drift: f64::INFINITY,
            ..ModulationSettings::default()
        };
        let i = inputs(&track, &blobs, &scale, &bad, 1.0);
        assert!(compile_plan(&i).is_err());
    }

    #[test]
    fn unvoiced_frames_are_left_at_unity() {
        let mut track = flat_track(60.0, 1.0);
        for frame in track.frames.iter_mut().take(60).skip(40) {
            frame.voiced = false;
            frame.midi = f64::NAN;
            frame.f0 = 0.0;
        }
        let mut b = blob(1, 0.0, 1.0, 60.0);
        b.pitch_offset = 1.0;
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");

        let unvoiced = plan.pitch_ratio.values[50];
        assert_eq!(unvoiced, 1.0);
        assert!(plan.pitch_ratio.values[10] > 1.0);
    }

    #[test]
    fn split_modulation_sums_back_to_the_input() {
        let n = 400;
        let values: Vec<f32> = (0..n)
            .map(|i| {
                let t = i as f64 * HOP;
                (60.0 + 1.5 * t + 0.4 * (2.0 * std::f64::consts::PI * 8.0 * t).sin()) as f32
            })
            .collect();
        let (drift, vibrato) = split_modulation(&values, HOP, 3.0);
        assert_eq!(drift.len(), n);
        assert_eq!(vibrato.len(), n);
        for i in 0..n {
            assert!(
                (drift[i] + vibrato[i] - values[i]).abs() < 1e-3,
                "parts do not sum back at {i}"
            );
        }
        // The middle of the drift should not carry the 6 Hz wobble.
        let ripple = drift[100..300]
            .windows(2)
            .map(|w| (w[1] - w[0]).abs() as f64)
            .fold(0.0f64, f64::max);
        assert!(ripple < 0.02, "drift still wobbles, {ripple}");
        let peak = vibrato[100..300].iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak > 0.25, "vibrato was lost, peak {peak}");
    }

    #[test]
    fn split_modulation_handles_degenerate_input() {
        assert_eq!(split_modulation(&[], HOP, 3.0), (Vec::new(), Vec::new()));
        let (d, v) = split_modulation(&[1.0, 2.0], 0.0, 3.0);
        assert_eq!(d, vec![1.0, 2.0]);
        assert_eq!(v, vec![0.0, 0.0]);
        let (d, v) = split_modulation(&[1.0, 2.0, 3.0], HOP, -1.0);
        assert_eq!(d, vec![1.0, 2.0, 3.0]);
        assert_eq!(v, vec![0.0, 0.0, 0.0]);
        let (d, v) = split_modulation(&[f32::NAN, 1.0, 1.0], HOP, 3.0);
        assert!(d.iter().all(|x| x.is_finite()));
        assert_eq!(v[0], 0.0);
    }

    #[test]
    fn guide_pitch_pulls_a_mapped_blob_to_its_note() {
        use crate::midi::{GuideMode, GuideSelection, MidiNote, NoteMapping};

        let track = flat_track(60.0, 1.0);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.1, 0.9, 60.0)]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let timeline = TimelineMap::default();
        let notes = vec![MidiNote {
            track: 0,
            channel: 0,
            key: 64,
            velocity: 100,
            start_tick: 0,
            end_tick: 480,
        }];
        let mappings = vec![NoteMapping {
            blob: BlobId(1),
            note: Some(0),
            manual: true,
            opted_out: false,
        }];
        let selection = GuideSelection {
            track: 0,
            channel: None,
            mode: GuideMode::PitchOnly,
            strength: 1.0,
            muted: false,
        };
        let mut i = inputs(&track, &blobs, &scale, &modulation, 1.0);
        i.guide = Some(GuideInputs {
            notes: &notes,
            mappings: &mappings,
            timeline: &timeline,
            selection: &selection,
        });
        let plan = compile_plan(&i).expect("plan");
        let expected = (4.0f64 / 12.0).exp2() as f32;
        assert!((plan.pitch_ratio.at(0.5) - expected).abs() < 1e-6);

        // Visual-only guidance contributes nothing.
        let visual = GuideSelection {
            mode: GuideMode::VisualOnly,
            ..selection.clone()
        };
        let mut i2 = i;
        i2.guide = Some(GuideInputs {
            notes: &notes,
            mappings: &mappings,
            timeline: &timeline,
            selection: &visual,
        });
        let plan = compile_plan(&i2).expect("plan");
        assert!(plan.pitch_ratio.values.iter().all(|r| *r == 1.0));
    }

    #[test]
    fn opted_out_mapping_ignores_the_guide() {
        use crate::midi::{GuideMode, GuideSelection, MidiNote, NoteMapping};

        let track = flat_track(60.0, 1.0);
        let blobs = BlobSet::from_blobs(vec![blob(1, 0.1, 0.9, 60.0)]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let timeline = TimelineMap::default();
        let notes = vec![MidiNote {
            track: 0,
            channel: 0,
            key: 72,
            velocity: 100,
            start_tick: 0,
            end_tick: 480,
        }];
        let mappings = vec![NoteMapping {
            blob: BlobId(1),
            note: Some(0),
            manual: false,
            opted_out: true,
        }];
        let selection = GuideSelection {
            track: 0,
            channel: None,
            mode: GuideMode::Combined,
            strength: 1.0,
            muted: false,
        };
        let mut i = inputs(&track, &blobs, &scale, &modulation, 1.0);
        i.guide = Some(GuideInputs {
            notes: &notes,
            mappings: &mappings,
            timeline: &timeline,
            selection: &selection,
        });
        let plan = compile_plan(&i).expect("plan");
        assert!(plan.pitch_ratio.values.iter().all(|r| *r == 1.0));
        assert_eq!(plan.time_map, TimeMap::identity(1.0));
    }

    #[test]
    fn passthrough_plan_is_unity_everywhere() {
        let plan = RenderPlan::passthrough(48_000.0, 3.0);
        for t in [-1.0, 0.0, 1.5, 3.0, 10.0] {
            assert_eq!(plan.pitch_ratio.at(t), 1.0);
        }
        assert!((plan.time_map.source_at(2.0) - 2.0).abs() < 1e-12);
        let degenerate = RenderPlan::passthrough(48_000.0, 0.0);
        assert_eq!(degenerate.pitch_ratio.at(0.0), 1.0);
    }

    #[test]
    fn plan_round_trips_through_json() {
        let track = flat_track(60.0, 1.0);
        let mut b = blob(1, 0.1, 0.9, 60.0);
        b.pitch_offset = 1.5;
        let blobs = BlobSet::from_blobs(vec![b]).expect("blobs");
        let scale = ScaleSettings::default();
        let modulation = ModulationSettings::default();
        let plan = compile_plan(&inputs(&track, &blobs, &scale, &modulation, 1.0)).expect("plan");
        let json = serde_json::to_string(&plan).expect("serialise");
        let back: RenderPlan = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(plan, back);
    }
}
