// SPDX-License-Identifier: AGPL-3.0-or-later

//! Serialisable user intent and the undo history that orders it.
//!
//! An operation records what the user meant, never the audio it produced. Applying one
//! touches only [`crate::project::EditState`], so analysis stays immutable evidence and any
//! state is reachable again by replaying the operations that built it.

use serde::{Deserialize, Serialize};

use crate::analysis::f0::PitchTrack;
use crate::blob::{BlobId, BlobSet, Edge, Voicing};
use crate::curve::{Anchor, PitchCurve};
use crate::dsp::formant::FormantMode;
use crate::midi::{GuideSelection, NoteMapping};
use crate::project::EditState;
use crate::target::{ModulationSettings, ScaleSettings};
use crate::timeline::{MeterEvent, TempoEvent};
use crate::units::{AccidentalStyle, Tuning};
use crate::{limits, AxysError, Result};

/// Longest undo history kept before the oldest operation is discarded.
pub const MAX_HISTORY_OPS: usize = 10_000;

/// Widest formant shift accepted, in semitones.
pub const MAX_FORMANT_SHIFT: f64 = 24.0;

/// Lowest concert reference tuning accepted, in Hz.
pub const MIN_A4_HZ: f64 = 380.0;

/// Highest concert reference tuning accepted, in Hz.
pub const MAX_A4_HZ: f64 = 480.0;

/// Spacing of the anchors a smoothing pass materialises from detected pitch, in seconds.
const SMOOTH_SAMPLE_SECONDS: f64 = 0.02;

/// Anchors a single smoothing pass may materialise from detected pitch.
const MAX_SMOOTH_SAMPLES: usize = 4_096;

/// A serialisable user intent applied over immutable analysis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
// `rename_all` names the variants; `rename_all_fields` names their fields, which matters as
// soon as one is two words.
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EditOp {
    /// Cuts a blob in two at a source time.
    SplitBlob {
        /// Blob to cut.
        blob: BlobId,
        /// Cut position in source seconds.
        time: f64,
    },
    /// Merges two neighbouring blobs into the earlier one.
    JoinBlobs {
        /// Earlier blob, which survives.
        first: BlobId,
        /// Later blob, which is absorbed.
        second: BlobId,
    },
    /// Moves one edge of a blob.
    MoveBoundary {
        /// Blob to resize.
        blob: BlobId,
        /// Edge being dragged.
        edge: Edge,
        /// New edge position in source seconds.
        time: f64,
    },
    /// Reclassifies part of a blob's interior.
    SetVoicing {
        /// Blob holding the span.
        blob: BlobId,
        /// Span start in source seconds.
        start: f64,
        /// Span end in source seconds.
        end: f64,
        /// Classification to apply.
        voicing: Voicing,
    },
    /// Transposes a selection by a relative amount.
    MovePitch {
        /// Blobs in the selection.
        blobs: Vec<BlobId>,
        /// Relative transposition in semitones.
        semitones: f64,
    },
    /// Sets one blob's transposition to an absolute amount.
    SetPitchOffset {
        /// Blob to transpose.
        blob: BlobId,
        /// Absolute transposition in semitones.
        semitones: f64,
    },
    /// Slides a selection along the timeline by a relative amount.
    MoveTime {
        /// Blobs in the selection.
        blobs: Vec<BlobId>,
        /// Relative shift in seconds.
        seconds: f64,
    },
    /// Sets one blob's duration scale.
    SetTimeScale {
        /// Blob to stretch.
        blob: BlobId,
        /// Positive multiplier on the blob duration.
        scale: f64,
    },
    /// Adds one curve anchor.
    AddAnchor {
        /// Blob owning the curve.
        blob: BlobId,
        /// Anchor to add.
        anchor: Anchor,
    },
    /// Moves an existing curve anchor in time and pitch.
    MoveAnchor {
        /// Blob owning the curve.
        blob: BlobId,
        /// Index of the anchor in time order.
        index: usize,
        /// New position in source seconds.
        time: f64,
        /// New fractional MIDI value.
        midi: f64,
    },
    /// Deletes one curve anchor.
    RemoveAnchor {
        /// Blob owning the curve.
        blob: BlobId,
        /// Index of the anchor in time order.
        index: usize,
    },
    /// Replaces the curve across the span the given anchors cover.
    DrawSpan {
        /// Blob owning the curve.
        blob: BlobId,
        /// Anchors of the drawn gesture.
        anchors: Vec<Anchor>,
    },
    /// Reduces jitter across a span without replacing the contour.
    SmoothSpan {
        /// Blob owning the curve.
        blob: BlobId,
        /// Span start in source seconds.
        start: f64,
        /// Span end in source seconds.
        end: f64,
        /// Strength of the reduction, 0.0 leaves the span alone and 1.0 is a full pass.
        amount: f64,
    },
    /// Restores detected-relative pitch across a span by clearing its anchors.
    ResetSpan {
        /// Blob owning the curve.
        blob: BlobId,
        /// Span start in source seconds.
        start: f64,
        /// Span end in source seconds.
        end: f64,
    },
    /// Restores one blob to its detected pitch and timing.
    ResetBlob {
        /// Blob to reset.
        blob: BlobId,
    },
    /// Restores the analysed segmentation across a span, discarding splits, joins and edits.
    ResetRange {
        /// Span start in source seconds.
        start: f64,
        /// Span end in source seconds.
        end: f64,
    },
    /// Suppresses every edit on one blob without discarding it.
    /// Excludes one blob from automatic scale correction and guidance.
    SetExcluded {
        /// Blob to exclude.
        blob: BlobId,
        /// New exclusion state.
        excluded: bool,
    },
    /// Sets one blob's level.
    SetGain {
        /// Blob to set the level of.
        blob: BlobId,
        /// Absolute level in decibels; 0.0 is the blob as sung.
        gain_db: f64,
    },
    /// Replaces the key and scale used by pitch correction.
    SetScale {
        /// New scale settings.
        scale: ScaleSettings,
    },
    /// Replaces the concert reference tuning.
    SetTuning {
        /// New tuning.
        tuning: Tuning,
    },
    /// Replaces the convention note names are spelled with.
    SetAccidentals {
        /// New accidental style.
        accidentals: AccidentalStyle,
    },
    /// Replaces the drift and vibrato controls.
    SetModulation {
        /// New modulation settings.
        modulation: ModulationSettings,
    },
    /// Replaces the formant treatment.
    SetFormant {
        /// New formant mode.
        formant: FormantMode,
    },
    /// Selects or clears the MIDI guide.
    SetGuide {
        /// New guide selection, or None to drop the guide.
        selection: Option<GuideSelection>,
    },
    /// Sets one blob-to-note mapping, replacing any existing entry for that blob.
    SetMapping {
        /// Mapping to store.
        mapping: NoteMapping,
    },
    /// Replaces every blob-to-note mapping with a whole set.
    SetMappings {
        /// Mappings to store, one per mapped blob.
        mappings: Vec<NoteMapping>,
    },
    /// Places musical tick 0 in the source recording.
    SetTimelineOrigin {
        /// Source seconds at musical tick 0.
        seconds: f64,
    },
    /// Replaces the tempo map.
    SetTempoMap {
        /// New tempo events.
        events: Vec<TempoEvent>,
    },
    /// Replaces the meter map.
    SetMeterMap {
        /// New meter events.
        events: Vec<MeterEvent>,
    },
    /// Applies several operations as one undo step.
    Group {
        /// Operations in the order they are applied.
        ops: Vec<EditOp>,
    },
}

impl EditOp {
    /// Short label for the undo history, e.g. "Move Pitch".
    pub fn label(&self) -> &'static str {
        match self {
            EditOp::SplitBlob { .. } => "Split Blob",
            EditOp::JoinBlobs { .. } => "Join Blobs",
            EditOp::MoveBoundary { .. } => "Move Boundary",
            EditOp::SetVoicing { .. } => "Set Voicing",
            EditOp::MovePitch { .. } => "Move Pitch",
            EditOp::SetPitchOffset { .. } => "Set Pitch",
            EditOp::MoveTime { .. } => "Move Time",
            EditOp::SetTimeScale { .. } => "Set Time Scale",
            EditOp::AddAnchor { .. } => "Add Anchor",
            EditOp::MoveAnchor { .. } => "Move Anchor",
            EditOp::RemoveAnchor { .. } => "Remove Anchor",
            EditOp::DrawSpan { .. } => "Draw Curve",
            EditOp::SmoothSpan { .. } => "Smooth Span",
            EditOp::ResetSpan { .. } => "Reset Span",
            EditOp::ResetBlob { .. } => "Reset Blob",
            EditOp::ResetRange { .. } => "Reset Range",
            EditOp::SetExcluded { .. } => "Exclude Blob",
            EditOp::SetGain { .. } => "Set Gain",
            EditOp::SetScale { .. } => "Set Scale",
            EditOp::SetTuning { .. } => "Set Tuning",
            EditOp::SetAccidentals { .. } => "Set Accidentals",
            EditOp::SetModulation { .. } => "Set Modulation",
            EditOp::SetFormant { .. } => "Set Formant",
            EditOp::SetGuide { .. } => "Set Guide",
            EditOp::SetMapping { .. } => "Set Mapping",
            EditOp::SetMappings { .. } => "Set Mappings",
            EditOp::SetTimelineOrigin { .. } => "Align Timeline",
            EditOp::SetTempoMap { .. } => "Set Tempo Map",
            EditOp::SetMeterMap { .. } => "Set Meter Map",
            EditOp::Group { .. } => "Grouped Edit",
        }
    }
}

/// Undo and redo stacks over a project's edit history.
///
/// Operations are kept, not inverse patches: undoing means replaying the remaining
/// operations over fresh analysis. The stack holds at most [`MAX_HISTORY_OPS`] entries and
/// discards the oldest beyond that.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    applied: Vec<EditOp>,
    undone: Vec<EditOp>,
}

impl History {
    /// Creates an empty history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records an applied operation and discards the redo stack.
    pub fn push(&mut self, op: EditOp) {
        self.applied.push(op);
        if self.applied.len() > MAX_HISTORY_OPS {
            self.applied.remove(0);
        }
        self.undone.clear();
    }

    /// True when at least one operation can be undone.
    pub fn can_undo(&self) -> bool {
        !self.applied.is_empty()
    }

    /// True when at least one undone operation can be replayed.
    pub fn can_redo(&self) -> bool {
        !self.undone.is_empty()
    }

    /// Removes and returns the newest applied op, moving it to the redo stack.
    pub fn undo(&mut self) -> Option<EditOp> {
        let op = self.applied.pop()?;
        self.undone.push(op.clone());
        Some(op)
    }

    /// Removes and returns the newest undone op, moving it back to the applied stack.
    pub fn redo(&mut self) -> Option<EditOp> {
        let op = self.undone.pop()?;
        self.applied.push(op.clone());
        Some(op)
    }

    /// Applied operations in the order they were recorded.
    pub fn applied(&self) -> &[EditOp] {
        &self.applied
    }

    /// Label of the operation undo would remove.
    pub fn undo_label(&self) -> Option<&'static str> {
        self.applied.last().map(EditOp::label)
    }

    /// Label of the operation redo would replay.
    pub fn redo_label(&self) -> Option<&'static str> {
        self.undone.last().map(EditOp::label)
    }

    /// Empties both stacks.
    pub fn clear(&mut self) {
        self.applied.clear();
        self.undone.clear();
    }
}

/// Applies one operation to the mutable parts of a project.
///
/// Analysis results are never modified, so any op can be recomputed from the source.
pub fn apply(state: &mut EditState, track: Option<&PitchTrack>, op: &EditOp) -> Result<()> {
    apply_with_baseline(state, track, None, op)
}

/// Applies one operation, with the analysed segmentation available to restore from.
///
/// Only [`EditOp::ResetRange`] needs `baseline`; every other operation ignores it. A
/// `ResetRange` without one fails rather than silently resetting nothing, because the caller
/// asked for the analysed blobs back and there is nothing else to give them.
pub fn apply_with_baseline(
    state: &mut EditState,
    track: Option<&PitchTrack>,
    baseline: Option<&BlobSet>,
    op: &EditOp,
) -> Result<()> {
    match op {
        EditOp::SplitBlob { blob, time } => {
            state.blobs.split(*blob, *time, track)?;
        }
        EditOp::JoinBlobs { first, second } => {
            state.blobs.join(*first, *second, track)?;
        }
        EditOp::MoveBoundary { blob, edge, time } => {
            state.blobs.move_boundary(*blob, *edge, *time)?;
        }
        EditOp::SetVoicing {
            blob,
            start,
            end,
            voicing,
        } => {
            let (start, end) = finite_span(*start, *end)?;
            state.blobs.set_voicing(*blob, start, end, *voicing)?;
        }
        EditOp::MovePitch { blobs, semitones } => {
            let semitones = finite(*semitones, "pitch move")?;
            for id in require_all(state, blobs)? {
                if let Some(b) = state.blobs.get_mut(id) {
                    b.pitch_offset += semitones;
                }
            }
        }
        EditOp::SetPitchOffset { blob, semitones } => {
            let semitones = finite(*semitones, "pitch offset")?;
            blob_mut(state, *blob)?.pitch_offset = semitones;
        }
        EditOp::MoveTime { blobs, seconds } => {
            let seconds = finite(*seconds, "time move")?;
            for id in require_all(state, blobs)? {
                if let Some(b) = state.blobs.get_mut(id) {
                    b.time_offset += seconds;
                }
            }
        }
        EditOp::SetTimeScale { blob, scale } => {
            let scale = finite(*scale, "time scale")?;
            if scale <= 0.0 {
                return Err(AxysError::Invalid(format!(
                    "time scale {scale} is not positive"
                )));
            }
            blob_mut(state, *blob)?.time_scale = scale;
        }
        EditOp::AddAnchor { blob, anchor } => {
            let anchor = *anchor;
            finite(anchor.time, "anchor time")?;
            finite(anchor.midi, "anchor pitch")?;
            let curve = &mut blob_mut(state, *blob)?.curve;
            room_for(curve, 1)?;
            curve.insert(anchor);
        }
        EditOp::MoveAnchor {
            blob,
            index,
            time,
            midi,
        } => {
            blob_mut(state, *blob)?
                .curve
                .move_anchor(*index, *time, *midi)?;
        }
        EditOp::RemoveAnchor { blob, index } => {
            blob_mut(state, *blob)?.curve.remove(*index)?;
        }
        EditOp::DrawSpan { blob, anchors } => {
            draw_span(&mut blob_mut(state, *blob)?.curve, anchors)?;
        }
        EditOp::SmoothSpan {
            blob,
            start,
            end,
            amount,
        } => {
            let (start, end) = finite_span(*start, *end)?;
            let amount = finite(*amount, "smoothing amount")?.clamp(0.0, 1.0);
            let blob = blob_mut(state, *blob)?;
            let (blob_start, blob_end) = (blob.start, blob.end);
            let start = start.max(blob_start);
            let end = end.min(blob_end);
            if amount > 0.0 && end > start {
                materialise_span(&mut blob.curve, track, start, end)?;
                smooth_span(&mut blob.curve, start, end, amount)?;
            }
        }
        EditOp::ResetSpan { blob, start, end } => {
            let (start, end) = finite_span(*start, *end)?;
            blob_mut(state, *blob)?.curve.clear_span(start, end);
        }
        EditOp::ResetBlob { blob } => {
            let blob = blob_mut(state, *blob)?;
            blob.pitch_offset = 0.0;
            blob.time_offset = 0.0;
            blob.time_scale = 1.0;
            blob.curve = PitchCurve::new();
            blob.excluded = false;
            blob.gain_db = 0.0;
        }
        EditOp::ResetRange { start, end } => {
            let (start, end) = finite_span(*start, *end)?;
            let Some(baseline) = baseline else {
                return Err(AxysError::Invalid(
                    "the analysed segmentation is unavailable, so a range cannot be reset".into(),
                ));
            };
            state.blobs.restore_range(baseline, start, end)?;
            // Restoring the segmentation discards blob ids, so any guide mapping onto one that
            // no longer exists goes with it rather than being left pointing at nothing.
            state
                .mappings
                .retain(|mapping| state.blobs.get(mapping.blob).is_some());
        }
        EditOp::SetExcluded { blob, excluded } => {
            blob_mut(state, *blob)?.excluded = *excluded;
        }
        EditOp::SetGain { blob, gain_db } => {
            let gain_db = finite(*gain_db, "gain")?;
            blob_mut(state, *blob)?.gain_db =
                gain_db.clamp(crate::limits::MIN_GAIN_DB, crate::limits::MAX_GAIN_DB);
        }
        EditOp::SetScale { scale } => {
            validate_scale(scale)?;
            state.scale = scale.clone();
        }
        EditOp::SetTuning { tuning } => {
            validate_tuning(tuning)?;
            state.tuning = *tuning;
        }
        EditOp::SetAccidentals { accidentals } => {
            state.accidentals = *accidentals;
        }
        EditOp::SetModulation { modulation } => {
            validate_modulation(modulation)?;
            state.modulation = *modulation;
        }
        EditOp::SetFormant { formant } => {
            if let FormantMode::Shift(semitones) = formant {
                let semitones = finite(*semitones, "formant shift")?;
                if semitones.abs() > MAX_FORMANT_SHIFT {
                    return Err(AxysError::Invalid(format!(
                        "formant shift {semitones} exceeds {MAX_FORMANT_SHIFT} semitones"
                    )));
                }
            }
            state.formant = *formant;
        }
        EditOp::SetGuide { selection } => {
            if let Some(selection) = selection {
                let strength = finite(selection.strength, "guide strength")?;
                if !(0.0..=1.0).contains(&strength) {
                    return Err(AxysError::Invalid(format!(
                        "guide strength {strength} is outside 0..=1"
                    )));
                }
            }
            state.guide = selection.clone();
        }
        EditOp::SetMapping { mapping } => {
            if state.blobs.get(mapping.blob).is_none() {
                return Err(AxysError::NotFound(format!("blob {}", mapping.blob.0)));
            }
            match state.mappings.iter_mut().find(|m| m.blob == mapping.blob) {
                Some(existing) => *existing = *mapping,
                None => state.mappings.push(*mapping),
            }
        }
        EditOp::SetMappings { mappings } => {
            for mapping in mappings {
                if state.blobs.get(mapping.blob).is_none() {
                    return Err(AxysError::NotFound(format!("blob {}", mapping.blob.0)));
                }
            }
            state.mappings = mappings.clone();
        }
        EditOp::SetTimelineOrigin { seconds } => {
            state.timeline.origin_seconds = finite(*seconds, "timeline origin")?;
        }
        EditOp::SetTempoMap { events } => {
            state.timeline.set_tempo(events.clone())?;
        }
        EditOp::SetMeterMap { events } => {
            state.timeline.set_meter(events.clone())?;
        }
        EditOp::Group { ops } => {
            for op in ops {
                apply_with_baseline(state, track, baseline, op)?;
            }
        }
    }
    Ok(())
}

/// Rejects a non-finite scalar, naming the field in the error.
fn finite(value: f64, what: &str) -> Result<f64> {
    if value.is_finite() {
        Ok(value)
    } else {
        Err(AxysError::Invalid(format!("{what} is not finite")))
    }
}

/// Rejects a non-finite or inverted span.
fn finite_span(start: f64, end: f64) -> Result<(f64, f64)> {
    finite(start, "span start")?;
    finite(end, "span end")?;
    if end < start {
        return Err(AxysError::Invalid(format!(
            "span end {end} precedes start {start}"
        )));
    }
    Ok((start, end))
}

/// Borrows a blob mutably, reporting a missing id.
fn blob_mut(state: &mut EditState, id: BlobId) -> Result<&mut crate::blob::Blob> {
    state
        .blobs
        .get_mut(id)
        .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))
}

/// Checks that every id in a selection exists before any of them is changed.
fn require_all(state: &EditState, ids: &[BlobId]) -> Result<Vec<BlobId>> {
    for id in ids {
        if state.blobs.get(*id).is_none() {
            return Err(AxysError::NotFound(format!("blob {}", id.0)));
        }
    }
    Ok(ids.to_vec())
}

/// Rejects a curve that cannot take `extra` more anchors.
fn room_for(curve: &PitchCurve, extra: usize) -> Result<()> {
    if curve.len() + extra > limits::MAX_CURVE_ANCHORS {
        return Err(AxysError::Invalid(format!(
            "curve anchor limit is {}",
            limits::MAX_CURVE_ANCHORS
        )));
    }
    Ok(())
}

/// Replaces the anchors lying inside the span the drawn anchors cover.
fn draw_span(curve: &mut PitchCurve, anchors: &[Anchor]) -> Result<()> {
    if anchors.is_empty() {
        return Ok(());
    }
    if anchors
        .iter()
        .any(|a| !a.time.is_finite() || !a.midi.is_finite())
    {
        return Err(AxysError::Invalid("drawn anchor is not finite".into()));
    }
    room_for(curve, anchors.len())?;
    let mut start = f64::INFINITY;
    let mut end = f64::NEG_INFINITY;
    for a in anchors {
        start = start.min(a.time);
        end = end.max(a.time);
    }
    curve.clear_span(start, end);
    for a in anchors {
        curve.insert(*a);
    }
    Ok(())
}

/// Gives a span enough anchors to smooth by sampling detected pitch where it has none.
///
/// A span the user has never drawn on follows detected pitch, which has no anchors to
/// filter, so the detected contour is written into the curve first and smoothed after.
fn materialise_span(
    curve: &mut PitchCurve,
    track: Option<&PitchTrack>,
    start: f64,
    end: f64,
) -> Result<()> {
    let present = curve
        .anchors()
        .iter()
        .filter(|a| a.time >= start && a.time <= end)
        .count();
    if present >= 3 {
        return Ok(());
    }
    let Some(track) = track else {
        return Ok(());
    };
    let steps = ((end - start) / SMOOTH_SAMPLE_SECONDS)
        .floor()
        .clamp(0.0, MAX_SMOOTH_SAMPLES as f64) as usize;
    let count = (steps + 1).min(MAX_SMOOTH_SAMPLES);
    if count < 3 {
        return Ok(());
    }
    let mut fresh = Vec::with_capacity(count);
    for i in 0..count {
        let time = start + (end - start) * (i as f64 / (count - 1) as f64);
        if let Some(midi) = track.midi_at(time) {
            if midi.is_finite() {
                fresh.push(Anchor::new(time, midi));
            }
        }
    }
    if fresh.len() < 3 {
        return Ok(());
    }
    room_for(curve, fresh.len())?;
    curve.clear_span(start, end);
    for a in fresh {
        curve.insert(a);
    }
    Ok(())
}

/// Blends the anchors inside a span toward a three-point binomial average.
///
/// `amount` scales the blend, so the contour is attenuated rather than replaced and the
/// span's endpoints stay where the untouched pitch on either side left them.
fn smooth_span(curve: &mut PitchCurve, start: f64, end: f64, amount: f64) -> Result<()> {
    let mut anchors = curve.anchors().to_vec();
    let indices: Vec<usize> = (0..anchors.len())
        .filter(|&i| anchors[i].time >= start && anchors[i].time <= end)
        .collect();
    if indices.len() < 3 {
        return Ok(());
    }
    let values: Vec<f64> = indices.iter().map(|&i| anchors[i].midi).collect();
    for k in 1..values.len() - 1 {
        let filtered = 0.25 * values[k - 1] + 0.5 * values[k] + 0.25 * values[k + 1];
        anchors[indices[k]].midi = values[k] + (filtered - values[k]) * amount;
    }
    *curve = PitchCurve::from_anchors(anchors)?;
    Ok(())
}

/// Rejects a scale whose pitch classes or strength fall outside their ranges.
fn validate_scale(scale: &ScaleSettings) -> Result<()> {
    if scale.root >= 12 {
        return Err(AxysError::Invalid(format!(
            "scale root {} is not a pitch class",
            scale.root
        )));
    }
    if let Some(bad) = scale
        .degrees
        .iter()
        .chain(&scale.excluded)
        .find(|d| **d >= 12)
    {
        return Err(AxysError::Invalid(format!(
            "scale degree {bad} is not a pitch class"
        )));
    }
    let strength = finite(scale.strength, "scale strength")?;
    if !(0.0..=1.0).contains(&strength) {
        return Err(AxysError::Invalid(format!(
            "scale strength {strength} is outside 0..=1"
        )));
    }
    Ok(())
}

/// Rejects a reference tuning outside [`MIN_A4_HZ`]..=[`MAX_A4_HZ`].
fn validate_tuning(tuning: &Tuning) -> Result<()> {
    let a4 = finite(tuning.a4_hz, "reference tuning")?;
    if !(MIN_A4_HZ..=MAX_A4_HZ).contains(&a4) {
        return Err(AxysError::Invalid(format!(
            "reference tuning {a4} Hz is outside {MIN_A4_HZ}..={MAX_A4_HZ}"
        )));
    }
    Ok(())
}

/// Rejects modulation settings that are non-finite, negative or have no vibrato boundary.
fn validate_modulation(modulation: &ModulationSettings) -> Result<()> {
    let drift = finite(modulation.drift, "drift")?;
    let depth = finite(modulation.vibrato_depth, "vibrato depth")?;
    let split = finite(modulation.vibrato_split_hz, "vibrato split")?;
    if drift < 0.0 || depth < 0.0 {
        return Err(AxysError::Invalid(
            "modulation amounts must not be negative".into(),
        ));
    }
    if split <= 0.0 {
        return Err(AxysError::Invalid(format!(
            "vibrato split {split} Hz is not positive"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::f0::PitchFrame;
    use crate::blob::{Blob, BlobSet};
    use crate::curve::Interp;
    use crate::midi::GuideMode;
    use crate::timeline::TimelineMap;
    use crate::units::{AccidentalStyle, Tuning};

    fn blob(id: u32, start: f64, end: f64) -> Blob {
        Blob::new(BlobId(id), start, end, 60.0)
    }

    fn state_with(blobs: Vec<Blob>) -> EditState {
        EditState {
            blobs: BlobSet::from_blobs(blobs).unwrap(),
            scale: ScaleSettings::default(),
            modulation: ModulationSettings::default(),
            formant: FormantMode::default(),
            timeline: TimelineMap::default(),
            guide: None,
            mappings: Vec::new(),
            tuning: Tuning::default(),
            accidentals: AccidentalStyle::default(),
        }
    }

    fn state() -> EditState {
        state_with(vec![blob(1, 0.0, 1.0), blob(2, 1.0, 2.0)])
    }

    /// A track whose MIDI alternates about 60 so a smoothing pass has jitter to remove.
    fn jittery_track() -> PitchTrack {
        let hop = 0.005;
        let frames = (0..400)
            .map(|i| {
                let offset = if i % 2 == 0 { 0.5 } else { -0.5 };
                PitchFrame {
                    time: i as f64 * hop,
                    f0: 261.6,
                    midi: 60.0 + offset,
                    confidence: 0.9,
                    rms: 0.2,
                    voiced: true,
                }
            })
            .collect();
        PitchTrack {
            sample_rate: 48_000.0,
            hop_seconds: hop,
            frames,
        }
    }

    fn anchors_of(state: &EditState, id: u32) -> Vec<Anchor> {
        state
            .blobs
            .get(BlobId(id))
            .unwrap()
            .curve
            .anchors()
            .to_vec()
    }

    #[test]
    fn split_blob_produces_two_blobs() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SplitBlob {
                blob: BlobId(1),
                time: 0.5,
            },
        )
        .unwrap();
        assert_eq!(s.blobs.len(), 3);
    }

    #[test]
    fn join_blobs_merges_neighbours() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::JoinBlobs {
                first: BlobId(1),
                second: BlobId(2),
            },
        )
        .unwrap();
        assert_eq!(s.blobs.len(), 1);
        assert_eq!(s.blobs.get(BlobId(1)).unwrap().end, 2.0);
    }

    #[test]
    fn move_boundary_resizes() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::MoveBoundary {
                blob: BlobId(1),
                edge: Edge::End,
                time: 0.6,
            },
        )
        .unwrap();
        assert!((s.blobs.get(BlobId(1)).unwrap().end - 0.6).abs() < 1e-9);
    }

    #[test]
    fn set_voicing_reclassifies_a_span() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetVoicing {
                blob: BlobId(1),
                start: 0.0,
                end: 0.2,
                voicing: Voicing::Unvoiced,
            },
        )
        .unwrap();
        assert_eq!(
            s.blobs.get(BlobId(1)).unwrap().voicing_at(0.1),
            Voicing::Unvoiced
        );
    }

    #[test]
    fn set_voicing_rejects_an_inverted_span() {
        let mut s = state();
        let err = apply(
            &mut s,
            None,
            &EditOp::SetVoicing {
                blob: BlobId(1),
                start: 0.5,
                end: 0.1,
                voicing: Voicing::Silence,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AxysError::Invalid(_)));
    }

    #[test]
    fn move_pitch_is_relative_and_covers_a_selection() {
        let mut s = state();
        let op = EditOp::MovePitch {
            blobs: vec![BlobId(1), BlobId(2)],
            semitones: 1.5,
        };
        apply(&mut s, None, &op).unwrap();
        apply(&mut s, None, &op).unwrap();
        assert!((s.blobs.get(BlobId(1)).unwrap().pitch_offset - 3.0).abs() < 1e-9);
        assert!((s.blobs.get(BlobId(2)).unwrap().pitch_offset - 3.0).abs() < 1e-9);
    }

    #[test]
    fn move_pitch_changes_nothing_when_one_id_is_missing() {
        let mut s = state();
        let err = apply(
            &mut s,
            None,
            &EditOp::MovePitch {
                blobs: vec![BlobId(1), BlobId(99)],
                semitones: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AxysError::NotFound(_)));
        assert_eq!(s.blobs.get(BlobId(1)).unwrap().pitch_offset, 0.0);
    }

    #[test]
    fn set_pitch_offset_is_absolute() {
        let mut s = state();
        let op = EditOp::SetPitchOffset {
            blob: BlobId(1),
            semitones: -2.0,
        };
        apply(&mut s, None, &op).unwrap();
        apply(&mut s, None, &op).unwrap();
        assert_eq!(s.blobs.get(BlobId(1)).unwrap().pitch_offset, -2.0);
    }

    #[test]
    fn move_time_accumulates() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::MoveTime {
                blobs: vec![BlobId(2)],
                seconds: 0.25,
            },
        )
        .unwrap();
        assert!((s.blobs.get(BlobId(2)).unwrap().time_offset - 0.25).abs() < 1e-9);
    }

    #[test]
    fn set_time_scale_rejects_a_non_positive_scale() {
        let mut s = state();
        for bad in [0.0, -1.0] {
            let err = apply(
                &mut s,
                None,
                &EditOp::SetTimeScale {
                    blob: BlobId(1),
                    scale: bad,
                },
            )
            .unwrap_err();
            assert!(matches!(err, AxysError::Invalid(_)), "accepted {bad}");
        }
        assert_eq!(s.blobs.get(BlobId(1)).unwrap().time_scale, 1.0);
        apply(
            &mut s,
            None,
            &EditOp::SetTimeScale {
                blob: BlobId(1),
                scale: 1.5,
            },
        )
        .unwrap();
        assert_eq!(s.blobs.get(BlobId(1)).unwrap().time_scale, 1.5);
    }

    #[test]
    fn set_time_scale_rejects_a_non_finite_scale() {
        let mut s = state();
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetTimeScale {
                blob: BlobId(1),
                scale: f64::NAN,
            },
        )
        .is_err());
    }

    #[test]
    fn anchor_ops_add_move_and_remove() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(0.2, 61.0),
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(0.8, 63.0),
            },
        )
        .unwrap();
        assert_eq!(anchors_of(&s, 1).len(), 2);

        apply(
            &mut s,
            None,
            &EditOp::MoveAnchor {
                blob: BlobId(1),
                index: 0,
                time: 0.4,
                midi: 62.0,
            },
        )
        .unwrap();
        let moved = anchors_of(&s, 1);
        assert!((moved[0].time - 0.4).abs() < 1e-9);
        assert!((moved[0].midi - 62.0).abs() < 1e-9);

        apply(
            &mut s,
            None,
            &EditOp::RemoveAnchor {
                blob: BlobId(1),
                index: 0,
            },
        )
        .unwrap();
        assert_eq!(anchors_of(&s, 1).len(), 1);
    }

    #[test]
    fn anchor_ops_reject_bad_input() {
        let mut s = state();
        assert!(apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(f64::NAN, 60.0),
            },
        )
        .is_err());
        assert!(matches!(
            apply(
                &mut s,
                None,
                &EditOp::RemoveAnchor {
                    blob: BlobId(1),
                    index: 7,
                },
            ),
            Err(AxysError::NotFound(_))
        ));
        assert!(apply(
            &mut s,
            None,
            &EditOp::MoveAnchor {
                blob: BlobId(1),
                index: 0,
                time: 0.1,
                midi: 60.0,
            },
        )
        .is_err());
    }

    #[test]
    fn draw_span_replaces_only_the_covered_span() {
        let mut s = state();
        for (t, m) in [(0.1, 60.0), (0.3, 61.0), (0.5, 62.0), (0.9, 63.0)] {
            apply(
                &mut s,
                None,
                &EditOp::AddAnchor {
                    blob: BlobId(1),
                    anchor: Anchor::new(t, m),
                },
            )
            .unwrap();
        }
        apply(
            &mut s,
            None,
            &EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: vec![
                    Anchor::with_interp(0.3, 65.0, Interp::Linear),
                    Anchor::with_interp(0.5, 66.0, Interp::Linear),
                ],
            },
        )
        .unwrap();
        let got: Vec<(f64, f64)> = anchors_of(&s, 1).iter().map(|a| (a.time, a.midi)).collect();
        assert_eq!(
            got,
            vec![(0.1, 60.0), (0.3, 65.0), (0.5, 66.0), (0.9, 63.0)]
        );
    }

    #[test]
    fn draw_span_with_no_anchors_is_a_no_op() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: Vec::new(),
            },
        )
        .unwrap();
        assert!(anchors_of(&s, 1).is_empty());
    }

    #[test]
    fn draw_span_rejects_a_non_finite_anchor() {
        let mut s = state();
        assert!(apply(
            &mut s,
            None,
            &EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: vec![Anchor::new(0.1, f64::INFINITY)],
            },
        )
        .is_err());
    }

    /// Mean absolute second difference, which rises with jitter and falls with smoothing.
    fn jitter(anchors: &[Anchor]) -> f64 {
        if anchors.len() < 3 {
            return 0.0;
        }
        let mut total = 0.0;
        for w in anchors.windows(3) {
            total += (w[0].midi - 2.0 * w[1].midi + w[2].midi).abs();
        }
        total / (anchors.len() - 2) as f64
    }

    #[test]
    fn smooth_span_reduces_jitter_without_replacing_the_contour() {
        let mut s = state();
        let times: Vec<f64> = (0..11).map(|i| 0.1 + i as f64 * 0.05).collect();
        for (i, t) in times.iter().enumerate() {
            let midi = 60.0 + if i % 2 == 0 { 1.0 } else { -1.0 } + i as f64 * 0.1;
            apply(
                &mut s,
                None,
                &EditOp::AddAnchor {
                    blob: BlobId(1),
                    anchor: Anchor::new(*t, midi),
                },
            )
            .unwrap();
        }
        let before = anchors_of(&s, 1);
        apply(
            &mut s,
            None,
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.0,
                end: 1.0,
                amount: 0.5,
            },
        )
        .unwrap();
        let after = anchors_of(&s, 1);

        assert_eq!(before.len(), after.len());
        for (a, b) in before.iter().zip(&after) {
            assert!((a.time - b.time).abs() < 1e-12, "times must not move");
        }
        assert!(jitter(&after) < jitter(&before) * 0.9);
        // Partial strength attenuates rather than flattening.
        assert!(jitter(&after) > 0.0);
        // The rising trend survives.
        assert!(after.last().unwrap().midi > after.first().unwrap().midi);
    }

    #[test]
    fn smooth_span_at_full_amount_removes_more_than_half() {
        let mut s = state();
        for i in 0..11 {
            let midi = 60.0 + if i % 2 == 0 { 1.0 } else { -1.0 };
            apply(
                &mut s,
                None,
                &EditOp::AddAnchor {
                    blob: BlobId(1),
                    anchor: Anchor::new(0.1 + i as f64 * 0.05, midi),
                },
            )
            .unwrap();
        }
        let before = jitter(&anchors_of(&s, 1));
        apply(
            &mut s,
            None,
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.0,
                end: 1.0,
                amount: 1.0,
            },
        )
        .unwrap();
        assert!(jitter(&anchors_of(&s, 1)) < before * 0.5);
    }

    #[test]
    fn smooth_span_leaves_anchors_outside_the_span_alone() {
        let mut s = state();
        for i in 0..9 {
            apply(
                &mut s,
                None,
                &EditOp::AddAnchor {
                    blob: BlobId(1),
                    anchor: Anchor::new(
                        0.05 + i as f64 * 0.1,
                        60.0 + if i % 2 == 0 { 1.0 } else { -1.0 },
                    ),
                },
            )
            .unwrap();
        }
        let before = anchors_of(&s, 1);
        apply(
            &mut s,
            None,
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.3,
                end: 0.6,
                amount: 1.0,
            },
        )
        .unwrap();
        let after = anchors_of(&s, 1);
        for (a, b) in before.iter().zip(&after) {
            if a.time < 0.3 || a.time > 0.6 {
                assert!((a.midi - b.midi).abs() < 1e-12, "moved outside the span");
            }
        }
    }

    #[test]
    fn smooth_span_materialises_detected_pitch_when_the_span_has_no_anchors() {
        let mut s = state();
        let track = jittery_track();
        apply(
            &mut s,
            Some(&track),
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.1,
                end: 0.9,
                amount: 1.0,
            },
        )
        .unwrap();
        let after = anchors_of(&s, 1);
        assert!(after.len() >= 3);
        assert!(after.iter().all(|a| a.time >= 0.1 && a.time <= 0.9));
        assert!(after.iter().all(|a| (a.midi - 60.0).abs() < 1.0));
    }

    #[test]
    fn smooth_span_without_a_track_or_anchors_does_nothing() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.1,
                end: 0.9,
                amount: 1.0,
            },
        )
        .unwrap();
        assert!(anchors_of(&s, 1).is_empty());
    }

    #[test]
    fn smooth_span_with_zero_amount_changes_nothing() {
        let mut s = state();
        let track = jittery_track();
        apply(
            &mut s,
            Some(&track),
            &EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.1,
                end: 0.9,
                amount: 0.0,
            },
        )
        .unwrap();
        assert!(anchors_of(&s, 1).is_empty());
    }

    #[test]
    fn reset_span_clears_only_its_anchors() {
        let mut s = state();
        for t in [0.1, 0.4, 0.5, 0.9] {
            apply(
                &mut s,
                None,
                &EditOp::AddAnchor {
                    blob: BlobId(1),
                    anchor: Anchor::new(t, 62.0),
                },
            )
            .unwrap();
        }
        apply(
            &mut s,
            None,
            &EditOp::ResetSpan {
                blob: BlobId(1),
                start: 0.3,
                end: 0.6,
            },
        )
        .unwrap();
        let times: Vec<f64> = anchors_of(&s, 1).iter().map(|a| a.time).collect();
        assert_eq!(times, vec![0.1, 0.9]);
    }

    #[test]
    fn reset_range_restores_the_analysed_segmentation() {
        let baseline = state().blobs;
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SplitBlob {
                blob: BlobId(1),
                time: 0.5,
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::SetPitchOffset {
                blob: BlobId(2),
                semitones: 4.0,
            },
        )
        .unwrap();
        assert_eq!(s.blobs.len(), 3);

        apply_with_baseline(
            &mut s,
            None,
            Some(&baseline),
            &EditOp::ResetRange {
                start: 0.0,
                end: 2.0,
            },
        )
        .unwrap();

        assert_eq!(s.blobs.len(), 2, "the split is undone");
        let spans: Vec<(f64, f64)> = s.blobs.blobs().iter().map(|b| (b.start, b.end)).collect();
        assert_eq!(spans, vec![(0.0, 1.0), (1.0, 2.0)]);
        assert_eq!(s.blobs.get(BlobId(2)).unwrap().pitch_offset, 0.0);
    }

    #[test]
    fn reset_range_leaves_blobs_outside_the_span_alone() {
        let baseline = state().blobs;
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SplitBlob {
                blob: BlobId(1),
                time: 0.5,
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::SetPitchOffset {
                blob: BlobId(2),
                semitones: 4.0,
            },
        )
        .unwrap();

        apply_with_baseline(
            &mut s,
            None,
            Some(&baseline),
            &EditOp::ResetRange {
                start: 0.0,
                end: 0.8,
            },
        )
        .unwrap();

        assert_eq!(
            s.blobs.len(),
            2,
            "the split halves collapse back into one blob"
        );
        assert_eq!(
            s.blobs.get(BlobId(2)).unwrap().pitch_offset,
            4.0,
            "a blob the span never reached keeps its edit"
        );
    }

    #[test]
    fn reset_range_without_a_baseline_is_refused() {
        let mut s = state();
        let err = apply(
            &mut s,
            None,
            &EditOp::ResetRange {
                start: 0.0,
                end: 1.0,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AxysError::Invalid(_)));
    }

    #[test]
    fn reset_range_rejects_an_empty_span() {
        let baseline = state().blobs;
        let mut s = state();
        assert!(apply_with_baseline(
            &mut s,
            None,
            Some(&baseline),
            &EditOp::ResetRange {
                start: 1.0,
                end: 1.0
            },
        )
        .is_err());
    }

    #[test]
    fn reset_blob_restores_detected_behaviour() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetPitchOffset {
                blob: BlobId(1),
                semitones: 3.0,
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::SetTimeScale {
                blob: BlobId(1),
                scale: 2.0,
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(0.5, 70.0),
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::SetExcluded {
                blob: BlobId(1),
                excluded: true,
            },
        )
        .unwrap();
        apply(&mut s, None, &EditOp::ResetBlob { blob: BlobId(1) }).unwrap();

        let b = s.blobs.get(BlobId(1)).unwrap();
        assert_eq!(b.pitch_offset, 0.0);
        assert_eq!(b.time_offset, 0.0);
        assert_eq!(b.time_scale, 1.0);
        assert!(b.curve.is_empty());
        assert!(!b.excluded);
        // Analysis evidence survives the reset.
        assert_eq!(b.detected_center, 60.0);
    }

    #[test]
    fn set_scale_stores_and_validates() {
        let mut s = state();
        let good = ScaleSettings {
            root: 2,
            degrees: vec![0, 2, 4, 5, 7, 9, 11],
            strength: 0.75,
            excluded: vec![11],
        };
        apply(
            &mut s,
            None,
            &EditOp::SetScale {
                scale: good.clone(),
            },
        )
        .unwrap();
        assert_eq!(s.scale, good);

        let mut bad = good.clone();
        bad.root = 12;
        assert!(apply(&mut s, None, &EditOp::SetScale { scale: bad }).is_err());

        let mut bad = good.clone();
        bad.degrees = vec![0, 13];
        assert!(apply(&mut s, None, &EditOp::SetScale { scale: bad }).is_err());

        let mut bad = good;
        bad.strength = 2.0;
        assert!(apply(&mut s, None, &EditOp::SetScale { scale: bad }).is_err());
    }

    #[test]
    fn set_tuning_stores_and_validates() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetTuning {
                tuning: Tuning { a4_hz: 432.0 },
            },
        )
        .unwrap();
        assert_eq!(s.tuning, Tuning { a4_hz: 432.0 });

        for bad in [379.0, 481.0, f64::NAN, f64::INFINITY] {
            assert!(
                apply(
                    &mut s,
                    None,
                    &EditOp::SetTuning {
                        tuning: Tuning { a4_hz: bad },
                    },
                )
                .is_err(),
                "{bad} was accepted"
            );
        }
        assert_eq!(s.tuning, Tuning { a4_hz: 432.0 });

        for edge in [MIN_A4_HZ, MAX_A4_HZ] {
            apply(
                &mut s,
                None,
                &EditOp::SetTuning {
                    tuning: Tuning { a4_hz: edge },
                },
            )
            .unwrap();
            assert_eq!(s.tuning.a4_hz, edge);
        }
    }

    #[test]
    fn set_accidentals_stores_the_style() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetAccidentals {
                accidentals: AccidentalStyle::Flats,
            },
        )
        .unwrap();
        assert_eq!(s.accidentals, AccidentalStyle::Flats);
    }

    #[test]
    fn tuning_and_accidentals_survive_a_replay() {
        let ops = [
            EditOp::SetTuning {
                tuning: Tuning { a4_hz: 442.0 },
            },
            EditOp::SetAccidentals {
                accidentals: AccidentalStyle::Flats,
            },
        ];
        let mut history = History::new();
        let mut s = state();
        for op in &ops {
            apply(&mut s, None, op).unwrap();
            history.push(op.clone());
        }
        assert_eq!(history.undo_label(), Some("Set Accidentals"));

        history.undo();
        let mut replayed = state();
        for op in history.applied() {
            apply(&mut replayed, None, op).unwrap();
        }
        assert_eq!(replayed.tuning, Tuning { a4_hz: 442.0 });
        assert_eq!(replayed.accidentals, AccidentalStyle::Sharps);

        let json = serde_json::to_string(&ops[0]).unwrap();
        assert!(json.contains("\"type\":\"setTuning\""), "{json}");
        assert!(json.contains("\"a4Hz\":442.0"), "{json}");
    }

    #[test]
    fn set_modulation_stores_and_validates() {
        let mut s = state();
        let good = ModulationSettings {
            drift: 0.5,
            vibrato_depth: 1.5,
            vibrato_split_hz: 4.0,
        };
        apply(&mut s, None, &EditOp::SetModulation { modulation: good }).unwrap();
        assert_eq!(s.modulation, good);

        let mut bad = good;
        bad.vibrato_split_hz = 0.0;
        assert!(apply(&mut s, None, &EditOp::SetModulation { modulation: bad }).is_err());

        let mut bad = good;
        bad.drift = -1.0;
        assert!(apply(&mut s, None, &EditOp::SetModulation { modulation: bad }).is_err());

        let mut bad = good;
        bad.vibrato_depth = f64::NAN;
        assert!(apply(&mut s, None, &EditOp::SetModulation { modulation: bad }).is_err());
    }

    #[test]
    fn set_formant_stores_and_bounds_the_shift() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetFormant {
                formant: FormantMode::Shift(-3.0),
            },
        )
        .unwrap();
        assert_eq!(s.formant, FormantMode::Shift(-3.0));
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetFormant {
                formant: FormantMode::Shift(99.0),
            },
        )
        .is_err());
        apply(
            &mut s,
            None,
            &EditOp::SetFormant {
                formant: FormantMode::Follow,
            },
        )
        .unwrap();
        assert_eq!(s.formant, FormantMode::Follow);
    }

    #[test]
    fn set_guide_stores_and_clears() {
        let mut s = state();
        let selection = GuideSelection {
            track: 1,
            channel: Some(0),
            mode: GuideMode::Combined,
            strength: 0.5,
            muted: false,
        };
        apply(
            &mut s,
            None,
            &EditOp::SetGuide {
                selection: Some(selection.clone()),
            },
        )
        .unwrap();
        assert_eq!(s.guide, Some(selection.clone()));

        let mut bad = selection;
        bad.strength = 3.0;
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetGuide {
                selection: Some(bad)
            },
        )
        .is_err());

        apply(&mut s, None, &EditOp::SetGuide { selection: None }).unwrap();
        assert!(s.guide.is_none());
    }

    #[test]
    fn set_mapping_upserts_by_blob() {
        let mut s = state();
        let first = NoteMapping {
            blob: BlobId(1),
            note: Some(3),
            manual: true,
            opted_out: false,
        };
        apply(&mut s, None, &EditOp::SetMapping { mapping: first }).unwrap();
        let second = NoteMapping {
            blob: BlobId(1),
            note: Some(4),
            manual: true,
            opted_out: false,
        };
        apply(&mut s, None, &EditOp::SetMapping { mapping: second }).unwrap();
        assert_eq!(s.mappings, vec![second]);

        let missing = NoteMapping {
            blob: BlobId(42),
            note: None,
            manual: true,
            opted_out: true,
        };
        assert!(matches!(
            apply(&mut s, None, &EditOp::SetMapping { mapping: missing }),
            Err(AxysError::NotFound(_))
        ));
    }

    #[test]
    fn set_mappings_replaces_the_whole_set_and_validates() {
        let mut s = state();
        let one = NoteMapping {
            blob: BlobId(1),
            note: Some(0),
            manual: false,
            opted_out: false,
        };
        let two = NoteMapping {
            blob: BlobId(2),
            note: Some(1),
            manual: false,
            opted_out: false,
        };
        apply(
            &mut s,
            None,
            &EditOp::SetMappings {
                mappings: vec![one, two],
            },
        )
        .unwrap();
        assert_eq!(s.mappings, vec![one, two]);

        apply(
            &mut s,
            None,
            &EditOp::SetMappings {
                mappings: vec![two],
            },
        )
        .unwrap();
        assert_eq!(s.mappings, vec![two]);

        let missing = NoteMapping {
            blob: BlobId(42),
            note: Some(0),
            manual: true,
            opted_out: false,
        };
        assert!(matches!(
            apply(
                &mut s,
                None,
                &EditOp::SetMappings {
                    mappings: vec![two, missing],
                },
            ),
            Err(AxysError::NotFound(_))
        ));
        assert_eq!(s.mappings, vec![two]);
    }

    #[test]
    fn timeline_ops_update_the_map() {
        let mut s = state();
        apply(&mut s, None, &EditOp::SetTimelineOrigin { seconds: -0.25 }).unwrap();
        assert!((s.timeline.origin_seconds + 0.25).abs() < 1e-12);
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetTimelineOrigin { seconds: f64::NAN },
        )
        .is_err());

        apply(
            &mut s,
            None,
            &EditOp::SetTempoMap {
                events: vec![TempoEvent {
                    tick: 0,
                    micros_per_quarter: 400_000,
                }],
            },
        )
        .unwrap();
        assert!((s.timeline.bpm_at_tick(0) - 150.0).abs() < 1e-6);

        apply(
            &mut s,
            None,
            &EditOp::SetMeterMap {
                events: vec![MeterEvent {
                    tick: 0,
                    numerator: 3,
                    denominator: 4,
                }],
            },
        )
        .unwrap();
        assert_eq!(s.timeline.meter_at_tick(0).numerator, 3);

        assert!(apply(
            &mut s,
            None,
            &EditOp::SetMeterMap {
                events: vec![MeterEvent {
                    tick: 0,
                    numerator: 0,
                    denominator: 4,
                }],
            },
        )
        .is_err());
    }

    #[test]
    fn blob_ops_report_a_missing_id() {
        let mut s = state();
        let missing = BlobId(404);
        let ops = vec![
            EditOp::SplitBlob {
                blob: missing,
                time: 0.5,
            },
            EditOp::JoinBlobs {
                first: missing,
                second: BlobId(1),
            },
            EditOp::MoveBoundary {
                blob: missing,
                edge: Edge::Start,
                time: 0.1,
            },
            EditOp::SetVoicing {
                blob: missing,
                start: 0.0,
                end: 0.1,
                voicing: Voicing::Voiced,
            },
            EditOp::MovePitch {
                blobs: vec![missing],
                semitones: 1.0,
            },
            EditOp::SetPitchOffset {
                blob: missing,
                semitones: 1.0,
            },
            EditOp::MoveTime {
                blobs: vec![missing],
                seconds: 0.1,
            },
            EditOp::SetTimeScale {
                blob: missing,
                scale: 1.1,
            },
            EditOp::AddAnchor {
                blob: missing,
                anchor: Anchor::new(0.1, 60.0),
            },
            EditOp::MoveAnchor {
                blob: missing,
                index: 0,
                time: 0.1,
                midi: 60.0,
            },
            EditOp::RemoveAnchor {
                blob: missing,
                index: 0,
            },
            EditOp::DrawSpan {
                blob: missing,
                anchors: vec![Anchor::new(0.1, 60.0)],
            },
            EditOp::SmoothSpan {
                blob: missing,
                start: 0.0,
                end: 0.5,
                amount: 0.5,
            },
            EditOp::ResetSpan {
                blob: missing,
                start: 0.0,
                end: 0.5,
            },
            EditOp::ResetBlob { blob: missing },
            EditOp::SetExcluded {
                blob: missing,
                excluded: true,
            },
        ];
        for op in ops {
            let err = apply(&mut s, None, &op).unwrap_err();
            assert!(
                matches!(err, AxysError::NotFound(_)),
                "{} gave {err}",
                op.label()
            );
        }
    }

    #[test]
    fn labels_are_title_case_of_two_or_three_words() {
        let ops = vec![
            EditOp::SplitBlob {
                blob: BlobId(1),
                time: 0.5,
            },
            EditOp::JoinBlobs {
                first: BlobId(1),
                second: BlobId(2),
            },
            EditOp::MoveBoundary {
                blob: BlobId(1),
                edge: Edge::Start,
                time: 0.1,
            },
            EditOp::SetVoicing {
                blob: BlobId(1),
                start: 0.0,
                end: 0.1,
                voicing: Voicing::Voiced,
            },
            EditOp::MovePitch {
                blobs: vec![],
                semitones: 0.0,
            },
            EditOp::SetPitchOffset {
                blob: BlobId(1),
                semitones: 0.0,
            },
            EditOp::MoveTime {
                blobs: vec![],
                seconds: 0.0,
            },
            EditOp::SetTimeScale {
                blob: BlobId(1),
                scale: 1.0,
            },
            EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(0.0, 60.0),
            },
            EditOp::MoveAnchor {
                blob: BlobId(1),
                index: 0,
                time: 0.0,
                midi: 60.0,
            },
            EditOp::RemoveAnchor {
                blob: BlobId(1),
                index: 0,
            },
            EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: vec![],
            },
            EditOp::SmoothSpan {
                blob: BlobId(1),
                start: 0.0,
                end: 1.0,
                amount: 0.5,
            },
            EditOp::ResetSpan {
                blob: BlobId(1),
                start: 0.0,
                end: 1.0,
            },
            EditOp::ResetBlob { blob: BlobId(1) },
            EditOp::SetExcluded {
                blob: BlobId(1),
                excluded: true,
            },
            EditOp::SetScale {
                scale: ScaleSettings::default(),
            },
            EditOp::SetTuning {
                tuning: Tuning::default(),
            },
            EditOp::SetAccidentals {
                accidentals: AccidentalStyle::default(),
            },
            EditOp::SetModulation {
                modulation: ModulationSettings::default(),
            },
            EditOp::SetFormant {
                formant: FormantMode::default(),
            },
            EditOp::SetGuide { selection: None },
            EditOp::SetMapping {
                mapping: NoteMapping {
                    blob: BlobId(1),
                    note: None,
                    manual: false,
                    opted_out: false,
                },
            },
            EditOp::SetTimelineOrigin { seconds: 0.0 },
            EditOp::SetTempoMap { events: vec![] },
            EditOp::SetMeterMap { events: vec![] },
            EditOp::Group { ops: Vec::new() },
        ];
        assert_eq!(ops.len(), 27);
        for op in &ops {
            let label = op.label();
            let words: Vec<&str> = label.split(' ').collect();
            assert!(
                (2..=3).contains(&words.len()),
                "{label} has {} words",
                words.len()
            );
            for word in words {
                let mut chars = word.chars();
                let first = chars.next().unwrap();
                assert!(first.is_ascii_uppercase(), "{label} is not Title Case");
                assert!(
                    chars.all(|c| c.is_ascii_lowercase()),
                    "{label} is not Title Case"
                );
            }
        }
    }

    #[test]
    fn history_undo_and_redo_keep_order() {
        let mut h = History::new();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
        assert!(h.undo().is_none());
        assert!(h.redo().is_none());

        let a = EditOp::SetAccidentals {
            accidentals: AccidentalStyle::Flats,
        };
        let b = EditOp::SetTimelineOrigin { seconds: 1.0 };
        h.push(a.clone());
        h.push(b.clone());
        assert_eq!(h.applied(), &[a.clone(), b.clone()]);
        assert_eq!(h.undo_label(), Some("Align Timeline"));

        assert_eq!(h.undo(), Some(b.clone()));
        assert_eq!(h.applied(), std::slice::from_ref(&a));
        assert_eq!(h.undo_label(), Some("Set Accidentals"));
        assert_eq!(h.redo_label(), Some("Align Timeline"));

        assert_eq!(h.undo(), Some(a.clone()));
        assert!(!h.can_undo());

        assert_eq!(h.redo(), Some(a.clone()));
        assert_eq!(h.redo(), Some(b.clone()));
        assert_eq!(h.applied(), &[a, b]);
        assert!(!h.can_redo());
    }

    #[test]
    fn push_clears_the_redo_stack() {
        let mut h = History::new();
        h.push(EditOp::SetTimelineOrigin { seconds: 2.0 });
        h.undo();
        assert!(h.can_redo());
        h.push(EditOp::SetTimelineOrigin { seconds: 3.0 });
        assert!(!h.can_redo());
        assert_eq!(h.redo_label(), None);
        assert_eq!(h.applied().len(), 1);
    }

    #[test]
    fn clear_empties_both_stacks() {
        let mut h = History::new();
        h.push(EditOp::SetTimelineOrigin { seconds: 2.0 });
        h.push(EditOp::SetTimelineOrigin { seconds: 3.0 });
        h.undo();
        h.clear();
        assert!(!h.can_undo());
        assert!(!h.can_redo());
        assert!(h.applied().is_empty());
    }

    #[test]
    fn history_drops_the_oldest_past_the_cap() {
        let mut h = History::new();
        for i in 0..MAX_HISTORY_OPS + 5 {
            h.push(EditOp::SetTimelineOrigin { seconds: i as f64 });
        }
        assert_eq!(h.applied().len(), MAX_HISTORY_OPS);
        assert_eq!(h.applied()[0], EditOp::SetTimelineOrigin { seconds: 5.0 });
    }

    #[test]
    fn replaying_the_history_reproduces_the_state() {
        let ops = vec![
            EditOp::SplitBlob {
                blob: BlobId(1),
                time: 0.5,
            },
            EditOp::MovePitch {
                blobs: vec![BlobId(1)],
                semitones: 2.0,
            },
            EditOp::AddAnchor {
                blob: BlobId(2),
                anchor: Anchor::new(1.5, 64.0),
            },
            EditOp::SetTimelineOrigin { seconds: 4.0 },
        ];
        let mut history = History::new();
        let mut first = state();
        for op in &ops {
            apply(&mut first, None, op).unwrap();
            history.push(op.clone());
        }
        history.undo();

        let mut replayed = state();
        for op in history.applied() {
            apply(&mut replayed, None, op).unwrap();
        }
        assert_ne!(replayed, first);

        history.redo();
        let mut replayed = state();
        for op in history.applied() {
            apply(&mut replayed, None, op).unwrap();
        }
        assert_eq!(replayed, first);
    }

    #[test]
    fn ops_round_trip_through_json_with_a_tag() {
        let op = EditOp::MovePitch {
            blobs: vec![BlobId(1), BlobId(2)],
            semitones: -1.25,
        };
        let json = serde_json::to_string(&op).unwrap();
        assert!(json.contains("\"type\":\"movePitch\""), "{json}");
        let back: EditOp = serde_json::from_str(&json).unwrap();
        assert_eq!(op, back);

        let h = {
            let mut h = History::new();
            h.push(op);
            h.undo();
            h
        };
        let json = serde_json::to_string(&h).unwrap();
        let back: History = serde_json::from_str(&json).unwrap();
        assert_eq!(h, back);
    }

    #[test]
    fn malformed_op_json_is_rejected() {
        assert!(serde_json::from_str::<EditOp>("{\"type\":\"noSuchOp\"}").is_err());
        assert!(serde_json::from_str::<EditOp>("{\"type\":\"splitBlob\"}").is_err());
        assert!(serde_json::from_str::<EditOp>("[]").is_err());
    }
}
