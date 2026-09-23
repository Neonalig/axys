// SPDX-License-Identifier: AGPL-3.0-or-later

//! Serialisable user intent and the undo history that orders it.
//!
//! An operation records what the user meant, never the audio it produced. Applying one
//! touches only [`crate::project::EditState`], so analysis stays immutable evidence and any
//! state is reachable again by replaying the operations that built it.

use serde::{Deserialize, Serialize};

use crate::analysis::f0::PitchTrack;
use crate::blob::{Blob, BlobId, BlobSet, Edge, Subregion, Voicing};
use crate::clip::{
    clip_of, fit_to_source, free_position, numbered_for, ripple_insert, Clip, ClipId, Reference,
    ReferenceId, Span, MAX_CLIPS, MAX_REFERENCES,
};
use crate::curve::{Anchor, Interp, PitchCurve, Stroke};
use crate::dsp::formant::FormantMode;
use crate::midi::{GuideSelection, NoteMapping};
use crate::mixer::MixerSettings;
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
        /// Read from recorded histories and otherwise ignored.
        ///
        /// A drawn curve is heard with the blob's offset added, so the offset alone already moves
        /// it. Histories recorded while this also transposed the anchors replay with the move
        /// heard once rather than twice.
        #[serde(default, skip_serializing_if = "is_false")]
        anchors: bool,
    },
    /// Sets one blob's transposition to an absolute amount.
    SetPitchOffset {
        /// Blob to transpose.
        blob: BlobId,
        /// Absolute transposition in semitones.
        semitones: f64,
        /// Read from recorded histories and otherwise ignored, as for [`EditOp::MovePitch`].
        #[serde(default, skip_serializing_if = "is_false")]
        anchors: bool,
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
    /// Removes blobs and silences the material they covered.
    DeleteBlobs {
        /// Blobs to delete.
        blobs: Vec<BlobId>,
        /// Leaves the material playing as it was sung instead of silencing it.
        #[serde(default, skip_serializing_if = "is_false")]
        keep_audio: bool,
    },
    /// Puts new blobs over audio no blob covers.
    AddBlobs {
        /// The blobs, in project seconds. Each id names the clip it goes to; the blob is given a
        /// fresh id in that clip, and its detected centre is read from the clip's audio.
        blobs: Vec<Blob>,
    },
    /// Slides a blob along the audio, so it covers different material without moving any.
    ShiftBlob {
        /// Blob to slide.
        blob: BlobId,
        /// Distance in seconds, held so the blob stays between its neighbours and in its clip.
        seconds: f64,
    },
    /// Replaces what a blob sounds across a span, leaving the rest of the blob as it was.
    ReplacePitch {
        /// Blob holding the span.
        blob: BlobId,
        /// Span start in project seconds.
        start: f64,
        /// Span end in project seconds.
        end: f64,
        /// What the span sounds afterwards.
        fill: PitchFill,
    },
    /// Sets the part of a clip's audio that is heard.
    TrimClip {
        /// Clip to trim.
        clip: ClipId,
        /// First project second heard.
        start: f64,
        /// Last project second heard.
        end: f64,
    },
    /// Puts an imported vocal on the timeline.
    AddClip {
        /// The clip, its blobs numbered for it. Placed as `exact` and `ripple` say.
        clip: Clip,
        /// Inserts the clip at its position, moving every clip after it later to make room, as
        /// [`ripple_insert`] describes.
        #[serde(default, skip_serializing_if = "is_false")]
        ripple: bool,
        /// Places the clip at its position, over any clip already there. Without it or `ripple`,
        /// a position that would overlap another clip moves to the nearest free one.
        #[serde(default, skip_serializing_if = "is_false")]
        exact: bool,
    },
    /// Moves a clip along the timeline.
    MoveClip {
        /// Clip to move.
        clip: ClipId,
        /// Wanted position in project seconds.
        position: f64,
        /// Places the clip at `position`, over any clip already there. Without it or `ripple`, an
        /// overlapping position lands on the nearest free one.
        #[serde(default, skip_serializing_if = "is_false")]
        exact: bool,
        /// Inserts the clip at `position`, moving every other clip at or after it later to make
        /// room, as [`ripple_insert`] describes.
        #[serde(default, skip_serializing_if = "is_false")]
        ripple: bool,
    },
    /// Takes a clip off the lane.
    RemoveClip {
        /// Clip to remove.
        clip: ClipId,
    },
    /// Brings in audio heard beside the vocal.
    AddReference {
        /// The reference to add.
        reference: Reference,
    },
    /// Moves a reference along the timeline.
    MoveReference {
        /// Reference to move.
        reference: ReferenceId,
        /// New start in project seconds.
        position: f64,
    },
    /// Names a clip in place of its file's name, or goes back to the file's name with `None`.
    RenameClip {
        /// Clip to rename.
        clip: ClipId,
        /// New name, which may not be blank once trimmed.
        name: Option<String>,
    },
    /// Names a reference in place of its file's name, or goes back to it with `None`.
    RenameReference {
        /// Reference to rename.
        reference: ReferenceId,
        /// New name, which may not be blank once trimmed.
        name: Option<String>,
    },
    /// Takes a reference out of the project.
    RemoveReference {
        /// Reference to remove.
        reference: ReferenceId,
    },
    /// Replaces the monitor levels.
    SetMixer {
        /// New mixer settings.
        mixer: MixerSettings,
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
    /// Renames the project.
    SetName {
        /// New name, which may not be blank once trimmed.
        name: String,
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
    /// Keeps a drawn curve whole, replacing the one with its id.
    SetStroke {
        /// The stroke, whose id is new or names the one it replaces.
        stroke: Stroke,
    },
    /// Forgets a kept curve. What it wrote into blobs is left as it is.
    RemoveStroke {
        /// Id of the stroke to forget.
        stroke: u32,
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
            EditOp::DeleteBlobs { .. } => "Delete Blobs",
            EditOp::AddBlobs { .. } => "Add Blobs",
            EditOp::ShiftBlob { .. } => "Move Blob",
            EditOp::ReplacePitch { .. } => "Replace Pitch",
            EditOp::TrimClip { .. } => "Trim Clip",
            EditOp::AddClip { .. } => "Import Clip",
            EditOp::MoveClip { .. } => "Move Clip",
            EditOp::RemoveClip { .. } => "Delete Clip",
            EditOp::AddReference { .. } => "Import Reference",
            EditOp::MoveReference { .. } => "Move Reference",
            EditOp::RemoveReference { .. } => "Delete Reference",
            EditOp::RenameClip { .. } => "Rename Clip",
            EditOp::RenameReference { .. } => "Rename Reference",
            EditOp::SetMixer { .. } => "Set Mixer",
            EditOp::SetScale { .. } => "Set Scale",
            EditOp::SetTuning { .. } => "Set Tuning",
            EditOp::SetName { .. } => "Rename Project",
            EditOp::SetAccidentals { .. } => "Set Accidentals",
            EditOp::SetModulation { .. } => "Set Modulation",
            EditOp::SetFormant { .. } => "Set Formant",
            EditOp::SetGuide { .. } => "Set Guide",
            EditOp::SetMapping { .. } => "Set Mapping",
            EditOp::SetMappings { .. } => "Set Mappings",
            EditOp::SetTimelineOrigin { .. } => "Align Timeline",
            EditOp::SetTempoMap { .. } => "Set Tempo Map",
            EditOp::SetMeterMap { .. } => "Set Meter Map",
            EditOp::SetStroke { .. } => "Draw Curve",
            EditOp::RemoveStroke { .. } => "Delete Curve",
            EditOp::Group { .. } => "Grouped Edit",
        }
    }
}

/// What a span of a blob sounds after [`EditOp::ReplacePitch`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PitchFill {
    /// A heard contour, in project seconds and fractional MIDI.
    Contour {
        /// Points of the contour in time order.
        anchors: Vec<Anchor>,
    },
    /// The blob's own pitch, as it sounds with no curve drawn. Across the whole blob it also
    /// clears the blob's offset, so the blob sounds as it was sung.
    Sung,
    /// Whatever was drawn across the span let go, leaving the blob's own pitch with its offset.
    Release,
    /// A level line at the span's median detected pitch, moved by the blob's offset.
    Flat,
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

impl EditOp {
    /// Whether the operation reads or changes a clip or any of its blobs.
    ///
    /// A range reset touches every clip, since it reaches whatever lies under its span.
    pub fn touches_clip(&self, clip: ClipId) -> bool {
        let one = |blob: &BlobId| clip_of(*blob) == clip;
        match self {
            EditOp::SplitBlob { blob, .. }
            | EditOp::MoveBoundary { blob, .. }
            | EditOp::SetVoicing { blob, .. }
            | EditOp::SetPitchOffset { blob, .. }
            | EditOp::SetTimeScale { blob, .. }
            | EditOp::AddAnchor { blob, .. }
            | EditOp::MoveAnchor { blob, .. }
            | EditOp::RemoveAnchor { blob, .. }
            | EditOp::DrawSpan { blob, .. }
            | EditOp::SmoothSpan { blob, .. }
            | EditOp::ResetSpan { blob, .. }
            | EditOp::ResetBlob { blob }
            | EditOp::SetExcluded { blob, .. }
            | EditOp::SetGain { blob, .. }
            | EditOp::ShiftBlob { blob, .. }
            | EditOp::ReplacePitch { blob, .. } => one(blob),
            EditOp::AddBlobs { blobs } => blobs.iter().any(|blob| one(&blob.id)),
            EditOp::JoinBlobs { first, second } => one(first) || one(second),
            EditOp::MovePitch { blobs, .. }
            | EditOp::MoveTime { blobs, .. }
            | EditOp::DeleteBlobs { blobs, .. } => blobs.iter().any(one),
            EditOp::SetMapping { mapping } => one(&mapping.blob),
            EditOp::SetMappings { mappings } => mappings.iter().any(|m| one(&m.blob)),
            EditOp::ResetRange { .. } => true,
            EditOp::AddClip { clip: added, .. } => added.id == clip,
            EditOp::MoveClip { clip: moved, .. }
            | EditOp::RemoveClip { clip: moved }
            | EditOp::RenameClip { clip: moved, .. }
            | EditOp::TrimClip { clip: moved, .. } => *moved == clip,
            EditOp::Group { ops } => ops.iter().any(|op| op.touches_clip(clip)),
            _ => false,
        }
    }
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

    /// The applied operations, oldest first, for rewriting in place.
    pub fn applied_mut(&mut self) -> &mut [EditOp] {
        &mut self.applied
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

/// The per-clip evidence an operation may read: each clip's detected pitch and the segmentation
/// its analysis produced.
pub trait ClipSources {
    /// Detected pitch of a clip, in its source seconds.
    fn track(&self, clip: ClipId) -> Option<&PitchTrack>;
    /// The analysed segmentation of a clip, which a range reset restores.
    fn baseline(&self, clip: ClipId) -> Option<&BlobSet>;
}

/// The same evidence for every clip, which is what a project with one source has.
struct Uniform<'a> {
    track: Option<&'a PitchTrack>,
    baseline: Option<&'a BlobSet>,
}

impl ClipSources for Uniform<'_> {
    fn track(&self, _clip: ClipId) -> Option<&PitchTrack> {
        self.track
    }

    fn baseline(&self, _clip: ClipId) -> Option<&BlobSet> {
        self.baseline
    }
}

/// Applies one operation to the mutable parts of a project.
///
/// Analysis results are never modified, so any op can be recomputed from the source. `track` is
/// read for every clip, which suits a project with one.
pub fn apply(state: &mut EditState, track: Option<&PitchTrack>, op: &EditOp) -> Result<()> {
    apply_with_baseline(state, track, None, op)
}

/// Applies one operation, with the analysed segmentation available to restore from.
///
/// Only [`EditOp::ResetRange`] needs `baseline`; every other operation ignores it. A
/// `ResetRange` without one fails rather than silently resetting nothing, because the caller
/// asked for the analysed blobs back and there is nothing else to give them. Like [`apply`], the
/// same evidence is read for every clip.
pub fn apply_with_baseline(
    state: &mut EditState,
    track: Option<&PitchTrack>,
    baseline: Option<&BlobSet>,
    op: &EditOp,
) -> Result<()> {
    apply_in(state, &Uniform { track, baseline }, op)
}

/// Applies one operation, reading each clip's own evidence from `sources`.
///
/// Times in an operation are project seconds. Each is moved into the owning clip's source
/// seconds before it reaches the clip, so the clip's blobs never change meaning when the clip
/// moves.
pub fn apply_in(state: &mut EditState, sources: &dyn ClipSources, op: &EditOp) -> Result<()> {
    match op {
        EditOp::SplitBlob { blob, time } => {
            let track = sources.track(clip_of(*blob));
            let clip = owner(state, *blob)?;
            let at = finite(*time, "split time")? - clip.position;
            clip.blobs.split(*blob, at, track)?;
        }
        EditOp::JoinBlobs { first, second } => {
            if clip_of(*first) != clip_of(*second) {
                return Err(AxysError::Invalid(
                    "blobs from different clips cannot be joined".into(),
                ));
            }
            let track = sources.track(clip_of(*first));
            owner(state, *first)?.blobs.join(*first, *second, track)?;
        }
        EditOp::MoveBoundary { blob, edge, time } => {
            let clip = owner(state, *blob)?;
            // Held inside the clip's own audio, so an edge dragged past it cannot reach a blob of
            // the clip beside it.
            let window = clip.window();
            let at =
                (finite(*time, "boundary time")? - clip.position).clamp(window.start, window.end);
            clip.blobs.move_boundary(*blob, *edge, at)?;
        }
        EditOp::SetVoicing {
            blob,
            start,
            end,
            voicing,
        } => {
            let (start, end) = finite_span(*start, *end)?;
            let clip = owner(state, *blob)?;
            let offset = clip.position;
            clip.blobs
                .set_voicing(*blob, start - offset, end - offset, *voicing)?;
        }
        EditOp::MovePitch {
            blobs, semitones, ..
        } => {
            let semitones = finite(*semitones, "pitch move")?;
            for id in require_all(state, blobs)? {
                if let Some(b) = state.blob_mut(id) {
                    b.pitch_offset += semitones;
                }
            }
        }
        EditOp::SetPitchOffset {
            blob, semitones, ..
        } => {
            let semitones = finite(*semitones, "pitch offset")?;
            blob_mut(state, *blob)?.pitch_offset = semitones;
        }
        EditOp::MoveTime { blobs, seconds } => {
            let seconds = finite(*seconds, "time move")?;
            for id in require_all(state, blobs)? {
                if let Some(b) = state.blob_mut(id) {
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
            let mut anchor = *anchor;
            finite(anchor.time, "anchor time")?;
            finite(anchor.midi, "anchor pitch")?;
            anchor.time -= position_of(state, *blob)?;
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
            let at = finite(*time, "anchor time")? - position_of(state, *blob)?;
            blob_mut(state, *blob)?
                .curve
                .move_anchor(*index, at, *midi)?;
        }
        EditOp::RemoveAnchor { blob, index } => {
            blob_mut(state, *blob)?.curve.remove(*index)?;
        }
        EditOp::DrawSpan { blob, anchors } => {
            let offset = position_of(state, *blob)?;
            let local: Vec<Anchor> = anchors
                .iter()
                .map(|anchor| Anchor {
                    time: anchor.time - offset,
                    ..*anchor
                })
                .collect();
            draw_span(&mut blob_mut(state, *blob)?.curve, &local)?;
        }
        EditOp::SmoothSpan {
            blob,
            start,
            end,
            amount,
        } => {
            let (start, end) = finite_span(*start, *end)?;
            let amount = finite(*amount, "smoothing amount")?.clamp(0.0, 1.0);
            let track = sources.track(clip_of(*blob));
            let offset = position_of(state, *blob)?;
            let blob = blob_mut(state, *blob)?;
            let (blob_start, blob_end) = (blob.start, blob.end);
            let start = (start - offset).max(blob_start);
            let end = (end - offset).min(blob_end);
            if amount > 0.0 && end > start {
                materialise_span(&mut blob.curve, track, start, end)?;
                smooth_span(&mut blob.curve, start, end, amount)?;
            }
        }
        EditOp::ResetSpan { blob, start, end } => {
            let (start, end) = finite_span(*start, *end)?;
            let offset = position_of(state, *blob)?;
            blob_mut(state, *blob)?
                .curve
                .clear_span(start - offset, end - offset);
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
            for clip in &mut state.clips {
                let (from, to) = (start - clip.position, end - clip.position);
                if to <= 0.0 || from >= clip.source.duration {
                    continue;
                }
                let Some(baseline) = sources.baseline(clip.id) else {
                    return Err(AxysError::Invalid(
                        "range includes a clip with no analysis".into(),
                    ));
                };
                clip.blobs.restore_range(baseline, from, to)?;
                // Deleted blobs are part of the segmentation, so restoring it brings them back.
                clip.unsilence(from, to);
            }
            // Restoring the segmentation discards blob ids, so any guide mapping onto one that
            // no longer exists goes with it rather than being left pointing at nothing.
            forget_missing_mappings(state);
        }
        EditOp::SetExcluded { blob, excluded } => {
            blob_mut(state, *blob)?.excluded = *excluded;
        }
        EditOp::SetGain { blob, gain_db } => {
            let gain_db = finite(*gain_db, "gain")?;
            blob_mut(state, *blob)?.gain_db =
                gain_db.clamp(crate::limits::MIN_GAIN_DB, crate::limits::MAX_GAIN_DB);
        }
        EditOp::DeleteBlobs { blobs, keep_audio } => {
            for id in require_all(state, blobs)? {
                let clip = owner(state, id)?;
                let removed = clip.blobs.remove(id)?;
                if !*keep_audio {
                    clip.silence(Span {
                        start: removed.start,
                        end: removed.end,
                    });
                }
            }
            forget_missing_mappings(state);
        }
        EditOp::AddBlobs { blobs } => {
            for blob in blobs {
                let id = clip_of(blob.id);
                let track = sources.track(id);
                let clip = state
                    .clip_mut(id)
                    .ok_or_else(|| AxysError::NotFound(format!("clip {}", id.0)))?;
                let window = clip.window();
                let mut local = blob.shifted(-clip.position);
                if local.start < window.start - 1e-6 || local.end > window.end + 1e-6 {
                    return Err(AxysError::Invalid(
                        "a new blob lies outside its clip's audio".into(),
                    ));
                }
                local.start = local.start.max(window.start);
                local.end = local.end.min(window.end);
                if local.subregions.is_empty() {
                    local.subregions =
                        vec![Subregion::new(local.start, local.end, Voicing::Voiced)];
                }
                local.id = fresh_blob_id(&clip.blobs, id);
                local.rederive_center(track);
                clip.blobs.insert(local)?;
            }
        }
        EditOp::ShiftBlob { blob, seconds } => {
            let seconds = finite(*seconds, "blob shift")?;
            let track = sources.track(clip_of(*blob));
            let clip = owner(state, *blob)?;
            let window = clip.window();
            clip.blobs
                .shift_span(*blob, seconds, window.start, window.end, track)?;
        }
        EditOp::ReplacePitch {
            blob,
            start,
            end,
            fill,
        } => {
            let (start, end) = finite_span(*start, *end)?;
            let track = sources.track(clip_of(*blob));
            let offset = position_of(state, *blob)?;
            let target = blob_mut(state, *blob)?;
            replace_pitch(target, start - offset, end - offset, fill, offset, track)?;
        }
        EditOp::TrimClip { clip, start, end } => {
            let (start, end) = finite_span(*start, *end)?;
            let target = state
                .clip_mut(*clip)
                .ok_or_else(|| AxysError::NotFound(format!("clip {}", clip.0)))?;
            let duration = target.source.duration.max(0.0);
            let from = (start - target.position).clamp(0.0, duration);
            let to = (end - target.position).clamp(0.0, duration);
            if to - from < MIN_CLIP_SECONDS {
                return Err(AxysError::Invalid(format!(
                    "a clip is at least {MIN_CLIP_SECONDS} s long"
                )));
            }
            target.window = if from <= 1e-9 && to >= duration - 1e-9 {
                None
            } else {
                Some(Span {
                    start: from,
                    end: to,
                })
            };
        }
        EditOp::AddClip {
            clip,
            ripple,
            exact,
        } => {
            if state.clips.len() >= MAX_CLIPS {
                return Err(AxysError::Invalid(format!(
                    "a project holds at most {MAX_CLIPS} clips"
                )));
            }
            if state.clip(clip.id).is_some() {
                return Err(AxysError::Invalid(format!(
                    "clip {} is already on the lane",
                    clip.id.0
                )));
            }
            if !numbered_for(&clip.blobs, clip.id) {
                return Err(AxysError::Invalid(format!(
                    "clip {} carries blobs numbered for another clip",
                    clip.id.0
                )));
            }
            let duration = finite(clip.source.duration, "clip duration")?;
            if duration <= 0.0 {
                return Err(AxysError::Invalid("clip is empty".into()));
            }
            let mut clip = clip.clone();
            fit_to_source(&mut clip.blobs, duration);
            if let Some(window) = clip.window {
                let (from, to) = finite_span(window.start, window.end)?;
                if to - from < MIN_CLIP_SECONDS {
                    return Err(AxysError::Invalid(format!(
                        "a clip is at least {MIN_CLIP_SECONDS} s long"
                    )));
                }
            }
            let window = clip.window();
            let length = window.end - window.start;
            // Placed by where it starts being heard, so a trimmed clip lands where it is put.
            let wanted = finite(clip.position, "clip position")? + window.start;
            let spans = lane_spans(state, None);
            let at = if *exact {
                wanted.max(0.0)
            } else if *ripple {
                let (at, shift) = ripple_insert(&spans, length, wanted);
                for other in &mut state.clips {
                    if other.start() >= at - 1e-9 {
                        other.position += shift;
                    }
                }
                at
            } else {
                free_position(&spans, length, wanted)
            };
            clip.position = at - window.start;
            state.clips.push(clip);
        }
        EditOp::MoveClip {
            clip,
            position,
            exact,
            ripple,
        } => {
            let others = lane_spans(state, Some(*clip));
            let window = state
                .clip(*clip)
                .ok_or_else(|| AxysError::NotFound(format!("clip {}", clip.0)))?
                .window();
            let length = window.end - window.start;
            // `position` is still where source second 0 goes; the lane is read by where the clip
            // starts being heard.
            let wanted = finite(*position, "clip position")? + window.start;
            let at = if *ripple {
                let (at, shift) = ripple_insert(&others, length, wanted);
                for other in state.clips.iter_mut().filter(|other| other.id != *clip) {
                    if other.start() >= at - 1e-9 {
                        other.position += shift;
                    }
                }
                at
            } else if *exact {
                wanted.max(0.0)
            } else {
                free_position(&others, length, wanted)
            };
            if let Some(target) = state.clip_mut(*clip) {
                target.position = at - window.start;
            }
        }
        EditOp::RemoveClip { clip } => {
            let before = state.clips.len();
            state.clips.retain(|entry| entry.id != *clip);
            if state.clips.len() == before {
                return Err(AxysError::NotFound(format!("clip {}", clip.0)));
            }
            forget_missing_mappings(state);
        }
        EditOp::AddReference { reference } => {
            if state.references.len() >= MAX_REFERENCES {
                return Err(AxysError::Invalid(format!(
                    "a project holds at most {MAX_REFERENCES} references"
                )));
            }
            if state.reference(reference.id).is_some() {
                return Err(AxysError::Invalid(format!(
                    "reference {} is already in the project",
                    reference.id.0
                )));
            }
            let mut reference = reference.clone();
            reference.position = finite(reference.position, "reference position")?.max(0.0);
            state.references.push(reference);
        }
        EditOp::MoveReference {
            reference,
            position,
        } => {
            let position = finite(*position, "reference position")?.max(0.0);
            state
                .references
                .iter_mut()
                .find(|entry| entry.id == *reference)
                .ok_or_else(|| AxysError::NotFound(format!("reference {}", reference.0)))?
                .position = position;
        }
        EditOp::RenameClip { clip, name } => {
            let name = source_name(name.as_deref())?;
            state
                .clip_mut(*clip)
                .ok_or_else(|| AxysError::NotFound(format!("clip {}", clip.0)))?
                .name = name;
        }
        EditOp::RenameReference { reference, name } => {
            let name = source_name(name.as_deref())?;
            state
                .references
                .iter_mut()
                .find(|entry| entry.id == *reference)
                .ok_or_else(|| AxysError::NotFound(format!("reference {}", reference.0)))?
                .name = name;
        }
        EditOp::RemoveReference { reference } => {
            let before = state.references.len();
            state.references.retain(|entry| entry.id != *reference);
            if state.references.len() == before {
                return Err(AxysError::NotFound(format!("reference {}", reference.0)));
            }
        }
        EditOp::SetMixer { mixer } => {
            state.mixer = mixer.validated()?;
        }
        EditOp::SetScale { scale } => {
            validate_scale(scale)?;
            state.scale = scale.clone();
        }
        EditOp::SetTuning { tuning } => {
            validate_tuning(tuning)?;
            state.tuning = *tuning;
        }
        EditOp::SetName { name } => {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AxysError::Invalid("a project name cannot be blank".into()));
            }
            if trimmed.chars().count() > MAX_NAME_CHARS {
                return Err(AxysError::Invalid(format!(
                    "a project name is longer than {MAX_NAME_CHARS} characters"
                )));
            }
            state.name = trimmed.to_string();
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
            if state.blob(mapping.blob).is_none() {
                return Err(AxysError::NotFound(format!("blob {}", mapping.blob.0)));
            }
            match state.mappings.iter_mut().find(|m| m.blob == mapping.blob) {
                Some(existing) => *existing = *mapping,
                None => state.mappings.push(*mapping),
            }
        }
        EditOp::SetMappings { mappings } => {
            for mapping in mappings {
                if state.blob(mapping.blob).is_none() {
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
        EditOp::SetStroke { stroke } => {
            stroke.validate()?;
            match state.strokes.iter_mut().find(|kept| kept.id == stroke.id) {
                Some(kept) => *kept = stroke.clone(),
                None => {
                    if state.strokes.len() >= limits::MAX_STROKES {
                        return Err(AxysError::Invalid(format!(
                            "a project keeps at most {} curves",
                            limits::MAX_STROKES
                        )));
                    }
                    state.strokes.push(stroke.clone());
                }
            }
        }
        EditOp::RemoveStroke { stroke } => {
            let before = state.strokes.len();
            state.strokes.retain(|kept| kept.id != *stroke);
            if state.strokes.len() == before {
                return Err(AxysError::NotFound(format!("curve {stroke}")));
            }
        }
        EditOp::Group { ops } => {
            for op in ops {
                apply_in(state, sources, op)?;
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
        .blob_mut(id)
        .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))
}

/// Borrows the clip that owns a blob, reporting a blob that is not on the lane.
fn owner(state: &mut EditState, id: BlobId) -> Result<&mut Clip> {
    match state.clip_mut(clip_of(id)) {
        Some(clip) if clip.blobs.get(id).is_some() => Ok(clip),
        _ => Err(AxysError::NotFound(format!("blob {}", id.0))),
    }
}

/// Project seconds of the clip that owns a blob, which its times are measured from.
fn position_of(state: &EditState, id: BlobId) -> Result<f64> {
    match state.clip(clip_of(id)) {
        Some(clip) if clip.blobs.get(id).is_some() => Ok(clip.position),
        _ => Err(AxysError::NotFound(format!("blob {}", id.0))),
    }
}

/// The project spans every clip but `except` occupies on the lane.
fn lane_spans(state: &EditState, except: Option<ClipId>) -> Vec<(f64, f64)> {
    state
        .clips
        .iter()
        .filter(|clip| Some(clip.id) != except)
        .map(|clip| (clip.start(), clip.end()))
        .collect()
}

/// The next unused blob id in a clip's range.
fn fresh_blob_id(blobs: &BlobSet, clip: ClipId) -> BlobId {
    let next = blobs
        .blobs()
        .iter()
        .filter(|blob| clip_of(blob.id) == clip)
        .map(|blob| blob.id.0 + 1)
        .max()
        .unwrap_or(clip.first_blob().0);
    BlobId(next)
}

/// How far either side of a replaced span its boundary anchors sit, in seconds.
const EDGE_SECONDS: f64 = 1e-3;

/// Replaces what a blob sounds across `[start, end]`, in its clip's source seconds.
///
/// The curve outside the span is kept, with a boundary anchor at each edge holding the value the
/// curve had there, and the span is given the fill: the contour, a level line, or a released
/// stretch that follows the blob's own pitch. The blob's own pitch across the whole blob clears
/// the curve and the offset.
fn replace_pitch(
    blob: &mut Blob,
    start: f64,
    end: f64,
    fill: &PitchFill,
    offset: f64,
    track: Option<&PitchTrack>,
) -> Result<()> {
    let start = start.max(blob.start);
    let end = end.min(blob.end);
    if end - start <= 1e-9 {
        return Ok(());
    }
    let whole = start <= blob.start + EDGE_SECONDS && end >= blob.end - EDGE_SECONDS;
    if whole && matches!(fill, PitchFill::Sung | PitchFill::Release) {
        blob.curve = PitchCurve::new();
        if matches!(fill, PitchFill::Sung) {
            blob.pitch_offset = 0.0;
        }
        return Ok(());
    }

    // A drawn value is heard with the blob's offset added, so the fill is written without it.
    let mut inside: Vec<Anchor> = match fill {
        PitchFill::Contour { anchors } => anchors
            .iter()
            .filter(|a| a.time.is_finite() && a.midi.is_finite())
            .map(|a| Anchor {
                time: a.time - offset,
                midi: a.midi - blob.pitch_offset,
                interp: match a.interp {
                    Interp::Release => Interp::Linear,
                    other => other,
                },
            })
            .filter(|a| a.time >= start - 1e-9 && a.time <= end + 1e-9)
            .collect(),
        PitchFill::Flat => {
            let level = track
                .and_then(|track| track.median_midi(start, end))
                .unwrap_or(blob.detected_center);
            vec![
                Anchor::with_interp(start, level, Interp::Linear),
                Anchor::with_interp(end, level, Interp::Linear),
            ]
        }
        PitchFill::Sung | PitchFill::Release => Vec::new(),
    };
    inside.sort_by(|a, b| a.time.total_cmp(&b.time));
    let released = inside.is_empty();

    let curve = &blob.curve;
    let has_left = start - EDGE_SECONDS > blob.start;
    let has_right = end + EDGE_SECONDS < blob.end;
    let before = curve.drawn_at(start - EDGE_SECONDS);
    let after = curve.drawn_at(end + EDGE_SECONDS);
    let mut anchors: Vec<Anchor> = curve
        .anchors()
        .iter()
        .copied()
        .filter(|a| a.time < start - EDGE_SECONDS)
        .collect();

    if has_left {
        match before {
            Some(value) => {
                let interp = if released {
                    Interp::Release
                } else {
                    Interp::Linear
                };
                anchors.push(Anchor::with_interp(start - EDGE_SECONDS, value, interp));
            }
            // Already following the blob's own pitch up to the span; with nothing drawn yet, a
            // release from the blob's start says so.
            None if anchors.is_empty() => {
                anchors.push(Anchor::with_interp(
                    blob.start,
                    blob.detected_center,
                    Interp::Release,
                ));
            }
            None => {}
        }
    } else if released {
        anchors.push(Anchor::with_interp(
            start,
            blob.detected_center,
            Interp::Release,
        ));
    }

    let filled = !inside.is_empty();
    anchors.extend(inside);
    if filled && has_right && after.is_none() {
        if let Some(last) = anchors.last_mut() {
            last.interp = Interp::Release;
        }
    }
    if has_right {
        if let Some(value) = after {
            let interp = curve
                .anchors()
                .iter()
                .rev()
                .find(|a| a.time <= end + EDGE_SECONDS)
                .map_or(Interp::Linear, |a| a.interp);
            anchors.push(Anchor::with_interp(end + EDGE_SECONDS, value, interp));
        }
    }
    anchors.extend(
        curve
            .anchors()
            .iter()
            .copied()
            .filter(|a| a.time > end + EDGE_SECONDS),
    );
    if anchors.len() > limits::MAX_CURVE_ANCHORS {
        return Err(AxysError::Invalid(format!(
            "curve anchor limit is {}",
            limits::MAX_CURVE_ANCHORS
        )));
    }
    let rebuilt = PitchCurve::from_anchors(anchors)?;
    blob.curve = if rebuilt.draws() {
        rebuilt
    } else {
        PitchCurve::new()
    };
    Ok(())
}

/// A clip or reference name trimmed and checked, or `None` to go back to the file's name.
fn source_name(name: Option<&str>) -> Result<Option<String>> {
    let Some(name) = name else {
        return Ok(None);
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AxysError::Invalid("a source name cannot be blank".into()));
    }
    if trimmed.chars().count() > MAX_NAME_CHARS {
        return Err(AxysError::Invalid(format!(
            "a source name is longer than {MAX_NAME_CHARS} characters"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// Drops the guide mappings that name a blob no longer on the lane.
fn forget_missing_mappings(state: &mut EditState) {
    let kept: Vec<_> = state
        .mappings
        .iter()
        .copied()
        .filter(|mapping| state.blob(mapping.blob).is_some())
        .collect();
    state.mappings = kept;
}

/// Checks that every id in a selection exists before any of them is changed.
fn require_all(state: &EditState, ids: &[BlobId]) -> Result<Vec<BlobId>> {
    for id in ids {
        if state.blob(*id).is_none() {
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
/// Shortest part of its audio a clip may be trimmed to, in seconds.
const MIN_CLIP_SECONDS: f64 = 0.01;

/// Longest a project name may be, in characters.
///
/// A name reaches a file system, a tab title and a titlebar, none of which handle an arbitrarily
/// long one gracefully.
const MAX_NAME_CHARS: usize = 120;

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
            name: "Test".to_string(),
            clips: vec![Clip::new(
                ClipId(0),
                crate::clip::test_source("Test", 100.0),
                0.0,
                BlobSet::from_blobs(blobs).unwrap(),
            )],
            references: Vec::new(),
            scale: ScaleSettings::default(),
            modulation: ModulationSettings::default(),
            formant: FormantMode::default(),
            timeline: TimelineMap::default(),
            guide: None,
            mappings: Vec::new(),
            tuning: Tuning::default(),
            accidentals: AccidentalStyle::default(),
            mixer: MixerSettings::default(),
            strokes: Vec::new(),
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
        state.blob(BlobId(id)).unwrap().curve.anchors().to_vec()
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
        assert_eq!(s.clips[0].blobs.len(), 3);
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
        assert_eq!(s.clips[0].blobs.len(), 1);
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().end, 2.0);
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
        assert!((s.clips[0].blobs.get(BlobId(1)).unwrap().end - 0.6).abs() < 1e-9);
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
            s.clips[0].blobs.get(BlobId(1)).unwrap().voicing_at(0.1),
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
            anchors: false,
        };
        apply(&mut s, None, &op).unwrap();
        apply(&mut s, None, &op).unwrap();
        assert!((s.clips[0].blobs.get(BlobId(1)).unwrap().pitch_offset - 3.0).abs() < 1e-9);
        assert!((s.clips[0].blobs.get(BlobId(2)).unwrap().pitch_offset - 3.0).abs() < 1e-9);
    }

    #[test]
    fn a_kept_stroke_is_set_replaced_and_removed_without_touching_the_blobs() {
        use crate::curve::StrokePoint;
        let mut s = state();
        let before = s.clips.clone();
        let point = |time: f64, midi: f64| StrokePoint { time, midi };
        let stroke = |midi: f64| Stroke {
            id: 4,
            points: vec![point(0.2, 60.0), point(1.8, midi)],
            bezier: None,
        };
        apply(
            &mut s,
            None,
            &EditOp::SetStroke {
                stroke: stroke(62.0),
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::SetStroke {
                stroke: stroke(65.0),
            },
        )
        .unwrap();
        assert_eq!(s.strokes, vec![stroke(65.0)]);
        assert_eq!(s.clips, before);
        let backwards = Stroke {
            id: 5,
            points: vec![point(1.0, 60.0), point(0.5, 60.0)],
            bezier: None,
        };
        assert!(apply(&mut s, None, &EditOp::SetStroke { stroke: backwards }).is_err());
        apply(&mut s, None, &EditOp::RemoveStroke { stroke: 4 }).unwrap();
        assert!(s.strokes.is_empty());
        assert!(apply(&mut s, None, &EditOp::RemoveStroke { stroke: 4 }).is_err());
    }

    #[test]
    fn a_recorded_anchor_flag_leaves_the_drawing_to_the_offset() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: BlobId(1),
                anchor: Anchor::new(0.5, 60.0),
            },
        )
        .unwrap();
        let recorded: EditOp = serde_json::from_str(
            r#"{ "type": "movePitch", "blobs": [1], "semitones": 2, "anchors": true }"#,
        )
        .unwrap();
        apply(&mut s, None, &recorded).unwrap();
        let blob = s.blob(BlobId(1)).unwrap();
        assert_eq!(blob.pitch_offset, 2.0);
        assert_eq!(blob.curve.anchors()[0].midi, 60.0);
    }

    /// The target the plan compiles for blob 1 at `time`, over a flat track at 60.
    fn heard_at(state: &EditState, time: f64) -> f64 {
        let track = steady_track(60.0);
        let clip = &state.clips[0];
        let plan = crate::target::compile_plan(&crate::target::PlanInputs {
            track: &track,
            blobs: &clip.blobs,
            silenced: &[],
            sample_rate: 48_000.0,
            duration: 2.0,
            scale: &state.scale,
            modulation: &state.modulation,
            formant: state.formant,
            guide: None,
            hop: 0.005,
        })
        .unwrap();
        f64::from(plan.target_midi.at(time))
    }

    #[test]
    fn moving_a_drawn_blob_moves_what_it_sounds_by_exactly_the_amount_asked() {
        for anchors in [false, true] {
            let mut s = state();
            let draw = EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: vec![Anchor::new(0.0, 62.0), Anchor::new(1.0, 62.0)],
            };
            apply(&mut s, None, &draw).unwrap();
            assert!((heard_at(&s, 0.5) - 62.0).abs() < 1e-4);
            let moved = EditOp::MovePitch {
                blobs: vec![BlobId(1)],
                semitones: 1.0,
                anchors,
            };
            apply(&mut s, None, &moved).unwrap();
            assert!(
                (heard_at(&s, 0.5) - 63.0).abs() < 1e-4,
                "anchors: {anchors}"
            );
            let set = EditOp::SetPitchOffset {
                blob: BlobId(1),
                semitones: 3.0,
                anchors,
            };
            apply(&mut s, None, &set).unwrap();
            assert!(
                (heard_at(&s, 0.5) - 65.0).abs() < 1e-4,
                "anchors: {anchors}"
            );
        }
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
                anchors: false,
            },
        )
        .unwrap_err();
        assert!(matches!(err, AxysError::NotFound(_)));
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().pitch_offset, 0.0);
    }

    #[test]
    fn set_pitch_offset_is_absolute() {
        let mut s = state();
        let op = EditOp::SetPitchOffset {
            blob: BlobId(1),
            semitones: -2.0,
            anchors: false,
        };
        apply(&mut s, None, &op).unwrap();
        apply(&mut s, None, &op).unwrap();
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().pitch_offset, -2.0);
    }

    #[test]
    fn set_mixer_replaces_the_desk_and_clamps_what_it_is_given() {
        let mut s = state();
        let mut mixer = MixerSettings::default();
        let mut track = crate::mixer::ClipStrips::new(ClipId(0));
        track.original.mute = false;
        track.processed.gain_db = -3.0;
        mixer.clips.push(track);
        mixer.click.pan = 9.0;
        apply(
            &mut s,
            None,
            &EditOp::SetMixer {
                mixer: mixer.clone(),
            },
        )
        .unwrap();
        assert!(!s.mixer.clip(ClipId(0)).original.mute);
        assert_eq!(s.mixer.clip(ClipId(0)).processed.gain_db, -3.0);
        assert_eq!(s.mixer.click.pan, 1.0);

        mixer.click.pan = f64::INFINITY;
        assert!(apply(&mut s, None, &EditOp::SetMixer { mixer }).is_err());
    }

    #[test]
    fn set_gain_is_absolute_and_clamped() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetGain {
                blob: BlobId(1),
                gain_db: -6.0,
            },
        )
        .unwrap();
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().gain_db, -6.0);
        apply(
            &mut s,
            None,
            &EditOp::SetGain {
                blob: BlobId(1),
                gain_db: 1000.0,
            },
        )
        .unwrap();
        assert_eq!(
            s.clips[0].blobs.get(BlobId(1)).unwrap().gain_db,
            crate::limits::MAX_GAIN_DB
        );
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
        assert!((s.clips[0].blobs.get(BlobId(2)).unwrap().time_offset - 0.25).abs() < 1e-9);
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
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().time_scale, 1.0);
        apply(
            &mut s,
            None,
            &EditOp::SetTimeScale {
                blob: BlobId(1),
                scale: 1.5,
            },
        )
        .unwrap();
        assert_eq!(s.clips[0].blobs.get(BlobId(1)).unwrap().time_scale, 1.5);
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
        let baseline = state().clips[0].blobs.clone();
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
                anchors: false,
            },
        )
        .unwrap();
        assert_eq!(s.clips[0].blobs.len(), 3);

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

        assert_eq!(s.clips[0].blobs.len(), 2, "the split is undone");
        let spans: Vec<(f64, f64)> = s.clips[0]
            .blobs
            .blobs()
            .iter()
            .map(|b| (b.start, b.end))
            .collect();
        assert_eq!(spans, vec![(0.0, 1.0), (1.0, 2.0)]);
        assert_eq!(s.clips[0].blobs.get(BlobId(2)).unwrap().pitch_offset, 0.0);
    }

    #[test]
    fn reset_range_leaves_blobs_outside_the_span_alone() {
        let baseline = state().clips[0].blobs.clone();
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
                anchors: false,
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
            s.clips[0].blobs.len(),
            2,
            "the split halves collapse back into one blob"
        );
        assert_eq!(
            s.clips[0].blobs.get(BlobId(2)).unwrap().pitch_offset,
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
        let baseline = state().clips[0].blobs.clone();
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
                anchors: false,
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

        let b = s.clips[0].blobs.get(BlobId(1)).unwrap();
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
    fn renaming_trims_and_stores_the_name() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::SetName {
                name: "  Take 3  ".to_string(),
            },
        )
        .unwrap();
        assert_eq!(s.name, "Take 3");
    }

    #[test]
    fn a_blank_name_is_rejected() {
        let mut s = state();
        let before = s.name.clone();
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetName {
                name: "   ".to_string(),
            },
        )
        .is_err());
        assert_eq!(s.name, before);
    }

    #[test]
    fn an_overlong_name_is_rejected() {
        let mut s = state();
        assert!(apply(
            &mut s,
            None,
            &EditOp::SetName {
                name: "n".repeat(MAX_NAME_CHARS + 1),
            },
        )
        .is_err());
    }

    #[test]
    fn renaming_is_one_undo_step() {
        let mut history = History::new();
        let mut s = state();
        let op = EditOp::SetName {
            name: "Second Take".to_string(),
        };
        apply(&mut s, None, &op).unwrap();
        history.push(op);
        assert_eq!(history.undo_label(), Some("Rename Project"));

        history.undo();
        let mut replayed = state();
        for op in history.applied() {
            apply(&mut replayed, None, op).unwrap();
        }
        assert_eq!(replayed.name, "Test");
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
                anchors: false,
            },
            EditOp::SetPitchOffset {
                blob: missing,
                semitones: 1.0,
                anchors: false,
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
                anchors: false,
            },
            EditOp::SetPitchOffset {
                blob: BlobId(1),
                semitones: 0.0,
                anchors: false,
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
                anchors: false,
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
            anchors: false,
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

    /// A second clip of two seconds, numbered for clip 1, with one blob at 0.5..1.5.
    fn second_clip(position: f64) -> Clip {
        let first = ClipId(1).first_blob().0;
        Clip::new(
            ClipId(1),
            crate::clip::test_source("second.wav", 2.0),
            position,
            BlobSet::from_blobs(vec![blob(first, 0.5, 1.5)]).unwrap(),
        )
    }

    /// Clip 0 from [`state`], made two seconds long so a second clip can sit beside it.
    /// A steady track at `midi` over the first ten seconds.
    fn steady_track(midi: f64) -> PitchTrack {
        let hop = 0.005;
        PitchTrack {
            sample_rate: 48_000.0,
            hop_seconds: hop,
            frames: (0..2000)
                .map(|i| PitchFrame {
                    time: i as f64 * hop,
                    f0: 261.6,
                    midi,
                    confidence: 0.9,
                    rms: 0.2,
                    voiced: true,
                })
                .collect(),
        }
    }

    #[test]
    fn trimming_hides_audio_and_blobs_outside_the_window_and_untrimming_restores_them() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        let trim = |start: f64, end: f64| EditOp::TrimClip {
            clip: ClipId(0),
            start,
            end,
        };
        apply(&mut s, None, &trim(0.5, 1.5)).unwrap();
        let clip = &s.clips[0];
        assert_eq!(clip.start(), 0.5);
        assert_eq!(clip.end(), 1.5);
        let visible = clip.project_blobs();
        assert_eq!(visible.len(), 2);
        assert_eq!((visible[0].start, visible[0].end), (0.5, 1.0));
        assert_eq!((visible[1].start, visible[1].end), (1.0, 1.5));
        assert_eq!(clip.blobs.len(), 2, "hidden blobs stay with the clip");
        assert_eq!(clip.hidden().len(), 2);

        apply(&mut s, None, &trim(0.0, 2.0)).unwrap();
        assert_eq!(s.clips[0].window, None);
        assert!(apply(&mut s, None, &trim(1.0, 1.001)).is_err());
    }

    #[test]
    fn a_trimmed_clip_is_moved_by_where_it_starts_being_heard() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        s.clips[0].window = Some(Span {
            start: 1.0,
            end: 2.0,
        });
        apply(
            &mut s,
            None,
            &EditOp::MoveClip {
                clip: ClipId(0),
                position: -1.0,
                exact: true,
                ripple: false,
            },
        )
        .unwrap();
        assert_eq!(s.clips[0].position, -1.0);
        assert_eq!(s.clips[0].start(), 0.0);
    }

    #[test]
    fn a_shifted_blob_covers_other_audio_without_a_timing_edit() {
        let mut s = state_with(vec![blob(1, 0.0, 1.0), blob(2, 2.0, 3.0)]);
        let track = steady_track(64.0);
        apply(
            &mut s,
            Some(&track),
            &EditOp::ShiftBlob {
                blob: BlobId(1),
                seconds: 0.5,
            },
        )
        .unwrap();
        let moved = s.blob(BlobId(1)).unwrap();
        assert_eq!((moved.start, moved.end), (0.5, 1.5));
        assert_eq!(moved.time_offset, 0.0);
        assert_eq!(moved.detected_center, 64.0);
        // Held against the next blob rather than passing over it.
        apply(
            &mut s,
            None,
            &EditOp::ShiftBlob {
                blob: BlobId(1),
                seconds: 5.0,
            },
        )
        .unwrap();
        assert_eq!(s.blob(BlobId(1)).unwrap().end, 2.0);
    }

    #[test]
    fn added_blobs_take_fresh_ids_in_their_clip_and_refuse_to_overlap() {
        let mut s = state_with(vec![blob(1, 0.0, 1.0)]);
        let track = steady_track(62.0);
        let mut new = Blob::new(BlobId(0), 1.5, 2.5, 0.0);
        new.pitch_offset = 1.0;
        apply(
            &mut s,
            Some(&track),
            &EditOp::AddBlobs {
                blobs: vec![new.clone()],
            },
        )
        .unwrap();
        let added = s.clips[0].blobs.blobs()[1].clone();
        assert_eq!(added.id, BlobId(2));
        assert_eq!(added.detected_center, 62.0);
        assert_eq!(added.pitch_offset, 1.0);
        assert!(apply(&mut s, None, &EditOp::AddBlobs { blobs: vec![new] }).is_err());
    }

    #[test]
    fn deleting_a_blob_with_its_audio_kept_silences_nothing() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::DeleteBlobs {
                blobs: vec![BlobId(1)],
                keep_audio: true,
            },
        )
        .unwrap();
        assert!(s.blob(BlobId(1)).is_none());
        assert!(s.clips[0].silenced.is_empty());
    }

    fn replace(start: f64, end: f64, fill: PitchFill) -> EditOp {
        EditOp::ReplacePitch {
            blob: BlobId(1),
            start,
            end,
            fill,
        }
    }

    #[test]
    fn a_contour_replaces_only_its_span_of_an_undrawn_blob() {
        let mut s = state();
        s.blob_mut(BlobId(1)).unwrap().pitch_offset = 2.0;
        let fill = PitchFill::Contour {
            anchors: vec![
                Anchor::with_interp(0.4, 70.0, Interp::Linear),
                Anchor::with_interp(0.6, 70.0, Interp::Linear),
            ],
        };
        apply(&mut s, None, &replace(0.4, 0.6, fill)).unwrap();
        let curve = &s.blob(BlobId(1)).unwrap().curve;
        assert_eq!(curve.drawn_at(0.2), None);
        assert_eq!(
            curve.drawn_at(0.5),
            Some(68.0),
            "heard is the curve plus the offset"
        );
        assert_eq!(curve.drawn_at(0.8), None);
    }

    #[test]
    fn the_sung_fill_releases_a_span_and_keeps_the_drawing_around_it() {
        let mut s = state();
        apply(
            &mut s,
            None,
            &EditOp::DrawSpan {
                blob: BlobId(1),
                anchors: vec![
                    Anchor::with_interp(0.0, 65.0, Interp::Linear),
                    Anchor::with_interp(1.0, 65.0, Interp::Linear),
                ],
            },
        )
        .unwrap();
        apply(&mut s, None, &replace(0.4, 0.6, PitchFill::Sung)).unwrap();
        let curve = &s.blob(BlobId(1)).unwrap().curve;
        assert_eq!(curve.drawn_at(0.2), Some(65.0));
        assert_eq!(curve.drawn_at(0.5), None);
        assert_eq!(curve.drawn_at(0.8), Some(65.0));

        s.blob_mut(BlobId(1)).unwrap().pitch_offset = 3.0;
        apply(&mut s, None, &replace(0.0, 1.0, PitchFill::Sung)).unwrap();
        let blob = s.blob(BlobId(1)).unwrap();
        assert!(blob.curve.is_empty());
        assert_eq!(blob.pitch_offset, 0.0);
    }

    #[test]
    fn the_flat_fill_levels_a_span_at_its_median_pitch() {
        let mut s = state();
        let track = jittery_track();
        apply(&mut s, Some(&track), &replace(0.2, 0.8, PitchFill::Flat)).unwrap();
        let curve = &s.blob(BlobId(1)).unwrap().curve;
        let level = curve.drawn_at(0.5).unwrap();
        assert_eq!(curve.drawn_at(0.3), Some(level));
        assert!((level - 60.0).abs() <= 0.5);
        assert_eq!(curve.drawn_at(0.1), None);
    }

    fn two_clips() -> EditState {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(5.0),
                ripple: false,
                exact: false,
            },
        )
        .unwrap();
        s
    }

    #[test]
    fn an_edit_in_project_seconds_lands_in_the_clip_source_seconds() {
        let mut s = two_clips();
        let id = ClipId(1).first_blob();
        apply(
            &mut s,
            None,
            &EditOp::SplitBlob {
                blob: id,
                time: 6.0,
            },
        )
        .unwrap();
        let clip = s.clip(ClipId(1)).unwrap();
        assert_eq!(clip.blobs.len(), 2);
        assert_eq!(clip.blobs.get(id).unwrap().end, 1.0);
        assert!(clip
            .blobs
            .blobs()
            .iter()
            .all(|b| clip_of(b.id) == ClipId(1)));

        apply(
            &mut s,
            None,
            &EditOp::AddAnchor {
                blob: id,
                anchor: Anchor::new(5.75, 62.0),
            },
        )
        .unwrap();
        assert_eq!(s.blob(id).unwrap().curve.anchors()[0].time, 0.75);
    }

    #[test]
    fn a_clip_added_over_another_lands_beside_it() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(1.5),
                ripple: false,
                exact: false,
            },
        )
        .unwrap();
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 2.0);
    }

    #[test]
    fn a_clip_is_renamed_and_named_after_its_file_again() {
        let mut s = state();
        let rename = |name: Option<&str>| EditOp::RenameClip {
            clip: ClipId(0),
            name: name.map(str::to_string),
        };
        apply(&mut s, None, &rename(Some("  Lead  "))).unwrap();
        assert_eq!(s.clips[0].name.as_deref(), Some("Lead"));
        assert!(apply(&mut s, None, &rename(Some(" "))).is_err());
        apply(&mut s, None, &rename(None)).unwrap();
        assert_eq!(s.clips[0].name, None);
    }

    #[test]
    fn a_rippled_clip_lands_where_asked_and_pushes_the_rest() {
        let mut s = two_clips();
        let mut clip = second_clip(4.0);
        clip.id = ClipId(2);
        clip.blobs = crate::clip::renumber(&clip.blobs, ClipId(2)).unwrap();
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip,
                ripple: true,
                exact: false,
            },
        )
        .unwrap();
        assert_eq!(s.clip(ClipId(0)).unwrap().position, 0.0);
        assert_eq!(s.clip(ClipId(2)).unwrap().position, 4.0);
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 6.0);
    }

    #[test]
    fn moving_a_clip_keeps_its_blobs_in_their_own_time() {
        let mut s = two_clips();
        let before = s.clip(ClipId(1)).unwrap().blobs.clone();
        apply(
            &mut s,
            None,
            &EditOp::MoveClip {
                clip: ClipId(1),
                position: 9.0,
                ripple: false,
                exact: false,
            },
        )
        .unwrap();
        let clip = s.clip(ClipId(1)).unwrap();
        assert_eq!(clip.position, 9.0);
        assert_eq!(clip.blobs, before);
        assert_eq!(
            s.layer_blobs(&[ClipId(0), ClipId(1)])
                .unwrap()
                .blobs()
                .last()
                .unwrap()
                .start,
            9.5
        );
    }

    #[test]
    fn a_boundary_cannot_be_dragged_into_the_next_clip() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(2.0),
                ripple: false,
                exact: false,
            },
        )
        .unwrap();
        apply(
            &mut s,
            None,
            &EditOp::MoveBoundary {
                blob: BlobId(2),
                edge: Edge::End,
                time: 2.8,
            },
        )
        .unwrap();
        assert_eq!(s.blob(BlobId(2)).unwrap().end, 2.0);
        assert!(s.layer_blobs(&[ClipId(0), ClipId(1)]).is_ok());
    }

    #[test]
    fn a_clip_cannot_be_moved_onto_another() {
        let mut s = two_clips();
        apply(
            &mut s,
            None,
            &EditOp::MoveClip {
                clip: ClipId(1),
                position: 0.5,
                ripple: false,
                exact: false,
            },
        )
        .unwrap();
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 2.0);
    }

    #[test]
    fn removing_a_clip_takes_its_mappings_with_it() {
        let mut s = two_clips();
        let id = ClipId(1).first_blob();
        s.mappings = vec![
            NoteMapping {
                blob: id,
                note: Some(0),
                manual: false,
                opted_out: false,
            },
            NoteMapping {
                blob: BlobId(1),
                note: Some(1),
                manual: false,
                opted_out: false,
            },
        ];
        apply(&mut s, None, &EditOp::RemoveClip { clip: ClipId(1) }).unwrap();
        assert!(s.clip(ClipId(1)).is_none());
        assert_eq!(s.mappings.len(), 1);
        assert!(apply(&mut s, None, &EditOp::RemoveClip { clip: ClipId(1) }).is_err());
    }

    #[test]
    fn blobs_from_different_clips_are_not_joined() {
        let mut s = two_clips();
        let op = EditOp::JoinBlobs {
            first: BlobId(2),
            second: ClipId(1).first_blob(),
        };
        assert!(apply(&mut s, None, &op).is_err());
    }

    #[test]
    fn deleting_a_blob_silences_its_material_and_a_reset_brings_it_back() {
        let mut s = state();
        let baseline = s.clips[0].blobs.clone();
        apply(
            &mut s,
            None,
            &EditOp::DeleteBlobs {
                blobs: vec![BlobId(2)],
                keep_audio: false,
            },
        )
        .unwrap();
        assert!(s.blob(BlobId(2)).is_none());
        assert_eq!(
            s.clips[0].silenced,
            vec![Span {
                start: 1.0,
                end: 2.0
            }]
        );

        apply_with_baseline(
            &mut s,
            None,
            Some(&baseline),
            &EditOp::ResetRange {
                start: 0.9,
                end: 2.1,
            },
        )
        .unwrap();
        assert!(s.blob(BlobId(2)).is_some());
        assert!(s.clips[0].silenced.is_empty());
    }

    #[test]
    fn a_reference_is_added_moved_and_removed() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        let reference = Reference {
            id: ReferenceId(0),
            source: crate::clip::test_source("vocal.mp3", 30.0),
            position: -2.0,
            name: None,
        };
        apply(&mut s, None, &EditOp::AddReference { reference }).unwrap();
        assert_eq!(s.references[0].position, 0.0);
        apply(
            &mut s,
            None,
            &EditOp::MoveReference {
                reference: ReferenceId(0),
                position: 4.0,
            },
        )
        .unwrap();
        assert_eq!(s.references[0].position, 4.0);
        assert_eq!(s.duration(), 34.0);
        apply(
            &mut s,
            None,
            &EditOp::RemoveReference {
                reference: ReferenceId(0),
            },
        )
        .unwrap();
        assert!(s.references.is_empty());
    }

    #[test]
    fn an_exact_clip_lands_over_another_and_moves_nothing() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(1.5),
                ripple: false,
                exact: true,
            },
        )
        .unwrap();
        assert_eq!(s.clip(ClipId(0)).unwrap().position, 0.0);
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 1.5);
        let place = |position: f64| EditOp::MoveClip {
            clip: ClipId(1),
            position,
            ripple: false,
            exact: true,
        };
        apply(&mut s, None, &place(0.25)).unwrap();
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 0.25);
        apply(&mut s, None, &place(-3.0)).unwrap();
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 0.0);
    }

    #[test]
    fn a_recorded_clip_move_without_exact_keeps_the_old_placement() {
        let op: EditOp =
            serde_json::from_str(r#"{"type":"moveClip","clip":1,"position":0.5}"#).unwrap();
        let mut s = two_clips();
        apply(&mut s, None, &op).unwrap();
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 2.0);
        let json = serde_json::to_string(&EditOp::MoveClip {
            clip: ClipId(1),
            position: 1.0,
            ripple: false,
            exact: false,
        })
        .unwrap();
        assert!(!json.contains("exact"));
    }

    #[test]
    fn a_clip_moved_with_ripple_pushes_the_clips_after_it() {
        // Clip 0 at 0..2 and clip 1 at 5..7; clip 0 moved to 4.0 needs 1 s of room.
        let mut s = two_clips();
        apply(
            &mut s,
            None,
            &EditOp::MoveClip {
                clip: ClipId(0),
                position: 4.0,
                exact: false,
                ripple: true,
            },
        )
        .unwrap();
        assert_eq!(s.clip(ClipId(0)).unwrap().position, 4.0);
        assert_eq!(s.clip(ClipId(1)).unwrap().position, 6.0);
    }

    #[test]
    fn overlapping_clips_are_edited_on_their_own() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(0.0),
                ripple: false,
                exact: true,
            },
        )
        .unwrap();
        let id = ClipId(1).first_blob();
        apply(
            &mut s,
            None,
            &EditOp::MovePitch {
                blobs: vec![id],
                semitones: 2.0,
                anchors: false,
            },
        )
        .unwrap();
        assert_eq!(s.blob(id).unwrap().pitch_offset, 2.0);
        assert_eq!(s.blob(BlobId(1)).unwrap().pitch_offset, 0.0);
        assert!(s.layer_blobs(&[ClipId(0), ClipId(1)]).is_err());
        assert!(s.layer_blobs(&[ClipId(1)]).is_ok());
    }

    #[test]
    fn conflicts_are_reported_per_clip() {
        let mut s = state();
        s.clips[0].source.duration = 2.0;
        apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip: second_clip(0.0),
                ripple: false,
                exact: true,
            },
        )
        .unwrap();
        // Two clips sounding at once are not a timing problem.
        assert!(s.conflicts().is_empty());
        apply(
            &mut s,
            None,
            &EditOp::MoveTime {
                blobs: vec![BlobId(1)],
                seconds: 0.5,
            },
        )
        .unwrap();
        // Blob 1 now overlaps blob 2, which is allowed.
        assert!(s.conflicts().is_empty());
        apply(
            &mut s,
            None,
            &EditOp::MoveTime {
                blobs: vec![BlobId(1)],
                seconds: -1.0,
            },
        )
        .unwrap();
        let conflicts = s.conflicts();
        assert!(!conflicts.is_empty());
        assert!(conflicts.iter().all(|c| clip_of(c.first) == ClipId(0)));
    }

    #[test]
    fn a_clip_whose_blobs_belong_to_another_is_refused() {
        let mut s = state();
        let mut clip = second_clip(5.0);
        clip.id = ClipId(2);
        assert!(apply(
            &mut s,
            None,
            &EditOp::AddClip {
                clip,
                ripple: false,
                exact: false,
            }
        )
        .is_err());
    }
}
