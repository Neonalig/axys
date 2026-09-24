// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { controlOwnsKey } from './key-owner.js';

function key(value: string, modifiers: { ctrl?: boolean; alt?: boolean } = {}) {
  return {
    key: value,
    ctrlKey: modifiers.ctrl === true,
    metaKey: false,
    altKey: modifiers.alt === true,
  };
}

describe('controlOwnsKey', () => {
  it('lets Space and letters past a slider but keeps its arrows', () => {
    expect(controlOwnsKey('range', key(' '))).toBe(false);
    expect(controlOwnsKey('range', key('m'))).toBe(false);
    expect(controlOwnsKey('range', key('ArrowUp'))).toBe(true);
  });

  it('lets Space and chords past a number field but keeps what it types', () => {
    expect(controlOwnsKey('number', key(' '))).toBe(false);
    expect(controlOwnsKey('number', key('s', { ctrl: true }))).toBe(false);
    expect(controlOwnsKey('number', key('5'))).toBe(true);
    expect(controlOwnsKey('number', key('Backspace'))).toBe(true);
    expect(controlOwnsKey('number', key('r'))).toBe(true);
  });

  it('keeps typing and editing chords in a text field and lets other chords past', () => {
    expect(controlOwnsKey('text', key(' '))).toBe(true);
    expect(controlOwnsKey('text', key('c', { ctrl: true }))).toBe(true);
    expect(controlOwnsKey('text', key('s', { ctrl: true }))).toBe(false);
  });

  it('keeps nothing where nothing is typed', () => {
    expect(controlOwnsKey('none', key(' '))).toBe(false);
  });
});
