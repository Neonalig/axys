// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Main-thread handles for the analysis and render workers.
 *
 * Each client owns one worker, starts it on first use and turns the message protocol into
 * promises with progress callbacks. A cancelled job rejects with {@link WorkerCancelled} and a
 * failed one with {@link AxysError}, so a caller distinguishes the two without inspecting text.
 */

import type { BitDepth, F0Params, SegmentParams } from '../core/types';
import { AxysError } from '../core/wasm';
import { bufferOf, WorkerCancelled, WorkerStalled } from './protocol';
import type {
  AnalyseRequest,
  AnalysedMessage,
  DecodeRequest,
  AnalysisResult,
  CancelRequest,
  CancelledMessage,
  DecodedAudio,
  DecodedMessage,
  EncodedMessage,
  ClipAudio,
  EncodedWav,
  ExportWavRequest,
  FailedMessage,
  ProgressMessage,
  ReferenceAudio,
  RenderRangeRequest,
  RenderedMessage,
  RenderedRange,
  RequestId,
  WarmRequest,
} from './protocol';

/** Receives a worker's stage name and its completed fraction, 0 to 1. */
export type ProgressListener = (stage: string, progress: number) => void;

/** Source audio to analyse, with optional overrides for the core's defaults. */
export interface AnalysisJob {
  samples: Float32Array;
  sampleRate: number;
  name: string;
  f0?: F0Params;
  segment?: SegmentParams;
}

/** A span of a compiled plan to render at offline quality. */
export interface RenderJob {
  samples: Float32Array;
  trackJson: string;
  planJson: string;
  sampleRate: number;
  /** First output frame to render. */
  startFrame: number;
  /** One past the last output frame, or `null` for the whole output. */
  endFrame: number | null;
}

/** A saved project to render and encode as a WAV file. */
export interface ExportJob {
  projectJson: string;
  /** Every clip's mono samples at the project rate, each transferred to the worker. */
  clips: ClipAudio[];
  /** Every reference's channels at the project rate, each transferred to the worker. */
  references: ReferenceAudio[];
  /** Whether the file mixes the references in, which makes it stereo. */
  withReferences: boolean;
  /** Output seconds to encode, or `null` for the whole output. */
  range: { start: number; end: number } | null;
  depth: BitDepth;
  /** Rate to write the file at; the core resamples when it differs from the source rate. */
  sampleRate: number;
}

type JobRequest = AnalyseRequest | DecodeRequest | RenderRangeRequest | ExportWavRequest;

type TerminalMessage = AnalysedMessage | DecodedMessage | RenderedMessage | EncodedMessage;

type ClientResponse = ProgressMessage<string> | TerminalMessage | FailedMessage | CancelledMessage;

interface Pending {
  operation: string;
  progress: ProgressListener | undefined;
  /** Settles the promise from a terminal message; false when the message is not its result. */
  settle(message: TerminalMessage): boolean;
  fail(error: Error): void;
  /** The watchdog, restarted by every report from the worker. */
  watchdog: ReturnType<typeof setTimeout> | null;
}

/**
 * Shared worker plumbing: one lazily started worker, a request id per job and a pending map.
 */
abstract class WorkerClient {
  #worker: Worker | null = null;
  #pending = new Map<RequestId, Pending>();
  #nextId = 1;

  /** Asks the worker to abandon every job in flight. Each rejects with {@link WorkerCancelled}. */
  cancel(): void {
    const worker = this.#worker;
    if (!worker) return;
    for (const id of this.#pending.keys()) {
      const request: CancelRequest = { type: 'cancel', id };
      worker.postMessage(request);
    }
  }

  /** Stops the worker and rejects every job in flight. The next call starts a fresh worker. */
  terminate(): void {
    this.#worker?.terminate();
    this.#worker = null;
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const job of pending) {
      if (job.watchdog !== null) clearTimeout(job.watchdog);
      job.fail(new WorkerCancelled(job.operation));
    }
  }

  /**
   * Starts the worker and has it load its core now rather than on its first job.
   *
   * @remarks So work keeps running if the page loses its server after it has loaded.
   */
  warm(): void {
    const request: WarmRequest = { type: 'warm' };
    try {
      this.#ensure().postMessage(request);
    } catch {
      // A worker that will not start fails its first job instead, with the reason.
    }
  }

  /** Builds the worker this client drives. */
  protected abstract spawn(): Worker;

  /**
   * Milliseconds a job may go without a report before the worker is taken down, or `null` for
   * no limit.
   *
   * @remarks A worker stuck in one call never answers a cancel, so stopping it is the only way
   * to free whatever waits on it.
   */
  protected stallLimit(): number | null {
    return null;
  }

  /**
   * Posts one job and resolves when the worker reports its result.
   *
   * @param read Reads the job's result from a terminal message, or returns `null` when the
   * message belongs to a different kind of job.
   */
  protected start<T>(
    operation: string,
    build: (id: RequestId) => { request: JobRequest; transfer: Transferable[] },
    read: (message: TerminalMessage) => T | null,
    progress: ProgressListener | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const worker = this.#ensure();
      const id = this.#nextId++;
      this.#pending.set(id, {
        operation,
        progress,
        settle: (message) => {
          const value = read(message);
          if (value === null) return false;
          resolve(value);
          return true;
        },
        fail: reject,
        watchdog: null,
      });
      this.#watch(id);
      try {
        const { request, transfer } = build(id);
        worker.postMessage(request, transfer);
      } catch (thrown) {
        this.#pending.delete(id);
        reject(new AxysError(operation, messageOf(thrown), thrown));
      }
    });
  }

  #ensure(): Worker {
    if (this.#worker) return this.#worker;
    const worker = this.spawn();
    worker.addEventListener('message', (event: MessageEvent<ClientResponse>) => {
      this.#receive(event.data);
    });
    worker.addEventListener('error', (event) => {
      this.#breakDown(event.message);
    });
    worker.addEventListener('messageerror', () => {
      this.#breakDown('Background task failed');
    });
    this.#worker = worker;
    return worker;
  }

  /** Restarts a job's watchdog. */
  #watch(id: RequestId): void {
    const limit = this.stallLimit();
    const pending = this.#pending.get(id);
    if (limit === null || pending === undefined) return;
    if (pending.watchdog !== null) clearTimeout(pending.watchdog);
    pending.watchdog = setTimeout(() => {
      const worker = this.#worker;
      this.#worker = null;
      worker?.terminate();
      const jobs = [...this.#pending.values()];
      this.#pending.clear();
      for (const job of jobs) {
        if (job.watchdog !== null) clearTimeout(job.watchdog);
        job.fail(new WorkerStalled(job.operation));
      }
    }, limit);
  }

  #receive(message: ClientResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (pending.watchdog !== null) clearTimeout(pending.watchdog);
    pending.watchdog = null;
    if (message.type === 'progress') this.#watch(message.id);
    switch (message.type) {
      case 'progress':
        pending.progress?.(message.stage, message.progress);
        return;
      case 'failed':
        this.#pending.delete(message.id);
        pending.fail(new AxysError(message.operation, message.message));
        return;
      case 'cancelled':
        this.#pending.delete(message.id);
        pending.fail(new WorkerCancelled(pending.operation));
        return;
      default:
        if (pending.settle(message)) this.#pending.delete(message.id);
    }
  }

  /** Fails every job when the worker itself dies, so no caller waits forever. */
  #breakDown(message: string): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const job of pending) {
      if (job.watchdog !== null) clearTimeout(job.watchdog);
      job.fail(new AxysError(job.operation, message));
    }
  }
}

/** Decodes media in the decode worker. */
export class DecodeClient extends WorkerClient {
  /**
   * Decodes one file's bytes, at `sampleRate` or at the file's own rate when it is `null`.
   *
   * @remarks `bytes` is transferred to the worker.
   */
  decode(
    bytes: ArrayBuffer,
    extension: string,
    sampleRate: number | null,
    onProgress?: ProgressListener,
  ): Promise<DecodedAudio> {
    return this.start<DecodedAudio>(
      'Decode Audio',
      (id) => ({
        request: { type: 'decode', id, bytes, extension, sampleRate },
        transfer: [bytes],
      }),
      (message) => (message.type === 'decoded' ? message.result : null),
      onProgress,
    );
  }

  protected override stallLimit(): number {
    return DECODE_STALL_MS;
  }

  protected override spawn(): Worker {
    return new Worker(new URL('./decode.worker.ts', import.meta.url), {
      type: 'module',
      name: 'axys-decode',
    });
  }
}

/** Milliseconds a decode may go without reporting progress before it is stopped. */
const DECODE_STALL_MS = 20_000;

/** Milliseconds an analysis may go without reporting progress before it is stopped. */
const ANALYSIS_STALL_MS = 120_000;

/** Runs pitch, energy and segmentation analysis in the analysis worker. */
export class AnalysisClient extends WorkerClient {
  /**
   * Analyses one mono source buffer.
   *
   * @remarks `job.samples` is transferred to the worker and comes back on the result, so the
   * caller must read the audio from {@link AnalysisResult.samples} afterwards.
   */
  analyse(job: AnalysisJob, onProgress?: ProgressListener): Promise<AnalysisResult> {
    return this.start<AnalysisResult>(
      'Analyse Audio',
      (id) => ({
        request: {
          type: 'analyse',
          id,
          samples: job.samples,
          sampleRate: job.sampleRate,
          name: job.name,
          f0: job.f0,
          segment: job.segment,
        },
        transfer: [bufferOf(job.samples)],
      }),
      (message) => (message.type === 'analysed' ? message.result : null),
      onProgress,
    );
  }

  protected override stallLimit(): number {
    return ANALYSIS_STALL_MS;
  }

  protected override spawn(): Worker {
    return new Worker(new URL('./analysis.worker.ts', import.meta.url), {
      type: 'module',
      name: 'axys-analysis',
    });
  }
}

/** Renders and encodes processed audio in the render worker. */
export class RenderClient extends WorkerClient {
  /**
   * Renders a span of the compiled plan at offline quality.
   *
   * @remarks `job.samples` is transferred to the worker and comes back on
   * {@link RenderedRange.source}.
   */
  renderRange(job: RenderJob, onProgress?: ProgressListener): Promise<RenderedRange> {
    return this.start<RenderedRange>(
      'Render Audio',
      (id) => ({
        request: {
          type: 'renderRange',
          id,
          samples: job.samples,
          trackJson: job.trackJson,
          planJson: job.planJson,
          sampleRate: job.sampleRate,
          startFrame: job.startFrame,
          endFrame: job.endFrame,
        },
        transfer: [bufferOf(job.samples)],
      }),
      (message) => (message.type === 'rendered' ? message.result : null),
      onProgress,
    );
  }

  /**
   * Renders a saved project and encodes it as a WAV file.
   *
   * @remarks Every buffer in `job.clips` and `job.references` is transferred to the worker and
   * not returned.
   */
  exportWav(job: ExportJob, onProgress?: ProgressListener): Promise<EncodedWav> {
    return this.start<EncodedWav>(
      'Export WAV',
      (id) => ({
        request: {
          type: 'exportWav',
          id,
          projectJson: job.projectJson,
          clips: job.clips,
          references: job.references,
          withReferences: job.withReferences,
          range: job.range,
          depth: job.depth,
          sampleRate: job.sampleRate,
        },
        transfer: [
          ...job.clips.map((clip) => bufferOf(clip.samples)),
          ...job.references.flatMap((reference) => reference.channels.map(bufferOf)),
        ],
      }),
      (message) => (message.type === 'encoded' ? message.result : null),
      onProgress,
    );
  }

  protected override spawn(): Worker {
    return new Worker(new URL('./render.worker.ts', import.meta.url), {
      type: 'module',
      name: 'axys-render',
    });
  }
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  return 'the worker request could not be sent';
}
