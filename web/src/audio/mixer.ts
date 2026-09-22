// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the monitor desk amounts to in amplitudes.
 *
 * The worklet mixes with these, the editor draws with them and the panel reads them back, so
 * what is heard, what is drawn and what the faders say cannot disagree.
 */

import { MAX_GAIN_DB, MIN_GAIN_DB } from '../core/types.js';
import type { MixerSettings, MixerStrip } from '../core/types.js';

/** One audio source on the desk. */
export type StripId = 'processed' | 'original' | 'click';

/** The strips in the order the desk draws them. */
export const STRIP_IDS: readonly StripId[] = ['processed', 'original', 'click'];

/** How each strip names itself and what it plays. */
export const STRIP_LABELS: Readonly<Record<StripId, { label: string; tip: string }>> = {
  processed: { label: 'Processed', tip: 'The take as the edits make it sound.' },
  original: { label: 'Original', tip: 'The take as it was sung, on the same transport clock.' },
  click: { label: 'Click', tip: 'The metronome.' },
};

/** What one strip contributes to each output channel. */
export interface StripLevel {
  left: number;
  right: number;
  /** Whether the strip is heard at all, which is what mute, solo and a closed fader decide. */
  audible: boolean;
}

/** Amplitudes every strip contributes, mute and solo already resolved. */
export type MixLevels = Record<StripId, StripLevel>;

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

/**
 * What each strip contributes to the two output channels.
 *
 * @remarks Pan is equal power, so a strip swept across the field holds its loudness rather than
 * dipping through the middle. Any solo silences every strip that is not soloed, which is what a
 * solo means everywhere else.
 */
export function mixLevels(mixer: MixerSettings): MixLevels {
  const soloed = STRIP_IDS.some((id) => mixer[id].solo);
  const levels = {} as MixLevels;
  for (const id of STRIP_IDS) {
    levels[id] = levelOf(mixer[id], soloed);
  }
  return levels;
}

function levelOf(strip: MixerStrip, soloed: boolean): StripLevel {
  const open = soloed ? strip.solo : !strip.mute;
  const gain = open ? amplitude(strip.gainDb) : 0;
  const angle = ((Math.min(Math.max(strip.pan, -1), 1) + 1) * Math.PI) / 4;
  return { left: gain * Math.cos(angle), right: gain * Math.sin(angle), audible: gain > 0 };
}

/** Level the click is heard at until it is moved, mirroring the core's own default. */
export const DEFAULT_CLICK_DB = -11;

/** The desk a project starts with, for the moments before one is open. */
export const DEFAULT_MIXER: MixerSettings = {
  processed: { gainDb: 0, pan: 0, mute: false, solo: false },
  original: { gainDb: 0, pan: 0, mute: true, solo: false },
  click: { gainDb: DEFAULT_CLICK_DB, pan: 0, mute: false, solo: false },
};

/**
 * The desk with the two vocal strips exchanging which of them is heard.
 *
 * @remarks Only mute and solo move. A swap answers which take is being listened to, and taking
 * each strip's level and pan with it would answer a question nobody asked.
 */
export function swapped(mixer: MixerSettings): MixerSettings {
  return {
    ...mixer,
    processed: { ...mixer.processed, mute: mixer.original.mute, solo: mixer.original.solo },
    original: { ...mixer.original, mute: mixer.processed.mute, solo: mixer.processed.solo },
  };
}

/** Which of the two vocal strips is being heard, for the control that swaps them. */
export function vocalMonitor(mixer: MixerSettings): 'processed' | 'original' | 'both' | 'neither' {
  const levels = mixLevels(mixer);
  if (levels.processed.audible && levels.original.audible) return 'both';
  if (levels.processed.audible) return 'processed';
  if (levels.original.audible) return 'original';
  return 'neither';
}
