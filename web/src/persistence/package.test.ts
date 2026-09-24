// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import {
  decodeWav,
  encodeWav,
  exactDepth,
  isPackage,
  packProject,
  unpackProject,
} from './package.js';

/** Samples that are whole steps of an n-bit file. */
function steps(bits: number, values: readonly number[]): Float32Array {
  return new Float32Array(values.map((value) => value / 2 ** (bits - 1)));
}

describe('packProject', () => {
  it('round-trips the document and every sample bit for bit', async () => {
    const mono = new Float32Array([0, 0.25, -1, 1e-30, 0.1]);
    const left = steps(16, [16384, -16384, 1]);
    const right = steps(16, [4096, 24576, -1]);
    const progress: number[] = [];
    const blob = await packProject(
      '{"name":"Take"}',
      [
        { key: 'aaaa', name: 'Lead Vocals.wav', sampleRate: 48000, channels: [mono] },
        {
          key: 'bbbb-reference',
          name: 'Lead Vocals.wav',
          sampleRate: 48000,
          channels: [left, right],
        },
      ],
      (done) => progress.push(done),
    );
    const file = new File([blob], 'Take.axys');
    expect(await isPackage(file)).toBe(true);
    expect(progress.at(-1)).toBe(1);

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

describe('encodeWav', () => {
  it('writes 16-bit audio at 16 bits, the size of the file it came from', async () => {
    const channels = [steps(16, [1, -2, 32767, -32768]), steps(16, [0, 5, -5, 100])];
    expect(await exactDepth(channels)).toBe(16);
    const { data } = await encodeWav(channels, 44100);
    expect(data.length).toBe(44 + 4 * 2 * 2);
    const decoded = await decodeWav(data);
    expect(decoded.sampleRate).toBe(44100);
    expect(decoded.channels.map((channel) => [...channel])).toEqual(
      channels.map((channel) => [...channel]),
    );
  });

  it('keeps 16-bit channels mixed to mono exact at 24 bits', async () => {
    const left = steps(16, [1, 3, -7]);
    const right = steps(16, [0, 4, -8]);
    const mono = new Float32Array(
      left.map((sample, index) => (sample + (right[index] ?? 0)) * 0.5),
    );
    expect(await exactDepth([mono])).toBe(24);
    const decoded = await decodeWav((await encodeWav([mono], 48000)).data);
    expect([...(decoded.channels[0] ?? [])]).toEqual([...mono]);
  });

  it('writes audio with finer steps as float', async () => {
    const channels = [new Float32Array([0.1, 0.2, 0.3])];
    expect(await exactDepth(channels)).toBe(32);
    const decoded = await decodeWav((await encodeWav(channels, 48000)).data);
    expect([...(decoded.channels[0] ?? [])]).toEqual([...(channels[0] ?? [])]);
  });
});
