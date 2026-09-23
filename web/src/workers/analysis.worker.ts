// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs pitch detection, energy analysis and provisional segmentation off the main thread.
 *
 * Owns its own instance of the WebAssembly core, so analysing a long take never blocks the
 * editor or the audio thread. A long take is measured in spans across a pool of span workers and
 * finished here. Failure is posted as a typed message, never thrown into the void.
 */

import type { F0Params, SegmentParams } from '../core/types';
import { loadCore } from '../core/wasm';
import { analyse, analyseSpans, analysisFrameCount, spanSamples } from '../wasm/axys_wasm.js';
import type { Analysis } from '../wasm/axys_wasm.js';
import { SpanPool } from './span-pool';
import { analysisTransfers, WorkerCancelled } from './protocol';
import type {
  AnalyseRequest,
  AnalysisRequest,
  AnalysisResponse,
  AnalysisResult,
  AnalysisStage,
  RequestId,
  SpanMeasures,
} from './protocol';

/** The dedicated worker scope, narrowed from the ambient global. */
interface AnalysisScope {
  addEventListener(type: 'message', fn: (event: MessageEvent<AnalysisRequest>) => void): void;
  postMessage(message: AnalysisResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as AnalysisScope;

/** Frames below which a take is analysed in one call, where splitting costs more than it saves. */
const MIN_SPLIT_FRAMES = 1_000;

/** Fewest frames in one span. */
const MIN_SPAN_FRAMES = 500;

/** Spans per worker, so a slow span does not leave the others idle and progress moves often. */
const SPANS_PER_WORKER = 3;

/** Most span workers this worker starts. */
const MAX_SPAN_WORKERS = 8;

/** Share of the progress bar the spans fill; decoding and segmentation take the rest. */
const SPANS_SHARE = 0.8;

/** Jobs the caller has asked to abandon, checked at every stage boundary. */
const cancelling = new Set<RequestId>();

/** The span workers, started on first use; `null` where none can run. */
let pool: SpanPool | null | undefined;

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelling.add(request.id);
    pool?.drop(request.id);
    return;
  }
  if (request.type === 'warm') {
    void loadCore().catch(() => {
      // The first job reports the failure with its operation named.
    });
    spanPool()?.warm();
    return;
  }
  void run(request);
});

async function run(request: AnalyseRequest): Promise<void> {
  const { id } = request;
  try {
    report(id, 'Load Engine', 0);
    await loadCore();
    if (abandon(id)) return;

    // Zero, not a small number: a take analysed in one call is one opaque call into the core,
    // so a bar pinned at 8 per cent for its whole duration reads as stalled. Indeterminate says
    // "working" honestly. A split take reports each span as it lands.
    report(id, 'Analyse Audio', 0);
    const params = paramsJson(request);
    const analysis =
      (await analyseAcrossPool(request, params)) ??
      analyse(request.samples, request.sampleRate, params);
    try {
      if (abandon(id)) return;

      report(id, 'Read Pitch', 0.85);
      const trackJson = analysis.trackJson();
      const times = analysis.times();
      const midi = analysis.midi();
      const confidence = analysis.confidence();
      const rms = analysis.rms();

      report(id, 'Read Blobs', 0.95);
      const energyJson = analysis.energyJson();
      const blobsJson = analysis.blobsJson();
      if (abandon(id)) return;

      const result: AnalysisResult = {
        trackJson,
        energyJson,
        blobsJson,
        times,
        midi,
        confidence,
        rms,
        samples: request.samples,
        sampleRate: request.sampleRate,
        name: request.name,
      };
      report(id, 'Read Blobs', 1);
      scope.postMessage({ type: 'analysed', id, result }, analysisTransfers(result));
    } finally {
      analysis.free();
    }
  } catch (thrown) {
    if (thrown instanceof WorkerCancelled && abandon(id)) return;
    cancelling.delete(id);
    scope.postMessage(
      { type: 'failed', id, operation: 'Analyse Audio', message: messageOf(thrown) },
      [],
    );
  }
}

/**
 * Analyses a take measured in spans across the span workers.
 *
 * Resolves `null` when the take is too short to split or the pool could not finish it, so the
 * caller analyses it in one call. Rejects with {@link WorkerCancelled} when the job is cancelled.
 */
async function analyseAcrossPool(
  request: AnalyseRequest,
  params: string,
): Promise<Analysis | null> {
  const { id, samples, sampleRate } = request;
  const len = samples.length;
  const frames = analysisFrameCount(len, sampleRate, params);
  if (frames < MIN_SPLIT_FRAMES) return null;
  const workers = spanPool();
  if (workers === null) return null;

  const spanFrames = Math.max(
    MIN_SPAN_FRAMES,
    Math.ceil(frames / (workers.size * SPANS_PER_WORKER)),
  );
  const count = Math.ceil(frames / spanFrames);
  let landed = 0;
  const spans: Promise<SpanMeasures>[] = [];
  for (let first = 0; first < frames; first += spanFrames) {
    const end = Math.min(frames, first + spanFrames);
    const [start = 0, stop = 0] = spanSamples(len, sampleRate, params, first, end);
    const span = {
      window: samples.slice(start, stop),
      offset: start,
      len,
      sampleRate,
      paramsJson: params,
      first,
      end,
    };
    spans.push(
      workers.observe(id, span).then((measures) => {
        landed += 1;
        report(id, 'Analyse Audio', (SPANS_SHARE * landed) / count);
        return measures;
      }),
    );
  }

  const settled = await Promise.allSettled(spans);
  const parts: SpanMeasures[] = [];
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      parts.push(outcome.value);
      continue;
    }
    workers.drop(id);
    if (outcome.reason instanceof WorkerCancelled) throw outcome.reason;
    console.warn('Span workers failed, so the take is analysed on one thread', outcome.reason);
    return null;
  }

  const f64 = (length: number) => new Float64Array(length);
  const f32 = (length: number) => new Float32Array(length);
  return analyseSpans(
    len,
    sampleRate,
    params,
    joined(
      parts.map((part) => part.freq),
      f64,
    ),
    joined(
      parts.map((part) => part.dprime),
      f64,
    ),
    joined(
      parts.map((part) => part.cost),
      f64,
    ),
    joined(
      parts.map((part) => part.counts),
      (length) => new Uint32Array(length),
    ),
    joined(
      parts.map((part) => part.rms),
      f32,
    ),
    joined(
      parts.map((part) => part.unvoiced),
      f64,
    ),
    joined(
      parts.map((part) => part.energyRms),
      f32,
    ),
    joined(
      parts.map((part) => part.flux),
      f32,
    ),
    joined(
      parts.map((part) => part.zcr),
      f32,
    ),
  );
}

/** Starts the span workers on first use. */
function spanPool(): SpanPool | null {
  if (pool === undefined) {
    const cores = globalThis.navigator?.hardwareConcurrency ?? 1;
    pool = cores > 1 ? SpanPool.create(Math.min(MAX_SPAN_WORKERS, cores)) : null;
  }
  return pool;
}

/** Concatenates typed arrays in order. */
function joined<T extends Float32Array | Float64Array | Uint32Array>(
  views: readonly T[],
  make: (length: number) => T,
): T {
  const out = make(views.reduce((total, view) => total + view.length, 0));
  let at = 0;
  for (const view of views) {
    out.set(view, at);
    at += view.length;
  }
  return out;
}

/** Reports a cancelled job and clears it. True when the caller asked to stop. */
function abandon(id: RequestId): boolean {
  if (!cancelling.delete(id)) return false;
  scope.postMessage({ type: 'cancelled', id }, []);
  return true;
}

function report(id: RequestId, stage: AnalysisStage, progress: number): void {
  scope.postMessage({ type: 'progress', id, stage, progress }, []);
}

/** The core's `{ f0, segment }` parameter document, empty when both take their defaults. */
function paramsJson(request: { f0?: F0Params; segment?: SegmentParams }): string {
  if (!request.f0 && !request.segment) return '';
  const params: { f0?: F0Params; segment?: SegmentParams } = {};
  if (request.f0) params.f0 = request.f0;
  if (request.segment) params.segment = request.segment;
  return JSON.stringify(params);
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  return 'the analysis worker failed without a message';
}
