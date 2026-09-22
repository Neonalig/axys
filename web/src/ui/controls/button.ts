// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Buttons and toggles.
 *
 * Every button in the chrome is built here, so a control's rest, hover, active, disabled, focus
 * and checked states are settled once. A button carries an icon and a name, and the name is shown
 * or hidden by the toolbar's own class rather than by whoever built the button, so turning the
 * names on reaches every one of them at once.
 */

import { ICONS, STATE_ICONS, stateIcon } from '../icons.js';
import type { IconName, StateIconName } from '../icons.js';
import { setTooltip } from '../tooltip.js';

/** What a button shows and does. */
export interface ButtonOptions {
  /** The glyph on the button. */
  icon: IconName;
  /** The button's name, both its accessible name and the text beside the glyph. */
  label: string;
  /** One short sentence saying what pressing it does. Defaults to the label. */
  tooltip?: string;
  /** Extra classes, for the few buttons a container places by hand. */
  className?: string;
  onPress?: () => void;
}

/**
 * A button with a glyph and a name.
 *
 * @remarks The name is in the markup whether or not it is shown, so assistive technology and the
 * labelled toolbar read the same string, and turning names on adds no elements.
 */
export function button(options: ButtonOptions): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = ['axys-icon', options.className ?? ''].join(' ').trim();

  const glyph = document.createElement('span');
  glyph.className = 'axys-button-icon';
  glyph.innerHTML = ICONS[options.icon];

  const text = document.createElement('span');
  text.className = 'axys-button-label';
  text.textContent = options.label;

  element.append(glyph, text);
  element.setAttribute('aria-label', options.label);
  setTooltip(element, options.tooltip ?? options.label);
  if (options.onPress !== undefined) {
    element.addEventListener('click', options.onPress);
  }
  return element;
}

/** A button whose state the caller drives. */
export interface Toggle {
  /** The button, to place in a group. */
  readonly element: HTMLButtonElement;
  /** Shows the toggle as on or off: the pressed state, the glyph and the tooltip together. */
  set(on: boolean): void;
}

/** What a toggle shows in each of its two states. */
export interface ToggleOptions {
  /** The glyph pair to swap between, or a single glyph where Lucide ships no off variant. */
  icon: StateIconName | IconName;
  /** The control's name, which does not change with its state. */
  label: string;
  /** One short sentence naming what pressing it will do, per state. */
  tooltip: (on: boolean) => string;
  className?: string;
  onPress?: (wanted: boolean) => void;
}

/**
 * A button that reads as switched on or off.
 *
 * @remarks `aria-pressed` carries the state whichever glyph is showing, so nothing depends on the
 * swap. A toggle's tooltip names what pressing it will do and follows the glyph, rather than
 * repeating the name beside it.
 */
export function toggle(options: ToggleOptions): Toggle {
  const paired = options.icon in STATE_ICONS;
  const pair = options.icon as StateIconName;
  const element = button({
    icon: paired ? STATE_ICONS[pair].off : (options.icon as IconName),
    label: options.label,
    tooltip: options.tooltip(false),
    ...(options.className === undefined ? {} : { className: options.className }),
  });
  element.setAttribute('aria-pressed', 'false');

  let on = false;
  const glyph = element.querySelector<HTMLElement>('.axys-button-icon');

  const set = (next: boolean): void => {
    on = next;
    element.setAttribute('aria-pressed', String(next));
    if (paired && glyph !== null) {
      glyph.innerHTML = stateIcon(pair, next);
    }
    setTooltip(element, options.tooltip(next));
  };

  if (options.onPress !== undefined) {
    const press = options.onPress;
    element.addEventListener('click', () => {
      press(!on);
    });
  }

  set(false);
  return { element, set };
}
