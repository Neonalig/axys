// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * End-to-end cover for the three edit modes, outside pitch, the clipboard and clip trimming.
 *
 * The edits are built by the same pure functions the commands and gestures call, from a state
 * read out of a real session, and applied to that session through the compiled core.
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { analyseFixture, loadTestCore, type TestCore } from './helpers/core';
import {
  copyClips,
  copyPitch,
  cutBlobOps,
  cutClipSpans,
  cutPitchOps,
  deleteStrokeOps,
  drawStrokeOps,
  liftRunOps,
  outsideRuns,
  pastePitchOps,
  placePitch,
  placeStrokes,
  samplePitch,
  stretchOps,
} from '../web/src/app/clipboard';
import { initialState } from '../web/src/app/store';
import type { AppState } from '../web/src/app/store';
import type { Blob, EditOp, EditState, RenderPlan } from '../web/src/core/types';
import { planTargetMidi } from '../web/src/editor/layers/pitch';

type Session = TestCore['Session']['prototype'];

interface TrackJson {
  frames: { time: number; midi: number | null; confidence: number; rms: number }[];
}

/** The editor's state as the entry point builds it from a session. */
function stateOf(session: Session, patch: Partial<AppState> = {}): AppState {
  const track = JSON.parse(session.trackJson()) as TrackJson;
  const frames = track.frames;
  return {
    ...initialState(),
    phase: 'ready',
    edits: JSON.parse(session.stateJson()) as EditState,
    blobs: JSON.parse(session.blobsJson()) as Blob[],
    layer: JSON.parse(session.layerJson()) as number[],
    plan: JSON.parse(session.planJson()) as RenderPlan,
    track: {
      times: Float32Array.from(frames, (frame) => frame.time),
      midi: Float32Array.from(frames, (frame) => frame.midi ?? Number.NaN),
      confidence: Float32Array.from(frames, (frame) => frame.confidence),
      rms: Float32Array.from(frames, (frame) => frame.rms),
    },
    ...patch,
  };
}

/** A state with one blob selected by the span it occupies. */
function selecting(state: AppState, blob: Blob): AppState {
  const range = { start: blob.start + blob.timeOffset, end: blob.end + blob.timeOffset };
  return { ...state, selection: { blobs: [blob.id], anchors: [], ranges: [range] } };
}

function apply(session: Session, ops: readonly EditOp[]): void {
  expect(ops.length).toBeGreaterThan(0);
  const op: EditOp = ops.length === 1 ? ops[0]! : { type: 'group', ops: [...ops] };
  session.applyEdit(JSON.stringify(op));
}

describe('editing modes', () => {
  let core: TestCore;
  let fixture: Awaited<ReturnType<typeof analyseFixture>>;

  beforeAll(async () => {
    core = await loadTestCore();
    fixture = await analyseFixture('phrase.wav');
  });

  function session(): Session {
    return core.Session.create(fixture.samples, fixture.sampleRate, 'phrase', fixture.analysis, '');
  }

  it('cuts a blob in Blob mode without silencing its audio, and edits the pitch left behind', () => {
    const scoped = session();
    try {
      const before = stateOf(scoped);
      const target = before.blobs[1]!;
      apply(scoped, cutBlobOps(selecting(before, target)));
      const after = stateOf(scoped);
      expect(after.blobs).toHaveLength(before.blobs.length - 1);
      expect(after.edits?.clips[0]?.silenced).toEqual([]);

      // The pitch the blob covered is outside every blob now, and editing it makes a blob again.
      const runs = outsideRuns(after, target.start, target.end);
      expect(runs.length).toBeGreaterThan(0);
      apply(scoped, liftRunOps(runs[0]!, 2, 0));
      const lifted = stateOf(scoped);
      expect(lifted.blobs).toHaveLength(before.blobs.length);
      const made = lifted.blobs.find((blob) => blob.start >= runs[0]!.start - 1e-6)!;
      expect(made.pitchOffset).toBe(2);
      expect(scoped.undo()).toBe(true);
      expect(stateOf(scoped).blobs).toHaveLength(before.blobs.length - 1);
    } finally {
      scoped.free();
    }
  });

  it('slides a blob along the audio in Blob mode without a timing edit', () => {
    const scoped = session();
    try {
      const before = stateOf(scoped);
      const first = before.blobs[0]!;
      // Its neighbour touches its end, so it can only go earlier.
      scoped.applyEdit(JSON.stringify({ type: 'shiftBlob', blob: first.id, seconds: -0.05 }));
      const moved = stateOf(scoped).blobs[0]!;
      expect(moved.timeOffset).toBe(0);
      expect(moved.start).toBeCloseTo(first.start - 0.05, 6);
      scoped.applyEdit(JSON.stringify({ type: 'shiftBlob', blob: first.id, seconds: 1 }));
      expect(stateOf(scoped).blobs[0]!.end).toBeCloseTo(before.blobs[1]!.start, 6);
      expect(scoped.outputFrames()).toBe(fixture.samples.length);
    } finally {
      scoped.free();
    }
  });

  it('pastes pitch copied from one blob over another and hears it there', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const [source, target] = [state.blobs[0]!, state.blobs[2]!];
      const copied = copyPitch(selecting(state, source));
      expect(copied?.kind).toBe('pitch');
      const range = { start: target.start, end: target.end };
      const points = placePitch(copied!, range, 0);
      apply(scoped, pastePitchOps(state, points));

      const after = stateOf(scoped);
      const middle = (target.start + target.end) / 2;
      const heard = planTargetMidi(after.plan!, middle);
      const wanted = samplePitch(state, [{ start: source.start, end: source.end }]).flat();
      const median = wanted.map((point) => point.midi).sort((a, b) => a - b)[wanted.length >> 1]!;
      expect(heard).not.toBeNull();
      expect(Math.abs(heard! - median)).toBeLessThan(0.5);
    } finally {
      scoped.free();
    }
  });

  it('copies one unbroken line across blobs and the gaps between them', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const [first, last] = [state.blobs[0]!, state.blobs[2]!];
      const range = { start: first.start - 0.05, end: last.end + 0.05 };
      const copied = copyPitch({
        ...state,
        selection: { blobs: [], anchors: [], ranges: [range] },
      });
      expect(copied?.kind).toBe('pitch');
      if (copied?.kind !== 'pitch') return;
      expect(copied.lines).toHaveLength(1);
      const line = copied.lines[0]!;
      expect(line[0]!.time).toBeCloseTo(range.start, 5);
      expect(line[line.length - 1]!.time).toBeCloseTo(range.end, 5);

      // Pasted back where it came from, every blob under it takes its part of the one line.
      const points = placePitch(copied, null, range.start);
      const ops = pastePitchOps(state, points);
      const under = state.blobs.filter(
        (blob) => blob.end > range.start && blob.start + blob.timeOffset < range.end,
      );
      expect(ops.filter((op) => op.type === 'replacePitch')).toHaveLength(under.length);
    } finally {
      scoped.free();
    }
  });

  it('keeps a curve drawn across a gap whole, and copies, reshapes and deletes it as drawn', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const [left, right] = [state.blobs[1]!, state.blobs[2]!];
      // A straight ramp from the middle of one blob to the middle of the next, over the gap.
      const from = { time: (left.start + left.end) / 2, midi: 58 };
      const to = { time: (right.start + right.end) / 2, midi: 70 };
      const ramp = Array.from({ length: 21 }, (_, i) => ({
        time: from.time + ((to.time - from.time) * i) / 20,
        midi: from.midi + ((to.midi - from.midi) * i) / 20,
      }));
      scoped.applyEdit(JSON.stringify({ type: 'setPitchOffset', blob: left.id, semitones: 1 }));
      apply(scoped, drawStrokeOps(stateOf(scoped), ramp, [from, from, to, to], null));
      const drawn = stateOf(scoped);
      expect(drawn.edits?.strokes).toHaveLength(1);

      // Copying the ramp copies it as drawn, including where it crosses nothing.
      const gap = (left.end + right.start) / 2;
      const copied = copyPitch({
        ...drawn,
        selection: { blobs: [], anchors: [], ranges: [{ start: from.time, end: to.time }] },
      });
      if (copied?.kind !== 'pitch') throw new Error('nothing copied');
      expect(copied.strokes).toHaveLength(1);
      const line = copied.lines[0]!;
      const near = line.reduce((best, point) =>
        Math.abs(point.time - gap) < Math.abs(best.time - gap) ? point : best,
      );
      const expected =
        from.midi + ((to.midi - from.midi) * (near.time - from.time)) / (to.time - from.time);
      expect(Math.abs(near.midi - expected)).toBeLessThan(0.05);

      // Pasted elsewhere, the curve comes with it as a curve of its own.
      apply(scoped, placeStrokes(drawn, copied, null, 0.1));
      const pasted = stateOf(scoped).edits?.strokes ?? [];
      expect(pasted).toHaveLength(2);
      expect(pasted[1]!.points[0]!.time).toBeCloseTo(0.1, 9);

      // Reshaped, it keeps its id; deleted, it goes and the blob keeps its own offset.
      const kept = pasted[0]!;
      const flatter = ramp.map((point) => ({ ...point, midi: 60 }));
      apply(scoped, drawStrokeOps(stateOf(scoped), flatter, null, kept));
      expect(stateOf(scoped).edits?.strokes?.map((stroke) => stroke.id)).toEqual([
        kept.id,
        pasted[1]!.id,
      ]);
      const reshaped = stateOf(scoped).edits!.strokes!.find((stroke) => stroke.id === kept.id)!;
      apply(scoped, deleteStrokeOps(stateOf(scoped), reshaped));
      const after = stateOf(scoped);
      expect(after.edits?.strokes?.map((stroke) => stroke.id)).toEqual([pasted[1]!.id]);
      expect(after.blobs.find((blob) => blob.id === left.id)!.pitchOffset).toBe(1);
      expect(scoped.undo()).toBe(true);
      expect(stateOf(scoped).edits?.strokes).toHaveLength(2);
    } finally {
      scoped.free();
    }
  });

  it('stretches a selection of blobs by its edge, keeping their proportions', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const chosen = state.blobs.slice(0, 2);
      const from = { start: chosen[0]!.start, end: chosen[1]!.end };
      const to = { start: from.start, end: from.start + (from.end - from.start) * 1.5 };
      const selected = {
        ...state,
        selection: { blobs: chosen.map((blob) => blob.id), anchors: [], ranges: [from] },
      };

      // Blob and Pitch: the audio stretches, the second blob starting half as far in again.
      const both = stretchOps(selected, from, to, false, 'sung');
      apply(scoped, both.ops);
      const [first, second] = stateOf(scoped).blobs;
      expect(first!.timeScale).toBeCloseTo(1.5, 9);
      const wanted = from.start + (chosen[1]!.start - from.start) * 1.5;
      expect(second!.start + second!.timeOffset).toBeCloseTo(wanted, 9);
      expect(both.ranges[0]!.end).toBeCloseTo(to.end, 9);

      // With ripple, the blob after the selection moves by as much as the edge did.
      expect(scoped.undo()).toBe(true);
      const rippled = stretchOps(selected, from, to, true, 'sung');
      apply(scoped, rippled.ops);
      const third = stateOf(scoped).blobs[2]!;
      expect(third.timeOffset).toBeCloseTo(to.end - from.end, 9);
      expect(scoped.undo()).toBe(true);

      // Blob: the spans stretch over audio that stays where it is, until a neighbour stops them.
      const shrunk = { start: from.start, end: from.start + (from.end - from.start) * 0.5 };
      apply(scoped, stretchOps({ ...selected, editMode: 'blob' }, from, shrunk, false, 'sung').ops);
      const blobs = stateOf(scoped).blobs;
      expect(blobs[0]!.timeOffset).toBe(0);
      expect(blobs[0]!.end).toBeCloseTo(from.start + (chosen[0]!.end - from.start) * 0.5, 9);
      expect(blobs[1]!.end).toBeCloseTo(shrunk.end, 9);
    } finally {
      scoped.free();
    }
  });

  it('replaces the part of a curve a pasted curve lands on and keeps the rest either side', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const blobs = state.blobs;
      const line = (from: number, to: number, midi: (t: number) => number) =>
        Array.from({ length: 41 }, (_, i) => {
          const time = from + ((to - from) * i) / 40;
          return { time, midi: midi(time) };
        });
      // A freehand line across the first three blobs, and a Bezier over the last.
      const hand = line(blobs[0]!.start, blobs[2]!.end, (t) => 60 + Math.sin(t * 20));
      apply(scoped, drawStrokeOps(stateOf(scoped), hand, null, null));
      const last = blobs[blobs.length - 1]!;
      const a = { time: last.start, midi: 64 };
      const d = { time: last.end, midi: 67 };
      const c1 = { time: a.time + (d.time - a.time) / 3, midi: 70 };
      const c2 = { time: a.time + ((d.time - a.time) * 2) / 3, midi: 61 };
      const ramp = line(a.time, d.time, (t) => 64 + ((t - a.time) / (d.time - a.time)) * 3);
      apply(scoped, drawStrokeOps(stateOf(scoped), ramp, [a, c1, c2, d], null));
      expect(stateOf(scoped).edits?.strokes).toHaveLength(2);

      // Copy the Bezier and paste it into the middle of the freehand line.
      const drawn = stateOf(scoped);
      const copied = copyPitch({
        ...drawn,
        selection: { blobs: [], anchors: [], ranges: [{ start: a.time, end: d.time }] },
      });
      if (copied?.kind !== 'pitch') throw new Error('nothing copied');
      const at = blobs[1]!.start;
      const length = d.time - a.time;
      apply(scoped, [
        ...pastePitchOps(drawn, placePitch(copied, null, at)),
        ...placeStrokes(drawn, copied, null, at),
      ]);
      const strokes = stateOf(scoped).edits!.strokes!;
      // The freehand line is now two, around the pasted Bezier, and nothing overlaps.
      expect(strokes).toHaveLength(4);
      const spans = strokes
        .map((stroke) => [stroke.points[0]!.time, stroke.points[stroke.points.length - 1]!.time])
        .sort((x, y) => x[0]! - y[0]!);
      for (let i = 1; i < spans.length; i += 1) {
        expect(spans[i]![0]!).toBeGreaterThanOrEqual(spans[i - 1]![1]! - 1e-6);
      }
      const pasted = strokes.find((stroke) => Math.abs(stroke.points[0]!.time - at) < 1e-6)!;
      expect(pasted.bezier).toBeDefined();
      expect(pasted.points[pasted.points.length - 1]!.time).toBeCloseTo(at + length, 6);
      expect(scoped.undo()).toBe(true);
      expect(stateOf(scoped).edits?.strokes).toHaveLength(2);
    } finally {
      scoped.free();
    }
  });

  it('pastes a drawing over another exactly as it was drawn', () => {
    const scoped = session();
    try {
      const blobs = stateOf(scoped).blobs;
      const line = (from: number, to: number, midi: (t: number) => number) =>
        Array.from({ length: 41 }, (_, i) => {
          const time = from + ((to - from) * i) / 40;
          return { time, midi: midi(time) };
        });
      const under = line(blobs[0]!.start, blobs[2]!.end, () => 55);
      apply(scoped, drawStrokeOps(stateOf(scoped), under, null, null));
      const last = blobs[blobs.length - 1]!;
      const drawn = line(last.start, last.end, (t) => 62 + 2 * Math.sin((t - last.start) * 30));
      apply(scoped, drawStrokeOps(stateOf(scoped), drawn, null, null));

      // Copied with the drawing picked up, pasted with the one under it picked up.
      const state = stateOf(scoped);
      const pick = (points: { time: number }[]) => ({
        ...state,
        selection: {
          blobs: [],
          anchors: [],
          ranges: [{ start: points[0]!.time, end: points[points.length - 1]!.time }],
        },
      });
      const copied = copyPitch(pick(drawn));
      if (copied?.kind !== 'pitch') throw new Error('nothing copied');
      const target = pick(under);
      const at = under[0]!.time;
      const range = target.selection.ranges[0]!;
      apply(scoped, [
        ...pastePitchOps(target, placePitch(copied, range, 0)),
        ...placeStrokes(target, copied, range, 0),
      ]);

      const after = stateOf(scoped);
      const pasted = after.edits!.strokes!.find(
        (stroke) => Math.abs(stroke.points[0]!.time - at) < 1e-6,
      )!;
      const shift = at - drawn[0]!.time;
      // The same length and the same pitches, only moved in time.
      expect(pasted.points).toHaveLength(drawn.length);
      pasted.points.forEach((point, index) => {
        expect(point.time).toBeCloseTo(drawn[index]!.time + shift, 6);
        expect(point.midi).toBeCloseTo(drawn[index]!.midi, 6);
      });
      // And it is what is heard wherever a blob sings under it.
      for (const index of [5, 10, 20]) {
        const point = pasted.points[index]!;
        const blob = after.blobs.find((b) => point.time >= b.start && point.time < b.end);
        if (blob === undefined) continue;
        const heard = planTargetMidi(after.plan!, point.time);
        if (heard !== null) expect(Math.abs(heard - point.midi)).toBeLessThan(0.1);
      }
    } finally {
      scoped.free();
    }
  });

  it('keeps a pasted line whole as curves, with no gaps where the frames under it are unpitched', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const [source, target] = [state.blobs[0]!, state.blobs[2]!];
      const range = { start: source.start, end: source.end };
      const copied = copyPitch({
        ...state,
        selection: { blobs: [], anchors: [], ranges: [range] },
      });
      if (copied?.kind !== 'pitch') throw new Error('nothing copied');
      expect(copied.strokes).toHaveLength(0);
      apply(scoped, [
        ...pastePitchOps(state, placePitch(copied, null, target.start)),
        ...placeStrokes(state, copied, null, target.start),
      ]);
      const strokes = stateOf(scoped).edits!.strokes!;
      const spans = strokes
        .map((stroke) => [stroke.points[0]!.time, stroke.points[stroke.points.length - 1]!.time])
        .sort((a, b) => a[0]! - b[0]!);
      // One run of curves from the paste point to the end of what was copied, end to end.
      expect(spans[0]![0]!).toBeCloseTo(target.start, 6);
      expect(spans[spans.length - 1]![1]!).toBeCloseTo(target.start + (range.end - range.start), 6);
      for (let i = 1; i < spans.length; i += 1) {
        expect(spans[i]![0]!).toBeCloseTo(spans[i - 1]![1]!, 6);
      }
    } finally {
      scoped.free();
    }
  });

  it('copies only the curves that run into a span, so a paste meets its neighbours cleanly', () => {
    const scoped = session();
    try {
      const b = stateOf(scoped).blobs;
      const line = (from: number, to: number, midi: (t: number) => number) =>
        Array.from({ length: 41 }, (_, i) => {
          const time = from + ((to - from) * i) / 40;
          return { time, midi: midi(time) };
        });
      apply(
        scoped,
        drawStrokeOps(
          stateOf(scoped),
          line(b[0]!.start, b[3]!.end, () => 66),
          null,
          null,
        ),
      );
      const ramp = line(b[1]!.start, b[1]!.end, (t) => 58 + (t - b[1]!.start) * 10);
      apply(
        scoped,
        drawStrokeOps(stateOf(scoped), ramp, [ramp[0]!, ramp[10]!, ramp[30]!, ramp[40]!], null),
      );
      const state = stateOf(scoped);
      const span = { start: ramp[0]!.time, end: ramp[40]!.time };
      const copied = copyPitch({ ...state, selection: { blobs: [], anchors: [], ranges: [span] } });
      if (copied?.kind !== 'pitch') throw new Error('nothing copied');
      // The flat line either side ends where the ramp begins, and none of it is copied with it.
      const copiedLine = copied.lines[0]!;
      expect(copiedLine[0]!.midi).toBeCloseTo(58, 6);
      expect(copiedLine[copiedLine.length - 1]!.midi).toBeCloseTo(ramp[40]!.midi, 6);

      const at = b[2]!.start + 0.05;
      apply(scoped, [
        ...pastePitchOps(state, placePitch(copied, null, at)),
        ...placeStrokes(state, copied, null, at),
      ]);
      // Every blob's anchors run forward with one pitch at each instant.
      for (const blob of stateOf(scoped).blobs) {
        const anchors = blob.curve.anchors;
        for (let i = 1; i < anchors.length; i += 1) {
          const [prev, next] = [anchors[i - 1]!, anchors[i]!];
          expect(next.time).toBeGreaterThanOrEqual(prev.time);
          if (next.time === prev.time) expect(next.midi).toBe(prev.midi);
        }
      }
    } finally {
      scoped.free();
    }
  });

  it('cuts a Bezier into Beziers that keep its shape', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const [first, last] = [state.blobs[0]!, state.blobs[state.blobs.length - 1]!];
      const a = { time: first.start, midi: 60 };
      const d = { time: last.end, midi: 66 };
      const c1 = { time: a.time + (d.time - a.time) / 3, midi: 72 };
      const c2 = { time: a.time + ((d.time - a.time) * 2) / 3, midi: 54 };
      const curve = Array.from({ length: 81 }, (_, i) => {
        const u = i / 80;
        const w = [(1 - u) ** 3, 3 * u * (1 - u) ** 2, 3 * u * u * (1 - u), u ** 3];
        const mix = (key: 'time' | 'midi') =>
          w[0]! * a[key] + w[1]! * c1[key] + w[2]! * c2[key] + w[3]! * d[key];
        return { time: mix('time'), midi: mix('midi') };
      });
      apply(scoped, drawStrokeOps(state, curve, [a, c1, c2, d], null));
      // A flat line across the middle third leaves a Bezier either side of it.
      const from = a.time + (d.time - a.time) / 3;
      const to = a.time + ((d.time - a.time) * 2) / 3;
      const flat = [
        { time: from, midi: 60 },
        { time: to, midi: 60 },
      ];
      apply(scoped, drawStrokeOps(stateOf(scoped), flat, null, null));
      const pieces = stateOf(scoped).edits!.strokes!.filter((stroke) => stroke.bezier);
      expect(pieces).toHaveLength(2);
      // Each piece's own Bezier still passes through the original curve where it was cut.
      const left = pieces.find((stroke) => stroke.bezier![0].time === a.time)!;
      expect(left.bezier![3].time).toBeCloseTo(from, 6);
      const onCurve = curve.reduce((best, point) =>
        Math.abs(point.time - from) < Math.abs(best.time - from) ? point : best,
      );
      expect(Math.abs(left.bezier![3].midi - onCurve.midi)).toBeLessThan(0.2);
    } finally {
      scoped.free();
    }
  });

  it('cuts pitch back to its sung pitch or to a flat line', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const blob = state.blobs[0]!;
      scoped.applyEdit(JSON.stringify({ type: 'setPitchOffset', blob: blob.id, semitones: 3 }));
      const moved = stateOf(scoped);
      const whole = [{ start: blob.start, end: blob.end }];
      apply(scoped, cutPitchOps(moved, whole, 'sung'));
      expect(stateOf(scoped).blobs[0]!.pitchOffset).toBe(0);

      apply(scoped, cutPitchOps(stateOf(scoped), whole, 'flat'));
      const flat = stateOf(scoped).blobs[0]!;
      expect(flat.curve.anchors.length).toBeGreaterThan(1);
      expect(new Set(flat.curve.anchors.map((anchor) => anchor.midi)).size).toBe(1);
    } finally {
      scoped.free();
    }
  });

  it('pastes a copied part of a clip as a clip of its own that overlaps the first', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const part = {
        ...state,
        selection: { blobs: [], anchors: [], ranges: [{ start: 0.2, end: 0.9 }] },
      };
      const copied = copyClips(part);
      expect(copied?.kind).toBe('clips');
      if (copied?.kind !== 'clips') return;
      const added = JSON.parse(
        scoped.pasteClips(JSON.stringify(copied.parts), 0.5, 'overlap'),
      ) as number[];
      expect(added).toEqual([1]);
      const clips = (JSON.parse(scoped.stateJson()) as EditState).clips;
      expect(clips).toHaveLength(2);
      expect(clips[1]!.window).toEqual({ start: 0.2, end: 0.9 });
      expect(clips[1]!.position + clips[1]!.window!.start).toBeCloseTo(0.5, 9);
      expect((JSON.parse(scoped.historyJson()) as { undo: string }).undo).toBe('Grouped Edit');
      expect(scoped.undo()).toBe(true);
      expect((JSON.parse(scoped.stateJson()) as EditState).clips).toHaveLength(1);
    } finally {
      scoped.free();
    }
  });

  it('cuts a span out of the middle of a clip and leaves two', () => {
    const scoped = session();
    try {
      const state = stateOf(scoped);
      const middle = {
        ...state,
        selection: { blobs: [], anchors: [], ranges: [{ start: 0.6, end: 0.8 }] },
      };
      scoped.cutClips(JSON.stringify(cutClipSpans(middle)), false);
      const clips = (JSON.parse(scoped.stateJson()) as EditState).clips;
      expect(clips).toHaveLength(2);
      expect(clips[0]!.window?.end).toBeCloseTo(0.6, 9);
      expect(clips[1]!.window?.start).toBeCloseTo(0.8, 9);
    } finally {
      scoped.free();
    }
  });

  it('trims a clip from either end, keeping the hidden audio to untrim', () => {
    const scoped = session();
    try {
      const duration = fixture.samples.length / fixture.sampleRate;
      const trim = (start: number, end: number): void => {
        scoped.applyEdit(JSON.stringify({ type: 'trimClip', clip: 0, start, end }));
      };
      const blobs = stateOf(scoped).blobs.length;
      trim(0.3, duration - 0.3);
      expect(scoped.outputFrames()).toBe(Math.round((duration - 0.3) * fixture.sampleRate));
      expect(stateOf(scoped).blobs.length).toBeLessThanOrEqual(blobs);
      trim(0, duration);
      expect((JSON.parse(scoped.stateJson()) as EditState).clips[0]!.window).toBeUndefined();
      expect(stateOf(scoped).blobs).toHaveLength(blobs);
    } finally {
      scoped.free();
    }
  });

  it('writes nothing new into a project nobody trimmed or pasted into', () => {
    const scoped = session();
    try {
      const json = scoped.projectJson(JSON.stringify(initialState().view));
      expect(json).not.toContain('"window"');
      expect(json).not.toContain('"keepAudio"');
    } finally {
      scoped.free();
    }
  });
});
