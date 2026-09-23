<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Axys core contracts

Authoritative Rust type and signature contract for `crates/axys-core`. Every module must implement
exactly these public names, shapes and semantics. Adding private helpers and extra public items is
fine. Changing or renaming anything listed here is not, because other modules compile against it.

House rules that apply to every file:

- First line is `// SPDX-License-Identifier: AGPL-3.0-or-later`, then a blank line, then a `//!`
  module doc comment.
- Every public type, field, variant and function carries a `///` doc comment describing the
  abstraction, not the implementation.
- Errors use `crate::AxysError` and `crate::Result`.
- Enforce the bounds in `crate::limits` on anything derived from imported data.
- No `unsafe`, no panics on untrusted input, no `unwrap()` outside tests.
- Every module ends with a `#[cfg(test)] mod tests` covering the behaviour it owns.
- All times are **source seconds** as `f64` unless a name says otherwise. Source seconds belong
  to one clip; **project seconds** are a clip's source seconds plus its position on the lane.
  An `EditOp` carries project seconds, and the applier moves each into the owning clip's.
- Serde types use `#[serde(rename_all = "camelCase")]`.

## `analysis/f0.rs`

```rust
/// Parameters controlling fundamental-frequency estimation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F0Params {
    pub min_hz: f64,        // default 65.0
    pub max_hz: f64,        // default 1000.0
    pub frame_seconds: f64, // default 0.0464 (analysis window)
    pub hop_seconds: f64,   // default 0.005  (5 ms frames)
    pub method: F0Method,   // default Yin
    pub threshold: f64,     // default 0.15, YIN absolute threshold, or pYIN's threshold mean
    pub strength: f64,      // default 0.25, SWIPE strength a voiced frame reaches
    pub voiced_rms_floor: f32, // default 0.0015
    /// Raises `threshold` to suit the clip. Default true; false for analyses stored before it.
    pub auto_threshold: bool,
}
impl Default for F0Params { /* the values above */ }

/// YIN with an absolute threshold, pYIN over a Beta threshold distribution, or SWIPE' in
/// `analysis/swipe.rs`. Each observes per-frame candidates and an unvoiced cost for one decoder.
pub enum F0Method { Yin, Pyin, Swipe }

/// One analysis frame of detected pitch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchFrame {
    pub time: f64,        // frame centre, source seconds
    pub f0: f64,          // Hz, 0.0 when unvoiced
    pub midi: f64,        // fractional MIDI at A4=440, f64::NAN when unvoiced
    pub confidence: f32,  // 0.0..=1.0
    pub rms: f32,         // frame RMS of the source
    pub voiced: bool,
}

/// Detected pitch over time, stored as ordered frames on a uniform hop.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTrack {
    pub sample_rate: f64,
    pub hop_seconds: f64,
    pub frames: Vec<PitchFrame>,
}

impl PitchTrack {
    pub fn duration(&self) -> f64;
    /// Nearest frame index to `time`, or None when empty.
    pub fn frame_index_at(&self, time: f64) -> Option<usize>;
    /// Linearly interpolated MIDI at `time`; None inside unvoiced spans or outside the track.
    pub fn midi_at(&self, time: f64) -> Option<f64>;
    /// Linearly interpolated F0 in Hz at `time`; None inside unvoiced spans or outside the track.
    pub fn hz_at(&self, time: f64) -> Option<f64>;
    /// Median MIDI over `[start, end]` across voiced frames only.
    pub fn median_midi(&self, start: f64, end: f64) -> Option<f64>;
    /// Contiguous voiced spans as (start, end) in seconds.
    pub fn voiced_spans(&self) -> Vec<(f64, f64)>;
    /// Struct-of-arrays view for the WASM boundary.
    pub fn to_arrays(&self) -> PitchTrackArrays;
}

/// Flat arrays of a pitch track for cheap transfer to JavaScript.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTrackArrays {
    pub times: Vec<f32>,
    pub midi: Vec<f32>,      // NaN where unvoiced
    pub confidence: Vec<f32>,
    pub rms: Vec<f32>,
}

/// Estimates F0 over `samples` using a pYIN-style probabilistic YIN.
///
/// Implements the cumulative mean normalised difference function of de Cheveigne and
/// Kawahara (YIN, 2002) with parabolic interpolation of the chosen lag, then a Viterbi
/// pass over candidate lags per frame in the manner of Mauch and Dixon (pYIN, 2014) so
/// octave errors and isolated dropouts are penalised by transition cost.
pub fn detect_f0(samples: &[f32], sample_rate: f64, params: &F0Params) -> Result<PitchTrack>;
```

Requirements: reject non-finite samples, a sample rate outside `limits::MIN_SAMPLE_RATE ..=
limits::MAX_SAMPLE_RATE`, and a duration over `limits::MAX_AUDIO_SECONDS`. The Viterbi pass must
keep the whole thing O(frames x candidates^2) with a bounded candidate count (use at most 16
candidates per frame). Confidence is `1 - d'(tau)` clamped to `0..=1`.

Tests must include: a synthetic 220 Hz sine detected within 5 cents; a glissando tracked
monotonically; silence reported unvoiced; a signal one octave apart in successive halves tracked
without a spurious octave jump inside each half; empty input handled; invalid sample rate rejected.

## `analysis/energy.rs`

```rust
/// Short-time energy and onset evidence on the same hop grid as a pitch track.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnergyTrack {
    pub hop_seconds: f64,
    pub times: Vec<f64>,
    pub rms: Vec<f32>,
    pub rms_db: Vec<f32>,        // 20*log10(rms), floored at -120
    pub spectral_flux: Vec<f32>, // half-wave rectified, normalised to 0..=1
    pub zero_crossing_rate: Vec<f32>,
}

impl EnergyTrack {
    pub fn duration(&self) -> f64;
    /// Indices of local flux peaks above `threshold` with `min_separation` seconds between them.
    pub fn onsets(&self, threshold: f32, min_separation: f64) -> Vec<f64>;
}

/// Computes energy, spectral flux and zero-crossing rate with an FFT of `frame_seconds`.
pub fn analyse_energy(
    samples: &[f32],
    sample_rate: f64,
    frame_seconds: f64,
    hop_seconds: f64,
) -> Result<EnergyTrack>;

/// Classifies a frame as likely unvoiced consonant material.
///
/// High zero-crossing rate with usable energy and no stable F0 indicates a sibilant or
/// fricative rather than silence.
pub fn is_unvoiced_consonant(rms: f32, zcr: f32, voiced: bool) -> bool;
```

Use `rustfft` for the flux spectrum with a Hann window.

## `blob.rs`

```rust
/// Stable identifier for a blob within one project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct BlobId(pub u32);

/// How a subregion of a blob was classified by analysis or by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Voicing { Voiced, Unvoiced, Silence }

/// A classified span inside a blob.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subregion { pub start: f64, pub end: f64, pub voicing: Voicing }

/// An editable note-like region of the analysed vocal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    pub id: BlobId,
    pub start: f64,
    pub end: f64,
    /// Representative detected pitch, fractional MIDI.
    pub detected_center: f64,
    /// Semitone offset the user has applied to the whole blob.
    pub pitch_offset: f64,
    /// Seconds the blob has been moved along the timeline.
    pub time_offset: f64,
    /// Scale factor applied to the blob duration; 1.0 leaves it unchanged.
    pub time_scale: f64,
    pub subregions: Vec<Subregion>,
    /// Anchors editing the target inside this blob, in source seconds.
    pub curve: PitchCurve,
    /// Excludes the blob from automatic scale correction and MIDI guidance. The blob still
    /// sounds, and edits made on it by hand still apply.
    pub excluded: bool,
    /// Level applied to the blob in the render, in decibels; 0.0 leaves it as sung. Clamped to
    /// `limits::MIN_GAIN_DB` and `limits::MAX_GAIN_DB`, and the floor is silence.
    #[serde(default)]
    pub gain_db: f64,
}

impl Blob {
    pub fn new(id: BlobId, start: f64, end: f64, detected_center: f64) -> Self;
    pub fn duration(&self) -> f64;
    /// Edited start, after `time_offset`.
    pub fn edited_start(&self) -> f64;
    /// Edited end, after `time_offset` and `time_scale`.
    pub fn edited_end(&self) -> f64;
    pub fn contains(&self, time: f64) -> bool;
    /// Target pitch centre: detected centre plus the user offset.
    pub fn target_center(&self) -> f64;
    pub fn voicing_at(&self, time: f64) -> Voicing;
}

/// An ordered, non-overlapping set of blobs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSet { /* private Vec<Blob> plus next id */ }

impl BlobSet {
    pub fn new() -> Self;
    pub fn from_blobs(blobs: Vec<Blob>) -> Result<Self>;
    pub fn blobs(&self) -> &[Blob];
    pub fn len(&self) -> usize;
    pub fn is_empty(&self) -> bool;
    pub fn get(&self, id: BlobId) -> Option<&Blob>;
    pub fn get_mut(&mut self, id: BlobId) -> Option<&mut Blob>;
    pub fn index_of(&self, id: BlobId) -> Option<usize>;
    pub fn at_time(&self, time: f64) -> Option<&Blob>;
    /// Adds a blob, keeping start order; errors when it overlaps an existing blob.
    pub fn insert(&mut self, blob: Blob) -> Result<BlobId>;
    pub fn remove(&mut self, id: BlobId) -> Result<Blob>;
    /// Allocates an unused id.
    pub fn next_id(&mut self) -> BlobId;
    /// Splits `id` at `time`, returning the two resulting ids in time order.
    ///
    /// Both halves keep the original edits: subregions are cut at `time`, the curve is
    /// distributed by anchor time, and each half re-derives its detected centre from
    /// `track` when one is given.
    pub fn split(&mut self, id: BlobId, time: f64, track: Option<&PitchTrack>)
        -> Result<(BlobId, BlobId)>;
    /// Joins two adjacent blobs into the earlier id.
    ///
    /// Errors when the blobs are not neighbours in the set. The gap between them, if any,
    /// becomes part of the joined blob as a `Silence` subregion.
    pub fn join(&mut self, first: BlobId, second: BlobId, track: Option<&PitchTrack>)
        -> Result<BlobId>;
    /// Moves a boundary, clamped so neither side collapses below `MIN_BLOB_SECONDS`
    /// and so the blob never crosses its neighbours.
    pub fn move_boundary(&mut self, id: BlobId, edge: Edge, time: f64) -> Result<()>;
    /// Reclassifies `[start, end]` inside `id`, merging touching subregions of equal voicing.
    pub fn set_voicing(&mut self, id: BlobId, start: f64, end: f64, voicing: Voicing) -> Result<()>;
    /// Overlaps and gaps produced by timing edits, for display before export.
    pub fn timing_conflicts(&self) -> Vec<TimingConflict>;
}

/// Which edge of a blob a boundary edit addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge { Start, End }

/// An overlap or gap between edited blob positions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingConflict {
    pub first: BlobId,
    pub second: BlobId,
    pub start: f64,
    pub end: f64,
    pub kind: ConflictKind,
}

/// Whether edited blobs collide or leave a hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind { Overlap, Gap }

/// Shortest blob a boundary edit may produce, in seconds.
pub const MIN_BLOB_SECONDS: f64 = 0.01;
```

## `clip.rs`

```rust
/// Low bits of a blob id that number blobs within their clip.
pub const CLIP_ID_BITS: u32 = 20;
pub const MAX_CLIPS: usize = 64;
pub const MAX_REFERENCES: usize = 32;

/// Stable identifier for a clip within one project.
pub struct ClipId(pub u32);
impl ClipId { pub fn first_blob(self) -> BlobId; }
/// The clip a blob belongs to.
pub fn clip_of(blob: BlobId) -> ClipId;

/// Stable identifier for a reference within one project.
pub struct ReferenceId(pub u32);

/// A span of source seconds.
pub struct Span { pub start: f64, pub end: f64 }

/// One imported vocal placed on the lane.
pub struct Clip {
    pub id: ClipId,
    pub source: SourceInfo,
    /// Project seconds at which the clip's source second 0 sits. Never negative.
    pub position: f64,
    /// In clip source seconds.
    pub blobs: BlobSet,
    /// Material deleted with its blobs, rendered as silence. Ordered, never overlapping.
    pub silenced: Vec<Span>,
    /// What the clip is called in place of its file's name.
    pub name: Option<String>,
}

impl Clip {
    pub fn new(id: ClipId, source: SourceInfo, position: f64, blobs: BlobSet) -> Self;
    pub fn end(&self) -> f64;
    pub fn project_blobs(&self) -> Vec<Blob>;
    pub fn silence(&mut self, span: Span);
    pub fn unsilence(&mut self, start: f64, end: f64);
}

/// Renumbers an analysed blob set into a clip's id range, keeping time order.
pub fn renumber(blobs: &BlobSet, clip: ClipId) -> Result<BlobSet>;
pub fn numbered_for(blobs: &BlobSet, clip: ClipId) -> bool;

/// The clips the editor edits together: `active` first, then every clip that overlaps none
/// already chosen, or `active` alone with `isolate`.
pub fn layer(clips: &[Clip], active: Option<ClipId>, isolate: bool) -> Vec<ClipId>;

/// The position nearest `wanted` at which a span of `duration` overlaps no other clip.
pub fn free_position(others: &[(f64, f64)], duration: f64, wanted: f64) -> f64;

/// Where a span is inserted at `wanted`, moved to the nearer edge of a clip it lands inside, and
/// how far every clip at or after that position moves later to make room: `(position, shift)`.
pub fn ripple_insert(others: &[(f64, f64)], duration: f64, wanted: f64) -> (f64, f64);

/// Audio heard beside the vocal and never edited or warped.
pub struct Reference {
    pub id: ReferenceId,
    pub source: SourceInfo,
    pub position: f64,
    /// What the reference is called in place of its file's name.
    pub name: Option<String>,
}
```

Clips may overlap. The blobs of a `layer`, taken together in project seconds, are always one valid
`BlobSet`; `EditState::layer_blobs` builds it, `EditState::all_blobs` lists every clip's blobs,
and `EditState::conflicts` lists the gaps timing edits opened inside each clip. `free_position` and
`ripple_insert` place a clip that is not `exact`, which only operations recorded before `exact`
existed still do. `Blob::shifted` and `PitchCurve::shifted` move a blob and its anchors between
the two time domains.

## `analysis/segment.rs`

```rust
/// Parameters controlling provisional blob segmentation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentParams {
    pub min_blob_seconds: f64,     // default 0.06
    pub min_silence_seconds: f64,  // default 0.05
    pub pitch_change_semitones: f64, // default 0.9, sustained step that splits a note
    pub pitch_hold_seconds: f64,   // default 0.045, how long a step must hold
    pub onset_threshold: f32,      // default 0.35
    pub attach_consonants: bool,   // default true
}
impl Default for SegmentParams { /* the values above */ }

/// Produces provisional blobs from pitch, energy and onset evidence.
///
/// Voiced spans become candidate notes, sustained pitch steps and flux onsets split them,
/// short fragments merge into their nearest neighbour, and leading unvoiced consonant
/// material attaches to the following blob when `attach_consonants` is set.
pub fn segment(
    track: &PitchTrack,
    energy: &EnergyTrack,
    params: &SegmentParams,
) -> Result<BlobSet>;
```

## `timeline.rs`

```rust
/// A tempo change expressed in MIDI ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempoEvent { pub tick: u64, pub micros_per_quarter: u32 }

/// A time-signature change expressed in MIDI ticks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeterEvent { pub tick: u64, pub numerator: u8, pub denominator: u8 }

/// A musical position.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BarBeat {
    pub bar: i64,        // bar 1 is the first full bar at or after the musical origin
    pub beat: f64,       // 1-based, fractional
    pub beats_in_bar: u8,
    pub beat_unit: u8,
}

/// Ordered tempo and meter maps with a deterministic conversion between ticks,
/// beats, bars, seconds and samples.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineMap {
    pub ppq: u16,
    pub tempo: Vec<TempoEvent>,   // sorted, always contains a tick 0 event
    pub meter: Vec<MeterEvent>,   // sorted, always contains a tick 0 event
    /// Source seconds at musical tick 0. Negative places the musical origin before audio
    /// zero, which is how a pickup is represented.
    pub origin_seconds: f64,
    pub sample_rate: f64,
}

impl Default for TimelineMap { /* 480 ppq, 120 bpm, 4/4, origin 0, 48000 Hz */ }

impl TimelineMap {
    pub fn new(ppq: u16, sample_rate: f64) -> Result<Self>;
    /// Replaces the tempo map, sorting, deduplicating by tick and ensuring a tick 0 event.
    pub fn set_tempo(&mut self, events: Vec<TempoEvent>) -> Result<()>;
    pub fn set_meter(&mut self, events: Vec<MeterEvent>) -> Result<()>;
    pub fn tempo_at_tick(&self, tick: u64) -> TempoEvent;
    pub fn meter_at_tick(&self, tick: u64) -> MeterEvent;
    pub fn bpm_at_tick(&self, tick: u64) -> f64;
    /// Elapsed seconds from musical tick 0, ignoring `origin_seconds`.
    pub fn tick_to_musical_seconds(&self, tick: f64) -> f64;
    pub fn musical_seconds_to_tick(&self, seconds: f64) -> f64;
    /// Source seconds, including `origin_seconds`.
    pub fn tick_to_seconds(&self, tick: f64) -> f64;
    pub fn seconds_to_tick(&self, seconds: f64) -> f64;
    pub fn tick_to_beats(&self, tick: f64) -> f64;
    pub fn beats_to_tick(&self, beats: f64) -> f64;
    pub fn seconds_to_samples(&self, seconds: f64) -> f64;
    pub fn samples_to_seconds(&self, samples: f64) -> f64;
    pub fn tick_to_bar_beat(&self, tick: f64) -> BarBeat;
    pub fn bar_beat_to_tick(&self, bar: i64, beat: f64) -> f64;
    pub fn seconds_to_bar_beat(&self, seconds: f64) -> BarBeat;
    /// Tick of the first bar line at or after `tick`.
    pub fn next_bar_tick(&self, tick: f64) -> f64;
    /// Bar-line ticks in `[from_seconds, to_seconds]`, for ruler drawing.
    pub fn bar_lines(&self, from_seconds: f64, to_seconds: f64) -> Vec<(i64, f64)>;
    /// Beat ticks subdivided by `division` (1 = beats, 2 = eighths ...) in a time window,
    /// each paired with its source seconds and whether it lands on a bar line.
    pub fn beat_grid(&self, from_seconds: f64, to_seconds: f64, division: u32)
        -> Vec<BeatGridPoint>;
    /// Nearest grid position to `seconds` at `division`, in source seconds.
    pub fn snap_seconds(&self, seconds: f64, division: u32) -> f64;
}

/// One entry of the visible beat grid.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BeatGridPoint {
    pub seconds: f64,
    pub tick: f64,
    pub bar: i64,
    pub beat: f64,
    pub is_bar_line: bool,
    pub is_beat: bool,
}
```

Requirements: tempo conversion integrates piecewise across events, never a single project-wide bpm.
`bar_lines` and `beat_grid` must bound their output to `limits::MAX_MAP_EVENTS` entries and must
handle meter changes mid-bar by starting a new bar at the change. Negative ticks (before the musical
origin) evaluate with the tick 0 tempo. Reject `ppq == 0`, zero or absurd `micros_per_quarter`,
`numerator == 0`, and a `denominator` that is not a power of two in `1..=128`.

Tests must include: 120 bpm quarter is 0.5 s; a tempo change mid-file lands the right absolute
second; round trip seconds to ticks to seconds; a 4/4 to 3/4 change renumbers bars correctly; a
pickup with negative `origin_seconds`; snapping to eighths across a tempo change; sample conversion.

## `midi.rs`

```rust
/// A note taken from an imported MIDI file.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiNote {
    pub track: usize,
    pub channel: u8,
    pub key: u8,
    pub velocity: u8,
    pub start_tick: u64,
    pub end_tick: u64,
}

/// A track listed from an imported MIDI file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiTrackInfo {
    pub index: usize,
    pub name: Option<String>,
    pub instrument: Option<String>,
    pub channels: Vec<u8>,
    pub note_count: usize,
    /// Channel 10 or a percussion program, so not offered as a pitch guide by default.
    pub is_percussion: bool,
    pub first_tick: u64,
    pub last_tick: u64,
}

/// A parsed Standard MIDI File.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiFile {
    pub format: u8,
    pub ppq: u16,
    pub tracks: Vec<MidiTrackInfo>,
    pub notes: Vec<MidiNote>,      // sorted by start_tick then track
    pub tempo: Vec<TempoEvent>,
    pub meter: Vec<MeterEvent>,
}

impl MidiFile {
    /// Notes on one track, optionally restricted to a channel, in tick order.
    pub fn notes_of(&self, track: usize, channel: Option<u8>) -> Vec<MidiNote>;
    /// Overlapping notes within a guide selection, reported rather than silently resolved.
    pub fn overlaps(&self, track: usize, channel: Option<u8>) -> Vec<(MidiNote, MidiNote)>;
    /// Builds a timeline map from the embedded tempo and meter maps.
    pub fn to_timeline(&self, sample_rate: f64, origin_seconds: f64) -> Result<TimelineMap>;
}

/// Parses a Standard MIDI File.
///
/// Rejects files over `limits::MAX_MIDI_BYTES`, event counts over `limits::MAX_MIDI_EVENTS`,
/// SMPTE timing divisions (unsupported, reported as such), and a zero tick division.
/// Unterminated notes end at the last event of their track rather than being dropped.
pub fn parse_smf(bytes: &[u8]) -> Result<MidiFile>;

/// How a MIDI guide contributes to the pitch target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuideMode { VisualOnly, PitchOnly, TimingOnly, Combined }

/// The user's chosen MIDI guide and how it is aligned and applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSelection {
    pub track: usize,
    pub channel: Option<u8>,
    pub mode: GuideMode,
    /// Strength of the guide, 0.0 leaves the vocal alone, 1.0 follows the guide fully.
    pub strength: f64,
    pub muted: bool,
}
impl Default for GuideSelection { /* track 0, no channel, VisualOnly, strength 1.0 */ }

/// A proposed or user-set relationship between one blob and one MIDI note.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMapping {
    pub blob: BlobId,
    /// Index into the guide note list, or None when the blob is deliberately unmapped.
    pub note: Option<usize>,
    /// Set by the user rather than proposed by analysis.
    pub manual: bool,
    /// Excluded from guidance entirely.
    pub opted_out: bool,
}

/// Blobs and notes left unmatched or matched more than once by a proposal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingReport {
    pub unmapped_blobs: Vec<BlobId>,
    pub unmapped_notes: Vec<usize>,
    pub multiply_mapped_notes: Vec<usize>,
}

/// Proposes blob-to-note mappings from temporal overlap and pitch proximity.
///
/// Nothing is deleted to force a one-to-one result; leftovers appear in the report.
/// Existing manual mappings in `existing` are preserved.
pub fn propose_mappings(
    blobs: &BlobSet,
    notes: &[MidiNote],
    timeline: &TimelineMap,
    existing: &[NoteMapping],
) -> (Vec<NoteMapping>, MappingReport);

/// Offset in seconds that moves `note_tick` onto `target_seconds`.
///
/// Applied by the caller to `TimelineMap::origin_seconds`, so audio never moves.
pub fn anchor_offset(timeline: &TimelineMap, note_tick: u64, target_seconds: f64) -> f64;

/// Difference between guide onsets and blob onsets at the start and end of the overlap,
/// which separates a wrong global offset from a wrong tempo map.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    pub early_error_seconds: f64,
    pub late_error_seconds: f64,
    /// Constant component: a global offset fixes this.
    pub offset_seconds: f64,
    /// Growing component: only a tempo-map change fixes this.
    pub drift_seconds_per_second: f64,
    pub pairs_compared: usize,
}

/// Measures alignment error between mapped blobs and their guide notes.
pub fn measure_drift(
    blobs: &BlobSet,
    notes: &[MidiNote],
    mappings: &[NoteMapping],
    timeline: &TimelineMap,
) -> Option<DriftReport>;
```

Use the `midly` crate for parsing.

## `dsp/window.rs`

```rust
/// Builds a periodic Hann window of `len` samples.
pub fn hann(len: usize) -> Vec<f32>;
/// Builds a symmetric Hann window of `len` samples, which sums to unity at 50% overlap.
pub fn hann_symmetric(len: usize) -> Vec<f32>;
/// Normalised cross-correlation of two equal-length slices, in -1.0..=1.0.
pub fn normalised_correlation(a: &[f32], b: &[f32]) -> f32;
/// Peak absolute value of a slice.
pub fn peak(samples: &[f32]) -> f32;
/// Root mean square of a slice.
pub fn rms(samples: &[f32]) -> f32;
```

## `dsp/resample.rs`

```rust
/// Reads `source` at a fractional sample position with Catmull-Rom interpolation.
///
/// Positions outside the buffer read as silence.
pub fn sample_at(source: &[f32], position: f64) -> f32;

/// Resamples `source` to `target_rate` with a windowed-sinc kernel.
///
/// `quality` is the half-width of the kernel in source samples; 16 is a good default.
pub fn resample(source: &[f32], source_rate: f64, target_rate: f64, quality: usize) -> Vec<f32>;

/// Mixes interleaved multi-channel audio down to mono.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32>;
```

## `dsp/formant.rs`

```rust
/// How formants are treated while pitch moves.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FormantMode {
    /// Formants ride with pitch, as a plain resampling would do.
    Follow,
    /// The spectral envelope is held while pitch moves.
    Preserve,
    /// The envelope is held and then shifted by a user amount in semitones.
    Shift(f64),
}
impl Default for FormantMode { /* Preserve */ }

/// Estimates a spectral envelope by cepstral liftering.
///
/// `order` is the quefrency cutoff in bins; 40 suits speech at 48 kHz.
pub fn spectral_envelope(frame: &[f32], order: usize) -> Vec<f32>;

/// Re-imposes `target_envelope` on `frame`, which already carries `source_envelope`.
///
/// Both envelopes are magnitude spectra of the same length as the frame's rFFT output.
pub fn apply_envelope_correction(
    frame: &mut [f32],
    source_envelope: &[f32],
    target_envelope: &[f32],
);

/// Warps a magnitude envelope by `ratio` along frequency, resampling linearly.
pub fn warp_envelope(envelope: &[f32], ratio: f64) -> Vec<f32>;
```

Use `rustfft`. Keep allocations out of the hot path by exposing a reusable struct if that helps,
but the free functions above must exist.

## `dsp/psola.rs`

```rust
/// Pitch marks and their local periods for one source buffer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EpochMap {
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
    pub fn index_at(&self, position: f64) -> Option<usize>;
    /// Interpolated local period in samples at `position`.
    pub fn period_at(&self, position: f64) -> f32;
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
    unvoiced_period_seconds: f64, // 0.01 is a good default
) -> EpochMap;

/// A deterministic time-domain PSOLA synthesiser.
///
/// Rendering any output range produces the same samples regardless of how the range is
/// split, because every grain is derived from the output sample position alone. This is
/// what lets the realtime worklet and the offline export share one interpretation.
pub struct Psola<'a> {
    /* private: source, epochs, sample_rate */
}

impl<'a> Psola<'a> {
    pub fn new(source: &'a [f32], epochs: &'a EpochMap) -> Self;

    /// Renders `out.len()` samples starting at output sample `out_start`.
    ///
    /// `source_at` maps an output sample index to a fractional source sample position and
    /// must be non-decreasing. `pitch_ratio_at` gives the frequency multiplier to apply at
    /// that output position; 1.0 leaves pitch unchanged. `unvoiced_passthrough` copies
    /// unvoiced grains without repitching so consonants keep their character.
    pub fn render(
        &self,
        out_start: u64,
        out: &mut [f32],
        source_at: &dyn Fn(u64) -> f64,
        pitch_ratio_at: &dyn Fn(u64) -> f64,
        formant: FormantMode,
    );
}
```

Implementation notes: this is TD-PSOLA (Moulines and Charpentier, 1990). For each output block,
walk output pitch marks from a deterministic seed derived from `out_start` (recompute the mark
phase from output sample 0 by integrating the target period, so block splits cannot drift), take
the nearest source epoch to `source_at(mark)`, window two periods of source around it with a Hann
window, and overlap-add. Unvoiced grains overlap-add at their source period. Guard every slice
index. Never allocate more than a fixed scratch per call.

`FormantMode::Preserve` is achieved by resampling each grain's _content_ by the inverse pitch ratio
while keeping the grain's placement at the target period, which holds the envelope; `Shift(s)`
additionally resamples by `2^(s/12)`.

## `target.rs`

```rust
/// A curve sampled on a uniform grid in source seconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SampledCurve {
    pub start: f64,
    pub hop: f64,
    pub values: Vec<f32>,
}

impl SampledCurve {
    pub fn constant(value: f32, start: f64, hop: f64, len: usize) -> Self;
    /// Linearly interpolated value at `time`, clamped at both ends. Returns 0.0 when empty.
    pub fn at(&self, time: f64) -> f32;
    pub fn end(&self) -> f64;
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
    pub fn identity(duration: f64) -> Self;
    pub fn from_points(points: Vec<(f64, f64)>) -> Result<Self>;
    /// Source seconds at an output time, extrapolating the end segments.
    pub fn source_at(&self, out: f64) -> f64;
    /// Output seconds at a source time; the inverse of `source_at`.
    pub fn output_at(&self, source: f64) -> f64;
    /// Local playback rate, source seconds per output second.
    pub fn rate_at(&self, out: f64) -> f64;
    pub fn output_duration(&self) -> f64;
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
impl Default for ScaleSettings { /* C chromatic, strength 0.0 */ }

impl ScaleSettings {
    /// Nearest allowed MIDI value to `midi`, or `midi` itself when no degree qualifies.
    pub fn quantise(&self, midi: f64) -> f64;
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
    pub vibrato_split_hz: f64, // default 3.0
}
impl Default for ModulationSettings { /* 1.0, 1.0, 3.0 */ }

/// Everything needed to interpret a project's edits as audio, shared by preview and export.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPlan {
    pub sample_rate: f64,
    pub time_map: TimeMap,
    /// Frequency multiplier indexed by **source** time. 1.0 leaves pitch unchanged.
    pub pitch_ratio: SampledCurve,
    /// Pitch the plan produces, in fractional MIDI, indexed by **source** time.
    ///
    /// 0.0 where the plan leaves pitch alone. Published so the editor draws what will be heard
    /// rather than rebuilding it from its own copy of the detected track, which disagrees with
    /// this one wherever detection is uncertain. Read by the editor, never by the renderer, so a
    /// plan written by hand may omit it.
    #[serde(default)]
    pub target_midi: SampledCurve,
    /// Amplitude multiplier indexed by **source** time. 1.0 leaves level unchanged, and carries
    /// each blob's own level. A plan written by hand may omit it.
    #[serde(default)]
    pub gain: SampledCurve,
    pub formant: FormantMode,
}

impl RenderPlan {
    /// A plan that reproduces the source exactly.
    pub fn passthrough(sample_rate: f64, duration: f64) -> Self;
    /// Whether the plan asks for nothing: no time move, no repitch, no formant move.
    pub fn is_identity(&self) -> bool;
    /// Whether any blob asks for a level other than the one it was sung at.
    pub fn moves_level(&self) -> bool;
}

/// Inputs the compiler reads to produce a plan.
pub struct PlanInputs<'a> {
    pub track: &'a PitchTrack,
    pub blobs: &'a BlobSet,
    /// Source spans whose blobs were deleted; the plan's gain is zero across them.
    pub silenced: &'a [Span],
    pub sample_rate: f64,
    pub duration: f64,
    pub scale: &'a ScaleSettings,
    pub modulation: &'a ModulationSettings,
    pub formant: FormantMode,
    pub guide: Option<GuideInputs<'a>>,
    /// Plan resolution in seconds; 0.005 matches the analysis hop.
    pub hop: f64,
}

/// Guide data supplied to the plan compiler.
pub struct GuideInputs<'a> {
    pub notes: &'a [MidiNote],
    pub mappings: &'a [NoteMapping],
    pub timeline: &'a TimelineMap,
    pub selection: &'a GuideSelection,
}

/// Compiles all active edits into one deterministic render plan.
///
/// Intent composes in a fixed order, later stages seeing the result of the earlier ones:
/// detected pitch, then scale correction, then MIDI pitch guidance, then blob pitch offset,
/// then drawn curve anchors, then modulation. A blob's `excluded` flag skips scale correction
/// and MIDI guidance for that blob. Blob timing offsets and scales, plus MIDI timing guidance,
/// build the time map.
pub fn compile_plan(inputs: &PlanInputs<'_>) -> Result<RenderPlan>;

/// Splits blobs into voices whose edited spans never overlap, in edited start order.
pub fn voice_layers(blobs: &BlobSet) -> Vec<Vec<BlobId>>;

/// A plan per voice of `voice_layers`: the first plays everything but the other voices' blobs,
/// every other plays its own blobs alone. One plan, `compile_plan`'s, with no overlaps.
pub fn compile_voices(inputs: &PlanInputs<'_>) -> Result<Vec<RenderPlan>>;

/// Splits a detected contour into slow drift and fast vibrato about `split_hz`.
///
/// Returns (drift, vibrato) sampled on the same grid as the input.
pub fn split_modulation(values: &[f32], hop: f64, split_hz: f64) -> (Vec<f32>, Vec<f32>);
```

## `edit.rs`

```rust
/// A serialisable user intent applied over immutable analysis.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditOp {
    SplitBlob { blob: BlobId, time: f64 },
    JoinBlobs { first: BlobId, second: BlobId },
    MoveBoundary { blob: BlobId, edge: Edge, time: f64 },
    SetVoicing { blob: BlobId, start: f64, end: f64, voicing: Voicing },
    MovePitch { blobs: Vec<BlobId>, semitones: f64 },
    SetPitchOffset { blob: BlobId, semitones: f64 },
    MoveTime { blobs: Vec<BlobId>, seconds: f64 },
    SetTimeScale { blob: BlobId, scale: f64 },
    AddAnchor { blob: BlobId, anchor: Anchor },
    MoveAnchor { blob: BlobId, index: usize, time: f64, midi: f64 },
    RemoveAnchor { blob: BlobId, index: usize },
    DrawSpan { blob: BlobId, anchors: Vec<Anchor> },
    SmoothSpan { blob: BlobId, start: f64, end: f64, amount: f64 },
    ResetSpan { blob: BlobId, start: f64, end: f64 },
    ResetBlob { blob: BlobId },
    ResetRange { start: f64, end: f64 },
    SetExcluded { blob: BlobId, excluded: bool },
    SetGain { blob: BlobId, gain_db: f64 },
    DeleteBlobs { blobs: Vec<BlobId> },
    AddClip { clip: Clip, ripple: bool, exact: bool },
    MoveClip { clip: ClipId, position: f64, exact: bool },
    RemoveClip { clip: ClipId },
    AddReference { reference: Reference },
    MoveReference { reference: ReferenceId, position: f64 },
    RemoveReference { reference: ReferenceId },
    RenameClip { clip: ClipId, name: Option<String> },
    RenameReference { reference: ReferenceId, name: Option<String> },
    SetMixer { mixer: MixerSettings },
    SetScale { scale: ScaleSettings },
    SetModulation { modulation: ModulationSettings },
    SetFormant { formant: FormantMode },
    SetGuide { selection: Option<GuideSelection> },
    SetMapping { mapping: NoteMapping },
    SetTimelineOrigin { seconds: f64 },
    SetTempoMap { events: Vec<TempoEvent> },
    SetMeterMap { events: Vec<MeterEvent> },
    /// Applies several operations as one undo step.
    Group { ops: Vec<EditOp> },
}

impl EditOp {
    /// Short label for the undo history, e.g. "Move Pitch".
    pub fn label(&self) -> &'static str;
}

/// Undo and redo stacks over a project's edit history.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History { /* private: applied ops and undone ops */ }

impl History {
    pub fn new() -> Self;
    pub fn push(&mut self, op: EditOp);
    pub fn can_undo(&self) -> bool;
    pub fn can_redo(&self) -> bool;
    /// Removes and returns the newest applied op, moving it to the redo stack.
    pub fn undo(&mut self) -> Option<EditOp>;
    pub fn redo(&mut self) -> Option<EditOp>;
    pub fn applied(&self) -> &[EditOp];
    pub fn undo_label(&self) -> Option<&'static str>;
    pub fn redo_label(&self) -> Option<&'static str>;
    pub fn clear(&mut self);
}
```

`edit.rs` also hosts the applier, which lives in `project.rs`'s owner module but is declared here:

```rust
/// The per-clip evidence an operation may read.
pub trait ClipSources {
    fn track(&self, clip: ClipId) -> Option<&PitchTrack>;
    /// The analysed segmentation a range reset restores.
    fn baseline(&self, clip: ClipId) -> Option<&BlobSet>;
}

/// Applies one operation, reading each clip's own evidence.
pub fn apply_in(state: &mut EditState, sources: &dyn ClipSources, op: &EditOp) -> Result<()>;

/// The same, with one track and one baseline read for every clip.
pub fn apply(state: &mut EditState, track: Option<&PitchTrack>, op: &EditOp) -> Result<()>;
pub fn apply_with_baseline(state: &mut EditState, track: Option<&PitchTrack>,
    baseline: Option<&BlobSet>, op: &EditOp) -> Result<()>;
```

`DeleteBlobs` removes the blobs and silences the source spans they covered; `ResetRange` restores
both the analysed blobs and the silenced material across its span. `AddClip` refuses a clip whose
blobs are not numbered for it. With `exact` it lands where it was asked, over any clip there; with
`ripple` it lands where it was asked, or on the nearer edge of a clip it was asked inside, and every
clip after it moves later by the overlap; with neither it lands on the nearest free position.
`MoveClip` with `exact` goes where it was asked and otherwise to the nearest free position. Both
flags default to false, so a recorded operation replays as it was made. Importing a second vocal or
a reference is an edit like any other,
so undo takes it back; the first clip is the base state the history replays over.

## `audio/wav.rs`

```rust
/// Bit depth of an exported WAV file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BitDepth { Pcm16, Pcm24, Float32 }

/// Decoded PCM audio with its source facts.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    pub sample_rate: u32,
    pub channels: u16,
    /// Deinterleaved channels.
    pub data: Vec<Vec<f32>>,
}

impl DecodedAudio {
    pub fn frames(&self) -> usize;
    pub fn duration(&self) -> f64;
    pub fn to_mono(&self) -> Vec<f32>;
}

/// Parses a RIFF WAVE file of PCM or IEEE float samples.
///
/// Rejects sizes, rates and channel counts outside `crate::limits`, truncated chunks and
/// unsupported codecs, without panicking on any input.
pub fn decode_wav(bytes: &[u8]) -> Result<DecodedAudio>;

/// Writes mono or interleaved PCM as a RIFF WAVE file.
///
/// Samples are clamped to the representable range, and `peak` in the returned report says
/// whether clipping was reached so the caller can warn before saving.
pub fn encode_wav(
    channels: &[Vec<f32>],
    sample_rate: u32,
    depth: BitDepth,
) -> Result<(Vec<u8>, ExportReport)>;

/// What an export produced.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub frames: usize,
    pub peak: f32,
    pub clipped_samples: usize,
}
```

## `project.rs`

```rust
/// Current project schema version.
pub const SCHEMA_VERSION: u32 = 2;

/// Immutable facts about the imported source audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub name: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub frames: usize,
    pub duration: f64,
    /// FNV-1a 64-bit digest of the decoded mono PCM, used to verify a relink.
    pub fingerprint: String,
    pub mime: Option<String>,
}

/// Parameters and version that produced the stored analysis, so it can be recomputed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisInfo {
    pub analyser_version: u32,
    pub f0: F0Params,
    pub segment: SegmentParams,
}

/// The mutable part of a project: everything an edit operation may change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditState {
    pub name: String,
    /// Vocal clips on the lane, in the order they were imported.
    pub clips: Vec<Clip>,
    pub references: Vec<Reference>,
    pub scale: ScaleSettings,
    pub modulation: ModulationSettings,
    pub formant: FormantMode,
    pub timeline: TimelineMap,
    pub guide: Option<GuideSelection>,
    pub mappings: Vec<NoteMapping>,
    pub tuning: Tuning,
    pub accidentals: AccidentalStyle,
    /// Monitor levels for everything the transport plays. Never read by the plan compiler; an
    /// export reads only the reference strips, and only when it includes references.
    #[serde(default)]
    pub mixer: MixerSettings,
}

/// The monitor desk, in `mixer.rs`: a track per clip, a strip per reference, one click and a
/// master.
///
/// A clip or reference with no entry reads as the strips it starts with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSettings {
    pub clips: Vec<ClipStrips>,
    pub references: Vec<ReferenceStrip>,
    pub click: MixerStrip,
    /// Level and mute only; never panned or soloed. Unity when a document has none.
    #[serde(default)]
    pub master: MixerStrip,
}

/// A clip's track: the take as edited and as sung.
pub struct ClipStrips { pub clip: ClipId, pub processed: MixerStrip, pub original: MixerStrip }

/// A reference's strip.
pub struct ReferenceStrip { pub reference: ReferenceId, pub strip: MixerStrip }

/// One audio source on the desk.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerStrip {
    /// Level in decibels; 0.0 is unity and `limits::MIN_GAIN_DB` is silence.
    pub gain_db: f64,
    /// Position across the stereo field, -1.0 hard left to 1.0 hard right.
    pub pan: f64,
    pub mute: bool,
    /// Silences every strip that is not soloed.
    pub solo: bool,
}

impl MixerSettings {
    /// A clip's track, or the one it starts with: processed up, original muted.
    pub fn clip(&self, clip: ClipId) -> ClipStrips;
    pub fn reference(&self, reference: ReferenceId) -> MixerStrip;
    pub fn strips(&self) -> Vec<&MixerStrip>;
    pub fn soloed(&self) -> bool;
    /// The same settings with every figure brought inside its bounds. A level out of range is
    /// clamped; a figure that is not a number is refused.
    pub fn validated(&self) -> Result<Self>;
}

/// Saved editor view state, restored on reopen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    pub visible_start: f64,
    pub visible_end: f64,
    pub low_midi: f64,
    pub high_midi: f64,
    pub time_display: TimeDisplay,
    pub snap_division: u32,
    pub playhead: f64,
    pub loop_start: Option<f64>,
    pub loop_end: Option<f64>,
    /// The clip in front; `None` is the first clip.
    pub active_clip: Option<ClipId>,
    /// How the clips outside the active layer are shown. `Show` when a document has none.
    pub others: OthersView,
}

/// Show draws the others behind the layer and a click brings one forward; Dim and Hide edit the
/// active clip alone.
pub enum OthersView { Show, Dim, Hide }
impl Default for ViewState { /* 0..10 s, MIDI 36..84, Seconds, division 4 */ }

/// Whether the ruler reads in clock time or in bars and beats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimeDisplay { Seconds, BarsBeats }

/// A complete saved project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub app_version: String,
    pub name: String,
    /// The audio and analysis of every clip the project or its history can put on the lane.
    pub clips: Vec<ClipMedia>,
    /// Every reference the project or its history can bring in, for relinking.
    pub references: Vec<Reference>,
    pub edits: EditState,
    /// The state the history replays from: the analysis, plus everything no edit recorded, such
    /// as the timeline a MIDI import adopted. An undo rebuilds `edits` from this and `history`,
    /// so the document has to carry it or a reopened project loses it on the first undo.
    pub base: EditState,
    /// Bytes of the imported MIDI file, base64, so the guide survives a reopen.
    pub midi: Option<String>,
    pub view: ViewState,
    pub history: History,
}

/// What a project keeps about one clip's audio, whether or not the clip is on the lane now.
pub struct ClipMedia {
    pub clip: ClipId,
    pub source: SourceInfo,
    pub analysis: AnalysisInfo,
    /// Discardable: it can be rebuilt from the source and params.
    pub track: Option<PitchTrack>,
    /// The analysed segmentation, numbered for the clip.
    pub blobs: BlobSet,
}

impl Project {
    /// A project with one clip at the start of the lane.
    pub fn new(name: String, source: SourceInfo, analysis: AnalysisInfo) -> Self;
    pub fn to_json(&self) -> Result<String>;
    /// Parses and migrates a project document of any supported schema version.
    pub fn from_json(json: &str) -> Result<Project>;
    /// True when `other` describes the same media as one of the project's clips.
    pub fn matches_source(&self, other: &SourceInfo) -> bool;
    pub fn clip_media(&self, clip: ClipId) -> Option<&ClipMedia>;
}
```

Schema version 1 held one source. `migrate` rewrites it as a project with that source as clip 0 at
position 0: `source`, `analysis` and `track` become clip 0's media, each edit state's `blobs`
become clip 0 on its lane, and the desk, wherever it appears including inside recorded
operations, becomes clip 0's track.

```rust

/// FNV-1a 64-bit digest of PCM, rendered as 16 lowercase hex characters.
pub fn fingerprint(samples: &[f32]) -> String;

/// Upgrades a parsed project document to `SCHEMA_VERSION`.
///
/// Errors on a version newer than this build understands rather than guessing.
pub fn migrate(value: serde_json::Value) -> Result<serde_json::Value>;
```

Base64 helpers live in `project.rs` as `pub fn to_base64(bytes: &[u8]) -> String` and
`pub fn from_base64(text: &str) -> Result<Vec<u8>>`, hand-written, no new dependency.

## `render.rs`

```rust
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
    /* private */
}

impl Renderer {
    /// Builds a renderer. `source` is mono at `plan.sample_rate`.
    pub fn new(source: Vec<f32>, track: &PitchTrack, plan: RenderPlan, quality: Quality) -> Self;
    /// Replaces the plan without rebuilding the epoch map.
    pub fn set_plan(&mut self, plan: RenderPlan);
    pub fn plan(&self) -> &RenderPlan;
    /// Total output length in samples.
    pub fn output_frames(&self) -> u64;
    /// Renders `out.len()` samples starting at output sample `out_start`.
    pub fn render_range(&self, out_start: u64, out: &mut [f32]);
    /// Renders the whole output, or the given output-second range.
    pub fn render_all(&self, range: Option<(f64, f64)>) -> Vec<f32>;
}
```

`render.rs` converts the plan into the two closures `Psola::render` wants: `source_at` from
`TimeMap`, and `pitch_ratio_at` from `pitch_ratio` evaluated at the _source_ time the time map
gives. For a plan that `is_identity`, `render_range` copies the source through the time map with
plain interpolation and no repitching, so an unedited take renders as the file that was imported
rather than as a resynthesis of it.
