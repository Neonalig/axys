// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { selectionForRange, selectionForRanges, selectionSpan, withRange } from './selection.js';
import type { Blob } from '../core/types.js';

function blob(id: number, start: number, end: number): Blob {
  return {
    id,
    start,
    end,
    detectedCenter: 60,
    pitchOffset: 0,
    timeOffset: 0,
    timeScale: 1,
    subregions: [],
    curve: { anchors: [] },
    excluded: false,
    gainDb: 0,
  };
}

const BLOBS: Blob[] = [blob(1, 0, 1), blob(2, 1, 2), blob(3, 2, 3)];

describe('selectionForRange', () => {
  it('leaves out the blobs a span only touches at its edges', () => {
    const selection = selectionForRange(BLOBS, { start: 1, end: 2 });
    expect(selection.blobs).toEqual([2]);
  });

  it('selects the blob a point falls inside', () => {
    expect(selectionForRange(BLOBS, { start: 1.5, end: 1.5 }).blobs).toEqual([2]);
  });

  it('selects every blob a span reaches into', () => {
    expect(selectionForRange(BLOBS, { start: 0.5, end: 2.5 }).blobs).toEqual([1, 2, 3]);
  });

  it('selects nothing without a span', () => {
    expect(selectionForRange(BLOBS, null)).toEqual({ blobs: [], anchors: [], ranges: [] });
  });
});

describe('selectionForRanges', () => {
  it('keeps disjoint spans apart and skips what lies between them', () => {
    const selection = selectionForRanges(BLOBS, [
      { start: 0.2, end: 0.8 },
      { start: 2.2, end: 2.8 },
    ]);
    expect(selection.blobs).toEqual([1, 3]);
    expect(selection.ranges).toHaveLength(2);
  });
});

describe('withRange', () => {
  it('merges spans that overlap and keeps the rest in time order', () => {
    const ranges = withRange([{ start: 4, end: 5 }], { start: 0, end: 1 });
    expect(withRange(ranges, { start: 0.5, end: 2 })).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 5 },
    ]);
  });
});

describe('selectionSpan', () => {
  it('reports the span covering every selected span', () => {
    expect(
      selectionSpan([
        { start: 4, end: 5 },
        { start: 0, end: 1 },
      ]),
    ).toEqual({ start: 0, end: 5 });
  });

  it('reports nothing for an empty selection', () => {
    expect(selectionSpan([])).toBeNull();
  });
});
