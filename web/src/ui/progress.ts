// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one progress bar the chrome draws, determinate or not.
 *
 * The host `<progress>` element draws its own indeterminate state, differently per browser and
 * differently again from itself at a second size, so the import cover and the status bar reported
 * the same work with two different animations. This is drawn by the page, so both read alike.
 */

/** A bar that shows a fraction, or marches while the fraction is unknown. */
export class ProgressBar {
  readonly #element: HTMLElement;
  readonly #fill: HTMLElement;
  #value: number | null = null;

  constructor(label: string) {
    const element = document.createElement('div');
    element.className = 'axys-progress';
    element.setAttribute('role', 'progressbar');
    element.setAttribute('aria-label', label);
    const fill = document.createElement('div');
    fill.className = 'axys-progress-fill';
    element.append(fill);
    this.#element = element;
    this.#fill = fill;
    this.set(null);
  }

  /** The bar element, ready to append. */
  get element(): HTMLElement {
    return this.#element;
  }

  /**
   * Shows a fraction between 0 and 1, or `null` for work of unknown length.
   *
   * @remarks A stage that reports nothing is given the marching bar rather than a fill pinned at
   * zero, which reads as stalled.
   */
  set(value: number | null): void {
    if (value === this.#value) {
      return;
    }
    this.#value = value;
    if (value === null) {
      this.#element.classList.add('is-indeterminate');
      this.#element.removeAttribute('aria-valuenow');
      this.#fill.style.removeProperty('width');
      return;
    }
    const clamped = Math.min(1, Math.max(0, value));
    this.#element.classList.remove('is-indeterminate');
    this.#element.setAttribute('aria-valuenow', clamped.toFixed(2));
    this.#element.setAttribute('aria-valuemin', '0');
    this.#element.setAttribute('aria-valuemax', '1');
    this.#fill.style.width = `${String(Math.round(clamped * 100))}%`;
  }
}
