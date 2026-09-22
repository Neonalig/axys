// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { Viewport } from './view.js';
import type { ViewState } from '../core/types.js';

const VIEW: ViewState = {
  visibleStart: 0,
  visibleEnd: 10,
  lowMidi: 48,
  highMidi: 72,
  timeDisplay: 'seconds',
  snapDivision: 4,
  playhead: 0,
  loopStart: null,
  loopEnd: null,
};

function at(ratio: number): Viewport {
  return new Viewport(800, 400, VIEW, ratio);
}

/** Where a line's two edges land in device pixels, which is what decides whether it is sharp. */
function edges(viewport: Viewport, value: number, width = 1): [number, number] {
  const centre = viewport.crisp(value, width) * viewport.ratio;
  const thickness = viewport.crispWidth(width) * viewport.ratio;
  return [centre - thickness / 2, centre + thickness / 2];
}

describe('crisp lines at each device pixel ratio', () => {
  for (const ratio of [1, 1.25, 1.5, 2, 3]) {
    it(`lands a one-pixel line on whole device pixels at ${String(ratio)}`, () => {
      const viewport = at(ratio);
      for (const value of [0, 3.2, 17.9, 123.456, 799]) {
        const [start, end] = edges(viewport, value);
        expect(start).toBeCloseTo(Math.round(start), 6);
        expect(end).toBeCloseTo(Math.round(end), 6);
      }
    });

    it(`lands a two-pixel line on whole device pixels at ${String(ratio)}`, () => {
      const viewport = at(ratio);
      for (const value of [0, 3.2, 17.9, 123.456]) {
        const [start, end] = edges(viewport, value, 2);
        expect(start).toBeCloseTo(Math.round(start), 6);
        expect(end).toBeCloseTo(Math.round(end), 6);
      }
    });

    it(`keeps a line at least one device pixel wide at ${String(ratio)}`, () => {
      expect(at(ratio).crispWidth() * ratio).toBeGreaterThanOrEqual(1);
    });
  }

  it('leaves whole ratios drawing the width that was asked for', () => {
    expect(at(1).crispWidth(2)).toBe(2);
    expect(at(2).crispWidth(2)).toBe(2);
  });

  it('carries its ratio through a view change', () => {
    expect(at(1.5).withView(VIEW).ratio).toBe(1.5);
  });
});
