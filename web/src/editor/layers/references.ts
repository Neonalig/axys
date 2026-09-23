// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Reference } from '../../core/types.js';
import { displayTitle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import { peaksFor } from '../peaks.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';
import { fillEnvelope } from './waveform.js';

/** Height in pixels of one reference's band along the foot of the plot. */
export const REFERENCE_BAND = 22;

/** Opacity of a reference band, which is context rather than something being edited. */
const BAND_ALPHA = 0.35;

const TITLE_FONT = '12px "Atkinson Hyperlegible Next", system-ui, sans-serif';

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
  ctx.save();
  ctx.globalAlpha = BAND_ALPHA * alpha;
  ctx.fillStyle = theme.midiNote;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

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
    ctx.globalAlpha = alpha;
    ctx.fillStyle = theme.waveform;
    fillEnvelope(ctx, span, left, rect.y + rect.height / 2, rect.height / 2 - 1);
  }

  ctx.globalAlpha = alpha;
  ctx.strokeStyle = theme.midiNote;
  ctx.lineWidth = viewport.crispWidth();
  // Both edges on the device grid, so neither blurs and sharpens as the band slides.
  const x0 = viewport.crisp(rect.x);
  const y0 = viewport.crisp(rect.y);
  ctx.strokeRect(
    x0,
    y0,
    viewport.crisp(rect.x + rect.width) - x0,
    viewport.crisp(rect.y + rect.height) - y0,
  );
  ctx.font = TITLE_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.text;
  ctx.fillText(
    displayTitle(reference),
    Math.max(rect.x, PITCH_LABEL_GUTTER) + 4,
    rect.y + rect.height / 2,
  );
  ctx.restore();
}
