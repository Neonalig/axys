// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { PeakEnvelope } from './peaks.js';

describe('PeakEnvelope', () => {
  it('samples the same columns whatever rounding noise the span carries', () => {
    const rate = 48_000;
    const samples = Float32Array.from(
      { length: rate * 4 },
      (_, i) => Math.sin(i * 0.37) * ((i % 997) / 997),
    );
    const envelope = PeakEnvelope.build(samples, rate);
    // 80 samples a column, so every sixteenth column edge lands on a bucket edge.
    const perColumn = 80 / rate;
    const count = 600;
    const exact = envelope.sample(1, 1 + count * perColumn, count);
    const wanted = { min: [...exact.min.slice(0, count)], max: [...exact.max.slice(0, count)] };
    for (const noise of [1e-13, -1e-13, 3e-12, -3e-12]) {
      const noisy = envelope.sample(1 + noise, 1 + count * perColumn + noise, count);
      expect([...noisy.min.slice(0, count)]).toEqual(wanted.min);
      expect([...noisy.max.slice(0, count)]).toEqual(wanted.max);
    }
  });
});
