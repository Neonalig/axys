// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FollowMode } from '../app/store.js';
import type {
  BarBeat,
  BeatGridPoint,
  MeterEvent,
  TempoEvent,
  TimelineMap,
  ViewState,
} from '../core/types.js';

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
const DEFAULT_MICROS_PER_QUARTER = 500_000;
const MAX_GRID_POINTS = 4096;

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
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

  constructor(width: number, height: number, view: ViewState) {
    this.width = Math.max(1, width);
    this.height = Math.max(RULER_HEIGHT + 1, height);
    this.view = view;
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
    return new Viewport(this.width, this.height, view);
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

/** Tempo in force at a tick. */
export function tempoAt(timeline: TimelineMap, tick: number): TempoEvent {
  let current: TempoEvent = { tick: 0, microsPerQuarter: DEFAULT_MICROS_PER_QUARTER };
  for (const event of timeline.tempo) {
    if (event.tick > tick && event.tick > 0) {
      break;
    }
    current = event;
  }
  return current;
}

/** Meter in force at a tick. */
export function meterAt(timeline: TimelineMap, tick: number): MeterEvent {
  let current: MeterEvent = { tick: 0, numerator: 4, denominator: 4 };
  for (const event of timeline.meter) {
    if (event.tick > tick && event.tick > 0) {
      break;
    }
    current = event;
  }
  return current;
}

/** Tempo in beats per minute at a tick. */
export function bpmAt(timeline: TimelineMap, tick: number): number {
  return 60_000_000 / Math.max(1, tempoAt(timeline, tick).microsPerQuarter);
}

function musicalSeconds(timeline: TimelineMap, tick: number): number {
  const ppq = timeline.ppq > 0 ? timeline.ppq : 480;
  let seconds = 0;
  let cursor = 0;
  let micros = DEFAULT_MICROS_PER_QUARTER;
  for (const event of timeline.tempo) {
    if (event.tick >= tick && event.tick > 0) {
      break;
    }
    const at = Math.max(event.tick, 0);
    if (at > cursor) {
      seconds += ((at - cursor) / ppq) * (micros / 1e6);
      cursor = at;
    }
    micros = event.microsPerQuarter;
  }
  return seconds + ((tick - cursor) / ppq) * (micros / 1e6);
}

function musicalTick(timeline: TimelineMap, seconds: number): number {
  const ppq = timeline.ppq > 0 ? timeline.ppq : 480;
  let elapsed = 0;
  let cursor = 0;
  let micros = DEFAULT_MICROS_PER_QUARTER;
  for (const event of timeline.tempo) {
    if (event.tick > cursor) {
      const span = ((event.tick - cursor) / ppq) * (micros / 1e6);
      if (elapsed + span > seconds) {
        return cursor + (((seconds - elapsed) * 1e6) / micros) * ppq;
      }
      elapsed += span;
      cursor = event.tick;
    }
    micros = event.microsPerQuarter;
  }
  return cursor + (((seconds - elapsed) * 1e6) / micros) * ppq;
}

/** Source seconds of a musical tick, including the timeline origin. */
export function tickToSeconds(timeline: TimelineMap, tick: number): number {
  return timeline.originSeconds + musicalSeconds(timeline, tick);
}

/** Musical tick at a source time. */
export function secondsToTick(timeline: TimelineMap, seconds: number): number {
  return musicalTick(timeline, seconds - timeline.originSeconds);
}

interface MeterSegment {
  anchorTick: number;
  endTick: number;
  bar: number;
  barTicks: number;
  beatTicks: number;
  numerator: number;
  denominator: number;
}

function meterSegments(timeline: TimelineMap): MeterSegment[] {
  const ppq = timeline.ppq > 0 ? timeline.ppq : 480;
  const events =
    timeline.meter.length > 0 ? timeline.meter : [{ tick: 0, numerator: 4, denominator: 4 }];
  const segments: MeterSegment[] = [];
  let bar = 1;
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) {
      continue;
    }
    const numerator = Math.max(1, event.numerator);
    const denominator = Math.max(1, event.denominator);
    const beatTicks = (ppq * 4) / denominator;
    const barTicks = beatTicks * numerator;
    const anchorTick = Math.max(0, event.tick);
    const next = events[i + 1];
    const endTick = next === undefined ? Number.POSITIVE_INFINITY : Math.max(anchorTick, next.tick);
    segments.push({ anchorTick, endTick, bar, barTicks, beatTicks, numerator, denominator });
    if (Number.isFinite(endTick)) {
      bar += Math.ceil((endTick - anchorTick) / barTicks);
    }
  }
  return segments;
}

function segmentAt(segments: MeterSegment[], tick: number): MeterSegment {
  let current = segments[0] ?? {
    anchorTick: 0,
    endTick: Number.POSITIVE_INFINITY,
    bar: 1,
    barTicks: 1920,
    beatTicks: 480,
    numerator: 4,
    denominator: 4,
  };
  for (const segment of segments) {
    if (segment.anchorTick > tick) {
      break;
    }
    current = segment;
  }
  return current;
}

/** Bar and beat reading at a source time. */
export function barBeatAt(timeline: TimelineMap, seconds: number): BarBeat {
  const segments = meterSegments(timeline);
  const tick = secondsToTick(timeline, seconds);
  const segment = segmentAt(segments, tick);
  const local = tick - segment.anchorTick;
  const bars = Math.floor(local / segment.barTicks);
  const withinBar = local - bars * segment.barTicks;
  return {
    bar: segment.bar + bars,
    beat: withinBar / segment.beatTicks + 1,
    beatsInBar: segment.numerator,
    beatUnit: segment.denominator,
  };
}

/**
 * Bar lines and beat subdivisions covering a time window.
 *
 * @remarks `division` counts subdivisions per beat, so 1 yields beats and 2 yields eighths of a
 * quarter-note beat. The result is capped so an extreme zoom-out cannot stall a frame.
 */
export function beatGrid(
  timeline: TimelineMap,
  from: number,
  to: number,
  division: number,
): BeatGridPoint[] {
  const points: BeatGridPoint[] = [];
  if (!(to > from)) {
    return points;
  }
  const steps = Math.max(1, Math.floor(division));
  const segments = meterSegments(timeline);
  const fromTick = secondsToTick(timeline, from);
  const toTick = secondsToTick(timeline, to);
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    if (segment === undefined) {
      continue;
    }
    const lower = i === 0 ? Number.NEGATIVE_INFINITY : segment.anchorTick;
    const upper = segment.endTick;
    if (upper <= fromTick || lower >= toTick) {
      continue;
    }
    const step = segment.beatTicks / steps;
    const first = Math.ceil((Math.max(fromTick, lower) - segment.anchorTick) / step);
    const bound = Number.isFinite(upper) ? Math.min(toTick, upper - 1e-9) : toTick;
    const last = Math.floor((bound - segment.anchorTick) / step);
    for (let k = first; k <= last; k += 1) {
      const tick = segment.anchorTick + k * step;
      const local = tick - segment.anchorTick;
      const bars = Math.floor(local / segment.barTicks);
      const withinBar = local - bars * segment.barTicks;
      points.push({
        seconds: tickToSeconds(timeline, tick),
        tick,
        bar: segment.bar + bars,
        beat: withinBar / segment.beatTicks + 1,
        isBarLine: Math.abs(withinBar) < 1e-6,
        isBeat: Math.abs(withinBar % segment.beatTicks) < 1e-6,
      });
      if (points.length >= MAX_GRID_POINTS) {
        return points;
      }
    }
  }
  return points;
}

/** Whether a timeline carries more than the default single tempo and meter. */
export function hasMusicalDetail(timeline: TimelineMap): boolean {
  return timeline.tempo.length > 1 || timeline.meter.length > 1;
}
