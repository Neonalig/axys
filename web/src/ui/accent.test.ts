// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { ACCENT_NAMES, accentTokens, contrastRatio } from './accent.js';
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

  it('leaves High Contrast on its own accent', () => {
    for (const name of ACCENT_NAMES) {
      expect(themeColors('contrast', name).accent).toBe('#00e5ff');
    }
  });
});
