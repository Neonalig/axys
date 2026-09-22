// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The footer zoom control: step out, a stepped slider, a readout and step in.
 *
 * The steps exist so zoom is one drag rather than a count of clicks, and so the common
 * magnifications are reachable without aiming. They do not constrain zoom itself: a wheel zoom
 * lands wherever it lands and the slider simply shows the nearest position to it.
 */

import { button, rangeInput } from './controls/index.js';
import { setTooltip } from './tooltip.js';

/** Visible spans the slider steps through, in seconds, widest last. */
const STEPS: readonly number[] = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600];

/** What the zoom control reports. */
export interface ZoomControlOptions {
  /** Asks for a visible span, in seconds, about the centre of the view. */
  onSpan(seconds: number): void;
  /** Frames the whole project. */
  onFit(): void;
}

/**
 * The zoom control as one element.
 *
 * @remarks Reports intent only. The caller owns the view and decides what anchor a new span
 * zooms about.
 */
export class ZoomControl {
  readonly element: HTMLElement;
  readonly #slider: HTMLInputElement;
  readonly #readout: HTMLInputElement;
  readonly #options: ZoomControlOptions;
  #span = 10;

  constructor(options: ZoomControlOptions) {
    this.#options = options;
    const element = document.createElement('div');
    element.className = 'axys-zoom';
    element.setAttribute('role', 'group');
    element.setAttribute('aria-label', 'Zoom');

    const out = button({
      icon: 'zoomOut',
      label: 'Zoom Out',
      onPress: () => {
        this.#step(1);
      },
    });
    const slider = rangeInput(0, STEPS.length - 1, 1);
    slider.className = 'axys-zoom-slider';
    slider.setAttribute('aria-label', 'Zoom Level');
    setTooltip(slider, 'Visible span. Ctrl and the wheel zoom freely between these steps');
    slider.addEventListener('input', () => {
      const chosen = STEPS[Number(slider.value)];
      if (chosen !== undefined) this.#options.onSpan(chosen);
    });

    const readout = document.createElement('input');
    readout.type = 'text';
    readout.className = 'axys-zoom-readout';
    readout.inputMode = 'decimal';
    readout.setAttribute('aria-label', 'Visible Seconds');
    setTooltip(readout, 'Seconds across the editor. Type one to zoom to it');
    readout.addEventListener('change', () => {
      const typed = Number.parseFloat(readout.value);
      if (Number.isFinite(typed) && typed > 0) this.#options.onSpan(typed);
      else this.#showSpan(this.#span);
    });

    const inward = button({
      icon: 'zoomIn',
      label: 'Zoom In',
      onPress: () => {
        this.#step(-1);
      },
    });
    const fit = button({
      icon: 'zoomFit',
      label: 'Zoom Fit',
      onPress: () => {
        this.#options.onFit();
      },
    });

    element.append(out, slider, readout, inward, fit);
    this.element = element;
    this.#slider = slider;
    this.#readout = readout;
    this.#showSpan(this.#span);
  }

  /** Reflects the view's current visible span. */
  update(span: number): void {
    if (!Number.isFinite(span) || span <= 0 || span === this.#span) {
      return;
    }
    this.#span = span;
    this.#slider.value = String(nearestStep(span));
    if (document.activeElement !== this.#readout) {
      this.#showSpan(span);
    }
  }

  /** Moves one step wider or narrower from wherever the view currently sits. */
  #step(direction: 1 | -1): void {
    const index = clampIndex(nearestStep(this.#span) + direction);
    const chosen = STEPS[index];
    if (chosen !== undefined) {
      this.#options.onSpan(chosen);
    }
  }

  #showSpan(span: number): void {
    this.#readout.value = span < 1 ? `${span.toFixed(2)} s` : `${span.toFixed(1)} s`;
  }
}

/** Index of the step closest to a span, on a log scale so each step feels the same size. */
function nearestStep(span: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < STEPS.length; index += 1) {
    const step = STEPS[index];
    if (step === undefined) continue;
    const distance = Math.abs(Math.log(step) - Math.log(span));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function clampIndex(index: number): number {
  return index < 0 ? 0 : index > STEPS.length - 1 ? STEPS.length - 1 : index;
}
