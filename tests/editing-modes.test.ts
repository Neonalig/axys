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
  liftRunOps,
  outsideRuns,
  pastePitchOps,
  placePitch,
  samplePitch,
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
      const after = stateOf(scoped, { outsidePitch: true });
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
      const copied = copyPitch(selecting(state, source), false);
      expect(copied?.kind).toBe('pitch');
      const range = { start: target.start, end: target.end };
      const points = placePitch(copied!, range, 0);
      apply(scoped, pastePitchOps(state, points, false));

      const after = stateOf(scoped);
      const middle = (target.start + target.end) / 2;
      const heard = planTargetMidi(after.plan!, middle);
      const wanted = samplePitch(state, [{ start: source.start, end: source.end }], false);
      const median = wanted.map((point) => point.midi).sort((a, b) => a - b)[wanted.length >> 1]!;
      expect(heard).not.toBeNull();
      expect(Math.abs(heard! - median)).toBeLessThan(0.5);
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
      const added = JSON.parse(scoped.pasteClips(JSON.stringify(copied.parts), 0.5)) as number[];
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
      scoped.cutClips(JSON.stringify(cutClipSpans(middle)));
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
