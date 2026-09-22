// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../../app/store.js';
import type { Blob, GuideSelection, MidiNote } from '../../core/types.js';
import type { Theme } from '../../ui/theme.js';
import type { Viewport } from '../view.js';
import { tickToSeconds } from '../view.js';
import { blobOutputEnd, blobOutputStart } from './blobs.js';

/** Half-height in semitones of a guide note body. */
const NOTE_HALF = 0.42;

/** Spacing in pixels between the diagonal strokes that fill a guide note. */
const HATCH_SPACING = 6;

/** Corner radius in pixels of a guide note. */
const NOTE_RADIUS = 3;

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
    drawGuideNote(ctx, viewport, theme, {
      x0,
      x1,
      top,
      bottom,
      active: mapped.has(index),
      muted: guide.muted,
    });
  }

  drawLinks(ctx, state, viewport, theme);
  ctx.restore();
}

/** One guide note's screen rectangle and how it should read. */
interface GuideNoteBox {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  /** Whether a blob is mapped onto it. */
  active: boolean;
  muted: boolean;
}

/**
 * Draws one guide note as a hatched, borderless block.
 *
 * @remarks Deliberately unlike a blob. A guide is read, never edited, so giving it the outline
 * and the solid or dashed border that mean "grab this" on a blob invites an edit that cannot
 * happen. Diagonal strokes and no border read as backing material at a glance.
 */
function drawGuideNote(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  theme: Theme,
  box: GuideNoteBox,
): void {
  const width = Math.max(2, box.x1 - box.x0);
  const height = Math.max(3, box.bottom - box.top);
  const colour = box.active ? theme.midiNoteActive : theme.midiNote;
  const dim = box.muted ? 0.35 : 1;

  ctx.save();
  ctx.beginPath();
  const radius = Math.min(NOTE_RADIUS, height / 2, width / 2);
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(box.x0, box.top, width, height, radius);
  } else {
    ctx.rect(box.x0, box.top, width, height);
  }
  ctx.globalAlpha = dim * (box.active ? 0.3 : 0.18);
  ctx.fillStyle = colour;
  ctx.fill();

  ctx.clip();
  ctx.globalAlpha = dim * (box.active ? 0.6 : 0.36);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Bounded to what is on screen, so a note wider than the canvas costs no more than the canvas.
  const from = Math.max(box.x0, -height);
  const to = Math.min(box.x1, viewport.width);
  // A stroke rises to the right, so the one that covers the top-left corner starts a full
  // note-height to the left of the corner. Beginning at the edge itself leaves that corner bare.
  const first = Math.ceil((from - box.x0 - height) / HATCH_SPACING) * HATCH_SPACING;
  for (let offset = first; offset < to - box.x0 + height; offset += HATCH_SPACING) {
    ctx.moveTo(box.x0 + offset, box.bottom);
    ctx.lineTo(box.x0 + offset + height, box.top);
  }
  ctx.stroke();
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
