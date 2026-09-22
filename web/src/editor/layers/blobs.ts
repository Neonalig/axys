// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_MIXER, vocalMonitor } from '../../audio/mixer.js';
import type { AppState } from '../../app/store.js';
import type { Blob, PitchCurve, PitchTrackArrays, TimingConflict } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';

/** Half-height in semitones of the smallest blob body. */
const MIN_HALF_SEMITONES = 0.5;

/** Padding in semitones above and below a blob's pitch extent. */
const BODY_PADDING = 0.35;

/** Edge grip width in pixels. */
const HANDLE_WIDTH = 5;

/** Edge grip height in pixels. */
const HANDLE_HEIGHT = 18;

/**
 * Dash pattern an excluded blob's outline is drawn with.
 *
 * @remarks The outline is the whole of it. An excluded blob sounds like any other and carries
 * whatever was done to it by hand; only automatic correction passes it by. Dimming it as well
 * said it was muted or disabled, which is the one thing exclusion does not mean.
 */
const EXCLUDED_DASH: readonly number[] = [4, 3];

/** Where a blob starts once its timing edits are applied, in output seconds. */
export function blobOutputStart(blob: Blob): number {
  return blob.start + blob.timeOffset;
}

/** Where a blob ends once its timing edits are applied, in output seconds. */
export function blobOutputEnd(blob: Blob): number {
  return blob.start + blob.timeOffset + (blob.end - blob.start) * blob.timeScale;
}

/** Output time of a source time inside a blob. */
export function sourceToOutput(blob: Blob, seconds: number): number {
  return blob.start + blob.timeOffset + (seconds - blob.start) * blob.timeScale;
}

/** Source time of an output time inside a blob. */
export function outputToSource(blob: Blob, seconds: number): number {
  const scale = blob.timeScale === 0 ? 1 : blob.timeScale;
  return blob.start + (seconds - blob.start - blob.timeOffset) / scale;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Value of a drawn pitch curve at a source time.
 *
 * @remarks Returns null outside the anchored span, where the target follows the detected
 * contour instead of a drawn one.
 */
export function evaluateCurve(curve: PitchCurve, seconds: number): number | null {
  const anchors = curve.anchors;
  if (anchors.length === 0) {
    return null;
  }
  const first = anchors[0];
  const last = anchors[anchors.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  if (anchors.length === 1) {
    return Math.abs(seconds - first.time) < 1e-6 ? first.midi : null;
  }
  if (seconds < first.time || seconds > last.time) {
    return null;
  }
  let index = 0;
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const next = anchors[i + 1];
    if (next !== undefined && next.time >= seconds) {
      index = i;
      break;
    }
    index = i;
  }
  const a = anchors[index];
  const b = anchors[index + 1];
  if (a === undefined || b === undefined) {
    return last.midi;
  }
  const span = b.time - a.time;
  const t = span <= 0 ? 0 : (seconds - a.time) / span;
  switch (a.interp) {
    case 'hold':
      return a.midi;
    case 'smooth':
      return a.midi + (b.midi - a.midi) * smoothstep(t);
    case 'cubic': {
      const previous = anchors[index - 1] ?? a;
      const following = anchors[index + 2] ?? b;
      const t2 = t * t;
      const t3 = t2 * t;
      return (
        0.5 *
        (2 * a.midi +
          (-previous.midi + b.midi) * t +
          (2 * previous.midi - 5 * a.midi + 4 * b.midi - following.midi) * t2 +
          (-previous.midi + 3 * a.midi - 3 * b.midi + following.midi) * t3)
      );
    }
    default:
      return a.midi + (b.midi - a.midi) * t;
  }
}

/**
 * Target pitch of a blob at a source time.
 *
 * @remarks Composes the blob's pitch offset with its drawn anchors, in the order the core
 * compiles them.
 */
export function targetMidiAt(blob: Blob, seconds: number, detected: number): number {
  const drawn = evaluateCurve(blob.curve, seconds);
  return drawn ?? detected + blob.pitchOffset;
}

/**
 * Lowest and highest pitch inside a blob as sung, in fractional MIDI.
 *
 * @remarks Carries no pitch edit, so this is where the blob sat before it was moved.
 */
export function blobDetectedExtent(
  blob: Blob,
  track: PitchTrackArrays | null,
): { low: number; high: number } {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  if (track !== null) {
    for (let i = 0; i < track.times.length; i += 1) {
      const time = track.times[i] ?? 0;
      if (time < blob.start) {
        continue;
      }
      if (time > blob.end) {
        break;
      }
      const midi = track.midi[i] ?? Number.NaN;
      if (!Number.isFinite(midi)) {
        continue;
      }
      low = Math.min(low, midi);
      high = Math.max(high, midi);
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = blob.detectedCenter - MIN_HALF_SEMITONES;
    high = blob.detectedCenter + MIN_HALF_SEMITONES;
  }
  const centre = (low + high) / 2;
  const half = Math.max(MIN_HALF_SEMITONES, (high - low) / 2 + BODY_PADDING);
  return { low: centre - half, high: centre + half };
}

/** Lowest and highest pitch a blob is drawn at, with its pitch edit applied. */
export function blobPitchExtent(
  blob: Blob,
  track: PitchTrackArrays | null,
): { low: number; high: number } {
  const extent = blobDetectedExtent(blob, track);
  return { low: extent.low + blob.pitchOffset, high: extent.high + blob.pitchOffset };
}

/**
 * Draws blob bodies, centres, boundary handles and timing conflicts.
 *
 * @remarks Blobs are drawn at their edited positions, so a timing edit moves the body while the
 * detected pitch behind it stays where it was sung.
 */
export function drawBlobs(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const selected = new Set(state.selection.blobs);
  // What is being heard is drawn solid and what is not is drawn transient, so the picture and
  // the mixer never disagree. Hearing both puts both between the two.
  const monitor = vocalMonitor(state.edits?.mixer ?? DEFAULT_MIXER);
  const hearingOriginal = monitor === 'original';
  const editedAlpha = monitor === 'processed' ? 1 : hearingOriginal ? 0.28 : 0.55;
  const originalAlpha = hearingOriginal ? 1 : 0.55;
  // Only the Time tool acts on a blob's edges, so the grips appear only while it is armed.
  const showHandles = state.tool === 'time';

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();

  if (monitor !== 'processed') {
    for (const blob of state.blobs) {
      if (blob.end < viewport.view.visibleStart || blob.start > viewport.view.visibleEnd) {
        continue;
      }
      drawOriginalBlob(ctx, state, viewport, theme, blob, originalAlpha);
    }
  }

  for (const blob of state.blobs) {
    const start = blobOutputStart(blob);
    const end = blobOutputEnd(blob);
    if (end < viewport.view.visibleStart || start > viewport.view.visibleEnd) {
      continue;
    }
    drawBlob(ctx, state, viewport, theme, blob, selected.has(blob.id), editedAlpha, showHandles);
  }

  for (const conflict of state.conflicts) {
    drawConflict(ctx, viewport, theme, conflict);
  }
  ctx.restore();
}

/**
 * Draws where a blob sat before it was edited.
 *
 * @remarks Its own colour, and always at the detected pitch and the unedited span, so the
 * distance an edit moved a blob is legible while the original is the thing being heard.
 */
function drawOriginalBlob(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  blob: Blob,
  alpha: number,
): void {
  const x0 = viewport.timeToX(blob.start);
  const x1 = viewport.timeToX(blob.end);
  const extent = blobDetectedExtent(blob, state.track);
  const top = viewport.midiToY(extent.high);
  const bottom = viewport.midiToY(extent.low);
  const width = Math.max(2, x1 - x0);
  const height = Math.max(4, bottom - top);

  ctx.save();
  ctx.globalAlpha = alpha * 0.25;
  ctx.fillStyle = theme.blobOriginal;
  ctx.fillRect(x0, top, width, height);
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = theme.blobOriginal;
  ctx.lineWidth = viewport.crispWidth();
  ctx.strokeRect(viewport.crisp(x0), viewport.crisp(top), Math.round(width), Math.round(height));
  ctx.restore();
}

function drawBlob(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  blob: Blob,
  isSelected: boolean,
  alpha: number,
  showHandles: boolean,
): void {
  const x0 = viewport.timeToX(blobOutputStart(blob));
  const x1 = viewport.timeToX(blobOutputEnd(blob));
  const extent = blobPitchExtent(blob, state.track);
  const top = viewport.midiToY(extent.high);
  const bottom = viewport.midiToY(extent.low);
  const width = Math.max(2, x1 - x0);
  const height = Math.max(4, bottom - top);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = isSelected ? theme.blobFillSelected : theme.blobFill;
  ctx.fillRect(x0, top, width, height);

  for (const region of blob.subregions) {
    if (region.voicing === 'voiced') {
      continue;
    }
    const rx0 = viewport.timeToX(sourceToOutput(blob, region.start));
    const rx1 = viewport.timeToX(sourceToOutput(blob, region.end));
    ctx.globalAlpha = alpha * (region.voicing === 'silence' ? 0.18 : 0.3);
    ctx.fillStyle = theme.unvoiced;
    ctx.fillRect(rx0, top, Math.max(1, rx1 - rx0), height);
  }

  ctx.globalAlpha = alpha;
  const bound = viewport.crispWidth(isSelected ? 2 : 1);
  ctx.lineWidth = bound;
  ctx.strokeStyle = isSelected ? theme.selection : theme.blobBounds;
  if (blob.excluded) {
    ctx.setLineDash([...EXCLUDED_DASH]);
  }
  ctx.strokeRect(
    viewport.crisp(x0, bound),
    viewport.crisp(top, bound),
    Math.round(width),
    Math.round(height),
  );
  ctx.setLineDash([]);

  const centreY = viewport.midiToY(blob.detectedCenter + blob.pitchOffset);
  ctx.beginPath();
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = theme.blobBounds;
  ctx.moveTo(x0, viewport.crisp(centreY));
  ctx.lineTo(x0 + width, viewport.crisp(centreY));
  ctx.stroke();
  ctx.setLineDash([]);

  if (showHandles) {
    const handleY = top + height / 2 - HANDLE_HEIGHT / 2;
    ctx.fillStyle = isSelected ? theme.handleActive : theme.handle;
    ctx.fillRect(x0 - HANDLE_WIDTH / 2, handleY, HANDLE_WIDTH, Math.min(HANDLE_HEIGHT, height));
    ctx.fillRect(
      x0 + width - HANDLE_WIDTH / 2,
      handleY,
      HANDLE_WIDTH,
      Math.min(HANDLE_HEIGHT, height),
    );
  }

  if (isSelected) {
    ctx.beginPath();
    ctx.fillStyle = theme.handleActive;
    ctx.arc(x0 + width / 2, centreY, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawConflict(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  conflict: TimingConflict,
): void {
  const x0 = viewport.timeToX(conflict.start);
  const x1 = viewport.timeToX(conflict.end);
  if (x1 < 0 || x0 > viewport.width) {
    return;
  }
  const width = Math.max(2, x1 - x0);
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = theme.conflict;
  ctx.fillRect(x0, viewport.plotTop, width, viewport.plotHeight);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.conflict;
  ctx.lineWidth = viewport.crispWidth();
  if (conflict.kind === 'gap') {
    ctx.setLineDash([4, 4]);
  }
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x0), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x0), viewport.height);
  ctx.moveTo(viewport.crisp(x0 + width), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x0 + width), viewport.height);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = theme.conflict;
  ctx.beginPath();
  const tip = viewport.plotTop + 4;
  ctx.moveTo(x0 + width / 2, tip + 8);
  ctx.lineTo(x0 + width / 2 - 5, tip);
  ctx.lineTo(x0 + width / 2 + 5, tip);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
