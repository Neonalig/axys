// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Musical time: ticks, seconds, tempo, meter, bars and beats.
 *
 * @remarks Mirrors the contract `timeline.rs` implements, so the ruler and the click can be drawn
 * and scheduled without a WebAssembly call per frame. The core stays the authority for snapping,
 * where exactness matters more than frame cost.
 */

import type { BarBeat, BeatGridPoint, MeterEvent, TempoEvent, TimelineMap } from './types.js';

const DEFAULT_MICROS_PER_QUARTER = 500_000;
const DEFAULT_PPQ = 480;
const MAX_GRID_POINTS = 4096;

/** Pulses per quarter note, falling back to the MIDI default for a timeline that declares none. */
export function ppqOf(timeline: TimelineMap): number {
  return timeline.ppq > 0 ? timeline.ppq : DEFAULT_PPQ;
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

/** Seconds the first beat lasts, at the tempo and meter in force at tick 0. */
export function firstBeatSeconds(timeline: TimelineMap): number {
  const meter = meterAt(timeline, 0);
  const beatTicks = (ppqOf(timeline) * 4) / Math.max(1, meter.denominator);
  return tickToSeconds(timeline, beatTicks) - tickToSeconds(timeline, 0);
}

/** Where the metronome's count starts against project zero. */
export interface StartPosition {
  /** Beat of the bar the first beat at or after zero is, from 1. */
  beat: number;
  /** Seconds from zero to that beat, less than one beat. */
  offset: number;
}

/**
 * The first beat at or after project zero, as its beat of the bar and when it falls.
 *
 * @remarks Read from the timeline origin at the tempo and meter of tick 0, which is where the
 * count starts.
 */
export function startPosition(timeline: TimelineMap): StartPosition {
  const beat = firstBeatSeconds(timeline);
  const beats = Math.max(1, meterAt(timeline, 0).numerator);
  if (!(beat > 0)) return { beat: 1, offset: 0 };
  const origin = timeline.originSeconds;
  const first = Math.ceil(-origin / beat - 1e-6);
  return {
    beat: (((first % beats) + beats) % beats) + 1,
    offset: Math.max(0, origin + first * beat),
  };
}

/** The timeline origin that puts beat `beat` of a bar `offset` seconds after project zero. */
export function originFor(timeline: TimelineMap, beat: number, offset: number): number {
  return offset - (beat - 1) * firstBeatSeconds(timeline);
}

/** Seconds one bar lasts from a source time, at the tempo and meter in force there. */
export function barSecondsAt(timeline: TimelineMap, seconds: number): number {
  const tick = secondsToTick(timeline, seconds);
  const meter = meterAt(timeline, tick);
  const barTicks =
    ((ppqOf(timeline) * 4) / Math.max(1, meter.denominator)) * Math.max(1, meter.numerator);
  return tickToSeconds(timeline, tick + barTicks) - seconds;
}

/** Tempo in beats per minute at a tick. */
export function bpmAt(timeline: TimelineMap, tick: number): number {
  return 60_000_000 / Math.max(1, tempoAt(timeline, tick).microsPerQuarter);
}

function musicalSeconds(timeline: TimelineMap, tick: number): number {
  const ppq = ppqOf(timeline);
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
  const ppq = ppqOf(timeline);
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
  const ppq = ppqOf(timeline);
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
