// SPDX-License-Identifier: AGPL-3.0-or-later

import { sourceNames } from '../app/sources.js';
import type { AppState } from '../app/store.js';
import type { ClipId } from '../core/types.js';
import { clipOf, displayTitle } from '../core/types.js';
import { checkboxInput } from './controls/index.js';
import { resolveTheme, sourceTheme } from './theme.js';

/** A row of toggles naming the vocal sources an operation changes. */
export interface SourcePicker {
  /** The toggles, or `null` for a project with one source, which has nothing to choose. */
  element: HTMLElement | null;
  /** The sources ticked now, in the order the project holds them. */
  chosen(): ClipId[];
}

/**
 * The sources an operation starts on: those holding the selected blobs, or every one.
 *
 * @remarks A selection lies in the layer being edited, so its sources are the ones asked about.
 */
export function initialSources(state: AppState): ClipId[] {
  const clips = state.edits?.clips.map((clip) => clip.id) ?? [];
  const selected = new Set(state.selection.blobs.map((blob) => clipOf(blob)));
  return selected.size === 0 ? clips : clips.filter((clip) => selected.has(clip));
}

/**
 * Builds the toggles, ticking `initial`.
 *
 * @remarks Each carries a dot in its source's colour. `onChange` runs after every toggle, and the
 * last ticked toggle cannot be cleared, so an operation always has a source to change.
 */
export function sourcePicker(
  state: AppState,
  initial: readonly ClipId[],
  onChange: () => void,
): SourcePicker {
  const clips = state.edits?.clips ?? [];
  const boxes = new Map<ClipId, HTMLInputElement>();
  const chosen = (): ClipId[] =>
    clips.filter((clip) => boxes.get(clip.id)?.checked ?? true).map((clip) => clip.id);
  if (clips.length < 2) {
    return { element: null, chosen };
  }
  const group = document.createElement('fieldset');
  group.className = 'axys-source-grid';
  const legend = document.createElement('legend');
  legend.textContent = 'Sources';
  group.append(legend);
  const theme = resolveTheme();
  for (const clip of clips) {
    const wrapper = document.createElement('label');
    wrapper.className = 'axys-note-toggle';
    const box = checkboxInput();
    box.checked = initial.includes(clip.id);
    const dot = document.createElement('span');
    dot.className = 'axys-source-dot';
    dot.style.background = sourceTheme(theme, clip.id).blobBounds;
    const caption = document.createElement('span');
    caption.textContent = displayTitle(clip);
    wrapper.htmlFor = box.id;
    wrapper.append(box, dot, caption);
    box.addEventListener('change', () => {
      if (chosen().length === 0) box.checked = true;
      onChange();
    });
    boxes.set(clip.id, box);
    group.append(wrapper);
  }
  return { element: group, chosen };
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
  return many ? `Affects ${names}` : 'No selection. Affects whole project';
}
