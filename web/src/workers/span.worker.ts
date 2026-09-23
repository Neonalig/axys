// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Measures pitch candidates and energy for one span of an analysis's frames at a time.
 *
 * One of a pool the analysis worker splits a take across. Owns its own instance of the
 * WebAssembly core; failure is posted as a typed message, never thrown into the void.
 */

import { loadCore } from '../core/wasm';
import { observeSpan } from '../wasm/axys_wasm.js';
import { measureTransfers } from './protocol';
import type { ObserveSpanRequest, SpanMeasures, SpanResponse } from './protocol';

/** The dedicated worker scope, narrowed from the ambient global. */
interface SpanScope {
  addEventListener(type: 'message', fn: (event: MessageEvent<ObserveSpanRequest>) => void): void;
  postMessage(message: SpanResponse, transfer: Transferable[]): void;
}

const scope = globalThis as unknown as SpanScope;

scope.addEventListener('message', (event) => {
  void run(event.data);
});

async function run(request: ObserveSpanRequest): Promise<void> {
  const { id } = request;
  try {
    await loadCore();
    const span = observeSpan(
      request.window,
      request.offset,
      request.len,
      request.sampleRate,
      request.paramsJson,
      request.first,
      request.end,
    );
    try {
      const measures: SpanMeasures = {
        freq: span.freq(),
        dprime: span.dprime(),
        cost: span.cost(),
        counts: span.counts(),
        rms: span.rms(),
        energyRms: span.energyRms(),
        flux: span.flux(),
        zcr: span.zcr(),
      };
      scope.postMessage({ type: 'observed', id, measures }, measureTransfers(measures));
    } finally {
      span.free();
    }
  } catch (thrown) {
    scope.postMessage(
      { type: 'failed', id, operation: 'Analyse Audio', message: messageOf(thrown) },
      [],
    );
  }
}

function messageOf(thrown: unknown): string {
  if (typeof thrown === 'string') return thrown;
  if (thrown instanceof Error) return thrown.message;
  return 'the span worker failed without a message';
}
