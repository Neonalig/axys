// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { PitchTrackArrays } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { blobOutputEnd, blobOutputStart, outputToSource, targetMidiAt } from './blobs.js';

/** Height in pixels of the unvoiced strip along the bottom of the pitch area. */
const UNVOICED_STRIP = 7;

/** Confidence at or below which a frame is shaded as uncertain. */
const LOW_CONFIDENCE = 0.5;

/** Opacity bands the detected line is grouped into, weakest first. */
const ALPHA_BANDS = [0.25, 0.45, 0.7, 1] as const;

interface Columns {
  count: number;
  voiced: Uint8Array;
  low: Float32Array;
  high: Float32Array;
  confidence: Float32Array;
  unvoiced: Float32Array;
}

function collect(track: PitchTrackArrays, viewport: Viewport): Columns {
  const count = Math.max(1, Math.ceil(viewport.width));
  const columns: Columns = {
    count,
    voiced: new Uint8Array(count),
    low: new Float32Array(count),
    high: new Float32Array(count),
    confidence: new Float32Array(count),
    unvoiced: new Float32Array(count),
  };
  const weight = new Float32Array(count);
  for (let i = 0; i < track.times.length; i += 1) {
    const time = track.times[i] ?? 0;
    if (time < viewport.view.visibleStart) {
      continue;
    }
    if (time > viewport.view.visibleEnd) {
      break;
    }
    const column = Math.floor(viewport.timeToX(time));
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
  return columns;
}

/**
 * Draws detected pitch with its confidence, unvoiced material and the edited pitch target.
 *
 * @remarks Detected pitch is reduced to one column per pixel before drawing. Unvoiced frames
 * are drawn as a strip along the bottom rather than as a pitch, and uncertain frames are shaded
 * rather than dropped, so the display never invents a stable note the analysis did not find.
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
  const columns = collect(state.track, viewport);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();

  drawUnvoiced(ctx, columns, viewport, theme);
  drawUncertainty(ctx, columns, viewport, theme);
  drawDetected(ctx, columns, viewport, theme);
  drawTarget(ctx, state, viewport, theme);
  drawAnchors(ctx, state, viewport, theme);

  ctx.restore();
}

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
    ctx.fillRect(column, base - height, 1, height);
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
    ctx.fillRect(column, top, 1, Math.max(1, bottom - top));
  }
  ctx.restore();
}

function bandFor(confidence: number): number {
  const index = Math.floor(confidence * ALPHA_BANDS.length);
  return Math.min(ALPHA_BANDS.length - 1, Math.max(0, index));
}

function drawDetected(
  ctx: CanvasRenderingContext2D,
  columns: Columns,
  viewport: Viewport,
  theme: Theme,
): void {
  const paths = ALPHA_BANDS.map(() => new Path2D());
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
    const bottomY = viewport.midiToY(low);
    const path = paths[bandFor(columns.confidence[column] ?? 0)];
    if (path === undefined) {
      continue;
    }
    if (previousColumn === column - 1) {
      path.moveTo(previousColumn + 0.5, previousY);
      path.lineTo(column + 0.5, bottomY);
    }
    path.moveTo(column + 0.5, bottomY);
    path.lineTo(column + 0.5, Math.min(bottomY - 1, topY));
    previousColumn = column;
    previousY = topY;
  }

  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.strokeStyle = theme.pitchDetected;
  for (let band = 0; band < paths.length; band += 1) {
    const path = paths[band];
    if (path === undefined) {
      continue;
    }
    ctx.globalAlpha = ALPHA_BANDS[band] ?? 1;
    ctx.stroke(path);
  }
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
  ctx.save();
  ctx.strokeStyle = theme.pitchTarget;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (const blob of state.blobs) {
    const start = Math.max(blobOutputStart(blob), viewport.view.visibleStart);
    const end = Math.min(blobOutputEnd(blob), viewport.view.visibleEnd);
    if (!(end > start)) {
      continue;
    }
    const from = Math.floor(viewport.timeToX(start));
    const to = Math.ceil(viewport.timeToX(end));
    ctx.beginPath();
    let open = false;
    for (let column = from; column <= to; column += 1) {
      const sourceTime = outputToSource(blob, viewport.xToTime(column + 0.5));
      const detected = detectedAt(track, sourceTime);
      if (detected === null) {
        open = false;
        continue;
      }
      const y = viewport.midiToY(targetMidiAt(blob, sourceTime, detected));
      if (open) {
        ctx.lineTo(column + 0.5, y);
      } else {
        ctx.moveTo(column + 0.5, y);
        open = true;
      }
    }
    ctx.stroke();
  }
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
