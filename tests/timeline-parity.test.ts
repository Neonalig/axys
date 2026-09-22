// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `core/timeline.ts` against the compiled core, over the fixtures that move.
 *
 * The web build computes bars and beats in TypeScript so a draw call never crosses the
 * WebAssembly boundary, which leaves two implementations of one contract. This is the test that
 * keeps them the same: every assertion compares the TypeScript answer against the core's own,
 * so a change to either that the other does not follow fails here rather than on screen.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { barBeatAt, beatGrid } from '../web/src/core/timeline.js';
import type { BeatGridPoint, EditState, TimelineMap } from '../web/src/core/types.js';
import { analyseFixture, loadTestCore, readMidiFixture, type TestCore } from './helpers/core.js';

/** Name of a MIDI fixture inside `fixtures/midi/`, without the extension. */
type MidiFixture = 'melody' | 'tempo-change' | 'meter-change' | 'pickup';

const FIXTURES: readonly MidiFixture[] = ['melody', 'tempo-change', 'meter-change', 'pickup'];

/**
 * Tolerance on a time the two implementations reach by different routes, in seconds.
 *
 * Both integrate the same tempo map piecewise in f64, so they agree to the last bits rather
 * than approximately. One nanosecond is 1/20800 of a sample at 48 kHz.
 */
const TIME_EPSILON = 1e-9;

/** A live editing session, which the generated typings only expose through `create`. */
type CoreSession = ReturnType<TestCore['Session']['create']>;

let core: TestCore;
let samples: Float32Array;
let sampleRate: number;
let analysis: Awaited<ReturnType<typeof analyseFixture>>['analysis'];
const midiBytes = new Map<MidiFixture, Uint8Array>();

beforeAll(async () => {
  core = await loadTestCore();
  const analysed = await analyseFixture('phrase.wav');
  samples = analysed.samples;
  sampleRate = analysed.sampleRate;
  analysis = analysed.analysis;
  for (const fixture of FIXTURES) {
    midiBytes.set(fixture, await readMidiFixture(`${fixture}.mid`));
  }
});

/** Builds a fresh session over the shared phrase analysis with `fixture` loaded. */
function sessionWith(fixture: MidiFixture): CoreSession {
  const session = core.Session.create(samples, sampleRate, 'phrase', analysis, '');
  const bytes = midiBytes.get(fixture);
  if (!bytes) throw new Error(`fixture ${fixture} was not read`);
  session.loadMidi(bytes);
  return session;
}

/** The timeline the session is holding, as the web build reads it. */
function timelineOf(session: CoreSession): TimelineMap {
  return (JSON.parse(session.stateJson()) as EditState).timeline;
}

describe('the drawn grid matches the core it mirrors', () => {
  for (const fixture of FIXTURES) {
    it(`agrees with the core on every beat of ${fixture}.mid`, () => {
      const session = sessionWith(fixture);
      const timeline = timelineOf(session);
      const expected = JSON.parse(session.beatGridJson(0, 7, 1)) as BeatGridPoint[];
      const actual = beatGrid(timeline, 0, 7, 1);

      expect(actual.length).toBe(expected.length);
      expect(actual.length).toBeGreaterThan(4);
      for (const [index, point] of expected.entries()) {
        const mine = actual[index];
        expect(mine).toBeDefined();
        if (!mine) continue;
        expect(Math.abs(mine.seconds - point.seconds)).toBeLessThan(TIME_EPSILON);
        expect(Math.abs(mine.tick - point.tick)).toBeLessThan(1e-6);
        expect(mine.bar).toBe(point.bar);
        expect(Math.abs(mine.beat - point.beat)).toBeLessThan(1e-9);
        expect(mine.isBarLine).toBe(point.isBarLine);
        expect(mine.isBeat).toBe(point.isBeat);
      }
      session.free();
    });

    it(`agrees with the core on the readout through ${fixture}.mid`, () => {
      const session = sessionWith(fixture);
      const timeline = timelineOf(session);
      for (let seconds = 0; seconds <= 6; seconds += 0.25) {
        const expected = JSON.parse(session.barBeatJson(seconds)) as {
          bar: number;
          beat: number;
          beatsInBar: number;
          beatUnit: number;
        };
        const mine = barBeatAt(timeline, seconds);
        expect(mine.bar).toBe(expected.bar);
        expect(Math.abs(mine.beat - expected.beat)).toBeLessThan(1e-9);
        expect(mine.beatsInBar).toBe(expected.beatsInBar);
        expect(mine.beatUnit).toBe(expected.beatUnit);
      }
      session.free();
    });
  }

  it('divides a beat the way the core does', () => {
    const session = sessionWith('meter-change');
    const timeline = timelineOf(session);
    for (const division of [2, 3, 4]) {
      const expected = JSON.parse(session.beatGridJson(0, 5, division)) as BeatGridPoint[];
      const actual = beatGrid(timeline, 0, 5, division);
      expect(actual.length).toBe(expected.length);
      for (const [index, point] of expected.entries()) {
        const mine = actual[index];
        expect(mine).toBeDefined();
        if (!mine) continue;
        expect(Math.abs(mine.seconds - point.seconds)).toBeLessThan(TIME_EPSILON);
      }
    }
    session.free();
  });
});
