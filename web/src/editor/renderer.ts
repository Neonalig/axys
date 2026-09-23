// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../app/store.js';
import type { Blob, BlobId, PitchTrackArrays } from '../core/types.js';
import type { Theme, ThemeName } from '../ui/theme.js';
import { currentTheme, resolveTheme } from '../ui/theme.js';
import { prefersReducedMotion } from '../ui/motion.js';
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
import { drawWaveform, fillEnvelope } from './layers/waveform.js';
import { drawReferenceBand, drawReferences, REFERENCE_BAND } from './layers/references.js';
import { othersOf } from '../app/sources.js';
import { clipEnd, clipOf, clipStart, clipWindow } from '../core/types.js';
import type { BezierCurve, BezierHandle, EditorPreview, PendingClip } from './tools.js';
import { peaksFor } from './peaks.js';
import type { PeakEnvelope } from './peaks.js';
import { RULER_HEIGHT, Viewport } from './view.js';

/** Where a hover readout is drawn and what it says. */
export interface HoverReadout {
  x: number;
  y: number;
  text: string;
}

const GHOST_ALPHA = 0.55;

/** Opacity of the clips outside the editor's layer, per way of showing them. */
const OTHERS_ALPHA = { show: 0.5, dim: 0.2 } as const;

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
  #pending: PendingClip | null = null;
  #hover: HoverReadout | null = null;
  #themeName: ThemeName | null = null;
  #theme: Theme | null = null;
  #ratio = 0;
  #dirty = false;
  #frame = 0;
  #lastFrameMs = 0;
  #disposed = false;
  #base: HTMLCanvasElement | null = null;
  /** Where the clips outside the layer are drawn before they are laid under it, faded. */
  #others: HTMLCanvasElement | null = null;
  #baseKey: BaseKey | null = null;
  /** The blob under the pointer, whose title scrolls when it does not fit, and since when. */
  #hoverBlob: { id: BlobId; since: number } | null = null;
  /** Whether the last frame scrolled a title, which needs the frames after it too. */
  #scrolling = false;
  /** The state split around the clip being dragged, kept while the drag lasts. */
  #split: DragSplit | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext('2d', { alpha: false });
    // Text drawn before a face arrived is set in the fallback, so the layers are drawn again.
    document.fonts?.addEventListener('loadingdone', this.#onFonts);
  }

  #onFonts = (): void => {
    this.#baseKey = null;
    this.invalidate();
  };

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

  /** Sets the clip being imported, drawn where it will land until its blobs arrive. */
  setPending(pending: PendingClip | null): void {
    if (this.#pending !== pending) {
      this.#pending = pending;
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

  /**
   * Sets the blob under the pointer, whose title scrolls when it is too long for its tab.
   *
   * @remarks Held still under reduced motion, where the title stays cut short.
   */
  setHoverBlob(id: BlobId | null): void {
    const wanted = id === null || prefersReducedMotion() ? null : id;
    if ((this.#hoverBlob?.id ?? null) === wanted) {
      return;
    }
    this.#hoverBlob = wanted === null ? null : { id: wanted, since: performance.now() };
    this.invalidate();
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
    document.fonts?.removeEventListener('loadingdone', this.#onFonts);
    this.#base = null;
    this.#baseKey = null;
    this.#state = null;
    this.#viewport = null;
    this.#preview = null;
    this.#pending = null;
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
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.#baseLayers(state, viewport, theme), 0, 0);
    ctx.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    drawOverlay(ctx, state, viewport, theme);
    this.#drawHoverGuides(ctx, state, viewport, theme);
    const pending = this.#pending;
    if (pending !== null) {
      drawPending(ctx, viewport, theme, pending);
    }
    this.#drawPreview(ctx, state, viewport, theme);
    this.#drawHover(ctx, viewport, theme);
    ctx.restore();

    this.#lastFrameMs = performance.now() - started;
  }

  /**
   * Everything under the overlay, drawn again only when something it shows has changed.
   *
   * @remarks The playhead, the hover readout and a gesture preview change on every frame they
   * are up, while the blobs, the pitch and the waveforms under them do not. Those are kept on a
   * canvas of their own and copied, so a playing or hovered editor costs one copy per frame
   * however much is on screen.
   */
  #baseLayers(state: AppState, viewport: Viewport, theme: Theme): HTMLCanvasElement {
    const base = (this.#base ??= document.createElement('canvas'));
    const hover = this.#hoverBlob;
    const marquee =
      hover === null ? null : { blob: hover.id, elapsed: performance.now() - hover.since };
    const preview = this.#preview;
    const dragged = preview?.kind === 'clipDrag' ? this.#splitFor(state, preview.clip) : null;
    const key = baseKey(state, viewport, theme, this.#ratio, [
      hover?.id ?? -1,
      this.#scrolling && marquee !== null ? marquee.elapsed : 0,
      dragged === null ? -1 : dragged.clip,
    ]);
    if (this.#baseKey !== null && sameBaseKey(this.#baseKey, key)) {
      return base;
    }
    this.#baseKey = key;
    if (base.width !== this.#canvas.width || base.height !== this.#canvas.height) {
      base.width = this.#canvas.width;
      base.height = this.#canvas.height;
    }
    const ctx = base.getContext('2d', { alpha: false });
    if (ctx === null) {
      return base;
    }
    ctx.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    // A clip being dragged is drawn by the preview where it will land, so it is left out here.
    state = dragged === null ? state : dragged.rest;
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    drawGrid(ctx, state, viewport, theme);
    this.#drawOthers(ctx, state, viewport, theme);
    drawWaveform(ctx, state, viewport, theme);
    drawMidi(ctx, state, viewport, theme);
    drawReferences(ctx, state, viewport, theme);
    this.#scrolling = drawBlobs(ctx, state, viewport, theme, marquee);
    if (this.#scrolling) {
      this.invalidate();
    }
    drawPitch(ctx, state, viewport, theme);
    drawPitchLabels(ctx, state, viewport, theme);
    drawRuler(ctx, state, viewport, theme);
    return base;
  }

  /**
   * Draws every clip outside the editor's layer behind it, faded as a whole.
   *
   * @remarks Each is drawn by the same layers as the active one, from its own blobs, track and
   * plan, on a canvas of its own. Fading the finished picture rather than each stroke keeps the
   * layers' own opacities where they overlap.
   */
  #drawOthers(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    viewport: Viewport,
    theme: Theme,
  ): void {
    const mode = othersOf(state.view);
    if (mode === 'hide' || state.others.length === 0) return;
    const canvas = (this.#others ??= document.createElement('canvas'));
    if (canvas.width !== this.#canvas.width || canvas.height !== this.#canvas.height) {
      canvas.width = this.#canvas.width;
      canvas.height = this.#canvas.height;
    }
    const layer = canvas.getContext('2d');
    if (layer === null) return;
    layer.setTransform(1, 0, 0, 1, 0, 0);
    layer.clearRect(0, 0, canvas.width, canvas.height);
    layer.setTransform(this.#ratio, 0, 0, this.#ratio, 0, 0);
    for (const other of state.others) {
      const behind: AppState = {
        ...state,
        tool: 'select',
        blobs: other.blobs,
        track: other.track,
        plan: other.plan,
        conflicts: [],
        selection: { blobs: [], anchors: [], ranges: [] },
      };
      drawWaveform(layer, behind, viewport, theme);
      drawBlobs(layer, behind, viewport, theme);
      drawPitch(layer, behind, viewport, theme);
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = OTHERS_ALPHA[mode];
    ctx.drawImage(canvas, 0, 0);
    ctx.restore();
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
        // The ants keep marching while the pointer is still, which needs a frame the gesture
        // itself does not ask for. Only while a band is on screen; nothing else here loops.
        this.invalidate();
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
      case 'blobShift':
        for (const blob of blobsOf(state, preview.blobs)) {
          const moved = {
            ...blob,
            start: blob.start + preview.seconds,
            end: blob.end + preview.seconds,
          };
          drawBlobGhost(ctx, state, viewport, theme, moved, 0, 0);
          drawCoveredPitch(ctx, state, viewport, theme, moved);
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
      case 'bezier':
        drawCurvePreview(ctx, viewport, theme, preview.points);
        drawBezierHandles(ctx, viewport, theme, preview.curve, preview.active);
        labelAt(ctx, viewport, theme, preview.label, curveAnchorPoint(viewport, preview.points));
        break;
      case 'clipDrag':
        this.#drawClipDrag(ctx, state, viewport, theme, preview.clip, preview.position);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(preview.position),
          y: viewport.plotTop + 24,
        });
        break;
      case 'referenceDrag': {
        const references = state.edits?.references ?? [];
        const index = references.findIndex((entry) => entry.id === preview.reference);
        const reference = references[index];
        if (reference !== undefined) {
          drawReferenceBand(ctx, viewport, theme, reference, index, preview.position, GHOST_ALPHA);
          labelAt(ctx, viewport, theme, preview.label, {
            x: viewport.timeToX(preview.position),
            y: viewport.height - (index + 2) * REFERENCE_BAND,
          });
        }
        break;
      }
      case 'drop':
        drawDropMarker(ctx, viewport, theme, preview.time);
        labelAt(ctx, viewport, theme, preview.label, {
          x: viewport.timeToX(preview.time) + 6,
          y: viewport.plotTop + 24,
        });
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

  /**
   * Draws a clip being dragged where it would land: its blobs, waveform and pitch, all of it.
   *
   * @remarks Drawn through a view shifted by the drag, so every layer draws the clip exactly as
   * it will look once it is let go, gaps and leading pitch included.
   */
  #drawClipDrag(
    ctx: CanvasRenderingContext2D,
    state: AppState,
    viewport: Viewport,
    theme: Theme,
    clip: number,
    position: number,
  ): void {
    const entry = state.edits?.clips.find((candidate) => candidate.id === clip);
    if (entry === undefined) {
      return;
    }
    const shift = position - entry.position;
    const middle = viewport.plotTop + viewport.plotHeight / 2;
    const window = clipWindow(entry);
    drawWaveBand(
      ctx,
      viewport,
      theme,
      position + window.start,
      window.end - window.start,
      null,
      middle,
    );
    const moving = this.#splitFor(state, clip).moving;
    const view = viewport.view;
    const shifted = new Viewport(
      viewport.width,
      viewport.height,
      { ...view, visibleStart: view.visibleStart - shift, visibleEnd: view.visibleEnd - shift },
      this.#ratio,
    );
    drawWaveform(ctx, moving, shifted, theme);
    drawBlobs(ctx, moving, shifted, theme);
    drawPitch(ctx, moving, shifted, theme);
  }

  /** The state split around a clip: everything else, and the clip on its own. */
  #splitFor(state: AppState, clip: number): DragSplit {
    const known = this.#split;
    if (known !== null && known.state === state && known.clip === clip) {
      return known;
    }
    const split = splitClip(state, clip);
    this.#split = split;
    return split;
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

/** What the layers under the overlay are drawn from, compared by identity. */
interface BaseKey {
  refs: readonly unknown[];
  numbers: readonly (number | string)[];
}

function baseKey(
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  ratio: number,
  extra: readonly number[],
): BaseKey {
  const view = viewport.view;
  return {
    refs: [
      theme,
      state.blobs,
      state.others,
      state.track,
      state.edits,
      state.plan,
      state.midi,
      state.conflicts,
      state.selection.blobs,
      state.selection.anchors,
    ],
    numbers: [
      state.tool,
      state.editMode,
      state.outsidePitch ? 1 : 0,
      viewport.width,
      viewport.height,
      ratio,
      view.visibleStart,
      view.visibleEnd,
      view.lowMidi,
      view.highMidi,
      view.timeDisplay,
      view.snapDivision,
      othersOf(view),
      ...extra,
    ],
  };
}

function sameBaseKey(a: BaseKey, b: BaseKey): boolean {
  return (
    a.refs.every((value, index) => value === b.refs[index]) &&
    a.numbers.every((value, index) => value === b.numbers[index])
  );
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
  ctx.lineWidth = viewport.crispWidth();
  ctx.setLineDash(MARCH_DASH);
  ctx.lineDashOffset = -marchOffset();
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(left), viewport.plotTop);
  ctx.lineTo(viewport.crisp(left), viewport.height);
  ctx.moveTo(viewport.crisp(left + width), viewport.plotTop);
  ctx.lineTo(viewport.crisp(left + width), viewport.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineDashOffset = 0;
}

/** Dash and gap of the marching band, in pixels. */
const MARCH_DASH: readonly number[] = [4, 3];

/**
 * How far the marching band's dashes have travelled, in pixels.
 *
 * @remarks One period of `--axys-march`, which the indeterminate progress bar already marches at,
 * so the two read as one idea. Driven from the clock rather than from a frame counter, so the
 * speed does not depend on how often the editor happens to redraw. Held still under reduced
 * motion, where the dashes say the same thing without moving.
 */
function marchOffset(): number {
  if (prefersReducedMotion()) {
    return 0;
  }
  const period = MARCH_DASH[0]! + MARCH_DASH[1]!;
  return ((performance.now() / MARCH_MS) * period) % period;
}

/** Milliseconds one dash takes to reach where the next one started. */
const MARCH_MS = 1100 / 8;

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
    viewport.crisp(x0),
    viewport.crisp(top),
    Math.round(Math.max(2, x1 - x0)),
    Math.round(Math.max(2, bottom - top)),
  );
  ctx.restore();
}

/**
 * Draws the detected pitch a blob slid along the audio would cover, where it will sit.
 *
 * @remarks The audio does not move, so the line is the audio's own under the blob's new span.
 */
function drawCoveredPitch(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
  blob: Blob,
): void {
  const track = state.track;
  if (track === null) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = theme.pitchDetected;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 2]);
  ctx.beginPath();
  let open = false;
  for (let i = 0; i < track.times.length; i += 1) {
    const time = track.times[i] ?? 0;
    if (time < blob.start) continue;
    if (time > blob.end) break;
    const midi = track.midi[i] ?? Number.NaN;
    if (!Number.isFinite(midi)) {
      open = false;
      continue;
    }
    const x = viewport.timeToX(blob.start + blob.timeOffset + (time - blob.start) * blob.timeScale);
    const y = viewport.midiToY(midi);
    if (open) ctx.lineTo(x, y);
    else ctx.moveTo(x, y);
    open = true;
  }
  ctx.stroke();
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
  const edgeWidth = viewport.crispWidth(2);
  ctx.lineWidth = edgeWidth;
  const x = edge === 'start' ? x0 : x1;
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x, edgeWidth), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x, edgeWidth), viewport.height);
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
  ctx.lineWidth = viewport.crispWidth();
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(0, viewport.crisp(y));
  ctx.lineTo(viewport.width, viewport.crisp(y));
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

/**
 * Draws a Bezier's control arms and its four handles.
 *
 * @remarks Ends are filled discs and controls hollow squares, the convention vector editors use to
 * tell a point the curve passes through from one that only pulls on it.
 */
function drawBezierHandles(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  curve: BezierCurve,
  active: BezierHandle | null,
): void {
  const at = (point: { time: number; midi: number }): { x: number; y: number } => ({
    x: viewport.timeToX(point.time),
    y: viewport.midiToY(point.midi),
  });
  const from = at(curve.from);
  const c1 = at(curve.c1);
  const c2 = at(curve.c2);
  const to = at(curve.to);
  ctx.save();
  ctx.strokeStyle = theme.handle;
  ctx.lineWidth = viewport.crispWidth();
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(c1.x, c1.y);
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(c2.x, c2.y);
  ctx.stroke();
  ctx.setLineDash([]);
  for (const [handle, point] of [
    ['from', from],
    ['to', to],
  ] as const) {
    ctx.fillStyle = handle === active ? theme.handleActive : theme.pitchTarget;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.lineWidth = 1.5;
  for (const [handle, point] of [
    ['c1', c1],
    ['c2', c2],
  ] as const) {
    ctx.fillStyle = theme.bg;
    ctx.strokeStyle = handle === active ? theme.handleActive : theme.pitchTarget;
    ctx.fillRect(point.x - 4, point.y - 4, 8, 8);
    ctx.strokeRect(point.x - 4, point.y - 4, 8, 8);
  }
  ctx.restore();
}

/** Fraction of the plot height the dragged clip's waveform band takes. */
const CLIP_BAND_FRACTION = 0.24;

/** A state split around one clip, for drawing that clip apart from the rest. */
interface DragSplit {
  state: AppState;
  clip: number;
  /** Everything but the clip. */
  rest: AppState;
  /** The clip alone, with nothing selected. */
  moving: AppState;
}

function splitClip(state: AppState, clip: number): DragSplit {
  const entry = state.edits?.clips.find((candidate) => candidate.id === clip);
  const start = entry === undefined ? 0 : clipStart(entry);
  const end = entry === undefined ? 0 : clipEnd(entry);
  const within = (time: number): boolean => time >= start && time <= end;
  const mine = (blob: Blob): boolean => clipOf(blob.id) === clip;
  return {
    state,
    clip,
    rest: {
      ...state,
      blobs: state.blobs.filter((blob) => !mine(blob)),
      track: state.track === null ? null : framesWhere(state.track, (time) => !within(time)),
    },
    moving: {
      ...state,
      blobs: state.blobs.filter(mine),
      track: state.track === null ? null : framesWhere(state.track, within),
      conflicts: [],
      selection: { blobs: [], anchors: [], ranges: [] },
    },
  };
}

/** The frames of a track whose time passes `keep`. */
function framesWhere(track: PitchTrackArrays, keep: (time: number) => boolean): PitchTrackArrays {
  const indices: number[] = [];
  for (let i = 0; i < track.times.length; i += 1) {
    if (keep(track.times[i] ?? 0)) indices.push(i);
  }
  return {
    times: Float32Array.from(indices, (i) => track.times[i] ?? 0),
    midi: Float32Array.from(indices, (i) => track.midi[i] ?? Number.NaN),
    confidence: Float32Array.from(indices, (i) => track.confidence[i] ?? 0),
    rms: Float32Array.from(indices, (i) => track.rms[i] ?? 0),
  };
}

/** Draws a clip being imported where it will land: its waveform band, titled. */
function drawPending(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  pending: PendingClip,
): void {
  const middle = viewport.plotTop + viewport.plotHeight / 2;
  drawWaveBand(
    ctx,
    viewport,
    theme,
    pending.position,
    pending.duration,
    peaksFor(pending.fingerprint),
    middle,
  );
  labelAt(ctx, viewport, theme, `Analysing ${pending.title}`, {
    x: viewport.timeToX(pending.position) + 6,
    y: viewport.plotTop + 24,
  });
}

/**
 * Draws a dashed band across a clip's span, carrying its waveform when the envelope is known.
 *
 * @remarks `position` and `duration` are project seconds, and the band is centred on `middle`
 * as far as the plot allows.
 */
function drawWaveBand(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  position: number,
  duration: number,
  envelope: PeakEnvelope | null,
  middle: number,
): void {
  const bandHeight = viewport.plotHeight * CLIP_BAND_FRACTION;
  const top = Math.min(
    Math.max(viewport.plotTop, middle - bandHeight / 2),
    viewport.height - bandHeight,
  );
  const x0 = viewport.timeToX(position);
  const x1 = viewport.timeToX(position + duration);

  ctx.save();
  ctx.globalAlpha = GHOST_ALPHA * 0.45;
  ctx.fillStyle = theme.blobFillSelected;
  ctx.fillRect(x0, top, Math.max(2, x1 - x0), bandHeight);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = viewport.crispWidth();
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(
    viewport.crisp(x0),
    viewport.crisp(top),
    Math.round(Math.max(2, x1 - x0)),
    Math.round(bandHeight),
  );
  ctx.setLineDash([]);

  const left = Math.max(x0, 0);
  const right = Math.min(x1, viewport.width);
  if (envelope !== null && right > left) {
    const columns = Math.max(1, Math.round(right - left));
    const from = viewport.xToTime(left) - position;
    const to = viewport.xToTime(right) - position;
    const span = envelope.sample(from, to, columns);
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = theme.waveform;
    fillEnvelope(ctx, span, left, top + bandHeight / 2, bandHeight / 2 - 2);
  }
  ctx.restore();
}

/** Draws where audio dragged in from outside would land. */
function drawDropMarker(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  time: number,
): void {
  const x = viewport.timeToX(time);
  ctx.save();
  ctx.strokeStyle = theme.handleActive;
  ctx.lineWidth = viewport.crispWidth(2);
  ctx.setLineDash([6, 4]);
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x, 2), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x, 2), viewport.height);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = theme.handleActive;
  ctx.beginPath();
  ctx.moveTo(x, RULER_HEIGHT);
  ctx.lineTo(x - 6, RULER_HEIGHT - 8);
  ctx.lineTo(x + 6, RULER_HEIGHT - 8);
  ctx.closePath();
  ctx.fill();
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
  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.moveTo(viewport.crisp(x0), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x0), viewport.height);
  ctx.moveTo(viewport.crisp(x1), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x1), viewport.height);
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
  ctx.moveTo(viewport.crisp(x), viewport.plotTop);
  ctx.lineTo(viewport.crisp(x), viewport.height);
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
