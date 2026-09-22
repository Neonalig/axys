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
  /** Single key that runs this item while the menu is open, shown beside the label. */
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

/** Anything a menu may hold. */
export type MenuEntry = MenuItem | MenuSeparator;

/** Distance in pixels a menu is kept from the viewport edge. */
const MARGIN = 8;

function isItem(entry: MenuEntry): entry is MenuItem {
  return !('separator' in entry);
}

/**
 * Opens a context menu at a viewport position.
 *
 * @remarks Returns a function that closes it. Only one menu is open at a time: opening a second
 * closes the first. Closing always restores focus to whatever held it, so a menu dismissed with
 * Escape leaves the keyboard where it was.
 */
export function showContextMenu(
  entries: readonly MenuEntry[],
  at: { x: number; y: number },
): () => void {
  closeOpenMenu();

  const previous = document.activeElement;
  const element = document.createElement('div');
  element.className = 'axys-menu';
  element.setAttribute('role', 'menu');
  element.tabIndex = -1;

  const buttons: HTMLButtonElement[] = [];
  for (const entry of entries) {
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

    const label = document.createElement('span');
    label.textContent = entry.checked === true ? `${entry.label} ✓` : entry.label;
    button.append(label);

    if (entry.key !== undefined) {
      const key = document.createElement('kbd');
      key.className = 'axys-menu-key';
      key.textContent = entry.key.toUpperCase();
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
    const pressed = event.key.toLowerCase();
    for (const entry of entries) {
      if (!isItem(entry) || entry.key?.toLowerCase() !== pressed) {
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
    if (!(event.target instanceof Node) || !element.contains(event.target)) {
      close();
    }
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
    element.remove();
    if (previous instanceof HTMLElement) {
      previous.focus();
    }
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

/** Puts a menu at a position, flipped back inside the viewport at either edge. */
function place(element: HTMLElement, at: { x: number; y: number }): void {
  const bounds = element.getBoundingClientRect();
  const left = Math.min(at.x, Math.max(MARGIN, window.innerWidth - bounds.width - MARGIN));
  const top = Math.min(at.y, Math.max(MARGIN, window.innerHeight - bounds.height - MARGIN));
  element.style.left = `${String(Math.round(Math.max(MARGIN, left)))}px`;
  element.style.top = `${String(Math.round(Math.max(MARGIN, top)))}px`;
}
