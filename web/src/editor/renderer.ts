// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../app/store.js';
import type { Blob, BlobId } from '../core/types.js';
import type { Theme, ThemeName } from '../ui/theme.js';
import { currentTheme, resolveTheme } from '../ui/theme.js';
import {
  blobOutputEnd,
  blobOutputStart,
  blobPitchExtent,
  drawBlobs,
  sourceToOutput,
} from './layers/blobs.js';
import { drawGrid, drawPitchLabels } from './layers/grid.js';
import { drawMidi } from './layers/midi.js';
import { drawHoverGuides, drawOverlay } from './layers/overlay.js';
import { drawPitch } from './layers/pitch.js';
import { CHIP_HEIGHT, chipWidth, drawChip } from './layers/readout.js';
import { drawRuler } from './layers/ruler.js';
import { drawWaveform } from './layers/waveform.js';
import type { EditorPreview } from './tools.js';
import type { Viewport } from './view.js';
import { RULER_HEIGHT } from './view.js';

/** Where a hover readout is drawn and what it says. */
export interface HoverReadout {
  x: number;
  y: number;
  text: string;
}

const GHOST_ALPHA = 0.55;

/**
 * Composes the editor layers onto one canvas.
 *
 * @remarks Draws on animation frames only, and only when the state, viewport, preview, theme or
 * backing-store size has changed since the last frame. The canvas backing store follows
 * `devicePixelRatio`, so every layer draws in CSS pixels.
 */
export class EditorRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx: CanvasRenderingContext2D | null;
  #state: AppState | null = null;
  #viewport: Viewport | null = null;
  #preview: EditorPreview | null = null;
  #hover: HoverReadout | null = null;
  #themeName: ThemeName | null = null;
  #theme: Theme | null = null;
  #ratio = 0;
  #dirty = false;
  #frame = 0;
  #lastFrameMs = 0;
  #disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d', { alpha: false });
  }

  /** Milliseconds the most recent frame took to draw. */
  get lastFrameMs(): number {
    return this.#lastFrameMs;
  }

  /**
   * Takes the state and viewport to draw and schedules a frame if either changed.
   *
   * @remarks Cheap to call on every store notification; repeated calls within one frame draw
   * once.
   */
  render(state: AppState, viewport: Viewport): void {
    if (this.#state !== state || !sameViewport(this.#viewport, viewport)) {
      this.#state = state;
      this.#viewport = viewport;
      this.invalidate();
    }
  }

  /** Sets the gesture preview drawn over the committed state. */
  setPreview(preview: EditorPreview | null): void {
    if (this.#preview !== preview) {
      this.#preview = preview;
      this.invalidate();
    }
  }

  /** Sets the floating readout that follows the cursor. */
  setHover(hover: HoverReadout | null): void {
    const current = this.#hover;
    const same =
      (current === null && hover === null) ||
      (current !== null &&
        hover !== null &&
        current.text === hover.text &&
        Math.round(current.x) === Math.round(hover.x) &&
        Math.round(current.y) === Math.round(hover.y));
    if (!same) {
      this.#hover = hover;
      this.invalidate();
    }
  }

  /** Marks the canvas as needing a redraw on the next animation frame. */
  invalidate(): void {
    if (this.#disposed || this.#dirty) {
      return;
    }
    this.#dirty = true;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = 0;
      this.#dirty = false;
      this.#draw();
    });
  }

  /** Cancels any pending frame and releases the canvas. */
  dispose(): void {
    this.#disposed = true;
    if (this.#frame !== 0) {
      cancelAnimationFrame(this.#frame);
      this.#frame = 0;
    }
    this.#dirty = false;
    this.#state = null;
    this.#viewport = null;
    this.#preview = null;
    this.#hover = null;
  }

  #draw(): void {
    const ctx = this.#ctx;
    const state = this.#state;
    const viewport = this.#viewport;
    if (ctx === null || state === null || viewport === null) {
      return;
    }
    const started = performance.now();
    const theme = this.#resolveTheme();
    this.#resize(viewport);

    ctx.save();
    ctx.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, viewport.width, viewport.height);

    drawGrid(ctx, state, viewport, theme);
    drawWaveform(ctx, state, viewport, theme);
    drawMidi(ctx, state, viewport, theme);
    drawBlobs(ctx, state, viewport, theme);
    drawPitch(ctx, state, viewport, theme);
    drawPitchLabels(ctx, state, viewport, theme);
    drawRuler(ctx, state, viewport, theme);
    drawOverlay(ctx, state, viewport, theme);
    this.#drawHoverGuides(ctx, state, viewport, theme);
    this.#drawPreview(ctx, state, viewport, theme);
    this.#drawHover(ctx, viewport, theme);
    ctx.restore();

    this.#lastFrameMs = performance.now() - started;
  }

  #resolveTheme(): Theme {
    const name = currentTheme();
    const theme = this.#theme;
    if (theme === null || this.#themeName !== name) {
      const resolved = resolveTheme();
      this.#themeName = name;
      this.#theme = resolved;
      return resolved;
    }
    return theme;
  }

  #resize(viewport: Viewport): void {
    const ratio = Math.max(1, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(viewport.width * ratio));
    const height = Math.max(1, Math.round(viewport.height * ratio));
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    this.#ratio = ratio;
  }

  #drawPreview(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    viewport: Viewport,
    theme: Theme,
  ): void {
    const preview = this.#preview;
    if (preview === null) {
      return;
    }
    ctx.save();
    switch (preview.kind) {
      case 'spanSelect':
        drawSpanSelect(ctx, viewport, theme, preview.x0, preview.x1);
        break;
      case 'pitchDrag':
        for (const blob of blobsOf(state, preview.blobs)) {
          drawBlobGhost(ctx, state, viewport, theme, blob, 0, preview.semitones);
        }
        labelAt(ctx, viewport, theme, preview.label, ghostAnchor(state, viewport, preview.blobs));
        break;
      case 'timeDrag':
        for (const blob of blobsOf(state, preview.blobs)) {
          drawBlobGhost(ctx, state, viewport, theme, blob, preview.seconds, 0);
        }
        labelAt(ctx, viewport, theme, preview.label, ghostAnchor(state, viewport, preview.blobs));
        break;
      case 'edgeDrag':
        drawEdgePreview(ctx, state, viewport, theme, preview.blob, preview.edge, preview.time);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(edgeOutputTime(state, preview.blob, preview.time)),
          y: viewport.plotTop + 24,
        });
        break;
      case 'anchorDrag':
        drawAnchorPreview(ctx, state, viewport, theme, preview.blob, preview.time, preview.midi);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(outputTimeOf(state, preview.blob, preview.time)),
          y: viewport.midiToY(preview.midi) - 16,
        });
        break;
      case 'curve':
        drawCurvePreview(ctx, viewport, theme, preview.points);
        labelAt(ctx, viewport, theme, preview.label, curveAnchorPoint(viewport, preview.points));
        break;
      case 'span':
        drawSpanPreview(ctx, state, viewport, theme, preview.blob, preview.start, preview.end);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(spanOutputTime(state, preview.blob, preview.end)),
          y: viewport.plotTop + 24,
        });
        break;
      case 'split':
        drawSplitPreview(ctx, state, viewport, theme, preview.blob, preview.time);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(outputTimeOf(state, preview.blob, preview.time)),
          y: viewport.plotTop + 24,
        });
        break;
    }
    ctx.restore();
  }

  #drawHoverGuides(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    viewport: Viewport,
    theme: Theme,
  ): void {
    const hover = this.#hover;
    if (hover === null) {
      return;
    }
    drawHoverGuides(ctx, state, viewport, theme, hover);
  }

  #drawHover(ctx: CanvasRenderingContext2D, viewport: Viewport, theme: Theme): void {
    const hover = this.#hover;
    if (hover === null || hover.text === '') {
      return;
    }
    drawTooltip(ctx, viewport, theme, hover.text, hover.x + 14, hover.y + 16);
  }
}

function sameViewport(a: Viewport | null, b: Viewport): boolean {
  if (a === null) {
    return false;
  }
  return a.width === b.width && a.height === b.height && sameView(a, b);
}

function sameView(a: Viewport, b: Viewport): boolean {
  return (
    a.view.visibleStart === b.view.visibleStart &&
    a.view.visibleEnd === b.view.visibleEnd &&
    a.view.lowMidi === b.view.lowMidi &&
    a.view.highMidi === b.view.highMidi &&
    a.view.timeDisplay === b.view.timeDisplay &&
    a.view.snapDivision === b.view.snapDivision &&
    a.view.playhead === b.view.playhead &&
    a.view.loopStart === b.view.loopStart &&
    a.view.loopEnd === b.view.loopEnd
  );
}

function blobsOf(state: AppState, ids: readonly BlobId[]): Blob[] {
  const wanted = new Set(ids);
  return state.blobs.filter((blob) => wanted.has(blob.id));
}

function blobOf(state: AppState, id: BlobId): Blob | undefined {
  return state.blobs.find((blob) => blob.id === id);
}

function outputTimeOf(state: AppState, id: BlobId, sourceSeconds: number): number {
  const blob = blobOf(state, id);
  return blob === undefined ? sourceSeconds : sourceToOutput(blob, sourceSeconds);
}

function edgeOutputTime(state: AppState, id: BlobId, sourceSeconds: number): number {
  return outputTimeOf(state, id, sourceSeconds);
}

function spanOutputTime(state: AppState, id: BlobId | null, sourceSeconds: number): number {
  return id === null ? sourceSeconds : outputTimeOf(state, id, sourceSeconds);
}

function ghostAnchor(
  state: AppState,
  viewport: Viewport,
  ids: readonly BlobId[],
): { x: number; y: number } {
  const blobs = blobsOf(state, ids);
  const first = blobs[0];
  if (first === undefined) {
    return { x: viewport.width / 2, y: viewport.plotTop + 24 };
  }
  const extent = blobPitchExtent(first, state.track);
  return {
    x: viewport.timeToX(blobOutputStart(first)),
    y: viewport.midiToY(extent.high) - 18,
  };
}

function curveAnchorPoint(
  viewport: Viewport,
  points: readonly { time: number; midi: number }[],
): { x: number; y: number } {
  const last = points[points.length - 1];
  if (last === undefined) {
    return { x: viewport.width / 2, y: viewport.plotTop + 24 };
  }
  return { x: viewport.timeToX(last.time), y: viewport.midiToY(last.midi) - 16 };
}

/**
 * Draws a selection drag in progress.
 *
 * @remarks The same dotted full-height region the committed selection is drawn as, so the drag
 * shows what the release will produce rather than a rectangle that becomes something else.
 */
function drawSpanSelect(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  x0: number,
  x1: number,
): void {
  const left = Math.min(x0, x1);
  const width = Math.max(1, Math.abs(x1 - x0));
  ctx.fillStyle = theme.selectionFill;
  ctx.fillRect(left, viewport.plotTop, width, viewport.plotHeight);
  ctx.strokeStyle = theme.selection;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(Math.round(left) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(left) + 0.5, viewport.height);
  ctx.moveTo(Math.round(left + width) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(left + width) + 0.5, viewport.height);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawBlobGhost(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  blob: Blob,
  seconds: number,
  semitones: number,
): void {
  const extent = blobPitchExtent(blob, state.track);
  const x0 = viewport.timeToX(blobOutputStart(blob) + seconds);
  const x1 = viewport.timeToX(blobOutputEnd(blob) + seconds);
  const top = viewport.midiToY(extent.high + semitones);
  const bottom = viewport.midiToY(extent.low + semitones);
  ctx.save();
  ctx.globalAlpha = GHOST_ALPHA;
  ctx.fillStyle = theme.blobFillSelected;
  ctx.fillRect(x0, top, Math.max(2, x1 - x0), Math.max(2, bottom - top));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(
    Math.round(x0) + 0.5,
    Math.round(top) + 0.5,
    Math.round(Math.max(2, x1 - x0)),
    Math.round(Math.max(2, bottom - top)),
  );
  ctx.restore();
}

function drawEdgePreview(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  id: BlobId,
  edge: 'start' | 'end',
  sourceSeconds: number,
): void {
  const blob = blobOf(state, id);
  if (blob === undefined) {
    return;
  }
  const moved: Blob =
    edge === 'start' ? { ...blob, start: sourceSeconds } : { ...blob, end: sourceSeconds };
  const x0 = viewport.timeToX(blobOutputStart(moved));
  const x1 = viewport.timeToX(blobOutputEnd(moved));
  const extent = blobPitchExtent(blob, state.track);
  const top = viewport.midiToY(extent.high);
  const bottom = viewport.midiToY(extent.low);
  ctx.save();
  ctx.globalAlpha = GHOST_ALPHA;
  ctx.fillStyle = theme.blobFillSelected;
  ctx.fillRect(Math.min(x0, x1), top, Math.abs(x1 - x0), Math.max(2, bottom - top));
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = 2;
  const x = edge === 'start' ? x0 : x1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(x) + 0.5, viewport.height);
  ctx.stroke();
  ctx.restore();
}

function drawAnchorPreview(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  id: BlobId,
  sourceSeconds: number,
  midi: number,
): void {
  const x = viewport.timeToX(outputTimeOf(state, id, sourceSeconds));
  const y = viewport.midiToY(midi);
  ctx.save();
  ctx.fillStyle = theme.handleActive;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = theme.pitchTarget;
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, Math.round(y) + 0.5);
  ctx.lineTo(viewport.width, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

/** Draws a stroke in progress, in output seconds, wherever it has reached. */
function drawCurvePreview(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  points: readonly { time: number; midi: number }[],
): void {
  if (points.length === 0) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = theme.pitchTarget;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let started = false;
  for (const point of points) {
    const x = viewport.timeToX(point.time);
    const y = viewport.midiToY(point.midi);
    if (started) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
      started = true;
    }
  }
  ctx.stroke();
  const last = points[points.length - 1];
  if (last !== undefined) {
    ctx.fillStyle = theme.handleActive;
    ctx.beginPath();
    ctx.arc(viewport.timeToX(last.time), viewport.midiToY(last.midi), 4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSpanPreview(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  id: BlobId | null,
  start: number,
  end: number,
): void {
  const x0 = viewport.timeToX(spanOutputTime(state, id, Math.min(start, end)));
  const x1 = viewport.timeToX(spanOutputTime(state, id, Math.max(start, end)));
  ctx.save();
  ctx.fillStyle = theme.selectionFill;
  ctx.fillRect(x0, viewport.plotTop, Math.max(1, x1 - x0), viewport.plotHeight);
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x0) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(x0) + 0.5, viewport.height);
  ctx.moveTo(Math.round(x1) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(x1) + 0.5, viewport.height);
  ctx.stroke();
  ctx.restore();
}

function drawSplitPreview(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  id: BlobId,
  sourceSeconds: number,
): void {
  const x = viewport.timeToX(outputTimeOf(state, id, sourceSeconds));
  ctx.save();
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(Math.round(x) + 0.5, viewport.plotTop);
  ctx.lineTo(Math.round(x) + 0.5, viewport.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function labelAt(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  text: string,
  at: { x: number; y: number },
): void {
  if (text === '') {
    return;
  }
  drawTooltip(ctx, viewport, theme, text, at.x, at.y);
}

/**
 * Draws a floating readout.
 *
 * @remarks Sized in whole character columns by {@link drawChip}, because these follow the cursor
 * and the transport and would otherwise resize on every frame a digit changed.
 */
function drawTooltip(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  text: string,
  x: number,
  y: number,
): void {
  const width = chipWidth(ctx, text);
  const left = Math.min(Math.max(4, x), viewport.width - width - 4);
  const top = Math.min(Math.max(RULER_HEIGHT + 2, y), viewport.height - CHIP_HEIGHT - 4);
  drawChip(ctx, theme, text, left, top);
}
