// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceNames } from '../app/sources.js';
import type { AppState } from '../app/store.js';
import type { ClipId } from '../core/types.js';
import { clipOf, displayTitle } from '../core/types.js';
import { field, selectInput } from './controls/index.js';
import { resolveTheme, sourceTheme } from './theme.js';

/** A drop-down naming the vocal sources an operation changes: one of them, or all. */
export interface SourcePicker {
  /** The field, or `null` for a project with one source, which has nothing to choose. */
  element: HTMLElement | null;
  /** The sources chosen now, in the order the project holds them. */
  chosen(): ClipId[];
}

/** Value of the option standing for every source. */
const ALL = 'all';

/**
 * The source an operation starts on, or `null` for all of them.
 *
 * @remarks The source holding the selected blobs when they share one, all when they span
 * several, and otherwise the source in front of the editor.
 */
export function initialSource(state: AppState): ClipId | null {
  const selected = new Set(state.selection.blobs.map((blob) => clipOf(blob)));
  if (selected.size > 1) return null;
  const [only] = selected;
  return only ?? state.layer[0] ?? null;
}

/**
 * Builds the drop-down, starting on {@link initialSource}.
 *
 * @remarks Each source carries a dot in its colour. `onChange` runs after every choice.
 */
export function sourcePicker(state: AppState, onChange: () => void): SourcePicker {
  const clips = state.edits?.clips ?? [];
  const every = (): ClipId[] => clips.map((clip) => clip.id);
  if (clips.length < 2) {
    return { element: null, chosen: every };
  }
  const theme = resolveTheme();
  const select = selectInput([
    { value: ALL, label: 'All Sources' },
    ...clips.map((clip) => ({
      value: String(clip.id),
      label: displayTitle(clip),
      glyph: `<span class="axys-source-dot" style="background:${sourceTheme(theme, clip.id).blobBounds}"></span>`,
    })),
  ]);
  const start = initialSource(state);
  select.value = start === null ? ALL : String(start);
  select.addEventListener('change', onChange);
  const chosen = (): ClipId[] =>
    select.value === ALL ? every() : every().filter((clip) => String(clip) === select.value);
  return { element: field('Source', select, 'Vocal sources to change'), chosen };
}

/**
 * What an operation will change, as a line under its controls.
 *
 * @remarks Names the sources whenever the project has more than one, so nothing is changed on a
 * source nobody was looking at.
 */
export function scopeText(state: AppState, clips: readonly ClipId[]): string {
  const many = (state.edits?.clips.length ?? 0) > 1;
  const names = sourceNames(state.edits, clips);
  const count = state.selection.blobs.filter((blob) => clips.includes(clipOf(blob))).length;
  if (count > 0) {
    const what = `${String(count)} selected ${count === 1 ? 'blob' : 'blobs'}`;
    return many ? `Affects ${what} in ${names}` : `Affects ${what}`;
  }
  return many ? `Affects ${names}` : 'Affects the whole project';
}
