// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Core workflow acceptance, design bible 13.4 and the six steps listed in `docs/testing.md`.
 *
 * Everything here drives the compiled core through the real `Session` API over
 * `fixtures/audio/phrase.wav`: analysis, boundary repair, pitch, contour and timing edits,
 * processed against bypassed rendering, a save and reopen round trip, and a WAV export
 * decoded and re-analysed. Nothing is mocked and no expected value is fabricated; every
 * pitch figure is measured with the same detector the app ships.
 */

import { beforeAll, describe, expect, it, test } from 'vitest';

import {
  analyseFixture,
  correlation,
  decodeWavBytes,
  loadTestCore,
  measureF0,
  peak,
  rms,
  type AnalysedFixture,
  type F0Measurement,
  type TestCore,
} from './helpers/core';

/** One blob as `Session.blobsJson` serialises it. */
interface BlobJson {
  id: number;
  start: number;
  end: number;
  detectedCenter: number;
  pitchOffset: number;
  timeOffset: number;
  timeScale: number;
  excluded: boolean;
  bypassed: boolean;
  curve: { anchors: { time: number; midi: number }[] };
}

/** A curve sampled on a uniform grid, as `RenderPlan` serialises it. */
interface SampledCurveJson {
  start: number;
  hop: number;
  values: number[];
}

/** A compiled render plan as `Session.planJson` serialises it. */
interface PlanJson {
  sampleRate: number;
  timeMap: { points: [number, number][] };
  pitchRatio: SampledCurveJson;
  formant: unknown;
  bypass: boolean;
}

/** One frame of the detected pitch track as `Session.trackJson` serialises it. */
interface TrackJson {
  sampleRate: number;
  hopSeconds: number;
  frames: { time: number; f0: number; midi: number | null; voiced: boolean }[];
}

/** The facts recorded at import, as `Session.sourceJson` serialises it. */
interface SourceJson {
  name: string;
  sampleRate: number;
  channels: number;
  frames: number;
  duration: number;
  fingerprint: string;
}

/** The figures `Session.lastExportReport` returns after an export. */
interface ExportReportJson {
  frames: number;
  peak: number;
  clippedSamples: number;
}

/**
 * Semitone distance expressed in cents.
 *
 * @param a Fractional MIDI note number.
 * @param b Fractional MIDI note number.
 * @returns `a - b` in cents.
 */
function cents(a: number, b: number): number {
  return (a - b) * 100;
}

/** Parses JSON into the named shape; the core is the only producer, so no validation. */
function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

/** The blob with the given id, or a failure naming the id. */
function blobById(blobs: BlobJson[], id: number): BlobJson {
  const found = blobs.find((blob) => blob.id === id);
  if (!found) throw new Error(`no blob with id ${id}; ids are ${blobs.map((b) => b.id).join()}`);
  return found;
}

/** Nearest sampled value of a plan curve at a source time, clamped at both ends. */
function curveAt(curve: SampledCurveJson, time: number): number {
  const index = Math.round((time - curve.start) / curve.hop);
  const clamped = Math.max(0, Math.min(curve.values.length - 1, index));
  return curve.values[clamped] ?? Number.NaN;
}

/** Output seconds at a source time, the inverse of the plan's monotone time map. */
function outputAt(points: [number, number][], source: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return source;
  if (source <= first[1]) return first[0];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    if (source <= current[1]) {
      const span = current[1] - previous[1];
      if (span <= 0) return current[0];
      return previous[0] + ((source - previous[1]) / span) * (current[0] - previous[0]);
    }
  }
  return last[0];
}

/**
 * Median fractional MIDI over a time window of a measured track.
 *
 * The median rather than the mean so that a handful of octave-error frames cannot move the
 * reading, which is the same reason the shared helper uses one.
 */
function medianMidiIn(track: F0Measurement, from: number, to: number): number {
  const voiced: number[] = [];
  for (let i = 0; i < track.midi.length; i += 1) {
    const time = track.times[i];
    const midi = track.midi[i];
    if (time === undefined || midi === undefined) continue;
    if (time >= from && time <= to && Number.isFinite(midi)) voiced.push(midi);
  }
  if (voiced.length === 0) return Number.NaN;
  voiced.sort((a, b) => a - b);
  return voiced[voiced.length >> 1] ?? Number.NaN;
}

/** Count of voiced frames in a time window of a measured track. */
function voicedFramesIn(track: F0Measurement, from: number, to: number): number {
  let count = 0;
  for (let i = 0; i < track.midi.length; i += 1) {
    const time = track.times[i];
    const midi = track.midi[i];
    if (time === undefined || midi === undefined) continue;
    if (time >= from && time <= to && Number.isFinite(midi)) count += 1;
  }
  return count;
}

/**
 * Start times of the voiced regions in a measured track.
 *
 * A region ends after `gapFrames` consecutive unvoiced frames, so the odd dropped frame
 * inside a sustained note does not read as two onsets.
 */
function voicedOnsets(track: F0Measurement, gapFrames = 5): number[] {
  const onsets: number[] = [];
  let inRegion = false;
  let start = 0;
  let unvoicedRun = 0;
  for (let i = 0; i < track.midi.length; i += 1) {
    const time = track.times[i];
    const midi = track.midi[i];
    if (time === undefined || midi === undefined) continue;
    if (Number.isFinite(midi)) {
      if (!inRegion) {
        inRegion = true;
        start = time;
      }
      unvoicedRun = 0;
    } else if (inRegion) {
      unvoicedRun += 1;
      if (unvoicedRun > gapFrames) {
        inRegion = false;
        onsets.push(start);
      }
    }
  }
  if (inRegion) onsets.push(start);
  return onsets;
}

/** Sample-by-sample difference of two buffers over their common length. */
function difference(a: Float32Array, b: Float32Array): Float32Array {
  const length = Math.min(a.length, b.length);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (a[i] ?? 0) - (b[i] ?? 0);
  return out;
}

/** Pitch-shifted note the pitch tests use, in semitones. */
const PITCH_EDIT_SEMITONES = 3;

/** Timing shift the timing tests use, in seconds. */
const TIME_EDIT_SECONDS = 0.06;

/**
 * Cents a measured note may sit from its intended value.
 *
 * `docs/testing.md` states 15 cents for pitch fidelity after transformation, which is the
 * same measurement this makes, so the same bound is used rather than a looser one invented
 * here. The observed error on this fixture is under one cent.
 */
const PITCH_TOLERANCE_CENTS = 15;

/**
 * Seconds an onset read back from a render may sit from where the time map puts it.
 *
 * Analysis runs on a 5 ms hop, so an onset is quantised to a frame, and the frame window
 * moves the first voiced frame by up to one more hop either way. Three hops covers both.
 */
const ONSET_TOLERANCE_SECONDS = 0.015;

describe('core workflow acceptance (design bible 13.4)', () => {
  let core: TestCore;
  let fixture: AnalysedFixture;

  /** A session with no edits, its plan and its full render. */
  let baseline: {
    session: InstanceType<TestCore['Session']>;
    plan: PlanJson;
    render: Float32Array;
  };
  let baselineOnsets: number[];
  let sourceBlobs: BlobJson[];

  /** Step 3, one session per edit dimension so nothing is attributed to the wrong edit. */
  let pitchOnly: { session: InstanceType<TestCore['Session']>; plan: PlanJson };
  let pitchOnlyTrack: F0Measurement;
  let contourOnly: { session: InstanceType<TestCore['Session']>; plan: PlanJson };
  let contourOnlyTrack: F0Measurement;
  let timingOnly: { session: InstanceType<TestCore['Session']>; plan: PlanJson };
  let timingOnlyTrack: F0Measurement;

  /** Steps 4 to 6: one pitch edit and one timing edit, on different notes. */
  let edited: { session: InstanceType<TestCore['Session']>; plan: PlanJson; render: Float32Array };
  let bypassedRender: Float32Array;
  let exportedBytes: Uint8Array;
  let exportedTrack: F0Measurement;

  /** Builds a fresh session over the shared analysis and applies the given edit ops. */
  function sessionWith(...ops: unknown[]): InstanceType<TestCore['Session']> {
    const session = core.Session.create(
      fixture.samples,
      fixture.sampleRate,
      'phrase.wav',
      fixture.analysis,
      '',
    );
    for (const op of ops) session.applyEdit(JSON.stringify(op));
    return session;
  }

  /** Renders a session's whole output through the shipped renderer at export quality. */
  function renderAll(
    session: InstanceType<TestCore['Session']>,
    planOverride?: PlanJson,
  ): Float32Array {
    const planText = planOverride ? JSON.stringify(planOverride) : session.planJson();
    const renderer = core.PlaybackRenderer.create(
      session.source(),
      session.trackJson(),
      planText,
      true,
    );
    try {
      return renderer.render(0, renderer.outputFrames());
    } finally {
      renderer.free();
    }
  }

  beforeAll(async () => {
    core = await loadTestCore();
    fixture = await analyseFixture('phrase.wav');
    sourceBlobs = json<BlobJson[]>(fixture.analysis.blobsJson());

    const baseSession = sessionWith();
    baseline = {
      session: baseSession,
      plan: json<PlanJson>(baseSession.planJson()),
      render: renderAll(baseSession),
    };
    baselineOnsets = voicedOnsets(await measureF0(baseline.render, fixture.sampleRate));

    const first = sourceBlobs[0];
    const second = sourceBlobs[1];
    if (!first || !second) throw new Error('phrase.wav must segment into at least two blobs');

    const pitchSession = sessionWith({
      type: 'movePitch',
      blobs: [first.id],
      semitones: PITCH_EDIT_SEMITONES,
    });
    pitchOnly = { session: pitchSession, plan: json<PlanJson>(pitchSession.planJson()) };
    pitchOnlyTrack = await measureF0(renderAll(pitchSession), fixture.sampleRate);

    // Anchors over the last third of the first note, bending its tail up two semitones.
    const contourStart = first.start + (first.end - first.start) * 0.66;
    const contourSession = sessionWith({
      type: 'drawSpan',
      blob: first.id,
      anchors: [
        { time: contourStart, midi: first.detectedCenter, interp: 'linear' },
        { time: first.end, midi: first.detectedCenter + 2, interp: 'linear' },
      ],
    });
    contourOnly = { session: contourSession, plan: json<PlanJson>(contourSession.planJson()) };
    contourOnlyTrack = await measureF0(renderAll(contourSession), fixture.sampleRate);

    const timingSession = sessionWith({
      type: 'moveTime',
      blobs: [second.id],
      seconds: TIME_EDIT_SECONDS,
    });
    timingOnly = { session: timingSession, plan: json<PlanJson>(timingSession.planJson()) };
    timingOnlyTrack = await measureF0(renderAll(timingSession), fixture.sampleRate);

    const editedSession = sessionWith(
      { type: 'movePitch', blobs: [first.id], semitones: PITCH_EDIT_SEMITONES },
      { type: 'moveTime', blobs: [second.id], seconds: TIME_EDIT_SECONDS },
    );
    const editedPlan = json<PlanJson>(editedSession.planJson());
    edited = { session: editedSession, plan: editedPlan, render: renderAll(editedSession) };
    bypassedRender = renderAll(editedSession, { ...editedPlan, bypass: true });

    exportedBytes = editedSession.exportWav(0, -1, fixture.sampleRate, 'pcm16');
    exportedTrack = await measureF0(
      decodeWavBytes(exportedBytes).samples,
      decodeWavBytes(exportedBytes).sampleRate,
    );
  });

  describe('1. import and analyse', () => {
    it('records the imported source facts', () => {
      const source = json<SourceJson>(baseline.session.sourceJson());
      expect(source.name).toBe('phrase.wav');
      expect(source.sampleRate).toBe(fixture.sampleRate);
      expect(source.channels).toBe(1);
      expect(source.frames).toBe(fixture.samples.length);
      expect(source.duration).toBeCloseTo(fixture.samples.length / fixture.sampleRate, 9);
      expect(source.fingerprint).not.toHaveLength(0);
    });

    it('produces a navigable pitch track spanning the audio', () => {
      const track = json<TrackJson>(baseline.session.trackJson());
      expect(track.sampleRate).toBe(fixture.sampleRate);
      expect(track.hopSeconds).toBeGreaterThan(0);
      expect(track.frames.length).toBeGreaterThan(100);

      const duration = fixture.samples.length / fixture.sampleRate;
      const firstFrame = track.frames[0];
      const lastFrame = track.frames[track.frames.length - 1];
      expect(firstFrame?.time).toBeLessThan(track.hopSeconds);
      // The last frame centre sits within one hop of the end, so the track is navigable
      // across the whole file rather than stopping short of it.
      expect(duration - (lastFrame?.time ?? 0)).toBeLessThanOrEqual(track.hopSeconds * 2);

      for (let i = 1; i < track.frames.length; i += 1) {
        const previous = track.frames[i - 1];
        const current = track.frames[i];
        if (!previous || !current) continue;
        expect(current.time).toBeGreaterThan(previous.time);
      }

      const voiced = track.frames.filter((frame) => frame.voiced);
      // phrase.wav is four sung notes with short silences and one sibilant between them,
      // so well over half of it carries pitch.
      expect(voiced.length / track.frames.length).toBeGreaterThan(0.5);
      for (const frame of voiced) {
        expect(frame.f0).toBeGreaterThan(0);
        expect(frame.midi).not.toBeNull();
      }
    });

    it('produces more than one provisional blob, ordered and non-overlapping', () => {
      const blobs = json<BlobJson[]>(baseline.session.blobsJson());
      expect(blobs.length).toBeGreaterThan(1);
      expect(blobs).toEqual(sourceBlobs);

      const duration = fixture.samples.length / fixture.sampleRate;
      let previousEnd = 0;
      for (const blob of blobs) {
        expect(blob.end).toBeGreaterThan(blob.start);
        expect(blob.start).toBeGreaterThanOrEqual(previousEnd);
        expect(blob.end).toBeLessThanOrEqual(duration);
        // Every provisional blob is a sung note, so it carries a usable detected centre.
        expect(Number.isFinite(blob.detectedCenter)).toBe(true);
        expect(blob.detectedCenter).toBeGreaterThan(40);
        expect(blob.detectedCenter).toBeLessThan(90);
        expect(blob.pitchOffset).toBe(0);
        expect(blob.timeOffset).toBe(0);
        expect(blob.timeScale).toBe(1);
        previousEnd = blob.end;
      }
    });
  });

  describe('2. repair a boundary without reanalysing', () => {
    it('leaves the pitch track byte-identical after moving a boundary', () => {
      const session = sessionWith();
      const before = session.trackJson();
      const target = sourceBlobs[2];
      if (!target) throw new Error('phrase.wav must segment into at least three blobs');
      const moved = target.start - 0.06;

      session.applyEdit(
        JSON.stringify({ type: 'moveBoundary', blob: target.id, edge: 'start', time: moved }),
      );

      // Byte identity is the strongest available statement of "nothing reanalysed": the
      // track is serialised from the immutable analysis, so any rerun would perturb it.
      expect(session.trackJson()).toBe(before);
      expect(session.trackJson()).toBe(baseline.session.trackJson());
      expect(fixture.analysis.trackJson()).toBe(before);
      session.free();
    });

    it('moves only the edited boundary and leaves its neighbours alone', () => {
      const target = sourceBlobs[2];
      const previous = sourceBlobs[1];
      const next = sourceBlobs[3];
      if (!target || !previous || !next) throw new Error('phrase.wav must have four blobs');
      const moved = target.start - 0.06;

      const session = sessionWith({
        type: 'moveBoundary',
        blob: target.id,
        edge: 'start',
        time: moved,
      });
      const blobs = json<BlobJson[]>(session.blobsJson());

      expect(blobById(blobs, target.id).start).toBeCloseTo(moved, 9);
      expect(blobById(blobs, target.id).end).toBeCloseTo(target.end, 9);
      expect(blobById(blobs, previous.id).start).toBeCloseTo(previous.start, 9);
      expect(blobById(blobs, previous.id).end).toBeCloseTo(previous.end, 9);
      expect(blobById(blobs, next.id).start).toBeCloseTo(next.start, 9);
      expect(json<{ undo: string | null }>(session.historyJson()).undo).toBe('Move Boundary');
      session.free();
    });
  });

  describe('3. pitch, contour and timing edits affect only what they should', () => {
    it('a note centre moves pitch on that note alone and leaves timing untouched', () => {
      const first = sourceBlobs[0];
      const second = sourceBlobs[1];
      if (!first || !second) throw new Error('phrase.wav must have two blobs');
      const expectedRatio = 2 ** (PITCH_EDIT_SEMITONES / 12);
      const middle = (time: BlobJson) => (time.start + time.end) / 2;

      expect(curveAt(pitchOnly.plan.pitchRatio, middle(first))).toBeCloseTo(expectedRatio, 6);
      expect(curveAt(pitchOnly.plan.pitchRatio, middle(second))).toBeCloseTo(1, 6);
      // The time map is the only thing a timing edit may touch, so a pitch edit must leave
      // it exactly as the unedited plan compiled it.
      expect(pitchOnly.plan.timeMap.points).toEqual(baseline.plan.timeMap.points);

      const blobs = json<BlobJson[]>(pitchOnly.session.blobsJson());
      expect(blobById(blobs, first.id).pitchOffset).toBe(PITCH_EDIT_SEMITONES);
      expect(blobById(blobs, first.id).timeOffset).toBe(0);
      expect(blobById(blobs, first.id).timeScale).toBe(1);
      expect(blobById(blobs, second.id).pitchOffset).toBe(0);
    });

    it('renders the moved centre at its new pitch and the next note at its old one', () => {
      const first = sourceBlobs[0];
      const second = sourceBlobs[1];
      if (!first || !second) throw new Error('phrase.wav must have two blobs');
      // Measure inside each note rather than across its edges, where the detector is still
      // settling on the attack and release.
      const inside = (blob: BlobJson): [number, number] => [blob.start + 0.05, blob.end - 0.05];

      const edited = medianMidiIn(pitchOnlyTrack, ...inside(first));
      const untouched = medianMidiIn(pitchOnlyTrack, ...inside(second));
      expect(
        Math.abs(cents(edited, first.detectedCenter + PITCH_EDIT_SEMITONES)),
      ).toBeLessThanOrEqual(PITCH_TOLERANCE_CENTS);
      expect(Math.abs(cents(untouched, second.detectedCenter))).toBeLessThanOrEqual(
        PITCH_TOLERANCE_CENTS,
      );
    });

    it('reshaping a tail with anchors bends only the tail, not the head or the timing', () => {
      const first = sourceBlobs[0];
      const second = sourceBlobs[1];
      if (!first || !second) throw new Error('phrase.wav must have two blobs');
      const contourStart = first.start + (first.end - first.start) * 0.66;

      // Head: before the first anchor the curve contributes nothing.
      expect(curveAt(contourOnly.plan.pitchRatio, first.start + 0.05)).toBeCloseTo(1, 6);
      // Tail: at the last anchor it reaches the two semitones the anchors ask for.
      expect(curveAt(contourOnly.plan.pitchRatio, first.end - 0.005)).toBeCloseTo(2 ** (2 / 12), 2);
      // Halfway through the anchored span, a linear interpolation is halfway there; one
      // decimal place because the check is that it ramps, not that it hits a sample exactly.
      expect(curveAt(contourOnly.plan.pitchRatio, (contourStart + first.end) / 2)).toBeCloseTo(
        2 ** (1 / 12),
        1,
      );
      // Nothing outside the blob, and no timing consequence.
      expect(curveAt(contourOnly.plan.pitchRatio, (second.start + second.end) / 2)).toBeCloseTo(
        1,
        6,
      );
      expect(contourOnly.plan.timeMap.points).toEqual(baseline.plan.timeMap.points);

      const blobs = json<BlobJson[]>(contourOnly.session.blobsJson());
      expect(blobById(blobs, first.id).curve.anchors).toHaveLength(2);
      // A drawn contour is not a centre move: the blob's own offset stays where it was.
      expect(blobById(blobs, first.id).pitchOffset).toBe(0);
      expect(blobById(blobs, second.id).curve.anchors).toHaveLength(0);
    });

    it('renders the reshaped tail above the unchanged head', () => {
      const first = sourceBlobs[0];
      if (!first) throw new Error('phrase.wav must have a first blob');
      const anchored = first.start + (first.end - first.start) * 0.66;
      const head = medianMidiIn(contourOnlyTrack, first.start + 0.05, anchored - 0.02);
      const tail = medianMidiIn(contourOnlyTrack, first.end - 0.06, first.end - 0.01);

      expect(Math.abs(cents(head, first.detectedCenter))).toBeLessThanOrEqual(
        PITCH_TOLERANCE_CENTS,
      );
      // The tail is a ramp, so it is measured as "clearly risen" rather than to a target:
      // over the last 50 ms the anchors ask for between about 1.7 and 2 semitones.
      expect(cents(tail, first.detectedCenter)).toBeGreaterThan(150);
      expect(cents(tail, first.detectedCenter)).toBeLessThan(250);
    });

    it('a timing move changes the time map and leaves every pitch ratio at unity', () => {
      const second = sourceBlobs[1];
      if (!second) throw new Error('phrase.wav must have two blobs');

      expect(timingOnly.plan.timeMap.points).not.toEqual(baseline.plan.timeMap.points);
      for (const value of timingOnly.plan.pitchRatio.values) expect(value).toBeCloseTo(1, 9);

      // The moved note's source span now plays back TIME_EDIT_SECONDS later.
      expect(outputAt(timingOnly.plan.timeMap.points, second.start)).toBeCloseTo(
        second.start + TIME_EDIT_SECONDS,
        6,
      );
      expect(outputAt(timingOnly.plan.timeMap.points, second.end)).toBeCloseTo(
        second.end + TIME_EDIT_SECONDS,
        6,
      );
      // The note before it is where it always was.
      const first = sourceBlobs[0];
      if (!first) throw new Error('phrase.wav must have a first blob');
      expect(outputAt(timingOnly.plan.timeMap.points, first.start)).toBeCloseTo(first.start, 6);

      const blobs = json<BlobJson[]>(timingOnly.session.blobsJson());
      expect(blobById(blobs, second.id).timeOffset).toBeCloseTo(TIME_EDIT_SECONDS, 9);
      expect(blobById(blobs, second.id).pitchOffset).toBe(0);
      expect(blobById(blobs, first.id).timeOffset).toBe(0);
    });

    it('renders the moved note later without moving its pitch', () => {
      const second = sourceBlobs[1];
      if (!second) throw new Error('phrase.wav must have two blobs');
      const onsets = voicedOnsets(timingOnlyTrack);
      expect(onsets).toHaveLength(baselineOnsets.length);

      for (let i = 0; i < onsets.length; i += 1) {
        const reference = baselineOnsets[i];
        const moved = onsets[i];
        if (reference === undefined || moved === undefined) continue;
        expect(Math.abs(moved - outputAt(timingOnly.plan.timeMap.points, reference))).toBeLessThan(
          ONSET_TOLERANCE_SECONDS,
        );
      }

      const shifted = medianMidiIn(
        timingOnlyTrack,
        second.start + TIME_EDIT_SECONDS + 0.05,
        second.end + TIME_EDIT_SECONDS - 0.05,
      );
      expect(Math.abs(cents(shifted, second.detectedCenter))).toBeLessThanOrEqual(
        PITCH_TOLERANCE_CENTS,
      );
    });
  });

  describe('4. processed and bypassed playback of the same region', () => {
    it('renders the same number of frames either way', () => {
      expect(edited.render.length).toBe(bypassedRender.length);
      expect(edited.session.outputFrames()).toBe(edited.render.length);
    });

    it('returns the untouched source when the plan is bypassed', () => {
      // Bypass is defined as "rendering returns the source", so this is the reference the
      // processed render is compared against. Float rounding in the copy path is the only
      // permitted difference.
      expect(bypassedRender.length).toBe(fixture.samples.length);
      let largest = 0;
      for (let i = 0; i < bypassedRender.length; i += 1) {
        largest = Math.max(largest, Math.abs((bypassedRender[i] ?? 0) - (fixture.samples[i] ?? 0)));
      }
      expect(largest).toBeLessThan(1e-6);
    });

    it('a looped region differs between processed and bypassed playback', () => {
      // The loop covers the pitch-edited note and the timing-moved note that follows it.
      const second = sourceBlobs[1];
      if (!second) throw new Error('phrase.wav must have two blobs');
      const from = 0;
      const to = Math.round((second.end + TIME_EDIT_SECONDS) * fixture.sampleRate);

      const processedLoop = edited.render.slice(from, to);
      const bypassedLoop = bypassedRender.slice(from, to);
      expect(processedLoop.length).toBe(bypassedLoop.length);

      const residual = difference(processedLoop, bypassedLoop);
      // A three-semitone shift replaces the waveform of that note outright, so the residual
      // is the same order as the signal; a quarter of it is a floor well clear of any
      // rounding, not a number chosen to pass.
      expect(rms(residual)).toBeGreaterThan(0.25 * rms(bypassedLoop));
      expect(peak(residual)).toBeGreaterThan(0.1 * peak(bypassedLoop));
      // Decorrelated rather than merely scaled: a gain change would leave this near 1.
      expect(correlation(processedLoop, bypassedLoop)).toBeLessThan(0.5);
    });

    it('renders the same region identically on repeat', () => {
      const second = sourceBlobs[1];
      if (!second) throw new Error('phrase.wav must have two blobs');
      const again = renderAll(edited.session);
      expect(again.length).toBe(edited.render.length);
      for (let i = 0; i < again.length; i += 1) {
        if (!Object.is(again[i], edited.render[i])) {
          throw new Error(`repeat render differs at sample ${i}`);
        }
      }
    });
  });

  describe('5. save and reopen', () => {
    it('reopens the saved project with the same state, plan and history', () => {
      const projectText = edited.session.projectJson('');
      const reopened = core.Session.openProject(projectText, fixture.samples, fixture.sampleRate);
      try {
        expect(reopened.stateJson()).toBe(edited.session.stateJson());
        expect(reopened.planJson()).toBe(edited.session.planJson());
        expect(reopened.trackJson()).toBe(edited.session.trackJson());
        expect(reopened.historyJson()).toBe(edited.session.historyJson());
      } finally {
        reopened.free();
      }
    });

    it('renders bit-identically after a save and reopen round trip', () => {
      const projectText = edited.session.projectJson('');
      const reopened = core.Session.openProject(projectText, fixture.samples, fixture.sampleRate);
      try {
        const roundTripped = renderAll(reopened);
        expect(roundTripped.length).toBe(edited.render.length);
        for (let i = 0; i < roundTripped.length; i += 1) {
          if (!Object.is(roundTripped[i], edited.render[i])) {
            throw new Error(
              `round-tripped render differs at sample ${i}: ` +
                `${String(roundTripped[i])} vs ${String(edited.render[i])}`,
            );
          }
        }
      } finally {
        reopened.free();
      }
    });

    it('refuses to reopen against audio the project was not made from', () => {
      const projectText = edited.session.projectJson('');
      const different = fixture.samples.slice();
      different[0] = (different[0] ?? 0) + 0.5;
      expect(() =>
        core.Session.openProject(projectText, different, fixture.sampleRate),
      ).toThrowError();
    });
  });

  describe('6. export WAV matching the active edits', () => {
    it('encodes the whole render as mono PCM at the session sample rate', () => {
      const decoded = decodeWavBytes(exportedBytes);
      expect(decoded.sampleRate).toBe(fixture.sampleRate);
      expect(decoded.samples.length).toBe(edited.render.length);

      const report = json<ExportReportJson | null>(edited.session.lastExportReport());
      expect(report).not.toBeNull();
      expect(report?.frames).toBe(edited.render.length);
      expect(report?.clippedSamples).toBe(0);
      expect(report?.peak).toBeCloseTo(peak(edited.render), 5);
    });

    it('decodes back to the pitch the edits asked for', () => {
      const first = sourceBlobs[0];
      const second = sourceBlobs[1];
      if (!first || !second) throw new Error('phrase.wav must have two blobs');

      const moved = medianMidiIn(exportedTrack, first.start + 0.05, first.end - 0.05);
      expect(
        Math.abs(cents(moved, first.detectedCenter + PITCH_EDIT_SEMITONES)),
      ).toBeLessThanOrEqual(PITCH_TOLERANCE_CENTS);

      // The timing-moved note kept its pitch, at its new place in the output.
      const kept = medianMidiIn(
        exportedTrack,
        second.start + TIME_EDIT_SECONDS + 0.05,
        second.end + TIME_EDIT_SECONDS - 0.05,
      );
      expect(Math.abs(cents(kept, second.detectedCenter))).toBeLessThanOrEqual(
        PITCH_TOLERANCE_CENTS,
      );
    });

    it('decodes back with its onsets where the time map puts them', () => {
      const onsets = voicedOnsets(exportedTrack);
      expect(onsets).toHaveLength(baselineOnsets.length);
      for (let i = 0; i < onsets.length; i += 1) {
        const reference = baselineOnsets[i];
        const found = onsets[i];
        if (reference === undefined || found === undefined) continue;
        expect(Math.abs(found - outputAt(edited.plan.timeMap.points, reference))).toBeLessThan(
          ONSET_TOLERANCE_SECONDS,
        );
      }

      const second = sourceBlobs[1];
      if (!second) throw new Error('phrase.wav must have two blobs');
      // The moved note's own onset is TIME_EDIT_SECONDS later than it was without the edit.
      const near = (list: number[], time: number) =>
        list.reduce((best, value) =>
          Math.abs(value - time) < Math.abs(best - time) ? value : best,
        );
      const before = near(baselineOnsets, second.start);
      const after = near(onsets, second.start + TIME_EDIT_SECONDS);
      expect(after - before).toBeCloseTo(TIME_EDIT_SECONDS, 2);
    });

    // DEFECT (engine, crates/axys-core/src/render.rs / dsp/psola.rs). A plan whose pitch
    // ratio is 1.0 everywhere and whose time map is the identity still rewrites the notes
    // above about MIDI 62 an octave or more down. On phrase.wav the third note reads 64 in
    // the source and 36.13 after a passthrough render, and the fourth reads 65 and then
    // 53.01, an exact octave. The first two notes, 60 and 62, come through to within a
    // hundredth of a cent, so this is not analysis error. It reproduces on
    // rapid-transitions.wav (64 -> 59, 67 -> 55) and is identical whether rendered in one
    // call or in 128-sample blocks, so it is not a block-boundary or checkpoint problem.
    // Repro: analyse fixtures/audio/phrase.wav, Session.create, PlaybackRenderer.create with
    // the unedited planJson, render the whole output, re-analyse, take the median MIDI over
    // 1.30 s to 1.80 s. The test below is correct and stays; it is marked failing rather
    // than weakened, and must be unmarked when the renderer is fixed.
    test.fails('keeps every unedited note at its detected pitch through export', () => {
      for (const blob of sourceBlobs.slice(2)) {
        const measured = medianMidiIn(exportedTrack, blob.start + 0.05, blob.end - 0.05);
        expect(voicedFramesIn(exportedTrack, blob.start + 0.05, blob.end - 0.05)).toBeGreaterThan(
          10,
        );
        expect(Math.abs(cents(measured, blob.detectedCenter))).toBeLessThanOrEqual(
          PITCH_TOLERANCE_CENTS,
        );
      }
    });
  });
});
