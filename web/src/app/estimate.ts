// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Estimates of a vocal's tempo, meter, first beat and key, read from its blobs.
 *
 * The blobs are the only evidence: where each note starts, how long it lasts and what pitch it
 * sits at. That is enough to propose a starting point for the project's settings, and every figure
 * it proposes stays an ordinary setting the user can correct.
 */

import type { Blob, EditOp, EditState, ScaleSettings } from '../core/types.js';

/** A vocal's timing as far as its note starts show it. */
export interface TimingEstimate {
  bpm: number;
  /** Beats in a bar, 3 or 4. */
  beatsPerBar: number;
  /** Seconds from project zero to the first beat at or after it. */
  offset: number;
  /** Beat of the bar that first beat is, from 1. */
  beat: number;
}

/** A vocal's key as its pitch classes show it. */
export interface KeyEstimate {
  /** Pitch class of the tonic, 0 for C. */
  root: number;
  minor: boolean;
}

/** Slowest and fastest tempo proposed, in beats per minute. */
const MIN_BPM = 60;
const MAX_BPM = 180;

/** Tempo the search leans towards when two candidates fit the notes equally well. */
const PREFERRED_BPM = 100;

/** Fewest note starts a tempo is estimated from. */
const MIN_ONSETS = 8;

/** Fewest notes a key is estimated from. */
const MIN_NOTES = 3;

/** How much better three beats to the bar has to fit than four before it is proposed. */
const TRIPLE_MARGIN = 1.1;

/** Krumhansl and Kessler's major and minor key profiles, from the tonic up. */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** Scale degrees of the major and natural minor scales. */
export const MAJOR_DEGREES: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_DEGREES: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

interface Onset {
  time: number;
  /** How strongly the note marks its beat: its length, which a held note on a strong beat has. */
  weight: number;
}

function onsetsOf(blobs: readonly Blob[]): Onset[] {
  return blobs
    .map((blob) => ({
      time: blob.start + blob.timeOffset,
      weight: Math.max(0.01, (blob.end - blob.start) * blob.timeScale),
    }))
    .filter((onset) => Number.isFinite(onset.time))
    .sort((a, b) => a.time - b.time);
}

/**
 * How well a beat period fits the onsets, and where its beats fall.
 *
 * @remarks The weighted mean of each onset's position within the period, taken round a circle:
 * a length of 1 when every onset lands on one phase of the period and near 0 when they scatter.
 */
function fit(onsets: readonly Onset[], period: number): { strength: number; phase: number } {
  let x = 0;
  let y = 0;
  let total = 0;
  for (const onset of onsets) {
    const angle = (2 * Math.PI * onset.time) / period;
    x += onset.weight * Math.cos(angle);
    y += onset.weight * Math.sin(angle);
    total += onset.weight;
  }
  const raw = ((((Math.atan2(y, x) / (2 * Math.PI)) * period) % period) + period) % period;
  // A beat a rounding error before zero is the beat at zero, not one a whole period later.
  const phase = period - raw < 1e-6 ? 0 : raw;
  return { strength: total > 0 ? Math.hypot(x, y) / total : 0, phase };
}

/**
 * The tempo, meter and first beat the blobs' starts fit best, or `null` for too few notes.
 *
 * @remarks Every period between {@link MIN_BPM} and {@link MAX_BPM} is tried. A period half as long
 * fits every onset a period fits, so the fit is weighed against a preference for moderate tempos.
 * The downbeat is the beat of the bar whose notes are held longest on average.
 */
export function estimateTiming(blobs: readonly Blob[]): TimingEstimate | null {
  const onsets = onsetsOf(blobs);
  if (onsets.length < MIN_ONSETS) return null;

  let best = { score: -1, bpm: PREFERRED_BPM, phase: 0 };
  for (let bpm = MIN_BPM; bpm <= MAX_BPM; bpm += 0.25) {
    const { strength, phase } = fit(onsets, 60 / bpm);
    const lean = Math.log2(bpm / PREFERRED_BPM);
    const score = strength * Math.exp(-0.5 * lean * lean);
    if (score > best.score) best = { score, bpm, phase };
  }
  const period = 60 / best.bpm;

  // The index of the beat each onset is nearest, counted from the first beat at or after zero.
  const indexOf = (time: number): number => Math.round((time - best.phase) / period);
  const accent = (beatsPerBar: number): { ratio: number; downbeat: number } => {
    const sums = new Array<number>(beatsPerBar).fill(0);
    const counts = new Array<number>(beatsPerBar).fill(0);
    for (const onset of onsets) {
      const slot = ((indexOf(onset.time) % beatsPerBar) + beatsPerBar) % beatsPerBar;
      sums[slot] = (sums[slot] ?? 0) + onset.weight;
      counts[slot] = (counts[slot] ?? 0) + 1;
    }
    const means = sums.map((sum, slot) => sum / Math.max(1, counts[slot] ?? 0));
    const average = means.reduce((a, b) => a + b, 0) / beatsPerBar;
    let downbeat = 0;
    for (let slot = 1; slot < beatsPerBar; slot += 1) {
      if ((means[slot] ?? 0) > (means[downbeat] ?? 0)) downbeat = slot;
    }
    return { ratio: average > 0 ? (means[downbeat] ?? 0) / average : 1, downbeat };
  };
  const four = accent(4);
  const three = accent(3);
  const triple = three.ratio > four.ratio * TRIPLE_MARGIN;
  const beatsPerBar = triple ? 3 : 4;
  const { downbeat } = triple ? three : four;

  return {
    bpm: Math.round(best.bpm * 10) / 10,
    beatsPerBar,
    offset: best.phase,
    // Beat index 0 is the first beat; the downbeat is the slot counted as beat 1.
    beat: ((beatsPerBar - downbeat) % beatsPerBar) + 1,
  };
}

/**
 * The key whose profile best matches how long each pitch class is sung, or `null` for too few
 * notes.
 */
export function estimateKey(blobs: readonly Blob[]): KeyEstimate | null {
  const weights = new Array<number>(12).fill(0);
  let notes = 0;
  for (const blob of blobs) {
    if (!Number.isFinite(blob.detectedCenter)) continue;
    const pitchClass = ((Math.round(blob.detectedCenter) % 12) + 12) % 12;
    weights[pitchClass] = (weights[pitchClass] ?? 0) + Math.max(0, blob.end - blob.start);
    notes += 1;
  }
  if (notes < MIN_NOTES) return null;
  let best: KeyEstimate & { score: number } = { root: 0, minor: false, score: -Infinity };
  for (let root = 0; root < 12; root += 1) {
    for (const minor of [false, true]) {
      const profile = minor ? MINOR_PROFILE : MAJOR_PROFILE;
      const score = correlation(
        weights,
        profile.map((_, index) => profile[(index - root + 12) % 12] ?? 0),
      );
      if (score > best.score) best = { root, minor, score };
    }
  }
  return { root: best.root, minor: best.minor };
}

function correlation(a: readonly number[], b: readonly number[]): number {
  const meanA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const meanB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let top = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = (a[index] ?? 0) - meanA;
    const db = (b[index] ?? 0) - meanB;
    top += da * db;
    left += da * da;
    right += db * db;
  }
  return left > 0 && right > 0 ? top / Math.sqrt(left * right) : 0;
}

/** What {@link estimateEdits} proposes, as edits and as the settings they amount to. */
export interface Estimate {
  ops: EditOp[];
  timing: TimingEstimate | null;
  key: KeyEstimate | null;
}

/**
 * The edits that set the project's tempo, meter, first beat and key from its blobs.
 *
 * @remarks Replaces the tempo and meter maps with one tempo and one meter. The key is set as the
 * scale's root and degrees with its strength and exclusions kept, so an estimate never changes
 * what is heard.
 */
export function estimateEdits(blobs: readonly Blob[], edits: EditState): Estimate {
  const timing = estimateTiming(blobs);
  const key = estimateKey(blobs);
  const ops: EditOp[] = [];
  if (timing !== null) {
    const denominator = 4;
    ops.push(
      {
        type: 'setTempoMap',
        events: [{ tick: 0, microsPerQuarter: Math.round(60_000_000 / timing.bpm) }],
      },
      { type: 'setMeterMap', events: [{ tick: 0, numerator: timing.beatsPerBar, denominator }] },
      { type: 'setTimelineOrigin', seconds: timing.offset - (timing.beat - 1) * (60 / timing.bpm) },
    );
  }
  if (key !== null) {
    const scale: ScaleSettings = {
      ...edits.scale,
      root: key.root,
      degrees: [...(key.minor ? MINOR_DEGREES : MAJOR_DEGREES)],
    };
    ops.push({ type: 'setScale', scale });
  }
  return { ops, timing, key };
}
