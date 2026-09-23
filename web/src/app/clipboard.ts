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
import type { Anchor, Blob, ClipId, EditOp, Stroke, StrokePoint } from '../core/types.js';
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
  | { kind: 'pitch'; lines: PitchPoint[][]; strokes: Stroke[]; start: number; end: number };

/** What a span of pitch is left at once its line is cut away. */
export type PitchCutFill = 'sung' | 'flat';

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
 * Lays copied blobs over the audio at `at`.
 *
 * @remarks The audio does not move: each blob lands over whatever the clip heard at its new time
 * holds, keeping its offset, level and exclusion. Its drawn curve belonged to the audio it came
 * from, so it is left behind. With `replace` the blobs already there make way; without it a blob
 * fills the space around them instead, as one blob per free stretch. A blob landing outside every
 * clip is dropped.
 */
export function pasteBlobOps(
  state: AppState,
  content: ClipboardContent,
  at: number,
  replace = true,
): EditOp[] {
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
    const there = state.blobs.filter(
      (existing) =>
        clipOf(existing.id) === clip.id && existing.end > start + EPS && existing.start < end - EPS,
    );
    const fields = { pitchOffset: blob.pitchOffset, gainDb: blob.gainDb, excluded: blob.excluded };
    if (replace) {
      for (const existing of there) replaced.add(existing.id);
      added.push(newBlob(clip.id, start, end, fields));
      continue;
    }
    let from = start;
    for (const existing of [...there, ...added.filter((a) => clipOf(a.id) === clip.id)].sort(
      (a, b) => a.start - b.start,
    )) {
      if (existing.start - from >= MIN_BLOB_SECONDS && existing.start < end) {
        added.push(newBlob(clip.id, from, Math.min(existing.start, end), fields));
      }
      from = Math.max(from, existing.end);
    }
    if (end - from >= MIN_BLOB_SECONDS) added.push(newBlob(clip.id, from, end, fields));
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
 * The pitch line heard across some output spans, one continuous line per span.
 *
 * @remarks Inside a blob a point is what the plan makes the blob sing, placed where the blob's
 * timing puts it; outside every blob it is the detected pitch where it was sung. A stretch with no
 * pitch, a consonant or the gap between two blobs, is joined straight across, and the line is held
 * level out to the edges of its span, so what is copied is the whole line the span covers rather
 * than the pieces of it that happen to be sung.
 */
export function samplePitch(state: AppState, ranges: readonly TimeRange[]): PitchPoint[][] {
  const track = state.track;
  if (track === null || ranges.length === 0) return [];
  const heard: PitchPoint[] = [];
  for (let i = 0; i < track.times.length; i += 1) {
    const source = track.times[i] ?? 0;
    const detected = track.midi[i] ?? Number.NaN;
    if (!Number.isFinite(detected)) continue;
    const blob = blobHolding(state.blobs, source);
    if (blob === undefined) {
      // Pitch outside every blob is often breath or bleed, so it is read only while it is shown.
      if (state.outsidePitch && clipAt(state, source) !== undefined) {
        heard.push({ time: source, midi: detected });
      }
      continue;
    }
    const target = state.plan === null ? null : planTargetMidi(state.plan, source);
    heard.push({ time: sourceToOutput(blob, source), midi: target ?? detected });
  }
  // A kept curve is the line as it was drawn, gaps and all, so its own points stand in for what
  // the blobs under it happen to sing.
  const strokes = strokesOf(state);
  const drawn = heard.filter(
    (point) => !strokes.some((stroke) => within(strokeSpan(stroke), point.time)),
  );
  for (const stroke of strokes) drawn.push(...stroke.points);
  heard.length = 0;
  heard.push(...drawn);
  heard.sort((a, b) => a.time - b.time);
  const lines: PitchPoint[][] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    const inside = heard.filter(
      (point) => point.time >= range.start - EPS && point.time <= range.end + EPS,
    );
    const first = inside[0];
    const last = inside[inside.length - 1];
    if (first === undefined || last === undefined) continue;
    const line = [...inside];
    if (first.time > range.start + EPS) line.unshift({ time: range.start, midi: first.midi });
    if (last.time < range.end - EPS) line.push({ time: range.end, midi: last.midi });
    if (line.length >= 2) lines.push(line);
  }
  return lines;
}

/**
 * Copies the heard pitch line across the selection, and every kept curve it holds whole, or
 * `null` where there is no line.
 */
export function copyPitch(state: AppState): ClipboardContent | null {
  const ranges = state.selection.ranges;
  const lines = samplePitch(state, ranges);
  if (lines.length === 0) return null;
  const start = Math.min(...ranges.map((range) => range.start));
  const end = Math.max(...ranges.map((range) => range.end));
  const strokes = structuredClone(strokesInside(state, ranges));
  return { kind: 'pitch', lines, strokes, start, end };
}

/** The kept curves, oldest first. */
export function strokesOf(state: AppState): Stroke[] {
  return state.edits?.strokes ?? [];
}

/** The output span a kept curve covers. */
export function strokeSpan(stroke: Stroke): TimeRange {
  return {
    start: stroke.points[0]?.time ?? 0,
    end: stroke.points[stroke.points.length - 1]?.time ?? 0,
  };
}

/** A kept curve's pitch at an output time, or `null` outside its span. */
export function strokeValue(stroke: Stroke, time: number): number | null {
  const points = stroke.points;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a === undefined || b === undefined || time < a.time || time > b.time) continue;
    const span = b.time - a.time;
    return span <= 0 ? b.midi : a.midi + ((b.midi - a.midi) * (time - a.time)) / span;
  }
  return null;
}

/** Whether a time falls in a span, within {@link EPS}. */
function within(range: TimeRange, time: number): boolean {
  return time >= range.start - EPS && time <= range.end + EPS;
}

/** The kept curves lying wholly inside some spans. */
export function strokesInside(state: AppState, ranges: readonly TimeRange[]): Stroke[] {
  return strokesOf(state).filter((stroke) => {
    const span = strokeSpan(stroke);
    return ranges.some((range) => within(range, span.start) && within(range, span.end));
  });
}

/** An id no kept curve has yet. */
function nextStrokeId(state: AppState, taken: readonly number[] = []): number {
  return Math.max(-1, ...strokesOf(state).map((stroke) => stroke.id), ...taken) + 1;
}

/** A stroke moved through time and pitch by `map`, with a new id. */
function mapStroke(stroke: Stroke, id: number, map: (point: StrokePoint) => StrokePoint): Stroke {
  const moved: Stroke = { id, points: stroke.points.map(map) };
  if (stroke.bezier !== undefined) {
    const [a, b, c, d] = stroke.bezier;
    moved.bezier = [map(a), map(b), map(c), map(d)];
  }
  return moved;
}

/**
 * Keeps a drawn line whole and lays it over whatever it crosses, as one group.
 *
 * @remarks With `replacing`, the curve it reshapes lets go of the span it covered first, so
 * shortening a curve leaves the rest of that span at the blob's own pitch. Pitch outside every
 * blob is drawn over only while it is shown, where the line makes a blob of its own.
 */
export function drawStrokeOps(
  state: AppState,
  points: readonly PitchPoint[],
  bezier: Stroke['bezier'] | null,
  replacing: Stroke | null,
): EditOp[] {
  if (points.length < 2) return [];
  const ops: EditOp[] = replacing === null ? [] : releasePitchOps(state, [strokeSpan(replacing)]);
  const stroke: Stroke = {
    id: replacing?.id ?? nextStrokeId(state),
    points: [...points].sort((a, b) => a.time - b.time),
  };
  if (bezier !== null && bezier !== undefined) stroke.bezier = bezier;
  ops.push({ type: 'setStroke', stroke });
  ops.push(...pastePitchOps(state, [stroke.points], state.outsidePitch));
  return ops;
}

/** Forgets a kept curve and lets go of what it wrote into the blobs under it. */
export function deleteStrokeOps(state: AppState, stroke: Stroke): EditOp[] {
  return [
    ...releasePitchOps(state, [strokeSpan(stroke)]),
    { type: 'removeStroke', stroke: stroke.id },
  ];
}

/** Lets every blob's part of some spans go back to its own pitch, keeping its offset. */
function releasePitchOps(state: AppState, ranges: readonly TimeRange[]): EditOp[] {
  return spanPitchOps(state, ranges, { kind: 'release' });
}

/** The kept curves a pasted line brings with it, placed as the line was and given new ids. */
export function placeStrokes(
  state: AppState,
  content: ClipboardContent,
  target: TimeRange | null,
  playhead: number,
): EditOp[] {
  if (content.kind !== 'pitch') return [];
  const place = placement(content, target, playhead);
  const ids: number[] = [];
  return content.strokes.map((stroke): EditOp => {
    const id = nextStrokeId(state, ids);
    ids.push(id);
    return { type: 'setStroke', stroke: mapStroke(stroke, id, place) };
  });
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
  lines: readonly (readonly PitchPoint[])[],
  outside: boolean,
): EditOp[] {
  const ops: EditOp[] = [];
  const added: Blob[] = [];
  for (const run of lines) {
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
  // The kept curves cut with the line go with it; what they wrote is replaced below.
  const forgotten = strokesInside(state, ranges).map((stroke): EditOp => ({
    type: 'removeStroke',
    stroke: stroke.id,
  }));
  return [...spanPitchOps(state, ranges, { kind: fill }), ...forgotten];
}

/** Gives every blob's part of some spans a fill without a contour. */
function spanPitchOps(
  state: AppState,
  ranges: readonly TimeRange[],
  fill: { kind: 'sung' | 'flat' | 'release' },
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
        fill,
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
): PitchPoint[][] {
  if (content.kind !== 'pitch') return [];
  const place = placement(content, target, playhead);
  return content.lines.map((line) => line.map(place));
}

/** Where each copied point lands, for a line and the curves it carries alike. */
function placement(
  content: Extract<ClipboardContent, { kind: 'pitch' }>,
  target: TimeRange | null,
  playhead: number,
): (point: PitchPoint) => PitchPoint {
  const length = content.end - content.start;
  if (target === null || !(length > 0)) {
    const shift = playhead - content.start;
    return (point) => ({ time: point.time + shift, midi: point.midi });
  }
  const scale = (target.end - target.start) / length;
  return (point) => ({
    time: target.start + (point.time - content.start) * scale,
    midi: point.midi,
  });
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
  const lines = samplePitch(state, ranges);
  if (lines.length === 0 || (seconds === 0 && semitones === 0)) return [];
  const ops = seconds === 0 ? [] : cutPitchOps(state, ranges, fill);
  // The kept curves inside the spans move with the line, keeping their ids.
  const kept = strokesInside(state, ranges).map((stroke): EditOp => ({
    type: 'setStroke',
    stroke: mapStroke(stroke, stroke.id, (point) => ({
      time: point.time + seconds,
      midi: point.midi + semitones,
    })),
  }));
  return [...ops, ...pastePitchOps(state, shiftLines(lines, seconds, semitones), outside), ...kept];
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

/** Pitch lines moved by a distance in time and in pitch. */
export function shiftLines(
  lines: readonly (readonly PitchPoint[])[],
  seconds: number,
  semitones: number,
): PitchPoint[][] {
  return lines.map((line) =>
    line.map((point) => ({ time: point.time + seconds, midi: point.midi + semitones })),
  );
}
