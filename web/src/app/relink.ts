// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * How a candidate file compares with the source audio a project recorded.
 *
 * A fingerprint digests decoded PCM, and two browsers decode the same file a few bits apart, so
 * a file whose name and length both match is taken as the same audio from another decoder.
 */

import type { SourceInfo } from '../core/types.js';

/**
 * How a candidate compares with a recorded source.
 *
 * @remarks `exact` has the recorded fingerprint. `same` has the recorded name and length, which
 * is the same file decoded elsewhere. `different` is anything else, and is only taken once the
 * user confirms it.
 */
export type RelinkMatch = 'exact' | 'same' | 'different';

/** What a candidate is compared on. */
export interface RelinkCandidate {
  name: string;
  frames: number;
  fingerprint: string;
}

/** How `candidate` compares with `source`. */
export function relinkMatch(candidate: RelinkCandidate, source: SourceInfo): RelinkMatch {
  if (candidate.fingerprint === source.fingerprint) return 'exact';
  if (candidate.frames === source.frames && sameName(candidate.name, source.name)) return 'same';
  return 'different';
}

/** Whether two file names are the same, ignoring case. */
export function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

/**
 * The index of the source a candidate most likely stands for.
 *
 * @remarks Prefers a matching fingerprint, then a matching name, then the nearest length. `-1`
 * for an empty list.
 */
export function likeliestSource(
  candidate: RelinkCandidate,
  sources: readonly SourceInfo[],
): number {
  const rank = (source: SourceInfo): number => {
    const match = relinkMatch(candidate, source);
    if (match !== 'different') return match === 'exact' ? 0 : 1;
    return sameName(candidate.name, source.name) ? 2 : 3;
  };
  let best = -1;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const current = best < 0 ? undefined : sources[best];
    if (source === undefined) continue;
    if (current === undefined) {
      best = index;
      continue;
    }
    const byRank = rank(source) - rank(current);
    const byLength =
      Math.abs(source.frames - candidate.frames) - Math.abs(current.frames - candidate.frames);
    if (byRank < 0 || (byRank === 0 && byLength < 0)) best = index;
  }
  return best;
}

/**
 * A buffer exactly `frames` long: `samples` cut short, or followed by silence.
 *
 * @remarks Returns a fresh buffer either way, so the caller may transfer it.
 */
export function fitFrames(samples: Float32Array, frames: number): Float32Array {
  const fitted = new Float32Array(frames);
  fitted.set(samples.subarray(0, Math.min(frames, samples.length)));
  return fitted;
}
