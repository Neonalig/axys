// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transient notifications shown over the editor.
 *
 * The host is a fixed layer, so a toast appearing or leaving never reflows the shell.
 */

import { ICONS } from './icons.js';
import { animateOut } from './motion.js';
import { setTooltip } from './tooltip.js';

/** Severity of a notification. */
export type ToastKind = 'info' | 'warn' | 'error';

/** A posted notification, while it is still on screen. */
export interface Toast {
  /** Removes the notification immediately. */
  dismiss(): void;
}

/** How long each severity stays before dismissing itself, in milliseconds. */
const LIFETIME: Readonly<Record<ToastKind, number>> = {
  info: 4000,
  warn: 8000,
  error: 14000,
};

/** Toasts kept on screen at once; the oldest leaves when a newer one arrives. */
const MAX_STACK = 5;

/**
 * Stack of auto-dismissing notifications.
 *
 * @remarks Every toast is announced to assistive technology: an error assertively, anything
 * else politely.
 */
export class ToastHost {
  readonly #element: HTMLElement;
  readonly #timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  constructor(parent: HTMLElement = document.body) {
    const element = document.createElement('div');
    element.className = 'axys-toast-host';
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-relevant', 'additions text');
    parent.append(element);
    this.#element = element;
  }

  /** The host element, already attached to its parent. */
  get element(): HTMLElement {
    return this.#element;
  }

  /** Reports something that went to plan. */
  info(message: string): Toast {
    return this.#push('info', message);
  }

  /** Reports a degraded mode or a result the user should check. */
  warn(message: string): Toast {
    return this.#push('warn', message);
  }

  /** Reports a failure that stopped what the user asked for. */
  error(message: string): Toast {
    return this.#push('error', message);
  }

  /** Removes every notification on screen. */
  clear(): void {
    for (const child of [...this.#element.children]) {
      if (child instanceof HTMLElement) {
        this.#remove(child);
      }
    }
  }

  /** Removes the host from the document. */
  dispose(): void {
    this.clear();
    this.#element.remove();
  }

  #push(kind: ToastKind, message: string): Toast {
    const toast = document.createElement('div');
    toast.className = `axys-toast is-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.textContent = message;
    toast.append(text);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'axys-icon';
    close.innerHTML = ICONS.close;
    close.setAttribute('aria-label', 'Dismiss Message');
    setTooltip(close, 'Dismiss Message');
    close.addEventListener('click', () => {
      this.#remove(toast);
    });
    toast.append(close);

    this.#element.append(toast);
    while (this.#element.children.length > MAX_STACK) {
      const oldest = this.#element.firstElementChild;
      if (!(oldest instanceof HTMLElement)) {
        break;
      }
      this.#remove(oldest);
    }

    const timer: ReturnType<typeof setTimeout> = globalThis.setTimeout(() => {
      this.#remove(toast);
    }, LIFETIME[kind]);
    this.#timers.set(toast, timer);

    return {
      dismiss: () => {
        this.#remove(toast);
      },
    };
  }

  #remove(toast: HTMLElement): void {
    const timer = this.#timers.get(toast);
    if (timer !== undefined) {
      globalThis.clearTimeout(timer);
      this.#timers.delete(toast);
    }
    animateOut(toast, 'is-leaving', () => {
      toast.remove();
    });
  }
}
