// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Which keystrokes a focused control keeps for itself, and which reach the editor's shortcuts.
 *
 * A control keeps only the keys it acts on. Focus left on a slider or a number field after it was
 * used therefore does not stop Space playing or a shortcut running.
 */

/** What a focused element does with keys. */
export type ControlKind = 'text' | 'number' | 'range' | 'none';

/** The parts of a keystroke the rule reads. */
export interface Keystroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** Keys that move or edit inside any field. */
const FIELD_KEYS = new Set([
  'Backspace',
  'Delete',
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'Enter',
  'Tab',
]);

/** Keys a slider moves by. */
const RANGE_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** Chords every field uses to edit its text: select all, copy, cut, paste, undo and redo. */
const EDITING_CHORDS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

/** Whether a control of `kind` keeps `stroke` rather than letting a shortcut have it. */
export function controlOwnsKey(kind: ControlKind, stroke: Keystroke): boolean {
  const primary = stroke.ctrlKey || stroke.metaKey;
  switch (kind) {
    case 'none':
      return false;
    case 'range':
      return !primary && !stroke.altKey && RANGE_KEYS.has(stroke.key);
    case 'text':
      if (primary) return EDITING_CHORDS.has(stroke.key.toLowerCase());
      // Alt alone types characters on some layouts, so only an Alt chord with a letter passes.
      return !stroke.altKey || stroke.key.length !== 1;
    case 'number':
      if (primary) return EDITING_CHORDS.has(stroke.key.toLowerCase());
      if (stroke.altKey) return false;
      if (FIELD_KEYS.has(stroke.key)) return true;
      // A stray letter in a number field is kept, so it cannot run a single-key edit, but Space
      // types nothing into a number and so plays.
      return stroke.key.length === 1 && stroke.key !== ' ';
  }
}

/** What a focused element does with keys, read from the element. */
export function controlKind(target: EventTarget | null): ControlKind {
  if (!(target instanceof HTMLElement)) return 'none';
  if (target.isContentEditable) return 'text';
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return 'text';
  if (tag === 'SELECT') return 'range';
  if (target instanceof HTMLInputElement) {
    const type = target.type.toLowerCase();
    if (type === 'range') return 'range';
    if (type === 'number') return 'number';
    if (type === 'button' || type === 'checkbox' || type === 'radio' || type === 'submit') {
      return 'none';
    }
    return 'text';
  }
  return 'none';
}
