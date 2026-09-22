// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Context menus for the editor canvas.
 *
 * Actions that belong to one object are reached on that object rather than by finding the right
 * toolbar button, which keeps the toolbar to the things that have no object to sit on. Each item
 * names its key and that key runs it while the menu is open, so the menu also teaches the
 * shortcut rather than hiding it.
 */

/** One runnable entry. */
export interface MenuItem {
  label: string;
  /** Icon drawn ahead of the label, the same one the command's button carries. */
  icon?: IconName;
  /**
   * Markup drawn in the icon column instead of `icon`.
   *
   * @remarks For a music glyph, which is a run of text in another font rather than an icon. The
   * markup is author-controlled; never pass anything a person typed.
   */
  glyph?: string;
  /**
   * The shortcut this item's command carries, shown beside the label.
   *
   * @remarks A plain single key also runs the item while the menu is open. A chord is shown but
   * not matched here, because the chord already works with the menu closed.
   */
  key?: string;
  /** Whether the item can run. A disabled item is shown, so the menu does not change shape. */
  enabled?: boolean;
  /** Shows a mark against the label, for a setting the item toggles. */
  checked?: boolean;
  run(): void;
}

/** A rule between groups of entries. */
export interface MenuSeparator {
  separator: true;
}

/**
 * A row the caller draws itself, for a choice a list of labels cannot carry.
 *
 * @remarks The row owns its own keyboard handling and is skipped by the menu's own arrow-key
 * walk, so only use it where a plain item genuinely will not do: a grid of colour swatches is
 * the case it exists for.
 */
export interface MenuCustom {
  /** Builds the row. `close` dismisses the menu, for a row that acts on a press. */
  render(close: () => void): HTMLElement;
}

/** Anything a menu may hold. */
export type MenuEntry = MenuItem | MenuSeparator | MenuCustom;

import { ICONS } from './icons.js';
import type { IconName } from './icons.js';
import { animateOut } from './motion.js';

/** Distance in pixels a menu is kept from the viewport edge. */
const MARGIN = 8;

function isItem(entry: MenuEntry): entry is MenuItem {
  return !('separator' in entry) && !('render' in entry);
}

/**
 * Opens a context menu at a viewport position.
 *
 * @remarks Returns a function that closes it. Only one menu is open at a time: opening a second
 * closes the first. Closing always restores focus to whatever held it, so a menu dismissed with
 * Escape leaves the keyboard where it was.
 *
 * `opener` is the control the menu hangs off, and pressing that control again closes the menu
 * rather than opening a second one. The press that dismisses a menu arrives before the click
 * that would reopen it, so the opener is remembered for as long as that pair takes.
 */
export function showContextMenu(
  entries: readonly MenuEntry[],
  at: { x: number; y: number },
  opener?: Element,
): () => void {
  if (opener !== undefined && dismissedBy(opener)) {
    return () => {};
  }
  closeOpenMenu();

  const previous = document.activeElement;
  const element = document.createElement('div');
  element.className = 'axys-menu';
  element.setAttribute('role', 'menu');
  element.tabIndex = -1;

  const buttons: HTMLButtonElement[] = [];
  for (const entry of entries) {
    if ('render' in entry) {
      element.append(
        entry.render(() => {
          close();
        }),
      );
      continue;
    }
    if (!isItem(entry)) {
      const rule = document.createElement('div');
      rule.className = 'axys-menu-separator';
      rule.setAttribute('role', 'separator');
      element.append(rule);
      continue;
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'axys-menu-item';
    button.setAttribute('role', 'menuitem');
    button.disabled = entry.enabled === false;

    // Every item carries the icon its toolbar button carries, so the same action is recognised
    // in either place. An entry without one keeps the column, so the labels stay aligned.
    const mark = document.createElement('span');
    mark.className = 'axys-menu-icon';
    mark.innerHTML = entry.glyph ?? (entry.icon === undefined ? '' : ICONS[entry.icon]);
    const label = document.createElement('span');
    label.className = 'axys-menu-label';
    label.textContent = entry.checked === true ? `${entry.label} ✓` : entry.label;
    button.append(mark, label);

    if (entry.key !== undefined) {
      const key = document.createElement('kbd');
      key.className = 'axys-menu-key';
      key.textContent = entry.key;
      button.append(key);
    }

    button.addEventListener('click', () => {
      close();
      entry.run();
    });
    element.append(button);
    buttons.push(button);
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const pressed = event.key.toLowerCase();
    for (const entry of entries) {
      if (!isItem(entry) || entry.key?.length !== 1 || entry.key.toLowerCase() !== pressed) {
        continue;
      }
      event.preventDefault();
      if (entry.enabled === false) {
        return;
      }
      close();
      entry.run();
      return;
    }
  };

  const move = (step: number): void => {
    const usable = buttons.filter((button) => !button.disabled);
    if (usable.length === 0) {
      return;
    }
    const current = usable.indexOf(document.activeElement as HTMLButtonElement);
    const next = usable[(current + step + usable.length) % usable.length];
    next?.focus();
  };

  const onPointerDown = (event: Event): void => {
    if (event.target instanceof Node && element.contains(event.target)) {
      return;
    }
    // A press on the control the menu hangs off is the control being pressed again, which means
    // close. Without this the press dismisses the menu and the click that follows reopens it.
    if (opener !== undefined && event.target instanceof Node && opener.contains(event.target)) {
      dismissedAt = { opener, when: Date.now() };
    }
    close();
  };

  let closed = false;
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    openMenu = null;
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('blur', close);
    window.removeEventListener('resize', close);
    // Focus goes back before the exit plays, so the keyboard is never parked on a leaving menu.
    if (previous instanceof HTMLElement) {
      previous.focus();
    }
    animateOut(element, 'is-leaving', () => {
      element.remove();
    });
  };

  element.addEventListener('keydown', onKeyDown);
  document.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('blur', close);
  window.addEventListener('resize', close);

  document.body.append(element);
  place(element, at);
  (buttons.find((button) => !button.disabled) ?? element).focus();

  openMenu = close;
  return close;
}

/** Closes whichever menu is open, if any. */
export function closeOpenMenu(): void {
  openMenu?.();
}

let openMenu: (() => void) | null = null;

/** The control whose own press dismissed a menu, and when. */
let dismissedAt: { opener: Element; when: number } | null = null;

/** How long after a press dismisses a menu the click from that press is ignored. */
const REOPEN_GUARD_MS = 400;

/** Whether this control's own press has just closed its menu, so it must not reopen it. */
function dismissedBy(opener: Element): boolean {
  const dismissed = dismissedAt;
  dismissedAt = null;
  return (
    dismissed !== null &&
    dismissed.opener === opener &&
    Date.now() - dismissed.when < REOPEN_GUARD_MS
  );
}

/** Puts a menu at a position, flipped back inside the viewport at either edge. */
function place(element: HTMLElement, at: { x: number; y: number }): void {
  const bounds = element.getBoundingClientRect();
  const left = Math.min(at.x, Math.max(MARGIN, window.innerWidth - bounds.width - MARGIN));
  const top = Math.min(at.y, Math.max(MARGIN, window.innerHeight - bounds.height - MARGIN));
  element.style.left = `${String(Math.round(Math.max(MARGIN, left)))}px`;
  element.style.top = `${String(Math.round(Math.max(MARGIN, top)))}px`;
}
