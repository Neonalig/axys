// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FollowMode } from '../app/store.js';
import type { ViewState } from '../core/types.js';

/** Height in CSS pixels of the timeline ruler band across the top of the canvas. */
export const RULER_HEIGHT = 28;

/** Width in CSS pixels reserved at the left edge for pitch-row labels. */
export const PITCH_LABEL_GUTTER = 46;

/** Shortest visible time span, in seconds. */
export const MIN_TIME_SPAN = 0.02;

/** Longest visible time span, in seconds. */
export const MAX_TIME_SPAN = 7200;

/** Shortest visible pitch range, in semitones. */
export const MIN_PITCH_RANGE = 2;

/** Longest visible pitch range, in semitones. */
export const MAX_PITCH_RANGE = 96;

const MIN_MIDI = 0;
const MAX_MIDI = 127;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Device pixels per CSS pixel, or 1 where there is no display to ask. */
export function displayRatio(): number {
  return Math.max(1, globalThis.devicePixelRatio || 1);
}

/**
 * Maps between screen pixels and the time and pitch domain.
 *
 * @remarks Immutable. The zoom and pan methods return a new {@link ViewState} for the store to
 * adopt rather than mutating this instance. Time occupies the full canvas width; pitch occupies
 * the canvas below the ruler band.
 */
export class Viewport {
  readonly width: number;
  readonly height: number;
  readonly view: ViewState;
  /**
   * Device pixels per CSS pixel, for {@link crisp}.
   *
   * @remarks Defaults to 1 so a viewport built for a measurement, rather than for a frame, needs
   * no display to ask.
   */
  readonly ratio: number;

  constructor(width: number, height: number, view: ViewState, ratio = 1) {
    this.width = Math.max(1, width);
    this.height = Math.max(RULER_HEIGHT + 1, height);
    this.view = view;
    this.ratio = Math.max(1, ratio);
  }

  /**
   * A coordinate moved to where a line drawn there lands on whole device pixels.
   *
   * @remarks The canvas is scaled by the device pixel ratio and every layer draws in CSS pixels,
   * so the usual `Math.round(x) + 0.5` lands on a CSS-pixel centre, which is not a device-pixel
   * centre at any ratio but 1. At 125 and 150 percent scaling that blurs every grid line, every
   * ruler tick and every blob bound.
   *
   * `width` is the line's CSS width, because where the centre belongs depends on it: a line an
   * odd number of device pixels wide is centred on a half pixel, an even one on a whole pixel.
   * Pair it with {@link crispWidth}, which is what rounds that width to whole device pixels.
   */
  crisp(value: number, width = 1): number {
    const device = this.#deviceWidth(width);
    const offset = device % 2 === 1 ? 0.5 : 0;
    return (Math.round(value * this.ratio) + offset) / this.ratio;
  }

  /**
   * A line width in CSS pixels rounded to a whole number of device pixels, at least one.
   *
   * @remarks A fractional device width is drawn as a blurred band whatever its centre is on. At
   * a ratio of 1 or 2 this returns the width unchanged; at 1.25 a one-pixel rule becomes one
   * device pixel rather than one and a quarter.
   */
  crispWidth(width = 1): number {
    return this.#deviceWidth(width) / this.ratio;
  }

  #deviceWidth(width: number): number {
    return Math.max(1, Math.round(width * this.ratio));
  }

  /** Top edge of the pitch area, below the ruler band. */
  get plotTop(): number {
    return RULER_HEIGHT;
  }

  /** Height of the pitch area in CSS pixels. */
  get plotHeight(): number {
    return this.height - RULER_HEIGHT;
  }

  /** Visible time span in seconds. */
  get timeSpan(): number {
    return Math.max(MIN_TIME_SPAN, this.view.visibleEnd - this.view.visibleStart);
  }

  /** Visible pitch range in semitones. */
  get pitchRange(): number {
    return Math.max(MIN_PITCH_RANGE, this.view.highMidi - this.view.lowMidi);
  }

  get secondsPerPixel(): number {
    return this.timeSpan / this.width;
  }

  /** Semitones covered by one vertical pixel. */
  get semitonesPerPixel(): number {
    return this.pitchRange / this.plotHeight;
  }

  timeToX(seconds: number): number {
    return ((seconds - this.view.visibleStart) / this.timeSpan) * this.width;
  }

  xToTime(x: number): number {
    return this.view.visibleStart + (x / this.width) * this.timeSpan;
  }

  midiToY(midi: number): number {
    return this.plotTop + ((this.view.highMidi - midi) / this.pitchRange) * this.plotHeight;
  }

  yToMidi(y: number): number {
    return this.view.highMidi - ((y - this.plotTop) / this.plotHeight) * this.pitchRange;
  }

  /** Same viewport geometry against a different view state. */
  withView(view: ViewState): Viewport {
    return new Viewport(this.width, this.height, view, this.ratio);
  }

  /**
   * Zooms about a fixed screen point so the point under the cursor stays put.
   *
   * @remarks A factor above 1 zooms in.
   */
  zoomTime(factor: number, anchorX: number): ViewState {
    if (!Number.isFinite(factor) || factor <= 0) {
      return this.view;
    }
    const anchorTime = this.xToTime(anchorX);
    const span = clamp(this.timeSpan / factor, MIN_TIME_SPAN, MAX_TIME_SPAN);
    const fraction = clamp(anchorX / this.width, 0, 1);
    const start = anchorTime - fraction * span;
    return { ...this.view, visibleStart: start, visibleEnd: start + span };
  }

  /** Zooms the pitch axis about a fixed screen point. */
  zoomPitch(factor: number, anchorY: number): ViewState {
    if (!Number.isFinite(factor) || factor <= 0) {
      return this.view;
    }
    const anchorMidi = this.yToMidi(anchorY);
    const range = clamp(this.pitchRange / factor, MIN_PITCH_RANGE, MAX_PITCH_RANGE);
    const fraction = clamp((this.plotTop + this.plotHeight - anchorY) / this.plotHeight, 0, 1);
    return withPitchWindow(this.view, anchorMidi - fraction * range, range);
  }

  /**
   * Scrolls the view by a pixel delta.
   *
   * @remarks Positive `dx` moves the view later in time, positive `dy` moves it toward lower
   * notes, matching the direction the content appears to travel under a scroll gesture.
   */
  pan(dx: number, dy: number): ViewState {
    const seconds = dx * this.secondsPerPixel;
    const semitones = dy * this.semitonesPerPixel;
    const panned: ViewState = {
      ...this.view,
      visibleStart: this.view.visibleStart + seconds,
      visibleEnd: this.view.visibleEnd + seconds,
    };
    return withPitchWindow(panned, this.view.lowMidi - semitones, this.pitchRange);
  }
}

function withPitchWindow(view: ViewState, low: number, range: number): ViewState {
  const span = clamp(range, MIN_PITCH_RANGE, MAX_PITCH_RANGE);
  const lowMidi = clamp(low, MIN_MIDI, MAX_MIDI - span);
  return { ...view, lowMidi, highMidi: lowMidi + span };
}

/** Fraction of the visible span a followed playhead is placed at. */
const FOLLOW_ANCHOR = 0.15;

/** Fraction of the visible span a followed playhead may reach before the view moves again. */
const FOLLOW_EDGE = 0.85;

/** True when a time sits inside a view's visible span. */
export function isVisible(view: ViewState, seconds: number): boolean {
  return seconds >= view.visibleStart && seconds <= view.visibleEnd;
}

/** Scrolls a view so a time sits at the position a followed playhead is held at. */
export function snapViewTo(view: ViewState, seconds: number): ViewState {
  const span = Math.max(MIN_TIME_SPAN, view.visibleEnd - view.visibleStart);
  const start = seconds - FOLLOW_ANCHOR * span;
  return { ...view, visibleStart: start, visibleEnd: start + span };
}

/**
 * Scrolls a view so a moving playhead stays in sight.
 *
 * @remarks `null` when the view already sits where the mode wants it. Only the time axis moves.
 */
export function followView(view: ViewState, playhead: number, mode: FollowMode): ViewState | null {
  const span = Math.max(MIN_TIME_SPAN, view.visibleEnd - view.visibleStart);
  if (mode === 'centre') {
    const start = playhead - span / 2;
    return Math.abs(start - view.visibleStart) < span * 1e-4
      ? null
      : { ...view, visibleStart: start, visibleEnd: start + span };
  }
  const offset = (playhead - view.visibleStart) / span;
  if (offset >= 0 && offset <= FOLLOW_EDGE) {
    return null;
  }
  return snapViewTo(view, playhead);
}

/**
 * Frames a view on a time and pitch extent with a margin.
 *
 * @remarks Used by Zoom Fit and by the first paint after analysis.
 */
export function fitView(
  view: ViewState,
  start: number,
  end: number,
  lowMidi: number,
  highMidi: number,
): ViewState {
  const span = clamp((end - start) * 1.04, MIN_TIME_SPAN, MAX_TIME_SPAN);
  const centre = (start + end) / 2;
  const range = clamp(highMidi - lowMidi + 4, MIN_PITCH_RANGE, MAX_PITCH_RANGE);
  const framed: ViewState = {
    ...view,
    visibleStart: centre - span / 2,
    visibleEnd: centre + span / 2,
  };
  return withPitchWindow(framed, (lowMidi + highMidi) / 2 - range / 2, range);
}
