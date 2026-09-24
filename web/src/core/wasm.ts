// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The only module that touches the generated wasm-bindgen bindings.
 *
 * Loads the core, converts its JSON to the shapes in `core/types.ts` and turns a thrown
 * `JsValue` into an {@link AxysError}.
 */

import initWasm, {
  analyse,
  coreVersion,
  hzToMidi as rawHzToMidi,
  midiToHz as rawMidiToHz,
  migrateProject as rawMigrateProject,
  parseMidi as rawParseMidi,
  Session as RawSession,
  start as installPanicHook,
} from '../wasm/axys_wasm.js';
import {
  arrayOf,
  isNumber,
  isBlob,
  isClipPlan,
  isDriftReport,
  isEditState,
  isExportPreview,
  isExportReport,
  isGuideOverlap,
  isHistoryLabels,
  isMappingProposal,
  isMappingReport,
  isMediaList,
  isMidiFile,
  isPitchTrack,
  isProject,
  isRenderPlan,
  isTimingConflict,
  nullable,
  parseJson,
  pitchTrackToArrays,
} from './json';
import type { ClipPlan, Guard, HistoryLabels, MediaList } from './json';
import { wasmModuleUrl } from './wasm-url';
import type {
  BitDepth,
  Blob,
  Clip,
  ClipId,
  DriftReport,
  EditOp,
  EditState,
  ExportPreview,
  ExportReport,
  F0Params,
  GuideOverlap,
  MappingProposal,
  MappingReport,
  MidiFile,
  PitchTrackArrays,
  Project,
  ReferenceId,
  RenderPlan,
  SegmentParams,
  SourceInfo,
  TimingConflict,
  ViewState,
} from './types';

export type { ClipPlan, HistoryLabels, MediaList } from './json';

/** A failure raised by the WebAssembly core, carrying the message the core reported. */
export class AxysError extends Error {
  /** What the application was doing when the core failed, for a toast or a log line. */
  readonly operation: string;

  constructor(operation: string, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AxysError';
    this.operation = operation;
  }
}

/** How the core module was turned into a WebAssembly instance. */
export type InstantiationPath = 'streaming' | 'arrayBuffer';

/** What loading the core module cost and which path it took, for the diagnostics panel. */
export interface CoreLoadReport {
  url: string;
  path: InstantiationPath;
  /** `Content-Type` the host served the module with, empty when the host sent none. */
  contentType: string;
  /** Why streaming compilation was abandoned, or `null` when it succeeded. */
  fallbackReason: string | null;
  milliseconds: number;
  version: string;
}

/** Source audio and analysis parameters a new session is built from. */
export interface SessionInput {
  samples: Float32Array;
  sampleRate: number;
  name: string;
  /** Pitch detection parameters; the core's defaults apply when omitted. */
  f0?: F0Params;
  /** Segmentation parameters; the core's defaults apply when omitted. */
  segment?: SegmentParams;
}

/** An analysis a worker has already produced, with the audio it was measured from. */
export interface AnalysedSessionInput {
  samples: Float32Array;
  sampleRate: number;
  name: string;
  /** A `PitchTrack`, as the analysis worker reports it. */
  trackJson: string;
  /** An array of `Blob`, as the analysis worker reports it. */
  blobsJson: string;
  /** Pitch detection parameters the analysis ran with; the core's defaults apply when omitted. */
  f0?: F0Params;
  /** Segmentation parameters the analysis ran with; the core's defaults apply when omitted. */
  segment?: SegmentParams;
}

/** A further analysed vocal to put on the lane of an open session. */
export interface ClipInput extends Omit<AnalysedSessionInput, 'sampleRate'> {
  /** Project seconds the clip is wanted at; an overlapping position lands on the nearest free one. */
  position: number;
  /** Inserts at `position` instead, moving the clips after it later to make room. */
  ripple?: boolean;
  /** Places the clip at `position` over whatever is already there. */
  exact?: boolean;
}

/**
 * What a paste does to what is already there: lands over it, moves what starts after it later by
 * the length pasted, or takes out what is under it first.
 */
export type PasteMode = 'overlap' | 'ripple' | 'replace';

/** A copied part of a clip: the clip as it was copied, and the project span taken from it. */
export interface ClipPart {
  clip: Clip;
  start: number;
  end: number;
}

/** Typed facade over the wasm-bindgen exports. */
export interface AxysCore {
  version: string;
  createSession(input: SessionInput): Session;
  /** Builds a session from an analysis produced elsewhere, without re-analysing the audio. */
  openSessionFromAnalysis(input: AnalysedSessionInput): Session;
  /**
   * Reopens a saved project. Each clip plays and exports once its audio is attached with
   * {@link Session.attachClip}.
   */
  openSession(projectJson: string): Session;
  /** Parses a project document of any supported schema version, in the current one. */
  readProject(json: string): { json: string; project: Project };
  parseMidi(bytes: Uint8Array): MidiFile;
  hzToMidi(hz: number, a4: number): number;
  midiToHz(midi: number, a4: number): number;
}

/** Encoded audio and the peak figures the export produced. */
export interface ExportResult {
  bytes: Uint8Array;
  report: ExportReport;
}

let loading: Promise<AxysCore> | null = null;
let loadReport: CoreLoadReport | null = null;

/** Loads and initialises the WebAssembly core exactly once. */
export function loadCore(): Promise<AxysCore> {
  loading ??= initialise();
  return loading;
}

/** How the core module loaded, or `null` before {@link loadCore} has finished. */
export function coreLoadReport(): CoreLoadReport | null {
  return loadReport;
}

async function initialise(): Promise<AxysCore> {
  const url = wasmModuleUrl();
  const started = now();
  try {
    const compiled = await compileCore(url);
    await initWasm({ module_or_path: compiled.module });
    installPanicHook();
    const version = coreVersion();
    loadReport = {
      url: url.href,
      path: compiled.path,
      contentType: compiled.contentType,
      fallbackReason: compiled.fallbackReason,
      milliseconds: now() - started,
      version,
    };
    return makeCore(version);
  } catch (thrown) {
    loading = null;
    throw asAxysError('Load Core', thrown);
  }
}

interface CompiledCore {
  module: WebAssembly.Module;
  path: InstantiationPath;
  contentType: string;
  fallbackReason: string | null;
}

/**
 * Compiles the core module, preferring streaming compilation.
 *
 * @remarks A host that serves the module as anything but `application/wasm` rejects streaming
 * compilation, so the already buffered response is compiled from an `ArrayBuffer` instead.
 */
async function compileCore(url: URL): Promise<CompiledCore> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new AxysError(
      'Load Core',
      `Download failed (${String(response.status)} ${response.statusText})`,
    );
  }
  const contentType = response.headers.get('content-type') ?? '';
  const buffered = response.clone();

  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      const module = await WebAssembly.compileStreaming(response);
      return { module, path: 'streaming', contentType, fallbackReason: null };
    } catch (thrown) {
      const module = await WebAssembly.compile(await buffered.arrayBuffer());
      return { module, path: 'arrayBuffer', contentType, fallbackReason: messageOf(thrown) };
    }
  }

  const module = await WebAssembly.compile(await buffered.arrayBuffer());
  return {
    module,
    path: 'arrayBuffer',
    contentType,
    fallbackReason: 'this browser has no streaming compilation',
  };
}

function makeCore(version: string): AxysCore {
  return {
    version,
    createSession(input: SessionInput): Session {
      const params = paramsJson(input.f0, input.segment);
      const analysis = call('Analyse Audio', () =>
        analyse(input.samples, input.sampleRate, params),
      );
      try {
        const raw = call('Create Session', () =>
          RawSession.create(input.samples, input.sampleRate, input.name, analysis, params),
        );
        return new Session(raw);
      } finally {
        analysis.free();
      }
    },
    openSessionFromAnalysis(input: AnalysedSessionInput): Session {
      const params = paramsJson(input.f0, input.segment);
      const raw = call('Create Session', () =>
        RawSession.createFromAnalysis(
          input.samples,
          input.sampleRate,
          input.name,
          input.trackJson,
          input.blobsJson,
          params,
        ),
      );
      return new Session(raw);
    },
    openSession(projectJson: string): Session {
      const raw = call('Open Project', () => RawSession.openProject(projectJson));
      return new Session(raw);
    },
    readProject(json: string): { json: string; project: Project } {
      const migrated = call('Open Project', () => rawMigrateProject(json));
      return { json: migrated, project: decode('Open Project', migrated, isProject, 'project') };
    },
    parseMidi(bytes: Uint8Array): MidiFile {
      const json = call('Open MIDI', () => rawParseMidi(bytes));
      return decode('Open MIDI', json, isMidiFile, 'MIDI file');
    },
    hzToMidi(hz: number, a4: number): number {
      return rawHzToMidi(hz, a4);
    },
    midiToHz(midi: number, a4: number): number {
      return rawMidiToHz(midi, a4);
    },
  };
}

/**
 * One editing session over a source vocal.
 *
 * Owns the analysis, the edit state and the undo history in WebAssembly memory. Call
 * {@link Session.free} when finished; every other method throws afterwards.
 */
export class Session {
  readonly #raw: RawSession;
  #freed = false;
  #sampleRate: number | null = null;

  constructor(raw: RawSession) {
    this.#raw = raw;
  }

  /** Applies one operation and recompiles the render plan. */
  applyEdit(op: EditOp): void {
    const json = JSON.stringify(op);
    call('Apply Edit', () => this.#alive().applyEdit(json));
  }

  /** Undoes the newest operation. False when the undo stack is empty. */
  undo(): boolean {
    return call('Undo', () => this.#alive().undo());
  }

  /** Redoes the most recently undone operation. False when the redo stack is empty. */
  redo(): boolean {
    return call('Redo', () => this.#alive().redo());
  }

  /** Everything an edit operation may change. */
  state(): EditState {
    return this.#read('Read State', () => this.#alive().stateJson(), isEditState, 'edit state');
  }

  /**
   * Detected pitch across the lane in project seconds, as parallel arrays.
   *
   * @remarks Unvoiced frames carry `NaN` pitch, and one sits between clips so a line never joins
   * two takes.
   */
  track(): PitchTrackArrays {
    const json = call('Read Track', () => this.#alive().trackJson());
    return pitchTrackToArrays(decode('Read Track', json, isPitchTrack, 'pitch track'));
  }

  /** One clip's detected pitch in its own source seconds, as the core's JSON, for its renderer. */
  clipTrackJson(clip: ClipId): string {
    return call('Read Track', () => this.#alive().clipTrackJson(clip));
  }

  /** One clip's mono source samples at the project rate. A fresh copy each call. */
  clipSamples(clip: ClipId): Float32Array {
    return call('Read Source', () => this.#alive().clipSamples(clip));
  }

  /** Each clip on the lane's own compiled plan and position, in lane order. */
  clipPlans(): ClipPlan[] {
    return this.#read(
      'Read Plan',
      () => this.#alive().clipPlansJson(),
      arrayOf(isClipPlan),
      'clip plans',
    );
  }

  /** Every clip and reference the project can need, and which clips have audio attached. */
  media(): MediaList {
    return this.#read('Read Media', () => this.#alive().mediaJson(), isMediaList, 'media');
  }

  /**
   * Gives a reopened project one clip's audio.
   *
   * @remarks Throws when the audio is not the file the clip was made from.
   */
  attachClip(clip: ClipId, samples: Float32Array): void {
    call('Relink Audio', () => {
      this.#alive().attachClip(clip, samples);
    });
  }

  /**
   * Gives a clip audio the user chose for it, whether or not it is the file it was made from.
   *
   * @remarks `samples` must be exactly as long as the clip's recorded source. The recorded source
   * is kept, so a later relink is still checked against the original.
   */
  relinkClip(clip: ClipId, samples: Float32Array): void {
    call('Relink Audio', () => {
      this.#alive().relinkClip(clip, samples);
    });
  }

  /** Takes a clip's audio away, leaving the clip waiting for a relink. */
  detachClip(clip: ClipId): void {
    call('Relink Audio', () => {
      this.#alive().detachClip(clip);
    });
  }

  /**
   * Pastes copied parts of clips as new clips, as one undoable edit, returning their ids.
   *
   * @remarks Each part is the clip as it was copied and the project span taken from it. The
   * earliest lands at `at`, project seconds, and the rest keep their distance from it.
   */
  pasteClips(parts: readonly ClipPart[], at: number, mode: PasteMode = 'overlap'): ClipId[] {
    const json = JSON.stringify(parts);
    return this.#read(
      'Paste Clips',
      () => this.#alive().pasteClips(json, at, mode),
      arrayOf(isNumber),
      'clip ids',
    );
  }

  /**
   * Takes project spans out of clips on the lane, as one undoable edit.
   *
   * @remarks A span covering a clip removes it, one reaching an end trims it, and one inside it
   * leaves the clip in two.
   */
  cutClips(parts: readonly { clip: ClipId; start: number; end: number }[], ripple = false): void {
    const json = JSON.stringify(parts);
    call('Cut Clips', () => {
      this.#alive().cutClips(json, ripple);
    });
  }

  /**
   * Hands the session a reference's channels at the project rate, so an export can include it.
   *
   * @remarks Copies the channels; the caller keeps its own.
   */
  attachReference(reference: ReferenceId, channels: readonly Float32Array[]): void {
    const frames = channels[0]?.length ?? 0;
    const joined = new Float32Array(frames * channels.length);
    channels.forEach((channel, index) => {
      joined.set(channel.subarray(0, frames), index * frames);
    });
    call('Export WAV', () => {
      this.#alive().attachReference(reference, joined, channels.length);
    });
  }

  /**
   * Puts another analysed vocal on the lane as one undoable edit, returning its clip id.
   *
   * @remarks The samples must be mono at the project rate.
   */
  addClip(input: ClipInput): ClipId {
    const params = paramsJson(input.f0, input.segment);
    return call('Import Clip', () =>
      this.#alive().addClip(
        input.samples,
        input.name,
        input.trackJson,
        input.blobsJson,
        params,
        input.position,
        input.ripple ?? false,
        input.exact ?? false,
      ),
    );
  }

  /**
   * Replaces a clip's analysis, as though it had been imported with the new one.
   *
   * @remarks Refused once an edit touches the clip. The caller reloads the clip's audio in the
   * engine afterwards, since its pitch track has changed.
   */
  reanalyse(
    clip: ClipId,
    input: { trackJson: string; blobsJson: string; f0?: F0Params; segment?: SegmentParams },
  ): void {
    const params = paramsJson(input.f0, input.segment);
    call('Analyse Clip', () =>
      this.#alive().reanalyse(clip, input.trackJson, input.blobsJson, params),
    );
  }

  /** Brings in a reference as one undoable edit, returning its id. */
  addReference(source: SourceInfo, position: number): ReferenceId {
    const json = JSON.stringify(source);
    return call('Import Reference', () => this.#alive().addReference(json, position));
  }

  /**
   * Brings a clip forward and sets whether the editor edits it alone.
   *
   * @remarks `null` is the first clip. {@link Session.blobs}, {@link Session.track} and
   * {@link Session.plan} read the layer this sets.
   */
  setFocus(active: ClipId | null, isolate: boolean): void {
    call('Focus Clip', () => this.#alive().setFocus(active ?? -1, isolate));
  }

  /** The clips of the editor's layer, active clip first. */
  layer(): ClipId[] {
    return this.#read('Read Layer', () => this.#alive().layerJson(), arrayOf(isNumber), 'layer');
  }

  /** One clip's detected pitch in its own source seconds. */
  clipTrack(clip: ClipId): PitchTrackArrays {
    const json = call('Read Track', () => this.#alive().clipTrackJson(clip));
    return pitchTrackToArrays(decode('Read Track', json, isPitchTrack, 'pitch track'));
  }

  /** The blobs of the editor's layer in time order. */
  blobs(): Blob[] {
    return this.#read('Read Blobs', () => this.#alive().blobsJson(), arrayOf(isBlob), 'blobs');
  }

  /** The blobs of every clip outside the editor's layer, in project seconds. */
  otherBlobs(): Blob[] {
    return this.#read('Read Blobs', () => this.#alive().otherBlobsJson(), arrayOf(isBlob), 'blobs');
  }

  /**
   * One plan for the editor's layer in project seconds, for the editor to draw from.
   *
   * @remarks Its time map and target pitch join every clip's; playback reads
   * {@link Session.clipPlans} instead.
   */
  plan(): RenderPlan {
    return this.#read('Read Plan', () => this.#alive().planJson(), isRenderPlan, 'render plan');
  }

  /** Overlaps and gaps produced by timing edits. */
  conflicts(): TimingConflict[] {
    return this.#read(
      'Read Conflicts',
      () => this.#alive().conflictsJson(),
      arrayOf(isTimingConflict),
      'timing conflicts',
    );
  }

  /** Undo and redo labels for the menu. */
  history(): HistoryLabels {
    return this.#read(
      'Read History',
      () => this.#alive().historyJson(),
      isHistoryLabels,
      'history',
    );
  }

  /**
   * Serialises the whole project, including the imported MIDI guide.
   *
   * @remarks The name comes from the edit state rather than from a parameter, because that is
   * where the one copy of it lives.
   */
  project(view: ViewState): string {
    const viewJson = JSON.stringify(view);
    return call('Save Project', () => this.#alive().projectJson(viewJson));
  }

  /**
   * Describes what exporting an output range would produce, without encoding a file.
   *
   * @remarks `range` is in output seconds and `null` covers the whole output. The figures are
   * measured at the source sample rate. `withReferences` measures the export with every attached,
   * unmuted reference mixed in.
   */
  exportPreview(
    range: { start: number; end: number } | null,
    withReferences = false,
  ): ExportPreview {
    const start = range ? Math.max(0, range.start) : 0;
    const end = range ? range.end : -1;
    return this.#read(
      'Export WAV',
      () => this.#alive().exportPreview(start, end, withReferences),
      isExportPreview,
      'export preview',
    );
  }

  /**
   * Renders and encodes the processed audio at export quality.
   *
   * @remarks `range` is in output seconds and `null` exports the whole output. The file keeps the
   * source sample rate unless `sampleRate` asks for another, which the core resamples to.
   * `withReferences` writes stereo with every attached, unmuted reference at its desk level and
   * pan.
   */
  exportWav(
    range: { start: number; end: number } | null,
    depth: BitDepth,
    sampleRate?: number,
    withReferences = false,
  ): ExportResult {
    const start = range ? Math.max(0, range.start) : 0;
    const end = range ? range.end : -1;
    const rate = sampleRate ?? this.sampleRate();
    const bytes = call('Export WAV', () =>
      this.#alive().exportWav(start, end, rate, depth, withReferences),
    );
    const report = this.lastExportReport();
    if (!report) {
      throw new AxysError('Export WAV', 'Encoder returned no peak level');
    }
    return { bytes, report };
  }

  /** Peak and clipping figures from the most recent export, or `null` before any export. */
  lastExportReport(): ExportReport | null {
    return this.#read(
      'Export WAV',
      () => this.#alive().lastExportReport(),
      nullable(isExportReport),
      'export report',
    );
  }

  /** Output length of the lane, in samples. */
  outputFrames(): number {
    return call('Read Plan', () => this.#alive().outputFrames());
  }

  /** Imports a MIDI guide, adopting its tempo and meter maps. */
  loadMidi(bytes: Uint8Array): MidiFile {
    return this.#read('Open MIDI', () => this.#alive().loadMidi(bytes), isMidiFile, 'MIDI file');
  }

  /** The imported MIDI guide, or `null` when none is loaded. */
  midi(): MidiFile | null {
    return this.#read(
      'Read MIDI',
      () => this.#alive().midiJson(),
      nullable(isMidiFile),
      'MIDI file',
    );
  }

  /**
   * Proposes blob-to-note mappings without applying them.
   *
   * @remarks The caller keeps what it wants of the proposal and commits it as a `setMappings`
   * edit of its own, so aligning a selection and previewing an alignment are one undo step.
   */
  proposeMappingsPreview(clips?: readonly ClipId[]): MappingProposal {
    const json = clips === undefined ? undefined : JSON.stringify(clips);
    return this.#read(
      'Align Guide',
      () => this.#alive().proposeMappingsPreview(json),
      isMappingProposal,
      'mapping proposal',
    );
  }

  /** Proposes blob-to-note mappings, keeping manual ones, and returns the report. */
  proposeMappings(): MappingReport {
    return this.#read(
      'Align Guide',
      () => this.#alive().proposeMappings(),
      isMappingReport,
      'mapping report',
    );
  }

  /** Overlapping note pairs in the selected guide, empty when no guide is selected. */
  guideOverlaps(): GuideOverlap[] {
    return this.#read(
      'Read Guide',
      () => this.#alive().guideOverlapsJson(),
      arrayOf(isGuideOverlap),
      'guide overlaps',
    );
  }

  /** Alignment error between mapped blobs and their guide notes, or `null` without a guide. */
  drift(): DriftReport | null {
    return this.#read(
      'Read Drift',
      () => this.#alive().driftJson(),
      nullable(isDriftReport),
      'drift report',
    );
  }

  /** Snaps a source time to the musical grid at `division`. */
  snapSeconds(seconds: number, division: number): number {
    return call('Snap Time', () => this.#alive().snapSeconds(seconds, division));
  }

  /** Source seconds that move the given guide note onto `targetSeconds`. */
  anchorOffset(noteTick: number, targetSeconds: number): number {
    return call('Align Guide', () => this.#alive().anchorOffset(noteTick, targetSeconds));
  }

  /** The project sample rate every clip is held at. */
  sampleRate(): number {
    this.#sampleRate ??= call('Read Source', () => this.#alive().sampleRate());
    return this.#sampleRate;
  }

  /** Releases the session's WebAssembly memory. */
  free(): void {
    if (this.#freed) return;
    this.#freed = true;
    this.#raw.free();
  }

  #alive(): RawSession {
    if (this.#freed) {
      throw new AxysError('Use Session', 'Project is closed');
    }
    return this.#raw;
  }

  #read<T>(operation: string, read: () => string, guard: Guard<T>, label: string): T {
    return decode(operation, call(operation, read), guard, label);
  }
}

function paramsJson(f0: F0Params | undefined, segment: SegmentParams | undefined): string {
  if (!f0 && !segment) return '';
  const params: { f0?: F0Params; segment?: SegmentParams } = {};
  if (f0) params.f0 = f0;
  if (segment) params.segment = segment;
  return JSON.stringify(params);
}

function call<T>(operation: string, run: () => T): T {
  try {
    return run();
  } catch (thrown) {
    throw asAxysError(operation, thrown);
  }
}

function decode<T>(operation: string, json: string, guard: Guard<T>, label: string): T {
  try {
    return parseJson(json, guard, label);
  } catch (thrown) {
    throw asAxysError(operation, thrown);
  }
}

function asAxysError(operation: string, thrown: unknown): AxysError {
  if (thrown instanceof AxysError) return thrown;
  return new AxysError(operation, messageOf(thrown), thrown);
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'object' && thrown !== null && 'message' in thrown) {
    const message: unknown = (thrown as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Unknown error';
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}
