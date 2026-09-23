// SPDX-License-Identifier: AGPL-3.0-or-later

/** Opacity of a name drawn in the background colour over a filled tab. */
export const LABEL_ALPHA = 0.75;

/** Cap height in pixels per canvas font string. */
const capHeights = new Map<string, number>();

// A web font that finishes loading changes what every font string measures.
if (typeof document !== 'undefined' && 'fonts' in document) {
  document.fonts.addEventListener('loadingdone', () => {
    capHeights.clear();
  });
}

/**
 * The baseline that centres a line of text between `top` and `bottom`, on the device grid.
 *
 * @remarks Centred on the capital height of the context's current font, which is where a reader
 * sees the middle of a line; the `middle` baseline centres the em box and sits visibly high. Draw
 * with the `alphabetic` baseline. The capital height is measured once per font and again after
 * a web font loads.
 */
export function labelBaseline(
  ctx: CanvasRenderingContext2D,
  top: number,
  bottom: number,
  ratio: number,
): number {
  let cap = capHeights.get(ctx.font);
  if (cap === undefined) {
    cap = ctx.measureText('H').actualBoundingBoxAscent;
    capHeights.set(ctx.font, cap);
  }
  return Math.round(((top + bottom) / 2 + cap / 2) * ratio) / ratio;
}
