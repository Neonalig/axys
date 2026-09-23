// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Labelled fields and the inputs that go in them.
 *
 * One definition per control, so the inspector, the mixer, the dialogs and the operation panels
 * cannot style or behave three different ways for the same thing.
 */

import { ICONS } from '../icons.js';
import { setTooltip } from '../tooltip.js';

let sequence = 0;

/** A document-unique id for pairing a label with its control. */
export function nextControlId(prefix: string): string {
  sequence += 1;
  return `axys-${prefix}-${String(sequence)}`;
}

/**
 * A label carrying its own explainer, marked with an info icon.
 *
 * @remarks The guide sits on the label rather than on the control. A tooltip that appears over
 * the control covers the slider or the drop-down being reached for, which is exactly when it is
 * least wanted; the icon says the explanation is there and the whole label is the target.
 */
export function guidedLabel(text: string, guide: string): HTMLLabelElement {
  const label = document.createElement('label');
  label.className = 'axys-label';
  label.append(document.createTextNode(text));
  if (guide !== '') {
    label.append(infoMark());
    setTooltip(label, guide);
  }
  return label;
}

/**
 * Gives an element that is not a control an explainer, marked with an info icon after its content.
 *
 * @remarks For a readout or a status word whose tooltip would otherwise go unfound. Safe to call
 * again with a new explainer; the icon is added once. Setting `textContent` afterwards removes it.
 */
export function withInfo(element: HTMLElement, guide: string): void {
  element.classList.add('axys-has-info');
  if (element.querySelector(':scope > .axys-info') === null) element.append(infoMark());
  setTooltip(element, guide);
}

function infoMark(): HTMLSpanElement {
  const mark = document.createElement('span');
  mark.className = 'axys-info';
  mark.innerHTML = ICONS.info;
  return mark;
}

/**
 * How a scrubbable field says it can be dragged, and with which modifiers.
 *
 * @remarks Appended to the field's own explainer rather than replacing it, and said the same way
 * on every one of them: a gesture that is written differently in each row is a gesture nobody
 * learns.
 */
export const DRAG_HINT = 'Drag to set. Shift coarse, Alt fine';

/**
 * Wraps a control in a labelled row, with the label carrying the field's explainer.
 *
 * @remarks A number field is also a drag, so its explainer names the gesture and the fine-adjust
 * modifier. The tooltip is not the only way to find it: the label and the field both take the
 * `ew-resize` cursor, which is what says the row can be dragged at all.
 */
export function field(
  labelText: string,
  control: HTMLElement,
  guide: string,
  unit?: string,
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'axys-field';
  if (control.id === '') {
    control.id = nextControlId('control');
  }
  const scrubbable =
    control instanceof HTMLInputElement && control.type === 'number' && !control.readOnly;
  const explainer = !scrubbable ? guide : guide === '' ? DRAG_HINT : `${guide}. ${DRAG_HINT}`;
  const label = guidedLabel(labelText, explainer);
  label.htmlFor = control.id;
  row.append(label, unit === undefined ? control : withUnit(control, unit));
  bindDragAdjust(control, label);
  return row;
}

/**
 * Wraps an input so its unit, such as `s` or `Hz`, is drawn inside its right edge.
 *
 * @remarks The unit takes no pointer events, so a drag that starts on it still adjusts the field.
 */
export function withUnit(control: HTMLElement, unit: string): HTMLElement {
  const wrapper = document.createElement('span');
  wrapper.className = 'axys-unit-field';
  wrapper.style.setProperty('--axys-unit-chars', String(unit.length));
  const suffix = document.createElement('span');
  suffix.className = 'axys-unit';
  suffix.textContent = unit;
  suffix.setAttribute('aria-hidden', 'true');
  wrapper.append(control, suffix);
  return wrapper;
}

/** Focuses a field and offers its whole value, for a press the drag took over and gave back. */
function selectField(control: HTMLInputElement): void {
  control.focus();
  try {
    control.select();
  } catch {
    // A field that will not report a selection is simply focused, which is what a click asks for.
  }
}

/** Marks the page as being dragged, so nothing under the pointer is selected while it moves. */
const ADJUSTING_CLASS = 'is-adjusting';

/**
 * Takes the field over for a drag: focused, unselected and with nothing else selectable.
 *
 * @remarks A press inside a field starts selecting its text, and the drag that press turns into
 * would otherwise leave the number highlighted behind it. The selection is dropped as the drag
 * begins, and the page stops selecting for as long as it lasts, so what the hand is doing and
 * what the field shows agree. Focus is taken at the same time, which is what keeps the panel
 * from rewriting the field under the hand.
 */
function startDrag(control: HTMLInputElement): void {
  document.body.classList.add(ADJUSTING_CLASS);
  control.blur();
  window.getSelection()?.removeAllRanges();
  control.focus();
}

/** Pixels a press has to travel before it counts as a drag rather than a click. */
const DRAG_THRESHOLD = 3;

/** How far one pixel of travel moves a field, as a multiple of its own step. */
const DRAG_COARSE = 10;
const DRAG_FINE = 0.1;

/**
 * Lets a number field be dragged sideways to set its value, the way every editor's fields are.
 *
 * @remarks The label is a handle as well as the field, which is what makes the gesture reachable
 * without putting a caret in the way. One pixel is one step, Shift is ten and Alt a tenth, the
 * same modifiers the canvas uses.
 *
 * The pointer is captured for the length of the drag and the cursor is left visible, which is
 * what every design tool does.
 *
 * The drag commits once, on release, so a field dragged across half its range is one undo step.
 */
export function bindDragAdjust(control: HTMLElement, ...handles: readonly HTMLElement[]): void {
  if (!(control instanceof HTMLInputElement) || control.type !== 'number') return;
  const step = Number.parseFloat(control.step) || 1;
  const decimals = (control.step.split('.')[1] ?? '').length;

  for (const handle of [control, ...handles]) {
    handle.classList.add('is-adjustable');
    // The field itself needs the press taken over outright: a press inside a form control starts
    // its own text selection, which `user-select` does not govern, so a drag back across the
    // digits would select them however often the selection is cleared. Focus is given back on
    // release instead, and the spinners it would otherwise swallow are not drawn.
    const isField = handle === control;
    let dragging = false;
    /** Set while the click that ends a drag is still to arrive, so it is not taken as a click. */
    let dragged = false;
    let origin = 0;
    let last = 0;
    /** The value the drag has reached, before it is rounded to the field's step. */
    let value = 0;
    /** How far one pixel of travel moves the value, for the range the field has now. */
    let rate = step;

    handle.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0 || control.disabled || control.readOnly) return;
      dragging = false;
      dragged = false;
      origin = event.clientX;
      last = event.clientX;
      if (isField) event.preventDefault();
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener('pointermove', (event: PointerEvent) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      const travel = event.clientX - last;
      last = event.clientX;
      if (!dragging) {
        if (Math.abs(event.clientX - origin) < DRAG_THRESHOLD) return;
        dragging = true;
        startDrag(control);
        const current = Number.parseFloat(control.value);
        value = Number.isFinite(current) ? current : 0;
        rate = dragRate(control, step);
      }
      event.preventDefault();
      const scale = event.shiftKey ? DRAG_COARSE : event.altKey ? DRAG_FINE : 1;
      const { low, high } = bounds(control);
      value = Math.min(Math.max(value + travel * rate * scale, low), high);
      const next = Math.min(Math.max(Math.round(value / step) * step, low), high);
      if (next.toFixed(decimals) === control.value) return;
      control.value = next.toFixed(decimals);
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const release = (event: PointerEvent): void => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      handle.releasePointerCapture(event.pointerId);
      if (!dragging) {
        // A press that stayed a press is a click on the field: it focuses it and offers the
        // whole number, which is what is typed over.
        if (isField) selectField(control);
        return;
      }
      dragging = false;
      document.body.classList.remove(ADJUSTING_CLASS);
      dragged = true;
      // Focus was taken to keep the panel from rewriting the field mid-drag, and is given back
      // before the edit, so the field it leaves behind is the one the session settled on rather
      // than the last number the drag wrote.
      control.blur();
      // One change for the whole drag: the field's own listener turns that into one edit.
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
    handle.addEventListener('pointerup', release);
    handle.addEventListener('pointercancel', release);
    // A press that became a drag must not also count as a click: a label's click puts the
    // keyboard in the field it names, which would take back the focus the drag just gave up.
    handle.addEventListener('click', (event: MouseEvent) => {
      if (!dragged) return;
      dragged = false;
      event.preventDefault();
    });
  }
}

/** A number field's bounds as they stand now, which a field whose range follows the project can change. */
function bounds(control: HTMLInputElement): { low: number; high: number } {
  const low = Number.parseFloat(control.min);
  const high = Number.parseFloat(control.max);
  return {
    low: Number.isFinite(low) ? low : Number.NEGATIVE_INFINITY,
    high: Number.isFinite(high) ? high : Number.POSITIVE_INFINITY,
  };
}

/**
 * How far one pixel of travel moves a field: one step, or less where the whole range is short.
 *
 * @remarks A bounded field crosses its range in no less than {@link DRAG_RANGE_PIXELS}, so a field
 * of four values is not swept end to end by a twitch.
 */
function dragRate(control: HTMLInputElement, step: number): number {
  const { low, high } = bounds(control);
  const range = high - low;
  return Number.isFinite(range) && range > 0 ? Math.min(step, range / DRAG_RANGE_PIXELS) : step;
}

/** Fewest pixels a drag takes to cross a bounded field's whole range. */
const DRAG_RANGE_PIXELS = 300;

/** Numeric entry with explicit bounds and step. */
export function numberInput(options: {
  min?: number;
  max?: number;
  step: number;
  readOnly?: boolean;
}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.id = nextControlId('num');
  input.step = String(options.step);
  if (options.min !== undefined) {
    input.min = String(options.min);
  }
  if (options.max !== undefined) {
    input.max = String(options.max);
  }
  if (options.readOnly === true) {
    input.readOnly = true;
    input.setAttribute('aria-readonly', 'true');
  }
  return input;
}

/**
 * Slider over a continuous range.
 *
 * @remarks The slider draws its own track, filled from zero, or from the start where zero is out
 * of range, to the value. The fill follows every change to the value, typed, dragged or set.
 */
export function rangeInput(min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.id = nextControlId('range');
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (native?.get !== undefined && native.set !== undefined) {
    const { get, set } = native;
    Object.defineProperty(input, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return get.call(this) as string;
      },
      set(this: HTMLInputElement, value: string) {
        set.call(this, value);
        fillRange(this);
      },
    });
  }
  input.addEventListener('input', () => {
    fillRange(input);
  });
  fillRange(input);
  return input;
}

/** Sets the span of a slider's track its fill covers, as fractions of the track. */
function fillRange(input: HTMLInputElement): void {
  const min = Number(input.min);
  const max = Number(input.max);
  if (!(max > min)) return;
  const at = (value: number): number => Math.min(1, Math.max(0, (value - min) / (max - min)));
  const origin = at(min < 0 && max > 0 ? 0 : min);
  const value = at(Number(input.value));
  input.style.setProperty('--axys-range-from', Math.min(origin, value).toFixed(4));
  input.style.setProperty('--axys-range-to', Math.max(origin, value).toFixed(4));
}

/** Single-line text entry. */
export function textInput(maxLength: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.id = nextControlId('text');
  input.maxLength = maxLength;
  input.autocomplete = 'off';
  input.spellcheck = false;
  return input;
}

/** Checkbox for a boolean setting. */
export function checkboxInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = nextControlId('check');
  return input;
}
