// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs pitch detection, energy analysis and provisional segmentation off the main thread.
 *
 * Owns its own instance of the WebAssembly core, so analysing a long take never blocks the
 * editor or the audio thread. Failure is posted as a typed message, never thrown into the void.
 */

import type { F0Params, SegmentParams } from '../core/types';
import { loadCore } from '../core/wasm';
import { analyse } from '../wasm/axys_wasm.js';
import { analysisTransfers } from './protocol';
import type {
  AnalyseRequest,
  AnalysisRequest,
  AnalysisResponse,
  AnalysisResult,
  AnalysisStage,
  RequestId,
} from './protocol';

/** The dedicated worker scope, narrowed from the ambient global. */
interface AnalysisScope {
  addEventListener(type: 'message', fn: (event: MessageEvent<AnalysisRequest>) => void): void;
  postMessage(message: AnalysisResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as AnalysisScope;

/** Jobs the caller has asked to abandon, checked at every stage boundary. */
const cancelling = new Set<RequestId>();

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelling.add(request.id);
    return;
  }
  void run(request);
});

async function run(request: AnalyseRequest): Promise<void> {
  const { id } = request;
  try {
    report(id, 'Load Core', 0);
    await loadCore();
    if (abandon(id)) return;

    report(id, 'Analyse Audio', 0.08);
    const analysis = analyse(request.samples, request.sampleRate, paramsJson(request));
    try {
      if (abandon(id)) return;

      report(id, 'Read Track', 0.85);
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
    cancelling.delete(id);
    scope.postMessage(
      { type: 'failed', id, operation: 'Analyse Audio', message: messageOf(thrown) },
      [],
    );
  }
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
