// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What Cut, Copy and Paste carry in each edit mode, and the edits they make.
 *
 * Blob and Pitch takes the audio itself: the clips under the selection, with their blobs, edits
 * and analysis. Blob takes blobs alone and leaves the audio where it is. Pitch takes the pitch
 * line as it is heard and leaves both the audio and the blobs. Every function here is pure: it
 * reads the state and returns what to copy or which edits to commit.
 */

import type { AppState, EditMode } from './store.js';
import type { TimeRange } from './selection.js';
import type { Anchor, Blob, ClipId, EditOp } from '../core/types.js';
import { CLIP_ID_BITS, clipEnd, clipOf, clipStart, MIN_BLOB_SECONDS } from '../core/types.js';
import type { ClipPart } from '../core/wasm.js';
import {
  blobOutputEnd,
  blobOutputStart,
  outputToSource,
  sourceToOutput,
} from '../editor/layers/blobs.js';
import { planTargetMidi } from '../editor/layers/pitch.js';

/** One point of a heard pitch line, in output seconds and fractional MIDI. */
export interface PitchPoint {
  time: number;
  midi: number;
}

/**
 * What the clipboard holds.
 *
 * @remarks `start` and `end` bound what was copied: output seconds for pitch, project seconds for
 * blobs. Clips carry their own spans in each part.
 */
export type ClipboardContent =
  | { kind: 'clips'; parts: ClipPart[] }
  | { kind: 'blobs'; blobs: Blob[]; start: number; end: number }
  | { kind: 'pitch'; points: PitchPoint[]; start: number; end: number };

/** What a span of pitch is left at once its line is cut away. */
export type PitchCutFill = 'sung' | 'flat';

/** Longest gap in a pitch line, in seconds, that still reads as one line. */
const LINE_GAP_SECONDS = 0.05;

/** Longest gap between detected frames, in seconds, that one outside run spans. */
const RUN_GAP_SECONDS = 0.03;

/** Shortest outside run an edit makes a blob of, in seconds. */
const MIN_RUN_SECONDS = 0.03;

/** Tolerance when comparing times, in seconds. */
const EPS = 1e-6;

/** The name of what a mode's clipboard commands act on, for messages. */
export function clipboardNoun(mode: EditMode): string {
  return mode === 'pitch' ? 'Pitch' : mode === 'blob' ? 'Blobs' : 'Clips';
}

/** The clips of the editor's layer, in the order the project holds them. */
function layerClips(state: AppState): NonNullable<AppState['edits']>['clips'] {
  const layer = new Set(state.layer);
  return (state.edits?.clips ?? []).filter((clip) => layer.has(clip.id));
}

/** The layer clip heard at a project time, or `undefined` in a gap between clips. */
function clipAt(
  state: AppState,
  seconds: number,
): NonNullable<AppState['edits']>['clips'][number] | undefined {
  return layerClips(state).find(
    (clip) => seconds >= clipStart(clip) - EPS && seconds < clipEnd(clip) + EPS,
  );
}

/**
 * The part of every layer clip each selected span reaches, in project seconds.
 *
 * @remarks A span reaching every blob a clip has takes the whole clip, silence at its ends
 * included, which is what double-clicking a clip's title asks for.
 */
function clipSpans(state: AppState): { clip: ClipId; start: number; end: number }[] {
  const spans: { clip: ClipId; start: number; end: number }[] = [];
  for (const clip of layerClips(state)) {
    const from = clipStart(clip);
    const to = clipEnd(clip);
    const own = state.blobs.filter((blob) => clipOf(blob.id) === clip.id);
    const first = Math.min(...own.map(blobOutputStart));
    const last = Math.max(...own.map(blobOutputEnd));
    for (const range of state.selection.ranges) {
      let start = Math.max(range.start, from);
      let end = Math.min(range.end, to);
      if (end - start < MIN_BLOB_SECONDS) continue;
      if (own.length > 0 && range.start <= first + EPS && range.end >= last - EPS) {
        start = Math.min(start, from);
        end = Math.max(end, to);
      }
      spans.push({ clip: clip.id, start, end });
    }
  }
  return spans;
}

/** Copies the selected parts of every layer clip, or `null` with nothing selected. */
export function copyClips(state: AppState): ClipboardContent | null {
  const clips = new Map(layerClips(state).map((clip) => [clip.id, clip]));
  const parts: ClipPart[] = [];
  for (const span of clipSpans(state)) {
    const clip = clips.get(span.clip);
    if (clip !== undefined)
      parts.push({ clip: structuredClone(clip), start: span.start, end: span.end });
  }
  return parts.length === 0 ? null : { kind: 'clips', parts };
}

/** The spans Cut takes out of the layer's clips. */
export function cutClipSpans(state: AppState): { clip: ClipId; start: number; end: number }[] {
  return clipSpans(state);
}

/** The blobs of the layer the selection covers. */
function selectedBlobs(state: AppState): Blob[] {
  const wanted = new Set(state.selection.blobs);
  return state.blobs.filter((blob) => wanted.has(blob.id));
}

/** Copies the selected blobs' shapes and levels, or `null` with none selected. */
export function copyBlobs(state: AppState): ClipboardContent | null {
  const blobs = selectedBlobs(state);
  if (blobs.length === 0) return null;
  return {
    kind: 'blobs',
    blobs: structuredClone(blobs),
    start: Math.min(...blobs.map((blob) => blob.start)),
    end: Math.max(...blobs.map((blob) => blob.end)),
  };
}

/** Removes the selected blobs and leaves their audio playing as sung. */
export function cutBlobOps(state: AppState): EditOp[] {
  const blobs = selectedBlobs(state).map((blob) => blob.id);
  return blobs.length === 0 ? [] : [{ type: 'deleteBlobs', blobs, keepAudio: true }];
}

/** A blob for the core to place in a clip, numbered only by the clip it goes to. */
function newBlob(clip: ClipId, start: number, end: number, fields: Partial<Blob> = {}): Blob {
  return {
    id: clip * 2 ** CLIP_ID_BITS,
    start,
    end,
    detectedCenter: 0,
    pitchOffset: 0,
    timeOffset: 0,
    timeScale: 1,
    subregions: [],
    curve: { anchors: [] },
    excluded: false,
    gainDb: 0,
    ...fields,
  };
}

/**
 * Lays copied blobs over the audio at `at`, replacing the blobs already there.
 *
 * @remarks The audio does not move: each blob lands over whatever the clip heard at its new time
 * holds, keeping its offset, level and exclusion. Its drawn curve belonged to the audio it came
 * from, so it is left behind. A blob landing outside every clip is dropped.
 */
export function pasteBlobOps(state: AppState, content: ClipboardContent, at: number): EditOp[] {
  if (content.kind !== 'blobs') return [];
  const shift = at - content.start;
  const replaced = new Set<number>();
  const added: Blob[] = [];
  for (const blob of content.blobs) {
    const wanted = { start: blob.start + shift, end: blob.end + shift };
    const clip = clipAt(state, (wanted.start + wanted.end) / 2);
    if (clip === undefined) continue;
    const start = Math.max(wanted.start, clipStart(clip));
    const end = Math.min(wanted.end, clipEnd(clip));
    if (end - start < MIN_BLOB_SECONDS) continue;
    for (const existing of state.blobs) {
      if (clipOf(existing.id) !== clip.id) continue;
      if (existing.end > start + EPS && existing.start < end - EPS) replaced.add(existing.id);
    }
    added.push(
      newBlob(clip.id, start, end, {
        pitchOffset: blob.pitchOffset,
        gainDb: blob.gainDb,
        excluded: blob.excluded,
      }),
    );
  }
  const ops: EditOp[] = [];
  if (replaced.size > 0) ops.push({ type: 'deleteBlobs', blobs: [...replaced], keepAudio: true });
  if (added.length > 0) ops.push({ type: 'addBlobs', blobs: added });
  return added.length === 0 ? [] : ops;
}

/** The blob whose source span holds a project time, scanning from a hint in time order. */
function blobHolding(blobs: readonly Blob[], seconds: number): Blob | undefined {
  return blobs.find((blob) => seconds >= blob.start && seconds < blob.end);
}

/**
 * The pitch line heard across some output spans, one point per detected frame.
 *
 * @remarks Inside a blob the point is what the plan makes the blob sing, placed where the blob's
 * timing puts it. Outside every blob it is the detected pitch where it was sung, and is read only
 * when `outside` says those lines are shown.
 */
export function samplePitch(
  state: AppState,
  ranges: readonly TimeRange[],
  outside: boolean,
): PitchPoint[] {
  const track = state.track;
  if (track === null || ranges.length === 0) return [];
  const points: PitchPoint[] = [];
  const within = (time: number): boolean =>
    ranges.some((range) => time >= range.start - EPS && time <= range.end + EPS);
  for (let i = 0; i < track.times.length; i += 1) {
    const source = track.times[i] ?? 0;
    const detected = track.midi[i] ?? Number.NaN;
    if (!Number.isFinite(detected)) continue;
    const blob = blobHolding(state.blobs, source);
    if (blob === undefined) {
      if (outside && within(source) && clipAt(state, source) !== undefined) {
        points.push({ time: source, midi: detected });
      }
      continue;
    }
    const time = sourceToOutput(blob, source);
    if (!within(time)) continue;
    const heard = state.plan === null ? null : planTargetMidi(state.plan, source);
    points.push({ time, midi: heard ?? detected });
  }
  points.sort((a, b) => a.time - b.time);
  return points;
}

/** Copies the heard pitch line across the selection, or `null` where there is none. */
export function copyPitch(state: AppState, outside: boolean): ClipboardContent | null {
  const points = samplePitch(state, state.selection.ranges, outside);
  if (points.length < 2) return null;
  const ranges = state.selection.ranges;
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  return { kind: 'pitch', points, start, end };
}

/** A pitch line split where it has a gap longer than {@link LINE_GAP_SECONDS}. */
function lineRuns(points: readonly PitchPoint[]): PitchPoint[][] {
  const runs: PitchPoint[][] = [];
  let current: PitchPoint[] = [];
  for (const point of points) {
    const last = current[current.length - 1];
    if (last !== undefined && point.time - last.time > LINE_GAP_SECONDS) {
      runs.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** The part of a line inside a span, with a point placed at each edge it crosses. */
function lineWithin(points: readonly PitchPoint[], start: number, end: number): PitchPoint[] {
  const inside: PitchPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) continue;
    const previous = points[index - 1];
    if (previous !== undefined) {
      for (const edge of [start, end]) {
        if (edge > previous.time && edge < point.time) {
          const t = (edge - previous.time) / (point.time - previous.time);
          inside.push({ time: edge, midi: previous.midi + (point.midi - previous.midi) * t });
        }
      }
    }
    if (point.time >= start && point.time <= end) inside.push(point);
  }
  inside.sort((a, b) => a.time - b.time);
  return inside;
}

/** A stretch of detected pitch outside every blob, inside one clip, in project seconds. */
export interface OutsideRun {
  clip: ClipId;
  start: number;
  end: number;
}

/**
 * The stretches of detected pitch outside every blob between two project times.
 *
 * @remarks Frames closer than {@link RUN_GAP_SECONDS} are one run, held between the blobs either
 * side and inside the clip heard there. Runs too short to make a blob of are left out.
 */
export function outsideRuns(state: AppState, from: number, to: number): OutsideRun[] {
  const track = state.track;
  if (track === null) return [];
  const hop = track.times.length > 1 ? (track.times[1] ?? 0) - (track.times[0] ?? 0) : 0.005;
  const runs: OutsideRun[] = [];
  let open: { start: number; last: number } | null = null;
  const close = (): void => {
    if (open === null) return;
    const run = fitRun(state, open.start, open.last + hop);
    if (run !== null) runs.push(run);
    open = null;
  };
  for (let i = 0; i < track.times.length; i += 1) {
    const time = track.times[i] ?? 0;
    if (time < from - hop) continue;
    if (time > to) break;
    const voiced = Number.isFinite(track.midi[i] ?? Number.NaN);
    if (!voiced || blobHolding(state.blobs, time) !== undefined) {
      if (open !== null && time - open.last > RUN_GAP_SECONDS) close();
      continue;
    }
    if (open !== null && time - open.last > RUN_GAP_SECONDS) close();
    if (open === null) open = { start: time, last: time };
    else open.last = time;
  }
  close();
  return runs
    .map((run) => ({
      ...run,
      start: Math.max(run.start, from),
      end: Math.min(run.end, to),
    }))
    .filter((run) => run.end - run.start >= MIN_RUN_SECONDS);
}

/** A run held inside its clip and between the blobs around it, or `null` when too short. */
function fitRun(state: AppState, start: number, end: number): OutsideRun | null {
  const clip = clipAt(state, start);
  if (clip === undefined) return null;
  let from = Math.max(start, clipStart(clip));
  let to = Math.min(end, clipEnd(clip));
  for (const blob of state.blobs) {
    if (clipOf(blob.id) !== clip.id) continue;
    if (blob.end <= from + EPS || blob.start >= to - EPS) continue;
    if (blob.start >= from) to = Math.min(to, blob.start);
    else from = Math.max(from, blob.end);
  }
  return to - from >= MIN_RUN_SECONDS ? { clip: clip.id, start: from, end: to } : null;
}

/** The outside run holding a project time, or `null`. */
export function outsideRunAt(state: AppState, seconds: number): OutsideRun | null {
  return (
    outsideRuns(state, seconds - 30, seconds + 30).find(
      (run) => seconds >= run.start - EPS && seconds <= run.end + EPS,
    ) ?? null
  );
}

/** Anchors for a stretch of a heard line, in the times `time` maps each point to. */
function anchorsOf(points: readonly PitchPoint[], time: (seconds: number) => number): Anchor[] {
  return points.map((point) => ({ time: time(point.time), midi: point.midi, interp: 'linear' }));
}

/**
 * Lays a heard pitch line over whatever it lands on.
 *
 * @remarks Each blob is given the part of the line over it and keeps the rest of what it sang.
 * Over pitch outside every blob, when `outside` says it can be edited, the line makes a blob of
 * its own. A line landing on neither is dropped.
 */
export function pastePitchOps(
  state: AppState,
  points: readonly PitchPoint[],
  outside: boolean,
): EditOp[] {
  const ops: EditOp[] = [];
  const added: Blob[] = [];
  for (const run of lineRuns(points)) {
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined || run.length < 2) continue;
    for (const blob of state.blobs) {
      const from = Math.max(blobOutputStart(blob), first.time);
      const to = Math.min(blobOutputEnd(blob), last.time);
      if (to - from < MIN_BLOB_SECONDS) continue;
      const inside = lineWithin(run, from, to);
      if (inside.length < 2) continue;
      const anchors = anchorsOf(inside, (time) =>
        Math.min(blob.end, Math.max(blob.start, outputToSource(blob, time))),
      );
      const start = anchors[0]?.time ?? blob.start;
      const end = anchors[anchors.length - 1]?.time ?? blob.end;
      ops.push({
        type: 'replacePitch',
        blob: blob.id,
        start,
        end,
        fill: { kind: 'contour', anchors },
      });
    }
    if (!outside) continue;
    for (const gap of outsideRuns(state, first.time, last.time)) {
      const inside = lineWithin(run, gap.start, gap.end);
      if (inside.length < 2) continue;
      added.push(
        newBlob(gap.clip, gap.start, gap.end, {
          curve: { anchors: anchorsOf(inside, (time) => time) },
        }),
      );
    }
  }
  if (added.length > 0) ops.push({ type: 'addBlobs', blobs: added });
  return ops;
}

/** Leaves every blob's part of the spans at its sung pitch or flat, as `fill` says. */
export function cutPitchOps(
  state: AppState,
  ranges: readonly TimeRange[],
  fill: PitchCutFill,
): EditOp[] {
  const ops: EditOp[] = [];
  for (const blob of state.blobs) {
    for (const range of ranges) {
      const from = Math.max(blobOutputStart(blob), range.start);
      const to = Math.min(blobOutputEnd(blob), range.end);
      if (to - from < MIN_BLOB_SECONDS) continue;
      ops.push({
        type: 'replacePitch',
        blob: blob.id,
        start: Math.max(blob.start, outputToSource(blob, from)),
        end: Math.min(blob.end, outputToSource(blob, to)),
        fill: { kind: fill },
      });
    }
  }
  return ops;
}

/**
 * Where copied pitch lands: stretched over the selection when there is one, else starting at the
 * playhead.
 */
export function placePitch(
  content: ClipboardContent,
  target: TimeRange | null,
  playhead: number,
): PitchPoint[] {
  if (content.kind !== 'pitch') return [];
  const length = content.end - content.start;
  if (target === null || !(length > 0)) {
    const shift = playhead - content.start;
    return content.points.map((point) => ({ time: point.time + shift, midi: point.midi }));
  }
  const scale = (target.end - target.start) / length;
  return content.points.map((point) => ({
    time: target.start + (point.time - content.start) * scale,
    midi: point.midi,
  }));
}

/**
 * Moves the pitch line across some spans without moving any audio.
 *
 * @remarks A move in time leaves the spans it came from at their sung pitch or flat, as `fill`
 * says, and lays the line where it lands. A move in pitch alone lays it back over itself.
 */
export function movePitchOps(
  state: AppState,
  ranges: readonly TimeRange[],
  seconds: number,
  semitones: number,
  fill: PitchCutFill,
  outside: boolean,
): EditOp[] {
  const points = samplePitch(state, ranges, outside);
  if (points.length < 2 || (seconds === 0 && semitones === 0)) return [];
  const moved = points.map((point) => ({
    time: point.time + seconds,
    midi: point.midi + semitones,
  }));
  const ops = seconds === 0 ? [] : cutPitchOps(state, ranges, fill);
  return [...ops, ...pastePitchOps(state, moved, outside)];
}

/**
 * Makes a blob of an outside run, moved by `semitones` in pitch and `seconds` in time.
 *
 * @remarks What moving a line outside every blob does: the run becomes a blob like any other, so
 * the move is one edit and one undo.
 */
export function liftRunOps(run: OutsideRun, semitones: number, seconds: number): EditOp[] {
  return [
    {
      type: 'addBlobs',
      blobs: [
        newBlob(run.clip, run.start, run.end, { pitchOffset: semitones, timeOffset: seconds }),
      ],
    },
  ];
}

/** A copied line's points moved by a distance, for drawing where a move lands. */
export function shiftPoints(
  points: readonly PitchPoint[],
  seconds: number,
  semitones: number,
): PitchPoint[] {
  return points.map((point) => ({ time: point.time + seconds, midi: point.midi + semitones }));
}
