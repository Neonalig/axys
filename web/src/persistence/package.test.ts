// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  decodeFloatWav,
  encodeFloatWav,
  isPackage,
  packProject,
  unpackProject,
} from './package.js';

describe('packProject', () => {
  it('round-trips the document and every sample bit for bit', async () => {
    const mono = new Float32Array([0, -0, 0.25, -1, 1e-30, 0.1]);
    const left = new Float32Array([0.5, -0.5]);
    const right = new Float32Array([0.125, 0.75]);
    const blob = packProject('{"name":"Take"}', [
      { key: 'aaaa', name: 'Lead Vocals.wav', sampleRate: 48000, channels: [mono] },
      {
        key: 'bbbb-reference',
        name: 'Lead Vocals.wav',
        sampleRate: 48000,
        channels: [left, right],
      },
    ]);
    const file = new File([blob], 'Take.axys');
    expect(await isPackage(file)).toBe(true);

    const unpacked = await unpackProject(file);
    expect(unpacked.json).toBe('{"name":"Take"}');
    expect(unpacked.media.map((item) => item.key)).toEqual(['aaaa', 'bbbb-reference']);
    const [first, second] = unpacked.media;
    expect(new Uint32Array(first?.channels[0]?.buffer ?? new ArrayBuffer(0))).toEqual(
      new Uint32Array(mono.buffer),
    );
    expect(second?.channels.map((channel) => [...channel])).toEqual([[...left], [...right]]);
    expect(new Set(unpacked.media.map((item) => item.name)).size).toBe(2);
  });

  it('refuses a file that is not a package', async () => {
    await expect(unpackProject(new File(['not a zip'], 'x.axys'))).rejects.toThrow(
      'is not an Axys project',
    );
    expect(await isPackage(new File(['{}'], 'x.axys.json'))).toBe(false);
  });
});

describe('encodeFloatWav', () => {
  it('reads back what it wrote', () => {
    const channels = [new Float32Array([0.1, 0.2, 0.3])];
    const decoded = decodeFloatWav(encodeFloatWav(channels, 44100));
    expect(decoded.sampleRate).toBe(44100);
    expect([...(decoded.channels[0] ?? [])]).toEqual([...(channels[0] ?? [])]);
  });
});
