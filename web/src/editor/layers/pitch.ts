// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Blob, PitchTrackArrays, RenderPlan } from '../../core/types.js';
import { clipEnd, clipStart } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import {
  blobOutputEnd,
  blobOutputStart,
  outputToSource,
  sourceToOutput,
  targetMidiAt,
} from './blobs.js';

/** Height in pixels of the unvoiced strip along the bottom of the pitch area. */
const UNVOICED_STRIP = 7;

/** Confidence at or below which a frame is shaded as uncertain. */
const LOW_CONFIDENCE = 0.5;

/** Opacity bands the detected line is grouped into, weakest first. */
const ALPHA_BANDS = [0.25, 0.45, 0.7, 1] as const;

/** Shortest a detected column is drawn, in pixels, so a steady note is never a sub-pixel mark. */
const MIN_COLUMN_HEIGHT = 1.5;

interface Columns {
  count: number;
  /** Screen x of the first column, which is a whole number of columns from time zero. */
  originX: number;
  voiced: Uint8Array;
  low: Float32Array;
  high: Float32Array;
  confidence: Float32Array;
  unvoiced: Float32Array;
}

/**
 * Reduces the track to one column per pixel.
 *
 * @remarks Columns are cut on a grid anchored at time zero rather than at the left edge of the
 * view, so panning does not move frames between columns. Anchoring on the edge made the line
 * shuffle its own shape as the view slid under it, which reads as the whole track shimmering.
 */
function collect(track: PitchTrackArrays, viewport: Viewport): Columns {
  const count = Math.max(1, Math.ceil(viewport.width) + 1);
  const step = viewport.secondsPerPixel;
  const firstColumn = Math.floor(viewport.view.visibleStart / step);
  const originX = viewport.timeToX(firstColumn * step);
  // One frame of margin at each edge, so a frame just off screen still contributes the segment
  // that reaches the edge rather than leaving the line short of it.
  const hop = frameHop(track);
  const from = viewport.view.visibleStart - hop;
  const to = viewport.view.visibleEnd + hop;
  const columns: Columns = {
    count,
    originX,
    voiced: new Uint8Array(count),
    low: new Float32Array(count),
    high: new Float32Array(count),
    confidence: new Float32Array(count),
    unvoiced: new Float32Array(count),
  };
  const weight = new Float32Array(count);
  for (let i = 0; i < track.times.length; i += 1) {
    const time = track.times[i] ?? 0;
    // A timing edit can carry frames past later ones, so the track is not always in time order.
    if (time < from || time > to) {
      continue;
    }
    const column = Math.floor(time / step) - firstColumn;
    if (column < 0 || column >= count) {
      continue;
    }
    const midi = track.midi[i] ?? Number.NaN;
    const confidence = track.confidence[i] ?? 0;
    if (Number.isFinite(midi)) {
      if (columns.voiced[column] === 0) {
        columns.voiced[column] = 1;
        columns.low[column] = midi;
        columns.high[column] = midi;
      } else {
        columns.low[column] = Math.min(columns.low[column] ?? midi, midi);
        columns.high[column] = Math.max(columns.high[column] ?? midi, midi);
      }
      columns.confidence[column] = (columns.confidence[column] ?? 0) + confidence;
      weight[column] = (weight[column] ?? 0) + 1;
    } else {
      const rms = track.rms[i] ?? 0;
      columns.unvoiced[column] = Math.max(columns.unvoiced[column] ?? 0, rms);
    }
  }
  for (let column = 0; column < count; column += 1) {
    const total = weight[column] ?? 0;
    if (total > 0) {
      columns.confidence[column] = (columns.confidence[column] ?? 0) / total;
    }
  }
  bridge(columns, hop / step);
  return columns;
}

/** Seconds between analysis frames, which is what a column can hold at most one of. */
function frameHop(track: PitchTrackArrays): number {
  const first = track.times[0];
  const second = track.times[1];
  if (first === undefined || second === undefined) {
    return 0;
  }
  return Math.max(0, second - first);
}

/**
 * Fills the columns a zoom leaves between two frames.
 *
 * @remarks Zoomed in past one frame per pixel, most columns hold no frame at all, and the line
 * fell apart into ticks with the gaps between them widening as the zoom went further in. A gap
 * no wider than the frame spacing is the zoom rather than an unvoiced stretch, so the two frames
 * either side of it are joined; anything wider is material with no pitch in it and stays open.
 */
function bridge(columns: Columns, framePixels: number): void {
  if (!(framePixels > 1)) {
    return;
  }
  const span = Math.ceil(framePixels) + 1;
  let previous = -1;
  for (let column = 0; column < columns.count; column += 1) {
    if (columns.voiced[column] !== 1) {
      continue;
    }
    const gap = column - previous;
    if (previous >= 0 && gap > 1 && gap <= span) {
      const lowFrom = columns.low[previous] ?? 0;
      const highFrom = columns.high[previous] ?? 0;
      const confidenceFrom = columns.confidence[previous] ?? 0;
      const lowTo = columns.low[column] ?? 0;
      const highTo = columns.high[column] ?? 0;
      const confidenceTo = columns.confidence[column] ?? 0;
      for (let between = previous + 1; between < column; between += 1) {
        const t = (between - previous) / gap;
        columns.voiced[between] = 1;
        columns.low[between] = lowFrom + (lowTo - lowFrom) * t;
        columns.high[between] = highFrom + (highTo - highFrom) * t;
        columns.confidence[between] = confidenceFrom + (confidenceTo - confidenceFrom) * t;
      }
    }
    previous = column;
  }
}

/**
 * Draws detected pitch with its confidence, unvoiced material and the edited pitch target.
 *
 * @remarks Detected pitch is reduced to one column per pixel before drawing. Unvoiced frames
 * are drawn as a strip along the bottom rather than as a pitch, and uncertain frames are shaded
 * rather than dropped, so the display never invents a stable note the analysis did not find. The
 * target follows the compiled plan when the state carries one, so scale correction and MIDI
 * guidance show as well as drawn pitch, and falls back to the blob edits alone until then.
 */
export function drawPitch(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  if (state.track === null) {
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();

  // One pass per voice, so blobs moved over each other draw two lines rather than one column
  // spanning both.
  for (const track of warpedTracks(state.track, state.blobs)) {
    const columns = collect(track, viewport);
    drawUnvoiced(ctx, columns, viewport, theme);
    drawUncertainty(ctx, columns, viewport, theme);
    drawDetected(ctx, columns, viewport, theme);
  }
  if (state.outsidePitch) {
    const outside = outsideTrack(state);
    if (outside !== null) {
      drawDetected(ctx, collect(outside, viewport), viewport, theme, OUTSIDE_STYLE);
    }
  }
  drawBridges(ctx, state.track, state.blobs, viewport, theme);
  drawTarget(ctx, state, viewport, theme);
  drawAnchors(ctx, state, viewport, theme);

  ctx.restore();
}

/**
 * The track with every frame inside a blob moved to where that blob's timing edit puts it, split
 * into voices whose blobs never overlap, and unvoiced outside every blob.
 *
 * @remarks The detected line then moves and stretches with its blob, as the waveform and the
 * target already do. Frames outside every blob stay where they were sung, in the first voice.
 * Blobs go to voices as the core splits them for playback: each to the first voice whose last
 * blob has ended. Kept per track and blob list, which every edit replaces.
 */
function warpedTracks(track: PitchTrackArrays, blobs: readonly Blob[]): PitchTrackArrays[] {
  const known = WARPED.get(track);
  if (known !== undefined && known.blobs === blobs) {
    return known.warped;
  }
  const voiceOf = voicesOf(blobs);
  const count = Math.max(0, ...voiceOf.values()) + 1;
  const members: number[][] = Array.from({ length: count }, () => []);
  const times = new Float32Array(track.times);
  const inside = new Uint8Array(times.length);
  let next = 0;
  for (let i = 0; i < times.length; i += 1) {
    const time = track.times[i] ?? 0;
    while (next < blobs.length && (blobs[next]?.end ?? 0) < time) next += 1;
    const blob = blobs[next];
    if (blob !== undefined && time >= blob.start) {
      inside[i] = 1;
      times[i] = sourceToOutput(blob, time);
      members[voiceOf.get(blob.id) ?? 0]?.push(i);
    } else {
      members[0]?.push(i);
    }
  }
  // Pitch outside every blob is not drawn: nothing there can be edited. Its level still reaches
  // the unvoiced strip.
  const warped = members
    .filter((indices) => indices.length > 0)
    .map((indices) => ({
      times: Float32Array.from(indices, (i) => times[i] ?? 0),
      midi: Float32Array.from(indices, (i) =>
        inside[i] === 1 ? (track.midi[i] ?? Number.NaN) : Number.NaN,
      ),
      confidence: Float32Array.from(indices, (i) => track.confidence[i] ?? 0),
      rms: Float32Array.from(indices, (i) => track.rms[i] ?? 0),
    }));
  WARPED.set(track, { blobs, warped });
  return warped;
}

/**
 * Continues each blob's detected line across the stretches of it that have no pitch, such as a
 * consonant or a breath, as a faint dashed line.
 *
 * @remarks Between two sung stretches the line joins their ends. Before the first and after the
 * last it runs flat to the blob's edge, so a blob always reads as one line.
 */
function drawBridges(
  ctx: CanvasRenderingContext2D,
  track: PitchTrackArrays,
  blobs: readonly Blob[],
  viewport: Viewport,
  theme: Theme,
): void {
  const path = new Path2D();
  const view = viewport.view;
  for (const blob of blobs) {
    if (blobOutputEnd(blob) < view.visibleStart || blobOutputStart(blob) > view.visibleEnd) {
      continue;
    }
    const at = (time: number): number => viewport.timeToX(sourceToOutput(blob, time));
    let last: { x: number; y: number } | null = null;
    let gap = false;
    let first = true;
    for (let i = firstFrame(track, blob.start); i < track.times.length; i += 1) {
      const time = track.times[i] ?? 0;
      if (time > blob.end) break;
      const midi = track.midi[i] ?? Number.NaN;
      if (!Number.isFinite(midi)) {
        gap = true;
        continue;
      }
      const point = { x: at(time), y: viewport.midiToY(midi) };
      if (first && gap) {
        path.moveTo(at(blob.start), point.y);
        path.lineTo(point.x, point.y);
      } else if (gap && last !== null && point.x - last.x > 2) {
        path.moveTo(last.x, last.y);
        path.lineTo(point.x, point.y);
      }
      first = false;
      gap = false;
      last = point;
    }
    if (last !== null && gap) {
      path.moveTo(last.x, last.y);
      path.lineTo(at(blob.end), last.y);
    }
  }
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = theme.pitchDetected;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  ctx.stroke(path);
  ctx.restore();
}

/** Index of the first frame at or after `seconds`. */
function firstFrame(track: PitchTrackArrays, seconds: number): number {
  let low = 0;
  let high = track.times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((track.times[middle] ?? 0) < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Each blob's voice: the first whose last blob has ended by the edited start of this one. */
function voicesOf(blobs: readonly Blob[]): Map<number, number> {
  const order = [...blobs].sort((a, b) => blobOutputStart(a) - blobOutputStart(b));
  const ends: number[] = [];
  const voices = new Map<number, number>();
  for (const blob of order) {
    const start = blobOutputStart(blob);
    let voice = ends.findIndex((end) => end <= start + 1e-9);
    if (voice === -1) {
      voice = ends.length;
      ends.push(0);
    }
    ends[voice] = blobOutputEnd(blob);
    voices.set(blob.id, voice);
  }
  return voices;
}

/** Each track's warped voices, and the blob list they were warped by. */
const WARPED = new WeakMap<
  PitchTrackArrays,
  { blobs: readonly Blob[]; warped: PitchTrackArrays[] }
>();

function drawUnvoiced(
  ctx: CanvasRenderingContext2D,
  columns: Columns,
  viewport: Viewport,
  theme: Theme,
): void {
  const base = viewport.plotTop + viewport.plotHeight - 1;
  ctx.save();
  ctx.fillStyle = theme.unvoiced;
  for (let column = 0; column < columns.count; column += 1) {
    const rms = columns.unvoiced[column] ?? 0;
    if (rms <= 0) {
      continue;
    }
    const level = Math.min(1, Math.sqrt(rms) * 2.5);
    const height = 2 + level * (UNVOICED_STRIP - 2);
    ctx.globalAlpha = 0.35 + level * 0.5;
    ctx.fillRect(columns.originX + column, base - height, 1, height);
  }
  ctx.restore();
}

function drawUncertainty(
  ctx: CanvasRenderingContext2D,
  columns: Columns,
  viewport: Viewport,
  theme: Theme,
): void {
  ctx.save();
  ctx.fillStyle = theme.confidenceLow;
  for (let column = 0; column < columns.count; column += 1) {
    if (columns.voiced[column] !== 1) {
      continue;
    }
    const confidence = columns.confidence[column] ?? 0;
    if (confidence > LOW_CONFIDENCE) {
      continue;
    }
    const spread = 0.35 + (LOW_CONFIDENCE - confidence) * 1.2;
    const top = viewport.midiToY((columns.high[column] ?? 0) + spread);
    const bottom = viewport.midiToY((columns.low[column] ?? 0) - spread);
    ctx.globalAlpha = 0.18 + (LOW_CONFIDENCE - confidence) * 0.3;
    ctx.fillRect(columns.originX + column, top, 1, Math.max(1, bottom - top));
  }
  ctx.restore();
}

function bandFor(confidence: number): number {
  const index = Math.floor(confidence * ALPHA_BANDS.length);
  return Math.min(ALPHA_BANDS.length - 1, Math.max(0, index));
}

/** How a detected line is stroked. */
interface LineStyle {
  colour: (theme: Theme) => string;
  width: number;
  dash: readonly number[];
  /** Multiplier on every confidence band's opacity. */
  alpha: number;
}

/** The detected line inside blobs, which is the one edited by default. */
const DETECTED_STYLE: LineStyle = {
  colour: (theme) => theme.pitchDetected,
  width: 2,
  dash: [3, 2],
  alpha: 1,
};

/** Detected pitch outside every blob: finer, sparser and muted, so it is never read as a blob's. */
const OUTSIDE_STYLE: LineStyle = {
  colour: (theme) => theme.textMuted,
  width: 1.5,
  dash: [1, 3],
  alpha: 0.8,
};

/**
 * The frames of the layer's track outside every blob and inside the clip heard there.
 *
 * @remarks Where it was sung, since only a blob moves pitch in time. Kept per track, blob list
 * and clip list, which every edit replaces.
 */
function outsideTrack(state: AppState): PitchTrackArrays | null {
  const track = state.track;
  if (track === null) return null;
  const clips = state.edits?.clips ?? null;
  const known = OUTSIDE.get(track);
  if (known !== undefined && known.blobs === state.blobs && known.clips === clips) {
    return known.outside;
  }
  const layer = new Set(state.layer);
  const heard = (clips ?? []).filter((clip) => layer.has(clip.id));
  const midi = new Float32Array(track.midi.length).fill(Number.NaN);
  let next = 0;
  for (let i = 0; i < track.times.length; i += 1) {
    const time = track.times[i] ?? 0;
    while (next < state.blobs.length && (state.blobs[next]?.end ?? 0) <= time) next += 1;
    const blob = state.blobs[next];
    if (blob !== undefined && time >= blob.start) continue;
    if (!heard.some((clip) => time >= clipStart(clip) && time < clipEnd(clip))) continue;
    midi[i] = track.midi[i] ?? Number.NaN;
  }
  const outside = { ...track, midi };
  OUTSIDE.set(track, { blobs: state.blobs, clips, outside });
  return outside;
}

/** Each track's outside frames, and the blob and clip lists they were read against. */
const OUTSIDE = new WeakMap<
  PitchTrackArrays,
  { blobs: readonly Blob[]; clips: unknown; outside: PitchTrackArrays }
>();

function drawDetected(
  ctx: CanvasRenderingContext2D,
  columns: Columns,
  viewport: Viewport,
  theme: Theme,
  style: LineStyle = DETECTED_STYLE,
): void {
  const paths = ALPHA_BANDS.map(() => new Path2D());
  const origin = columns.originX;
  let previousColumn = -2;
  let previousY = 0;
  for (let column = 0; column < columns.count; column += 1) {
    if (columns.voiced[column] !== 1) {
      previousColumn = -2;
      continue;
    }
    const low = columns.low[column] ?? 0;
    const high = columns.high[column] ?? 0;
    const topY = viewport.midiToY(high);
    // A steady note spans no pitch at all, so its column would be a hairline that only lands on
    // a pixel at some sub-pixel offsets and vanishes at the rest. It is given a floor instead.
    const bottomY = Math.max(viewport.midiToY(low), topY + MIN_COLUMN_HEIGHT);
    const path = paths[bandFor(columns.confidence[column] ?? 0)];
    if (path === undefined) {
      continue;
    }
    const x = origin + column + 0.5;
    if (previousColumn === column - 1) {
      path.moveTo(origin + previousColumn + 0.5, previousY);
      path.lineTo(x, bottomY);
    }
    path.moveTo(x, bottomY);
    path.lineTo(x, topY);
    previousColumn = column;
    previousY = topY;
  }

  ctx.save();
  // Thicker than the gold target line and dotted against it, so the two are told apart by shape
  // as well as by colour at any zoom.
  ctx.lineWidth = style.width;
  ctx.lineCap = 'butt';
  ctx.setLineDash([...style.dash]);
  ctx.strokeStyle = style.colour(theme);
  for (let band = 0; band < paths.length; band += 1) {
    const path = paths[band];
    if (path === undefined) {
      continue;
    }
    ctx.globalAlpha = (ALPHA_BANDS[band] ?? 1) * style.alpha;
    ctx.stroke(path);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

/** Detected pitch at a source time, or null where the frame is unvoiced or out of range. */
export function detectedAt(track: PitchTrackArrays, seconds: number): number | null {
  const length = track.times.length;
  if (length === 0) {
    return null;
  }
  const first = track.times[0] ?? 0;
  const second = track.times[1] ?? first + 0.01;
  const hop = second - first;
  if (hop <= 0) {
    return null;
  }
  const index = Math.round((seconds - first) / hop);
  if (index < 0 || index >= length) {
    return null;
  }
  const midi = track.midi[index] ?? Number.NaN;
  return Number.isFinite(midi) ? midi : null;
}

/**
 * Pitch the compiled plan produces at a source time, in fractional MIDI.
 *
 * @remarks Read straight from the plan rather than rebuilt from the ratio and this module's own
 * detected track: the two disagree wherever detection is uncertain, and the difference showed up
 * as spikes in the drawn target. Returns null where the plan leaves the pitch alone, so the
 * caller draws nothing on top of the detected line rather than a second line over the same
 * pixels. Samples either side of an edited span are never mixed with the zeros beyond it, which
 * would otherwise draw a line plunging towards MIDI zero at every span edge.
 */
export function planTargetMidi(plan: RenderPlan, seconds: number): number | null {
  const curve = plan.targetMidi;
  const last = curve.values.length - 1;
  if (last < 0 || !Number.isFinite(seconds) || !(curve.hop > 0)) {
    return null;
  }
  const position = (seconds - curve.start) / curve.hop;
  if (position < -0.5 || position > last + 0.5) {
    return null;
  }
  const index = Math.floor(position);
  const low = curve.values[Math.max(0, Math.min(last, index))] ?? 0;
  const high = curve.values[Math.max(0, Math.min(last, index + 1))] ?? 0;
  if (low > 0 && high > 0) {
    const fraction = position - index;
    return low + (high - low) * Math.min(1, Math.max(0, fraction));
  }
  const nearest = position - index < 0.5 ? low : high;
  return nearest > 0 ? nearest : null;
}

function drawTarget(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  if (state.track === null) {
    return;
  }
  const track = state.track;
  const plan = state.plan;
  ctx.save();
  ctx.strokeStyle = theme.pitchTarget;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  // Sampled on a grid anchored at time zero rather than at the left edge of the view, so a
  // following view slides the line past rather than resampling it into a different shape on
  // every frame.
  const step = viewport.secondsPerPixel;
  ctx.beginPath();
  for (const blob of state.blobs) {
    const start = Math.max(blobOutputStart(blob), viewport.view.visibleStart);
    const end = Math.min(blobOutputEnd(blob), viewport.view.visibleEnd);
    if (!(end > start)) {
      continue;
    }
    const from = Math.floor(start / step);
    const to = Math.ceil(end / step);
    let open = false;
    for (let column = from; column <= to; column += 1) {
      const outputTime = column * step;
      const sourceTime = outputToSource(blob, outputTime);
      const detected = detectedAt(track, sourceTime);
      if (detected === null) {
        open = false;
        continue;
      }
      const target =
        plan === null ? targetMidiAt(blob, sourceTime, detected) : planTargetMidi(plan, sourceTime);
      if (target === null) {
        open = false;
        continue;
      }
      const x = viewport.timeToX(outputTime);
      const y = viewport.midiToY(target);
      if (open) {
        ctx.lineTo(x, y);
      } else {
        ctx.moveTo(x, y);
        open = true;
      }
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawAnchors(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const selected = new Set(state.selection.anchors.map((entry) => `${entry.blob}:${entry.index}`));
  ctx.save();
  for (const blob of state.blobs) {
    for (let index = 0; index < blob.curve.anchors.length; index += 1) {
      const anchor = blob.curve.anchors[index];
      if (anchor === undefined) {
        continue;
      }
      const x = viewport.timeToX(
        blob.start + blob.timeOffset + (anchor.time - blob.start) * blob.timeScale,
      );
      if (x < -6 || x > viewport.width + 6) {
        continue;
      }
      const y = viewport.midiToY(anchor.midi);
      const active = selected.has(`${blob.id}:${index}`);
      ctx.fillStyle = active ? theme.handleActive : theme.pitchTarget;
      ctx.strokeStyle = theme.bg;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(x, y, active ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}
