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
  parseMidi as rawParseMidi,
  Session as RawSession,
  start as installPanicHook,
} from '../wasm/axys_wasm.js';
import {
  arrayOf,
  isBarBeat,
  isBeatGridPoint,
  isBlob,
  isDriftReport,
  isEditState,
  isExportPreview,
  isExportReport,
  isGuideOverlap,
  isHistoryLabels,
  isMappingProposal,
  isMappingReport,
  isMidiFile,
  isPitchTrack,
  isProject,
  isRenderPlan,
  isSourceInfo,
  isTimingConflict,
  nullable,
  parseJson,
  pitchTrackToArrays,
} from './json';
import type { Guard, HistoryLabels } from './json';
import { wasmModuleUrl } from './wasm-url';
import type {
  BarBeat,
  BeatGridPoint,
  BitDepth,
  Blob,
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
  RenderPlan,
  SegmentParams,
  SourceInfo,
  TimingConflict,
  ViewState,
} from './types';

export type { HistoryLabels } from './json';

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

/** Typed facade over the wasm-bindgen exports. */
export interface AxysCore {
  version: string;
  createSession(input: SessionInput): Session;
  /** Builds a session from an analysis produced elsewhere, without re-analysing the audio. */
  openSessionFromAnalysis(input: AnalysedSessionInput): Session;
  openSession(projectJson: string, samples: Float32Array): Session;
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
      `the core module could not be read (${String(response.status)} ${response.statusText})`,
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
    openSession(projectJson: string, samples: Float32Array): Session {
      const project = decode('Open Project', projectJson, isProject, 'project');
      const raw = call('Open Project', () =>
        RawSession.openProject(projectJson, samples, project.source.sampleRate),
      );
      return new Session(raw);
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

  /** The detected pitch track as parallel arrays, unvoiced frames carrying `NaN` pitch. */
  track(): PitchTrackArrays {
    const track = decode('Read Track', this.trackJson(), isPitchTrack, 'pitch track');
    return pitchTrackToArrays(track);
  }

  /** The detected pitch track as the core's JSON, for handing to the worklet. */
  trackJson(): string {
    return call('Read Track', () => this.#alive().trackJson());
  }

  /** The current blobs in time order. */
  blobs(): Blob[] {
    return this.#read('Read Blobs', () => this.#alive().blobsJson(), arrayOf(isBlob), 'blobs');
  }

  /** The compiled render plan. */
  plan(): RenderPlan {
    return this.#read('Read Plan', () => this.#alive().planJson(), isRenderPlan, 'render plan');
  }

  /** The compiled render plan as the core's JSON, for handing to the worklet. */
  planJson(): string {
    return call('Read Plan', () => this.#alive().planJson());
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

  /** Serialises the whole project under `name`, including the imported MIDI guide. */
  project(name: string, view: ViewState): string {
    const viewJson = JSON.stringify(view);
    const json = call('Save Project', () => this.#alive().projectJson(viewJson));
    const project = decode('Save Project', json, isProject, 'project');
    if (project.name === name) return json;
    project.name = name;
    return JSON.stringify(project);
  }

  /**
   * Describes what exporting an output range would produce, without encoding a file.
   *
   * @remarks `range` is in output seconds and `null` covers the whole output. The figures are
   * measured at the source sample rate.
   */
  exportPreview(range: { start: number; end: number } | null): ExportPreview {
    const start = range ? Math.max(0, range.start) : 0;
    const end = range ? range.end : -1;
    return this.#read(
      'Export WAV',
      () => this.#alive().exportPreview(start, end),
      isExportPreview,
      'export preview',
    );
  }

  /**
   * Renders and encodes the processed audio at export quality.
   *
   * @remarks `range` is in output seconds and `null` exports the whole output. The file keeps the
   * source sample rate unless `sampleRate` asks for another, which the core resamples to.
   */
  exportWav(
    range: { start: number; end: number } | null,
    depth: BitDepth,
    sampleRate?: number,
  ): ExportResult {
    const start = range ? Math.max(0, range.start) : 0;
    const end = range ? range.end : -1;
    const rate = sampleRate ?? this.sampleRate();
    const bytes = call('Export WAV', () => this.#alive().exportWav(start, end, rate, depth));
    const report = this.lastExportReport();
    if (!report) {
      throw new AxysError('Export WAV', 'the core encoded a file but reported no peak figures');
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

  /** Immutable facts about the imported source audio. */
  sourceInfo(): SourceInfo {
    return this.#read('Read Source', () => this.#alive().sourceJson(), isSourceInfo, 'source');
  }

  /** Mono source samples, for handing to the worklet. */
  source(): Float32Array {
    return call('Read Source', () => this.#alive().source());
  }

  /** Output length of the current plan, in samples. */
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
  proposeMappingsPreview(): MappingProposal {
    return this.#read(
      'Align Guide',
      () => this.#alive().proposeMappingsPreview(),
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

  /** Bar lines and beats in a time window, for the ruler and snapping. */
  beatGrid(from: number, to: number, division: number): BeatGridPoint[] {
    return this.#read(
      'Read Grid',
      () => this.#alive().beatGridJson(from, to, division),
      arrayOf(isBeatGridPoint),
      'beat grid',
    );
  }

  /** Bar and beat reading at a source time. */
  barBeat(seconds: number): BarBeat {
    return this.#read('Read Grid', () => this.#alive().barBeatJson(seconds), isBarBeat, 'bar beat');
  }

  /** Snaps a source time to the musical grid at `division`. */
  snapSeconds(seconds: number, division: number): number {
    return call('Snap Time', () => this.#alive().snapSeconds(seconds, division));
  }

  /** Source seconds that move the given guide note onto `targetSeconds`. */
  anchorOffset(noteTick: number, targetSeconds: number): number {
    return call('Align Guide', () => this.#alive().anchorOffset(noteTick, targetSeconds));
  }

  /** Source sample rate recorded at import. */
  sampleRate(): number {
    this.#sampleRate ??= this.sourceInfo().sampleRate;
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
      throw new AxysError('Use Session', 'this session has been closed');
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
  return 'the core failed without a message';
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}
