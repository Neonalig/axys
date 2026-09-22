// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Theme } from '../../ui/theme.js';
import type { PeakEnvelope } from '../peaks.js';
import { peaksFor } from '../peaks.js';
import type { Viewport } from '../view.js';

/** Fraction of the pitch area the waveform may occupy at full scale. */
const BAND_FRACTION = 0.34;

/** Opacity that keeps the waveform readable as context without competing with pitch. */
const BAND_ALPHA = 0.55;

/**
 * Draws the source peak envelope as a band behind the pitch layers.
 *
 * @remarks Takes its envelope from the peak cache keyed by the source fingerprint, or from an
 * explicitly supplied one. One column is drawn per device pixel column, so cost tracks canvas
 * width rather than file length.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  peaks: PeakEnvelope | null = peaksFor(state.source?.fingerprint),
): void {
  if (peaks === null || state.source === null) {
    return;
  }
  const columns = Math.max(1, Math.floor(viewport.width));
  const span = peaks.sample(viewport.view.visibleStart, viewport.view.visibleEnd, columns);
  const centre = viewport.plotTop + viewport.plotHeight / 2;
  const half = (viewport.plotHeight * BAND_FRACTION) / 2;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();
  ctx.globalAlpha = BAND_ALPHA;
  ctx.fillStyle = theme.waveform;
  for (let column = 0; column < span.count; column += 1) {
    const low = span.min[column] ?? 0;
    const high = span.max[column] ?? 0;
    const top = centre - high * half;
    const bottom = centre - low * half;
    ctx.fillRect(column, top, 1, Math.max(1, bottom - top));
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.waveform;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(centre) + 0.5);
  ctx.lineTo(viewport.width, Math.round(centre) + 0.5);
  ctx.stroke();
  ctx.restore();
}
