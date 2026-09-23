// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Renders and encodes processed audio off the main thread at offline quality.
 *
 * Renders in chunks so progress is real and a cancel message is honoured within one chunk, and
 * hands the caller's source buffer back so a transfer never costs it the audio. Failure is
 * posted as a typed message, never thrown into the void.
 */

import { loadCore } from '../core/wasm';
import { PlaybackRenderer } from '../wasm/axys_wasm.js';
import { encodedTransfers, RENDER_CHUNK_FRAMES, renderedTransfers } from './protocol';
import type {
  EncodedWav,
  ExportWavRequest,
  RenderRangeRequest,
  RenderRequest,
  RenderResponse,
  RenderStage,
  RenderedRange,
  RequestId,
} from './protocol';

/** The dedicated worker scope, narrowed from the ambient global. */
interface RenderScope {
  addEventListener(type: 'message', fn: (event: MessageEvent<RenderRequest>) => void): void;
  postMessage(message: RenderResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as RenderScope;

/** Jobs the caller has asked to abandon, checked between chunks. */
const cancelling = new Set<RequestId>();

scope.addEventListener('message', (event) => {
  const request = event.data;
  switch (request.type) {
    case 'cancel':
      cancelling.add(request.id);
      return;
    case 'warm':
      void loadCore().catch(() => {
        // The first job reports the failure with its operation named.
      });
      return;
    case 'renderRange':
      void renderRange(request);
      return;
    case 'exportWav':
      void exportWav(request);
      return;
  }
});

async function renderRange(request: RenderRangeRequest): Promise<void> {
  const { id } = request;
  try {
    report(id, 'Load Core', 0);
    await loadCore();
    if (abandon(id)) return;

    report(id, 'Build Renderer', 0.02);
    const renderer = PlaybackRenderer.create(
      request.samples,
      request.trackJson,
      request.planJson,
      true,
    );
    try {
      const outputFrames = renderer.outputFrames();
      const start = clamp(request.startFrame, 0, outputFrames);
      const end = clamp(request.endFrame ?? outputFrames, start, outputFrames);
      const total = end - start;
      const samples = new Float32Array(total);

      report(id, 'Render Audio', 0);
      let done = 0;
      while (done < total) {
        if (abandon(id)) return;
        const length = Math.min(RENDER_CHUNK_FRAMES, total - done);
        samples.set(renderer.render(start + done, length), done);
        done += length;
        report(id, 'Render Audio', done / total);
        await yieldToMessages();
      }
      if (abandon(id)) return;

      const result: RenderedRange = {
        samples,
        startFrame: start,
        outputFrames,
        sampleRate: request.sampleRate,
        source: request.samples,
      };
      scope.postMessage({ type: 'rendered', id, result }, renderedTransfers(result));
    } finally {
      renderer.free();
    }
  } catch (thrown) {
    fail(id, 'Render Audio', thrown);
  }
}

async function exportWav(request: ExportWavRequest): Promise<void> {
  const { id } = request;
  try {
    report(id, 'Load Core', 0);
    const core = await loadCore();
    if (abandon(id)) return;

    report(id, 'Encode WAV', 0.05);
    const session = core.openSession(request.projectJson);
    try {
      for (const clip of request.clips) session.attachClip(clip.clip, clip.samples);
      for (const reference of request.references) {
        session.attachReference(reference.reference, reference.channels);
      }
      if (abandon(id)) return;
      const encoded = session.exportWav(
        request.range,
        request.depth,
        request.sampleRate,
        request.withReferences,
      );
      const result: EncodedWav = { bytes: encoded.bytes, report: encoded.report };
      report(id, 'Encode WAV', 1);
      scope.postMessage({ type: 'encoded', id, result }, encodedTransfers(result));
    } finally {
      session.free();
    }
  } catch (thrown) {
    fail(id, 'Export WAV', thrown);
  }
}

/** Reports a cancelled job and clears it. True when the caller asked to stop. */
function abandon(id: RequestId): boolean {
  if (!cancelling.delete(id)) return false;
  scope.postMessage({ type: 'cancelled', id }, []);
  return true;
}

function report(id: RequestId, stage: RenderStage, progress: number): void {
  scope.postMessage({ type: 'progress', id, stage, progress }, []);
}

function fail(id: RequestId, operation: string, thrown: unknown): void {
  cancelling.delete(id);
  scope.postMessage({ type: 'failed', id, operation, message: messageOf(thrown) }, []);
}

/** Returns to the event loop so a queued cancel message is delivered. */
function yieldToMessages(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  return 'the render worker failed without a message';
}
