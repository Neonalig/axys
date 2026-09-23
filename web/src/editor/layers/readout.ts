// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The readout chips the canvas draws over itself.
 *
 * A readout that changes every frame is unreadable if its box changes with it, so these are drawn
 * in a monospaced face and sized in whole character columns. A figure gaining a digit widens the
 * box by one column rather than by however many pixels that glyph happened to need, and a figure
 * that only changes value does not move the box at all.
 */

import type { Theme } from '../../ui/theme.js';

/**
 * Face every readout is drawn in, so one character is one column.
 *
 * @remarks Canvas 2D takes no `font-variant-numeric`, so the readout is set in the mono face,
 * whose figures are one width already. The stack repeats `--axys-font-mono` because a canvas
 * context cannot read a custom property.
 */
export const READOUT_FONT =
  '12px "Atkinson Hyperlegible Mono", ui-monospace, "Cascadia Mono", consolas, monospace';

/** Height in pixels of a readout chip. */
export const CHIP_HEIGHT = 20;

/** Horizontal padding in pixels inside a chip. */
const CHIP_PAD = 6;

/**
 * Columns a chip is rounded up to.
 *
 * @remarks A chip stays one of a few widths rather than one width per reading, so a figure
 * counting up does not make the box breathe.
 */
const COLUMN_STEP = 4;

/** Width in pixels of one character column in {@link READOUT_FONT}. */
export function columnWidth(ctx: CanvasRenderingContext2D): number {
  const previous = ctx.font;
  ctx.font = READOUT_FONT;
  const width = ctx.measureText('0').width;
  ctx.font = previous;
  return width;
}

/** Width in pixels a chip holding this text is drawn at. */
export function chipWidth(ctx: CanvasRenderingContext2D, text: string): number {
  const columns = Math.ceil(text.length / COLUMN_STEP) * COLUMN_STEP;
  return columns * columnWidth(ctx) + CHIP_PAD * 2;
}

/** Draws one readout chip with its text, and returns the box it occupied. */
export function drawChip(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  text: string,
  left: number,
  top: number,
): { width: number; height: number } {
  const width = chipWidth(ctx, text);
  ctx.save();
  ctx.font = READOUT_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = theme.surfaceRaised;
  ctx.fillRect(left, top, width, CHIP_HEIGHT);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.border;
  ctx.strokeRect(Math.round(left) + 0.5, Math.round(top) + 0.5, Math.round(width), CHIP_HEIGHT);
  ctx.fillStyle = theme.text;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, left + CHIP_PAD, top + CHIP_HEIGHT / 2 + figureHalfHeight(ctx));
  ctx.restore();
  return { width, height: CHIP_HEIGHT };
}

/**
 * Half the ink height of a figure in {@link READOUT_FONT}, in pixels.
 *
 * @remarks A `middle` baseline centres the em box rather than the ink, which sets figures high in
 * a chip. Measured on a figure rather than the text, so the baseline does not move with the text.
 */
function figureHalfHeight(ctx: CanvasRenderingContext2D): number {
  const metrics = ctx.measureText('0');
  return (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
}
