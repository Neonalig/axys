// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Vocal sources that sound at once.
 *
 * Clips may overlap. The editor edits one layer of them at a time: the active clip and every clip
 * that sits beside it without overlapping, whose blobs are still one ordered set. Every other clip
 * is an other source, drawn behind the layer from its own blobs, track and plan.
 */

import type {
  Blob,
  Clip,
  ClipId,
  EditState,
  OthersView,
  PitchTrackArrays,
  RenderPlan,
} from '../core/types.js';
import { clipOf, displayTitle } from '../core/types.js';

/** A clip outside the editor's layer, placed in project seconds for drawing. */
export interface OtherSource {
  clip: ClipId;
  blobs: Blob[];
  track: PitchTrackArrays | null;
  plan: RenderPlan | null;
}

/**
 * A clip's detected pitch moved to where the clip sits.
 *
 * @remarks Material deleted with its blobs reads as unvoiced, because it is silent.
 */
export function placeTrack(track: PitchTrackArrays, clip: Clip): PitchTrackArrays {
  const times = new Float32Array(track.times.length);
  const midi = new Float32Array(track.midi);
  for (let index = 0; index < times.length; index += 1) {
    const time = track.times[index] ?? 0;
    times[index] = time + clip.position;
    if (clip.silenced.some((span) => time >= span.start && time <= span.end)) {
      midi[index] = Number.NaN;
    }
  }
  return { times, midi, confidence: track.confidence, rms: track.rms };
}

/** A clip's plan moved to where the clip sits, for drawing its target pitch. */
export function placePlan(plan: RenderPlan, position: number): RenderPlan {
  const shift = <T extends { start: number }>(curve: T): T => ({
    ...curve,
    start: curve.start + position,
  });
  return {
    ...plan,
    timeMap: {
      points: plan.timeMap.points.map(([out, source]) => [out + position, source + position]),
    },
    pitchRatio: shift(plan.pitchRatio),
    targetMidi: shift(plan.targetMidi),
    gain: shift(plan.gain),
  };
}

/** Every clip outside `layer`, in the order the project holds them. */
export function otherSources(
  edits: EditState,
  layer: readonly ClipId[],
  blobs: readonly Blob[],
  track: (clip: Clip) => PitchTrackArrays | null,
  plan: (clip: Clip) => RenderPlan | null,
): OtherSource[] {
  return edits.clips
    .filter((clip) => !layer.includes(clip.id))
    .map((clip) => ({
      clip: clip.id,
      blobs: blobs.filter((blob) => clipOf(blob.id) === clip.id),
      track: track(clip),
      plan: plan(clip),
    }));
}

/**
 * The clip `step` places after `from` in the order the project holds them, wrapping round.
 *
 * @remarks `null` with no clips. A `from` not in the project counts as the first clip.
 */
export function stepSource(edits: EditState, from: ClipId | null, step: number): ClipId | null {
  const clips = edits.clips;
  if (clips.length === 0) return null;
  const at = Math.max(
    0,
    clips.findIndex((clip) => clip.id === from),
  );
  const next = (((at + step) % clips.length) + clips.length) % clips.length;
  return clips[next]?.id ?? null;
}

/** Whether any two clips sound at once. */
export function hasOverlaps(edits: EditState | null): boolean {
  const clips = edits?.clips ?? [];
  for (let i = 0; i < clips.length; i += 1) {
    for (let j = i + 1; j < clips.length; j += 1) {
      const a = clips[i];
      const b = clips[j];
      if (a === undefined || b === undefined) continue;
      if (
        a.position < b.position + b.source.duration - 1e-9 &&
        b.position < a.position + a.source.duration - 1e-9
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Names a set of sources for a scope line: "Lead", "Lead and Harmony", "Lead, Harmony and 2
 * more".
 */
export function sourceNames(edits: EditState | null, clips: readonly ClipId[]): string {
  const names = (edits?.clips ?? [])
    .filter((clip) => clips.includes(clip.id))
    .map((clip) => displayTitle(clip));
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0] ?? ''} and ${names[1] ?? ''}`;
  if (names.length === 3) return `${names[0] ?? ''}, ${names[1] ?? ''} and ${names[2] ?? ''}`;
  return `${names[0] ?? ''}, ${names[1] ?? ''} and ${String(names.length - 2)} more`;
}

/** The view's {@link OthersView}, reading an absent one as `show`. */
export function othersOf(view: { others?: OthersView }): OthersView {
  return view.others ?? 'show';
}
