// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Note names for a MIDI number, in the project's accidental convention.
 *
 * @remarks The Unicode musical symbols rather than an ASCII hash and a letter b, and rather than
 * SMuFL: a note name is running text, and pulling a 16 KB music font in behind every grid label
 * would be absurd. Neither shipped face carries them, so the browser falls back per character to a
 * system face that does, which every target platform has.
 */

import type { AccidentalStyle } from './types.js';

const SHARP = '♯';
const FLAT = '♭';

/** The twelve pitch classes spelled with sharps, starting at C. */
export const SHARP_NAMES = [
  'C',
  `C${SHARP}`,
  'D',
  `D${SHARP}`,
  'E',
  'F',
  `F${SHARP}`,
  'G',
  `G${SHARP}`,
  'A',
  `A${SHARP}`,
  'B',
] as const;

/** The twelve pitch classes spelled with flats, starting at C. */
export const FLAT_NAMES = [
  'C',
  `D${FLAT}`,
  'D',
  `E${FLAT}`,
  'E',
  'F',
  `G${FLAT}`,
  'G',
  `A${FLAT}`,
  'A',
  `B${FLAT}`,
  'B',
] as const;

const BLACK_KEYS = [false, true, false, true, false, false, true, false, true, false, true, false];

/** The dash shown where there is no note to name. */
const NO_NOTE = '--';

/** Pitch-class index of a MIDI note, 0 is C. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Whether a note sits on a black piano key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_KEYS[pitchClass(midi)] ?? false;
}

/** Note name with octave, such as `C♯4`, or `--` where the MIDI number is not finite. */
export function noteName(midi: number, style: AccidentalStyle = 'sharps'): string {
  if (!Number.isFinite(midi)) {
    return NO_NOTE;
  }
  const rounded = Math.round(midi);
  const names = style === 'flats' ? FLAT_NAMES : SHARP_NAMES;
  const name = names[pitchClass(rounded)] ?? 'C';
  return `${name}${String(Math.floor(rounded / 12) - 1)}`;
}

/** Note name plus the signed cents deviation, such as `A3 -12c`. */
export function noteNameWithCents(midi: number, style: AccidentalStyle = 'sharps'): string {
  const cents = Math.round((midi - Math.round(midi)) * 100);
  const sign = cents > 0 ? '+' : '';
  return `${noteName(midi, style)} ${sign}${String(cents)}c`;
}
