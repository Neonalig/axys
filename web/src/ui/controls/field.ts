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
    const mark = document.createElement('span');
    mark.className = 'axys-info';
    mark.innerHTML = ICONS.info;
    label.append(mark);
    setTooltip(label, guide);
  }
  return label;
}

/** Wraps a control in a labelled row, with the label carrying the field's explainer. */
export function field(labelText: string, control: HTMLElement, guide: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'axys-field';
  if (control.id === '') {
    control.id = nextControlId('control');
  }
  const label = guidedLabel(labelText, guide);
  label.htmlFor = control.id;
  row.append(label, control);
  bindDragAdjust(control, label);
  return row;
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
 * what every design tool does. Pointer lock was tried first and is wrong here: the browser takes
 * the cursor away behind a notice about the page controlling it, and locking releases the pointer
 * capture the drag is tracked by, so the field stops following the hand entirely.
 *
 * The drag commits once, on release, so a field dragged across half its range is one undo step.
 */
export function bindDragAdjust(control: HTMLElement, ...handles: readonly HTMLElement[]): void {
  if (!(control instanceof HTMLInputElement) || control.type !== 'number') return;
  const step = Number.parseFloat(control.step) || 1;
  const decimals = (control.step.split('.')[1] ?? '').length;
  const low = control.min === '' ? Number.NEGATIVE_INFINITY : Number.parseFloat(control.min);
  const high = control.max === '' ? Number.POSITIVE_INFINITY : Number.parseFloat(control.max);

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
      }
      event.preventDefault();
      const scale = event.shiftKey ? DRAG_COARSE : event.altKey ? DRAG_FINE : 1;
      const current = Number.parseFloat(control.value);
      const from = Number.isFinite(current) ? current : 0;
      const next = Math.min(Math.max(from + travel * step * scale, low), high);
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

/** Slider over a continuous range. */
export function rangeInput(min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.id = nextControlId('range');
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

/** Checkbox for a boolean setting. */
export function checkboxInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = nextControlId('check');
  return input;
}
