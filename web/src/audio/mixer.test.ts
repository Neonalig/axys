// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { amplitude, DEFAULT_MIXER, mixLevels, vocalMonitor } from './mixer.js';
import type { MixerSettings } from '../core/types.js';

function desk(patch: Partial<MixerSettings> = {}): MixerSettings {
  return { ...DEFAULT_MIXER, ...patch };
}

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
  it('starts on the processed take with the original muted', () => {
    const levels = mixLevels(DEFAULT_MIXER);
    expect(levels.processed.audible).toBe(true);
    expect(levels.original.audible).toBe(false);
    expect(levels.click.audible).toBe(true);
    expect(levels.click.left).toBeLessThan(levels.processed.left);
  });

  it('holds loudness across the stereo field rather than dipping through the middle', () => {
    const centre = mixLevels(DEFAULT_MIXER).processed;
    const left = mixLevels(desk({ processed: { ...DEFAULT_MIXER.processed, pan: -1 } })).processed;
    expect(centre.left).toBeCloseTo(centre.right, 12);
    expect(left.right).toBeCloseTo(0, 12);
    const power = (l: number, r: number): number => l * l + r * r;
    expect(power(centre.left, centre.right)).toBeCloseTo(power(left.left, left.right), 12);
  });

  it('silences every strip a solo leaves out, muted or not', () => {
    const levels = mixLevels(desk({ click: { ...DEFAULT_MIXER.click, solo: true } }));
    expect(levels.click.audible).toBe(true);
    expect(levels.processed.audible).toBe(false);
  });

  it('treats a closed fader as silence', () => {
    const levels = mixLevels(desk({ processed: { ...DEFAULT_MIXER.processed, gainDb: -60 } }));
    expect(levels.processed.audible).toBe(false);
  });
});

describe('vocalMonitor', () => {
  it('names what is being heard', () => {
    expect(vocalMonitor(DEFAULT_MIXER)).toBe('processed');
    expect(vocalMonitor(desk({ original: { ...DEFAULT_MIXER.original, mute: false } }))).toBe(
      'both',
    );
    expect(vocalMonitor(desk({ processed: { ...DEFAULT_MIXER.processed, mute: true } }))).toBe(
      'neither',
    );
  });
});
