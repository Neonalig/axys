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
  // Fill, outline and text all measured from the same whole-pixel box, so the text is centred
  // between the lines that are drawn rather than in a box half a pixel off them.
  const x = Math.round(left);
  const y = Math.round(top);
  const w = Math.round(width);
  ctx.save();
  ctx.font = READOUT_FONT;
  ctx.textAlign = 'left';
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = theme.surfaceRaised;
  ctx.fillRect(x, y, w + 1, CHIP_HEIGHT + 1);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.border;
  ctx.strokeRect(x + 0.5, y + 0.5, w, CHIP_HEIGHT);
  ctx.fillStyle = theme.text;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, x + CHIP_PAD, y + 1 + (CHIP_HEIGHT - 1) / 2 + figureHalfHeight(ctx));
  ctx.restore();
  return { width, height: CHIP_HEIGHT };
}

/** Key names a hint names, drawn as keys; single letters are left alone, since notes use them. */
const HINT_KEYS = /\b(Ctrl|Shift|Alt|Enter|Esc|Delete|Backspace|Space)\b/g;

/**
 * Draws a hint chip, `Move Clip  Ctrl Start`, with each key it names in a box of its own.
 *
 * @remarks The boxes sit around the key's own characters, so the chip keeps the width its text
 * gives it and a hint reads as the same chip a readout is.
 */
export function drawHintChip(
  ctx: CanvasRenderingContext2D,
  theme: Theme,
  text: string,
  left: number,
  top: number,
): { width: number; height: number } {
  const box = drawChip(ctx, theme, text, left, top);
  const column = columnWidth(ctx);
  ctx.save();
  ctx.strokeStyle = theme.borderStrong;
  ctx.lineWidth = 1;
  for (const match of text.matchAll(HINT_KEYS)) {
    const x = Math.round(left) + Math.round(CHIP_PAD + match.index * column - KEY_INSET) + 0.5;
    const width = Math.round(match[0].length * column + KEY_INSET * 2);
    // Inset evenly from the chip's inner edges, so the key sits on the same middle as the text.
    ctx.beginPath();
    ctx.roundRect(x, Math.round(top) + KEY_INSET + 0.5, width, CHIP_HEIGHT - KEY_INSET * 2, 3);
    ctx.stroke();
  }
  ctx.restore();
  return box;
}

/** Pixels a key's box reaches past its characters and in from the chip's edge. */
const KEY_INSET = 3;

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
