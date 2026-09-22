// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  emptySelection,
  selectionForRange,
  selectionForRanges,
  selectionSpan,
  withRange,
} from '../app/selection.js';
import type { TimeRange } from '../app/selection.js';
import type { AppState, AppStore, Selection, ToolId } from '../app/store.js';
import type { Blob, BlobId, Edge, EditOp, Interp, ViewState } from '../core/types.js';
import { MIN_BLOB_SECONDS } from '../core/types.js';
import {
  blobOutputEnd,
  blobOutputStart,
  blobPitchExtent,
  outputToSource,
  sourceToOutput,
} from './layers/blobs.js';
import { MARQUEE_CURSOR } from './cursors.js';
import { noteNameWithCents } from './layers/grid.js';
import { formatClock } from './layers/ruler.js';
import type { EditorRenderer } from './renderer.js';
import type {
  EditorPreview,
  GesturePoint,
  Hit,
  Modifiers,
  PitchSnap,
  SnapContext,
} from './tools.js';
import {
  ANCHOR_RADIUS,
  AUDITION_SECONDS,
  BODY_SLACK,
  CLICK_SLOP,
  cursorFor,
  describeHit,
  EDGE_GRIP,
  FINE_FACTOR,
  gestureAnchors,
  modifiersOf,
  simplifyGesture,
  snapMidi,
  SNAP_PIXELS,
  snapTime,
} from './tools.js';
import { displayRatio, fitView, isVisible, RULER_HEIGHT, snapViewTo, Viewport } from './view.js';

/** Everything the controller needs from the shell around it. */
export interface EditorControllerOptions {
  canvas: HTMLCanvasElement;
  store: AppStore;
  /** Commits one edit operation; the shell applies it to the session and refreshes the store. */
  apply(op: EditOp): void;
  /** Draws gesture previews. Attach one here or later with {@link EditorController.setRenderer}. */
  renderer?: EditorRenderer;
  /** Plays a region once, for an Alt-click snippet. */
  audition?(start: number, end: number): void;
  /** Moves the transport to a position, for ruler scrubbing. */
  seek?(seconds: number): void;
  /** Sets or clears the loop the transport plays, in output seconds. */
  setLoop?(range: { start: number; end: number } | null): void;
  /** Reports what a gesture did, for the live region. */
  announce?(message: string): void;
  /** Opens the menu for what was right-clicked, at a viewport position. */
  contextMenu?(hit: Hit, at: { x: number; y: number }): void;
}

type Point = { x: number; y: number };

type Gesture =
  | { kind: 'rubberBand'; additive: boolean; extend: boolean }
  | { kind: 'scrub' }
  | { kind: 'loop'; anchorTime: number }
  | { kind: 'rulerDrag'; anchorTime: number; drawing: boolean }
  | { kind: 'pitch'; blobs: BlobId[]; semitones: number }
  | { kind: 'anchor'; blob: BlobId; index: number; time: number; midi: number }
  | { kind: 'pen'; points: GesturePoint[] }
  | { kind: 'line'; from: GesturePoint; to: GesturePoint; curved: boolean }
  | { kind: 'time'; blobs: BlobId[]; seconds: number }
  | { kind: 'edge'; blob: BlobId; edge: Edge; sourceTime: number; scale: number | null }
  | { kind: 'audition'; start: number; end: number }
  | { kind: 'pan'; from: ViewState }
  | { kind: 'split'; blob: BlobId; time: number };

const WHEEL_ZOOM = 0.002;
const KEY_ZOOM = 1.3;

/**
 * Owns pointer, wheel and view keyboard handling for the editor canvas.
 *
 * @remarks Each gesture previews on the object being dragged and commits exactly one
 * {@link EditOp} through the supplied dispatch callback, so undo steps match gestures. Zoom and
 * pan change only the view state and never the meaning of an edit. The controller never touches
 * the session directly.
 */
export class EditorController {
  readonly #canvas: HTMLCanvasElement;
  readonly #store: AppStore;
  #renderer: EditorRenderer | null;
  readonly #options: EditorControllerOptions;
  readonly #unsubscribe: () => void;
  readonly #observer: ResizeObserver | null;
  #pointerId: number | null = null;
  #origin: Point = { x: 0, y: 0 };
  #current: Point = { x: 0, y: 0 };
  #moved = false;
  #gesture: Gesture | null = null;
  #hover: Hit | null = null;

  constructor(options: EditorControllerOptions) {
    this.#options = options;
    this.#canvas = options.canvas;
    this.#store = options.store;
    this.#renderer = options.renderer ?? null;

    this.#canvas.addEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.addEventListener('pointermove', this.#onPointerMove);
    this.#canvas.addEventListener('pointerup', this.#onPointerUp);
    this.#canvas.addEventListener('pointercancel', this.#onPointerCancel);
    this.#canvas.addEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.#canvas.addEventListener('keydown', this.#onKeyDown);
    this.#canvas.addEventListener('contextmenu', this.#onContextMenu);
    this.#canvas.addEventListener('dblclick', this.#onDoubleClick);

    this.#unsubscribe = this.#store.subscribe(() => {
      this.render();
    });
    this.#observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            this.render();
          });
    this.#observer?.observe(this.#canvas);
    this.render();
  }

  /** The viewport the canvas currently presents. */
  get viewport(): Viewport {
    const rect = this.#canvas.getBoundingClientRect();
    const width = rect.width > 0 ? rect.width : this.#canvas.clientWidth;
    const height = rect.height > 0 ? rect.height : this.#canvas.clientHeight;
    return new Viewport(width, height, this.#store.state.view, displayRatio());
  }

  /** Attaches the renderer that draws gesture previews. */
  setRenderer(renderer: EditorRenderer | null): void {
    this.#renderer = renderer;
    this.render();
  }

  /** Draws the current state, honouring the renderer's frame scheduling. */
  render(): void {
    this.#renderer?.render(this.#store.state, this.viewport);
  }

  /** Gives the canvas keyboard focus. */
  focus(): void {
    this.#canvas.focus();
  }

  /** What lies under a canvas position, in CSS pixels relative to the canvas. */
  hitTest(x: number, y: number): Hit {
    const state = this.#store.state;
    const viewport = this.viewport;
    const time = viewport.xToTime(x);
    const midi = viewport.yToMidi(y);
    const base: Hit = {
      kind: 'empty',
      blob: null,
      edge: null,
      anchor: null,
      conflict: null,
      time,
      sourceTime: time,
      midi,
    };

    if (y < RULER_HEIGHT) {
      const loop = state.transport.loop;
      if (loop !== null) {
        if (Math.abs(x - viewport.timeToX(loop.start)) <= EDGE_GRIP) {
          return { ...base, kind: 'loopEdge', edge: 'start' };
        }
        if (Math.abs(x - viewport.timeToX(loop.end)) <= EDGE_GRIP) {
          return { ...base, kind: 'loopEdge', edge: 'end' };
        }
      }
      return { ...base, kind: 'ruler' };
    }

    for (const blob of state.blobs) {
      for (let index = 0; index < blob.curve.anchors.length; index += 1) {
        const anchor = blob.curve.anchors[index];
        if (anchor === undefined) {
          continue;
        }
        const ax = viewport.timeToX(sourceToOutput(blob, anchor.time));
        const ay = viewport.midiToY(anchor.midi);
        if (Math.hypot(ax - x, ay - y) <= ANCHOR_RADIUS) {
          return {
            ...base,
            kind: 'anchor',
            blob: blob.id,
            anchor: index,
            sourceTime: anchor.time,
            midi: anchor.midi,
          };
        }
      }
    }

    for (const blob of state.blobs) {
      const x0 = viewport.timeToX(blobOutputStart(blob));
      const x1 = viewport.timeToX(blobOutputEnd(blob));
      if (x < x0 - EDGE_GRIP || x > x1 + EDGE_GRIP) {
        continue;
      }
      const extent = blobPitchExtent(blob, state.track);
      const top = viewport.midiToY(extent.high) - BODY_SLACK;
      const bottom = viewport.midiToY(extent.low) + BODY_SLACK;
      if (y < top || y > bottom) {
        continue;
      }
      const sourceTime = outputToSource(blob, time);
      if (Math.abs(x - x0) <= EDGE_GRIP) {
        return { ...base, kind: 'blobEdge', blob: blob.id, edge: 'start', sourceTime };
      }
      if (Math.abs(x - x1) <= EDGE_GRIP) {
        return { ...base, kind: 'blobEdge', blob: blob.id, edge: 'end', sourceTime };
      }
      return { ...base, kind: 'blob', blob: blob.id, sourceTime };
    }

    // Reported only where no blob covers the position, so the red band explains itself without
    // taking a hover away from the blobs whose timing produced it.
    for (const conflict of state.conflicts) {
      if (time >= conflict.start && time <= conflict.end) {
        return { ...base, kind: 'conflict', conflict };
      }
    }
    return base;
  }

  /** Switches the armed tool. */
  setTool(tool: ToolId): void {
    this.#cancelGesture();
    this.#store.update({ tool });
    this.#applyCursor(this.#hover);
  }

  /**
   * Replaces or extends the blob selection.
   *
   * @remarks Each blob contributes its own span, so an additive selection of blobs that are not
   * neighbours stays two regions rather than swallowing everything between them.
   */
  selectBlobs(ids: readonly BlobId[], additive = false): void {
    const wanted = new Set(ids);
    let ranges = additive ? [...this.#store.state.selection.ranges] : [];
    for (const blob of this.#store.state.blobs) {
      if (!wanted.has(blob.id)) {
        continue;
      }
      ranges = withRange(ranges, { start: blobOutputStart(blob), end: blobOutputEnd(blob) });
    }
    this.#setSelection(selectionForRanges(this.#store.state.blobs, ranges));
  }

  /** Selects every blob. */
  selectAll(): void {
    const blobs = this.#store.state.blobs;
    if (blobs.length === 0) {
      return;
    }
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const blob of blobs) {
      start = Math.min(start, blobOutputStart(blob));
      end = Math.max(end, blobOutputEnd(blob));
    }
    this.#setSelection(selectionForRange(blobs, { start, end }));
    this.#announce(`${String(blobs.length)} selected`);
  }

  /** Drops the current selection and every selected span. */
  clearSelection(): void {
    this.#cancelGesture();
    this.#setSelection(emptySelection());
  }

  /** Moves the selection in pitch by a relative amount. */
  nudgePitch(semitones: number): void {
    const selection = this.#store.state.selection;
    const anchor = selection.anchors[0];
    if (selection.blobs.length === 0 && anchor !== undefined) {
      const blob = this.#blob(anchor.blob);
      const point = blob?.curve.anchors[anchor.index];
      if (blob === undefined || point === undefined) {
        return;
      }
      this.#commit(
        {
          type: 'moveAnchor',
          blob: blob.id,
          index: anchor.index,
          time: point.time,
          midi: point.midi + semitones,
        },
        `Anchor ${noteNameWithCents(point.midi + semitones, this.#accidentals())}`,
      );
      return;
    }
    if (selection.blobs.length === 0 || semitones === 0) {
      return;
    }
    this.#commit(
      { type: 'movePitch', blobs: [...selection.blobs], semitones },
      `Move Pitch ${formatSemitones(semitones)}`,
    );
  }

  /** Moves the selection in time by a relative amount. */
  nudgeTime(seconds: number): void {
    const selection = this.#store.state.selection;
    if (selection.blobs.length === 0 || seconds === 0) {
      return;
    }
    this.#commit(
      { type: 'moveTime', blobs: [...selection.blobs], seconds },
      `Move Time ${formatMilliseconds(seconds)}`,
    );
  }

  /**
   * Sets the selection's target pitch from a numeric entry.
   *
   * @remarks Addresses the selected anchor when one is selected, otherwise moves every selected
   * blob so the first lands on the given note.
   */
  setSelectionPitch(midi: number): void {
    if (!Number.isFinite(midi)) {
      return;
    }
    const selection = this.#store.state.selection;
    const anchor = selection.anchors[0];
    if (selection.blobs.length === 0 && anchor !== undefined) {
      const point = this.#blob(anchor.blob)?.curve.anchors[anchor.index];
      if (point === undefined) {
        return;
      }
      this.#commit(
        { type: 'moveAnchor', blob: anchor.blob, index: anchor.index, time: point.time, midi },
        `Anchor ${noteNameWithCents(midi, this.#accidentals())}`,
      );
      return;
    }
    const first = this.#blob(selection.blobs[0] ?? -1);
    if (first === undefined) {
      return;
    }
    if (selection.blobs.length === 1) {
      const semitones = midi - first.detectedCenter;
      this.#commit(
        { type: 'setPitchOffset', blob: first.id, semitones },
        `Move Pitch ${noteNameWithCents(midi, this.#accidentals())}`,
      );
      return;
    }
    const delta = midi - (first.detectedCenter + first.pitchOffset);
    if (delta === 0) {
      return;
    }
    this.#commit(
      { type: 'movePitch', blobs: [...selection.blobs], semitones: delta },
      `Move Pitch ${formatSemitones(delta)}`,
    );
  }

  /** Places the selection so its first blob starts at a given output time. */
  setSelectionTime(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      return;
    }
    const selection = this.#store.state.selection;
    const first = this.#blob(selection.blobs[0] ?? -1);
    if (first === undefined) {
      return;
    }
    const delta = seconds - blobOutputStart(first);
    if (delta === 0) {
      return;
    }
    this.#commit(
      { type: 'moveTime', blobs: [...selection.blobs], seconds: delta },
      `Move Time ${formatClock(seconds, 0.001)}`,
    );
  }

  /** Sets a selected blob's duration multiplier from a numeric entry. */
  setSelectionTimeScale(scale: number): void {
    const first = this.#blob(this.#store.state.selection.blobs[0] ?? -1);
    if (first === undefined || !Number.isFinite(scale) || scale <= 0) {
      return;
    }
    this.#commit(
      { type: 'setTimeScale', blob: first.id, scale },
      `Stretch ${Math.round(scale * 100)}%`,
    );
  }

  /** Splits the blob under an output time. */
  splitAt(seconds: number): void {
    const blob = this.#blobAtOutput(seconds);
    if (blob === undefined) {
      return;
    }
    const source = clamp(
      outputToSource(blob, seconds),
      blob.start + MIN_BLOB_SECONDS,
      blob.end - MIN_BLOB_SECONDS,
    );
    if (!(source > blob.start) || !(source < blob.end)) {
      return;
    }
    this.#commit(
      { type: 'splitBlob', blob: blob.id, time: source },
      `Split Blob ${formatClock(seconds, 0.001)}`,
    );
  }

  /** Splits the blob under the playhead. */
  splitAtPlayhead(): void {
    this.splitAt(this.#playhead());
  }

  /** Zooms the time axis about a screen position, defaulting to the canvas centre. */
  zoomTime(factor: number, anchorX?: number): void {
    const viewport = this.viewport;
    this.#store.update({ view: viewport.zoomTime(factor, anchorX ?? viewport.width / 2) });
  }

  /** Zooms the pitch axis about a screen position, defaulting to the plot centre. */
  zoomPitch(factor: number, anchorY?: number): void {
    const viewport = this.viewport;
    this.#store.update({
      view: viewport.zoomPitch(factor, anchorY ?? viewport.plotTop + viewport.plotHeight / 2),
    });
  }

  /** Scrolls the view by a pixel delta, which hands control of the view back to the user. */
  panBy(dx: number, dy: number): void {
    const viewport = this.viewport;
    this.#store.update({ view: viewport.pan(dx, dy), follow: false });
  }

  /** Frames the whole project, or the selection when there is one. */
  zoomFit(): void {
    const state = this.#store.state;
    const selected = new Set(state.selection.blobs);
    const blobs = selected.size > 0 ? state.blobs.filter((b) => selected.has(b.id)) : state.blobs;
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;
    for (const blob of blobs) {
      start = Math.min(start, blobOutputStart(blob));
      end = Math.max(end, blobOutputEnd(blob));
      const extent = blobPitchExtent(blob, state.track);
      low = Math.min(low, extent.low);
      high = Math.max(high, extent.high);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      start = 0;
      end = state.source?.duration ?? 10;
    }
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      low = 48;
      high = 72;
    }
    this.#store.update({ view: fitView(state.view, start, end, low, high) });
  }

  /** Detaches every listener and stops drawing. */
  dispose(): void {
    this.#cancelGesture();
    this.#canvas.removeEventListener('pointerdown', this.#onPointerDown);
    this.#canvas.removeEventListener('pointermove', this.#onPointerMove);
    this.#canvas.removeEventListener('pointerup', this.#onPointerUp);
    this.#canvas.removeEventListener('pointercancel', this.#onPointerCancel);
    this.#canvas.removeEventListener('pointerleave', this.#onPointerLeave);
    this.#canvas.removeEventListener('wheel', this.#onWheel);
    this.#canvas.removeEventListener('keydown', this.#onKeyDown);
    this.#canvas.removeEventListener('contextmenu', this.#onContextMenu);
    this.#canvas.removeEventListener('dblclick', this.#onDoubleClick);
    this.#observer?.disconnect();
    this.#unsubscribe();
  }

  #onPointerDown = (event: PointerEvent): void => {
    const state = this.#store.state;
    if (state.phase !== 'ready') {
      return;
    }
    // The middle button pans whatever tool is armed, which is the gesture people arrive with
    // from every other editor and costs no toolbar room.
    if (event.button === 1) {
      capturePointer(this.#canvas, event.pointerId);
      this.#pointerId = event.pointerId;
      this.#origin = this.#pointOf(event);
      this.#current = this.#origin;
      this.#moved = false;
      this.#gesture = { kind: 'pan', from: state.view };
      this.#canvas.style.cursor = 'grabbing';
      event.preventDefault();
      return;
    }
    if (event.button !== 0) {
      return;
    }
    const point = this.#pointOf(event);
    const hit = this.hitTest(point.x, point.y);
    const modifiers = modifiersOf(event);
    this.#canvas.focus();
    capturePointer(this.#canvas, event.pointerId);
    this.#pointerId = event.pointerId;
    this.#origin = point;
    this.#current = point;
    this.#moved = false;
    this.#gesture = this.#beginGesture(state, hit, modifiers);
    // A band being dragged is not the select tool resting over a blob, so it says so for as long
    // as it lasts rather than leaving the arrow up while a marquee is being drawn.
    if (this.#gesture?.kind === 'rubberBand') {
      this.#canvas.style.cursor = MARQUEE_CURSOR;
    }
    this.#updatePreview();
    event.preventDefault();
  };

  #onPointerMove = (event: PointerEvent): void => {
    const point = this.#pointOf(event);
    const modifiers = modifiersOf(event);
    if (this.#pointerId === null || this.#gesture === null) {
      const hit = this.hitTest(point.x, point.y);
      this.#hover = hit;
      this.#applyCursor(hit);
      this.#renderer?.setHover({
        x: point.x,
        y: point.y,
        text: describeHit(hit, this.#store.state),
      });
      return;
    }
    this.#current = point;
    if (Math.hypot(point.x - this.#origin.x, point.y - this.#origin.y) > CLICK_SLOP) {
      this.#moved = true;
    }
    this.#advanceGesture(modifiers);
    this.#updatePreview();
    event.preventDefault();
  };

  #onPointerUp = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) {
      return;
    }
    const modifiers = modifiersOf(event);
    this.#current = this.#pointOf(event);
    this.#advanceGesture(modifiers);
    this.#finishGesture();
    this.#releasePointer(event.pointerId);
    event.preventDefault();
  };

  #onPointerCancel = (event: PointerEvent): void => {
    if (this.#pointerId !== event.pointerId) {
      return;
    }
    this.#cancelGesture();
    this.#releasePointer(event.pointerId);
  };

  #onPointerLeave = (): void => {
    if (this.#gesture === null) {
      this.#hover = null;
      this.#renderer?.setHover(null);
    }
  };

  /**
   * Opens the context menu for whatever was right-clicked.
   *
   * @remarks A right-click on a blob outside the selection selects it first, so the menu always
   * acts on what was clicked rather than on an earlier selection the user has moved past.
   */
  /**
   * Clears the loop when the ruler is double-clicked.
   *
   * @remarks A loop is drawn by dragging across the ruler, so it is undrawn where it was drawn.
   * Double-clicking elsewhere is left alone, because a loop is not what is under the cursor
   * there.
   */
  #onDoubleClick = (event: MouseEvent): void => {
    if (this.#store.state.transport.loop === null) {
      return;
    }
    const point = this.#pointOf(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind !== 'ruler' && hit.kind !== 'loopEdge') {
      return;
    }
    event.preventDefault();
    this.#clearLoop();
  };

  #onContextMenu = (event: MouseEvent): void => {
    const state = this.#store.state;
    if (state.phase !== 'ready') {
      return;
    }
    event.preventDefault();
    const point = this.#pointOf(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.blob !== null && !state.selection.blobs.includes(hit.blob)) {
      const blob = this.#blob(hit.blob);
      if (blob !== undefined) {
        this.#selectSpan(blobOutputStart(blob), blobOutputEnd(blob));
      }
    }
    this.#options.contextMenu?.(hit, { x: event.clientX, y: event.clientY });
  };

  #onWheel = (event: WheelEvent): void => {
    const point = this.#pointOf(event);
    const viewport = this.viewport;
    if (event.ctrlKey || event.metaKey) {
      this.#store.update({
        view: viewport.zoomTime(Math.exp(-event.deltaY * WHEEL_ZOOM), point.x),
      });
    } else if (event.altKey) {
      this.#store.update({
        view: viewport.zoomPitch(Math.exp(-event.deltaY * WHEEL_ZOOM), point.y),
      });
    } else if (event.shiftKey) {
      this.#store.update({ view: viewport.pan(event.deltaY, 0), follow: false });
    } else {
      this.#store.update({ view: viewport.pan(event.deltaX, event.deltaY), follow: false });
    }
    event.preventDefault();
  };

  #onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.#gesture !== null) {
      this.#cancelGesture();
      if (this.#pointerId !== null) {
        this.#releasePointer(this.#pointerId);
      }
      event.preventDefault();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    switch (event.key) {
      case '+':
      case '=':
        this.zoomTime(KEY_ZOOM);
        break;
      case '-':
      case '_':
        this.zoomTime(1 / KEY_ZOOM);
        break;
      case '.':
        this.zoomFit();
        break;
      // Home, End and the page keys read the timeline, the way they read a document. Shift keeps
      // the page keys on the pitch axis, which is the only axis they used to have.
      case 'Home':
        this.goTo(0);
        break;
      case 'End':
        this.goTo(this.#projectEnd());
        break;
      case 'PageUp':
        if (event.shiftKey) this.panBy(0, -this.viewport.plotHeight / 2);
        else this.panBy(-this.viewport.width, 0);
        break;
      case 'PageDown':
        if (event.shiftKey) this.panBy(0, this.viewport.plotHeight / 2);
        else this.panBy(this.viewport.width, 0);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  #beginGesture(state: AppState, hit: Hit, modifiers: Modifiers): Gesture | null {
    // Alt over open canvas or the ruler hears a snippet and leaves the playhead where it was.
    // Over a blob Alt stays the fine-adjustment modifier the drag gestures read.
    if ((hit.kind === 'empty' || hit.kind === 'ruler') && modifiers.fine) {
      return { kind: 'audition', start: hit.time, end: hit.time };
    }

    if (hit.kind === 'ruler' || hit.kind === 'loopEdge') {
      if (hit.kind === 'loopEdge' && state.transport.loop !== null) {
        const loop = state.transport.loop;
        return { kind: 'loop', anchorTime: hit.edge === 'start' ? loop.end : loop.start };
      }
      // A press on the ruler places the playhead and a drag across it draws a loop, which is
      // where every other editor puts the loop and where people reach for it first.
      this.#scrubTo(hit.time);
      return { kind: 'rulerDrag', anchorTime: hit.time, drawing: false };
    }

    switch (state.tool) {
      case 'select':
        // Ctrl adds a region of its own, Shift stretches the existing one: the pair every
        // editor with a multi-selection uses, and the pair Melodyne uses.
        return { kind: 'rubberBand', additive: modifiers.snap, extend: modifiers.constrain };
      case 'split':
        return hit.blob === null
          ? this.#beginScrub(hit)
          : { kind: 'split', blob: hit.blob, time: hit.sourceTime };
      case 'pitch': {
        if (hit.kind === 'anchor' && hit.blob !== null && hit.anchor !== null) {
          return {
            kind: 'anchor',
            blob: hit.blob,
            index: hit.anchor,
            time: hit.sourceTime,
            midi: hit.midi,
          };
        }
        if (hit.blob === null) {
          return this.#beginScrub(hit);
        }
        return { kind: 'pitch', blobs: this.#dragSet(hit.blob), semitones: 0 };
      }
      // Drawing starts wherever the pointer goes down, over a blob or over nothing, and the
      // stroke belongs to whatever it crosses rather than to the blob it happened to start on.
      case 'pen':
        return { kind: 'pen', points: [{ time: hit.time, midi: hit.midi }] };
      case 'line': {
        const from = { time: hit.time, midi: hit.midi };
        return { kind: 'line', from, to: from, curved: modifiers.fine };
      }
      case 'time': {
        if (hit.blob === null) {
          return this.#beginScrub(hit);
        }
        if (hit.kind === 'blobEdge' && hit.edge !== null) {
          const blob = this.#blob(hit.blob);
          if (blob === undefined) {
            return null;
          }
          return {
            kind: 'edge',
            blob: blob.id,
            edge: hit.edge,
            sourceTime: hit.edge === 'start' ? blob.start : blob.end,
            scale: hit.edge === 'end' ? blob.timeScale : null,
          };
        }
        return { kind: 'time', blobs: this.#dragSet(hit.blob), seconds: 0 };
      }
      default:
        return this.#beginScrub(hit);
    }
  }

  /**
   * Places the playhead where the pointer went down and keeps dragging it.
   *
   * @remarks What every tool does over open canvas, so the playhead is reachable without
   * travelling to the ruler for it.
   */
  #beginScrub(hit: Hit): Gesture {
    this.#scrubTo(hit.time);
    return { kind: 'scrub' };
  }

  #advanceGesture(modifiers: Modifiers): void {
    const gesture = this.#gesture;
    if (gesture === null) {
      return;
    }
    const viewport = this.viewport;
    const time = viewport.xToTime(this.#current.x);
    const midi = viewport.yToMidi(this.#current.y);
    switch (gesture.kind) {
      case 'scrub':
        this.#scrubTo(time);
        break;
      case 'rulerDrag': {
        // Under the slop the press is still a click, so the playhead keeps following the pointer
        // and no loop is drawn from a hand that never meant to move.
        if (!gesture.drawing && Math.abs(this.#current.x - this.#origin.x) <= CLICK_SLOP) {
          this.#scrubTo(time);
          break;
        }
        gesture.drawing = true;
        const start = Math.min(gesture.anchorTime, time);
        const end = Math.max(gesture.anchorTime, time);
        this.#setLoop(start, end);
        break;
      }
      case 'loop': {
        const start = Math.min(gesture.anchorTime, time);
        const end = Math.max(gesture.anchorTime, time);
        if (end - start > viewport.secondsPerPixel) {
          this.#setLoop(start, end);
        }
        break;
      }
      case 'pitch': {
        const scale = modifiers.fine ? FINE_FACTOR : 1;
        const raw = (viewport.yToMidi(this.#current.y) - viewport.yToMidi(this.#origin.y)) * scale;
        gesture.semitones = this.#quantisePitchDelta(gesture.blobs, raw, modifiers);
        break;
      }
      case 'anchor': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        const source = clamp(
          outputToSource(blob, this.#snapTime(time, modifiers)),
          blob.start,
          blob.end,
        );
        gesture.time = source;
        gesture.midi = snapMidi(
          modifiers.fine ? this.#fineMidi(midi) : midi,
          this.#pitchSnap(modifiers),
          this.#store.state.edits?.scale ?? null,
        );
        break;
      }
      case 'pen': {
        const value = snapMidi(
          midi,
          this.#pitchSnap(modifiers),
          this.#store.state.edits?.scale ?? null,
        );
        const last = gesture.points[gesture.points.length - 1];
        if (last === undefined || time > last.time) {
          gesture.points.push({ time, midi: value });
        } else {
          gesture.points[gesture.points.length - 1] = { time: last.time, midi: value };
        }
        break;
      }
      case 'line': {
        const value = modifiers.constrain
          ? gesture.from.midi
          : snapMidi(midi, this.#pitchSnap(modifiers), this.#store.state.edits?.scale ?? null);
        gesture.to = { time: this.#snapTime(time, modifiers), midi: value };
        gesture.curved = modifiers.fine;
        break;
      }
      case 'time': {
        const scale = modifiers.fine ? FINE_FACTOR : 1;
        const raw = (this.#current.x - this.#origin.x) * viewport.secondsPerPixel * scale;
        gesture.seconds = this.#quantiseTimeDelta(gesture.blobs, raw, modifiers);
        break;
      }
      case 'edge': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        const target = this.#snapTime(time, modifiers);
        if (gesture.edge === 'start') {
          gesture.sourceTime = clamp(outputToSource(blob, target), 0, blob.end - MIN_BLOB_SECONDS);
        } else {
          const duration = Math.max(MIN_BLOB_SECONDS, target - blobOutputStart(blob));
          const sourceDuration = Math.max(MIN_BLOB_SECONDS, blob.end - blob.start);
          gesture.scale = duration / sourceDuration;
          gesture.sourceTime = blob.start + duration / (blob.timeScale === 0 ? 1 : blob.timeScale);
        }
        break;
      }
      case 'audition':
        gesture.end = time;
        break;
      case 'pan': {
        // Measured against the view the drag started from, so a pan never compounds itself.
        const base = viewport.withView(gesture.from);
        this.#store.update({
          view: base.pan(this.#origin.x - this.#current.x, this.#origin.y - this.#current.y),
          follow: false,
        });
        break;
      }
      case 'split': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        gesture.time = clamp(
          outputToSource(blob, this.#snapTime(time, modifiers)),
          blob.start + MIN_BLOB_SECONDS,
          blob.end - MIN_BLOB_SECONDS,
        );
        break;
      }
      case 'rubberBand':
        break;
    }
  }

  #updatePreview(): void {
    const gesture = this.#gesture;
    if (gesture === null) {
      this.#renderer?.setPreview(null);
      return;
    }
    this.#renderer?.setPreview(this.#previewOf(gesture));
    this.render();
  }

  #previewOf(gesture: Gesture): EditorPreview | null {
    switch (gesture.kind) {
      case 'rubberBand':
        return this.#moved ? { kind: 'spanSelect', x0: this.#origin.x, x1: this.#current.x } : null;
      case 'pitch':
        return {
          kind: 'pitchDrag',
          blobs: gesture.blobs,
          semitones: gesture.semitones,
          label: formatSemitones(gesture.semitones),
        };
      case 'time':
        return {
          kind: 'timeDrag',
          blobs: gesture.blobs,
          seconds: gesture.seconds,
          label: formatMilliseconds(gesture.seconds),
        };
      case 'edge':
        return {
          kind: 'edgeDrag',
          blob: gesture.blob,
          edge: gesture.edge,
          time: gesture.sourceTime,
          label:
            gesture.scale === null
              ? `Start ${formatClock(gesture.sourceTime, 0.001)}`
              : `Stretch ${Math.round(gesture.scale * 100)}%`,
        };
      case 'anchor':
        return {
          kind: 'anchorDrag',
          blob: gesture.blob,
          index: gesture.index,
          time: gesture.time,
          midi: gesture.midi,
          label: noteNameWithCents(gesture.midi, this.#accidentals()),
        };
      case 'pen':
        return {
          kind: 'curve',
          points: gesture.points,
          label: `Draw Curve ${gesture.points.length}`,
        };
      case 'line':
        return {
          kind: 'curve',
          points: [gesture.from, gesture.to],
          label: `Ramp ${noteNameWithCents(gesture.to.midi, this.#accidentals())}`,
        };
      case 'split':
        return {
          kind: 'split',
          blob: gesture.blob,
          time: gesture.time,
          label: `Split Blob ${formatClock(gesture.time, 0.001)}`,
        };
      case 'pan':
        return null;
      case 'audition':
        return {
          kind: 'span',
          blob: null,
          start: Math.min(gesture.start, gesture.end),
          end: Math.max(gesture.start, gesture.end),
          label: `Audition ${formatClock(Math.abs(gesture.end - gesture.start), 0.01)}`,
        };
      default:
        return null;
    }
  }

  #finishGesture(): void {
    const gesture = this.#gesture;
    this.#gesture = null;
    this.#renderer?.setPreview(null);
    if (gesture === null) {
      return;
    }
    switch (gesture.kind) {
      case 'rubberBand':
        if (this.#moved) {
          this.#commitBand(gesture.additive, gesture.extend);
        } else {
          this.#commitClick(gesture.additive, gesture.extend);
        }
        break;
      case 'split':
        this.#commit(
          { type: 'splitBlob', blob: gesture.blob, time: gesture.time },
          `Split Blob ${formatClock(gesture.time, 0.001)}`,
        );
        break;
      case 'pitch':
        if (gesture.semitones !== 0) {
          this.#commit(
            { type: 'movePitch', blobs: gesture.blobs, semitones: gesture.semitones },
            `Move Pitch ${formatSemitones(gesture.semitones)}`,
          );
        }
        break;
      case 'anchor':
        this.#commit(
          {
            type: 'moveAnchor',
            blob: gesture.blob,
            index: gesture.index,
            time: gesture.time,
            midi: gesture.midi,
          },
          `Anchor ${noteNameWithCents(gesture.midi, this.#accidentals())}`,
        );
        break;
      case 'pen': {
        const viewport = this.viewport;
        const simplified = simplifyGesture(
          gesture.points,
          viewport.secondsPerPixel * 2,
          viewport.semitonesPerPixel * 2,
        );
        this.#commitStroke(simplified, 'smooth', 'Draw Curve');
        break;
      }
      case 'line': {
        const [from, to] =
          gesture.from.time <= gesture.to.time
            ? [gesture.from, gesture.to]
            : [gesture.to, gesture.from];
        this.#commitStroke(
          [from, to],
          gesture.curved ? 'smooth' : 'linear',
          `Draw Ramp ${noteNameWithCents(gesture.to.midi, this.#accidentals())}`,
        );
        break;
      }
      case 'time':
        if (gesture.seconds !== 0) {
          this.#commit(
            { type: 'moveTime', blobs: gesture.blobs, seconds: gesture.seconds },
            `Move Time ${formatMilliseconds(gesture.seconds)}`,
          );
        }
        break;
      case 'edge': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        if (gesture.edge === 'start') {
          if (gesture.sourceTime !== blob.start) {
            this.#commit(
              { type: 'moveBoundary', blob: blob.id, edge: 'start', time: gesture.sourceTime },
              `Blob Start ${formatClock(gesture.sourceTime, 0.001)}`,
            );
          }
        } else if (gesture.scale !== null && gesture.scale !== blob.timeScale) {
          this.#commit(
            { type: 'setTimeScale', blob: blob.id, scale: gesture.scale },
            `Stretch ${Math.round(gesture.scale * 100)}%`,
          );
        }
        break;
      }
      case 'audition': {
        // A snippet deliberately leaves both the playhead and the selection alone, so it can be
        // heard anywhere without losing the position being worked at.
        const start = Math.min(gesture.start, gesture.end);
        const end = Math.max(gesture.start, gesture.end);
        const span = end - start < AUDITION_SECONDS ? start + AUDITION_SECONDS : end;
        this.#options.audition?.(start, span);
        break;
      }
      case 'pan':
        this.#applyCursor(this.#hover);
        break;
      case 'scrub':
      case 'loop':
        break;
    }
    this.render();
  }

  /**
   * Selects everything a dragged span covers.
   *
   * @remarks A selection is a span of time, never a rectangle. Pitch is ignored deliberately: a
   * blob is selected when the span reaches it at all, so what is selected is what the shaded
   * region on screen says is selected, and a drag along one pitch does not miss the blob above
   * it. Operations that care how much of a blob was covered read the span itself.
   */
  #commitBand(additive: boolean, extend: boolean): void {
    const viewport = this.viewport;
    const left = viewport.xToTime(Math.min(this.#origin.x, this.#current.x));
    const right = viewport.xToTime(Math.max(this.#origin.x, this.#current.x));
    this.#selectRange({ start: left, end: right }, additive, extend);
  }

  /**
   * Selects what a span of output time covers.
   *
   * @remarks `additive` keeps the existing spans and adds this one beside them, which is what
   * makes a selection of two phrases with untouched material between them possible. `extend`
   * stretches the selection to reach the new span instead, so the result stays one region.
   */
  #selectRange(range: TimeRange, additive: boolean, extend: boolean): void {
    const blobs = this.#store.state.blobs;
    const existing = this.#store.state.selection.ranges;
    let ranges: TimeRange[];
    if (additive) {
      ranges = withRange(existing, range);
    } else if (extend) {
      const hull = selectionSpan(existing);
      ranges =
        hull === null
          ? [range]
          : [{ start: Math.min(hull.start, range.start), end: Math.max(hull.end, range.end) }];
    } else {
      ranges = [range];
    }
    const selection = selectionForRanges(blobs, ranges);
    this.#setSelection(selection);
    this.#announce(`${String(selection.blobs.length)} selected`);
  }

  /** Replaces the selection with the blobs and anchors a span of output time covers. */
  #selectSpan(start: number, end: number): void {
    this.#selectRange({ start, end }, false, false);
  }

  /**
   * Selects what a click landed on.
   *
   * @remarks Clicking a blob selects the span that blob occupies, so a click and a drag produce
   * the same kind of selection. Open canvas clears the selection and places the playhead.
   */
  #commitClick(additive: boolean, extend: boolean): void {
    const hit = this.hitTest(this.#current.x, this.#current.y);
    const previous = this.#store.state.selection;
    if (hit.kind === 'anchor' && hit.blob !== null && hit.anchor !== null) {
      const entry = { blob: hit.blob, index: hit.anchor };
      const owner = this.#blob(hit.blob);
      this.#setSelection({
        blobs: owner === undefined ? previous.blobs : [owner.id],
        anchors: additive ? [...previous.anchors, entry] : [entry],
        ranges:
          owner === undefined
            ? previous.ranges
            : [{ start: blobOutputStart(owner), end: blobOutputEnd(owner) }],
      });
      return;
    }
    if (hit.blob === null) {
      this.#setSelection(emptySelection());
      this.#scrubTo(hit.time);
      return;
    }
    const blob = this.#blob(hit.blob);
    if (blob === undefined) {
      return;
    }
    this.#selectRange({ start: blobOutputStart(blob), end: blobOutputEnd(blob) }, additive, extend);
  }

  /**
   * Commits a stroke drawn in output seconds onto every blob it crossed.
   *
   * @remarks A stroke is one gesture and one undo step, carrying one curve edit per blob,
   * because a pitch curve belongs to a blob while the stroke belongs to the take. Each blob is
   * given the part of the stroke that falls inside it, sampled at its own edges so a curve does
   * not stop short of the boundary it was drawn across. Blobs the stroke only grazes are left
   * alone.
   */
  #commitStroke(points: readonly GesturePoint[], interp: Interp, message: string): void {
    if (points.length < 2) {
      return;
    }
    const ops: EditOp[] = [];
    for (const blob of this.#store.state.blobs) {
      const inside = clipToSpan(points, blobOutputStart(blob), blobOutputEnd(blob));
      if (inside.length < 2) {
        continue;
      }
      const anchors = gestureAnchors(
        inside.map((point) => ({
          time: clamp(outputToSource(blob, point.time), blob.start, blob.end),
          midi: point.midi,
        })),
        interp,
      );
      if (anchors.length < 2) {
        continue;
      }
      ops.push({ type: 'drawSpan', blob: blob.id, anchors });
    }
    if (ops.length === 0) {
      return;
    }
    this.#commit(
      grouped(ops),
      ops.length === 1 ? message : `${message} Over ${String(ops.length)} Blobs`,
    );
  }

  #dragSet(id: BlobId): BlobId[] {
    const selection = this.#store.state.selection;
    if (selection.blobs.includes(id)) {
      return [...selection.blobs];
    }
    const blob = this.#blob(id);
    if (blob === undefined) {
      return [id];
    }
    this.#setSelection(
      selectionForRange(this.#store.state.blobs, {
        start: blobOutputStart(blob),
        end: blobOutputEnd(blob),
      }),
    );
    return [id];
  }

  #quantisePitchDelta(blobs: readonly BlobId[], raw: number, modifiers: Modifiers): number {
    if (modifiers.constrain) {
      return Math.round(raw);
    }
    const first = this.#blob(blobs[0] ?? -1);
    if (modifiers.snap && first !== undefined) {
      const centre = first.detectedCenter + first.pitchOffset;
      const snapped = snapMidi(centre + raw, 'scale', this.#store.state.edits?.scale ?? null);
      return snapped - centre;
    }
    return raw;
  }

  #quantiseTimeDelta(blobs: readonly BlobId[], raw: number, modifiers: Modifiers): number {
    const first = this.#blob(blobs[0] ?? -1);
    if (first === undefined || modifiers.fine) {
      return raw;
    }
    const wantsSnap = modifiers.constrain || !modifiers.snap;
    if (!wantsSnap) {
      return raw;
    }
    const moved = blobOutputStart(first) + raw;
    return snapTime(moved, this.#snapContext()) - blobOutputStart(first);
  }

  #snapTime(seconds: number, modifiers: Modifiers): number {
    if (modifiers.fine || modifiers.snap) {
      return seconds;
    }
    return snapTime(seconds, this.#snapContext());
  }

  #snapContext(): SnapContext {
    const state = this.#store.state;
    return {
      timeline: state.edits?.timeline ?? null,
      division: state.view.snapDivision,
      blobs: state.blobs,
      tolerance: this.viewport.secondsPerPixel * SNAP_PIXELS,
    };
  }

  #pitchSnap(modifiers: Modifiers): PitchSnap {
    if (modifiers.constrain) {
      return 'semitone';
    }
    return modifiers.snap ? 'scale' : 'free';
  }

  #fineMidi(midi: number): number {
    const viewport = this.viewport;
    const origin = viewport.yToMidi(this.#origin.y);
    return origin + (midi - origin) * FINE_FACTOR;
  }

  /**
   * Puts the playhead at a time and brings the view with it.
   *
   * @remarks What Home and End do. Following is switched off, because arriving somewhere by hand
   * and then being scrolled off it again is not what either key was pressed for.
   */
  goTo(seconds: number): void {
    const position = Math.max(0, seconds);
    this.#scrubTo(position);
    if (!isVisible(this.#store.state.view, position)) {
      this.#store.update({ view: snapViewTo(this.#store.state.view, position), follow: false });
    }
  }

  /** End of the material, which is the source when there is one and the last blob otherwise. */
  #projectEnd(): number {
    const state = this.#store.state;
    return state.source?.duration ?? state.blobs.at(-1)?.end ?? 0;
  }

  #scrubTo(seconds: number): void {
    const position = Math.max(0, seconds);
    this.#store.update({ view: { ...this.#store.state.view, playhead: position } });
    this.#options.seek?.(position);
  }

  /**
   * Sets the loop the transport plays.
   *
   * @remarks Goes to the audio engine as well as to the store. Writing only the store drew a loop
   * the transport then played straight past, which is the one thing a loop must not do.
   */
  #setLoop(start: number, end: number): void {
    const state = this.#store.state;
    if (end - start <= this.viewport.secondsPerPixel) {
      return;
    }
    this.#store.update({
      transport: { ...state.transport, loop: { start, end } },
      view: { ...state.view, loopStart: start, loopEnd: end },
    });
    this.#options.setLoop?.({ start, end });
  }

  /** Removes the loop, in the store and in the transport that is playing it. */
  #clearLoop(): void {
    const state = this.#store.state;
    this.#store.update({
      transport: { ...state.transport, loop: null },
      view: { ...state.view, loopStart: null, loopEnd: null },
    });
    this.#options.setLoop?.(null);
    this.#announce('Loop cleared.');
  }

  #setSelection(selection: Selection): void {
    this.#store.update({ selection });
  }

  #commit(op: EditOp, message: string): void {
    this.#options.apply(op);
    this.#announce(message);
  }

  #announce(message: string): void {
    this.#options.announce?.(message);
  }

  #accidentals(): 'sharps' | 'flats' {
    return this.#store.state.edits?.accidentals ?? 'sharps';
  }

  #playhead(): number {
    const state = this.#store.state;
    return state.transport.playing ? state.transport.position : state.view.playhead;
  }

  #blob(id: BlobId): Blob | undefined {
    return this.#store.state.blobs.find((blob) => blob.id === id);
  }

  #blobAtOutput(seconds: number): Blob | undefined {
    return this.#store.state.blobs.find(
      (blob) => seconds >= blobOutputStart(blob) && seconds <= blobOutputEnd(blob),
    );
  }

  /**
   * Shapes the cursor for what is under it.
   *
   * @remarks The canvas carries no `title`. The renderer draws its own readout immediately,
   * while the host tooltip appears only after a delay and only while the window holds focus,
   * so setting both showed two tooltips that disagreed about when to appear.
   */
  #applyCursor(hit: Hit | null): void {
    const tool = this.#store.state.tool;
    this.#canvas.style.cursor = hit === null ? 'default' : cursorFor(tool, hit);
  }

  #releasePointer(pointerId: number): void {
    if (this.#canvas.hasPointerCapture(pointerId)) {
      this.#canvas.releasePointerCapture(pointerId);
    }
    this.#pointerId = null;
    this.#moved = false;
  }

  #cancelGesture(): void {
    if (this.#gesture === null) {
      return;
    }
    this.#gesture = null;
    this.#renderer?.setPreview(null);
    this.render();
  }

  #pointOf(event: PointerEvent | WheelEvent | MouseEvent): Point {
    const rect = this.#canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }
}

/**
 * Captures a pointer for the duration of a drag, tolerating a host that refuses.
 *
 * @remarks Capture is what keeps a drag alive once it leaves the canvas, but it throws for a
 * pointer the host no longer considers active. Letting that escape would abandon the gesture at
 * the moment it began, which is worse than a drag that simply stops at the canvas edge.
 */
function capturePointer(element: Element, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The drag still tracks pointer events that reach the element.
  }
}

/**
 * The part of a stroke that falls inside a span, with a point placed at each edge it crosses.
 *
 * @remarks The interpolated edge points are what keep a curve reaching the blob boundary instead
 * of stopping at the last sample that happened to land inside it.
 */
function clipToSpan(points: readonly GesturePoint[], start: number, end: number): GesturePoint[] {
  const inside: GesturePoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (point === undefined) {
      continue;
    }
    const previous = points[index - 1];
    if (previous !== undefined) {
      // Both edges, not the first one found: a single segment drawn across a whole blob crosses
      // its start and its end, and taking only one of them leaves that blob a single point.
      for (const edge of [start, end]) {
        const crossing = crossPoint(previous, point, edge);
        if (crossing !== null) {
          inside.push(crossing);
        }
      }
    }
    if (point.time >= start && point.time <= end) {
      inside.push(point);
    }
  }
  inside.sort((a, b) => a.time - b.time);
  return inside;
}

/** Where a segment crosses a time, or `null` when it does not. */
function crossPoint(a: GesturePoint, b: GesturePoint, at: number): GesturePoint | null {
  const low = Math.min(a.time, b.time);
  const high = Math.max(a.time, b.time);
  if (at <= low || at >= high) {
    return null;
  }
  const span = b.time - a.time;
  const t = span === 0 ? 0 : (at - a.time) / span;
  return { time: at, midi: a.midi + (b.midi - a.midi) * t };
}

/** One edit when there is one, and one group when there are several. */
function grouped(ops: readonly EditOp[]): EditOp {
  return ops.length === 1 && ops[0] !== undefined ? ops[0] : { type: 'group', ops: [...ops] };
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) {
    return low;
  }
  return value < low ? low : value > high ? high : value;
}

function formatSemitones(semitones: number): string {
  const sign = semitones >= 0 ? '+' : '-';
  const size = Math.abs(semitones);
  if (size < 1) {
    return `${sign}${Math.round(size * 100)} cents`;
  }
  return `${sign}${size.toFixed(2)} st`;
}

function formatMilliseconds(seconds: number): string {
  const sign = seconds >= 0 ? '+' : '-';
  return `${sign}${Math.round(Math.abs(seconds) * 1000)} ms`;
}
