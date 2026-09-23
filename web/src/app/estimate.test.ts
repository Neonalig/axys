// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { Blob } from '../core/types.js';
import { estimateKey, estimateTiming } from './estimate.js';

function blob(id: number, start: number, end: number, midi = 60): Blob {
  return {
    id,
    start,
    end,
    detectedCenter: midi,
    pitchOffset: 0,
    timeOffset: 0,
    timeScale: 1,
    subregions: [],
    curve: { anchors: [] },
    excluded: false,
    gainDb: 0,
  };
}

/**
 * A phrase at `bpm` whose first note is `offset` seconds in, held longest on every `bar`th beat
 * counted from `downbeat`.
 */
function phrase(bpm: number, offset: number, bar: number, downbeat: number): Blob[] {
  const beat = 60 / bpm;
  return Array.from({ length: 32 }, (_, index) => {
    const start = offset + index * beat;
    const held = (index - downbeat) % bar === 0 ? 0.9 : 0.35;
    return blob(index, start, start + held * beat);
  });
}

describe('estimateTiming', () => {
  it('finds the tempo, the first beat and which beat of the bar it is', () => {
    // Beat index 1 is the downbeat, so the first beat is beat 4 of a bar of four.
    const estimate = estimateTiming(phrase(120, 0.25, 4, 1));
    expect(estimate?.bpm).toBeCloseTo(120, 0);
    expect(estimate?.beatsPerBar).toBe(4);
    expect(estimate?.offset).toBeCloseTo(0.25, 2);
    expect(estimate?.beat).toBe(4);
  });

  it('tells three beats to the bar from four', () => {
    const estimate = estimateTiming(phrase(90, 0, 3, 0));
    expect(estimate?.beatsPerBar).toBe(3);
    expect(estimate?.beat).toBe(1);
  });

  it('proposes nothing from a handful of notes', () => {
    expect(estimateTiming([blob(0, 0, 1), blob(1, 1, 2)])).toBeNull();
  });
});

describe('estimateKey', () => {
  it('reads a major and a minor scale', () => {
    const scale = (root: number, degrees: number[]): Blob[] =>
      [...degrees, 0, 7, 0].map((degree, index) =>
        blob(index, index, index + 1, 60 + root + degree),
      );
    expect(estimateKey(scale(7, [0, 2, 4, 5, 7, 9, 11]))).toEqual({ root: 7, minor: false });
    expect(estimateKey(scale(9, [0, 2, 3, 5, 7, 8, 10]))).toEqual({ root: 9, minor: true });
  });
});
