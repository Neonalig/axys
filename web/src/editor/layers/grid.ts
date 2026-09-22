// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { AccidentalStyle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';

/*
 * The Unicode musical symbols rather than an ASCII hash and a letter b, and rather than SMuFL:
 * a note name is running text, and pulling a 16 KB music font in behind every grid label would
 * be absurd. Neither shipped face carries them, so the browser falls back per character to a
 * system face that does, which every target platform has.
 */
const SHARP = '♯';
const FLAT = '♭';

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

/** Pitch-class index of a MIDI note, 0 is C. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Whether a note sits on a black piano key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_KEYS[pitchClass(midi)] ?? false;
}

/** Note name with octave, such as `C♯4`, in the project's accidental convention. */
export function noteName(midi: number, style: AccidentalStyle = 'sharps'): string {
  const rounded = Math.round(midi);
  const names = style === 'flats' ? FLAT_NAMES : SHARP_NAMES;
  const name = names[pitchClass(rounded)] ?? 'C';
  return `${name}${Math.floor(rounded / 12) - 1}`;
}

/** Note name plus the signed cents deviation, such as `A3 -12c`. */
export function noteNameWithCents(midi: number, style: AccidentalStyle = 'sharps'): string {
  const cents = Math.round((midi - Math.round(midi)) * 100);
  const sign = cents > 0 ? '+' : '';
  return `${noteName(midi, style)} ${sign}${cents}c`;
}

/**
 * Draws the pitch rows, octave emphasis, note labels and cents guides.
 *
 * @remarks Row shading follows the piano keyboard, so octave position reads without counting
 * labels. Cents guides appear only once a semitone is tall enough for them to be actionable.
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const { plotTop, plotHeight, width } = viewport;
  const rowHeight = plotHeight / viewport.pitchRange;
  const low = Math.floor(viewport.view.lowMidi) - 1;
  const high = Math.ceil(viewport.view.highMidi) + 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, plotTop, width, plotHeight);
  ctx.clip();

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, plotTop, width, plotHeight);

  if (rowHeight >= 3) {
    ctx.fillStyle = theme.surfaceSunken;
    for (let midi = low; midi <= high; midi += 1) {
      if (!isBlackKey(midi)) {
        continue;
      }
      const top = viewport.midiToY(midi + 0.5);
      ctx.fillRect(0, top, width, rowHeight);
    }
  }

  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  const semitoneLines = rowHeight >= 5;
  for (let midi = low; semitoneLines && midi <= high; midi += 1) {
    if (pitchClass(midi) === 0) {
      continue;
    }
    const y = Math.round(viewport.midiToY(midi - 0.5)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = theme.gridLineOctave;
  for (let midi = low; midi <= high; midi += 1) {
    if (pitchClass(midi) !== 0) {
      continue;
    }
    const y = Math.round(viewport.midiToY(midi - 0.5)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  if (rowHeight >= 44) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.setLineDash([2, 4]);
    ctx.strokeStyle = theme.gridLine;
    ctx.beginPath();
    for (let midi = low; midi <= high; midi += 1) {
      for (const cents of [-0.25, 0.25]) {
        const y = Math.round(viewport.midiToY(midi + cents)) + 0.5;
        ctx.moveTo(PITCH_LABEL_GUTTER, y);
        ctx.lineTo(width, y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

/**
 * Draws the pitch-label gutter down the left edge.
 *
 * @remarks Drawn after the content layers rather than with the grid. Every content layer spans
 * the full canvas width, so a gutter drawn underneath them ends up with blobs, the pitch track
 * and guide notes written across the note names.
 */
export function drawPitchLabels(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const rowHeight = viewport.plotHeight / viewport.pitchRange;
  const everySemitone = rowHeight >= 11;
  if (!everySemitone && rowHeight * 12 < 12) {
    return;
  }
  const style: AccidentalStyle = state.edits?.accidentals ?? 'sharps';
  const low = Math.floor(viewport.view.lowMidi) - 1;
  const high = Math.ceil(viewport.view.highMidi) + 1;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, PITCH_LABEL_GUTTER + 1, viewport.plotHeight);
  ctx.clip();
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, viewport.plotTop, PITCH_LABEL_GUTTER, viewport.plotHeight);
  ctx.strokeStyle = theme.border;
  ctx.beginPath();
  ctx.moveTo(PITCH_LABEL_GUTTER + 0.5, viewport.plotTop);
  ctx.lineTo(PITCH_LABEL_GUTTER + 0.5, viewport.plotTop + viewport.plotHeight);
  ctx.stroke();

  ctx.font = '12px "Atkinson Hyperlegible Next", system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let midi = low; midi <= high; midi += 1) {
    const isOctave = pitchClass(midi) === 0;
    if (!everySemitone && !isOctave) {
      continue;
    }
    const y = viewport.midiToY(midi);
    if (y < viewport.plotTop || y > viewport.plotTop + viewport.plotHeight) {
      continue;
    }
    ctx.fillStyle = isOctave ? theme.text : theme.gridLabel;
    ctx.fillText(noteName(midi, style), PITCH_LABEL_GUTTER - 8, y);
  }
  ctx.restore();
}
