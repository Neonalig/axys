// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import {
  amplitude,
  clipLevels,
  clipStrips,
  DEFAULT_MIXER,
  mixLevels,
  referenceLevel,
  UNITY_STRIP,
  vocalMonitor,
  withClipStrip,
  withReferenceStrip,
} from './mixer.js';

describe('amplitude', () => {
  it('reads unity at zero and silence at the floor', () => {
    expect(amplitude(0)).toBe(1);
    expect(amplitude(-60)).toBe(0);
    expect(amplitude(-1000)).toBe(0);
    expect(amplitude(-6)).toBeCloseTo(0.501, 3);
    expect(amplitude(6)).toBeCloseTo(1.995, 3);
  });

  it('holds a level that is not a number at unity rather than silencing playback', () => {
    expect(amplitude(Number.NaN)).toBe(1);
  });
});

describe('mixLevels', () => {
  it('starts every clip on the processed take with the original muted', () => {
    const levels = mixLevels(DEFAULT_MIXER);
    const clip = clipLevels(levels, 3);
    expect(clip.processed.audible).toBe(true);
    expect(clip.original.audible).toBe(false);
    expect(levels.click.audible).toBe(true);
    expect(levels.click.left).toBeLessThan(clip.processed.left);
    expect(referenceLevel(levels, 0).audible).toBe(true);
  });

  it('holds loudness across the stereo field rather than dipping through the middle', () => {
    const centre = clipLevels(mixLevels(DEFAULT_MIXER), 0).processed;
    const panned = withClipStrip(DEFAULT_MIXER, 0, 'processed', { ...UNITY_STRIP, pan: -1 });
    const left = clipLevels(mixLevels(panned), 0).processed;
    expect(centre.left).toBeCloseTo(centre.right, 12);
    expect(left.right).toBeCloseTo(0, 12);
    const power = (l: number, r: number): number => l * l + r * r;
    expect(power(centre.left, centre.right)).toBeCloseTo(power(left.left, left.right), 12);
  });

  it('silences every strip a solo leaves out, including sources with no entry yet', () => {
    const desk = withReferenceStrip(DEFAULT_MIXER, 1, { ...UNITY_STRIP, solo: true });
    const levels = mixLevels(desk);
    expect(referenceLevel(levels, 1).audible).toBe(true);
    expect(referenceLevel(levels, 2).audible).toBe(false);
    expect(clipLevels(levels, 0).processed.audible).toBe(false);
    expect(levels.click.audible).toBe(false);
  });

  it('keeps each clip on its own strips', () => {
    const desk = withClipStrip(DEFAULT_MIXER, 1, 'processed', { ...UNITY_STRIP, gainDb: -60 });
    const levels = mixLevels(desk);
    expect(clipLevels(levels, 1).processed.audible).toBe(false);
    expect(clipLevels(levels, 0).processed.audible).toBe(true);
    expect(clipStrips(desk, 1).original.mute).toBe(true);
  });
});

describe('vocalMonitor', () => {
  it('names what is being heard from one clip', () => {
    expect(vocalMonitor(DEFAULT_MIXER, 0)).toBe('processed');
    const both = withClipStrip(DEFAULT_MIXER, 0, 'original', UNITY_STRIP);
    expect(vocalMonitor(both, 0)).toBe('both');
    expect(vocalMonitor(both, 1)).toBe('processed');
  });
});
