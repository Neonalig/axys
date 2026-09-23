// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keyboard chords drawn as keys: one box per key, the way a keyboard shows them.
 */

/** Names that are keys in their own right, beyond single characters and function keys. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  'Ctrl',
  'Cmd',
  'Shift',
  'Alt',
  'Option',
  'Space',
  'Enter',
  'Esc',
  'Tab',
  'Delete',
  'Backspace',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Up',
  'Down',
  'Left',
  'Right',
]);

/** Whether one part of a chord names a key. */
export function isKey(part: string): boolean {
  return part.length === 1 || NAMED_KEYS.has(part) || /^F\d{1,2}$/.test(part);
}

/** The keys of a chord such as `Ctrl+Shift+V`, or `null` when it is not one. */
export function chordKeys(chord: string): string[] | null {
  // A plus on its own is a key, so `Ctrl++` is Ctrl and plus.
  const parts = chord.endsWith('++') ? [...chord.slice(0, -2).split('+'), '+'] : chord.split('+');
  return parts.length > 0 && parts.every(isKey) ? parts : null;
}

/** A chord drawn as one box per key. */
export function keycaps(chord: string): HTMLElement {
  const group = document.createElement('span');
  group.className = 'axys-keys';
  for (const key of chordKeys(chord) ?? [chord]) {
    const cap = document.createElement('kbd');
    cap.className = 'axys-key';
    cap.textContent = key;
    group.append(cap);
  }
  return group;
}

/**
 * Writes text into an element with a chord at the end of a line, `Save Project (Ctrl+S)`, drawn
 * as keys and the brackets dropped.
 *
 * @remarks Anything else in brackets, `(3 blobs)` say, is left as text.
 */
export function writeWithKeys(element: HTMLElement, text: string): void {
  element.replaceChildren();
  text.split('\n').forEach((line, index) => {
    if (index > 0) element.append(document.createElement('br'));
    const match = /^(.*?)\s*\(([^()]+)\)$/.exec(line);
    const keys = match?.[2] === undefined ? null : chordKeys(match[2]);
    if (match === null || keys === null) {
      element.append(document.createTextNode(line));
      return;
    }
    element.append(document.createTextNode(`${match[1] ?? ''} `), keycaps(match[2] ?? ''));
  });
}
