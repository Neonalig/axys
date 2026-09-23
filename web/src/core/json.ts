// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runtime validation for JSON crossing the WebAssembly, storage and worker boundaries.
 *
 * A payload that does not match its contract is rejected with an `Error` naming the shape,
 * so a malformed document fails at the boundary instead of becoming a broken object.
 */

import type {
  Anchor,
  AnalysisInfo,
  BarBeat,
  BeatGridPoint,
  Blob,
  BlobSet,
  Clip,
  ClipMedia,
  ClipStrips,
  DriftReport,
  EditOp,
  EditState,
  ExportPreview,
  ExportReport,
  F0Params,
  FormantMode,
  GuideOverlap,
  GuideSelection,
  History,
  MappingProposal,
  MappingReport,
  MeterEvent,
  MidiFile,
  MidiNote,
  MidiTrackInfo,
  MixerSettings,
  MixerStrip,
  ModulationSettings,
  NoteMapping,
  PitchCurve,
  PitchFrame,
  PitchTrack,
  PitchTrackArrays,
  Project,
  Reference,
  ReferenceStrip,
  RenderPlan,
  SampledCurve,
  ScaleSettings,
  SegmentParams,
  SourceInfo,
  Span,
  Subregion,
  TempoEvent,
  TimeMap,
  TimelineMap,
  TimingConflict,
  Tuning,
  ViewState,
} from './types';

/** A predicate that narrows an unknown value to `T`. */
export type Guard<T> = (value: unknown) => value is T;

/** Undo and redo labels reported by the core. */
export interface HistoryLabels {
  undo: string | null;
  redo: string | null;
}

/**
 * Parses JSON and validates it against `guard`.
 *
 * @param text JSON document.
 * @param guard Shape the document must match.
 * @param label Name of the shape, used in the thrown message.
 * @throws Error when the text is not JSON or does not match the shape.
 */
export function parseJson<T>(text: string, guard: Guard<T>, label = 'value'): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Malformed ${label} JSON: ${detail}`, { cause });
  }
  if (!guard(parsed)) {
    throw new Error(`Malformed ${label}: payload does not match its contract`);
  }
  return parsed;
}

/** Builds a guard for an array whose every element matches `guard`. */
export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value: unknown): value is T[] => Array.isArray(value) && value.every(guard);
}

/** Builds a guard accepting `null` alongside `guard`. */
export function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value: unknown): value is T | null => value === null || guard(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNumber);
}

function isLiteral<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

const INTERPS = ['linear', 'cubic', 'hold', 'smooth'] as const;
const VOICINGS = ['voiced', 'unvoiced', 'silence'] as const;
const EDGES = ['start', 'end'] as const;
const CONFLICT_KINDS = ['overlap', 'gap'] as const;
const GUIDE_MODES = ['visualOnly', 'pitchOnly', 'timingOnly', 'combined'] as const;
const TIME_DISPLAYS = ['seconds', 'barsBeats'] as const;
const OTHERS_VIEWS = ['show', 'dim', 'hide'] as const;
const ACCIDENTAL_STYLES = ['sharps', 'flats'] as const;

/** Accepts one curve anchor. */
export function isAnchor(value: unknown): value is Anchor {
  return (
    isRecord(value) &&
    isNumber(value.time) &&
    isNumber(value.midi) &&
    isLiteral(INTERPS, value.interp)
  );
}

function isPitchCurve(value: unknown): value is PitchCurve {
  return isRecord(value) && Array.isArray(value.anchors) && value.anchors.every(isAnchor);
}

function isSubregion(value: unknown): value is Subregion {
  return (
    isRecord(value) &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isLiteral(VOICINGS, value.voicing)
  );
}

/** Accepts one blob. */
export function isBlob(value: unknown): value is Blob {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isNumber(value.detectedCenter) &&
    isNumber(value.pitchOffset) &&
    isNumber(value.timeOffset) &&
    isNumber(value.timeScale) &&
    Array.isArray(value.subregions) &&
    value.subregions.every(isSubregion) &&
    isPitchCurve(value.curve) &&
    isBoolean(value.excluded) &&
    // Absent in a document written before blobs carried a level, which the core fills in with
    // silence-free unity rather than refusing. Refusing here would be stricter than the thing
    // this file mirrors.
    (value.gainDb === undefined || isNumber(value.gainDb))
  );
}

/** Accepts an ordered blob set. */
export function isBlobSet(value: unknown): value is BlobSet {
  return (
    isRecord(value) &&
    Array.isArray(value.blobs) &&
    value.blobs.every(isBlob) &&
    isNumber(value.nextId)
  );
}

/** Accepts one timing conflict. */
export function isTimingConflict(value: unknown): value is TimingConflict {
  return (
    isRecord(value) &&
    isNumber(value.first) &&
    isNumber(value.second) &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isLiteral(CONFLICT_KINDS, value.kind)
  );
}

function isPitchFrame(value: unknown): value is PitchFrame {
  return (
    isRecord(value) &&
    isNumber(value.time) &&
    isNumber(value.f0) &&
    isNullableNumber(value.midi) &&
    isNumber(value.confidence) &&
    isNumber(value.rms) &&
    isBoolean(value.voiced)
  );
}

/** Accepts a detected pitch track. */
export function isPitchTrack(value: unknown): value is PitchTrack {
  return (
    isRecord(value) &&
    isNumber(value.sampleRate) &&
    isNumber(value.hopSeconds) &&
    Array.isArray(value.frames) &&
    value.frames.every(isPitchFrame)
  );
}

/** Flattens a pitch track into parallel arrays, with NaN where the frame is unvoiced. */
export function pitchTrackToArrays(track: PitchTrack): PitchTrackArrays {
  const frames = track.frames;
  return {
    times: Float32Array.from(frames, (frame) => frame.time),
    midi: Float32Array.from(frames, (frame) => frame.midi ?? Number.NaN),
    confidence: Float32Array.from(frames, (frame) => frame.confidence),
    rms: Float32Array.from(frames, (frame) => frame.rms),
  };
}

function isF0Params(value: unknown): value is F0Params {
  return (
    isRecord(value) &&
    isNumber(value.minHz) &&
    isNumber(value.maxHz) &&
    isNumber(value.frameSeconds) &&
    isNumber(value.hopSeconds) &&
    isNumber(value.threshold) &&
    isNumber(value.voicedRmsFloor)
  );
}

function isSegmentParams(value: unknown): value is SegmentParams {
  return (
    isRecord(value) &&
    isNumber(value.minBlobSeconds) &&
    isNumber(value.minSilenceSeconds) &&
    isNumber(value.pitchChangeSemitones) &&
    isNumber(value.pitchHoldSeconds) &&
    isNumber(value.onsetThreshold) &&
    isBoolean(value.attachConsonants)
  );
}

function isAnalysisInfo(value: unknown): value is AnalysisInfo {
  return (
    isRecord(value) &&
    isNumber(value.analyserVersion) &&
    isF0Params(value.f0) &&
    isSegmentParams(value.segment)
  );
}

/** Accepts one tempo event. */
export function isTempoEvent(value: unknown): value is TempoEvent {
  return isRecord(value) && isNumber(value.tick) && isNumber(value.microsPerQuarter);
}

/** Accepts one meter event. */
export function isMeterEvent(value: unknown): value is MeterEvent {
  return (
    isRecord(value) &&
    isNumber(value.tick) &&
    isNumber(value.numerator) &&
    isNumber(value.denominator)
  );
}

/** Accepts a bar and beat reading. */
export function isBarBeat(value: unknown): value is BarBeat {
  return (
    isRecord(value) &&
    isNumber(value.bar) &&
    isNumber(value.beat) &&
    isNumber(value.beatsInBar) &&
    isNumber(value.beatUnit)
  );
}

/** Accepts one beat-grid entry. */
export function isBeatGridPoint(value: unknown): value is BeatGridPoint {
  return (
    isRecord(value) &&
    isNumber(value.seconds) &&
    isNumber(value.tick) &&
    isNumber(value.bar) &&
    isNumber(value.beat) &&
    isBoolean(value.isBarLine) &&
    isBoolean(value.isBeat)
  );
}

/** Accepts a timeline map. */
export function isTimelineMap(value: unknown): value is TimelineMap {
  return (
    isRecord(value) &&
    isNumber(value.ppq) &&
    Array.isArray(value.tempo) &&
    value.tempo.every(isTempoEvent) &&
    Array.isArray(value.meter) &&
    value.meter.every(isMeterEvent) &&
    isNumber(value.originSeconds) &&
    isNumber(value.sampleRate)
  );
}

function isMidiNote(value: unknown): value is MidiNote {
  return (
    isRecord(value) &&
    isNumber(value.track) &&
    isNumber(value.channel) &&
    isNumber(value.key) &&
    isNumber(value.velocity) &&
    isNumber(value.startTick) &&
    isNumber(value.endTick)
  );
}

function isMidiTrackInfo(value: unknown): value is MidiTrackInfo {
  return (
    isRecord(value) &&
    isNumber(value.index) &&
    isNullableString(value.name) &&
    isNullableString(value.instrument) &&
    isNumberArray(value.channels) &&
    isNumber(value.noteCount) &&
    isBoolean(value.isPercussion) &&
    isNumber(value.firstTick) &&
    isNumber(value.lastTick)
  );
}

/** Accepts a parsed Standard MIDI File. */
export function isMidiFile(value: unknown): value is MidiFile {
  return (
    isRecord(value) &&
    isNumber(value.format) &&
    isNumber(value.ppq) &&
    Array.isArray(value.tracks) &&
    value.tracks.every(isMidiTrackInfo) &&
    Array.isArray(value.notes) &&
    value.notes.every(isMidiNote) &&
    Array.isArray(value.tempo) &&
    value.tempo.every(isTempoEvent) &&
    Array.isArray(value.meter) &&
    value.meter.every(isMeterEvent)
  );
}

/** Accepts a MIDI guide selection. */
export function isGuideSelection(value: unknown): value is GuideSelection {
  return (
    isRecord(value) &&
    isNumber(value.track) &&
    isNullableNumber(value.channel) &&
    isLiteral(GUIDE_MODES, value.mode) &&
    isNumber(value.strength) &&
    isBoolean(value.muted)
  );
}

/** Accepts one blob-to-note mapping. */
export function isNoteMapping(value: unknown): value is NoteMapping {
  return (
    isRecord(value) &&
    isNumber(value.blob) &&
    isNullableNumber(value.note) &&
    isBoolean(value.manual) &&
    isBoolean(value.optedOut)
  );
}

/** Accepts a mapping proposal report. */
export function isMappingReport(value: unknown): value is MappingReport {
  return (
    isRecord(value) &&
    isNumberArray(value.unmappedBlobs) &&
    isNumberArray(value.unmappedNotes) &&
    isNumberArray(value.multiplyMappedNotes) &&
    isNumberArray(value.overlappingNotes)
  );
}

/** Accepts a mapping proposal: the mappings and the report over them. */
export function isMappingProposal(value: unknown): value is MappingProposal {
  return (
    isRecord(value) &&
    Array.isArray(value.mappings) &&
    value.mappings.every(isNoteMapping) &&
    isMappingReport(value.report)
  );
}

/** Accepts a pair of overlapping guide notes. */
export function isGuideOverlap(value: unknown): value is GuideOverlap {
  return (
    isRecord(value) &&
    isNumber(value.first) &&
    isNumber(value.second) &&
    isNumber(value.firstKey) &&
    isNumber(value.secondKey) &&
    isNumber(value.startSeconds) &&
    isNumber(value.endSeconds)
  );
}

/** Accepts a guide alignment report. */
export function isDriftReport(value: unknown): value is DriftReport {
  return (
    isRecord(value) &&
    isNumber(value.earlyErrorSeconds) &&
    isNumber(value.lateErrorSeconds) &&
    isNumber(value.offsetSeconds) &&
    isNumber(value.driftSecondsPerSecond) &&
    isNumber(value.pairsCompared)
  );
}

function isSampledCurve(value: unknown): value is SampledCurve {
  return (
    isRecord(value) && isNumber(value.start) && isNumber(value.hop) && isNumberArray(value.values)
  );
}

function isTimePoint(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber);
}

function isTimeMap(value: unknown): value is TimeMap {
  return isRecord(value) && Array.isArray(value.points) && value.points.every(isTimePoint);
}

/** Accepts a formant mode, either a named mode or a semitone shift. */
export function isFormantMode(value: unknown): value is FormantMode {
  if (value === 'follow' || value === 'preserve') {
    return true;
  }
  return isRecord(value) && isNumber(value.shift);
}

/** Accepts scale-correction settings. */
export function isScaleSettings(value: unknown): value is ScaleSettings {
  return (
    isRecord(value) &&
    isNumber(value.root) &&
    isNumberArray(value.degrees) &&
    isNumber(value.strength) &&
    isNumberArray(value.excluded)
  );
}

/** Accepts modulation settings. */
export function isModulationSettings(value: unknown): value is ModulationSettings {
  return (
    isRecord(value) &&
    isNumber(value.drift) &&
    isNumber(value.vibratoDepth) &&
    isNumber(value.vibratoSplitHz)
  );
}

/** Accepts a compiled render plan. */
export function isRenderPlan(value: unknown): value is RenderPlan {
  return (
    isRecord(value) &&
    isNumber(value.sampleRate) &&
    isTimeMap(value.timeMap) &&
    isSampledCurve(value.pitchRatio) &&
    isSampledCurve(value.targetMidi) &&
    isSampledCurve(value.gain) &&
    isFormantMode(value.formant)
  );
}

const EDIT_OP_FIELDS: Record<string, (op: Record<string, unknown>) => boolean> = {
  splitBlob: (op) => isNumber(op.blob) && isNumber(op.time),
  joinBlobs: (op) => isNumber(op.first) && isNumber(op.second),
  moveBoundary: (op) => isNumber(op.blob) && isLiteral(EDGES, op.edge) && isNumber(op.time),
  setVoicing: (op) =>
    isNumber(op.blob) && isNumber(op.start) && isNumber(op.end) && isLiteral(VOICINGS, op.voicing),
  movePitch: (op) => isNumberArray(op.blobs) && isNumber(op.semitones),
  setPitchOffset: (op) => isNumber(op.blob) && isNumber(op.semitones),
  moveTime: (op) => isNumberArray(op.blobs) && isNumber(op.seconds),
  setTimeScale: (op) => isNumber(op.blob) && isNumber(op.scale),
  addAnchor: (op) => isNumber(op.blob) && isAnchor(op.anchor),
  moveAnchor: (op) =>
    isNumber(op.blob) && isNumber(op.index) && isNumber(op.time) && isNumber(op.midi),
  removeAnchor: (op) => isNumber(op.blob) && isNumber(op.index),
  drawSpan: (op) => isNumber(op.blob) && Array.isArray(op.anchors) && op.anchors.every(isAnchor),
  smoothSpan: (op) =>
    isNumber(op.blob) && isNumber(op.start) && isNumber(op.end) && isNumber(op.amount),
  resetSpan: (op) => isNumber(op.blob) && isNumber(op.start) && isNumber(op.end),
  resetBlob: (op) => isNumber(op.blob),
  resetRange: (op) => isNumber(op.start) && isNumber(op.end),
  setExcluded: (op) => isNumber(op.blob) && isBoolean(op.excluded),
  setGain: (op) => isNumber(op.blob) && isNumber(op.gainDb),
  deleteBlobs: (op) => isNumberArray(op.blobs),
  addClip: (op) => isClip(op.clip),
  moveClip: (op) => isNumber(op.clip) && isNumber(op.position),
  removeClip: (op) => isNumber(op.clip),
  addReference: (op) => isReference(op.reference),
  moveReference: (op) => isNumber(op.reference) && isNumber(op.position),
  removeReference: (op) => isNumber(op.reference),
  renameClip: (op) => isNumber(op.clip) && (op.name === null || isString(op.name)),
  renameReference: (op) => isNumber(op.reference) && (op.name === null || isString(op.name)),
  setMixer: (op) => isMixerSettings(op.mixer),
  setScale: (op) => isScaleSettings(op.scale),
  setTuning: (op) => isTuning(op.tuning),
  setAccidentals: (op) => isLiteral(ACCIDENTAL_STYLES, op.accidentals),
  setModulation: (op) => isModulationSettings(op.modulation),
  setFormant: (op) => isFormantMode(op.formant),
  setGuide: (op) => op.selection === null || isGuideSelection(op.selection),
  setMapping: (op) => isNoteMapping(op.mapping),
  setMappings: (op) => Array.isArray(op.mappings) && op.mappings.every(isNoteMapping),
  setTimelineOrigin: (op) => isNumber(op.seconds),
  setTempoMap: (op) => Array.isArray(op.events) && op.events.every(isTempoEvent),
  setMeterMap: (op) => Array.isArray(op.events) && op.events.every(isMeterEvent),
  group: (op) => Array.isArray(op.ops) && op.ops.every(isEditOp),
};

/** Accepts one edit operation of the tagged union. */
export function isEditOp(value: unknown): value is EditOp {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  const fields = EDIT_OP_FIELDS[value.type];
  return fields !== undefined && fields(value);
}

/** Accepts an undo and redo history. */
export function isHistory(value: unknown): value is History {
  return (
    isRecord(value) &&
    Array.isArray(value.applied) &&
    value.applied.every(isEditOp) &&
    Array.isArray(value.undone) &&
    value.undone.every(isEditOp)
  );
}

/** Accepts the undo and redo labels reported by the core. */
export function isHistoryLabels(value: unknown): value is HistoryLabels {
  return isRecord(value) && isNullableString(value.undo) && isNullableString(value.redo);
}

/** Accepts an export report. */
export function isExportReport(value: unknown): value is ExportReport {
  return (
    isRecord(value) &&
    isNumber(value.frames) &&
    isNumber(value.peak) &&
    isNumber(value.clippedSamples)
  );
}

/** Accepts an export preview. */
export function isExportPreview(value: unknown): value is ExportPreview {
  return (
    isRecord(value) &&
    isNumber(value.start) &&
    isNumber(value.end) &&
    isNumber(value.frames) &&
    isNumber(value.duration) &&
    isNumber(value.peak) &&
    isBoolean(value.clips) &&
    isNumber(value.conflicts) &&
    isNumber(value.silent)
  );
}

/** Accepts the immutable facts about imported source audio. */
export function isSourceInfo(value: unknown): value is SourceInfo {
  return (
    isRecord(value) &&
    isString(value.name) &&
    isNumber(value.sampleRate) &&
    isNumber(value.channels) &&
    isNumber(value.frames) &&
    isNumber(value.duration) &&
    isString(value.fingerprint) &&
    isNullableString(value.mime)
  );
}

function isTuning(value: unknown): value is Tuning {
  return isRecord(value) && isNumber(value.a4Hz);
}

function isMixerStrip(value: unknown): value is MixerStrip {
  return (
    isRecord(value) &&
    isNumber(value.gainDb) &&
    isNumber(value.pan) &&
    isBoolean(value.mute) &&
    isBoolean(value.solo)
  );
}

function isClipStrips(value: unknown): value is ClipStrips {
  return (
    isRecord(value) &&
    isNumber(value.clip) &&
    isMixerStrip(value.processed) &&
    isMixerStrip(value.original)
  );
}

function isReferenceStrip(value: unknown): value is ReferenceStrip {
  return isRecord(value) && isNumber(value.reference) && isMixerStrip(value.strip);
}

/** Accepts the monitor desk. */
export function isMixerSettings(value: unknown): value is MixerSettings {
  return (
    isRecord(value) &&
    Array.isArray(value.clips) &&
    value.clips.every(isClipStrips) &&
    Array.isArray(value.references) &&
    value.references.every(isReferenceStrip) &&
    isMixerStrip(value.click) &&
    isMixerStrip(value.master)
  );
}

function isSpan(value: unknown): value is Span {
  return isRecord(value) && isNumber(value.start) && isNumber(value.end);
}

/** Accepts one clip on the lane. */
export function isClip(value: unknown): value is Clip {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    isSourceInfo(value.source) &&
    isNumber(value.position) &&
    isBlobSet(value.blobs) &&
    Array.isArray(value.silenced) &&
    value.silenced.every(isSpan) &&
    (value.name === undefined || isString(value.name))
  );
}

/** Accepts one reference. */
export function isReference(value: unknown): value is Reference {
  return (
    isRecord(value) &&
    isNumber(value.id) &&
    isSourceInfo(value.source) &&
    isNumber(value.position) &&
    (value.name === undefined || isString(value.name))
  );
}

function isClipMedia(value: unknown): value is ClipMedia {
  return (
    isRecord(value) &&
    isNumber(value.clip) &&
    isSourceInfo(value.source) &&
    isAnalysisInfo(value.analysis) &&
    (value.track === null || isPitchTrack(value.track)) &&
    isBlobSet(value.blobs)
  );
}

/** One clip's compiled plan and where the clip sits, as the worklet and the export read it. */
export interface ClipPlan {
  clip: number;
  /** Project seconds at which the clip's output second 0 sits. */
  position: number;
  plan: RenderPlan;
}

/** Accepts one clip's placed plan. */
export function isClipPlan(value: unknown): value is ClipPlan {
  return (
    isRecord(value) && isNumber(value.clip) && isNumber(value.position) && isRenderPlan(value.plan)
  );
}

/** Audio a project needs from the device, and which clips have theirs. */
export interface MediaList {
  clips: { clip: number; source: SourceInfo; attached: boolean }[];
  references: Reference[];
}

/** Accepts a session's media list. */
export function isMediaList(value: unknown): value is MediaList {
  return (
    isRecord(value) &&
    Array.isArray(value.clips) &&
    value.clips.every(
      (entry) =>
        isRecord(entry) &&
        isNumber(entry.clip) &&
        isSourceInfo(entry.source) &&
        isBoolean(entry.attached),
    ) &&
    Array.isArray(value.references) &&
    value.references.every(isReference)
  );
}

/** Accepts the mutable part of a project. */
export function isEditState(value: unknown): value is EditState {
  return (
    isRecord(value) &&
    Array.isArray(value.clips) &&
    value.clips.every(isClip) &&
    Array.isArray(value.references) &&
    value.references.every(isReference) &&
    isMixerSettings(value.mixer) &&
    isScaleSettings(value.scale) &&
    isModulationSettings(value.modulation) &&
    isFormantMode(value.formant) &&
    isTimelineMap(value.timeline) &&
    (value.guide === null || isGuideSelection(value.guide)) &&
    Array.isArray(value.mappings) &&
    value.mappings.every(isNoteMapping) &&
    isTuning(value.tuning) &&
    isLiteral(ACCIDENTAL_STYLES, value.accidentals)
  );
}

/** Accepts saved editor view state. */
export function isViewState(value: unknown): value is ViewState {
  return (
    isRecord(value) &&
    isNumber(value.visibleStart) &&
    isNumber(value.visibleEnd) &&
    isNumber(value.lowMidi) &&
    isNumber(value.highMidi) &&
    isLiteral(TIME_DISPLAYS, value.timeDisplay) &&
    isNumber(value.snapDivision) &&
    isNumber(value.playhead) &&
    isNullableNumber(value.loopStart) &&
    isNullableNumber(value.loopEnd) &&
    (value.activeClip === undefined || isNumber(value.activeClip)) &&
    (value.others === undefined || isLiteral(OTHERS_VIEWS, value.others))
  );
}

/** Accepts a complete saved project. */
export function isProject(value: unknown): value is Project {
  return (
    isRecord(value) &&
    isNumber(value.schemaVersion) &&
    isString(value.appVersion) &&
    isString(value.name) &&
    Array.isArray(value.clips) &&
    value.clips.every(isClipMedia) &&
    Array.isArray(value.references) &&
    value.references.every(isReference) &&
    isEditState(value.edits) &&
    isEditState(value.base) &&
    isNullableString(value.midi) &&
    isViewState(value.view) &&
    isHistory(value.history)
  );
}
