// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER, RULER_HEIGHT } from '../view.js';
import { noteName, noteNameWithCents } from './grid.js';
import { detectedAt } from './pitch.js';
import { formatBarBeat, formatClock } from './ruler.js';

/** Width in pixels of the grips on the loop range edges. */
const LOOP_GRIP = 7;

/** Opacity of the hovered piano row across the plot. */
const HOVER_ROW_ALPHA = 0.07;

/** Opacity of the hovered key in the pitch-label gutter, where it reads as the keyboard. */
const HOVER_KEY_ALPHA = 0.3;

/** Opacity of the crosshair that reports where the pointer is. */
const HOVER_LINE_ALPHA = 0.45;

/** Height in pixels of a readout chip. */
const CHIP_HEIGHT = 18;

/**
 * Draws selection, loop range, playhead and the playhead readout.
 *
 * @remarks Painted last, over every other layer, so transport and selection stay legible
 * against dense pitch material.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  ctx.save();
  drawSelection(ctx, state, viewport, theme);
  drawLoop(ctx, state, viewport, theme);
  drawPlayhead(ctx, state, viewport, theme);
  ctx.restore();
}

function drawSelection(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const ranges = state.selection.ranges;
  if (ranges.length === 0) {
    return;
  }
  ctx.save();
  for (const range of ranges) {
    const x0 = viewport.timeToX(range.start);
    const x1 = viewport.timeToX(range.end);
    if (x1 < 0 || x0 > viewport.width) {
      continue;
    }
    ctx.fillStyle = theme.selectionFill;
    ctx.fillRect(x0, viewport.plotTop, Math.max(1, x1 - x0), viewport.plotHeight);
    ctx.strokeStyle = theme.selection;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(x0) + 0.5, viewport.plotTop);
    ctx.lineTo(Math.round(x0) + 0.5, viewport.height);
    ctx.moveTo(Math.round(x1) + 0.5, viewport.plotTop);
    ctx.lineTo(Math.round(x1) + 0.5, viewport.height);
    ctx.stroke();
  }
  ctx.restore();
}

function drawLoop(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const loop = state.transport.loop;
  if (loop === null) {
    return;
  }
  const x0 = viewport.timeToX(loop.start);
  const x1 = viewport.timeToX(loop.end);
  ctx.save();
  ctx.fillStyle = theme.loopRange;
  ctx.fillRect(x0, viewport.plotTop, Math.max(1, x1 - x0), viewport.plotHeight);
  ctx.fillStyle = theme.loopEdge;
  ctx.fillRect(x0 - LOOP_GRIP / 2, 0, LOOP_GRIP, RULER_HEIGHT);
  ctx.fillRect(x1 - LOOP_GRIP / 2, 0, LOOP_GRIP, RULER_HEIGHT);
  ctx.strokeStyle = theme.loopEdge;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, 0);
  ctx.lineTo(Math.round(x0) + 0.5, viewport.height);
  ctx.moveTo(Math.round(x1) + 0.5, 0);
  ctx.lineTo(Math.round(x1) + 0.5, viewport.height);
  ctx.stroke();
  ctx.restore();
}

/**
 * Draws where the pointer is: a crosshair, the piano key it is over and its place on the ruler.
 *
 * @remarks Every tool gets this, not only the ones that cut. A cursor alone does not say which
 * sample or which semitone is under it, which is the accuracy a split or a pitch move needs.
 * Drawn under the gesture preview, so a tool's own preview line stays the stronger mark.
 */
export function drawHoverGuides(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  point: { x: number; y: number },
): void {
  const inPlot = point.y >= viewport.plotTop;
  ctx.save();

  if (inPlot) {
    const rowHeight = viewport.plotHeight / viewport.pitchRange;
    const midi = Math.round(viewport.yToMidi(point.y));
    const top = viewport.midiToY(midi + 0.5);
    const height = Math.max(2, rowHeight);
    ctx.fillStyle = theme.accent;
    ctx.globalAlpha = HOVER_ROW_ALPHA;
    ctx.fillRect(0, top, viewport.width, height);
    ctx.globalAlpha = HOVER_KEY_ALPHA;
    ctx.fillRect(0, top, PITCH_LABEL_GUTTER, height);
    ctx.globalAlpha = 1;
  }

  ctx.strokeStyle = theme.textMuted;
  ctx.globalAlpha = HOVER_LINE_ALPHA;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  const x = Math.round(point.x) + 0.5;
  ctx.moveTo(x, viewport.plotTop);
  ctx.lineTo(x, viewport.height);
  if (inPlot) {
    const y = Math.round(point.y) + 0.5;
    ctx.moveTo(PITCH_LABEL_GUTTER, y);
    ctx.lineTo(viewport.width, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  drawHoverRuler(ctx, state, viewport, theme, point.x);
  if (inPlot) {
    drawHoverKeyLabel(ctx, state, viewport, theme, point.y);
  }
  ctx.restore();
}

/** The time the pointer is over, marked in the ruler band. */
function drawHoverRuler(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  x: number,
): void {
  const timeline = state.edits?.timeline ?? null;
  const seconds = viewport.xToTime(x);
  const text =
    state.view.timeDisplay === 'barsBeats' && timeline !== null
      ? formatBarBeat(timeline, seconds)
      : formatClock(seconds, 0.001);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  const width = ctx.measureText(text).width + 10;
  const left = Math.min(Math.max(0, x - width / 2), viewport.width - width);
  ctx.fillStyle = theme.surfaceRaised;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(left, 1, width, CHIP_HEIGHT);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.borderStrong;
  ctx.strokeRect(Math.round(left) + 0.5, 1.5, Math.round(width), CHIP_HEIGHT);
  ctx.fillStyle = theme.rulerText;
  ctx.fillText(text, left + width / 2, 1 + CHIP_HEIGHT / 2);
}

/** The note the pointer is over, named in the pitch-label gutter. */
function drawHoverKeyLabel(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  y: number,
): void {
  const midi = Math.round(viewport.yToMidi(y));
  const text = noteName(midi, state.edits?.accidentals ?? 'sharps');
  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.text;
  ctx.fillText(text, 4, viewport.midiToY(midi));
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const position = state.transport.playing ? state.transport.position : state.view.playhead;
  const x = viewport.timeToX(position);
  if (x < -8 || x > viewport.width + 8) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = theme.playhead;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, 0);
  ctx.lineTo(Math.round(x) + 0.5, viewport.height);
  ctx.stroke();

  ctx.fillStyle = theme.playhead;
  ctx.beginPath();
  ctx.moveTo(x, RULER_HEIGHT);
  ctx.lineTo(x - 6, RULER_HEIGHT - 8);
  ctx.lineTo(x + 6, RULER_HEIGHT - 8);
  ctx.closePath();
  ctx.fill();

  drawReadout(ctx, state, viewport, theme, position, x);
  ctx.restore();
}

function drawReadout(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  position: number,
  x: number,
): void {
  const timeline = state.edits?.timeline ?? null;
  const clock =
    state.view.timeDisplay === 'barsBeats' && timeline !== null
      ? formatBarBeat(timeline, position)
      : formatClock(position, 0.001);
  const detected = state.track === null ? null : detectedAt(state.track, position);
  const pitch =
    detected === null
      ? 'Unvoiced'
      : noteNameWithCents(detected, state.edits?.accidentals ?? 'sharps');
  const text = `${clock}  ${pitch}`;

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const width = ctx.measureText(text).width + 12;
  const left = Math.min(Math.max(4, x + 8), viewport.width - width - 4);
  const top = viewport.plotTop + 6;
  ctx.fillStyle = theme.surfaceRaised;
  ctx.globalAlpha = 0.92;
  ctx.fillRect(left, top, width, 18);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.border;
  ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(width), 18);
  ctx.fillStyle = theme.text;
  ctx.fillText(text, left + 6, top + 9);
}
