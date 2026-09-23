// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Settings that belong to the person rather than to the project.
 *
 * How the editor presents itself follows someone between projects and should not travel with a
 * project document to somebody else's machine, so these live on the device. A browser that
 * refuses storage still runs; the settings simply start at their defaults each session.
 */

import type { FollowMode } from './store.js';
import type { TimeDisplay } from '../core/types.js';
import type { AccentName } from '../ui/accent.js';
import { ACCENT_NAMES, DEFAULT_ACCENT } from '../ui/accent.js';
import type { ThemeName } from '../ui/theme.js';

/** Theme choice, including deferring to the operating system. */
export type ThemeChoice = ThemeName | 'system';

/** Every display setting remembered on this device. */
export interface Preferences {
  /** Colour scheme, or `system` to follow the operating system as it changes. */
  theme: ThemeChoice;
  /** Which accent the chrome takes. High Contrast ignores it. */
  accent: AccentName;
  /** How the view keeps up once it is following. */
  followMode: FollowMode;
  /** Whether the ruler reads clock time or bars and beats. */
  timeDisplay: TimeDisplay;
  /** Whether the toolbar buttons carry their names beside their icons. */
  toolbarLabels: boolean;
  /** Whether the inspector starts folded away to its rail. */
  inspectorCollapsed: boolean;
  /** Whether the mixer starts folded away to its bar. */
  mixerCollapsed: boolean;
  /** How wide the inspector column is, in pixels. */
  inspectorWidth: number;
}

/** Narrowest the inspector column may be dragged, in pixels. */
export const INSPECTOR_MIN_WIDTH = 256;

/** Widest the inspector column may be dragged, in pixels. */
export const INSPECTOR_MAX_WIDTH = 640;

/** The width the inspector column opens at. */
export const INSPECTOR_DEFAULT_WIDTH = 344;

/** A stored or dragged width, held inside the bounds the column may take. */
export function clampInspectorWidth(value: number): number {
  if (!Number.isFinite(value)) return INSPECTOR_DEFAULT_WIDTH;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, Math.round(value)));
}

/** Local storage key holding the settings document. */
const KEY = 'axys.preferences';

const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'dark', 'light', 'contrast'];
const FOLLOW_MODES: readonly FollowMode[] = ['page', 'centre'];
const TIME_DISPLAYS: readonly TimeDisplay[] = ['seconds', 'barsBeats'];

/** The settings a device with nothing stored starts from. */
export function defaultPreferences(): Preferences {
  return {
    theme: 'system',
    accent: DEFAULT_ACCENT,
    followMode: 'centre',
    timeDisplay: 'seconds',
    toolbarLabels: false,
    inspectorCollapsed: false,
    mixerCollapsed: true,
    inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  };
}

/** Reads the stored settings, falling back to the defaults value by value. */
export function loadPreferences(): Preferences {
  const defaults = defaultPreferences();
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return defaults;
  }
  if (raw === null) {
    return defaults;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaults;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return defaults;
  }
  const record = parsed as Record<string, unknown>;
  return {
    theme: oneOf(record['theme'], THEME_CHOICES, defaults.theme),
    accent: oneOf(record['accent'], ACCENT_NAMES, defaults.accent),
    followMode: oneOf(record['followMode'], FOLLOW_MODES, defaults.followMode),
    timeDisplay: oneOf(record['timeDisplay'], TIME_DISPLAYS, defaults.timeDisplay),
    toolbarLabels:
      typeof record['toolbarLabels'] === 'boolean'
        ? record['toolbarLabels']
        : defaults.toolbarLabels,
    inspectorCollapsed:
      typeof record['inspectorCollapsed'] === 'boolean'
        ? record['inspectorCollapsed']
        : defaults.inspectorCollapsed,
    mixerCollapsed:
      typeof record['mixerCollapsed'] === 'boolean'
        ? record['mixerCollapsed']
        : defaults.mixerCollapsed,
    inspectorWidth:
      typeof record['inspectorWidth'] === 'number'
        ? clampInspectorWidth(record['inspectorWidth'])
        : defaults.inspectorWidth,
  };
}

/** Merges a change into the stored settings and returns the result. */
export function savePreferences(patch: Partial<Preferences>): Preferences {
  const merged = { ...loadPreferences(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // The settings still apply for this session, which is the most a refusing browser allows.
  }
  return merged;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}
