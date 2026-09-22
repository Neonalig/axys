// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Blob, GuideSelection, MidiNote } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { tickToSeconds } from '../view.js';
import { blobOutputEnd, blobOutputStart } from './blobs.js';

/** Half-height in semitones of a guide note body. */
const NOTE_HALF = 0.42;

function matchesGuide(note: MidiNote, guide: GuideSelection): boolean {
  if (note.track !== guide.track) {
    return false;
  }
  return guide.channel === null || note.channel === guide.channel;
}

/**
 * Draws the selected MIDI guide notes and the links to the blobs they map onto.
 *
 * @remarks Nothing is drawn until a guide track is selected, so an imported file cannot clutter
 * the editor before the user has chosen what it guides. A muted guide keeps its notes visible at
 * reduced weight.
 */
export function drawMidi(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const edits = state.edits;
  const midi = state.midi;
  const guide = edits?.guide ?? null;
  if (edits === null || midi === null || guide === null) {
    return;
  }
  const timeline = edits.timeline;
  const mapped = new Set<number>();
  for (const mapping of edits.mappings) {
    if (mapping.note !== null && !mapping.optedOut) {
      mapped.add(mapping.note);
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, viewport.plotTop, viewport.width, viewport.plotHeight);
  ctx.clip();
  ctx.globalAlpha = guide.muted ? 0.35 : 1;

  for (let index = 0; index < midi.notes.length; index += 1) {
    const note = midi.notes[index];
    if (note === undefined || !matchesGuide(note, guide)) {
      continue;
    }
    const start = tickToSeconds(timeline, note.startTick);
    const end = tickToSeconds(timeline, note.endTick);
    if (end < viewport.view.visibleStart || start > viewport.view.visibleEnd) {
      continue;
    }
    const x0 = viewport.timeToX(start);
    const x1 = viewport.timeToX(end);
    const top = viewport.midiToY(note.key + NOTE_HALF);
    const bottom = viewport.midiToY(note.key - NOTE_HALF);
    const active = mapped.has(index);
    ctx.globalAlpha = (guide.muted ? 0.35 : 1) * (active ? 0.5 : 0.3);
    ctx.fillStyle = active ? theme.midiNoteActive : theme.midiNote;
    ctx.fillRect(x0, top, Math.max(2, x1 - x0), Math.max(2, bottom - top));
    ctx.globalAlpha = guide.muted ? 0.45 : 1;
    ctx.strokeStyle = active ? theme.midiNoteActive : theme.midiNote;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(x0) + 0.5,
      Math.round(top) + 0.5,
      Math.max(2, Math.round(x1 - x0)),
      Math.max(2, Math.round(bottom - top)),
    );
  }

  drawLinks(ctx, state, viewport, theme);
  ctx.restore();
}

function drawLinks(
  ctx: CanvasRenderingContext2D,
  state: AppState,
  viewport: Viewport,
  theme: Theme,
): void {
  const edits = state.edits;
  const midi = state.midi;
  if (edits === null || midi === null) {
    return;
  }
  const blobs = new Map<number, Blob>();
  for (const blob of state.blobs) {
    blobs.set(blob.id, blob);
  }

  ctx.save();
  ctx.strokeStyle = theme.midiLink;
  ctx.lineWidth = 1.2;
  for (const mapping of edits.mappings) {
    if (mapping.note === null || mapping.optedOut) {
      continue;
    }
    const note = midi.notes[mapping.note];
    const blob = blobs.get(mapping.blob);
    if (note === undefined || blob === undefined) {
      continue;
    }
    const noteMid =
      (tickToSeconds(edits.timeline, note.startTick) +
        tickToSeconds(edits.timeline, note.endTick)) /
      2;
    const blobMid = (blobOutputStart(blob) + blobOutputEnd(blob)) / 2;
    const x0 = viewport.timeToX(blobMid);
    const x1 = viewport.timeToX(noteMid);
    if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > viewport.width) {
      continue;
    }
    ctx.setLineDash(mapping.manual ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(x0, viewport.midiToY(blob.detectedCenter + blob.pitchOffset));
    ctx.lineTo(x1, viewport.midiToY(note.key));
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();
}
