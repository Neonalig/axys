// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import { isBlackKey, noteName, pitchClass } from '../../core/notes.js';
import type { AccidentalStyle } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { PITCH_LABEL_GUTTER } from '../view.js';

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

  ctx.lineWidth = viewport.crispWidth();
  ctx.beginPath();
  ctx.strokeStyle = theme.gridLine;
  const semitoneLines = rowHeight >= 5;
  for (let midi = low; semitoneLines && midi <= high; midi += 1) {
    if (pitchClass(midi) === 0) {
      continue;
    }
    const y = viewport.crisp(viewport.midiToY(midi - 0.5));
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
    const y = viewport.crisp(viewport.midiToY(midi - 0.5));
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
        const y = viewport.crisp(viewport.midiToY(midi + cents));
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
  ctx.moveTo(viewport.crisp(PITCH_LABEL_GUTTER), viewport.plotTop);
  ctx.lineTo(viewport.crisp(PITCH_LABEL_GUTTER), viewport.plotTop + viewport.plotHeight);
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
