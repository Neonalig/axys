// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import {
  bezierAt,
  extendStroke,
  freePosition,
  insertPoint,
  moveBezierHandle,
  rippleInsert,
  sampleBezier,
  straightBezier,
} from './tools.js';
import { readoutNoteName } from '../core/notes.js';

describe('extendStroke', () => {
  const draw = (moves: [number, number][]): [number, number][] => {
    const [first, ...rest] = moves.map(([time, midi]) => ({ time, midi }));
    if (first === undefined) return [];
    let points = [first];
    let last = first;
    for (const point of rest) {
      points = extendStroke(points, last, point);
      last = point;
    }
    return points.map((point) => [point.time, point.midi]);
  };

  it('draws right to left as well as left to right', () => {
    expect(
      draw([
        [3, 60],
        [2, 61],
        [1, 62],
      ]),
    ).toEqual([
      [1, 62],
      [2, 61],
      [3, 60],
    ]);
  });

  it('replaces what a stroke passes back over with the newest part', () => {
    expect(
      draw([
        [0, 60],
        [1, 60],
        [2, 60],
        [3, 60],
        [1.5, 64],
      ]),
    ).toEqual([
      [0, 60],
      [1, 60],
      [1.5, 64],
      [3, 60],
    ]);
  });

  it('replaces the last point on a move straight up', () => {
    expect(
      draw([
        [0, 60],
        [1, 60],
        [1, 62],
      ]),
    ).toEqual([
      [0, 60],
      [1, 62],
    ]);
  });
});

describe('freePosition', () => {
  it('keeps a clip where it was asked when it fits', () => {
    expect(freePosition([[0, 2]], 1, 3)).toBe(3);
    expect(freePosition([], 1, -4)).toBe(0);
  });

  it('moves an overlapping clip against the nearer edge of the clip it hit', () => {
    expect(freePosition([[1, 4]], 1, 1.5)).toBe(0);
    expect(freePosition([[1, 4]], 1, 3.5)).toBe(4);
  });

  it('skips a gap too narrow for the clip', () => {
    expect(
      freePosition(
        [
          [0, 2],
          [2.5, 5],
        ],
        1,
        2.1,
      ),
    ).toBe(5);
  });
});

describe('Bezier', () => {
  const from = { time: 1, midi: 60 };
  const to = { time: 2, midi: 64 };

  it('starts straight, with its controls a third of the way in from each end', () => {
    const curve = straightBezier(to, from);
    expect(curve.from).toEqual(from);
    expect(curve.to).toEqual(to);
    expect(curve.c1.time).toBeCloseTo(4 / 3, 12);
    expect(curve.c2.midi).toBeCloseTo(60 + (4 * 2) / 3, 12);
    expect(bezierAt(curve, 0.5).midi).toBeCloseTo(62, 12);
  });

  it('carries a control with the end it belongs to', () => {
    const curve = moveBezierHandle(straightBezier(from, to), 'from', { time: 1.2, midi: 61 });
    expect(curve.from).toEqual({ time: 1.2, midi: 61 });
    expect(curve.c1.time).toBeCloseTo(4 / 3 + 0.2, 12);
    expect(curve.c1.midi).toBeCloseTo(60 + 4 / 3 + 1, 12);
  });

  it('holds its controls between its ends so the curve never folds back in time', () => {
    const curve = moveBezierHandle(straightBezier(from, to), 'c1', { time: 5, midi: 70 });
    expect(curve.c1.time).toBe(2);
    const points = sampleBezier(curve, 32);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]?.time ?? 0).toBeGreaterThan(points[i - 1]?.time ?? 0);
    }
    expect(points[0]).toEqual(from);
    expect(points.at(-1)?.time).toBeCloseTo(2, 12);
  });

  it('bends when a control is pulled off the line', () => {
    const curve = moveBezierHandle(straightBezier(from, to), 'c1', { time: 4 / 3, midi: 68 });
    expect(bezierAt(curve, 0.25).midi).toBeGreaterThan(61);
  });
});

describe('readoutNoteName', () => {
  it('keeps every reading the same width', () => {
    const readings = [60, 60.03, 61.69, 69.5, 71.99, 59.12].map((midi) => readoutNoteName(midi));
    expect(new Set(readings.map((text) => text.length)).size).toBe(1);
    expect(readoutNoteName(60.03)).toBe('C4   +3c');
    expect(readoutNoteName(61.69)).toBe('D4  -31c');
  });
});

describe('rippleInsert', () => {
  it('matches the core: a drop inside a clip goes to its nearer edge and pushes the rest', () => {
    expect(insertPoint([[0, 10]], 4)).toBe(0);
    expect(insertPoint([[0, 10]], 6)).toBe(10);
    expect(rippleInsert([[0, 10]], 3, 4)).toEqual({ position: 0, shift: 3 });
    expect(
      rippleInsert(
        [
          [0, 2],
          [4, 6],
        ],
        2,
        3,
      ),
    ).toEqual({ position: 3, shift: 1 });
  });
});
