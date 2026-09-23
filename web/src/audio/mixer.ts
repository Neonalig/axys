// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the monitor desk amounts to in amplitudes.
 *
 * The worklet mixes with these, the editor draws with them and the panel reads them back, so
 * what is heard, what is drawn and what the faders say cannot disagree.
 */

import { MAX_GAIN_DB, MIN_GAIN_DB } from '../core/types.js';
import type { ClipId, ClipStrips, MixerSettings, MixerStrip, ReferenceId } from '../core/types.js';

/** Which of a clip's two strips: the take as edited or as sung. */
export type VocalStrip = 'processed' | 'original';

/** What each vocal strip is called. */
export const VOCAL_NAMES: Readonly<Record<VocalStrip, string>> = {
  processed: 'Processed',
  original: 'Original',
};

/**
 * What the click strip is called.
 *
 * @remarks The name the transport control already uses, because two names for one sound is a
 * thing to work out rather than a thing to read.
 */
export const CLICK_NAME = 'Metronome';

/** What one strip contributes to each output channel. */
export interface StripLevel {
  left: number;
  right: number;
  /** Whether the strip is heard at all, which is what mute, solo and a closed fader decide. */
  audible: boolean;
}

/** What one clip's two strips contribute. */
export interface ClipLevels {
  processed: StripLevel;
  original: StripLevel;
}

/**
 * Amplitudes every strip contributes, mute and solo already resolved.
 *
 * @remarks Read on the audio thread, so looking a source up allocates nothing: a source with no
 * entry on the desk reads the shared default.
 */
export interface MixLevels {
  clips: ReadonlyMap<ClipId, ClipLevels>;
  references: ReadonlyMap<ReferenceId, StripLevel>;
  click: StripLevel;
  /** What a clip with no entry on the desk contributes. */
  defaultClip: ClipLevels;
  /** What a reference with no entry on the desk contributes. */
  defaultReference: StripLevel;
}

/**
 * Linear amplitude of a level in decibels, with the floor reading as silence.
 *
 * @remarks Mirrors `axys_core::units::decibels_to_amplitude`, because the worklet mixes on the
 * audio thread and cannot call into the core for a multiplier.
 */
export function amplitude(decibels: number): number {
  if (!Number.isFinite(decibels)) return 1;
  const clamped = Math.min(Math.max(decibels, MIN_GAIN_DB), MAX_GAIN_DB);
  return clamped <= MIN_GAIN_DB ? 0 : 10 ** (clamped / 20);
}

/** Level the click is heard at until it is moved, mirroring the core's own default. */
export const DEFAULT_CLICK_DB = -11;

/** A strip at unity, centred, neither muted nor soloed. */
export const UNITY_STRIP: MixerStrip = { gainDb: 0, pan: 0, mute: false, solo: false };

/** The desk a project starts with, for the moments before one is open. */
export const DEFAULT_MIXER: MixerSettings = {
  clips: [],
  references: [],
  click: { gainDb: DEFAULT_CLICK_DB, pan: 0, mute: false, solo: false },
};

/**
 * A clip's track, or the one it starts with: the edited take up and the original muted.
 *
 * @remarks Mirrors `MixerSettings::clip` in the core.
 */
export function clipStrips(mixer: MixerSettings, clip: ClipId): ClipStrips {
  return (
    mixer.clips.find((entry) => entry.clip === clip) ?? {
      clip,
      processed: UNITY_STRIP,
      original: { ...UNITY_STRIP, mute: true },
    }
  );
}

/** A reference's strip, or the unity strip it starts with. */
export function referenceStrip(mixer: MixerSettings, reference: ReferenceId): MixerStrip {
  return mixer.references.find((entry) => entry.reference === reference)?.strip ?? UNITY_STRIP;
}

/** The desk with one clip strip replaced, adding the clip's entry when it had none. */
export function withClipStrip(
  mixer: MixerSettings,
  clip: ClipId,
  which: VocalStrip,
  strip: MixerStrip,
): MixerSettings {
  const track = { ...clipStrips(mixer, clip), [which]: strip };
  const clips = mixer.clips.some((entry) => entry.clip === clip)
    ? mixer.clips.map((entry) => (entry.clip === clip ? track : entry))
    : [...mixer.clips, track];
  return { ...mixer, clips };
}

/** The desk with one reference strip replaced, adding its entry when it had none. */
export function withReferenceStrip(
  mixer: MixerSettings,
  reference: ReferenceId,
  strip: MixerStrip,
): MixerSettings {
  const references = mixer.references.some((entry) => entry.reference === reference)
    ? mixer.references.map((entry) =>
        entry.reference === reference ? { reference, strip } : entry,
      )
    : [...mixer.references, { reference, strip }];
  return { ...mixer, references };
}

/** Whether any strip on the desk is soloed, which is what silences the ones that are not. */
export function soloed(mixer: MixerSettings): boolean {
  return (
    mixer.click.solo ||
    mixer.clips.some((entry) => entry.processed.solo || entry.original.solo) ||
    mixer.references.some((entry) => entry.strip.solo)
  );
}

/**
 * What each strip contributes to the two output channels.
 *
 * @remarks Pan is equal power, so a strip swept across the field holds its loudness rather than
 * dipping through the middle. Any solo silences every strip that is not soloed, which is what a
 * solo means everywhere else.
 */
export function mixLevels(mixer: MixerSettings): MixLevels {
  const solo = soloed(mixer);
  const clips = new Map<ClipId, ClipLevels>();
  for (const entry of mixer.clips) {
    clips.set(entry.clip, {
      processed: levelOf(entry.processed, solo),
      original: levelOf(entry.original, solo),
    });
  }
  const references = new Map<ReferenceId, StripLevel>();
  for (const entry of mixer.references) {
    references.set(entry.reference, levelOf(entry.strip, solo));
  }
  const fresh = clipStrips({ ...mixer, clips: [] }, -1);
  return {
    clips,
    references,
    click: levelOf(mixer.click, solo),
    defaultClip: {
      processed: levelOf(fresh.processed, solo),
      original: levelOf(fresh.original, solo),
    },
    defaultReference: levelOf(UNITY_STRIP, solo),
  };
}

/** What one clip contributes, reading the default for a clip the desk has no entry for. */
export function clipLevels(levels: MixLevels, clip: ClipId): ClipLevels {
  return levels.clips.get(clip) ?? levels.defaultClip;
}

/** What one reference contributes, reading the default for one the desk has no entry for. */
export function referenceLevel(levels: MixLevels, reference: ReferenceId): StripLevel {
  return levels.references.get(reference) ?? levels.defaultReference;
}

function levelOf(strip: MixerStrip, solo: boolean): StripLevel {
  const open = solo ? strip.solo : !strip.mute;
  const gain = open ? amplitude(strip.gainDb) : 0;
  const angle = ((Math.min(Math.max(strip.pan, -1), 1) + 1) * Math.PI) / 4;
  return { left: gain * Math.cos(angle), right: gain * Math.sin(angle), audible: gain > 0 };
}

/** Which of a clip's two strips is being heard, which is what the editor draws solid. */
export function vocalMonitor(
  mixer: MixerSettings,
  clip: ClipId,
): 'processed' | 'original' | 'both' | 'neither' {
  const levels = clipLevels(mixLevels(mixer), clip);
  if (levels.processed.audible && levels.original.audible) return 'both';
  if (levels.processed.audible) return 'processed';
  if (levels.original.audible) return 'original';
  return 'neither';
}
