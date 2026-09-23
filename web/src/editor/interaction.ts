// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  emptySelection,
  selectionForRange,
  selectionForRanges,
  selectionSpan,
  withRange,
} from '../app/selection.js';
import type { TimeRange } from '../app/selection.js';
import {
  deleteStrokeOps,
  drawStrokeOps,
  liftRunOps,
  movePitchOps,
  outsideRunAt,
  samplePitch,
  shiftLines,
  strokeSpan,
  strokeValue,
} from '../app/clipboard.js';
import type { OutsideRun, PitchPoint } from '../app/clipboard.js';
import { othersOf } from '../app/sources.js';
import { projectEnd } from '../app/store.js';
import type { AppState, AppStore, Selection, ToolId } from '../app/store.js';
import type { Blob, BlobId, Edge, EditOp, Stroke, ViewState } from '../core/types.js';
import { clipEnd, clipOf, clipStart, displayTitle, MIN_BLOB_SECONDS } from '../core/types.js';
import {
  blobOutputEnd,
  blobOutputStart,
  blobPitchExtent,
  CONFLICT_STRIP,
  outputToSource,
  sourceToOutput,
  titleRect,
  TITLE_HEIGHT,
} from './layers/blobs.js';
import { MARQUEE_CURSOR } from './cursors.js';
import { referenceRect } from './layers/references.js';
import { detectedAt } from './layers/pitch.js';
import { noteNameWithCents } from '../core/notes.js';
import { formatClock } from './layers/ruler.js';
import type { EditorRenderer } from './renderer.js';
import type {
  BezierCurve,
  BezierHandle,
  EditorPreview,
  GesturePoint,
  Hit,
  Modifiers,
  PendingClip,
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
  extendStroke,
  modifiersOf,
  rippleInsert,
  moveBezierHandle,
  sampleBezier,
  simplifyGesture,
  snapMidi,
  SNAP_PIXELS,
  snapTime,
  straightBezier,
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
  /** Brings a clip outside the editor's layer forward, so its blobs can be edited. */
  focus?(clip: number): void;
}

type Point = { x: number; y: number };

type Gesture =
  | { kind: 'rubberBand'; additive: boolean; extend: boolean }
  | { kind: 'scrub' }
  | { kind: 'loop'; anchorTime: number }
  | { kind: 'rulerDrag'; anchorTime: number; drawing: boolean }
  | { kind: 'pitch'; blobs: BlobId[]; semitones: number }
  | { kind: 'anchor'; blob: BlobId; index: number; time: number; midi: number }
  | { kind: 'pen'; points: GesturePoint[]; last: GesturePoint }
  | { kind: 'bezierDraw'; from: GesturePoint; to: GesturePoint }
  | { kind: 'bezierHandle'; handle: BezierHandle }
  | { kind: 'time'; blobs: BlobId[]; seconds: number }
  | { kind: 'edge'; blob: BlobId; edge: Edge; sourceTime: number; scale: number | null }
  /** Blob mode: blobs slid along the audio, held between `lower` and `upper` seconds. */
  | { kind: 'shift'; blobs: BlobId[]; seconds: number; lower: number; upper: number }
  /** Pitch mode: the pitch line across `ranges` moved, audio left where it is. */
  | {
      kind: 'contour';
      ranges: TimeRange[];
      lines: PitchPoint[][];
      seconds: number;
      semitones: number;
      /** Whether the drag moves the line in time rather than in pitch. */
      horizontal: boolean;
    }
  /** Pitch outside every blob picked up, to become a blob of its own when let go. */
  | {
      kind: 'lift';
      run: OutsideRun;
      lines: PitchPoint[][];
      seconds: number;
      semitones: number;
      horizontal: boolean;
    }
  | { kind: 'audition'; start: number; end: number }
  | { kind: 'pan'; from: ViewState }
  | { kind: 'split'; blob: BlobId; time: number }
  | {
      kind: 'clip';
      clip: number;
      /** The blob whose tab was pressed, which a click without a drag selects. */
      blob: BlobId;
      /** Whether that click adds to the selection or stretches it, as on the blob itself. */
      additive: boolean;
      extend: boolean;
      /** Where the clip sat when it was picked up, in project seconds. */
      from: number;
      /** How far into the clip the pointer took hold, so the clip does not jump to it. */
      grab: number;
      duration: number;
      position: number;
      /** Whether it is inserted, moving every clip after it later to make room. */
      ripple: boolean;
    }
  | { kind: 'reference'; reference: number; from: number; grab: number; position: number };

const WHEEL_ZOOM = 0.002;

/** Grab radius in pixels around a Bezier end or control point. */
const BEZIER_HANDLE_RADIUS = 8;

/** Pixels of curve per sample when a Bezier is committed. */
const BEZIER_SAMPLE_PIXELS = 6;

/** Most samples one committed Bezier carries. */
const BEZIER_MAX_SAMPLES = 96;

const KEY_ZOOM = 1.3;

/** Grab distance in pixels around a kept curve. */
const STROKE_GRIP = 5;

/** Grab distance in pixels above and below a pitch line outside every blob. */
const PITCH_LINE_GRIP = 6;

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
  /** Where the pointer last was over the canvas, or `null` once it has left. */
  #pointer: Point | null = null;
  /** The view and blobs the hover readout was last read against. */
  #hoverView: unknown = null;
  #hoverBlobs: unknown = null;
  #moved = false;
  #gesture: Gesture | null = null;
  #hover: Hit | null = null;
  /**
   * The Bezier being shaped, between drawing it and keeping it.
   *
   * @remarks Kept by Enter, a tool change or the next curve, and dropped by Escape. Nothing
   * reaches the session until it is kept, so shaping one leaves no history.
   */
  #bezier: BezierCurve | null = null;
  /** The kept curve the Bezier being shaped was opened from, which keeping it replaces. */
  #editing: Stroke | null = null;

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

    this.#unsubscribe = this.#store.subscribe((state) => {
      if (this.#bezier !== null && this.#gesture === null) {
        if (state.phase !== 'ready') {
          this.#dropBezier();
        } else if (state.tool !== 'bezier') {
          this.#keepBezier();
        }
      }
      this.render();
      // A view that scrolls under a still pointer, as Follow does during playback, leaves the
      // readout naming what used to be there unless it is read again.
      if (
        this.#pointer !== null &&
        (state.view !== this.#hoverView || state.blobs !== this.#hoverBlobs)
      ) {
        this.#readHover(this.#pointer);
      }
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
      reference: null,
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
        // An anchor is heard, and drawn, with its blob's offset added.
        const heard = anchor.midi + blob.pitchOffset;
        const ay = viewport.midiToY(heard);
        if (Math.hypot(ax - x, ay - y) <= ANCHOR_RADIUS) {
          return {
            ...base,
            kind: 'anchor',
            blob: blob.id,
            anchor: index,
            sourceTime: anchor.time,
            midi: heard,
          };
        }
      }
    }

    // A kept curve answers to the tools that pick one up, wherever it runs, blob or gap.
    if (state.editMode !== 'blob' && (state.tool === 'select' || state.tool === 'bezier')) {
      const stroke = this.#strokeAt(viewport, x, y);
      if (stroke !== null) {
        const value = strokeValue(stroke, time) ?? midi;
        return { ...base, kind: 'stroke', stroke: stroke.id, midi: value };
      }
    }

    // A reference's band lies along the foot of the plot, under everything the pitch field
    // draws, so it answers first where it is.
    const references = state.edits?.references ?? [];
    for (let index = 0; index < references.length; index += 1) {
      const reference = references[index];
      if (reference === undefined) continue;
      const rect = referenceRect(reference, index, viewport);
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        return { ...base, kind: 'reference', reference: reference.id };
      }
    }

    // The tab over a blob names its clip and is where the clip is picked up, so it answers
    // before the blob under it does.
    for (const blob of state.blobs) {
      const rect = titleRect(blob, state.track, viewport);
      if (
        rect !== null &&
        x >= rect.x &&
        x <= rect.x + rect.width &&
        y >= rect.y &&
        y <= rect.y + rect.height
      ) {
        return { ...base, kind: 'clipTitle', blob: blob.id };
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

    // Pitch outside every blob answers only while it is shown, and is where it was sung.
    if (state.outsidePitch && state.track !== null) {
      const detected = detectedAt(state.track, time);
      const owned = state.blobs.some((blob) => time >= blob.start && time < blob.end);
      if (
        detected !== null &&
        !owned &&
        Math.abs(viewport.midiToY(detected) - y) <= PITCH_LINE_GRIP &&
        outsideRunAt(state, time) !== null
      ) {
        return { ...base, kind: 'pitchLine', midi: detected };
      }
    }

    // Reported only over its strip along the top of the plot, where no blob covers it.
    const onStrip = y <= viewport.plotTop + CONFLICT_STRIP + EDGE_GRIP;
    for (const conflict of onStrip ? state.conflicts : []) {
      if (time >= conflict.start && time <= conflict.end) {
        return { ...base, kind: 'conflict', conflict };
      }
    }
    return base;
  }

  /** Switches the armed tool. */
  setTool(tool: ToolId): void {
    this.#cancelGesture();
    if (tool !== 'bezier') this.#keepBezier();
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
        `Anchor ${noteNameWithCents(point.midi + blob.pitchOffset + semitones, this.#accidentals())}`,
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
      const owner = this.#blob(anchor.blob);
      const point = owner?.curve.anchors[anchor.index];
      if (owner === undefined || point === undefined) {
        return;
      }
      this.#commit(
        {
          type: 'moveAnchor',
          blob: anchor.blob,
          index: anchor.index,
          time: point.time,
          midi: midi - owner.pitchOffset,
        },
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
      end = projectEnd(state) || 10;
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
    this.#bezier = null;
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
    const hit = this.#bringForward(point, this.hitTest(point.x, point.y));
    const modifiers = modifiersOf(event);
    this.#canvas.focus();
    capturePointer(this.#canvas, event.pointerId);
    this.#pointerId = event.pointerId;
    this.#origin = point;
    this.#current = point;
    this.#moved = false;
    this.#gesture = this.#beginGesture(this.#store.state, hit, modifiers);
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
    this.#pointer = point;
    if (this.#pointerId === null || this.#gesture === null) {
      this.#readHover(point);
      return;
    }
    this.#current = point;
    if (Math.hypot(point.x - this.#origin.x, point.y - this.#origin.y) > CLICK_SLOP) {
      this.#moved = true;
    }
    this.#advanceGesture(modifiers);
    this.#updatePreview();
    // The readout and its guides go on following the pointer through a drag, read against the
    // view the drag has just produced, rather than staying where the drag began.
    this.#readHover(point);
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

  /**
   * The clip outside the editor's layer whose blob or title is under a point, or `null`.
   *
   * @remarks Only while the others are shown; dimmed or hidden, they are never hit.
   */
  #otherClipAt(point: Point): number | null {
    const state = this.#store.state;
    if (othersOf(state.view) !== 'show') return null;
    const viewport = this.viewport;
    for (const other of state.others) {
      for (const blob of other.blobs) {
        const x0 = viewport.timeToX(blobOutputStart(blob));
        const x1 = viewport.timeToX(blobOutputEnd(blob));
        if (point.x < x0 || point.x > x1) continue;
        const extent = blobPitchExtent(blob, other.track);
        const top = viewport.midiToY(extent.high) - TITLE_HEIGHT;
        const bottom = viewport.midiToY(extent.low) + BODY_SLACK;
        if (point.y >= top && point.y <= bottom) return other.clip;
      }
    }
    return null;
  }

  /**
   * Brings forward the clip behind a point where nothing of the layer is hit, and hits again.
   *
   * @remarks The layer is in front, so a click that lands on it acts on it. Where it lands on a
   * clip behind instead, that clip comes forward and the click acts on it.
   */
  #bringForward(point: Point, hit: Hit): Hit {
    if (hit.kind !== 'empty' && hit.kind !== 'conflict') return hit;
    const clip = this.#otherClipAt(point);
    if (clip === null || this.#options.focus === undefined) return hit;
    this.#options.focus(clip);
    return this.hitTest(point.x, point.y);
  }

  /**
   * Reads what is under `point` into the hover readout and its guides.
   *
   * @remarks Outside a gesture it also sets the cursor for what is there. During one the cursor
   * belongs to the gesture and is left alone.
   */
  #readHover(point: Point): void {
    const state = this.#store.state;
    this.#hoverView = state.view;
    this.#hoverBlobs = state.blobs;
    const hit = this.hitTest(point.x, point.y);
    if (this.#gesture === null) {
      this.#hover = hit;
      this.#applyCursor(hit);
      if (this.#bezierHandleAt(point) !== null) {
        this.#canvas.style.cursor = 'grab';
      }
    }
    const behind =
      hit.kind === 'empty' || hit.kind === 'conflict' ? this.#otherClipAt(point) : null;
    const clip = behind === null ? undefined : state.edits?.clips.find((c) => c.id === behind);
    if (clip !== undefined && this.#gesture === null) {
      this.#canvas.style.cursor = 'pointer';
    }
    const text = clip === undefined ? describeHit(hit, state) : `Edit ${displayTitle(clip)}`;
    this.#renderer?.setHover({ x: point.x, y: point.y, text });
    this.#renderer?.setHoverBlob(hit.blob);
  }

  #onPointerLeave = (): void => {
    this.#pointer = null;
    if (this.#gesture === null) {
      this.#hover = null;
      this.#renderer?.setHover(null);
      this.#renderer?.setHoverBlob(null);
    }
  };

  /**
   * Selects a whole clip when its title is double-clicked, and clears the loop when the ruler is.
   *
   * @remarks A loop is drawn by dragging across the ruler, so it is undrawn where it was drawn.
   * Double-clicking anywhere else is left alone, because a loop is not what is under the cursor
   * there.
   */
  #onDoubleClick = (event: MouseEvent): void => {
    const point = this.#pointOf(event);
    const hit = this.hitTest(point.x, point.y);
    if (hit.kind === 'clipTitle' && hit.blob !== null) {
      event.preventDefault();
      this.#selectClip(clipOf(hit.blob));
      return;
    }
    if (this.#store.state.transport.loop === null) {
      return;
    }
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
    const hit = this.#bringForward(point, this.hitTest(point.x, point.y));
    if (hit.blob !== null && !this.#store.state.selection.blobs.includes(hit.blob)) {
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
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      this.#gesture === null &&
      (this.#editing !== null || this.#store.state.activeStroke !== null)
    ) {
      // Ahead of the window's own Delete, which would delete the blobs under the curve.
      if (this.#deleteStroke()) {
        event.stopPropagation();
        event.preventDefault();
        return;
      }
    }
    if (this.#bezier !== null && this.#gesture === null) {
      if (event.key === 'Enter' || event.key === 'Escape') {
        if (event.key === 'Enter') this.#keepBezier();
        else this.#dropBezier();
        // The window's own Escape clears the selection, which is not what dropping a curve means.
        event.stopPropagation();
        event.preventDefault();
        return;
      }
    }
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

    if (hit.kind === 'reference' && hit.reference !== null) {
      const reference = state.edits?.references.find((entry) => entry.id === hit.reference);
      if (reference !== undefined) {
        return {
          kind: 'reference',
          reference: reference.id,
          from: reference.position,
          grab: hit.time - reference.position,
          position: reference.position,
        };
      }
    }

    if (
      hit.kind === 'clipTitle' &&
      hit.blob !== null &&
      this.#bezierHandleAt(this.#origin) === null
    ) {
      const gesture = this.#beginClipDrag(state, hit.blob, hit.time, modifiers);
      if (gesture !== null) {
        return gesture;
      }
    }

    if (hit.kind === 'stroke' && hit.stroke !== undefined && hit.stroke !== null) {
      const handle = state.tool === 'bezier' ? this.#bezierHandleAt(this.#origin) : null;
      if (handle !== null) return { kind: 'bezierHandle', handle };
      this.#pickStroke(hit.stroke);
      return null;
    }

    const mode = state.editMode;
    // Blob mode edits blobs alone, so the tools that edit pitch only place the playhead there.
    if (
      mode === 'blob' &&
      (state.tool === 'pitch' || state.tool === 'pen' || state.tool === 'bezier')
    ) {
      return this.#beginScrub(hit);
    }
    if (mode === 'pitch' && (state.tool === 'pitch' || state.tool === 'time')) {
      if (
        state.tool === 'pitch' &&
        hit.kind === 'anchor' &&
        hit.blob !== null &&
        hit.anchor !== null
      ) {
        return {
          kind: 'anchor',
          blob: hit.blob,
          index: hit.anchor,
          time: hit.sourceTime,
          midi: hit.midi,
        };
      }
      return this.#beginContour(state, hit, state.tool === 'time') ?? this.#beginScrub(hit);
    }
    if (hit.kind === 'pitchLine' && (state.tool === 'pitch' || state.tool === 'time')) {
      return this.#beginLift(state, hit, state.tool === 'time') ?? this.#beginScrub(hit);
    }

    switch (state.tool) {
      case 'select':
        // Ctrl adds a region of its own, Shift stretches the existing one: the pair every
        // editor with a multi-selection uses, and the pair Melodyne uses.
        return { kind: 'rubberBand', additive: modifiers.snap, extend: modifiers.constrain };
      case 'split':
        // Splitting is a blob edit, which Pitch mode leaves alone.
        return hit.blob === null || mode === 'pitch'
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
      case 'pen': {
        const first = { time: hit.time, midi: hit.midi };
        return { kind: 'pen', points: [first], last: first };
      }
      case 'bezier': {
        const handle = this.#bezierHandleAt(this.#origin);
        if (handle !== null) {
          return { kind: 'bezierHandle', handle };
        }
        // Drawing another curve keeps the one being shaped, the way a vector editor finishes a
        // path when the next one starts.
        this.#keepBezier();
        const from = { time: hit.time, midi: hit.midi };
        return { kind: 'bezierDraw', from, to: from };
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
        if (mode === 'blob') {
          return this.#beginShift(state, this.#dragSet(hit.blob));
        }
        return { kind: 'time', blobs: this.#dragSet(hit.blob), seconds: 0 };
      }
      default:
        return this.#beginScrub(hit);
    }
  }

  /**
   * Picks up blobs to slide along the audio, with the distance they can go before one meets a
   * blob outside the set or the edge of its clip.
   */
  #beginShift(state: AppState, ids: readonly BlobId[]): Gesture {
    const set = new Set(ids);
    let lower = Number.NEGATIVE_INFINITY;
    let upper = Number.POSITIVE_INFINITY;
    for (const blob of state.blobs) {
      if (!set.has(blob.id)) continue;
      const clip = state.edits?.clips.find((entry) => entry.id === clipOf(blob.id));
      if (clip !== undefined) {
        lower = Math.max(lower, clipStart(clip) - blob.start);
        upper = Math.min(upper, clipEnd(clip) - blob.end);
      }
      for (const other of state.blobs) {
        if (set.has(other.id) || clipOf(other.id) !== clipOf(blob.id)) continue;
        if (other.end <= blob.start + 1e-9) lower = Math.max(lower, other.end - blob.start);
        if (other.start >= blob.end - 1e-9) upper = Math.min(upper, other.start - blob.end);
      }
    }
    return {
      kind: 'shift',
      blobs: [...ids],
      seconds: 0,
      lower: Math.min(0, lower),
      upper: Math.max(0, upper),
    };
  }

  /**
   * Picks up the pitch line under the pointer: the selection when the pointer is inside it, else
   * the blob or the outside run it is over, which becomes the selection.
   */
  #beginContour(state: AppState, hit: Hit, horizontal: boolean): Gesture | null {
    let ranges =
      state.selection.ranges.filter((range) => hit.time >= range.start && hit.time <= range.end)
        .length > 0
        ? [...state.selection.ranges]
        : [];
    if (ranges.length === 0) {
      const blob = hit.blob === null ? undefined : this.#blob(hit.blob);
      const run = hit.kind === 'pitchLine' ? outsideRunAt(state, hit.time) : null;
      const span =
        blob !== undefined
          ? { start: blobOutputStart(blob), end: blobOutputEnd(blob) }
          : run === null
            ? null
            : { start: run.start, end: run.end };
      if (span === null) return null;
      this.#setSelection(selectionForRange(state.blobs, span));
      ranges = [span];
    }
    const lines = samplePitch(this.#store.state, ranges);
    if (lines.length === 0) return null;
    return { kind: 'contour', ranges, lines, seconds: 0, semitones: 0, horizontal };
  }

  /** Picks up pitch outside every blob, to become a blob of its own. */
  #beginLift(state: AppState, hit: Hit, horizontal: boolean): Gesture | null {
    const run = outsideRunAt(state, hit.time);
    if (run === null) return null;
    const lines = samplePitch(state, [{ start: run.start, end: run.end }]);
    return { kind: 'lift', run, lines, seconds: 0, semitones: 0, horizontal };
  }

  /** Picks up the clip a blob belongs to, by the point under the pointer. */
  #beginClipDrag(
    state: AppState,
    blob: BlobId,
    time: number,
    modifiers: Modifiers,
  ): Gesture | null {
    const id = clipOf(blob);
    const clip = state.edits?.clips.find((entry) => entry.id === id);
    if (clip === undefined) {
      return null;
    }
    return {
      kind: 'clip',
      clip: id,
      blob,
      additive: modifiers.snap,
      extend: modifiers.constrain,
      from: clip.position,
      grab: time - clip.position,
      duration: clip.source.duration,
      position: clip.position,
      ripple: false,
    };
  }

  /**
   * Shows where audio dragged in from outside would land, and returns that time.
   *
   * @remarks Client coordinates, as a drag event carries them. `null` when the pointer is not over
   * the canvas, which also takes the marker away. Ctrl puts it at the start, and Shift inserts a
   * vocal there, moving the clips after it later, as they do for a clip being moved.
   */
  previewDrop(clientX: number, clientY: number, modifiers = NO_MODIFIERS): number | null {
    const rect = this.#canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) {
      this.endDrop();
      return null;
    }
    const time = this.#placeTime(this.viewport.xToTime(x), { ...modifiers, fine: false }, false);
    // A vocal and a reference both land where they are let go, over whatever is there, unless
    // Shift inserts the vocal instead.
    this.#renderer?.setPreview({
      kind: 'drop',
      time,
      label: `${modifiers.constrain ? 'Insert' : 'Import'} At ${formatClock(time, 0.001)}`,
    });
    return time;
  }

  /** Shows a clip being imported where it will land, or takes it away with `null`. */
  showPending(pending: PendingClip | null): void {
    this.#renderer?.setPending(pending);
  }

  /** Takes the drop marker away. */
  endDrop(): void {
    if (this.#gesture === null) {
      this.#updatePreview();
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
        const next = { time, midi: value };
        gesture.points = extendStroke(gesture.points, gesture.last, next);
        gesture.last = next;
        break;
      }
      case 'bezierDraw': {
        const value = modifiers.constrain
          ? gesture.from.midi
          : snapMidi(midi, this.#pitchSnap(modifiers), this.#store.state.edits?.scale ?? null);
        gesture.to = { time: this.#snapTime(time, modifiers), midi: value };
        break;
      }
      case 'bezierHandle': {
        const curve = this.#bezier;
        if (curve === null) {
          break;
        }
        // The ends snap like any drawn point; the controls only shape, so they move freely.
        const end = gesture.handle === 'from' || gesture.handle === 'to';
        const point = end
          ? {
              time: this.#snapTime(time, modifiers),
              midi: snapMidi(
                midi,
                this.#pitchSnap(modifiers),
                this.#store.state.edits?.scale ?? null,
              ),
            }
          : { time, midi: modifiers.fine ? this.#fineMidi(midi) : midi };
        this.#bezier = moveBezierHandle(curve, gesture.handle, point);
        break;
      }
      case 'time': {
        const scale = modifiers.fine ? FINE_FACTOR : 1;
        const raw = (this.#current.x - this.#origin.x) * viewport.secondsPerPixel * scale;
        gesture.seconds = this.#quantiseTimeDelta(gesture.blobs, raw, modifiers);
        break;
      }
      case 'shift': {
        const scale = modifiers.fine ? FINE_FACTOR : 1;
        const raw = (this.#current.x - this.#origin.x) * viewport.secondsPerPixel * scale;
        gesture.seconds = clamp(raw, gesture.lower, gesture.upper);
        break;
      }
      case 'contour':
      case 'lift': {
        const scale = modifiers.fine ? FINE_FACTOR : 1;
        if (gesture.horizontal) {
          gesture.seconds = (this.#current.x - this.#origin.x) * viewport.secondsPerPixel * scale;
        } else {
          const raw =
            (viewport.yToMidi(this.#current.y) - viewport.yToMidi(this.#origin.y)) * scale;
          gesture.semitones = modifiers.constrain ? Math.round(raw) : raw;
        }
        break;
      }
      case 'edge': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        const target = this.#snapTime(time, modifiers);
        // Blob mode moves the end the way it moves the start: over the audio, never stretching it.
        if (gesture.edge === 'end' && this.#store.state.editMode === 'blob') {
          gesture.scale = null;
          gesture.sourceTime = Math.max(
            blob.start + MIN_BLOB_SECONDS,
            outputToSource(blob, target),
          );
          break;
        }
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
      case 'clip': {
        // Lands where it is let go, over any clip already there, and only the grid pulls on it.
        // Shift inserts it there instead, moving the clips after it later.
        const wanted = this.#placeTime(time - gesture.grab, modifiers, false);
        gesture.ripple = modifiers.constrain;
        gesture.position = gesture.ripple
          ? rippleInsert(this.#otherSpans(gesture.clip), gesture.duration, wanted).position
          : wanted;
        break;
      }
      case 'reference':
        gesture.position = this.#placeTime(time - gesture.grab, modifiers);
        break;
      case 'rubberBand':
        break;
    }
  }

  #updatePreview(): void {
    const gesture = this.#gesture;
    if (gesture === null) {
      this.#renderer?.setPreview(this.#bezierPreview(null));
      this.render();
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
              ? `${gesture.edge === 'start' ? 'Start' : 'End'} ${formatClock(gesture.sourceTime, 0.001)}`
              : `Stretch ${Math.round(gesture.scale * 100)}%`,
        };
      case 'shift':
        return {
          kind: 'blobShift',
          blobs: gesture.blobs,
          seconds: gesture.seconds,
          label: `Move Blob ${formatMilliseconds(gesture.seconds)}`,
        };
      case 'contour':
      case 'lift':
        return this.#moved
          ? {
              kind: 'lines',
              lines: shiftLines(gesture.lines, gesture.seconds, gesture.semitones),
              label: `Move Pitch ${
                gesture.horizontal
                  ? formatMilliseconds(gesture.seconds)
                  : formatSemitones(gesture.semitones)
              }`,
            }
          : null;
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
      case 'bezierDraw':
        return {
          kind: 'curve',
          points: [gesture.from, gesture.to],
          label: `Bezier ${noteNameWithCents(gesture.to.midi, this.#accidentals())}`,
        };
      case 'bezierHandle':
        return this.#bezierPreview(gesture.handle);
      case 'split':
        return {
          kind: 'split',
          blob: gesture.blob,
          time: gesture.time,
          label: `Split Blob ${formatClock(gesture.time, 0.001)}`,
        };
      case 'clip':
        return this.#moved
          ? {
              kind: 'clipDrag',
              clip: gesture.clip,
              position: gesture.position,
              label: `${gesture.ripple ? 'Insert' : 'Move'} Clip ${formatClock(gesture.position, 0.001)}`,
            }
          : null;
      case 'reference':
        return this.#moved
          ? {
              kind: 'referenceDrag',
              reference: gesture.reference,
              position: gesture.position,
              label: `Move Reference ${formatClock(gesture.position, 0.001)}`,
            }
          : null;
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
            {
              type: 'movePitch',
              blobs: gesture.blobs,
              semitones: gesture.semitones,
            },
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
            // Dragged in heard pitch, stored without the blob's offset.
            midi: gesture.midi - (this.#blob(gesture.blob)?.pitchOffset ?? 0),
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
        this.#commitStroke(simplified, null, 'Draw Curve');
        break;
      }
      case 'bezierDraw':
        // A press that never became a line leaves nothing to shape.
        if (this.#moved && gesture.to.time !== gesture.from.time) {
          this.#bezier = straightBezier(gesture.from, gesture.to);
          this.#announce('Drag handles to shape. Enter to apply, Esc to cancel');
        }
        break;
      case 'bezierHandle':
        break;
      case 'time':
        if (gesture.seconds !== 0) {
          this.#commit(
            { type: 'moveTime', blobs: gesture.blobs, seconds: gesture.seconds },
            `Move Time ${formatMilliseconds(gesture.seconds)}`,
          );
        }
        break;
      case 'shift':
        if (gesture.seconds !== 0) {
          // Slid one at a time from the leading edge, so a blob never meets one of its own set.
          const order = gesture.blobs
            .map((id) => this.#blob(id))
            .filter((blob): blob is Blob => blob !== undefined)
            .sort((a, b) => (gesture.seconds > 0 ? b.start - a.start : a.start - b.start));
          this.#commit(
            grouped(
              order.map((blob): EditOp => ({
                type: 'shiftBlob',
                blob: blob.id,
                seconds: gesture.seconds,
              })),
            ),
            `Move Blob ${formatMilliseconds(gesture.seconds)}`,
          );
        }
        break;
      case 'contour': {
        if (!this.#moved) {
          break;
        }
        const state = this.#store.state;
        const ops = movePitchOps(
          state,
          gesture.ranges,
          gesture.seconds,
          gesture.semitones,
          state.pitchCutFill,
          state.outsidePitch,
        );
        if (ops.length > 0) {
          this.#commit(
            grouped(ops),
            `Move Pitch ${
              gesture.horizontal
                ? formatMilliseconds(gesture.seconds)
                : formatSemitones(gesture.semitones)
            }`,
          );
          // The selection goes with the line, so it names what was just moved.
          if (gesture.horizontal) {
            const ranges = gesture.ranges.map((range) => ({
              start: range.start + gesture.seconds,
              end: range.end + gesture.seconds,
            }));
            this.#setSelection(selectionForRanges(this.#store.state.blobs, ranges));
          }
        }
        break;
      }
      case 'lift': {
        if (!this.#moved || (gesture.seconds === 0 && gesture.semitones === 0)) {
          break;
        }
        const ops = gesture.horizontal
          ? liftRunOps(gesture.run, 0, gesture.seconds)
          : liftRunOps(gesture.run, gesture.semitones, 0);
        this.#commit(
          grouped(ops),
          gesture.horizontal
            ? `Move Time ${formatMilliseconds(gesture.seconds)}`
            : `Move Pitch ${formatSemitones(gesture.semitones)}`,
        );
        break;
      }
      case 'edge': {
        const blob = this.#blob(gesture.blob);
        if (blob === undefined) {
          break;
        }
        if (gesture.edge === 'end' && gesture.scale === null) {
          if (gesture.sourceTime !== blob.end) {
            this.#commit(
              { type: 'moveBoundary', blob: blob.id, edge: 'end', time: gesture.sourceTime },
              `Blob End ${formatClock(gesture.sourceTime, 0.001)}`,
            );
          }
        } else if (gesture.edge === 'start') {
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
      case 'reference':
        if (this.#moved && gesture.position !== gesture.from) {
          this.#commit(
            { type: 'moveReference', reference: gesture.reference, position: gesture.position },
            `Move Reference ${formatClock(gesture.position, 0.001)}`,
          );
        }
        break;
      case 'clip':
        if (this.#moved) {
          if (gesture.position !== gesture.from || gesture.ripple) {
            this.#commit(
              {
                type: 'moveClip',
                clip: gesture.clip,
                position: gesture.position,
                exact: !gesture.ripple,
                ripple: gesture.ripple,
              },
              `Move Clip ${formatClock(gesture.position, 0.001)}`,
            );
          }
        } else {
          // The tab reads as the blob's own header, so a click on it selects the blob beneath.
          // The whole clip is a double-click.
          const blob = this.#blob(gesture.blob);
          if (blob !== undefined) {
            this.#selectRange(
              { start: blobOutputStart(blob), end: blobOutputEnd(blob) },
              gesture.additive,
              gesture.extend,
            );
          }
        }
        break;
      case 'scrub':
      case 'loop':
        break;
    }
    this.#updatePreview();
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

  /** Selects every blob of one clip, which is what a double-click on its title means. */
  #selectClip(clip: number): void {
    const state = this.#store.state;
    const blobs = state.blobs.filter((blob) => clipOf(blob.id) === clip);
    const first = blobs[0];
    if (first === undefined) {
      return;
    }
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const blob of blobs) {
      start = Math.min(start, blobOutputStart(blob));
      end = Math.max(end, blobOutputEnd(blob));
    }
    this.#selectSpan(start, end);
    const entry = state.edits?.clips.find((candidate) => candidate.id === clip);
    if (entry !== undefined) {
      this.#announce(`${displayTitle(entry)} selected`);
    }
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
    if (hit.kind === 'pitchLine') {
      const run = outsideRunAt(this.#store.state, hit.time);
      if (run !== null) {
        this.#selectRange({ start: run.start, end: run.end }, additive, extend);
        return;
      }
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
   * Keeps a line drawn in output seconds whole and lays it over every blob it crosses.
   *
   * @remarks One gesture and one undo step. The line is kept as a curve of its own, gaps and all,
   * so it is drawn, picked up and copied as it was drawn; each blob it crosses is given the part
   * over it and keeps the rest of what it sang. A Bezier keeps its handles, and one reopened for
   * shaping replaces the curve it was opened from.
   */
  #commitStroke(
    points: readonly GesturePoint[],
    bezier: BezierCurve | null,
    message: string,
  ): void {
    const replacing = this.#editing;
    this.#editing = null;
    if (points.length < 2) {
      return;
    }
    const shape: Stroke['bezier'] | null =
      bezier === null ? null : [bezier.from, bezier.c1, bezier.c2, bezier.to];
    const ops = drawStrokeOps(this.#store.state, points, shape, replacing);
    if (ops.length === 0) {
      return;
    }
    this.#commit(grouped(ops), message);
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

  /**
   * Where a clip, a reference or a dropped file is put: the start with Ctrl, and otherwise
   * `seconds` snapped. Never negative.
   *
   * @remarks Without `edges`, only the grid pulls on it, not the edges of the blobs already there.
   * Shift is left to the caller, which inserts a vocal with it.
   */
  #placeTime(seconds: number, modifiers: Modifiers, edges = true): number {
    if (modifiers.snap) return 0;
    if (modifiers.fine) return Math.max(0, seconds);
    const context = edges ? this.#snapContext() : { ...this.#snapContext(), blobs: [] };
    return Math.max(0, snapTime(seconds, context));
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
    return projectEnd(state);
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
    this.#announce('Loop cleared');
  }

  #setSelection(selection: Selection, stroke: number | null = null): void {
    this.#store.update({ selection, activeStroke: stroke });
  }

  /** The kept curve within grabbing distance of a canvas position, the newest first. */
  #strokeAt(viewport: Viewport, x: number, y: number): Stroke | null {
    const strokes = this.#store.state.edits?.strokes ?? [];
    for (let s = strokes.length - 1; s >= 0; s -= 1) {
      const stroke = strokes[s];
      if (stroke === undefined) continue;
      for (let i = 1; i < stroke.points.length; i += 1) {
        const a = stroke.points[i - 1];
        const b = stroke.points[i];
        if (a === undefined || b === undefined) continue;
        const distance = segmentDistance(
          x,
          y,
          viewport.timeToX(a.time),
          viewport.midiToY(a.midi),
          viewport.timeToX(b.time),
          viewport.midiToY(b.midi),
        );
        if (distance <= STROKE_GRIP) return stroke;
      }
    }
    return null;
  }

  /**
   * Picks up a kept curve: a Bezier opens for shaping again, and any curve becomes the selection.
   *
   * @remarks Shaping switches to the Bezier tool, since that is where its handles are dragged.
   */
  #pickStroke(id: number): void {
    const stroke = (this.#store.state.edits?.strokes ?? []).find((entry) => entry.id === id);
    if (stroke === undefined) return;
    this.#keepBezier();
    const span = strokeSpan(stroke);
    this.#setSelection(selectionForRange(this.#store.state.blobs, span), stroke.id);
    if (stroke.bezier !== undefined) {
      if (this.#store.state.tool !== 'bezier') this.#store.update({ tool: 'bezier' });
      const [from, c1, c2, to] = stroke.bezier;
      this.#bezier = { from, c1, c2, to };
      this.#editing = stroke;
      this.#announce('Drag handles to shape. Enter to apply, Delete to delete, Esc to cancel');
    } else {
      this.#announce('Curve selected');
    }
    this.#updatePreview();
  }

  /** Deletes the kept curve being shaped or selected, and what it wrote into the blobs. */
  #deleteStroke(): boolean {
    const state = this.#store.state;
    const id = this.#editing?.id ?? state.activeStroke;
    const stroke = (state.edits?.strokes ?? []).find((entry) => entry.id === id);
    if (stroke === undefined) return false;
    this.#bezier = null;
    this.#editing = null;
    this.#renderer?.setPreview(null);
    this.#commit(grouped(deleteStrokeOps(state, stroke)), 'Curve deleted');
    this.#setSelection(emptySelection());
    return true;
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

  /** The project spans of every clip but `clip`. */
  #otherSpans(clip: number): [number, number][] {
    return (this.#store.state.edits?.clips ?? [])
      .filter((entry) => entry.id !== clip)
      .map((entry): [number, number] => [clipStart(entry), clipEnd(entry)]);
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
    this.#canvas.style.cursor =
      hit === null ? 'default' : cursorFor(tool, hit, this.#store.state.editMode);
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
    this.#updatePreview();
  }

  /** Which handle of the curve being shaped lies under a canvas position, if any. */
  #bezierHandleAt(point: Point): BezierHandle | null {
    const curve = this.#bezier;
    if (curve === null || this.#store.state.tool !== 'bezier') {
      return null;
    }
    const viewport = this.viewport;
    let best: BezierHandle | null = null;
    let bestDistance = BEZIER_HANDLE_RADIUS;
    // Controls first, so a control resting on its own end is still reachable.
    for (const handle of ['c1', 'c2', 'from', 'to'] as const) {
      const at = curve[handle];
      const distance = Math.hypot(
        viewport.timeToX(at.time) - point.x,
        viewport.midiToY(at.midi) - point.y,
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        best = handle;
      }
    }
    return best;
  }

  #bezierPreview(active: BezierHandle | null): EditorPreview | null {
    const curve = this.#bezier;
    if (curve === null) {
      return null;
    }
    return {
      kind: 'bezier',
      curve,
      points: sampleBezier(curve, this.#bezierSamples(curve)),
      active,
      label: `Bezier ${noteNameWithCents(curve.to.midi, this.#accidentals())}  Enter Apply  Esc Cancel`,
    };
  }

  /** Samples a curve at roughly one point per few pixels of its length on screen. */
  #bezierSamples(curve: BezierCurve): number {
    const viewport = this.viewport;
    const points = [curve.from, curve.c1, curve.c2, curve.to];
    let length = 0;
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1];
      const b = points[i];
      if (a === undefined || b === undefined) continue;
      length += Math.hypot(
        viewport.timeToX(b.time) - viewport.timeToX(a.time),
        viewport.midiToY(b.midi) - viewport.midiToY(a.midi),
      );
    }
    return Math.min(BEZIER_MAX_SAMPLES, Math.max(8, Math.ceil(length / BEZIER_SAMPLE_PIXELS)));
  }

  /** Commits the curve being shaped, as one stroke over every blob it crosses. */
  #keepBezier(): void {
    const curve = this.#bezier;
    if (curve === null) {
      return;
    }
    this.#bezier = null;
    this.#renderer?.setPreview(null);
    // A curve reopened and let go untouched changes nothing, so it leaves no history.
    const before = this.#editing?.bezier;
    if (
      before !== undefined &&
      [curve.from, curve.c1, curve.c2, curve.to].every(
        (point, index) => point.time === before[index]?.time && point.midi === before[index]?.midi,
      )
    ) {
      this.#editing = null;
      this.render();
      return;
    }
    const viewport = this.viewport;
    // Reduced the way a pen stroke is, so the curve keeps its shape in a handful of points
    // rather than one per sample, but finely enough to stay smooth between them.
    const points = simplifyGesture(
      sampleBezier(curve, this.#bezierSamples(curve)),
      viewport.secondsPerPixel / 2,
      viewport.semitonesPerPixel / 2,
    );
    this.#commitStroke(
      points,
      curve,
      `Draw Bezier ${noteNameWithCents(curve.to.midi, this.#accidentals())}`,
    );
    this.render();
  }

  /** Throws away the curve being shaped. */
  #dropBezier(): void {
    if (this.#bezier === null) {
      return;
    }
    this.#bezier = null;
    this.#editing = null;
    this.#renderer?.setPreview(null);
    this.#announce('Curve discarded');
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

/** A gesture with no modifier held. */
const NO_MODIFIERS: Modifiers = { constrain: false, fine: false, snap: false };

/** One edit when there is one, and one group when there are several. */
function grouped(ops: readonly EditOp[]): EditOp {
  return ops.length === 1 && ops[0] !== undefined ? ops[0] : { type: 'group', ops: [...ops] };
}

/** Distance in pixels from a point to a segment. */
function segmentDistance(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : clamp(((x - x0) * dx + (y - y0) * dy) / length, 0, 1);
  return Math.hypot(x - (x0 + dx * t), y - (y0 + dy * t));
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
