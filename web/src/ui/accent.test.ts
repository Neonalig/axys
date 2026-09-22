// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { ACCENT_NAMES, accentTokens, contrastRatio, perceptualDistance } from './accent.js';
import { themeColors } from './theme.js';

/** Text on a coloured control must clear this, per WCAG AA at body size. */
const TEXT_FLOOR = 4.5;

/** A control's own colour against the surface behind it must clear this, per WCAG AA. */
const CHROME_FLOOR = 3;

describe('the accent ramp', () => {
  it('reproduces the published Cerulean hexes', () => {
    expect(accentTokens('cerulean', true).accent).toBe('#35a4ff');
    expect(accentTokens('cerulean', false).accent).toBe('#006cb4');
  });

  it('gives Slate the Cerulean hue at a lower chroma', () => {
    expect(accentTokens('slate', true).accent).not.toBe(accentTokens('cerulean', true).accent);
  });

  for (const name of ACCENT_NAMES) {
    it(`keeps ${name} legible in dark`, () => {
      const tokens = accentTokens(name, true);
      const dark = themeColors('dark', name);
      expect(contrastRatio(tokens.accentText, tokens.accent)).toBeGreaterThanOrEqual(TEXT_FLOOR);
      expect(contrastRatio(tokens.accent, dark.surfaceSunken)).toBeGreaterThanOrEqual(CHROME_FLOOR);
    });

    it(`keeps ${name} legible in light`, () => {
      const tokens = accentTokens(name, false);
      const light = themeColors('light', name);
      expect(contrastRatio(tokens.accentText, tokens.accent)).toBeGreaterThanOrEqual(TEXT_FLOOR);
      expect(contrastRatio(tokens.accent, light.surface)).toBeGreaterThanOrEqual(CHROME_FLOOR);
    });
  }

  /*
   * The semantic layers keep their own hues at every accent, so a selection has to stay tellable
   * from all four of them. Contrast ratio does not answer this: it says whether text on a colour
   * is readable, not whether two colours beside each other separate. The floor is an OKLab
   * distance, where roughly 0.02 is where a large area starts to read as a different colour at
   * all. The tightest pair in the shipped set is Abyssal against a MIDI note, at 0.088.
   */
  const SEPARATION_FLOOR = 0.06;

  for (const name of ACCENT_NAMES) {
    it(`keeps a ${name} selection apart from the semantic layers`, () => {
      const selection = accentTokens(name, true).selection;
      const dark = themeColors('dark', name);
      for (const layer of ['pitchDetected', 'pitchTarget', 'midiNote', 'playhead'] as const) {
        expect(perceptualDistance(selection, dark[layer])).toBeGreaterThanOrEqual(SEPARATION_FLOOR);
      }
    });
  }

  it('leaves High Contrast on its own accent', () => {
    for (const name of ACCENT_NAMES) {
      expect(themeColors('contrast', name).accent).toBe('#00e5ff');
    }
  });
});
