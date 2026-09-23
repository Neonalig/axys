// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { chordKeys } from './keys.js';

describe('chordKeys', () => {
  it('splits a chord into its keys', () => {
    expect(chordKeys('Ctrl+Shift+V')).toEqual(['Ctrl', 'Shift', 'V']);
    expect(chordKeys('Q')).toEqual(['Q']);
    expect(chordKeys('F1')).toEqual(['F1']);
    expect(chordKeys('Alt+[')).toEqual(['Alt', '[']);
    expect(chordKeys('Ctrl++')).toEqual(['Ctrl', '+']);
  });

  it('refuses what is not a chord, so bracketed text stays text', () => {
    expect(chordKeys('3 blobs')).toBeNull();
    expect(chordKeys('Hz')).toBeNull();
  });
});
