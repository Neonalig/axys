// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Reference } from '../../core/types.js';
import { displayTitle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import { referenceColour } from '../../ui/theme.js';
import { peaksFor } from '../peaks.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';
import { CORNER_RADIUS } from './blobs.js';
import { LABEL_ALPHA, labelBaseline } from './label.js';
import { fillEnvelope } from './waveform.js';

/** Height in pixels of one reference's band along the foot of the plot. */
export const REFERENCE_BAND = 22;

/** Opacity of a reference band, which is context rather than something being edited. */
const BAND_ALPHA = 0.35;

const TITLE_FONT = '600 12px "Atkinson Hyperlegible Next", system-ui, sans-serif';

/** Key a reference's waveform envelope is cached under, apart from any clip of the same file. */
export function referencePeaksKey(fingerprint: string): string {
  return `${fingerprint}-reference`;
}

/**
 * Where a reference's band sits, in canvas pixels.
 *
 * @remarks Bands stack upwards from the foot of the plot in the order the references were
 * imported, and a band at `position` is drawn at that position rather than where the reference
 * is placed, so a band being dragged can be drawn with the same geometry.
 */
export function referenceRect(
  reference: Reference,
  index: number,
  viewport: Viewport,
  position = reference.position,
): { x: number; y: number; width: number; height: number } {
  const x0 = viewport.timeToX(position);
  const x1 = viewport.timeToX(position + reference.source.duration);
  const y = viewport.height - (index + 1) * REFERENCE_BAND;
  return { x: x0, y, width: Math.max(2, x1 - x0), height: REFERENCE_BAND - 2 };
}

/**
 * Draws every reference as a band along the foot of the plot, carrying its name and waveform.
 *
 * @remarks A reference is heard and never edited, so it keeps out of the pitch field: a band says
 * where it starts and ends, which is what lining a vocal up against it needs.
 */
export function drawReferences(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const references = state.edits?.references ?? [];
  if (references.length === 0) {
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(PITCH_LABEL_GUTTER, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();
  references.forEach((reference, index) => {
    drawReferenceBand(ctx, viewport, theme, reference, index, reference.position, 1);
  });
  ctx.restore();
}

/** Padding either side of a reference's name inside its tab, in pixels. */
const TITLE_PADDING = 6;

/**
 * Draws a reference's name on a tab filled in its colour, at the visible start of its band.
 *
 * @remarks The tab is cut to the band, so a narrow band shows as much of it as fits.
 */
function drawBandTitle(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  title: string,
  colour: string,
  band: { left: number; right: number; top: number; bottom: number; rounded: boolean },
): void {
  if (band.right - band.left < TITLE_PADDING * 2) return;
  ctx.font = TITLE_FONT;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const width = ctx.measureText(title).width + TITLE_PADDING * 2;
  const right = Math.min(band.right, band.left + width);
  ctx.save();
  // The band's own rounded start where it is in view; square where the view cuts it.
  const corner = band.rounded ? CORNER_RADIUS : 0;
  ctx.beginPath();
  ctx.roundRect(band.left, band.top, right - band.left, band.bottom - band.top, [
    corner,
    0,
    0,
    corner,
  ]);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colour;
  ctx.fillRect(band.left, band.top, right - band.left, band.bottom - band.top);
  ctx.globalAlpha = LABEL_ALPHA;
  ctx.fillStyle = theme.bg;
  // On the device grid, so the name does not blur and sharpen as the band slides.
  const x = Math.round((band.left + TITLE_PADDING) * viewport.ratio) / viewport.ratio;
  ctx.fillText(title, x, labelBaseline(ctx, band.top, band.bottom, viewport.ratio));
  ctx.restore();
}

/** Draws one reference's band at a position, at an opacity. */
export function drawReferenceBand(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  reference: Reference,
  index: number,
  position: number,
  alpha: number,
): void {
  const rect = referenceRect(reference, index, viewport, position);
  if (rect.x + rect.width < 0 || rect.x > viewport.width) {
    return;
  }
  const colour = referenceColour(reference.source.fingerprint);
  // Fill and outline share edges on the device grid. A fill at the band's fractional edges
  // covers the pixel beside the outline by a different amount each frame, which reads as the
  // outline shimmering while the band slides.
  const line = viewport.crispWidth();
  const x0 = viewport.crisp(rect.x);
  const y0 = viewport.crisp(rect.y);
  const x1 = viewport.crisp(rect.x + rect.width);
  const y1 = viewport.crisp(rect.y + rect.height);
  ctx.save();
  ctx.globalAlpha = BAND_ALPHA * alpha;
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.roundRect(x0 - line / 2, y0 - line / 2, x1 - x0 + line, y1 - y0 + line, CORNER_RADIUS);
  ctx.fill();

  const envelope = peaksFor(referencePeaksKey(reference.source.fingerprint));
  // Columns are cut a whole number of pixels from the band's own start, so a band sliding under a
  // following view keeps each column over the same audio. Cut from the view's edge instead, the
  // columns resampled on every frame once the start had scrolled away, and the waveform shimmered.
  const skipped = Math.max(0, Math.floor(-rect.x));
  const left = rect.x + skipped;
  const right = Math.min(rect.x + rect.width, viewport.width + 1);
  if (envelope !== null && right > left) {
    const columns = Math.max(1, Math.ceil(right - left));
    const from = viewport.xToTime(left) - position;
    const to = viewport.xToTime(left + columns) - position;
    const span = envelope.sample(from, to, columns);
    // The reference's own colour at full strength over its faint band, whatever that colour is.
    ctx.globalAlpha = alpha;
    ctx.fillStyle = colour;
    // Drawn from a device pixel, so the columns do not smear across a moving sub-pixel offset.
    const x = Math.round(left * viewport.ratio) / viewport.ratio;
    // Centred between the drawn edges of the band's outline.
    const inner = y0 + line / 2;
    const outer = y1 - line / 2;
    const middle = (inner + outer) / 2;
    fillEnvelope(ctx, span, x, middle, (outer - inner) / 2 - 1);
  }

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = line;
  ctx.beginPath();
  ctx.roundRect(x0, y0, x1 - x0, y1 - y0, CORNER_RADIUS);
  ctx.stroke();
  drawBandTitle(ctx, viewport, theme, displayTitle(reference), colour, {
    left: Math.max(x0 - line / 2, PITCH_LABEL_GUTTER),
    rounded: x0 - line / 2 >= PITCH_LABEL_GUTTER,
    right: x1 + line / 2,
    top: y0 - line / 2,
    bottom: y1 + line / 2,
  });
  ctx.restore();
}
