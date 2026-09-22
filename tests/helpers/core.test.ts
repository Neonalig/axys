// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Smoke test for the shared harness: the real core loads in Node, the WAV decoder reads
 * a fixture, and the detector agrees with the synthesised pitch.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import {
  analyseFixture,
  correlation,
  loadTestCore,
  measureF0,
  medianMidi,
  peak,
  readMidiFixture,
  readWavFixture,
  rms,
  type AnalysedFixture,
  type TestCore,
} from './core';

/** Cents between two fractional MIDI note numbers. */
function cents(a: number, b: number): number {
  return (a - b) * 100;
}

describe('test core harness', () => {
  let core: TestCore;
  let vowel: AnalysedFixture;

  beforeAll(async () => {
    core = await loadTestCore();
    vowel = await analyseFixture('sustained-vowel.wav');
  });

  it('loads the compiled core and reports a version', () => {
    const version = core.coreVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    expect(core.schemaVersion()).toBeGreaterThan(0);
  });

  it('caches the core across calls', async () => {
    expect(await loadTestCore()).toBe(core);
  });

  it('decodes sustained-vowel.wav as 48 kHz mono in range', () => {
    expect(vowel.sampleRate).toBe(48_000);
    // fixtures/README.md: the audio fixtures are 48 kHz 16-bit mono, several seconds long.
    expect(vowel.samples.length).toBeGreaterThan(48_000);
    expect(peak(vowel.samples)).toBeGreaterThan(0.1);
    expect(peak(vowel.samples)).toBeLessThanOrEqual(1);
    expect(rms(vowel.samples)).toBeGreaterThan(0.01);
  });

  it('detects the synthesised C4 within 10 cents', () => {
    const midi = vowel.analysis.midi();
    const times = vowel.analysis.times();
    expect(times.length).toBe(midi.length);
    // The fixture is a steady MIDI 60; 10 cents is the tolerance docs/testing.md asks of
    // this harness, twice the 5 cents the DSP suite itself asserts, so a harness bug is
    // caught while normal detector jitter is not reported as one.
    expect(Math.abs(cents(medianMidi(midi), 60))).toBeLessThan(10);
  });

  it('memoises analysis per fixture name', async () => {
    const again = await analyseFixture('sustained-vowel.wav');
    expect(again).toBe(vowel);
    expect(again.analysis).toBe(vowel.analysis);
  });

  it('measures F0 of raw samples with the same detector', async () => {
    const measured = await measureF0(vowel.samples, vowel.sampleRate);
    expect(measured.times.length).toBe(measured.midi.length);
    // Same input through the same detector, so the reading must land on the fixture's
    // own median rather than merely near it; a hundredth of a semitone allows only for
    // the median of an even frame count.
    expect(Math.abs(measured.midi.length - vowel.analysis.midi().length)).toBeLessThanOrEqual(1);
    expect(medianMidi(measured.midi)).toBeCloseTo(medianMidi(vowel.analysis.midi()), 2);
  });

  it('reads a MIDI fixture the core can parse', async () => {
    const bytes = await readMidiFixture('melody.mid');
    expect(bytes.subarray(0, 4)).toEqual(new Uint8Array([0x4d, 0x54, 0x68, 0x64]));
    const parsed: unknown = JSON.parse(core.parseMidi(bytes));
    expect(parsed).toBeTypeOf('object');
  });

  it('ignores unvoiced frames in medianMidi', () => {
    expect(medianMidi([Number.NaN, 60, Number.NaN, 62, 64])).toBe(62);
    expect(medianMidi([Number.NaN, Number.NaN])).toBeNaN();
    expect(medianMidi([])).toBeNaN();
  });

  it('correlates a buffer with itself and with its inverse', async () => {
    const { samples } = await readWavFixture('sustained-vowel.wav');
    const inverted = samples.map((value) => -value);
    expect(correlation(samples, samples)).toBeCloseTo(1, 6);
    expect(correlation(samples, inverted)).toBeCloseTo(-1, 6);
  });

  it('measures rms and peak against known values', () => {
    expect(rms([1, -1, 1, -1])).toBeCloseTo(1, 12);
    expect(rms([])).toBe(0);
    expect(peak([0.2, -0.7, 0.5])).toBeCloseTo(0.7, 12);
    expect(peak([])).toBe(0);
  });
});
