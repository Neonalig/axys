// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End-to-end cover for design bible 13.1 "Rust/WASM APIs and TypeScript integration".
 *
 * Every assertion here drives the compiled `axys-wasm` artefact the browser loads, through
 * the generated wasm-bindgen bindings, from Node. Nothing is mocked and no expected value
 * is fabricated: the numbers are either exact by definition (MIDI 69 is A440) or read back
 * out of the engine and cross-checked against a second engine output.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';

import {
  analyseFixture,
  loadTestCore,
  readMidiFixture,
  reopenProject,
  type TestCore,
} from './helpers/core';
import { DEFAULT_F0 } from '../web/src/core/types';

/** One frame of `Session.trackJson`, as `axys_core::analysis::f0::PitchFrame` serialises. */
interface TrackFrameJson {
  time: number;
  f0: number;
  /** `null` rather than `NaN`, because JSON has no NaN. */
  midi: number | null;
  confidence: number;
  rms: number;
  voiced: boolean;
}

/** `Session.trackJson`, as `axys_core::analysis::f0::PitchTrack` serialises. */
interface TrackJson {
  sampleRate: number;
  hopSeconds: number;
  frames: TrackFrameJson[];
}

/** One blob of `Session.blobsJson`, as `axys_core::blob::Blob` serialises. */
interface BlobJson {
  id: number;
  start: number;
  end: number;
  detectedCenter: number;
  pitchOffset: number;
  timeOffset: number;
  timeScale: number;
  subregions: { start: number; end: number; voicing: string }[];
  curve: { anchors: unknown[] };
  excluded: boolean;
}

/** `Session.planJson`, as `axys_core::target::RenderPlan` serialises. */
interface PlanJson {
  sampleRate: number;
  timeMap: { points: [number, number][] };
  pitchRatio: { start: number; hop: number; values: number[] };
  formant: unknown;
}

/** One strip of the mixer, as `axys_core::mixer::MixerStrip` serialises. */
interface StripJson {
  gainDb: number;
  pan: number;
  mute: boolean;
  solo: boolean;
}

/** The part of `Session.stateJson` these tests read. */
interface StateJson {
  mixer: {
    clips: { clip: number; processed: StripJson; original: StripJson }[];
    references: unknown[];
    click: StripJson;
  };
}

/** `Session.historyJson`. */
interface HistoryJson {
  undo: string | null;
  redo: string | null;
}

/** `parseMidi`, as `axys_core::midi::MidiFile` serialises. */
interface MidiFileJson {
  format: number;
  ppq: number;
  tracks: {
    index: number;
    name: string | null;
    instrument: string | null;
    channels: number[];
    noteCount: number;
    isPercussion: boolean;
    firstTick: number;
    lastTick: number;
  }[];
  notes: {
    track: number;
    channel: number;
    key: number;
    velocity: number;
    startTick: number;
    endTick: number;
  }[];
  tempo: { tick: number; microsPerQuarter: number }[];
  meter: { tick: number; numerator: number; denominator: number }[];
}

/**
 * Indexes an array, failing the test rather than yielding `undefined`.
 *
 * `noUncheckedIndexedAccess` makes every index optional, and a silent `undefined` reaching
 * an expectation would weaken it.
 *
 * @param values Array to index.
 * @param index Position to read.
 * @returns The element at `index`.
 */
function at<T>(values: ArrayLike<T>, index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error(`index ${String(index)} is out of range`);
  return value;
}

/**
 * A minimal Standard MIDI File header plus one empty track, with a caller-chosen division.
 *
 * Used to reach the division branch of the parser with a file that is otherwise valid, so a
 * rejection can only be about the division.
 *
 * @param divisionHigh High byte of the MThd division word.
 * @param divisionLow Low byte of the MThd division word.
 * @returns The encoded file.
 */
function midiWithDivision(divisionHigh: number, divisionLow: number): Uint8Array {
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6]; // "MThd", chunk length 6
  const format = [0, 0, 0, 1, divisionHigh, divisionLow]; // format 0, one track, division
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4]; // "MTrk", chunk length 4
  const endOfTrack = [0x00, 0xff, 0x2f, 0x00]; // delta 0, meta end of track
  return new Uint8Array([...header, ...format, ...trackHeader, ...endOfTrack]);
}

describe('wasm boundary', () => {
  let core: TestCore;
  let samples: Float32Array;
  let sampleRate: number;
  let analysis: Awaited<ReturnType<typeof analyseFixture>>['analysis'];
  let session: TestCore['Session']['prototype'];
  let track: TrackJson;

  beforeAll(async () => {
    core = await loadTestCore();
    const fixture = await analyseFixture('phrase.wav');
    samples = fixture.samples;
    sampleRate = fixture.sampleRate;
    analysis = fixture.analysis;
    // One session serves every read-only shape assertion; the mutating tests make their own.
    session = core.Session.create(samples, sampleRate, 'phrase', analysis, '');
    track = JSON.parse(session.trackJson()) as TrackJson;
  });

  afterAll(() => {
    session.free();
  });

  it('reports a core version and a project schema version', () => {
    expect(core.coreVersion()).toMatch(/^\d+\.\d+\.\d+/);
    const schema = core.schemaVersion();
    expect(Number.isInteger(schema)).toBe(true);
    expect(schema).toBeGreaterThanOrEqual(1);
  });

  it('round trips hzToMidi and midiToHz and returns NaN for non-positive input', () => {
    // Exact by definition: A4 is MIDI 69 at the given reference, so no tolerance applies.
    expect(core.hzToMidi(440, 440)).toBe(69);
    expect(core.midiToHz(69, 440)).toBeCloseTo(440, 10);

    for (const hz of [65.406, 220, 440, 987.767]) {
      const roundTripped = core.midiToHz(core.hzToMidi(hz, 440), 440);
      // The pair is exp2/log2 of the same expression in f64, so the error is a few ulp.
      // 1e-9 Hz is roughly 1e-11 of the largest value here, well above f64 noise and far
      // below anything audible.
      expect(roundTripped).toBeCloseTo(hz, 9);
    }

    for (const bad of [0, -1, -440, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(core.hzToMidi(bad, 440)).toBeNaN();
    }
  });

  it('analyses to times, midi, confidence and rms of equal length with NaN only where unvoiced', () => {
    const times = analysis.times();
    const midi = analysis.midi();
    const confidence = analysis.confidence();
    const rms = analysis.rms();

    expect(times.length).toBe(track.frames.length);
    expect(midi.length).toBe(times.length);
    expect(confidence.length).toBe(times.length);
    expect(rms.length).toBe(times.length);
    expect(times.length).toBeGreaterThan(0);

    let voicedFrames = 0;
    for (let i = 0; i < times.length; i += 1) {
      const frame = at(track.frames, i);
      // The struct-of-arrays view and the JSON view are two serialisations of one track, so
      // NaN in `midi()` must line up frame for frame with `voiced: false` in the JSON.
      expect(Number.isNaN(at(midi, i))).toBe(!frame.voiced);
      expect(Number.isNaN(at(confidence, i))).toBe(false);
      expect(Number.isNaN(at(rms, i))).toBe(false);
      expect(at(confidence, i)).toBeGreaterThanOrEqual(0);
      expect(at(confidence, i)).toBeLessThanOrEqual(1);
      expect(at(rms, i)).toBeGreaterThanOrEqual(0);
      // Frame times are f32 copies of f64 frame centres on a uniform hop. A 24-bit mantissa
      // over times up to ~3 s leaves under 1e-6 s of error, so 1e-5 s is a safe bound that
      // still catches an off-by-one-frame regression (one hop is 5 ms).
      expect(at(times, i)).toBeCloseTo(frame.time, 5);
      if (frame.voiced) voicedFrames += 1;
    }
    expect(voicedFrames).toBeGreaterThan(0);
    expect(voicedFrames).toBeLessThan(times.length);
  });

  it('parses melody.mid into notes, tempo and meter', async () => {
    const bytes = await readMidiFixture('melody.mid');
    const file = JSON.parse(core.parseMidi(bytes)) as MidiFileJson;

    expect(file.ppq).toBeGreaterThan(0);
    expect(file.tracks.length).toBeGreaterThan(0);
    // fixtures/README.md: melody.mid is four notes at 120 bpm in 4/4.
    expect(file.notes.length).toBe(4);
    expect(file.tempo.length).toBeGreaterThanOrEqual(1);
    expect(at(file.tempo, 0).microsPerQuarter).toBe(500_000);
    expect(at(file.meter, 0).numerator).toBe(4);
    expect(at(file.meter, 0).denominator).toBe(4);

    for (const note of file.notes) {
      expect(note.key).toBeGreaterThanOrEqual(0);
      expect(note.key).toBeLessThanOrEqual(127);
      expect(note.endTick).toBeGreaterThan(note.startTick);
      expect(note.track).toBeLessThan(file.tracks.length);
    }
    // The contract says notes are sorted by start tick.
    for (let i = 1; i < file.notes.length; i += 1) {
      expect(at(file.notes, i).startTick).toBeGreaterThanOrEqual(at(file.notes, i - 1).startTick);
    }
    expect(at(file.tracks, 0).noteCount).toBe(file.notes.filter((note) => note.track === 0).length);
  });

  it('rejects garbage MIDI bytes without leaving the module unusable', () => {
    for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]) {
      expect(() => core.parseMidi(bad)).toThrow();
    }
    // A wasm trap would poison the instance, so a later call proves the failure was a clean
    // Rust error and not a panic.
    expect(core.hzToMidi(440, 440)).toBe(69);
  });

  it('exposes state, blobs, plan, track, conflicts and history as parseable JSON', () => {
    const state = JSON.parse(session.stateJson()) as Record<string, unknown>;
    for (const key of [
      'clips',
      'references',
      'scale',
      'modulation',
      'formant',
      'timeline',
      'guide',
      'mappings',
      'tuning',
      'accidentals',
    ]) {
      expect(state).toHaveProperty(key);
    }

    const blobs = JSON.parse(session.blobsJson()) as BlobJson[];
    expect(Array.isArray(blobs)).toBe(true);
    expect(blobs.length).toBeGreaterThan(0);
    for (const blob of blobs) {
      expect(Number.isInteger(blob.id)).toBe(true);
      expect(blob.end).toBeGreaterThan(blob.start);
      expect(blob.timeScale).toBe(1);
      expect(blob.pitchOffset).toBe(0);
      expect(blob.timeOffset).toBe(0);
      expect(blob.subregions.length).toBeGreaterThan(0);
      expect(Array.isArray(blob.curve.anchors)).toBe(true);
      expect(blob.excluded).toBe(false);
    }
    // BlobSet is ordered and non-overlapping by contract.
    for (let i = 1; i < blobs.length; i += 1) {
      expect(at(blobs, i).start).toBeGreaterThanOrEqual(at(blobs, i - 1).end);
    }

    const plan = JSON.parse(session.planJson()) as PlanJson;
    expect(plan.sampleRate).toBe(sampleRate);
    expect(plan.timeMap.points.length).toBeGreaterThanOrEqual(2);
    expect(plan.pitchRatio.hop).toBeGreaterThan(0);
    expect(plan.pitchRatio.values.length).toBeGreaterThan(0);
    for (const value of plan.pitchRatio.values) expect(Number.isFinite(value)).toBe(true);
    // The time map must be strictly ascending in output time to be invertible.
    for (let i = 1; i < plan.timeMap.points.length; i += 1) {
      expect(at(plan.timeMap.points, i)[0]).toBeGreaterThan(at(plan.timeMap.points, i - 1)[0]);
    }

    expect(track.sampleRate).toBe(sampleRate);
    expect(track.hopSeconds).toBeGreaterThan(0);
    expect(track.frames.length).toBeGreaterThan(0);

    const conflicts = JSON.parse(session.conflictsJson()) as unknown[];
    expect(Array.isArray(conflicts)).toBe(true);
    // Nothing has been moved yet, so nothing can collide.
    expect(conflicts.length).toBe(0);

    const history = JSON.parse(session.historyJson()) as HistoryJson;
    expect(history).toEqual({ undo: null, redo: null });
  });

  it('applies a well-formed edit and reports errors for malformed ones', () => {
    const scoped = core.Session.create(samples, sampleRate, 'edits', analysis, '');
    try {
      const blobs = JSON.parse(scoped.blobsJson()) as BlobJson[];
      const first = at(blobs, 0);
      const before = scoped.planJson();

      scoped.applyEdit(JSON.stringify({ type: 'movePitch', blobs: [first.id], semitones: 2 }));
      expect(scoped.planJson()).not.toBe(before);
      const afterBlobs = JSON.parse(scoped.blobsJson()) as BlobJson[];
      // movePitch is defined as a pitch offset on the named blobs, exactly.
      expect(at(afterBlobs, 0).pitchOffset).toBe(2);

      for (const malformed of [
        '{"type":"notARealOp"}',
        'not json at all',
        '{"type":"movePitch"}',
        '{"type":"setPitchOffset","blob":999999,"semitones":1}',
      ]) {
        expect(() => scoped.applyEdit(malformed)).toThrow();
      }
      // A panic would trap the instance; the session still answering proves it did not.
      expect(JSON.parse(scoped.blobsJson())).toHaveLength(blobs.length);
      expect(at(JSON.parse(scoped.blobsJson()) as BlobJson[], 0).pitchOffset).toBe(2);
    } finally {
      scoped.free();
    }
  });

  it('undoes and redoes edits and reports their labels', () => {
    const scoped = core.Session.create(samples, sampleRate, 'history', analysis, '');
    try {
      const blobs = JSON.parse(scoped.blobsJson()) as BlobJson[];
      const first = at(blobs, 0);
      const pristine = scoped.stateJson();

      scoped.applyEdit(JSON.stringify({ type: 'movePitch', blobs: [first.id], semitones: 2 }));
      scoped.applyEdit(JSON.stringify({ type: 'setTimeScale', blob: first.id, scale: 1.2 }));
      const edited = scoped.stateJson();
      expect(JSON.parse(scoped.historyJson()) as HistoryJson).toEqual({
        undo: 'Set Time Scale',
        redo: null,
      });

      expect(scoped.undo()).toBe(true);
      expect(JSON.parse(scoped.historyJson()) as HistoryJson).toEqual({
        undo: 'Move Pitch',
        redo: 'Set Time Scale',
      });

      expect(scoped.redo()).toBe(true);
      expect(scoped.stateJson()).toBe(edited);
      expect(JSON.parse(scoped.historyJson()) as HistoryJson).toEqual({
        undo: 'Set Time Scale',
        redo: null,
      });

      expect(scoped.undo()).toBe(true);
      expect(scoped.undo()).toBe(true);
      // Undoing everything must land back on the analysed state, byte for byte, because
      // undo replays the history from the immutable analysis.
      expect(scoped.stateJson()).toBe(pristine);
      expect(scoped.undo()).toBe(false);
      expect((JSON.parse(scoped.historyJson()) as HistoryJson).undo).toBeNull();
    } finally {
      scoped.free();
    }
  });

  it('keeps the mixer in the document and in the history', () => {
    const scoped = core.Session.create(samples, sampleRate, 'mixer', analysis, '');
    let reopened: TestCore['Session']['prototype'] | null = null;
    try {
      const before = (JSON.parse(scoped.stateJson()) as StateJson).mixer;
      // A clip with no entry on the desk reads as its starting track.
      expect(before.clips).toEqual([]);
      expect(before.click.gainDb).toBeCloseTo(-11, 6);

      const strip = { gainDb: 0, pan: 0, mute: false, solo: false };
      const mixer = {
        ...before,
        clips: [
          {
            clip: 0,
            processed: { ...strip, gainDb: -4.5, pan: -0.5 },
            original: { ...strip, solo: true },
          },
        ],
      };
      scoped.applyEdit(JSON.stringify({ type: 'setMixer', mixer }));
      expect((JSON.parse(scoped.historyJson()) as HistoryJson).undo).toBe('Set Mixer');

      const document = scoped.projectJson('');
      reopened = reopenProject(core, document, samples);
      const saved = (JSON.parse(reopened.stateJson()) as StateJson).mixer.clips[0];
      expect(saved?.processed.gainDb).toBeCloseTo(-4.5, 6);
      expect(saved?.processed.pan).toBeCloseTo(-0.5, 6);
      expect(saved?.original.solo).toBe(true);

      // The desk is monitoring, so it must not reach the render plan.
      const plain = core.Session.create(samples, sampleRate, 'mixer', analysis, '');
      try {
        expect(scoped.planJson()).toBe(plain.planJson());
      } finally {
        plain.free();
      }

      expect(scoped.undo()).toBe(true);
      expect((JSON.parse(scoped.stateJson()) as StateJson).mixer).toEqual(before);
    } finally {
      reopened?.free();
      scoped.free();
    }
  });

  it('round trips a project through openProject with matching audio', () => {
    const scoped = core.Session.create(samples, sampleRate, 'project', analysis, '');
    let reopened: TestCore['Session']['prototype'] | null = null;
    try {
      const blobs = JSON.parse(scoped.blobsJson()) as BlobJson[];
      scoped.applyEdit(
        JSON.stringify({ type: 'movePitch', blobs: [at(blobs, 0).id], semitones: -3 }),
      );
      const document = scoped.projectJson('');
      const parsed = JSON.parse(document) as { schemaVersion: number; name: string };
      expect(parsed.schemaVersion).toBe(core.schemaVersion());
      expect(parsed.name).toBe('project');

      reopened = reopenProject(core, document, samples);
      // Reopening must reproduce the edit state and the compiled plan exactly, or a saved
      // project does not sound like the session that saved it.
      expect(reopened.stateJson()).toBe(scoped.stateJson());
      expect(reopened.planJson()).toBe(scoped.planJson());
      expect(reopened.historyJson()).toBe(scoped.historyJson());
    } finally {
      reopened?.free();
      scoped.free();
    }
  });

  it('refuses to open a project against audio it was not made from', async () => {
    const other = await analyseFixture('vibrato.wav');
    const scoped = core.Session.create(samples, sampleRate, 'project', analysis, '');
    try {
      const document = scoped.projectJson('');
      expect(() => reopenProject(core, document, other.samples)).toThrow(/does not match/);
      // Same audio with one sample changed: the fingerprint, not the length, is the check.
      const tampered = samples.slice();
      tampered[0] = at(tampered, 0) + 0.5;
      expect(() => reopenProject(core, document, tampered)).toThrow();
    } finally {
      scoped.free();
    }
  });

  it('analyses a fresh import again, and refuses once it is edited', () => {
    const scoped = core.Session.create(samples, sampleRate, 'again', analysis, '');
    try {
      const clip = scoped.addClip(
        samples,
        'second.wav',
        analysis.trackJson(),
        analysis.blobsJson(),
        '',
        100,
        false,
        true,
      );
      const params = JSON.stringify({ f0: { ...DEFAULT_F0, method: 'swipe' } });
      const swipe = core.analyse(samples, sampleRate, params);
      try {
        scoped.reanalyse(clip, swipe.trackJson(), swipe.blobsJson(), params);
        const first = 2 ** 20 * clip;
        scoped.applyEdit(JSON.stringify({ type: 'movePitch', blobs: [first], semitones: 1 }));
        expect(() => scoped.reanalyse(clip, swipe.trackJson(), swipe.blobsJson(), params)).toThrow(
          /edits/,
        );
      } finally {
        swipe.free();
      }
    } finally {
      scoped.free();
    }
  });

  it('puts a second clip on the lane as one undo step and exports both', () => {
    const scoped = core.Session.create(samples, sampleRate, 'lane', analysis, '');
    try {
      const clip = scoped.addClip(
        samples,
        'second.wav',
        analysis.trackJson(),
        analysis.blobsJson(),
        '',
        100,
        false,
        false,
      );
      expect(clip).toBe(1);
      expect((JSON.parse(scoped.historyJson()) as HistoryJson).undo).toBe('Import Clip');
      const plans = JSON.parse(scoped.clipPlansJson()) as { clip: number; position: number }[];
      expect(plans.map((entry) => entry.position)).toEqual([0, 100]);
      const duration = samples.length / sampleRate;
      expect(scoped.outputFrames()).toBe(Math.round((100 + duration) * sampleRate));

      // Blobs read back in project seconds, the second clip's numbered for it.
      const blobs = JSON.parse(scoped.blobsJson()) as BlobJson[];
      const later = blobs.filter((blob) => blob.id >= 2 ** 20);
      expect(later.length).toBeGreaterThan(0);
      expect(at(later, 0).start).toBeGreaterThanOrEqual(100);

      expect(scoped.undo()).toBe(true);
      expect(JSON.parse(scoped.clipPlansJson())).toHaveLength(1);
      expect(scoped.redo()).toBe(true);
      expect(JSON.parse(scoped.clipPlansJson())).toHaveLength(2);
    } finally {
      scoped.free();
    }
  });

  it('refuses a second clip at another sample rate', () => {
    const scoped = core.Session.create(samples, sampleRate, 'lane', analysis, '');
    try {
      const track = JSON.parse(analysis.trackJson()) as { sampleRate: number };
      track.sampleRate = sampleRate / 2;
      expect(() =>
        scoped.addClip(
          samples,
          'other.wav',
          JSON.stringify(track),
          analysis.blobsJson(),
          '',
          0,
          false,
          false,
        ),
      ).toThrow(/Hz/);
    } finally {
      scoped.free();
    }
  });

  it('keeps a reference in the document without taking its audio', () => {
    const scoped = core.Session.create(samples, sampleRate, 'lane', analysis, '');
    let reopened: TestCore['Session']['prototype'] | null = null;
    try {
      const source = {
        name: 'backing.mp3',
        sampleRate,
        channels: 2,
        frames: 48_000,
        duration: 1,
        fingerprint: '0123456789abcdef',
        mime: null,
      };
      const id = scoped.addReference(JSON.stringify(source), 2.5);
      const media = JSON.parse(scoped.mediaJson()) as {
        references: { id: number; position: number }[];
      };
      expect(media.references).toEqual([expect.objectContaining({ id, position: 2.5 })]);

      reopened = reopenProject(core, scoped.projectJson(''), samples);
      const state = JSON.parse(reopened.stateJson()) as { references: { id: number }[] };
      expect(state.references.map((reference) => reference.id)).toEqual([id]);
      // A reference is heard, never rendered: the export is the vocal alone.
      expect(reopened.outputFrames()).toBe(scoped.outputFrames());
    } finally {
      reopened?.free();
      scoped.free();
    }
  });

  it('migrates a single-source document to one clip', () => {
    const scoped = core.Session.create(samples, sampleRate, 'old', analysis, '');
    try {
      const current = JSON.parse(scoped.projectJson('')) as {
        clips: { source: unknown; analysis: unknown; track: unknown }[];
        edits: { clips: { blobs: unknown }[]; mixer: { click: unknown } };
        base: { clips: { blobs: unknown }[]; mixer: { click: unknown } };
      } & Record<string, unknown>;
      const media = at(current.clips, 0);
      const strip = { gainDb: 0, pan: 0, mute: false, solo: false };
      const desk = { processed: strip, original: { ...strip, mute: true }, click: strip };
      const old = {
        ...current,
        schemaVersion: 1,
        source: media.source,
        analysis: media.analysis,
        track: media.track,
        clips: undefined,
        references: undefined,
        edits: {
          ...current.edits,
          clips: undefined,
          blobs: at(current.edits.clips, 0).blobs,
          mixer: desk,
        },
        base: {
          ...current.base,
          clips: undefined,
          blobs: at(current.base.clips, 0).blobs,
          mixer: desk,
        },
      };
      const migrated = JSON.parse(core.migrateProject(JSON.stringify(old))) as {
        schemaVersion: number;
        edits: { clips: unknown[] };
      };
      expect(migrated.schemaVersion).toBe(core.schemaVersion());
      expect(migrated.edits.clips).toHaveLength(1);
      const reopened = reopenProject(core, JSON.stringify(migrated), samples);
      try {
        expect(reopened.blobsJson()).toBe(scoped.blobsJson());
      } finally {
        reopened.free();
      }
    } finally {
      scoped.free();
    }
  });

  it('renders the requested number of samples through PlaybackRenderer', () => {
    const renderer = core.PlaybackRenderer.create(
      samples,
      session.trackJson(),
      session.planJson(),
      false,
    );
    try {
      expect(renderer.outputFrames()).toBe(session.outputFrames());
      // The plan is a passthrough, so the output is exactly as long as the source.
      expect(renderer.outputFrames()).toBe(samples.length);

      for (const length of [1, 128, 4096]) {
        const block = renderer.render(0, length);
        expect(block.length).toBe(length);
        for (let i = 0; i < block.length; i += 1) {
          expect(Number.isFinite(at(block, i))).toBe(true);
        }
      }
      // A block straddling the end must still return the length asked for, padded, because
      // the audio callback always needs a full buffer.
      expect(renderer.render(renderer.outputFrames() - 64, 512).length).toBe(512);
      expect(renderer.render(0, 0).length).toBe(0);

      expect(() => renderer.setPlan('{}')).toThrow();
      renderer.setPlan(session.planJson());
    } finally {
      renderer.free();
    }
  });

  it('analyses a take measured in spans exactly as in one call', () => {
    const whole = core.analyse(samples, sampleRate, '');
    const len = samples.length;
    const frames = core.analysisFrameCount(len, sampleRate, '');
    const spans: ReturnType<typeof core.observeSpan>[] = [];
    for (let first = 0; first < frames; first += 300) {
      const end = Math.min(frames, first + 300);
      const [start = 0, stop = 0] = core.spanSamples(len, sampleRate, '', first, end);
      spans.push(
        core.observeSpan(samples.slice(start, stop), start, len, sampleRate, '', first, end),
      );
    }
    const join = <T extends Float32Array | Float64Array | Uint32Array>(
      pick: (span: (typeof spans)[number]) => T,
      make: (length: number) => T,
    ): T => {
      const views = spans.map(pick);
      const out = make(views.reduce((total, view) => total + view.length, 0));
      let at = 0;
      for (const view of views) {
        out.set(view, at);
        at += view.length;
      }
      return out;
    };
    const f64 = (length: number) => new Float64Array(length);
    const f32 = (length: number) => new Float32Array(length);
    const split = core.analyseSpans(
      len,
      sampleRate,
      '',
      join((span) => span.freq(), f64),
      join((span) => span.dprime(), f64),
      join((span) => span.cost(), f64),
      join(
        (span) => span.counts(),
        (length) => new Uint32Array(length),
      ),
      join((span) => span.rms(), f32),
      join((span) => span.unvoiced(), f64),
      join((span) => span.energyRms(), f32),
      join((span) => span.flux(), f32),
      join((span) => span.zcr(), f32),
    );
    try {
      expect(spans.length).toBeGreaterThan(1);
      expect(split.trackJson()).toBe(whole.trackJson());
      expect(split.energyJson()).toBe(whole.energyJson());
      expect(split.blobsJson()).toBe(whole.blobsJson());
    } finally {
      for (const span of spans) span.free();
      split.free();
      whole.free();
    }
  });

  it('frees every wasm object without error', () => {
    const freshAnalysis = core.analyse(samples.subarray(0, sampleRate), sampleRate, '');
    const freshSession = core.Session.create(samples, sampleRate, 'freeing', freshAnalysis, '');
    const freshRenderer = core.PlaybackRenderer.create(
      samples,
      freshSession.trackJson(),
      freshSession.planJson(),
      true,
    );

    expect(() => freshRenderer.free()).not.toThrow();
    expect(() => freshSession.free()).not.toThrow();
    expect(() => freshAnalysis.free()).not.toThrow();
    // Every handle is also disposable, which is what `using` in the app relies on.
    expect(typeof core.Analysis.prototype[Symbol.dispose]).toBe('function');
    expect(typeof core.Session.prototype[Symbol.dispose]).toBe('function');
    expect(typeof core.PlaybackRenderer.prototype[Symbol.dispose]).toBe('function');
    // The module is still alive after three frees.
    expect(core.hzToMidi(440, 440)).toBe(69);
  });

  it('rejects an SMPTE MIDI division with a clean error', () => {
    // 0xE8 has the high bit set, which marks SMPTE timecode: -24 fps, 4 ticks per frame.
    expect(() => core.parseMidi(midiWithDivision(0xe8, 0x04))).toThrow(/SMPTE/i);
    // A zero division is the other unusable header, and must also be named rather than
    // dividing by zero somewhere downstream.
    expect(() => core.parseMidi(midiWithDivision(0x00, 0x00))).toThrow(/division/i);
    expect(core.schemaVersion()).toBeGreaterThanOrEqual(1);
  });

  it('rejects a project document from a future schema version with a clean error', () => {
    const scoped = core.Session.create(samples, sampleRate, 'future', analysis, '');
    try {
      const document = JSON.parse(scoped.projectJson('')) as Record<string, unknown>;
      document['schemaVersion'] = core.schemaVersion() + 1;
      expect(() => core.Session.openProject(JSON.stringify(document))).toThrow(/newer than/i);

      // A document missing required fields is malformed rather than unsupported, and must
      // still be an error and not a panic.
      expect(() => core.Session.openProject('{"schemaVersion":2}')).toThrow(/malformed/i);
      expect(() => core.Session.openProject('{"schemaVersion":1}')).toThrow(/no source/i);
      expect(() => core.Session.openProject('not json')).toThrow();
    } finally {
      scoped.free();
    }
  });

  it('rejects a truncated WAV payload cleanly (decode_wav itself is not on the wasm surface)', () => {
    // `axys_core::audio::wav::decode_wav` is not exported by `axys-wasm`: the app decodes
    // through `BaseAudioContext.decodeAudioData` in web/src/audio/decode.ts, and the Rust
    // decoder's truncation cases are covered by its own unit tests. What is reachable here
    // is what a truncated file yields once decoded, so that is what is asserted.

    // Truncated before any audio frames: zero samples, handled rather than rejected.
    const empty = core.analyse(new Float32Array(0), sampleRate, '');
    try {
      expect(empty.times().length).toBe(0);
      expect(empty.midi().length).toBe(0);
      expect(JSON.parse(empty.blobsJson())).toEqual([]);
    } finally {
      empty.free();
    }

    // Truncated mid-frame, read past the end: a non-finite sample must be named, not fed
    // into the detector.
    const corrupt = samples.slice(0, sampleRate);
    corrupt[1000] = Number.NaN;
    expect(() => core.analyse(corrupt, sampleRate, '')).toThrow(/non-finite/i);

    // A sample rate a broken header can produce must be rejected against the stated limits.
    expect(() => core.analyse(samples.subarray(0, 4800), 0, '')).toThrow(/sample rate/i);
    expect(() => core.analyse(samples.subarray(0, 4800), 1e9, '')).toThrow(/sample rate/i);

    expect(core.hzToMidi(440, 440)).toBe(69);
  });
});
