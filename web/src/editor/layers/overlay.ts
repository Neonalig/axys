// SPDX-License-Identifier: AGPL-3.0-or-later

import { selectionSpan } from '../../app/selection.js';
import type { AppState } from '../../app/store.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER, RULER_HEIGHT } from '../view.js';
import { noteName, readoutNoteName } from '../../core/notes.js';
import { detectedAt } from './pitch.js';
import { stretchHandlesShown } from '../tools.js';
import { chipWidth, drawChip, READOUT_FONT } from './readout.js';
import { formatBarBeat, formatClock } from './ruler.js';
import { labelBaseline } from './label.js';

/** Width in pixels of the grips on the loop range edges. */
const LOOP_GRIP = 7;

/** Opacity of the hovered piano row across the plot. */
const HOVER_ROW_ALPHA = 0.07;

/** Opacity of the hovered key in the pitch-label gutter, where it reads as the keyboard. */
const HOVER_KEY_ALPHA = 0.3;

/** Opacity of the crosshair that reports where the pointer is. */
const HOVER_LINE_ALPHA = 0.45;

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
    ctx.lineWidth = viewport.crispWidth();
    ctx.beginPath();
    ctx.moveTo(viewport.crisp(x0), viewport.plotTop);
    ctx.lineTo(viewport.crisp(x0), viewport.height);
    ctx.moveTo(viewport.crisp(x1), viewport.plotTop);
    ctx.lineTo(viewport.crisp(x1), viewport.height);
    ctx.stroke();
  }
  // The edges that stretch the selection carry a grip, so they read as something to take hold of.
  const hull = stretchHandlesShown(state) ? selectionSpan(ranges) : null;
  if (hull !== null) {
    const middle = viewport.plotTop + viewport.plotHeight / 2;
    ctx.fillStyle = theme.handleActive;
    for (const time of [hull.start, hull.end]) {
      const x = viewport.timeToX(time);
      ctx.fillRect(
        Math.round(x - STRETCH_GRIP_WIDTH / 2),
        Math.round(middle - STRETCH_GRIP_HEIGHT / 2),
        STRETCH_GRIP_WIDTH,
        STRETCH_GRIP_HEIGHT,
      );
    }
  }
  ctx.restore();
}

/** Size in pixels of the grips on a stretchable selection's edges. */
const STRETCH_GRIP_WIDTH = 5;
const STRETCH_GRIP_HEIGHT = 24;

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
  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x0), 0);
  ctx.lineTo(viewport.crisp(x0), viewport.height);
  ctx.moveTo(viewport.crisp(x1), 0);
  ctx.lineTo(viewport.crisp(x1), viewport.height);
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
  // Over a ruler only that ruler's own axis is previewed: a horizontal line across the time
  // ruler, or a vertical one down the note gutter, would point at nothing that ruler measures.
  const overTime = point.y < viewport.plotTop;
  const overNotes = point.x < PITCH_LABEL_GUTTER && !overTime;
  const inPlot = !overTime;
  const showVertical = !overNotes;
  const showHorizontal = inPlot;
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
  ctx.lineWidth = viewport.crispWidth();
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  if (showVertical) {
    const x = viewport.crisp(point.x);
    ctx.moveTo(x, viewport.plotTop);
    ctx.lineTo(x, viewport.height);
  }
  if (showHorizontal) {
    const y = viewport.crisp(point.y);
    ctx.moveTo(PITCH_LABEL_GUTTER, y);
    ctx.lineTo(viewport.width, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  if (showVertical) {
    drawHoverRuler(ctx, state, viewport, theme, point.x);
  }
  if (showHorizontal) {
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

  const width = chipWidth(ctx, text);
  const left = Math.min(Math.max(0, x - width / 2), viewport.width - width);
  drawChip(ctx, theme, text, left, 1);
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
  ctx.font = READOUT_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.text;
  const row = viewport.midiToY(midi);
  ctx.fillText(text, 4, labelBaseline(ctx, row, row, viewport.ratio));
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
  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x), 0);
  ctx.lineTo(viewport.crisp(x), viewport.height);
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
  // Where the take is unvoiced the readout simply ends: naming the absence puts a word under
  // the cursor that changes on every frame the voice drops out.
  const detected = state.track === null ? null : detectedAt(state.track, position);
  const pitch =
    detected === null ? '' : readoutNoteName(detected, state.edits?.accidentals ?? 'sharps');
  const text = pitch === '' ? clock : `${clock}  ${pitch}`;

  const width = chipWidth(ctx, text);
  const left = Math.min(Math.max(4, x + 8), viewport.width - width - 4);
  drawChip(ctx, theme, text, left, viewport.plotTop + 6);
}
