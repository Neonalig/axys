// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState, ToolId } from '../app/store.js';
import type {
  Anchor,
  Blob,
  BlobId,
  Edge,
  Interp,
  ScaleSettings,
  TimelineMap,
  TimingConflict,
} from '../core/types.js';
import { noteNameWithCents } from './layers/grid.js';
import { formatClock } from './layers/ruler.js';
import { beatGrid } from './view.js';

/** Pointer travel in pixels below which a gesture counts as a click. */
export const CLICK_SLOP = 3;

/** Multiplier applied to a drag while the fine-adjustment modifier is held. */
export const FINE_FACTOR = 0.2;

/** Grab radius in pixels around a curve anchor. */
export const ANCHOR_RADIUS = 6;

/** Grab width in pixels around a blob boundary. */
export const EDGE_GRIP = 5;

/** Vertical slack in pixels around a blob body. */
export const BODY_SLACK = 4;

/** Shortest snippet an Alt-click plays, in seconds. */
export const AUDITION_SECONDS = 0.35;

/** Snap radius in pixels around a grid line or blob edge. */
export const SNAP_PIXELS = 7;

/** One editor tool and how it presents itself. */
export interface ToolDefinition {
  id: ToolId;
  /** Toolbar label. */
  label: string;
  /** One-line tooltip describing the gesture. */
  hint: string;
  /** Single-key shortcut, empty when the tool has none. */
  key: string;
  /** CSS cursor used while the tool is armed. */
  cursor: string;
}

/** Every tool in toolbar order. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    id: 'select',
    label: 'Select',
    hint: 'Click a blob, drag a band, Shift adds',
    key: 'V',
    cursor: 'default',
  },
  {
    id: 'split',
    label: 'Slice',
    hint: 'Click a blob to slice it in two',
    key: 'X',
    cursor: 'col-resize',
  },
  {
    id: 'pitch',
    label: 'Move Pitch',
    hint: 'Drag in pitch, Shift semitones, Alt fine, Ctrl scale',
    key: 'P',
    cursor: 'ns-resize',
  },
  { id: 'pen', label: 'Draw Curve', hint: 'Drag a freehand target', key: 'B', cursor: 'crosshair' },
  {
    id: 'line',
    label: 'Draw Ramp',
    hint: 'Drag a ramp, Alt curves it',
    key: 'N',
    cursor: 'crosshair',
  },
  {
    id: 'time',
    label: 'Move Time',
    hint: 'Drag a blob or its edges in time',
    key: 'T',
    cursor: 'ew-resize',
  },
];

/** The definition of one tool. */
export function toolDefinition(id: ToolId): ToolDefinition {
  const found = TOOLS.find((tool) => tool.id === id);
  return found ?? { id, label: id, hint: '', key: '', cursor: 'default' };
}

/** What kind of object a pointer position lands on. */
export type HitKind = 'empty' | 'ruler' | 'loopEdge' | 'blob' | 'blobEdge' | 'anchor' | 'conflict';

/** What lies under a pointer position. */
export interface Hit {
  kind: HitKind;
  blob: BlobId | null;
  /** Which boundary, for a blob edge or a loop edge. */
  edge: Edge | null;
  /** Index into the blob's anchors. */
  anchor: number | null;
  /** The timing conflict the position falls in, when it is not over a blob. */
  conflict: TimingConflict | null;
  /** Output seconds under the cursor. */
  time: number;
  /** Source seconds under the cursor; equal to `time` outside any blob. */
  sourceTime: number;
  midi: number;
}

/** Cursor shape for a tool over a given target. */
export function cursorFor(tool: ToolId, hit: Hit): string {
  if (hit.kind === 'loopEdge' || hit.kind === 'blobEdge') {
    return 'ew-resize';
  }
  if (hit.kind === 'conflict') {
    return 'help';
  }
  if (hit.kind === 'anchor') {
    return 'grab';
  }
  if (hit.kind === 'empty' && (tool === 'pitch' || tool === 'time' || tool === 'split')) {
    return 'default';
  }
  return toolDefinition(tool).cursor;
}

/**
 * Readout describing what is under the cursor.
 *
 * @remarks The ruler has no readout of its own. It reports the time it measures, the same way
 * every other position does, because naming the control the cursor is over says less than saying
 * where the cursor is.
 */
export function describeHit(hit: Hit, state: AppState): string {
  const accidentals = state.edits?.accidentals ?? 'sharps';
  const clock = formatClock(hit.time, 0.001);
  switch (hit.kind) {
    case 'ruler':
      return clock;
    case 'loopEdge':
      return hit.edge === 'start' ? 'Loop Start' : 'Loop End';
    case 'anchor':
      return `Anchor ${noteNameWithCents(hit.midi, accidentals)}`;
    case 'blobEdge':
      return hit.edge === 'start' ? `Blob Start ${clock}` : `Blob End ${clock}`;
    case 'blob':
      return `Blob ${clock} ${noteNameWithCents(hit.midi, accidentals)}`;
    case 'conflict': {
      const conflict = hit.conflict;
      if (conflict === null) {
        return clock;
      }
      const pair = `blobs ${String(conflict.first)} and ${String(conflict.second)}`;
      return conflict.kind === 'gap'
        ? `Gap  Nothing sounds between ${pair}`
        : `Overlap  ${pair.charAt(0).toUpperCase()}${pair.slice(1)} both sound here`;
    }
    default:
      return `${clock} ${noteNameWithCents(hit.midi, accidentals)}`;
  }
}

/** Which modifier behaviour a pointer or key event asks for. */
export interface Modifiers {
  /** Shift: constrain the gesture. */
  constrain: boolean;
  /** Alt: fine adjustment. */
  fine: boolean;
  /** Ctrl or Cmd: toggle snapping. */
  snap: boolean;
}

/** Reads the modifier state of an event. */
export function modifiersOf(event: {
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}): Modifiers {
  return {
    constrain: event.shiftKey,
    fine: event.altKey,
    snap: event.ctrlKey || event.metaKey,
  };
}

/** Everything time snapping considers. */
export interface SnapContext {
  timeline: TimelineMap | null;
  /** Beat subdivisions the grid offers. */
  division: number;
  blobs: readonly Blob[];
  /** Snap radius in seconds. */
  tolerance: number;
}

/**
 * Nearest musical or structural position to a time.
 *
 * @remarks Considers beat subdivisions of the timeline and the edited edges of every blob, and
 * returns the input unchanged when nothing lies within the tolerance.
 */
export function snapTime(seconds: number, context: SnapContext): number {
  let best = seconds;
  let bestDistance = context.tolerance;
  const consider = (candidate: number): void => {
    const distance = Math.abs(candidate - seconds);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  };

  const timeline = context.timeline;
  if (timeline !== null) {
    const window = Math.max(context.tolerance * 4, 0.05);
    for (const point of beatGrid(
      timeline,
      seconds - window,
      seconds + window,
      Math.max(1, context.division),
    )) {
      consider(point.seconds);
    }
  }
  for (const blob of context.blobs) {
    const start = blob.start + blob.timeOffset;
    consider(start);
    consider(start + (blob.end - blob.start) * blob.timeScale);
  }
  return best;
}

/** How a dragged pitch is quantised. */
export type PitchSnap = 'free' | 'semitone' | 'scale';

/**
 * Quantises a fractional MIDI value.
 *
 * @remarks Scale snapping falls back to semitone snapping when the scale has no degrees.
 */
export function snapMidi(midi: number, mode: PitchSnap, scale: ScaleSettings | null): number {
  if (mode === 'free') {
    return midi;
  }
  if (mode === 'semitone' || scale === null || scale.degrees.length === 0) {
    return Math.round(midi);
  }
  const rounded = Math.round(midi);
  let best = rounded;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let octave = -1; octave <= 1; octave += 1) {
    for (const degree of scale.degrees) {
      const pitchClass = (((scale.root + degree) % 12) + 12) % 12;
      const base = Math.floor((rounded - pitchClass) / 12) * 12 + pitchClass + octave * 12;
      const distance = Math.abs(base - midi);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = base;
      }
    }
  }
  return best;
}

/**
 * One sampled point of a drawing gesture, in fractional MIDI.
 *
 * @remarks A gesture is sampled in output seconds, because a stroke crosses whatever blobs lie
 * under it and each of those reads a different source time at the same place on screen. The
 * points are converted to source seconds per blob when the stroke is committed.
 */
export interface GesturePoint {
  time: number;
  midi: number;
}

/**
 * Reduces a freehand gesture to the fewest points that stay within tolerance.
 *
 * @remarks Ramer-Douglas-Peucker over the gesture in normalised time and pitch units, so the
 * tolerances can be given as the current zoom's pixel size. Points are assumed time-ordered.
 */
export function simplifyGesture(
  points: readonly GesturePoint[],
  timeTolerance: number,
  midiTolerance: number,
): GesturePoint[] {
  if (points.length <= 2) {
    return [...points];
  }
  const time = Math.max(timeTolerance, 1e-6);
  const midi = Math.max(midiTolerance, 1e-6);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const span = stack.pop();
    if (span === undefined) {
      break;
    }
    const [from, to] = span;
    const a = points[from];
    const b = points[to];
    if (a === undefined || b === undefined || to - from < 2) {
      continue;
    }
    const ax = a.time / time;
    const ay = a.midi / midi;
    const bx = b.time / time;
    const by = b.midi / midi;
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.hypot(dx, dy);
    let worst = 0;
    let worstIndex = -1;
    for (let i = from + 1; i < to; i += 1) {
      const p = points[i];
      if (p === undefined) {
        continue;
      }
      const px = p.time / time;
      const py = p.midi / midi;
      const distance =
        length === 0
          ? Math.hypot(px - ax, py - ay)
          : Math.abs(dy * px - dx * py + bx * ay - by * ax) / length;
      if (distance > worst) {
        worst = distance;
        worstIndex = i;
      }
    }
    if (worst > 1 && worstIndex > from) {
      keep[worstIndex] = 1;
      stack.push([from, worstIndex], [worstIndex, to]);
    }
  }
  const result: GesturePoint[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (keep[i] === 1 && point !== undefined) {
      result.push(point);
    }
  }
  return result;
}

/**
 * Turns gesture points into curve anchors.
 *
 * @remarks Points that do not advance in time are dropped, so the anchors stay strictly
 * ordered as the core requires.
 */
export function gestureAnchors(points: readonly GesturePoint[], interp: Interp): Anchor[] {
  const anchors: Anchor[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (!Number.isFinite(point.time) || !Number.isFinite(point.midi)) {
      continue;
    }
    if (point.time <= previous) {
      continue;
    }
    previous = point.time;
    anchors.push({ time: point.time, midi: point.midi, interp });
  }
  return anchors;
}

/** A gesture in progress, drawn over the committed state until it is released. */
export type EditorPreview =
  | { kind: 'spanSelect'; x0: number; x1: number }
  | { kind: 'pitchDrag'; blobs: readonly BlobId[]; semitones: number; label: string }
  | { kind: 'timeDrag'; blobs: readonly BlobId[]; seconds: number; label: string }
  | { kind: 'edgeDrag'; blob: BlobId; edge: Edge; time: number; label: string }
  | { kind: 'anchorDrag'; blob: BlobId; index: number; time: number; midi: number; label: string }
  | { kind: 'curve'; points: readonly GesturePoint[]; label: string }
  | { kind: 'span'; blob: BlobId | null; start: number; end: number; label: string }
  | { kind: 'split'; blob: BlobId; time: number; label: string };
