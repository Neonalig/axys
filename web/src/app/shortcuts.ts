// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keyboard access to the command list, plus the editing keys that are not commands.
 *
 * Every binding comes from a command's own `shortcut`, so a key and the button beside it can
 * never mean different things. Nudging, selection clearing and playhead movement are handled
 * here because they act on the current selection rather than on a fixed object.
 */

import { emptySelection } from './selection.js';
import type { Command, CommandContext } from './commands.js';
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

/** Digits the numpad carries, which address the take by proportion rather than by command. */
const NUMPAD_DIGITS: readonly string[] = [
  'Numpad0',
  'Numpad1',
  'Numpad2',
  'Numpad3',
  'Numpad4',
  'Numpad5',
  'Numpad6',
  'Numpad7',
  'Numpad8',
  'Numpad9',
];

interface Chord {
  primary: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseChord(shortcut: string): Chord | null {
  const parts = shortcut
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const key = parts.pop();
  if (key === undefined) return null;
  const chord: Chord = { primary: false, shift: false, alt: false, key: normaliseKey(key) };
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
  return {
    primary: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
    key: normaliseKey(event.key),
  };
}

function sameChord(a: Chord, b: Chord): boolean {
  return a.primary === b.primary && a.shift === b.shift && a.alt === b.alt && a.key === b.key;
}

/** True while the keystroke belongs to a text field rather than to the editor. */
function editingText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    return type !== 'button' && type !== 'checkbox' && type !== 'radio' && type !== 'submit';
  }
  return false;
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
  if (blobs.length === 0) return null;
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
 * @remarks Numpad 0 to 9 are 0% to 90%, the way a media player's number row scrubs. They are read
 * by `code` rather than by `key`, so the numpad digit and the digit above the letters stay two
 * different keys: `0` on the number row excludes a blob.
 */
function jumpToPercent(ctx: CommandContext, code: string): boolean {
  const digit = NUMPAD_DIGITS.indexOf(code);
  if (digit < 0) return false;
  const duration = ctx.store.state.source?.duration ?? 0;
  if (!(duration > 0)) return false;
  ctx.editor.goTo((duration * digit) / 10);
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
    if (editingText(event.target)) return;

    if (event.key === 'Escape') {
      clearSelection(ctx);
      event.preventDefault();
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
        event.preventDefault();
        return;
      }
      if (seekBy(ctx, event)) {
        event.preventDefault();
        return;
      }
    }

    const pressed = chordOf(event);
    for (const binding of bindings) {
      if (!sameChord(pressed, binding.chord)) continue;
      event.preventDefault();
      if (!binding.command.enabled(ctx)) return;
      void binding.command.run(ctx);
      return;
    }
  };

  target.addEventListener('keydown', onKeyDown);
  return () => {
    target.removeEventListener('keydown', onKeyDown);
  };
}
