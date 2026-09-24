// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import type { SourceInfo } from '../core/types.js';
import { fitFrames, likeliestSource, relinkMatch } from './relink.js';

function source(name: string, frames: number, fingerprint: string): SourceInfo {
  return {
    name,
    sampleRate: 48000,
    channels: 1,
    frames,
    duration: frames / 48000,
    fingerprint,
    mime: null,
  };
}

describe('relinkMatch', () => {
  const recorded = source('Lead Vocals.wav', 1000, 'aaaa');

  it('takes a matching fingerprint as exact', () => {
    expect(relinkMatch({ name: 'renamed.wav', frames: 1000, fingerprint: 'aaaa' }, recorded)).toBe(
      'exact',
    );
  });

  it('takes the recorded name and length decoded elsewhere as the same file', () => {
    expect(
      relinkMatch({ name: 'lead vocals.WAV', frames: 1000, fingerprint: 'bbbb' }, recorded),
    ).toBe('same');
  });

  it('refuses a different length or name without confirmation', () => {
    expect(
      relinkMatch({ name: 'Lead Vocals.wav', frames: 999, fingerprint: 'bbbb' }, recorded),
    ).toBe('different');
    expect(relinkMatch({ name: 'Other.wav', frames: 1000, fingerprint: 'bbbb' }, recorded)).toBe(
      'different',
    );
  });
});

describe('likeliestSource', () => {
  const sources = [
    source('Harmony.wav', 2000, 'cccc'),
    source('Lead Vocals.wav', 1500, 'aaaa'),
    source('Ad Libs.wav', 1010, 'dddd'),
  ];

  it('prefers a matching name over a nearer length', () => {
    expect(
      likeliestSource({ name: 'Lead Vocals.wav', frames: 1000, fingerprint: 'x' }, sources),
    ).toBe(1);
  });

  it('falls back to the nearest length', () => {
    expect(likeliestSource({ name: 'take 3.wav', frames: 1000, fingerprint: 'x' }, sources)).toBe(
      2,
    );
  });

  it('is -1 with nothing to choose from', () => {
    expect(likeliestSource({ name: 'a.wav', frames: 1, fingerprint: 'x' }, [])).toBe(-1);
  });
});

describe('fitFrames', () => {
  it('cuts long audio short and pads short audio with silence', () => {
    expect([...fitFrames(new Float32Array([1, 2, 3]), 2)]).toEqual([1, 2]);
    expect([...fitFrames(new Float32Array([1, 2]), 4)]).toEqual([1, 2, 0, 0]);
  });
});
