// SPDX-License-Identifier: AGPL-3.0-or-later

import type { AppState } from '../app/store.js';
import { othersOf } from '../app/sources.js';
import type { ClipId, OthersView } from '../core/types.js';
import { displayTitle } from '../core/types.js';
import type { MenuEntry } from './menu.js';
import { resolveTheme, sourceTheme } from './theme.js';

/** How each way of showing the other sources is named. */
const OTHERS_LABELS: Readonly<Record<OthersView, string>> = {
  show: 'Show Others',
  dim: 'Dim Others',
  hide: 'Hide Others',
};

/** The name of an {@link OthersView}, for a menu or an announcement. */
export function othersLabel(mode: OthersView): string {
  return OTHERS_LABELS[mode];
}

/**
 * The Sources menu: every vocal source, the one in front checked, and how the rest are shown.
 *
 * @remarks Each source carries a dot in the colour its blobs are drawn in, so the menu and the
 * canvas name a source the same way.
 */
export function sourceMenu(
  state: AppState,
  focus: (clip: ClipId | null, others?: OthersView) => void,
): MenuEntry[] {
  const clips = state.edits?.clips ?? [];
  const active = state.layer[0] ?? null;
  const mode = othersOf(state.view);
  const theme = resolveTheme();
  const entries: MenuEntry[] = clips.map((clip) => ({
    label: displayTitle(clip),
    glyph: `<span class="axys-source-dot" style="background:${sourceTheme(theme, clip.id).blobBounds}"></span>`,
    checked: clip.id === active,
    run: () => {
      focus(clip.id);
    },
  }));
  entries.push({ separator: true });
  for (const choice of ['show', 'dim', 'hide'] as const) {
    entries.push({
      label: OTHERS_LABELS[choice],
      checked: mode === choice,
      enabled: clips.length > 1,
      run: () => {
        focus(active, choice);
      },
    });
  }
  return entries;
}
