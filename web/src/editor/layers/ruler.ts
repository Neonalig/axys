// SPDX-License-Identifier: AGPL-3.0-or-later

import { playbackEnd } from '../../app/store.js';
import type { AppState } from '../../app/store.js';
import type { TimelineMap } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { barBeatAt, beatGrid, bpmAt, tickToSeconds } from '../../core/timeline.js';
import { PITCH_LABEL_GUTTER, RULER_HEIGHT } from '../view.js';

const SECOND_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
];

const MIN_LABEL_PIXELS = 82;
const MIN_BEAT_PIXELS = 14;

/** Coarsest time step whose labels still fit, in seconds. */
export function secondsStep(secondsPerPixel: number): number {
  const wanted = secondsPerPixel * MIN_LABEL_PIXELS;
  for (const step of SECOND_STEPS) {
    if (step >= wanted) {
      return step;
    }
  }
  return SECOND_STEPS[SECOND_STEPS.length - 1] ?? 600;
}

/** Clock reading of a time, with only as much precision as the step needs. */
export function formatClock(seconds: number, step = 0.001): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const padded = rest.toFixed(decimals).padStart(decimals > 0 ? decimals + 3 : 2, '0');
  return `${sign}${minutes}:${padded}`;
}

/** Bar and beat reading of a time, such as `12.3`. */
export function formatBarBeat(timeline: TimelineMap, seconds: number): string {
  const position = barBeatAt(timeline, seconds);
  return `${position.bar}.${Math.floor(position.beat)}`;
}

/**
 * Draws the timeline ruler, or the vertical gridlines it carries down through the plot.
 *
 * @remarks Reads bars and beats through the project tempo and meter maps, so a tempo or meter
 * change moves the lines rather than only the numbers. Falls back to clock time whenever the
 * project has no edit state to read a timeline from. `part` is `plot` for the gridlines, drawn
 * under everything in the plot, and `band` for the ruler itself, drawn over it.
 */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  part: 'plot' | 'band' = 'band',
): void {
  const timeline = state.edits?.timeline ?? null;
  const musical = state.view.timeDisplay === 'barsBeats' && timeline !== null;

  ctx.save();
  // One drawing for both parts, each clipped to its own area.
  ctx.beginPath();
  // The band keeps the rule along its foot, which sits a pixel into the plot.
  if (part === 'band') ctx.rect(0, 0, viewport.width, viewport.plotTop + 1);
  else ctx.rect(0, viewport.plotTop, viewport.width, viewport.height - viewport.plotTop);
  ctx.clip();
  ctx.font = '12px "Atkinson Hyperlegible Next", system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  if (musical && timeline !== null) {
    drawMusical(ctx, state, viewport, theme, timeline);
  } else {
    drawClock(ctx, viewport, theme);
  }
  const end = playbackEnd(state);
  if (end > 0) drawLandmark(ctx, viewport, theme, end);
  ctx.restore();
}

/**
 * Draws the line at time zero, where the take starts.
 *
 * @remarks Set apart the way an octave boundary is, in the same colour and at twice the weight,
 * because zero is the one position on the timeline that is a landmark rather than a measurement.
 * Drawn after the rest of the grid, so it is not written over by it.
 */
function drawOrigin(ctx: CanvasRenderingContext2D, viewport: Viewport, theme: Theme): void {
  drawLandmark(ctx, viewport, theme, 0);
}

/** Draws a timeline landmark at `seconds`: the start, or where playback stops. */
function drawLandmark(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  seconds: number,
): void {
  if (viewport.view.visibleStart > seconds || viewport.view.visibleEnd < seconds) {
    return;
  }
  const width = viewport.crispWidth(ORIGIN_WIDTH);
  const x = viewport.crisp(viewport.timeToX(seconds), width);
  ctx.save();
  ctx.lineWidth = width;
  ctx.strokeStyle = theme.gridLineOctave;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, viewport.height);
  ctx.stroke();
  ctx.restore();
}

/** Weight of the origin line in CSS pixels, against one for every other grid line. */
const ORIGIN_WIDTH = 2;

function fillBand(ctx: CanvasRenderingContext2D, viewport: Viewport, theme: Theme): void {
  ctx.fillStyle = theme.rulerBg;
  ctx.fillRect(0, 0, viewport.width, RULER_HEIGHT);
  ctx.strokeStyle = theme.border;
  ctx.beginPath();
  ctx.moveTo(0, viewport.crisp(RULER_HEIGHT));
  ctx.lineTo(viewport.width, viewport.crisp(RULER_HEIGHT));
  ctx.stroke();
}

function drawClock(ctx: CanvasRenderingContext2D, viewport: Viewport, theme: Theme): void {
  fillBand(ctx, viewport, theme);
  const step = secondsStep(viewport.secondsPerPixel);
  const minor = step / 5;
  const start = Math.floor(viewport.view.visibleStart / minor) * minor;
  const end = viewport.view.visibleEnd;

  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  for (let time = start; time <= end; time += minor) {
    if (Math.abs(time / step - Math.round(time / step)) < 1e-6) {
      continue;
    }
    const x = viewport.crisp(viewport.timeToX(time));
    ctx.moveTo(x, RULER_HEIGHT - 6);
    ctx.lineTo(x, RULER_HEIGHT);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = theme.borderStrong;
  for (let index = Math.floor(start / step); index * step <= end; index += 1) {
    const x = viewport.crisp(viewport.timeToX(index * step));
    ctx.moveTo(x, 6);
    ctx.lineTo(x, RULER_HEIGHT);
  }
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  for (let index = Math.floor(start / step); index * step <= end; index += 1) {
    const x = viewport.crisp(viewport.timeToX(index * step));
    ctx.moveTo(x, viewport.plotTop);
    ctx.lineTo(x, viewport.height);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = theme.rulerText;
  ctx.textAlign = 'left';
  for (let index = Math.floor(start / step); index * step <= end; index += 1) {
    const time = index * step;
    const x = viewport.timeToX(time);
    if (x < PITCH_LABEL_GUTTER - 20) {
      continue;
    }
    ctx.fillText(formatClock(time, step), x + 4, RULER_HEIGHT / 2 - 1);
  }

  drawOrigin(ctx, viewport, theme);
}

function drawMusical(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  timeline: TimelineMap,
): void {
  fillBand(ctx, viewport, theme);
  const start = viewport.view.visibleStart;
  const end = viewport.view.visibleEnd;
  const requested = Math.max(1, Math.floor(state.view.snapDivision));
  const points = beatGrid(timeline, start, end, requested);
  const beats = points.filter((point) => point.isBeat);
  const beatPixels =
    beats.length > 1
      ? (viewport.timeToX(beats[beats.length - 1]?.seconds ?? 0) -
          viewport.timeToX(beats[0]?.seconds ?? 0)) /
        (beats.length - 1)
      : viewport.width;
  const showSubdivisions = beatPixels / requested >= MIN_BEAT_PIXELS;
  const showBeats = beatPixels >= MIN_BEAT_PIXELS;

  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  for (const point of points) {
    if (point.isBarLine || (!showSubdivisions && !point.isBeat) || !showBeats) {
      continue;
    }
    const x = viewport.crisp(viewport.timeToX(point.seconds));
    ctx.moveTo(x, point.isBeat ? RULER_HEIGHT - 9 : RULER_HEIGHT - 5);
    ctx.lineTo(x, RULER_HEIGHT);
  }
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  for (const point of points) {
    if (point.isBarLine || !point.isBeat || !showBeats) {
      continue;
    }
    const x = viewport.crisp(viewport.timeToX(point.seconds));
    ctx.moveTo(x, viewport.plotTop);
    ctx.lineTo(x, viewport.height);
  }
  ctx.stroke();
  ctx.restore();

  const bars = points.filter((point) => point.isBarLine);
  const barPixels =
    bars.length > 1
      ? (viewport.timeToX(bars[bars.length - 1]?.seconds ?? 0) -
          viewport.timeToX(bars[0]?.seconds ?? 0)) /
        (bars.length - 1)
      : viewport.width;
  const labelEvery = Math.max(1, Math.ceil(MIN_LABEL_PIXELS / Math.max(1, barPixels)));

  ctx.beginPath();
  ctx.strokeStyle = theme.borderStrong;
  for (const point of bars) {
    const x = viewport.crisp(viewport.timeToX(point.seconds));
    ctx.moveTo(x, 6);
    ctx.lineTo(x, RULER_HEIGHT);
  }
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLineOctave;
  for (const point of bars) {
    const x = viewport.crisp(viewport.timeToX(point.seconds));
    ctx.moveTo(x, viewport.plotTop);
    ctx.lineTo(x, viewport.height);
  }
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = theme.rulerText;
  ctx.textAlign = 'left';
  for (const point of bars) {
    if (point.bar % labelEvery !== 0 && labelEvery > 1) {
      continue;
    }
    const x = viewport.timeToX(point.seconds);
    if (x < PITCH_LABEL_GUTTER - 20) {
      continue;
    }
    ctx.fillText(String(point.bar), x + 4, RULER_HEIGHT / 2 - 1);
  }

  drawOrigin(ctx, viewport, theme);
  drawMapMarkers(ctx, viewport, theme, timeline);
}

function drawMapMarkers(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  timeline: TimelineMap,
): void {
  ctx.textAlign = 'left';
  ctx.font = '12px "Atkinson Hyperlegible Next", system-ui, sans-serif';
  const seen = new Set<number>();
  for (const event of timeline.tempo) {
    const seconds = tickToSeconds(timeline, event.tick);
    if (seconds < viewport.view.visibleStart || seconds > viewport.view.visibleEnd) {
      continue;
    }
    seen.add(event.tick);
    const x = viewport.timeToX(seconds);
    ctx.fillStyle = theme.accent;
    ctx.fillRect(x, 1, 2, 5);
    ctx.fillText(`${Math.round(bpmAt(timeline, event.tick))}`, x + 5, 5);
  }
  for (const event of timeline.meter) {
    const seconds = tickToSeconds(timeline, event.tick);
    if (seconds < viewport.view.visibleStart || seconds > viewport.view.visibleEnd) {
      continue;
    }
    const x = viewport.timeToX(seconds);
    ctx.fillStyle = theme.warning;
    ctx.fillRect(x, 1, 2, 5);
    const offset = seen.has(event.tick) ? 30 : 5;
    ctx.fillText(`${event.numerator}/${event.denominator}`, x + offset, 5);
  }
}
