// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decodes imported media in the core, off the main thread.
 *
 * The core decodes the same bytes to the same samples in every browser, so a file's fingerprint
 * agrees wherever it is opened. Decoding runs in steps, reporting progress and answering a
 * cancel between them.
 */

import { loadCore } from '../core/wasm';
import { AudioDecoder } from '../wasm/axys_wasm.js';
import { decodedTransfers } from './protocol';
import type {
  DecodeRequest,
  DecodeResponse,
  DecodeStage,
  DecodeWorkerRequest,
  DecodedAudio,
  RequestId,
} from './protocol';

/** The dedicated worker scope, narrowed from the ambient global. */
interface DecodeScope {
  addEventListener(type: 'message', fn: (event: MessageEvent<DecodeWorkerRequest>) => void): void;
  postMessage(message: DecodeResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as DecodeScope;

/** Packets decoded between progress reports and cancellation checks. */
const PACKETS_PER_STEP = 64;

/** Shortest gap between progress reports, in milliseconds. */
const REPORT_MS = 50;

/** Share of the progress bar reading the file fills; resampling and copying take the rest. */
const DECODE_SHARE = 0.9;

/** Jobs the caller has asked to abandon, checked between steps. */
const cancelling = new Set<RequestId>();

scope.addEventListener('message', (event) => {
  const request = event.data;
  if (request.type === 'cancel') {
    cancelling.add(request.id);
    return;
  }
  if (request.type === 'warm') {
    void loadCore().catch(() => {
      // The first job reports the failure with its operation named.
    });
    return;
  }
  void run(request);
});

async function run(request: DecodeRequest): Promise<void> {
  const { id } = request;
  let decoder: AudioDecoder | null = null;
  try {
    report(id, 'Load Engine', 0);
    await loadCore();
    if (abandon(id)) return;

    decoder = new AudioDecoder(new Uint8Array(request.bytes), request.extension);
    report(id, 'Decode Audio', 0);
    let reported = performance.now();
    while (!decoder.step(PACKETS_PER_STEP)) {
      const now = performance.now();
      if (now - reported >= REPORT_MS) {
        report(id, 'Decode Audio', decoder.progress() * DECODE_SHARE);
        reported = now;
        // Yields, so a cancel posted meanwhile is read before the next step.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abandon(id)) return;
      }
    }
    const resampling = request.sampleRate !== null && request.sampleRate !== decoder.sampleRate();
    report(id, resampling ? 'Resample Audio' : 'Decode Audio', DECODE_SHARE);
    const media = decoder.finish(request.sampleRate ?? 0);
    try {
      const channels: Float32Array[] = [];
      for (let index = 0; index < media.channelCount(); index += 1) {
        channels.push(media.channel(index));
      }
      const result: DecodedAudio = {
        sampleRate: media.sampleRate(),
        declaredRate: media.declaredRate(),
        frames: media.frames(),
        channels,
        mono: media.mono(),
        fingerprint: media.fingerprint(),
      };
      if (abandon(id)) return;
      report(id, 'Decode Audio', 1);
      scope.postMessage({ type: 'decoded', id, result }, decodedTransfers(result));
    } finally {
      media.free();
    }
  } catch (thrown) {
    cancelling.delete(id);
    scope.postMessage(
      { type: 'failed', id, operation: 'Decode Audio', message: messageOf(thrown) },
      [],
    );
  } finally {
    decoder?.free();
  }
}

function abandon(id: RequestId): boolean {
  if (!cancelling.delete(id)) return false;
  scope.postMessage({ type: 'cancelled', id }, []);
  return true;
}

function report(id: RequestId, stage: DecodeStage, progress: number): void {
  scope.postMessage({ type: 'progress', id, stage, progress }, []);
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  return 'the file could not be decoded';
}
