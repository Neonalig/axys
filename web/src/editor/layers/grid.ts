// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { AccidentalStyle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
const BLACK_KEYS = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Pitch-class index of a MIDI note, 0 is C. */
export function pitchClass(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

/** Whether a note sits on a black piano key. */
export function isBlackKey(midi: number): boolean {
  return BLACK_KEYS[pitchClass(midi)] ?? false;
}

/** Note name with octave, such as `C#4`, in the project's accidental convention. */
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
  const style: AccidentalStyle = state.edits?.accidentals ?? 'sharps';
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

  drawLabels(ctx, viewport, theme, style, low, high, rowHeight);
  ctx.restore();
}

function drawLabels(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  style: AccidentalStyle,
  low: number,
  high: number,
  rowHeight: number,
): void {
  const everySemitone = rowHeight >= 11;
  if (!everySemitone && rowHeight * 12 < 12) {
    return;
  }
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, viewport.plotTop, PITCH_LABEL_GUTTER, viewport.plotHeight);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = theme.border;
  ctx.beginPath();
  ctx.moveTo(PITCH_LABEL_GUTTER + 0.5, viewport.plotTop);
  ctx.lineTo(PITCH_LABEL_GUTTER + 0.5, viewport.plotTop + viewport.plotHeight);
  ctx.stroke();

  ctx.font = '11px system-ui, sans-serif';
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
