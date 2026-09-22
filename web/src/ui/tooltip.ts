// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tooltips for the DOM chrome, drawn by the page rather than by the host.
 *
 * A host tooltip appears only after a delay the page cannot set, and only while the window holds
 * focus, so a control's name is unreadable exactly when someone is reaching for it from another
 * window. These follow this file's delay and show whether or not the window is focused. The
 * accessible name stays on the control, so assistive technology reads the same thing either way.
 */

import { animateOut } from './motion.js';

/** Milliseconds a pointer rests on a control before its tooltip appears. */
const DELAY_MS = 320;

/** Gap in pixels between a control and its tooltip. */
const OFFSET = 6;

/** Distance in pixels a tooltip is kept from the viewport edge. */
const MARGIN = 6;

/** Attribute carrying a control's tooltip text. */
export const TIP_ATTRIBUTE = 'data-axys-tip';

/**
 * Puts a tooltip on an element, in place of `title`.
 *
 * @remarks A control whose tooltip changes while it is being pointed at, such as Play becoming
 * Pause under a keyboard shortcut, has the shown tooltip rewritten under the cursor rather than
 * left saying what the control used to do.
 */
export function setTooltip(element: HTMLElement, text: string): void {
  if (text === '') {
    element.removeAttribute(TIP_ATTRIBUTE);
  } else {
    element.setAttribute(TIP_ATTRIBUTE, text);
  }
  installed?.refresh(element);
}

/**
 * The one tooltip element, shown for whichever control the pointer or keyboard is on.
 *
 * @remarks Listens once at the root rather than per control, so controls added later need only
 * the attribute. A tooltip is hidden the moment its control is pressed, because the pointer is
 * then past reading it.
 */
export class TooltipHost {
  readonly #root: HTMLElement;
  readonly #element: HTMLElement;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #target: HTMLElement | null = null;

  private constructor(root: HTMLElement) {
    this.#root = root;
    const element = document.createElement('div');
    element.className = 'axys-tooltip';
    element.id = 'axys-tooltip';
    element.setAttribute('role', 'tooltip');
    element.hidden = true;
    document.body.append(element);
    this.#element = element;

    this.#root.addEventListener('pointerover', this.#onOver);
    this.#root.addEventListener('pointerout', this.#onOut);
    this.#root.addEventListener('pointerdown', this.#onDown);
    this.#root.addEventListener('focusin', this.#onFocus);
    this.#root.addEventListener('focusout', this.#onOut);
    window.addEventListener('scroll', this.#onDown, true);
  }

  /** Installs the tooltip layer over a subtree and returns it. */
  static install(root: HTMLElement): TooltipHost {
    installed = new TooltipHost(root);
    return installed;
  }

  /** Rewrites the shown tooltip when its own control's text has changed. */
  refresh(element: HTMLElement): void {
    if (this.#target !== element) {
      return;
    }
    const text = element.getAttribute(TIP_ATTRIBUTE);
    if (text === null || text === '') {
      this.#cancel();
      return;
    }
    this.#element.textContent = text;
    this.#place(element);
  }

  /** Removes the tooltip layer and its listeners. */
  dispose(): void {
    if (installed === this) {
      installed = null;
    }
    this.#cancel();
    this.#root.removeEventListener('pointerover', this.#onOver);
    this.#root.removeEventListener('pointerout', this.#onOut);
    this.#root.removeEventListener('pointerdown', this.#onDown);
    this.#root.removeEventListener('focusin', this.#onFocus);
    this.#root.removeEventListener('focusout', this.#onOut);
    window.removeEventListener('scroll', this.#onDown, true);
    this.#element.remove();
  }

  #onOver = (event: Event): void => {
    this.#arm(tipTarget(event.target));
  };

  #onFocus = (event: Event): void => {
    // A keyboard arrival has already waited, so its tooltip shows at once.
    const target = tipTarget(event.target);
    if (target !== null) {
      this.#show(target);
    }
  };

  #onOut = (): void => {
    this.#cancel();
  };

  #onDown = (): void => {
    this.#cancel();
  };

  #arm(target: HTMLElement | null): void {
    if (target === this.#target) {
      return;
    }
    this.#cancel();
    if (target === null) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#show(target);
    }, DELAY_MS);
  }

  #show(target: HTMLElement): void {
    const text = target.getAttribute(TIP_ATTRIBUTE);
    if (text === null || text === '' || !target.isConnected) {
      return;
    }
    this.#target = target;
    this.#element.classList.remove('is-leaving');
    this.#element.textContent = text;
    this.#element.hidden = false;
    target.setAttribute('aria-describedby', this.#element.id);
    this.#place(target);
  }

  /** Puts the tooltip under its control, pulled inside the viewport at either edge. */
  #place(target: HTMLElement): void {
    const anchor = target.getBoundingClientRect();
    const tip = this.#element.getBoundingClientRect();
    const left = Math.min(
      Math.max(MARGIN, anchor.left + anchor.width / 2 - tip.width / 2),
      Math.max(MARGIN, window.innerWidth - tip.width - MARGIN),
    );
    const below = anchor.bottom + OFFSET;
    const top =
      below + tip.height + MARGIN <= window.innerHeight ? below : anchor.top - tip.height - OFFSET;
    this.#element.style.left = `${String(Math.round(left))}px`;
    this.#element.style.top = `${String(Math.round(Math.max(MARGIN, top)))}px`;
  }

  #cancel(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#target?.removeAttribute('aria-describedby');
    this.#target = null;
    if (this.#element.hidden) {
      return;
    }
    animateOut(this.#element, 'is-leaving', () => {
      // Another control may have claimed the tooltip while this one was fading, so the element is
      // hidden only when nothing is using it.
      if (this.#target === null) {
        this.#element.hidden = true;
      }
    });
  }
}

/** The one installed host, so a tooltip rewritten from anywhere reaches the shown one. */
let installed: TooltipHost | null = null;

/** The nearest ancestor carrying tooltip text, or `null` when there is none. */
function tipTarget(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) {
    return null;
  }
  return node.closest<HTMLElement>(`[${TIP_ATTRIBUTE}]`);
}
