// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keyboard access to the command list, plus the editing keys that are not commands.
 *
 * Every binding comes from a command's own `shortcut`, so a key and the button beside it can
 * never mean different things. Nudging, selection clearing and playhead movement are handled
 * here because they act on the current selection rather than on a fixed object.
 */

import { movePitchOps } from './clipboard.js';
import { emptySelection, selectionForRanges, selectionInMode } from './selection.js';
import type { Command, CommandContext } from './commands.js';
import { controlKind, controlOwnsKey } from './key-owner.js';
import { projectEnd } from './store.js';
import type { AppState } from './store.js';
import type { EditOp } from '../core/types.js';

/** Semitones one arrow press moves the selected blobs, by modifier. */
const PITCH_STEP = 1;
const PITCH_STEP_COARSE = 12;
const PITCH_STEP_FINE = 0.01;

/** Seconds one arrow press moves the selected blobs, by modifier. */
const TIME_STEP = 0.01;
const TIME_STEP_COARSE = 0.1;
const TIME_STEP_FINE = 0.001;

/** Seconds one arrow press moves the playhead when nothing is selected. */
const SEEK_STEP = 1;
const SEEK_STEP_COARSE = 5;

/**
 * The digit keys in the order they sit on a keyboard, either row.
 *
 * @remarks `1` through `0` left to right, which is the order the take is laid out in, so the row
 * reads as a line across it. The numpad's own digits answer the same way.
 */
const DIGIT_ROW: readonly string[] = [
  'Digit1',
  'Digit2',
  'Digit3',
  'Digit4',
  'Digit5',
  'Digit6',
  'Digit7',
  'Digit8',
  'Digit9',
  'Digit0',
];

const NUMPAD_ROW: readonly string[] = [
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
  'Numpad0',
];

interface Chord {
  primary: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
  /**
   * Whether Shift has to agree for this chord to match.
   *
   * @remarks It does not for a punctuation key, because the key is what Shift produces. `?` is
   * Shift and the slash key on most layouts, so demanding that Shift be off would mean the chord
   * could never be pressed, and demanding it be on would bind a key nobody wrote down.
   */
  shiftMatters: boolean;
}

function parseChord(shortcut: string): Chord | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = parts.pop();
  if (key === undefined) return null;
  const normalised = normaliseKey(key);
  const chord: Chord = {
    primary: false,
    shift: false,
    alt: false,
    key: normalised,
    shiftMatters: normalised.length !== 1 || /[A-Z0-9]/.test(normalised),
  };
  for (const part of parts) {
    const modifier = part.toLowerCase();
    if (modifier === 'ctrl' || modifier === 'cmd' || modifier === 'meta') chord.primary = true;
    else if (modifier === 'shift') chord.shift = true;
    else if (modifier === 'alt' || modifier === 'option') chord.alt = true;
    else return null;
  }
  return chord;
}

function normaliseKey(key: string): string {
  if (key === ' ') return 'SPACE';
  return key.toUpperCase();
}

function chordOf(event: KeyboardEvent): Chord {
  // A digit is read from the key itself, since Shift and some layouts turn it into a symbol.
  const digit = /^Digit(\d)$/.exec(event.code)?.[1];
  return {
    primary: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: digit ?? normaliseKey(event.key),
    shiftMatters: true,
  };
}

/** Whether a keystroke is the chord a command asked for. `binding` decides whether Shift counts. */
function sameChord(pressed: Chord, binding: Chord): boolean {
  return (
    pressed.primary === binding.primary &&
    pressed.alt === binding.alt &&
    pressed.key === binding.key &&
    (!binding.shiftMatters || pressed.shift === binding.shift)
  );
}

/** Whether a key is Copy over text selected in the page, which the browser copies itself. */
function copyingSelectedText(event: KeyboardEvent): boolean {
  if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'c') return false;
  const selected = document.getSelection();
  return selected !== null && !selected.isCollapsed && selected.toString().length > 0;
}

function pitchStep(event: KeyboardEvent): number {
  if (event.altKey) return PITCH_STEP_FINE;
  if (event.shiftKey) return PITCH_STEP_COARSE;
  return PITCH_STEP;
}

function timeStep(event: KeyboardEvent): number {
  if (event.altKey) return TIME_STEP_FINE;
  if (event.shiftKey) return TIME_STEP_COARSE;
  return TIME_STEP;
}

function nudgeOp(state: AppState, event: KeyboardEvent): EditOp | null {
  const blobs = state.selection.blobs;
  if (state.editMode === 'pitch') return nudgePitchLine(state, event);
  if (blobs.length === 0) return null;
  if (state.editMode === 'blob') {
    const seconds =
      event.key === 'ArrowLeft'
        ? -timeStep(event)
        : event.key === 'ArrowRight'
          ? timeStep(event)
          : 0;
    if (seconds === 0) return null;
    // Slid from the leading edge, so a blob never meets one of its own selection.
    const order = state.blobs
      .filter((blob) => blobs.includes(blob.id))
      .sort((a, b) => (seconds > 0 ? b.start - a.start : a.start - b.start));
    return {
      type: 'group',
      ops: order.map((blob): EditOp => ({ type: 'shiftBlob', blob: blob.id, seconds })),
    };
  }
  switch (event.key) {
    case 'ArrowUp':
      return { type: 'movePitch', blobs, semitones: pitchStep(event) };
    case 'ArrowDown':
      return { type: 'movePitch', blobs, semitones: -pitchStep(event) };
    case 'ArrowLeft':
      return { type: 'moveTime', blobs, seconds: -timeStep(event) };
    case 'ArrowRight':
      return { type: 'moveTime', blobs, seconds: timeStep(event) };
    default:
      return null;
  }
}

/** In Pitch mode the arrows move the selected pitch line and leave the audio where it is. */
function nudgePitchLine(state: AppState, event: KeyboardEvent): EditOp | null {
  const ranges = state.selection.ranges;
  if (ranges.length === 0) return null;
  const [seconds, semitones] =
    event.key === 'ArrowUp'
      ? [0, pitchStep(event)]
      : event.key === 'ArrowDown'
        ? [0, -pitchStep(event)]
        : event.key === 'ArrowLeft'
          ? [-timeStep(event), 0]
          : event.key === 'ArrowRight'
            ? [timeStep(event), 0]
            : [0, 0];
  const ops = movePitchOps(state, ranges, seconds, semitones, state.pitchCutFill);
  return ops.length === 0 ? null : { type: 'group', ops };
}

/** Moves the selection with a pitch line nudged in time, so the next press moves it again. */
function followPitchLine(ctx: CommandContext, event: KeyboardEvent): void {
  const state = ctx.store.state;
  if (state.editMode !== 'pitch') return;
  const seconds =
    event.key === 'ArrowLeft' ? -timeStep(event) : event.key === 'ArrowRight' ? timeStep(event) : 0;
  if (seconds === 0) return;
  const ranges = state.selection.ranges.map((range) => ({
    start: range.start + seconds,
    end: range.end + seconds,
  }));
  ctx.store.update({
    selection: selectionInMode(selectionForRanges(state.blobs, ranges), state.editMode),
  });
}

/** Arrow keys with an empty selection walk the playhead instead of moving audio. */
function seekBy(ctx: CommandContext, event: KeyboardEvent): boolean {
  const step = event.shiftKey ? SEEK_STEP_COARSE : SEEK_STEP;
  if (event.key === 'ArrowLeft') {
    ctx.audio.seek(Math.max(0, ctx.audio.position - step));
    return true;
  }
  if (event.key === 'ArrowRight') {
    ctx.audio.seek(ctx.audio.position + step);
    return true;
  }
  return false;
}

/**
 * Jumps the playhead to a proportion of the take.
 *
 * @remarks The ten digits span the whole take: `1` is the start and `0` is the end, with the eight
 * between them evenly spaced, so the row reads as a line across the material rather than as ten
 * separate marks that stop short of it. Read by `code` rather than by `key`, so a keyboard layout
 * that puts a symbol on an unshifted digit still answers.
 */
function jumpToPercent(ctx: CommandContext, code: string): boolean {
  const index = DIGIT_ROW.indexOf(code) < 0 ? NUMPAD_ROW.indexOf(code) : DIGIT_ROW.indexOf(code);
  if (index < 0) return false;
  const duration = projectEnd(ctx.store.state);
  if (!(duration > 0)) return false;
  ctx.editor.goTo((duration * index) / (DIGIT_ROW.length - 1));
  return true;
}

function clearSelection(ctx: CommandContext): void {
  const state = ctx.store.state;
  if (
    state.selection.blobs.length === 0 &&
    state.selection.anchors.length === 0 &&
    state.selection.ranges.length === 0
  ) {
    return;
  }
  ctx.store.update({ selection: emptySelection() });
}

/** Binds keyboard shortcuts for a command list to a target element. Returns a disposer. */
export function bindShortcuts(
  target: EventTarget,
  commands: Command[],
  ctx: CommandContext,
): () => void {
  const bindings: { chord: Chord; command: Command }[] = [];
  for (const command of commands) {
    for (const shortcut of [command.shortcut, command.altShortcut]) {
      if (shortcut === undefined) continue;
      const chord = parseChord(shortcut);
      if (chord) bindings.push({ chord, command });
    }
  }

  const onKeyDown = (event: Event): void => {
    if (!(event instanceof KeyboardEvent) || event.repeat) return;
    if (controlOwnsKey(controlKind(event.target), event)) return;
    if (copyingSelectedText(event)) return;

    const pressed = chordOf(event);
    const matching = bindings.filter((binding) => sameChord(pressed, binding.chord));

    // Escape stops whatever it is bound to while that can run, and otherwise clears the selection.
    if (event.key === 'Escape') {
      event.preventDefault();
      const bound = matching.find((candidate) => candidate.command.enabled(ctx));
      if (bound !== undefined) void bound.command.run(ctx);
      else clearSelection(ctx);
      return;
    }

    if (!event.ctrlKey && !event.metaKey && !event.altKey && jumpToPercent(ctx, event.code)) {
      event.preventDefault();
      return;
    }

    if (event.key.startsWith('Arrow') && !event.ctrlKey && !event.metaKey) {
      const op = nudgeOp(ctx.store.state, event);
      if (op) {
        ctx.workspace.apply(op);
        followPitchLine(ctx, event);
        event.preventDefault();
        return;
      }
      if (seekBy(ctx, event)) {
        event.preventDefault();
        return;
      }
    }

    // A key bound to several commands runs the first one enabled.
    if (matching.length === 0) return;
    event.preventDefault();
    const binding = matching.find((candidate) => candidate.command.enabled(ctx));
    if (binding !== undefined) void binding.command.run(ctx);
  };

  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}
