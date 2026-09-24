// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Message contract shared by the analysis, span and render workers and the clients that drive them.
 *
 * Every request carries an id; every response quotes it, so several jobs may be in flight on one
 * worker and a late reply to a cancelled job is recognisable. Large buffers travel as transfers,
 * and a worker hands a caller's buffer back in the result so nothing is lost to the transfer.
 */

import type { BitDepth, ExportReport, F0Params, SegmentParams } from '../core/types';

/** Correlates a request with the responses it produces. */
export type RequestId = number;

/** Frames the render worker produces between progress reports and cancellation checks. */
export const RENDER_CHUNK_FRAMES = 1 << 16;

/** Where the analysis worker has reached. */
export type AnalysisStage = 'Load Engine' | 'Analyse Audio' | 'Read Pitch' | 'Read Blobs';

/** Where the decode worker has reached. */
export type DecodeStage = 'Load Engine' | 'Decode Audio' | 'Resample Audio';

/** Where the render worker has reached. */
export type RenderStage = 'Load Engine' | 'Prepare Render' | 'Render Audio' | 'Encode WAV';

/** Analyses one mono source buffer into pitch, energy and provisional blobs. */
export interface AnalyseRequest {
  type: 'analyse';
  id: RequestId;
  samples: Float32Array;
  sampleRate: number;
  name: string;
  /** Pitch detection parameters; the core's defaults apply when omitted. */
  f0?: F0Params;
  /** Segmentation parameters; the core's defaults apply when omitted. */
  segment?: SegmentParams;
}

/** Decodes one media file in the core, the same way in every browser. */
export interface DecodeRequest {
  type: 'decode';
  id: RequestId;
  bytes: ArrayBuffer;
  /** The file's extension without the dot, or empty. */
  extension: string;
  /** Rate to hand the audio back at, or `null` for the file's own. */
  sampleRate: number | null;
}

/** Audio the decode worker produced. */
export interface DecodedAudio {
  sampleRate: number;
  /** Rate the file declared. */
  declaredRate: number;
  frames: number;
  channels: Float32Array[];
  mono: Float32Array;
  fingerprint: string;
}

/** Everything the decode worker accepts. */
export type DecodeWorkerRequest = DecodeRequest | CancelRequest | WarmRequest;

/** Abandons the job with the given id as soon as the worker reaches a checkpoint. */
export interface CancelRequest {
  type: 'cancel';
  id: RequestId;
}

/**
 * Asks a worker to load everything it will need now, while the server can still be reached.
 *
 * @remarks A worker otherwise fetches its core on its first job, which fails once the page has
 * gone offline. Answered with nothing.
 */
export interface WarmRequest {
  type: 'warm';
}

/** Everything the analysis worker accepts. */
export type AnalysisRequest = AnalyseRequest | CancelRequest | WarmRequest;

/**
 * Everything one analysis produced.
 *
 * @remarks `midi` carries `NaN` on an unvoiced frame. `samples` is the caller's own buffer,
 * transferred back so the caller keeps its source audio.
 */
export interface AnalysisResult {
  trackJson: string;
  energyJson: string;
  blobsJson: string;
  /** The voicing threshold decoding used, raised from the one asked for by Auto Threshold. */
  threshold: number;
  times: Float32Array;
  midi: Float32Array;
  confidence: Float32Array;
  rms: Float32Array;
  samples: Float32Array;
  sampleRate: number;
  name: string;
}

/** Measures pitch candidates and energy for one span of an analysis's frames. */
export interface ObserveSpanRequest {
  type: 'observeSpan';
  id: RequestId;
  /** Source samples from `offset`, covering every sample the span's frames read. */
  window: Float32Array;
  offset: number;
  /** Samples in the whole source buffer. */
  len: number;
  sampleRate: number;
  /** The core's analysis parameter document. */
  paramsJson: string;
  /** First frame of the span. */
  first: number;
  /** One past the last frame of the span. */
  end: number;
}

/**
 * Pitch candidates and energy for a span of frames, as the core's flat arrays.
 *
 * @remarks `counts` holds the pitch candidates per frame; `freq`, `dprime` and `cost` hold every
 * frame's candidates back to back. `rms` is per pitch window and `energyRms` per energy window.
 * `unvoiced` is each frame's unvoiced cost, negative where the threshold sets it.
 * `flux` is not yet normalised over the whole take.
 */
export interface SpanMeasures {
  freq: Float64Array;
  dprime: Float64Array;
  cost: Float64Array;
  counts: Uint32Array;
  rms: Float32Array;
  unvoiced: Float64Array;
  energyRms: Float32Array;
  flux: Float32Array;
  zcr: Float32Array;
}

/** A finished span. */
export interface ObservedMessage {
  type: 'observed';
  id: RequestId;
  measures: SpanMeasures;
}

/** Renders a span of the plan's output at offline quality. */
export interface RenderRangeRequest {
  type: 'renderRange';
  id: RequestId;
  samples: Float32Array;
  trackJson: string;
  planJson: string;
  /** First output frame to render. */
  startFrame: number;
  /** One past the last output frame, or `null` for the whole output. */
  endFrame: number | null;
  sampleRate: number;
}

/** Renders and encodes a saved project to a WAV file at export quality. */
export interface ExportWavRequest {
  type: 'exportWav';
  id: RequestId;
  projectJson: string;
  /** Every clip's mono samples at the project rate, keyed by clip id. */
  clips: ClipAudio[];
  /** Every reference's channels at the project rate, used when `withReferences` is set. */
  references: ReferenceAudio[];
  /** Whether the file mixes the references in, which makes it stereo. */
  withReferences: boolean;
  /** Output seconds to encode, or `null` for the whole output. */
  range: { start: number; end: number } | null;
  depth: BitDepth;
  /** Rate to write the file at; the core resamples when it differs from the source rate. */
  sampleRate: number;
}

/** One clip's mono samples, keyed by the clip they belong to. */
export interface ClipAudio {
  clip: number;
  samples: Float32Array;
}

/** One reference's channels, keyed by the reference they belong to. */
export interface ReferenceAudio {
  reference: number;
  channels: Float32Array[];
}

/** Everything the render worker accepts. */
export type RenderRequest = RenderRangeRequest | ExportWavRequest | CancelRequest | WarmRequest;

/** Rendered output and where it sits in the plan's output timeline. */
export interface RenderedRange {
  samples: Float32Array;
  startFrame: number;
  /** Total output length of the plan, in frames. */
  outputFrames: number;
  sampleRate: number;
  /** The caller's source buffer, transferred back. */
  source: Float32Array;
}

/** An encoded WAV file and what the export produced. */
export interface EncodedWav {
  bytes: Uint8Array;
  report: ExportReport;
}

/** How far a job has got. */
export interface ProgressMessage<S extends string> {
  type: 'progress';
  id: RequestId;
  stage: S;
  /** Completed fraction, 0 to 1. */
  progress: number;
}

/** A finished analysis. */
export interface AnalysedMessage {
  type: 'analysed';
  id: RequestId;
  result: AnalysisResult;
}

/** A finished decode. */
export interface DecodedMessage {
  type: 'decoded';
  id: RequestId;
  result: DecodedAudio;
}

/** A finished render. */
export interface RenderedMessage {
  type: 'rendered';
  id: RequestId;
  result: RenderedRange;
}

/** A finished export. */
export interface EncodedMessage {
  type: 'encoded';
  id: RequestId;
  result: EncodedWav;
}

/** A job that failed, reported in place of a throw nobody would catch. */
export interface FailedMessage {
  type: 'failed';
  id: RequestId;
  /** What the worker was doing, for a toast headline. */
  operation: string;
  message: string;
}

/** A job abandoned at the caller's request. */
export interface CancelledMessage {
  type: 'cancelled';
  id: RequestId;
}

/** Everything the analysis worker posts back. */
export type AnalysisResponse =
  ProgressMessage<AnalysisStage> | AnalysedMessage | FailedMessage | CancelledMessage;

/** Everything the decode worker posts back. */
export type DecodeResponse =
  ProgressMessage<DecodeStage> | DecodedMessage | FailedMessage | CancelledMessage;

/** Everything a span worker posts back. */
export type SpanResponse = ObservedMessage | FailedMessage;

/** Everything the render worker posts back. */
export type RenderResponse =
  | ProgressMessage<RenderStage>
  | RenderedMessage
  | EncodedMessage
  | FailedMessage
  | CancelledMessage;

/** Raised in place of a result when a job was cancelled. */
export class WorkerCancelled extends Error {
  /** What the cancelled job was, for a log line. */
  readonly operation: string;

  constructor(operation: string) {
    super(`${operation} was cancelled`);
    this.name = 'WorkerCancelled';
    this.operation = operation;
  }
}

/** Raised in place of a result when a worker stopped reporting and was taken down. */
export class WorkerStalled extends Error {
  /** What the stalled job was, for a log line. */
  readonly operation: string;

  constructor(operation: string) {
    super(`${operation} stopped responding`);
    this.name = 'WorkerStalled';
    this.operation = operation;
  }
}

/** Buffers to transfer alongside an {@link AnalysisResult}. */
export function analysisTransfers(result: AnalysisResult): Transferable[] {
  return [result.times, result.midi, result.confidence, result.rms, result.samples].map(bufferOf);
}

/** Buffers to transfer alongside {@link DecodedAudio}. */
export function decodedTransfers(result: DecodedAudio): Transferable[] {
  return [...result.channels, result.mono].map(bufferOf);
}

/** Buffers to transfer alongside {@link SpanMeasures}. */
export function measureTransfers(measures: SpanMeasures): Transferable[] {
  return Object.values(measures).map(bufferOf);
}

/** Buffers to transfer alongside a {@link RenderedRange}. */
export function renderedTransfers(result: RenderedRange): Transferable[] {
  return [bufferOf(result.samples), bufferOf(result.source)];
}

/** Buffers to transfer alongside an {@link EncodedWav}. */
export function encodedTransfers(result: EncodedWav): Transferable[] {
  return [bufferOf(result.bytes)];
}

/**
 * The transferable buffer behind a view.
 *
 * @remarks A view over a `SharedArrayBuffer` cannot be transferred, so it is rejected rather
 * than silently copied.
 */
export function bufferOf(view: ArrayBufferView): ArrayBuffer {
  const { buffer } = view;
  if (buffer instanceof ArrayBuffer) return buffer;
  throw new TypeError('a shared buffer cannot be transferred');
}
