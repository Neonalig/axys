// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The control primitives.
 *
 * Every control the chrome draws is defined once here: the toolbar, the inspector, the mixer and
 * the dialogs build from these rather than each styling a button or a field its own way.
 */

export { button, toggle } from './button.js';
export type { ButtonOptions, Toggle, ToggleOptions } from './button.js';
export {
  bindDragAdjust,
  checkboxInput,
  field,
  guidedLabel,
  nextControlId,
  numberInput,
  rangeInput,
  textInput,
} from './field.js';
export { selectInput } from './select.js';
export type { SelectElement, SelectOption } from './select.js';
