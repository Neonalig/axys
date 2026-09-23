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
export type Interp = 'linear' | 'cubic' | 'hold' | 'smooth' | 'release';

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
  /** Which estimator turns audio into pitch candidates; absent is `yin`. */
  method?: F0Method;
  /** YIN's absolute threshold, or pYIN's threshold mean. */
  threshold: number;
  /** SWIPE strength above which a frame is voiced, from -1 to 1. */
  strength?: number;
  /** RMS below which a frame cannot be voiced. */
  voicedRmsFloor: number;
  /** Raises YIN's threshold to suit the clip. */
  autoThreshold?: boolean;
}

/** A pitch estimator: YIN, pYIN or SWIPE. */
export type F0Method = 'yin' | 'pyin' | 'swipe';

/** Every {@link F0Method}, in the order they are offered. */
export const F0_METHODS: readonly F0Method[] = ['yin', 'pyin', 'swipe'];

/** The estimator defaults the core uses, for a first import. */
export const DEFAULT_F0: F0Params = {
  minHz: 65,
  maxHz: 1000,
  frameSeconds: 0.0464,
  hopSeconds: 0.005,
  method: 'yin',
  threshold: 0.15,
  strength: 0.25,
  voicedRmsFloor: 0.0015,
  autoThreshold: true,
};

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
  /** Level applied to the blob in the render, in decibels; 0 leaves it as sung. */
  gainDb: number;
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
  /** Amplitude multiplier indexed by source time; 1 leaves level unchanged. */
  gain: SampledCurve;
  formant: FormantMode;
}

/** A serialisable user intent applied over immutable analysis. */
export type EditOp =
  | { type: 'splitBlob'; blob: BlobId; time: number }
  | { type: 'joinBlobs'; first: BlobId; second: BlobId }
  | { type: 'moveBoundary'; blob: BlobId; edge: Edge; time: number }
  | { type: 'setVoicing'; blob: BlobId; start: number; end: number; voicing: Voicing }
  | { type: 'movePitch'; blobs: BlobId[]; semitones: number; anchors?: boolean }
  | { type: 'setPitchOffset'; blob: BlobId; semitones: number; anchors?: boolean }
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
  | { type: 'setGain'; blob: BlobId; gainDb: number }
  | { type: 'deleteBlobs'; blobs: BlobId[]; keepAudio?: boolean }
  | { type: 'addBlobs'; blobs: Blob[] }
  | { type: 'shiftBlob'; blob: BlobId; seconds: number }
  | { type: 'replacePitch'; blob: BlobId; start: number; end: number; fill: PitchFill }
  | { type: 'trimClip'; clip: ClipId; start: number; end: number }
  | { type: 'addClip'; clip: Clip; ripple?: boolean; exact?: boolean }
  | { type: 'moveClip'; clip: ClipId; position: number; exact?: boolean; ripple?: boolean }
  | { type: 'removeClip'; clip: ClipId }
  | { type: 'addReference'; reference: Reference }
  | { type: 'moveReference'; reference: ReferenceId; position: number }
  | { type: 'removeReference'; reference: ReferenceId }
  | { type: 'renameClip'; clip: ClipId; name: string | null }
  | { type: 'renameReference'; reference: ReferenceId; name: string | null }
  | { type: 'setMixer'; mixer: MixerSettings }
  | { type: 'setScale'; scale: ScaleSettings }
  | { type: 'setTuning'; tuning: Tuning }
  | { type: 'setName'; name: string }
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

/**
 * What a span of a blob sounds after a `replacePitch`.
 *
 * @remarks `contour` is a heard contour in project seconds; `sung` is the blob's own pitch; `flat`
 * is a level line at the span's median detected pitch.
 */
export type PitchFill =
  { kind: 'contour'; anchors: Anchor[] } | { kind: 'sung' } | { kind: 'flat' };

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

/** Stable identifier for a clip within one project. */
export type ClipId = number;

/** Stable identifier for a reference within one project. */
export type ReferenceId = number;

/** A span of source seconds. */
export interface Span {
  start: number;
  end: number;
}

/**
 * One imported vocal placed on the lane.
 *
 * @remarks Its blobs and silenced spans are in the clip's own source seconds; project seconds
 * are those plus `position`. Blobs read from a session are already in project seconds.
 */
export interface Clip {
  id: ClipId;
  source: SourceInfo;
  /** Project seconds at which the clip's source second 0 sits. */
  position: number;
  blobs: BlobSet;
  /** Material deleted with its blobs, rendered as silence. */
  silenced: Span[];
  /** What the clip is called in place of its file's name. */
  name?: string;
  /** The part of the source that is heard, in clip source seconds; absent is all of it. */
  window?: Span;
}

/** Audio heard beside the vocal and never edited or warped. */
export interface Reference {
  id: ReferenceId;
  source: SourceInfo;
  /** Project seconds at which the reference starts. */
  position: number;
  /** What the reference is called in place of its file's name. */
  name?: string;
}

/** What a project keeps about one clip's audio, whether or not the clip is on the lane now. */
export interface ClipMedia {
  clip: ClipId;
  source: SourceInfo;
  analysis: AnalysisInfo;
  /** Stored analysis output; rebuildable from the source and parameters. */
  track: PitchTrack | null;
  /** The analysed segmentation, numbered for the clip. */
  blobs: BlobSet;
}

/** Low bits of a blob id that number blobs within their clip. */
export const CLIP_ID_BITS = 20;

/** The clip a blob belongs to. */
export function clipOf(blob: BlobId): ClipId {
  return Math.floor(blob / 2 ** CLIP_ID_BITS);
}

/** The part of a clip's source that is heard, in its source seconds, held inside the source. */
export function clipWindow(clip: Clip): Span {
  const duration = Math.max(0, clip.source.duration);
  const window = clip.window;
  if (window === undefined) return { start: 0, end: duration };
  const start = Math.min(duration, Math.max(0, window.start));
  return { start, end: Math.min(duration, Math.max(start, window.end)) };
}

/** Project seconds at which a clip starts being heard. */
export function clipStart(clip: Clip): number {
  return clip.position + clipWindow(clip).start;
}

/** Project seconds at which a clip stops being heard. */
export function clipEnd(clip: Clip): number {
  return clip.position + clipWindow(clip).end;
}

/** What a source is called on the desk and over its blobs: its file name without the extension. */
export function sourceTitle(fileName: string): string {
  const trimmed = fileName.trim();
  const dot = trimmed.lastIndexOf('.');
  return dot > 0 ? trimmed.slice(0, dot) : trimmed;
}

/** What a clip or a reference is called on the desk, over its blobs and on its band. */
export function displayTitle(entry: { name?: string; source: { name: string } }): string {
  return entry.name ?? sourceTitle(entry.source.name);
}

/** Parameters and version that produced the stored analysis. */
export interface AnalysisInfo {
  analyserVersion: number;
  f0: F0Params;
  segment: SegmentParams;
}

/** The mutable part of a project: everything an edit operation may change. */
export interface EditState {
  /**
   * What the project is called.
   *
   * @remarks The single source of truth: the tab title, the window titlebar, the save file name
   * and the export default all read it. It lives in the edit state because renaming is an edit
   * like any other, undone and redone with the rest of the history.
   */
  name: string;
  /** Vocal clips on the lane, in the order they were imported. */
  clips: Clip[];
  /** Audio heard beside the vocal. */
  references: Reference[];
  /** Monitor levels for everything the transport plays. */
  mixer: MixerSettings;
  scale: ScaleSettings;
  modulation: ModulationSettings;
  formant: FormantMode;
  timeline: TimelineMap;
  guide: GuideSelection | null;
  mappings: NoteMapping[];
  tuning: Tuning;
  accidentals: AccidentalStyle;
}

/** One audio source on the monitor desk. */
export interface MixerStrip {
  /** Level in decibels; 0 is unity and `MIN_GAIN_DB` is silence. */
  gainDb: number;
  /** Position across the stereo field, -1 hard left to 1 hard right. */
  pan: number;
  mute: boolean;
  /** Silences every strip that is not soloed. */
  solo: boolean;
}

/** A vocal clip's track on the desk: the take as edited and as sung. */
export interface ClipStrips {
  clip: ClipId;
  /** The take as the edits make it sound. */
  processed: MixerStrip;
  /** The take as it was sung, on the same transport clock. */
  original: MixerStrip;
}

/** A reference's strip on the desk. */
export interface ReferenceStrip {
  reference: ReferenceId;
  strip: MixerStrip;
}

/**
 * The monitor desk.
 *
 * @remarks A clip or reference with no entry reads as the strips it starts with; see
 * `audio/mixer.ts`.
 */
export interface MixerSettings {
  clips: ClipStrips[];
  references: ReferenceStrip[];
  /** The metronome. */
  click: MixerStrip;
  /** Everything the desk sends to the output. Only its level and mute apply. */
  master: MixerStrip;
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
  /** The clip in front, which the editor edits; absent is the first clip. */
  activeClip?: ClipId;
  /** How the clips outside the active layer are shown; absent is `show`. */
  others?: OthersView;
}

/**
 * How the clips outside the active layer are shown and reached.
 *
 * @remarks `show` draws them behind the layer, where a click brings one forward. `dim` and `hide`
 * edit the active clip alone, with the others faint or not drawn.
 */
export type OthersView = 'show' | 'dim' | 'hide';

/** Every {@link OthersView}, in the order they are offered. */
export const OTHERS_VIEWS: readonly OthersView[] = ['show', 'dim', 'hide'];

/** A complete saved project. */
export interface Project {
  schemaVersion: number;
  appVersion: string;
  name: string;
  /** The audio and analysis of every clip the project or its history can put on the lane. */
  clips: ClipMedia[];
  /** Every reference the project or its history can bring in. */
  references: Reference[];
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
export const SCHEMA_VERSION = 2;

/** Quietest a blob or a mixer strip may be set to, in decibels. This far down is silence. */
export const MIN_GAIN_DB = -60;

/** Loudest a blob or a mixer strip may be set to, in decibels. */
export const MAX_GAIN_DB = 24;
