// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A drop-down built out of the context menu, in place of a native `select`.
 *
 * A native `option` holds text and nothing else, which is what stops an accidental style offering
 * its accidental or a snap division offering its note. `ui/menu.ts` already does per-item icons,
 * check marks, disabled state and shortcut hints, so the list is that menu and the closed control
 * is a button wearing the chosen option's face.
 *
 * Combobox semantics are kept whole: the trigger is a `combobox` owning a list, typing a letter
 * jumps to the next option starting with it, Home and End go to the ends, Escape dismisses without
 * choosing, and focus returns to the trigger either way.
 */

import { ICONS } from '../icons.js';
import type { IconName } from '../icons.js';
import { showContextMenu } from '../menu.js';
import type { MenuEntry } from '../menu.js';
import { nextControlId } from './field.js';

/** One choice a select offers. */
export interface SelectOption {
  /** The value this option stands for, unique within the select. */
  value: string;
  /** What the option is called, in the list and on the closed control. */
  label: string;
  /** Glyph drawn ahead of the label, in the list and on the closed control. */
  icon?: IconName;
  /**
   * Markup drawn ahead of the label instead of `icon`.
   *
   * @remarks For a music glyph, which is a run of text in another font rather than an icon. The
   * markup is author-controlled; never pass anything a person typed.
   */
  glyph?: string;
  /** Whether the option can be chosen. A disabled option is shown, so the list keeps its shape. */
  enabled?: boolean;
}

/**
 * The closed control.
 *
 * @remarks It carries `value` and fires `change`, the two things a native `select` was used for,
 * so a field holding one needs to know nothing else about it.
 */
export interface SelectElement extends HTMLButtonElement {
  /** The chosen option's value. Setting it repaints without firing `change`. */
  value: string;
  /** Replaces the options, keeping the chosen value when it is still among them. */
  setOptions(options: readonly SelectOption[]): void;
}

/** Milliseconds of quiet after which type-to-select starts a new search. */
const TYPE_AHEAD_MS = 800;

/**
 * Builds a select over a fixed option list.
 *
 * @remarks Fires `change` only when a press or a key lands on a different value, never when the
 * value is set from code, so a select can be driven from application state without echoing back.
 */
export function selectInput(options: readonly SelectOption[]): SelectElement {
  let choices = [...options];
  let value = choices[0]?.value ?? '';
  let typed = '';
  let typedAt = 0;

  const element = document.createElement('button') as SelectElement;
  element.type = 'button';
  element.className = 'axys-select';
  element.id = nextControlId('select');
  element.setAttribute('role', 'combobox');
  element.setAttribute('aria-haspopup', 'listbox');
  element.setAttribute('aria-expanded', 'false');

  const face = document.createElement('span');
  face.className = 'axys-select-face';
  const caret = document.createElement('span');
  caret.className = 'axys-select-caret';
  caret.innerHTML = ICONS.caret;
  element.append(face, caret);

  const paint = (): void => {
    const option = choices.find((entry) => entry.value === value);
    face.replaceChildren();
    if (option === undefined) {
      return;
    }
    if (option.glyph !== undefined || option.icon !== undefined) {
      const mark = document.createElement('span');
      mark.className = 'axys-select-mark';
      mark.innerHTML = option.glyph ?? ICONS[option.icon as IconName];
      face.append(mark);
    }
    const text = document.createElement('span');
    text.className = 'axys-select-label';
    text.textContent = option.label;
    face.append(text);
  };

  const choose = (next: string): void => {
    if (next === value) {
      return;
    }
    value = next;
    paint();
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /** Moves the choice by whole steps without opening the list, the way a native select does. */
  const step = (by: number): void => {
    const usable = choices.filter((option) => option.enabled !== false);
    if (usable.length === 0) {
      return;
    }
    const at = usable.findIndex((option) => option.value === value);
    const next = usable[Math.min(usable.length - 1, Math.max(0, at + by))];
    if (next !== undefined) {
      choose(next.value);
    }
  };

  const jump = (prefix: string): void => {
    const match = choices.find(
      (option) => option.enabled !== false && option.label.toLowerCase().startsWith(prefix),
    );
    if (match !== undefined) {
      choose(match.value);
    }
  };

  const open = (): void => {
    const bounds = element.getBoundingClientRect();
    const entries: MenuEntry[] = choices.map((option) => ({
      label: option.label,
      ...(option.icon === undefined ? {} : { icon: option.icon }),
      ...(option.glyph === undefined ? {} : { glyph: option.glyph }),
      checked: option.value === value,
      enabled: option.enabled !== false,
      run: () => {
        choose(option.value);
      },
    }));
    element.setAttribute('aria-expanded', 'true');
    showContextMenu(entries, { x: bounds.left, y: bounds.bottom + 2 }, element);
    // The menu hands focus back to the trigger when it closes, however it closed, so the
    // expanded state is cleared from that rather than from each of the ways out.
    element.addEventListener(
      'focus',
      () => {
        element.setAttribute('aria-expanded', 'false');
      },
      { once: true },
    );
  };

  element.addEventListener('click', open);
  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // Alt opens the list, as on a native select; the bare arrow steps the value.
      if (event.altKey) {
        open();
      } else {
        step(event.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      step(event.key === 'Home' ? -choices.length : choices.length);
      return;
    }
    if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }
    const now = Date.now();
    typed =
      now - typedAt > TYPE_AHEAD_MS ? event.key.toLowerCase() : typed + event.key.toLowerCase();
    typedAt = now;
    jump(typed);
  });

  Object.defineProperty(element, 'value', {
    get: () => value,
    set: (next: string) => {
      if (choices.some((option) => option.value === next)) {
        value = next;
        paint();
      }
    },
  });

  element.setOptions = (next: readonly SelectOption[]): void => {
    choices = [...next];
    if (!choices.some((option) => option.value === value)) {
      value = choices[0]?.value ?? '';
    }
    paint();
  };

  paint();
  return element;
}
