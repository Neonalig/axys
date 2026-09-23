// SPDX-License-Identifier: AGPL-3.0-or-later

/** The browser running the page, by its product name and major version. */
export interface BrowserInfo {
  name: string;
  /** Major version, or `null` when the user agent does not give one. */
  version: string | null;
}

/** User agent tokens in the order they must be tested, since most browsers also claim Chrome. */
const PRODUCTS: readonly (readonly [token: string, name: string])[] = [
  ['Edg', 'Edge'],
  ['EdgiOS', 'Edge'],
  ['EdgA', 'Edge'],
  ['OPR', 'Opera'],
  ['SamsungBrowser', 'Samsung Internet'],
  ['Vivaldi', 'Vivaldi'],
  ['FxiOS', 'Firefox'],
  ['Firefox', 'Firefox'],
  ['CriOS', 'Chrome'],
  ['Chrome', 'Chrome'],
];

/** Identifies the browser from its user agent string. */
export function detectBrowser(): BrowserInfo {
  let agent: string;
  try {
    agent = globalThis.navigator?.userAgent ?? '';
  } catch {
    agent = '';
  }
  for (const [token, name] of PRODUCTS) {
    const version = majorAfter(agent, token);
    if (version === undefined) continue;
    return { name: name === 'Chrome' && isBrave() ? 'Brave' : name, version };
  }
  if (agent.includes('Safari/')) {
    return { name: 'Safari', version: majorAfter(agent, 'Version') ?? null };
  }
  return { name: 'this browser', version: null };
}

/** The browser as prose, such as "Firefox 131". */
export function browserLabel(browser: BrowserInfo = detectBrowser()): string {
  return browser.version === null ? browser.name : `${browser.name} ${browser.version}`;
}

/** The major version after `token/`, `null` for a bare token, or `undefined` when absent. */
function majorAfter(agent: string, token: string): string | null | undefined {
  const match = new RegExp(`(?:^|[\\s(;])${token}/(\\d+)?`).exec(agent);
  if (match === null) return undefined;
  return match[1] ?? null;
}

/** Brave reports itself as Chrome and only identifies itself through `navigator.brave`. */
function isBrave(): boolean {
  try {
    return typeof (globalThis.navigator as { brave?: unknown } | undefined)?.brave === 'object';
  } catch {
    return false;
  }
}
