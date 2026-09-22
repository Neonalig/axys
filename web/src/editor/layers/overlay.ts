// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { RULER_HEIGHT } from '../view.js';
import { noteNameWithCents } from './grid.js';
import { detectedAt } from './pitch.js';
import { formatBarBeat, formatClock } from './ruler.js';

/** Width in pixels of the grips on the loop range edges. */
const LOOP_GRIP = 7;

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
  const range = state.selection.range;
  if (range === null) {
    return;
  }
  const x0 = viewport.timeToX(range.start);
  const x1 = viewport.timeToX(range.end);
  ctx.save();
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
