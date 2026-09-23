// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The command palette and the keyboard cheatsheet.
 *
 * Both read the same command list the toolbar and the menus read, so a command reaches the
 * palette and the cheatsheet by existing rather than by being registered a second time. Nothing
 * here knows what a command does.
 */

import { keycaps } from './keys.js';
import { Dialog } from './dialog.js';
import type { SearchableCommand } from './shell.js';
import { ICONS } from './icons.js';

/** What the palette needs in order to offer and run a command. */
export interface PaletteOptions {
  /** Every command, in the order the toolbar groups them. */
  commands: readonly SearchableCommand[];
  /** Whether a command can run against the current state. */
  isEnabled(id: string): boolean;
  /** Runs a command. */
  run(id: string): void;
}

/** Commands offered at once before the list is cut off. */
const MAX_RESULTS = 12;

/**
 * Opens the command palette.
 *
 * @remarks Returns the panel, so a second press of the shortcut closes it rather than stacking
 * another. Matching is a subsequence over the label and its group, which is what lets `expwav`
 * find Export Audio without anybody maintaining a keyword list.
 */
export function showCommandPalette(options: PaletteOptions): Dialog {
  const content = document.createElement('div');
  content.className = 'axys-palette';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'axys-palette-search';
  search.placeholder = 'Search commands';
  search.setAttribute('aria-label', 'Search Commands');
  search.autocomplete = 'off';
  search.spellcheck = false;
  search.setAttribute('role', 'combobox');
  search.setAttribute('aria-expanded', 'true');
  search.setAttribute('aria-controls', 'axys-palette-results');

  const results = document.createElement('div');
  results.className = 'axys-palette-results';
  results.id = 'axys-palette-results';
  results.setAttribute('role', 'listbox');

  const empty = document.createElement('p');
  empty.className = 'axys-hint';
  empty.textContent = 'No matching commands';
  empty.hidden = true;

  content.append(search, results, empty);

  const dialog = Dialog.open({ title: 'Commands', icon: 'search', content });

  let shown: SearchableCommand[] = [];
  let active = 0;

  const paint = (): void => {
    const query = search.value.trim().toLowerCase();
    shown = rank(options.commands, query).slice(0, MAX_RESULTS);
    active = 0;
    results.replaceChildren();
    for (const [index, command] of shown.entries()) {
      results.append(row(command, index));
    }
    empty.hidden = shown.length > 0;
    mark();
  };

  const row = (command: SearchableCommand, index: number): HTMLElement => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'axys-palette-item';
    item.setAttribute('role', 'option');
    item.disabled = !options.isEnabled(command.id);

    const glyph = document.createElement('span');
    glyph.className = 'axys-menu-icon';
    glyph.innerHTML = ICONS[command.icon];

    const label = document.createElement('span');
    label.className = 'axys-menu-label';
    label.textContent = command.label;

    const group = document.createElement('span');
    group.className = 'axys-palette-group';
    group.textContent = command.group;

    item.append(glyph, label, group);
    if (command.shortcut !== undefined) {
      const key = keycaps(command.shortcut);
      key.classList.add('axys-menu-key');
      item.append(key);
    }
    item.addEventListener('click', () => {
      choose(index);
    });
    return item;
  };

  /** Shows which row Enter would run. The field keeps the caret, so the mark is not focus. */
  const mark = (): void => {
    for (const [index, child] of [...results.children].entries()) {
      const on = index === active;
      child.classList.toggle('is-active', on);
      child.setAttribute('aria-selected', String(on));
      if (on) {
        child.scrollIntoView({ block: 'nearest' });
        search.setAttribute('aria-activedescendant', idFor(child, index));
      }
    }
    if (shown.length === 0) {
      search.removeAttribute('aria-activedescendant');
    }
  };

  const move = (by: number): void => {
    if (shown.length === 0) return;
    active = (active + by + shown.length) % shown.length;
    mark();
  };

  const choose = (index: number): void => {
    const command = shown[index];
    if (command === undefined || !options.isEnabled(command.id)) return;
    dialog.close();
    options.run(command.id);
  };

  search.addEventListener('input', paint);
  search.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      active = event.key === 'Home' ? 0 : shown.length - 1;
      mark();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(active);
    }
  });

  paint();
  search.focus();
  return dialog;
}

/** Opens the keyboard cheatsheet over the commands that carry a shortcut. */
export function showCheatsheet(commands: readonly SearchableCommand[]): Dialog {
  const content = document.createElement('div');
  content.className = 'axys-cheatsheet';

  const groups = new Map<string, SearchableCommand[]>();
  for (const command of commands) {
    if (command.shortcut === undefined) continue;
    const bucket = groups.get(command.group);
    if (bucket) bucket.push(command);
    else groups.set(command.group, [command]);
  }

  for (const [group, entries] of groups) {
    const section = document.createElement('section');
    section.className = 'axys-cheatsheet-group';
    const heading = document.createElement('h3');
    heading.textContent = group;
    section.append(heading);

    const list = document.createElement('dl');
    for (const command of entries) {
      const name = document.createElement('dt');
      name.textContent = command.label;
      const key = document.createElement('dd');
      if (command.shortcut !== undefined) {
        const chord = keycaps(command.shortcut);
        chord.classList.add('axys-menu-key');
        key.append(chord);
      }
      list.append(name, key);
    }
    section.append(list);
    content.append(section);
  }

  return Dialog.open({ title: 'Keyboard Shortcuts', icon: 'help', content });
}

/**
 * The commands matching a query, best first.
 *
 * @remarks A subsequence match rather than a substring one, so `expwav` finds Export Audio. An
 * exact prefix of the label sorts first, then a whole-word match, then the rest in the order the
 * toolbar lists them. An empty query is every command in that order.
 */
function rank(commands: readonly SearchableCommand[], query: string): SearchableCommand[] {
  if (query === '') return [...commands];
  const scored: { command: SearchableCommand; score: number }[] = [];
  for (const command of commands) {
    const haystack = `${command.label} ${command.group}`.toLowerCase();
    if (!subsequence(haystack, query)) continue;
    const label = command.label.toLowerCase();
    const score = label.startsWith(query) ? 0 : label.includes(query) ? 1 : 2;
    scored.push({ command, score });
  }
  return scored
    .map((entry, index) => ({ ...entry, index }))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .map((entry) => entry.command);
}

/** Whether every character of `query` appears in `text`, in order. */
function subsequence(text: string, query: string): boolean {
  let at = 0;
  for (const character of query) {
    if (character === ' ') continue;
    at = text.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

/** A stable id per row, so the field can name the row it would run. */
function idFor(element: Element, index: number): string {
  const id = `axys-palette-option-${String(index)}`;
  element.id = id;
  return id;
}
