// SPDX-License-Identifier: AGPL-3.0-or-later

import { DEFAULT_MIXER, vocalMonitor } from '../../audio/mixer.js';
import type { AppState } from '../../app/store.js';
import type {
  Blob,
  BlobId,
  Clip,
  PitchCurve,
  PitchTrackArrays,
  TimingConflict,
} from '../../core/types.js';
import { clipOf, displayTitle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import { sourceTheme } from '../../ui/theme.js';
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

/** Narrowest blob, in pixels, that draws its voicing regions and centre line. */
const DETAIL_MIN_WIDTH = 8;

/** Height in pixels of the tab above a blob naming the clip it came from. */
export const TITLE_HEIGHT = 16;

/** Narrowest blob, in pixels, that carries a title tab. */
const TITLE_MIN_WIDTH = 28;

/** Padding in pixels either side of a title's text. */
const TITLE_PADDING = 4;

const TITLE_FONT = '600 12px "Atkinson Hyperlegible Next", system-ui, sans-serif';

/** The clip a blob belongs to, when that clip is on the lane. */
export function clipOfBlob(state: AppState, blob: Blob): Clip | undefined {
  const id = clipOf(blob.id);
  return state.edits?.clips.find((clip) => clip.id === id);
}

/**
 * The tab above a blob that names its clip, in canvas pixels, or `null` when the blob is too
 * narrow to carry one.
 *
 * @remarks It is also where the clip is picked up to be moved, so hit testing reads the same
 * rectangle the layer draws.
 */
export function titleRect(
  blob: Blob,
  track: PitchTrackArrays | null,
  viewport: Viewport,
): { x: number; y: number; width: number; height: number } | null {
  const x0 = viewport.timeToX(blobOutputStart(blob));
  const x1 = viewport.timeToX(blobOutputEnd(blob));
  const width = x1 - x0;
  if (width < TITLE_MIN_WIDTH) {
    return null;
  }
  const top = viewport.midiToY(blobPitchExtent(blob, track).high);
  return { x: x0, y: top - TITLE_HEIGHT, width, height: TITLE_HEIGHT };
}

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
  // A released segment follows the blob's own pitch rather than a drawn one.
  if (a.interp === 'release') {
    return null;
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
  return (drawn ?? detected) + blob.pitchOffset;
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
  if (track === null) {
    return measureExtent(blob, null);
  }
  let cache = EXTENTS.get(track);
  if (cache === undefined) {
    cache = new Map();
    EXTENTS.set(track, cache);
  }
  const key = `${String(blob.start)}:${String(blob.end)}:${String(blob.detectedCenter)}`;
  let extent = cache.get(key);
  if (extent === undefined) {
    extent = measureExtent(blob, track);
    cache.set(key, extent);
  }
  return extent;
}

/**
 * Each track's blob extents, keyed by the span and centre they were measured over.
 *
 * @remarks Every layer and every hit test reads a blob's extent, so it is measured once per track
 * rather than once per read. A new track, which every edit that moves pitch produces, starts
 * empty, and the old one is collected with its track.
 */
const EXTENTS = new WeakMap<PitchTrackArrays, Map<string, { low: number; high: number }>>();

function measureExtent(blob: Blob, track: PitchTrackArrays | null): { low: number; high: number } {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  if (track !== null) {
    for (let i = firstFrameAt(track, blob.start); i < track.times.length; i += 1) {
      const time = track.times[i] ?? 0;
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

/** Index of the first frame at or after `seconds`, by binary search over the frame times. */
function firstFrameAt(track: PitchTrackArrays, seconds: number): number {
  let low = 0;
  let high = track.times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((track.times[middle] ?? 0) < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
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
 * Draws blob bodies, centres, boundary handles and the gaps timing edits opened.
 *
 * @remarks Blobs are drawn at their edited positions, so a timing edit moves the body, and the
 * pitch layer moves the detected line with it.
 */
export function drawBlobs(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  marquee: TitleMarquee | null = null,
): boolean {
  let scrolling = false;
  const selected = new Set(state.selection.blobs);
  // What is being heard is drawn solid and what is not is drawn transient, so the picture and
  // the mixer never disagree. Hearing both puts both between the two. Each clip has its own
  // strips, so each is drawn by what is heard of it.
  const mixer = state.edits?.mixer ?? DEFAULT_MIXER;
  const monitors = new Map<number, ReturnType<typeof vocalMonitor>>();
  const monitorOf = (blob: Blob): ReturnType<typeof vocalMonitor> => {
    const clip = clipOf(blob.id);
    let monitor = monitors.get(clip);
    if (monitor === undefined) {
      monitor = vocalMonitor(mixer, clip);
      monitors.set(clip, monitor);
    }
    return monitor;
  };
  // Only the Time tool acts on a blob's edges, so the grips appear only while it is armed.
  const showHandles = state.tool === 'time';

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();

  for (const blob of state.blobs) {
    const monitor = monitorOf(blob);
    if (monitor === 'processed') {
      continue;
    }
    if (blob.end < viewport.view.visibleStart || blob.start > viewport.view.visibleEnd) {
      continue;
    }
    drawOriginalBlob(ctx, state, viewport, theme, blob, monitor === 'original' ? 1 : 0.55);
  }

  for (const blob of state.blobs) {
    const start = blobOutputStart(blob);
    const end = blobOutputEnd(blob);
    if (end < viewport.view.visibleStart || start > viewport.view.visibleEnd) {
      continue;
    }
    const monitor = monitorOf(blob);
    const alpha = monitor === 'processed' ? 1 : monitor === 'original' ? 0.28 : 0.55;
    const isSelected = selected.has(blob.id);
    // Each clip has colours of its own, so a blob always says which source it belongs to.
    const tint = sourceTheme(theme, clipOf(blob.id));
    drawBlob(ctx, state, viewport, tint, blob, isSelected, alpha, showHandles);
    const scrolled = marquee !== null && marquee.blob === blob.id ? marquee.elapsed : null;
    scrolling =
      drawTitle(ctx, state, viewport, tint, blob, isSelected, alpha, scrolled) || scrolling;
  }

  for (const conflict of state.conflicts) {
    drawConflict(ctx, viewport, theme, conflict);
  }
  ctx.restore();
  return scrolling;
}

/**
 * A blob whose title scrolls when it does not fit, and how long it has been scrolling.
 *
 * @remarks `elapsed` is milliseconds since the pointer arrived over the blob.
 */
export interface TitleMarquee {
  blob: BlobId;
  elapsed: number;
}

/** How fast a title too long for its tab scrolls, in pixels per second. */
const MARQUEE_SPEED = 30;

/** Fraction of each pass a scrolling title rests at either end. */
const MARQUEE_REST = 0.15;

/**
 * How far a title `overflow` pixels too long has scrolled after `elapsed` milliseconds.
 *
 * @remarks Back and forth, resting at each end, the way the mixer's names scroll.
 */
function marqueeOffset(overflow: number, elapsed: number): number {
  const pass = (1 + overflow / MARQUEE_SPEED) * 1000;
  const cycle = (elapsed % (pass * 2)) / pass;
  const phase = cycle < 1 ? cycle : 2 - cycle;
  const moved = Math.min(Math.max((phase - MARQUEE_REST) / (1 - MARQUEE_REST * 2), 0), 1);
  return -overflow * moved;
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

  // Detail narrower than a few pixels is not legible and costs a draw per blob when zoomed out.
  const detailed = x1 - x0 >= DETAIL_MIN_WIDTH;

  ctx.globalAlpha = alpha;
  const bound = viewport.crispWidth(isSelected ? 2 : 1);
  ctx.lineWidth = bound;
  ctx.strokeStyle = isSelected ? theme.selection : theme.blobBounds;
  if (blob.excluded) {
    ctx.setLineDash([...EXCLUDED_DASH]);
  }
  // Each edge on the device grid on its own, so neither jitters a pixel as the view slides.
  const left = viewport.crisp(x0, bound);
  const upper = viewport.crisp(top, bound);
  ctx.strokeRect(
    left,
    upper,
    viewport.crisp(x0 + width, bound) - left,
    viewport.crisp(top + height, bound) - upper,
  );
  ctx.setLineDash([]);

  const centreY = viewport.midiToY(blob.detectedCenter + blob.pitchOffset);
  if (detailed) {
    ctx.beginPath();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = theme.blobBounds;
    ctx.moveTo(x0, viewport.crisp(centreY));
    ctx.lineTo(x0 + width, viewport.crisp(centreY));
    ctx.stroke();
    ctx.setLineDash([]);
  }

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

/**
 * Draws the tab above a blob that names the clip it came from.
 *
 * @remarks The clip's file name without its extension, the way a desk heads a clip, cut to the
 * blob's width. A blob too narrow for a readable name carries no tab rather than a sliver.
 */
function drawTitle(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  blob: Blob,
  isSelected: boolean,
  alpha: number,
  scrolled: number | null,
): boolean {
  const rect = titleRect(blob, state.track, viewport);
  const clip = clipOfBlob(state, blob);
  if (rect === null || clip === undefined) {
    return false;
  }
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = isSelected ? theme.selection : theme.blobBounds;
  // Out to the outer edges of the blob's outline, which is drawn centred on the device grid.
  const bound = viewport.crispWidth(isSelected ? 2 : 1);
  const left = viewport.crisp(rect.x, bound) - bound / 2;
  const right = viewport.crisp(rect.x + Math.max(2, rect.width), bound) + bound / 2;
  ctx.fillRect(left, Math.round(rect.y), right - left, rect.height);
  ctx.font = TITLE_FONT;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = theme.bg;
  const title = displayTitle(clip);
  const room = rect.width - TITLE_PADDING * 2;
  const overflow = scrolled === null ? 0 : ctx.measureText(title).width - room;
  if (overflow > 0 && scrolled !== null) {
    ctx.beginPath();
    ctx.rect(rect.x + TITLE_PADDING, rect.y, room, rect.height);
    ctx.clip();
    const offset = marqueeOffset(overflow, scrolled);
    ctx.fillText(title, rect.x + TITLE_PADDING + offset, rect.y + rect.height / 2 + 0.5);
    ctx.restore();
    return true;
  }
  const text = fitText(ctx, title, room);
  if (text !== '') {
    ctx.fillText(text, rect.x + TITLE_PADDING, rect.y + rect.height / 2 + 0.5);
  }
  ctx.restore();
  return false;
}

/**
 * The longest prefix of `text` that fits `width`, ending in an ellipsis when it was cut.
 *
 * @remarks Assumes {@link TITLE_FONT}. Answers are kept by text and whole-pixel width, since every
 * blob of a clip asks the same question on every frame.
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  const key = `${String(Math.floor(width))}:${text}`;
  const known = FITTED.get(key);
  if (known !== undefined) {
    return known;
  }
  if (FITTED.size >= MAX_FITTED) {
    FITTED.clear();
  }
  const fitted = measureFit(ctx, text, Math.floor(width));
  FITTED.set(key, fitted);
  return fitted;
}

/** Titles already fitted, by whole-pixel width and text. */
const FITTED = new Map<string, string>();

/** Most fitted titles kept before the cache starts again. */
const MAX_FITTED = 2048;

function measureFit(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) {
    return text;
  }
  let low = 0;
  let high = text.length - 1;
  // The widest cut that fits, by bisection: a cut is never wider than a longer one.
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (ctx.measureText(`${text.slice(0, middle)}...`).width <= width) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? `${text.slice(0, low)}...` : '';
}

/** Height in pixels of the strip along the top of the plot that marks a gap. */
export const CONFLICT_STRIP = 4;

/**
 * Marks a gap a timing edit opened, as a strip along the top of the plot over its span.
 *
 * @remarks A strip rather than a band down the whole plot: a gap is worth knowing about, not
 * worth covering the pitch field for.
 */
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
  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = theme.conflict;
  ctx.fillRect(x0, viewport.plotTop, Math.max(2, x1 - x0), CONFLICT_STRIP);
  ctx.restore();
}
