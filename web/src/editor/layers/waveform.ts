// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import { clipOf } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import { sourceTheme } from '../../ui/theme.js';
import type { PeakEnvelope, PeakSpan } from '../peaks.js';
import { peaksFor } from '../peaks.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';
import { blobOutputEnd, blobOutputStart, blobPitchExtent } from './blobs.js';

/** Fraction of a blob's height the waveform may occupy at full scale. */
const FILL_FRACTION = 0.8;

/** Opacity that keeps the waveform readable as context without competing with pitch. */
const BAND_ALPHA = 0.5;

/** Shortest half-height in pixels a waveform is drawn at, so a thin blob still shows one. */
const MIN_HALF = 5;

/**
 * Draws the source peak envelope inside each blob.
 *
 * @remarks The waveform belongs to the blob that carries that audio, so it moves with the blob
 * when the blob is moved in pitch or time. Drawn free-floating it reads as a separate object
 * that happens to sit behind the blobs, and a pitch edit visibly pulls the two apart. Each
 * blob's envelope is sampled over its own source span, so a time-stretched blob shows the audio
 * it actually holds rather than whatever lies at those output seconds. Each blob reads the
 * envelope of the clip it belongs to, at that clip's own source seconds.
 */
export function drawWaveform(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  peaks: (clip: number) => { envelope: PeakEnvelope; position: number } | null = (clip) =>
    clipPeaks(state, clip),
): void {
  if (state.edits === null) {
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    PITCH_LABEL_GUTTER,
    viewport.plotTop,
    viewport.width - PITCH_LABEL_GUTTER,
    viewport.plotHeight,
  );
  ctx.clip();
  ctx.globalAlpha = BAND_ALPHA;

  for (const blob of state.blobs) {
    const x0 = viewport.timeToX(blobOutputStart(blob));
    const x1 = viewport.timeToX(blobOutputEnd(blob));
    if (x1 < PITCH_LABEL_GUTTER || x0 > viewport.width) {
      continue;
    }
    const source = peaks(clipOf(blob.id));
    if (source === null) {
      continue;
    }
    // In its clip's own colour, so the audio reads as that source's on any blob fill.
    ctx.fillStyle = sourceTheme(theme, clipOf(blob.id)).blobBounds;
    const columns = Math.max(1, Math.round(x1 - x0));
    const span = source.envelope.sample(
      blob.start - source.position,
      blob.end - source.position,
      columns,
    );
    const extent = blobPitchExtent(blob, state.track);
    const top = viewport.midiToY(extent.high);
    const bottom = viewport.midiToY(extent.low);
    const centre = (top + bottom) / 2;
    const half = Math.max(MIN_HALF, ((bottom - top) / 2) * FILL_FRACTION);
    // Drawn from a device pixel, so the columns do not smear across a moving sub-pixel offset.
    fillEnvelope(ctx, span, Math.round(x0 * viewport.ratio) / viewport.ratio, centre, half);
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Fills a sampled envelope as one shape, one pixel column per sample from `left`.
 *
 * @remarks `centre` is the zero line and `half` the full-scale half-height, in pixels. Every column
 * is at least a pixel tall, so silence still draws a line.
 */
export function fillEnvelope(
  ctx: CanvasRenderingContext2D,
  span: PeakSpan,
  left: number,
  centre: number,
  half: number,
): void {
  if (span.count === 0) {
    return;
  }
  ctx.beginPath();
  for (let column = 0; column < span.count; column += 1) {
    const top = centre - (span.max[column] ?? 0) * half;
    const x = left + column;
    if (column === 0) ctx.moveTo(x, top);
    else ctx.lineTo(x, top);
    ctx.lineTo(x + 1, top);
  }
  for (let column = span.count - 1; column >= 0; column -= 1) {
    const top = centre - (span.max[column] ?? 0) * half;
    const bottom = Math.max(top + 1, centre - (span.min[column] ?? 0) * half);
    const x = left + column;
    ctx.lineTo(x + 1, bottom);
    ctx.lineTo(x, bottom);
  }
  ctx.closePath();
  ctx.fill();
}

/** A clip's cached envelope and where the clip sits, or `null` when neither is known. */
export function clipPeaks(
  state: AppState,
  clip: number,
): { envelope: PeakEnvelope; position: number } | null {
  const entry = state.edits?.clips.find((candidate) => candidate.id === clip);
  if (entry === undefined) {
    return null;
  }
  const envelope = peaksFor(entry.source.fingerprint);
  return envelope === null ? null : { envelope, position: entry.position };
}
