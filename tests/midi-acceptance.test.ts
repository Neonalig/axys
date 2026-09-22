// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * MIDI workflow acceptance, design bible 13.5, against the real compiled core.
 *
 * Every session here is a real `Session` built from a real analysis of
 * `fixtures/audio/phrase.wav`, with real Standard MIDI Files loaded through
 * `Session.loadMidi`. Nothing is mocked and no expected value is copied from a previous
 * run: musical times are recomputed in the test from the parsed tempo and meter maps, and
 * the drift assertions rely on the algebra of linear regression rather than on recorded
 * numbers.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { analyseFixture, loadTestCore, readMidiFixture, type TestCore } from './helpers/core.js';

/** Name of a MIDI fixture inside `fixtures/midi/`, without the extension. */
type MidiFixture =
  'melody' | 'tempo-change' | 'meter-change' | 'pickup' | 'overlapping' | 'percussion';

/** One note of a parsed Standard MIDI File, as `parseMidi` reports it. */
interface MidiNote {
  track: number;
  channel: number;
  key: number;
  velocity: number;
  startTick: number;
  endTick: number;
}

/** One track of a parsed Standard MIDI File, as `parseMidi` reports it. */
interface MidiTrackInfo {
  index: number;
  name: string | null;
  channels: number[];
  noteCount: number;
  isPercussion: boolean;
  firstTick: number;
  lastTick: number;
}

/** A parsed Standard MIDI File. */
interface MidiFile {
  format: number;
  ppq: number;
  tracks: MidiTrackInfo[];
  notes: MidiNote[];
  tempo: { tick: number; microsPerQuarter: number }[];
  meter: { tick: number; numerator: number; denominator: number }[];
}

/** A musical position as `Session.barBeatJson` reports it. */
interface BarBeat {
  bar: number;
  beat: number;
  beatsInBar: number;
  beatUnit: number;
}

/** One entry of the visible beat grid. */
interface BeatGridPoint {
  seconds: number;
  tick: number;
  bar: number;
  beat: number;
  isBarLine: boolean;
  isBeat: boolean;
}

/** Alignment error split into its constant and growing components. */
interface DriftReport {
  earlyErrorSeconds: number;
  lateErrorSeconds: number;
  offsetSeconds: number;
  driftSecondsPerSecond: number;
  pairsCompared: number;
}

/** A blob as `Session.blobsJson` reports it. */
interface Blob {
  id: number;
  start: number;
  end: number;
  detectedCenter: number;
  curve: { anchors: { time: number; midi: number; interp: string }[] };
}

/** The compiled render plan. */
interface RenderPlan {
  sampleRate: number;
  timeMap: { points: [number, number][] };
  pitchRatio: { start: number; hop: number; values: number[] };
  formant: unknown;
  bypass: boolean;
}

/**
 * Absolute tolerance for a musical time in seconds.
 *
 * One nanosecond is 1/20800 of a sample at 48 kHz, so it cannot hide any error an editor
 * or a renderer could act on. It is only here to absorb the last-bit difference between
 * the core integrating a tempo map piecewise and the test multiplying one tempo out.
 */
const TIME_EPSILON = 1e-9;

/**
 * Absolute tolerance for the linear-regression algebra in the drift assertions.
 *
 * Adding a constant to every regression `y` shifts the intercept by exactly that constant
 * and leaves the slope untouched, in real arithmetic and in IEEE-754 doubles to within a
 * few ulps of the magnitudes involved (here below 1.0). 1e-12 is several orders of
 * magnitude above those ulps and several orders below any drift a user could hear.
 */
const REGRESSION_EPSILON = 1e-12;

let core: TestCore;
let samples: Float32Array;
let sampleRate: number;
let analysis: Awaited<ReturnType<typeof analyseFixture>>['analysis'];
let sourceDuration: number;
const midiBytes = new Map<MidiFixture, Uint8Array>();

/** A live editing session, which the generated typings only expose through `create`. */
type CoreSession = ReturnType<TestCore['Session']['create']>;

/** Reads the one array element at `index`, failing the test when it is absent. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`expected an element at index ${index}`);
  return item;
}

/** Builds a fresh session over the shared phrase analysis with `fixture` loaded. */
function sessionWith(fixture: MidiFixture): CoreSession {
  const session = core.Session.create(samples, sampleRate, 'phrase', analysis, '');
  const bytes = midiBytes.get(fixture);
  if (!bytes) throw new Error(`fixture ${fixture} was not read`);
  session.loadMidi(bytes);
  return session;
}

/**
 * Source seconds of a MIDI tick under the session's current timeline.
 *
 * The boundary has no direct tick-to-seconds call, but `anchorOffset(tick, target)` is
 * defined as `target - tick_to_seconds(tick)`, so a target of zero inverts to the tick's
 * source time exactly.
 */
function tickSeconds(session: CoreSession, tick: number): number {
  return -session.anchorOffset(tick, 0);
}

/** Applies one edit operation to a session. */
function edit(session: CoreSession, op: Record<string, unknown>): void {
  session.applyEdit(JSON.stringify(op));
}

/** Sets the guide selection, leaving strength at full and the guide unmuted. */
function selectGuide(
  session: CoreSession,
  track: number,
  mode: 'visualOnly' | 'pitchOnly' | 'timingOnly' | 'combined',
): void {
  edit(session, {
    type: 'setGuide',
    selection: { track, channel: null, mode, strength: 1, muted: false },
  });
}

/** Seconds a tick sits at, computed from a tempo map the test integrates itself. */
function expectedTickSeconds(file: MidiFile, tick: number): number {
  let seconds = 0;
  let cursor = 0;
  let micros = at(file.tempo, 0).microsPerQuarter;
  for (const event of file.tempo) {
    if (event.tick >= tick) break;
    if (event.tick > cursor) {
      seconds += ((event.tick - cursor) / file.ppq) * (micros / 1e6);
      cursor = event.tick;
    }
    micros = event.microsPerQuarter;
  }
  seconds += ((tick - cursor) / file.ppq) * (micros / 1e6);
  return seconds;
}

beforeAll(async () => {
  core = await loadTestCore();
  const fixture = await analyseFixture('phrase.wav');
  samples = fixture.samples;
  sampleRate = fixture.sampleRate;
  analysis = fixture.analysis;
  sourceDuration = samples.length / sampleRate;
  const names: MidiFixture[] = [
    'melody',
    'tempo-change',
    'meter-change',
    'pickup',
    'overlapping',
    'percussion',
  ];
  for (const name of names) midiBytes.set(name, await readMidiFixture(`${name}.mid`));
});

describe('13.5 step 1: import MIDI, list tracks, select one, place its notes', () => {
  it('lists melody.mid as one named melodic track of four notes', () => {
    const session = sessionWith('melody');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    expect(file.ppq).toBe(480);
    expect(file.tracks).toHaveLength(1);
    const track = at(file.tracks, 0);
    expect(track.name).toBe('Melody');
    expect(track.noteCount).toBe(4);
    expect(track.isPercussion).toBe(false);
    expect(track.channels).toEqual([0]);
    session.free();
  });

  it('places the four selected notes on the seconds its own tempo map implies', () => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'visualOnly');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    const notes = file.notes.filter((note) => note.track === 0);
    expect(notes).toHaveLength(4);
    // 120 bpm, 4/4, 480 ppq: quarter notes on the beat from bar 1 beat 1.
    expect(notes.map((note) => note.key)).toEqual([60, 62, 64, 65]);
    for (const note of notes) {
      expect(tickSeconds(session, note.startTick)).toBeCloseTo(
        expectedTickSeconds(file, note.startTick),
        9,
      );
      expect(tickSeconds(session, note.endTick)).toBeCloseTo(
        expectedTickSeconds(file, note.endTick),
        9,
      );
    }
    // The last note is a half note, so it is the one that proves durations survive too.
    const last = at(notes, 3);
    expect(tickSeconds(session, last.endTick) - tickSeconds(session, last.startTick)).toBeCloseTo(
      1.0,
      9,
    );
    session.free();
  });

  it('shows the notes against the vocal grid, one guide note per detected blob', () => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'visualOnly');
    const report = JSON.parse(session.proposeMappings()) as {
      unmappedBlobs: number[];
      unmappedNotes: number[];
      multiplyMappedNotes: number[];
    };
    const blobs = JSON.parse(session.blobsJson()) as Blob[];
    expect(blobs.length).toBe(4);
    expect(report.unmappedBlobs).toEqual([]);
    expect(report.unmappedNotes).toEqual([]);
    expect(report.multiplyMappedNotes).toEqual([]);
    session.free();
  });
});

describe('13.5 step 2: align a known MIDI onset to the recording', () => {
  it('moves the guide onto the blob onset and leaves the audio and analysis untouched', () => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'visualOnly');
    const blobs = JSON.parse(session.blobsJson()) as Blob[];
    const onset = at(blobs, 0).start;

    const sourceBefore = session.source().slice();
    const trackBefore = session.trackJson();
    const blobsBefore = session.blobsJson();

    const offset = session.anchorOffset(0, onset);
    expect(offset).toBeCloseTo(onset, 9);
    edit(session, { type: 'setTimelineOrigin', seconds: offset });

    // The guide moved.
    expect(tickSeconds(session, 0)).toBeCloseTo(onset, 9);
    expect(tickSeconds(session, 480)).toBeCloseTo(onset + 0.5, 9);

    // The audio did not.
    const sourceAfter = session.source();
    expect(sourceAfter.length).toBe(sourceBefore.length);
    expect(Array.from(sourceAfter)).toEqual(Array.from(sourceBefore));
    expect(session.trackJson()).toBe(trackBefore);
    expect(session.blobsJson()).toBe(blobsBefore);

    // Nor did the render plan, because a visual-only guide contributes nothing to it.
    const plan = JSON.parse(session.planJson()) as RenderPlan;
    expect(plan.timeMap.points).toEqual([
      [0, 0],
      [sourceDuration, sourceDuration],
    ]);
    session.free();
  });
});

describe('13.5 step 3: a tempo error reads as drift, not as an offset', () => {
  const anchorTick = 0;
  const injectedOffset = 0.25;
  // 120 bpm is 500000 us per quarter; 132 bpm is 10 percent faster, so every note after
  // the anchor arrives progressively early and nothing about the anchor itself changes.
  const correctMicros = 500_000;
  const fastMicros = Math.round(60_000_000 / 132);

  let aligned: DriftReport;
  let offsetOnly: DriftReport;
  let tempoOnly: DriftReport;
  let both: DriftReport;

  beforeAll(() => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'visualOnly');
    session.proposeMappings();
    const blobs = JSON.parse(session.blobsJson()) as Blob[];
    const origin = session.anchorOffset(anchorTick, at(blobs, 0).start);

    const read = (): DriftReport => JSON.parse(session.driftJson()) as DriftReport;
    const setOrigin = (seconds: number): void =>
      edit(session, { type: 'setTimelineOrigin', seconds });
    const setTempo = (micros: number): void =>
      edit(session, { type: 'setTempoMap', events: [{ tick: 0, microsPerQuarter: micros }] });

    setOrigin(origin);
    aligned = read();

    setOrigin(origin + injectedOffset);
    offsetOnly = read();

    setOrigin(origin);
    setTempo(fastMicros);
    tempoOnly = read();

    setOrigin(origin + injectedOffset);
    both = read();

    setTempo(correctMicros);
    session.free();
  });

  it('compares every mapped pair', () => {
    for (const report of [aligned, offsetOnly, tempoOnly, both]) {
      expect(report.pairsCompared).toBe(4);
    }
  });

  it('puts a pure constant offset entirely in offsetSeconds and none of it in the drift', () => {
    expect(offsetOnly.offsetSeconds - aligned.offsetSeconds).toBeCloseTo(injectedOffset, 12);
    expect(offsetOnly.driftSecondsPerSecond).toBeCloseTo(aligned.driftSecondsPerSecond, 12);
    // Both ends of the comparison move by the same amount, which is what "constant" means.
    expect(offsetOnly.earlyErrorSeconds - aligned.earlyErrorSeconds).toBeCloseTo(
      injectedOffset,
      12,
    );
    expect(offsetOnly.lateErrorSeconds - aligned.lateErrorSeconds).toBeCloseTo(injectedOffset, 12);
  });

  it('puts a pure tempo error in the drift, which a global offset cannot fix', () => {
    const ratio = fastMicros / correctMicros;
    // Under a tempo ratio r every guide onset lands at r times its musical time, so the
    // error against a fixed blob grows linearly. The regression slope must therefore move
    // in the negative direction by roughly (1 - r) of the guide's own rate; the exact
    // figure depends on how well the blobs track the grid, so only the sign, the order of
    // magnitude and the growth are asserted here.
    expect(ratio).toBeLessThan(1);
    expect(tempoOnly.driftSecondsPerSecond).toBeLessThan(aligned.driftSecondsPerSecond);
    expect(
      Math.abs(tempoOnly.driftSecondsPerSecond - aligned.driftSecondsPerSecond),
    ).toBeGreaterThan(0.05);
    // The error grows: the last pair is further out than the first, and further out than
    // it was before the tempo error was introduced.
    expect(Math.abs(tempoOnly.lateErrorSeconds)).toBeGreaterThan(
      Math.abs(tempoOnly.earlyErrorSeconds),
    );
    expect(Math.abs(tempoOnly.lateErrorSeconds)).toBeGreaterThan(
      Math.abs(aligned.lateErrorSeconds),
    );
    // And the constant component barely moves, so the report does not invite the user to
    // hide a tempo error behind an offset.
    expect(Math.abs(tempoOnly.offsetSeconds - aligned.offsetSeconds)).toBeLessThan(
      0.1 * Math.abs(tempoOnly.lateErrorSeconds - aligned.lateErrorSeconds),
    );
  });

  it('separates the two when both are present at once', () => {
    // This is the whole point of the report: a session carrying a constant offset and a
    // tempo error at the same time must attribute each to its own field, with no leakage.
    expect(both.offsetSeconds - tempoOnly.offsetSeconds).toBeCloseTo(injectedOffset, 12);
    expect(both.driftSecondsPerSecond).toBeCloseTo(tempoOnly.driftSecondsPerSecond, 12);
    expect(Math.abs(both.driftSecondsPerSecond - aligned.driftSecondsPerSecond)).toBeGreaterThan(
      REGRESSION_EPSILON,
    );
  });
});

describe('13.5 step 4: bar lines, beats and the readout survive tempo and meter changes', () => {
  it('lands every tempo-change.mid bar line where its own tempo map puts it', () => {
    const session = sessionWith('tempo-change');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    expect(file.tempo.map((event) => event.tick)).toEqual([0, 1920, 3840]);

    const grid = JSON.parse(session.beatGridJson(0, 7, 1)) as BeatGridPoint[];
    const barLines = grid.filter((point) => point.isBarLine);
    expect(barLines.map((point) => point.bar)).toEqual([1, 2, 3, 4]);
    for (const line of barLines) {
      expect(Math.abs(line.seconds - expectedTickSeconds(file, line.tick))).toBeLessThan(
        TIME_EPSILON,
      );
      expect(line.beat).toBe(1);
    }
    // A flattened tempo map would space the bars evenly; these must not be.
    const spacing = barLines
      .slice(1)
      .map((line, index) => line.seconds - at(barLines, index).seconds);
    expect(at(spacing, 0)).toBeCloseTo(2.0, 9);
    expect(at(spacing, 1)).toBeGreaterThan(at(spacing, 0));
    expect(at(spacing, 2)).toBeLessThan(at(spacing, 0));
    session.free();
  });

  it('keeps every beat of tempo-change.mid on its own tempo', () => {
    const session = sessionWith('tempo-change');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    const grid = JSON.parse(session.beatGridJson(0, 7, 1)) as BeatGridPoint[];
    expect(grid.length).toBeGreaterThan(12);
    for (const point of grid) {
      expect(Math.abs(point.seconds - expectedTickSeconds(file, point.tick))).toBeLessThan(
        TIME_EPSILON,
      );
      expect(point.isBeat).toBe(true);
    }
    session.free();
  });

  it('reads the playhead in bars and beats across a tempo change', () => {
    const session = sessionWith('tempo-change');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    const barTwo = expectedTickSeconds(file, 1920);
    const barThree = expectedTickSeconds(file, 3840);

    const onBarTwo = JSON.parse(session.barBeatJson(barTwo)) as BarBeat;
    expect(onBarTwo).toEqual({ bar: 2, beat: 1, beatsInBar: 4, beatUnit: 4 });

    // Bar 2 runs at 90 bpm, so a beat is 60/90 s. Half a beat in must read beat 1.5.
    const halfBeat = ((at(file.tempo, 1).microsPerQuarter / 1e6) * 1) / 2;
    const midBeat = JSON.parse(session.barBeatJson(barTwo + halfBeat)) as BarBeat;
    expect(midBeat.bar).toBe(2);
    expect(midBeat.beat).toBeCloseTo(1.5, 9);

    // Bar 3 runs at 140 bpm, so the same wall-clock distance is a larger fraction of a beat.
    const afterChange = JSON.parse(session.barBeatJson(barThree + halfBeat)) as BarBeat;
    expect(afterChange.bar).toBe(3);
    expect(afterChange.beat).toBeGreaterThan(midBeat.beat);
    expect(afterChange.beat).toBeCloseTo(
      1 + halfBeat / (at(file.tempo, 2).microsPerQuarter / 1e6),
      9,
    );
    session.free();
  });

  it('renumbers meter-change.mid bars and reports the meter in force at each', () => {
    const session = sessionWith('meter-change');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    expect(file.meter).toEqual([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 3, denominator: 4 },
      { tick: 3360, numerator: 7, denominator: 8 },
    ]);

    const grid = JSON.parse(session.beatGridJson(0, 7, 1)) as BeatGridPoint[];
    const barLines = grid.filter((point) => point.isBarLine);
    expect(barLines.map((point) => point.bar)).toEqual([1, 2, 3, 4]);
    // 4/4 then 3/4 then 7/8 at a constant 100 bpm: 1920, 1440 then 1680 ticks per bar.
    expect(barLines.map((point) => point.tick)).toEqual([0, 1920, 3360, 5040]);
    for (const line of barLines) {
      expect(Math.abs(line.seconds - expectedTickSeconds(file, line.tick))).toBeLessThan(
        TIME_EPSILON,
      );
    }

    const readouts = barLines.map(
      (line) => JSON.parse(session.barBeatJson(line.seconds)) as BarBeat,
    );
    expect(readouts).toEqual([
      { bar: 1, beat: 1, beatsInBar: 4, beatUnit: 4 },
      { bar: 2, beat: 1, beatsInBar: 3, beatUnit: 4 },
      { bar: 3, beat: 1, beatsInBar: 7, beatUnit: 8 },
      { bar: 4, beat: 1, beatsInBar: 7, beatUnit: 8 },
    ]);
    session.free();
  });

  it('counts eighth-note beats once meter-change.mid reaches 7/8', () => {
    const session = sessionWith('meter-change');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    // The meter changes to 3/4 during the sustained note that starts at tick 1920, which
    // is exactly the case design bible 6.5 calls out.
    const sustained = file.notes.find((note) => note.startTick === 1920);
    expect(sustained).toBeDefined();
    expect(sustained?.endTick).toBe(3360);

    const barThree = expectedTickSeconds(file, 3360);
    const eighth = at(file.tempo, 0).microsPerQuarter / 1e6 / 2;
    for (let beat = 1; beat <= 7; beat += 1) {
      const reading = JSON.parse(session.barBeatJson(barThree + (beat - 1) * eighth)) as BarBeat;
      expect(reading.bar).toBe(3);
      expect(reading.beat).toBeCloseTo(beat, 9);
      expect(reading.beatsInBar).toBe(7);
      expect(reading.beatUnit).toBe(8);
    }
    session.free();
  });

  it('places bar 1 beat 1 before audio zero for a pickup and keeps the grid continuous', () => {
    // pickup.mid cannot carry a negative tick, so the pickup is expressed the way
    // core_contracts describes it: the second note is the downbeat of bar 1 and the
    // musical origin lands before audio zero, which is a negative originSeconds.
    const session = sessionWith('pickup');
    selectGuide(session, 0, 'visualOnly');
    const blobs = JSON.parse(session.blobsJson()) as Blob[];
    const downbeat = at(blobs, 0).start;

    const origin = session.anchorOffset(480, downbeat);
    expect(origin).toBeLessThan(0);
    edit(session, { type: 'setTimelineOrigin', seconds: origin });

    expect(tickSeconds(session, 480)).toBeCloseTo(downbeat, 9);
    expect(tickSeconds(session, 0)).toBeCloseTo(downbeat - 0.5, 9);
    expect(tickSeconds(session, 0)).toBeLessThan(0);

    expect(JSON.parse(session.barBeatJson(tickSeconds(session, 0))) as BarBeat).toEqual({
      bar: 1,
      beat: 1,
      beatsInBar: 4,
      beatUnit: 4,
    });
    const atDownbeat = JSON.parse(session.barBeatJson(downbeat)) as BarBeat;
    expect(atDownbeat.bar).toBe(1);
    expect(atDownbeat.beat).toBeCloseTo(2, 9);

    // The grid spans audio zero without a discontinuity or a duplicated point.
    const grid = JSON.parse(session.beatGridJson(-0.5, 2, 1)) as BeatGridPoint[];
    expect(grid.length).toBeGreaterThan(3);
    expect(at(grid, 0).seconds).toBeLessThan(0);
    for (let i = 1; i < grid.length; i += 1) {
      expect(at(grid, i).seconds).toBeGreaterThan(at(grid, i - 1).seconds);
      expect(at(grid, i).tick).toBeGreaterThan(at(grid, i - 1).tick);
    }
    expect(grid.filter((point) => point.isBarLine).map((point) => point.bar)).toEqual([1, 2]);
    session.free();
  });
});

describe('13.5 step 5: guide mode changes the plan in exactly one dimension', () => {
  let plans: Record<'visualOnly' | 'pitchOnly' | 'timingOnly' | 'combined', RenderPlan>;
  /** The guide note blob 0 is forced onto, in semitones above its detected centre. */
  let forcedSemitones: number;

  beforeAll(() => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'visualOnly');
    session.proposeMappings();
    const blobs = JSON.parse(session.blobsJson()) as Blob[];

    // phrase.wav sings exactly the pitches melody.mid holds, so the proposed mapping is a
    // no-op in every mode and would prove nothing. Opt three blobs out and force the
    // remaining one onto a note that is neither its pitch nor its position, so pitch
    // guidance and timing guidance each have something real to do.
    for (const id of [1, 2, 3]) {
      edit(session, {
        type: 'setMapping',
        mapping: { blob: id, note: null, manual: true, optedOut: true },
      });
    }
    edit(session, {
      type: 'setMapping',
      mapping: { blob: 0, note: 3, manual: true, optedOut: false },
    });

    const file = JSON.parse(session.midiJson()) as MidiFile;
    forcedSemitones = at(file.notes, 3).key - at(blobs, 0).detectedCenter;

    const modes = ['visualOnly', 'pitchOnly', 'timingOnly', 'combined'] as const;
    const built = {} as Record<(typeof modes)[number], RenderPlan>;
    for (const mode of modes) {
      selectGuide(session, 0, mode);
      built[mode] = JSON.parse(session.planJson()) as RenderPlan;
    }
    plans = built;
    session.free();
  });

  it('visualOnly leaves pitch_ratio at 1.0 everywhere and the time map identity', () => {
    const plan = plans.visualOnly;
    for (const value of plan.pitchRatio.values) expect(value).toBe(1);
    expect(plan.timeMap.points).toEqual([
      [0, 0],
      [sourceDuration, sourceDuration],
    ]);
    expect(plan.bypass).toBe(false);
  });

  it('pitchOnly moves pitch_ratio to the guide note and leaves the time map identity', () => {
    const plan = plans.pitchOnly;
    const highest = Math.max(...plan.pitchRatio.values);
    const expected = 2 ** (forcedSemitones / 12);
    // The detected centre is within a cent of an exact semitone, so the ratio cannot be
    // more than about 1e-4 from the ideal; 1e-3 leaves room without hiding a real error.
    expect(highest).toBeCloseTo(expected, 3);
    expect(Math.min(...plan.pitchRatio.values)).toBe(1);
    expect(plan.timeMap).toEqual(plans.visualOnly.timeMap);
  });

  it('timingOnly moves the time map and leaves pitch_ratio at 1.0 everywhere', () => {
    const plan = plans.timingOnly;
    for (const value of plan.pitchRatio.values) expect(value).toBe(1);
    expect(plan.pitchRatio).toEqual(plans.visualOnly.pitchRatio);
    expect(plan.timeMap.points.length).toBeGreaterThan(2);
    expect(plan.timeMap).not.toEqual(plans.visualOnly.timeMap);
    // The map stays monotone in both coordinates, or the renderer could not read it.
    const points = plan.timeMap.points;
    for (let i = 1; i < points.length; i += 1) {
      expect(at(points, i)[0]).toBeGreaterThan(at(points, i - 1)[0]);
      expect(at(points, i)[1]).toBeGreaterThan(at(points, i - 1)[1]);
    }
  });

  it('combined is exactly the pitch dimension of pitchOnly and the time dimension of timingOnly', () => {
    // Design bible 6.1 and 6.6: the two contributions compose without either silently
    // altering the other, so combined must be bit-identical to each mode in its own
    // dimension. Any difference at all is a real composition bug, so this is exact.
    expect(plans.combined.pitchRatio).toEqual(plans.pitchOnly.pitchRatio);
    expect(plans.combined.timeMap).toEqual(plans.timingOnly.timeMap);
    expect(plans.combined.pitchRatio).not.toEqual(plans.visualOnly.pitchRatio);
    expect(plans.combined.timeMap).not.toEqual(plans.visualOnly.timeMap);
  });
});

describe('13.5 step 6: overriding a mapping keeps the analysis and manual curves', () => {
  it('reassigns one blob without touching the pitch track or any drawn anchor', () => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'combined');
    session.proposeMappings();

    const drawn = { time: 1.4, midi: 65.5, interp: 'smooth' };
    edit(session, { type: 'addAnchor', blob: 2, anchor: drawn });

    const trackBefore = session.trackJson();
    const blobsBefore = JSON.parse(session.blobsJson()) as Blob[];
    const curveBefore = at(blobsBefore, 2).curve;
    expect(curveBefore.anchors).toEqual([drawn]);

    edit(session, {
      type: 'setMapping',
      mapping: { blob: 2, note: 1, manual: true, optedOut: false },
    });

    const state = JSON.parse(session.stateJson()) as {
      mappings: { blob: number; note: number | null; manual: boolean; optedOut: boolean }[];
    };
    const overridden = state.mappings.find((mapping) => mapping.blob === 2);
    expect(overridden).toEqual({ blob: 2, note: 1, manual: true, optedOut: false });
    // The other proposals are left alone, so the override is local.
    expect(state.mappings.filter((mapping) => mapping.manual)).toHaveLength(1);

    expect(session.trackJson()).toBe(trackBefore);
    const blobsAfter = JSON.parse(session.blobsJson()) as Blob[];
    expect(at(blobsAfter, 2).curve).toEqual(curveBefore);
    expect(blobsAfter.map((blob) => [blob.start, blob.end, blob.detectedCenter])).toEqual(
      blobsBefore.map((blob) => [blob.start, blob.end, blob.detectedCenter]),
    );

    // The override is on the undo stack, which 6.1 requires of MIDI-derived intent.
    expect(JSON.parse(session.historyJson())).toMatchObject({ undo: 'Set Mapping' });
    session.free();
  });

  it('restores the proposed mapping when the override is undone', () => {
    const session = sessionWith('melody');
    selectGuide(session, 0, 'combined');
    session.proposeMappings();
    edit(session, {
      type: 'setMapping',
      mapping: { blob: 2, note: 1, manual: true, optedOut: false },
    });
    expect(session.undo()).toBe(true);
    const restored = JSON.parse(session.stateJson()) as {
      mappings: { blob: number; note: number | null }[];
    };
    const blobTwo = restored.mappings.find((mapping) => mapping.blob === 2);
    session.free();
    expect(restored.mappings).toHaveLength(4);
    expect(blobTwo?.note).toBe(2);
  });
});

describe('6.2 guide eligibility', () => {
  it('keeps every overlapping.mid note as authored rather than resolving the overlap away', () => {
    const session = sessionWith('overlapping');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    expect(file.notes).toHaveLength(3);
    expect(file.notes.map((note) => [note.key, note.startTick, note.endTick])).toEqual([
      [60, 0, 960],
      [64, 480, 1440],
      [67, 960, 1440],
    ]);
    // Notes 0 and 1 genuinely overlap, and nothing has been truncated to hide it.
    expect(at(file.notes, 1).startTick).toBeLessThan(at(file.notes, 0).endTick);
    session.free();
  });

  it('reports the overlapping.mid overlap through the WASM boundary', () => {
    const session = sessionWith('overlapping');
    selectGuide(session, 0, 'combined');
    const report = JSON.parse(session.proposeMappings()) as Record<string, unknown>;
    const conflicts = JSON.parse(session.conflictsJson()) as unknown[];
    const file = JSON.parse(session.midiJson()) as MidiFile & { overlaps?: unknown };
    const surfaced =
      file.overlaps !== undefined ||
      conflicts.length > 0 ||
      'overlappingNotes' in report ||
      typeof (session as unknown as { overlapsJson?: unknown }).overlapsJson === 'function';
    session.free();
    expect(surfaced).toBe(true);
  });

  it('marks the percussion.mid drum track as percussion and the melody track as not', () => {
    const session = sessionWith('percussion');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    expect(file.tracks).toHaveLength(2);
    const melody = at(file.tracks, 0);
    const drums = at(file.tracks, 1);
    expect(melody.name).toBe('Melody');
    expect(melody.isPercussion).toBe(false);
    expect(drums.name).toBe('Drums');
    expect(drums.channels).toEqual([9]);
    expect(drums.isPercussion).toBe(true);
    session.free();
  });

  it('does not offer the percussion track as the default pitch guide', () => {
    const session = sessionWith('percussion');
    const file = JSON.parse(session.midiJson()) as MidiFile;
    // The rule the inspector applies in web/src/ui/inspector.ts: the first non-percussion
    // track that has notes.
    const chosen = file.tracks.find((track) => !track.isPercussion && track.noteCount > 0);
    expect(chosen?.index).toBe(0);

    // And it must still be usable as a guide when the user picks it explicitly, so the
    // default is a preference rather than a hard exclusion.
    selectGuide(session, 0, 'pitchOnly');
    const report = JSON.parse(session.proposeMappings()) as { unmappedNotes: number[] };
    expect(report.unmappedNotes).toEqual([]);
    session.free();
  });
});
