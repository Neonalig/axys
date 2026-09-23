// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

import { browserLabel, detectBrowser } from './browser';

function agent(userAgent: string, extra: Record<string, unknown> = {}): void {
  vi.stubGlobal('navigator', { userAgent, ...extra });
}

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

describe('detectBrowser', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the browser behind the Chrome token', () => {
    agent(CHROME);
    expect(browserLabel()).toBe('Chrome 140');
    agent(`${CHROME} Edg/140.0.3485.54`);
    expect(browserLabel()).toBe('Edge 140');
    agent(`${CHROME} OPR/124.0.0.0`);
    expect(browserLabel()).toBe('Opera 124');
    agent(CHROME, { brave: {} });
    expect(browserLabel()).toBe('Brave 140');
  });

  it('reads Firefox and Safari', () => {
    agent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0');
    expect(browserLabel()).toBe('Firefox 143');
    agent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
    );
    expect(browserLabel()).toBe('Safari 26');
  });

  it('falls back to a generic name for an unknown agent', () => {
    agent('SomethingElse/1.0');
    expect(detectBrowser()).toEqual({ name: 'this browser', version: null });
  });
});
