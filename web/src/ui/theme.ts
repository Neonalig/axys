// SPDX-License-Identifier: AGPL-3.0-or-later

/** Selectable colour scheme. */
export type ThemeName = 'dark' | 'light' | 'contrast';

/** Every theme in selection order. */
export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'contrast'];

/** Short Title Case label per theme, for menus and buttons. */
export const THEME_LABELS: Readonly<Record<ThemeName, string>> = {
  dark: 'Dark Theme',
  light: 'Light Theme',
  contrast: 'High Contrast',
};

/**
 * Every colour token the application and the canvas layers may use.
 *
 * @remarks Each token maps to the CSS custom property `--axys-<kebab-case-name>`.
 */
export const THEME_TOKENS = [
  'bg',
  'surface',
  'surfaceRaised',
  'surfaceSunken',
  'border',
  'borderStrong',
  'text',
  'textMuted',
  'accent',
  'accentText',
  'focus',
  'danger',
  'warning',
  'success',
  'shadow',
  'gridLine',
  'gridLineOctave',
  'gridLabel',
  'rulerBg',
  'rulerText',
  'waveform',
  'pitchDetected',
  'pitchTarget',
  'blobFill',
  'blobFillSelected',
  'blobBounds',
  'blobOriginal',
  'selection',
  'selectionFill',
  'handle',
  'handleActive',
  'playhead',
  'loopRange',
  'loopEdge',
  'midiNote',
  'midiNoteActive',
  'midiLink',
  'confidenceHigh',
  'confidenceLow',
  'unvoiced',
  'conflict',
] as const;

/** Name of one colour token. */
export type TokenName = (typeof THEME_TOKENS)[number];

/** Resolved colour per token, ready for Canvas 2D or inline styling. */
export type Theme = Readonly<Record<TokenName, string>>;

const DARK: Theme = {
  bg: '#0e1116',
  surface: '#161b22',
  surfaceRaised: '#1e242d',
  surfaceSunken: '#0a0d12',
  border: '#2a323d',
  borderStrong: '#3d4756',
  text: '#e6edf3',
  textMuted: '#9aa7b4',
  accent: '#4cc2ff',
  accentText: '#04121c',
  focus: '#7fd6ff',
  danger: '#ff6b6b',
  warning: '#ffb454',
  success: '#56d364',
  shadow: '#00000080',
  gridLine: '#222a34',
  gridLineOctave: '#3a4552',
  gridLabel: '#8b98a5',
  rulerBg: '#12171e',
  rulerText: '#a9b6c2',
  waveform: '#33465c',
  pitchDetected: '#6fe3b0',
  pitchTarget: '#ffd166',
  blobFill: '#2f5d8c59',
  blobFillSelected: '#3f8fd680',
  blobBounds: '#8fb8e0',
  blobOriginal: '#c9a227',
  selection: '#4cc2ff',
  selectionFill: '#4cc2ff33',
  handle: '#f2f7fb',
  handleActive: '#ffd166',
  playhead: '#ff79c6',
  loopRange: '#a179ff2e',
  loopEdge: '#a179ff',
  midiNote: '#b78bff',
  midiNoteActive: '#ded0ff',
  midiLink: '#7c5cc4',
  confidenceHigh: '#6fe3b0',
  confidenceLow: '#4f6b78',
  unvoiced: '#6b7785',
  conflict: '#ff4d4d',
};

const LIGHT: Theme = {
  bg: '#f6f8fa',
  surface: '#ffffff',
  surfaceRaised: '#ffffff',
  surfaceSunken: '#eceff3',
  border: '#d3dae1',
  borderStrong: '#aab6c2',
  text: '#101820',
  textMuted: '#5a6773',
  accent: '#0b6bcb',
  accentText: '#ffffff',
  focus: '#0b6bcb',
  danger: '#c02626',
  warning: '#9a5b00',
  success: '#1a7f37',
  shadow: '#10182026',
  gridLine: '#e3e8ee',
  gridLineOctave: '#c1ccd8',
  gridLabel: '#5a6773',
  rulerBg: '#eef2f6',
  rulerText: '#3c4854',
  waveform: '#b9c7d6',
  pitchDetected: '#0f7a55',
  pitchTarget: '#b26a00',
  blobFill: '#0b6bcb24',
  blobFillSelected: '#0b6bcb45',
  blobBounds: '#2a6ea8',
  blobOriginal: '#a8760a',
  selection: '#0b6bcb',
  selectionFill: '#0b6bcb26',
  handle: '#16202b',
  handleActive: '#b26a00',
  playhead: '#d81b60',
  loopRange: '#6b3fd426',
  loopEdge: '#6b3fd4',
  midiNote: '#6b3fd4',
  midiNoteActive: '#3f1e94',
  midiLink: '#9a86d6',
  confidenceHigh: '#0f7a55',
  confidenceLow: '#9aa8b4',
  unvoiced: '#8a97a3',
  conflict: '#c02626',
};

const CONTRAST: Theme = {
  bg: '#000000',
  surface: '#000000',
  surfaceRaised: '#0d0d0d',
  surfaceSunken: '#000000',
  border: '#ffffff',
  borderStrong: '#ffffff',
  text: '#ffffff',
  textMuted: '#e4e4e4',
  accent: '#00e5ff',
  accentText: '#000000',
  focus: '#ffff00',
  danger: '#ff5252',
  warning: '#ffd400',
  success: '#00e676',
  shadow: '#000000',
  gridLine: '#4d4d4d',
  gridLineOctave: '#ffffff',
  gridLabel: '#ffffff',
  rulerBg: '#000000',
  rulerText: '#ffffff',
  waveform: '#7a7a7a',
  pitchDetected: '#00ff9c',
  pitchTarget: '#ffd400',
  blobFill: '#00e5ff26',
  blobFillSelected: '#00e5ff59',
  blobBounds: '#00e5ff',
  blobOriginal: '#ffd400',
  selection: '#ffffff',
  selectionFill: '#ffffff33',
  handle: '#ffffff',
  handleActive: '#ffd400',
  playhead: '#ff6ec7',
  loopRange: '#b388ff40',
  loopEdge: '#b388ff',
  midiNote: '#b388ff',
  midiNoteActive: '#e6d9ff',
  midiLink: '#8a63d2',
  confidenceHigh: '#00ff9c',
  confidenceLow: '#909090',
  unvoiced: '#bdbdbd',
  conflict: '#ff1744',
};

const PALETTES: Readonly<Record<ThemeName, Theme>> = {
  dark: DARK,
  light: LIGHT,
  contrast: CONTRAST,
};

/** Whether a theme paints light content on a dark ground. */
export function isDarkTheme(name: ThemeName): boolean {
  return name !== 'light';
}

/** CSS custom property name for a colour token. */
export function cssVariable(token: TokenName): string {
  return `--axys-${token.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Authored colours of a theme, before any stylesheet override. */
export function themeColors(name: ThemeName): Theme {
  return PALETTES[name];
}

/**
 * Writes a theme's tokens onto an element and marks it with `data-theme`.
 *
 * @remarks Call before the first paint; the stylesheet carries no colour values of its own.
 */
export function applyTheme(name: ThemeName, root: HTMLElement = document.documentElement): void {
  const colors = PALETTES[name];
  const changed = root.dataset['theme'] !== undefined && root.dataset['theme'] !== name;
  for (const token of THEME_TOKENS) {
    root.style.setProperty(cssVariable(token), colors[token]);
  }
  root.dataset['theme'] = name;
  root.style.colorScheme = isDarkTheme(name) ? 'dark' : 'light';
  if (changed) {
    crossFade(root);
  }
}

/**
 * Eases the chrome from one palette to the next.
 *
 * @remarks The class is on only for the length of the change. Left on, its colour transition
 * would also ease every hover and pressed state underneath it.
 */
function crossFade(root: HTMLElement): void {
  root.classList.add('is-theme-changing');
  if (crossFadeTimer !== null) {
    clearTimeout(crossFadeTimer);
  }
  crossFadeTimer = setTimeout(() => {
    crossFadeTimer = null;
    root.classList.remove('is-theme-changing');
  }, CROSS_FADE_MS);
}

/** Length of the palette cross-fade, matching `--axys-duration-slow`. */
const CROSS_FADE_MS = 240;

let crossFadeTimer: ReturnType<typeof setTimeout> | null = null;

/** Theme currently applied to an element, or the dark default. */
export function currentTheme(root: HTMLElement = document.documentElement): ThemeName {
  const applied = root.dataset['theme'];
  return THEME_NAMES.find((name) => name === applied) ?? 'dark';
}

/**
 * Colours as they actually resolve on an element, honouring stylesheet overrides.
 *
 * @remarks Reads computed style, so call it once per theme change rather than per frame.
 */
export function resolveTheme(root: HTMLElement = document.documentElement): Theme {
  const computed = getComputedStyle(root);
  const fallback = PALETTES[currentTheme(root)];
  const resolved: Record<TokenName, string> = { ...fallback };
  for (const token of THEME_TOKENS) {
    const value = computed.getPropertyValue(cssVariable(token)).trim();
    if (value.length > 0) {
      resolved[token] = value;
    }
  }
  return resolved;
}

/** Theme matching the operating system's colour and contrast preferences. */
export function preferredTheme(): ThemeName {
  if (typeof matchMedia !== 'function') {
    return 'dark';
  }
  if (matchMedia('(prefers-contrast: more)').matches) {
    return 'contrast';
  }
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Reports the preferred theme whenever the system preference changes. Returns a disposer. */
export function watchPreferredTheme(onChange: (name: ThemeName) => void): () => void {
  if (typeof matchMedia !== 'function') {
    return () => {};
  }
  const queries = [
    matchMedia('(prefers-color-scheme: light)'),
    matchMedia('(prefers-contrast: more)'),
  ];
  const listener = (): void => {
    onChange(preferredTheme());
  };
  for (const query of queries) {
    query.addEventListener('change', listener);
  }
  return () => {
    for (const query of queries) {
      query.removeEventListener('change', listener);
    }
  };
}
