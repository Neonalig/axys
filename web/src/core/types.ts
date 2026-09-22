// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * TypeScript mirrors of the `axys-core` serde contracts.
 *
 * Field names are the camelCase spellings serde emits, so a value parsed from a core JSON
 * payload is directly one of these types.
 */

/** Concert reference tuning. */
export interface Tuning {
  /** Frequency of A4 in Hz. */
  a4Hz: number;
}

/** How accidentals are spelled when a note is named. */
export type AccidentalStyle = 'sharps' | 'flats';

/** Interpolation character leaving an anchor toward the next one. */
export type Interp = 'linear' | 'cubic' | 'hold' | 'smooth';

/** One editable point on a pitch curve. */
export interface Anchor {
  /** Position in source seconds. */
  time: number;
  /** Fractional MIDI note number. */
  midi: number;
  interp: Interp;
}

/** An ordered set of anchors evaluated as a continuous pitch function. */
export interface PitchCurve {
  /** Anchors in time order. */
  anchors: Anchor[];
}

/** One analysis frame of detected pitch. */
export interface PitchFrame {
  /** Frame centre in source seconds. */
  time: number;
  /** Detected frequency in Hz, 0 when unvoiced. */
  f0: number;
  /** Fractional MIDI at A4=440, null when unvoiced. */
  midi: number | null;
  /** Detection confidence, 0 to 1. */
  confidence: number;
  rms: number;
  voiced: boolean;
}

/** Detected pitch over time, stored as ordered frames on a uniform hop. */
export interface PitchTrack {
  sampleRate: number;
  hopSeconds: number;
  frames: PitchFrame[];
}

/**
 * Flat arrays of a pitch track, as the editor and the renderer consume them.
 *
 * `midi` holds NaN where the frame is unvoiced.
 */
export interface PitchTrackArrays {
  times: Float32Array;
  midi: Float32Array;
  confidence: Float32Array;
  rms: Float32Array;
}

/**
 * Serde form of {@link PitchTrackArrays}, in which an unvoiced frame's MIDI is null.
 */
export interface PitchTrackArraysJson {
  times: number[];
  midi: (number | null)[];
  confidence: number[];
  rms: number[];
}

/** Parameters controlling fundamental-frequency estimation. */
export interface F0Params {
  minHz: number;
  maxHz: number;
  /** Analysis window length in seconds. */
  frameSeconds: number;
  /** Frame spacing in seconds. */
  hopSeconds: number;
  /** YIN absolute threshold. */
  threshold: number;
  /** RMS below which a frame cannot be voiced. */
  voicedRmsFloor: number;
}

/** Short-time energy and onset evidence on the pitch track's hop grid. */
export interface EnergyTrack {
  hopSeconds: number;
  times: number[];
  rms: number[];
  /** Frame RMS in dB, floored at -120. */
  rmsDb: number[];
  /** Half-wave rectified spectral flux, normalised to 0 to 1. */
  spectralFlux: number[];
  zeroCrossingRate: number[];
}

/** Parameters controlling provisional blob segmentation. */
export interface SegmentParams {
  minBlobSeconds: number;
  minSilenceSeconds: number;
  /** Sustained pitch step that splits a note, in semitones. */
  pitchChangeSemitones: number;
  /** How long a pitch step must hold before it splits a note. */
  pitchHoldSeconds: number;
  onsetThreshold: number;
  /** Attaches leading unvoiced consonant material to the following blob. */
  attachConsonants: boolean;
}

/** Stable identifier for a blob within one project. */
export type BlobId = number;

/** How a subregion of a blob was classified. */
export type Voicing = 'voiced' | 'unvoiced' | 'silence';

/** A classified span inside a blob. */
export interface Subregion {
  start: number;
  end: number;
  voicing: Voicing;
}

/** An editable note-like region of the analysed vocal. */
export interface Blob {
  id: BlobId;
  start: number;
  end: number;
  /** Representative detected pitch, fractional MIDI. */
  detectedCenter: number;
  /** Semitone offset applied to the whole blob. */
  pitchOffset: number;
  /** Seconds the blob has been moved along the timeline. */
  timeOffset: number;
  /** Multiplier on the blob duration; 1 leaves it unchanged. */
  timeScale: number;
  subregions: Subregion[];
  /** Anchors editing the target inside this blob, in source seconds. */
  curve: PitchCurve;
  /** Excludes the blob from automatic scale correction and guidance. */
  excluded: boolean;
}

/** An ordered, non-overlapping set of blobs. */
export interface BlobSet {
  blobs: Blob[];
  /** Next identifier the core will hand out. */
  nextId: number;
}

/** Which edge of a blob a boundary edit addresses. */
export type Edge = 'start' | 'end';

/** Whether edited blobs collide or leave a hole. */
export type ConflictKind = 'overlap' | 'gap';

/** An overlap or gap between edited blob positions. */
export interface TimingConflict {
  first: BlobId;
  second: BlobId;
  start: number;
  end: number;
  kind: ConflictKind;
}

/** A tempo change expressed in MIDI ticks. */
export interface TempoEvent {
  tick: number;
  microsPerQuarter: number;
}

/** A time-signature change expressed in MIDI ticks. */
export interface MeterEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

/** A musical position. */
export interface BarBeat {
  /** Bar 1 is the first full bar at or after the musical origin. */
  bar: number;
  /** 1-based, fractional. */
  beat: number;
  beatsInBar: number;
  beatUnit: number;
}

/** Ordered tempo and meter maps converting between ticks, bars, seconds and samples. */
export interface TimelineMap {
  ppq: number;
  /** Sorted, always containing a tick 0 event. */
  tempo: TempoEvent[];
  /** Sorted, always containing a tick 0 event. */
  meter: MeterEvent[];
  /** Source seconds at musical tick 0; negative places the origin before audio zero. */
  originSeconds: number;
  sampleRate: number;
}

/** One entry of the visible beat grid. */
export interface BeatGridPoint {
  seconds: number;
  tick: number;
  bar: number;
  beat: number;
  isBarLine: boolean;
  isBeat: boolean;
}

/** A note taken from an imported MIDI file. */
export interface MidiNote {
  track: number;
  channel: number;
  key: number;
  velocity: number;
  startTick: number;
  endTick: number;
}

/** A track listed from an imported MIDI file. */
export interface MidiTrackInfo {
  index: number;
  name: string | null;
  instrument: string | null;
  channels: number[];
  noteCount: number;
  /** Channel 10 or a percussion program, so not offered as a pitch guide by default. */
  isPercussion: boolean;
  firstTick: number;
  lastTick: number;
}

/** A parsed Standard MIDI File. */
export interface MidiFile {
  format: number;
  ppq: number;
  tracks: MidiTrackInfo[];
  /** Sorted by start tick, then track. */
  notes: MidiNote[];
  tempo: TempoEvent[];
  meter: MeterEvent[];
}

/** How a MIDI guide contributes to the pitch target. */
export type GuideMode = 'visualOnly' | 'pitchOnly' | 'timingOnly' | 'combined';

/** The chosen MIDI guide and how it is applied. */
export interface GuideSelection {
  track: number;
  channel: number | null;
  mode: GuideMode;
  /** 0 leaves the vocal alone, 1 follows the guide fully. */
  strength: number;
  muted: boolean;
}

/** A relationship between one blob and one MIDI note. */
export interface NoteMapping {
  blob: BlobId;
  /** Index into the guide note list, or null when the blob is deliberately unmapped. */
  note: number | null;
  /** Set by the user rather than proposed by analysis. */
  manual: boolean;
  /** Excluded from guidance entirely. */
  optedOut: boolean;
}

/** A proposed set of blob-to-note mappings and what it left unmatched. */
export interface MappingProposal {
  mappings: NoteMapping[];
  report: MappingReport;
}

/** Blobs and notes left unmatched or matched more than once by a proposal. */
export interface MappingReport {
  unmappedBlobs: BlobId[];
  unmappedNotes: number[];
  multiplyMappedNotes: number[];
  /** Notes that sound at once with another note, reported and never resolved. */
  overlappingNotes: number[];
}

/**
 * Two guide notes that sound at once in a monophonic guide.
 *
 * Note indices address the selected guide's note list, the same list a {@link NoteMapping}
 * indexes. Axys reports an overlap and never resolves it.
 */
export interface GuideOverlap {
  first: number;
  second: number;
  firstKey: number;
  secondKey: number;
  /** Start of the shared span in source seconds. */
  startSeconds: number;
  /** End of the shared span in source seconds. */
  endSeconds: number;
}

/** Alignment error between mapped blobs and their guide notes. */
export interface DriftReport {
  earlyErrorSeconds: number;
  lateErrorSeconds: number;
  /** Constant component: a global offset fixes this. */
  offsetSeconds: number;
  /** Growing component: only a tempo-map change fixes this. */
  driftSecondsPerSecond: number;
  pairsCompared: number;
}

/** A curve sampled on a uniform grid in source seconds. */
export interface SampledCurve {
  start: number;
  hop: number;
  values: number[];
}

/** A monotone piecewise-linear map from output time to source time. */
export interface TimeMap {
  /** Ascending (output seconds, source seconds) pairs, always at least two. */
  points: [number, number][];
}

/** Key and scale used by pitch-scale correction. */
export interface ScaleSettings {
  /** Pitch class of the tonic, 0 is C. */
  root: number;
  /** Allowed pitch classes relative to the root, ascending. */
  degrees: number[];
  /** How strongly detected pitch is pulled to the nearest allowed note, 0 to 1. */
  strength: number;
  /** Pitch classes excluded from correction. */
  excluded: number[];
}

/** Controls over expressive modulation retained through correction. */
export interface ModulationSettings {
  /** 1 keeps all slow drift, 0 removes it. */
  drift: number;
  /** 1 keeps vibrato at its detected depth, 0 removes it, 2 doubles it. */
  vibratoDepth: number;
  /** Boundary in Hz between drift and vibrato. */
  vibratoSplitHz: number;
}

/** How formants are treated while pitch moves. */
export type FormantMode = 'follow' | 'preserve' | { shift: number };

/** Everything needed to interpret a project's edits as audio. */
export interface RenderPlan {
  sampleRate: number;
  timeMap: TimeMap;
  /** Frequency multiplier indexed by source time; 1 leaves pitch unchanged. */
  pitchRatio: SampledCurve;
  /** Pitch the plan produces in fractional MIDI, indexed by source time; 0 where it leaves it. */
  targetMidi: SampledCurve;
  formant: FormantMode;
}

/** A serialisable user intent applied over immutable analysis. */
export type EditOp =
  | { type: 'splitBlob'; blob: BlobId; time: number }
  | { type: 'joinBlobs'; first: BlobId; second: BlobId }
  | { type: 'moveBoundary'; blob: BlobId; edge: Edge; time: number }
  | { type: 'setVoicing'; blob: BlobId; start: number; end: number; voicing: Voicing }
  | { type: 'movePitch'; blobs: BlobId[]; semitones: number }
  | { type: 'setPitchOffset'; blob: BlobId; semitones: number }
  | { type: 'moveTime'; blobs: BlobId[]; seconds: number }
  | { type: 'setTimeScale'; blob: BlobId; scale: number }
  | { type: 'addAnchor'; blob: BlobId; anchor: Anchor }
  | { type: 'moveAnchor'; blob: BlobId; index: number; time: number; midi: number }
  | { type: 'removeAnchor'; blob: BlobId; index: number }
  | { type: 'drawSpan'; blob: BlobId; anchors: Anchor[] }
  | { type: 'smoothSpan'; blob: BlobId; start: number; end: number; amount: number }
  | { type: 'resetSpan'; blob: BlobId; start: number; end: number }
  | { type: 'resetBlob'; blob: BlobId }
  | { type: 'resetRange'; start: number; end: number }
  | { type: 'setExcluded'; blob: BlobId; excluded: boolean }
  | { type: 'setScale'; scale: ScaleSettings }
  | { type: 'setTuning'; tuning: Tuning }
  | { type: 'setAccidentals'; accidentals: AccidentalStyle }
  | { type: 'setModulation'; modulation: ModulationSettings }
  | { type: 'setFormant'; formant: FormantMode }
  | { type: 'setGuide'; selection: GuideSelection | null }
  | { type: 'setMapping'; mapping: NoteMapping }
  | { type: 'setMappings'; mappings: NoteMapping[] }
  | { type: 'setTimelineOrigin'; seconds: number }
  | { type: 'setTempoMap'; events: TempoEvent[] }
  | { type: 'setMeterMap'; events: MeterEvent[] }
  | { type: 'group'; ops: EditOp[] };

/** Undo and redo stacks over a project's edit history. */
export interface History {
  applied: EditOp[];
  undone: EditOp[];
}

/** Bit depth of an exported WAV file. */
export type BitDepth = 'pcm16' | 'pcm24' | 'float32';

/** What an export produced. */
export interface ExportReport {
  frames: number;
  peak: number;
  clippedSamples: number;
}

/**
 * What an export of one output range would produce, measured before a file is encoded.
 *
 * @remarks Times are output seconds and `frames` counts them at the project sample rate.
 */
export interface ExportPreview {
  start: number;
  end: number;
  frames: number;
  duration: number;
  /** Largest sample magnitude the render reaches. */
  peak: number;
  /** Whether a fixed-point export would clamp the peak. */
  clips: boolean;
  /** Timing conflicts overlapping the source audio the range reads. */
  conflicts: number;
  /** Seconds of the range that map outside the source and render as silence. */
  silent: number;
}

/** Immutable facts about the imported source audio. */
export interface SourceInfo {
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  duration: number;
  /** FNV-1a 64-bit digest of the decoded mono PCM, used to verify a relink. */
  fingerprint: string;
  mime: string | null;
}

/** Parameters and version that produced the stored analysis. */
export interface AnalysisInfo {
  analyserVersion: number;
  f0: F0Params;
  segment: SegmentParams;
}

/** The mutable part of a project: everything an edit operation may change. */
export interface EditState {
  blobs: BlobSet;
  scale: ScaleSettings;
  modulation: ModulationSettings;
  formant: FormantMode;
  timeline: TimelineMap;
  guide: GuideSelection | null;
  mappings: NoteMapping[];
  tuning: Tuning;
  accidentals: AccidentalStyle;
}

/** Whether the ruler reads in clock time or in bars and beats. */
export type TimeDisplay = 'seconds' | 'barsBeats';

/** Saved editor view state, restored on reopen. */
export interface ViewState {
  visibleStart: number;
  visibleEnd: number;
  lowMidi: number;
  highMidi: number;
  timeDisplay: TimeDisplay;
  snapDivision: number;
  playhead: number;
  loopStart: number | null;
  loopEnd: number | null;
}

/** A complete saved project. */
export interface Project {
  schemaVersion: number;
  appVersion: string;
  name: string;
  source: SourceInfo;
  analysis: AnalysisInfo;
  /** Stored analysis output; rebuildable from the source and parameters. */
  track: PitchTrack | null;
  edits: EditState;
  /** The state the history replays from: the analysis, plus what no edit recorded. */
  base: EditState;
  /** Bytes of the imported MIDI file, base64. */
  midi: string | null;
  view: ViewState;
  history: History;
}

/** Quality tier of a render. */
export type Quality = 'preview' | 'offline';

/** Shortest blob a boundary edit may produce, in seconds. */
export const MIN_BLOB_SECONDS = 0.01;

/** Project schema version this build reads and writes. */
export const SCHEMA_VERSION = 1;
