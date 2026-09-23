// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transient notifications shown over the editor.
 *
 * The host is a fixed layer, so a toast appearing or leaving never reflows the shell.
 */

import { button } from './controls/index.js';
import { animateOut } from './motion.js';

/** Severity of a notification. */
export type ToastKind = 'info' | 'warn' | 'error';

/** A part of a toast's message that does something when pressed, such as opening Help. */
export interface ToastLink {
  /** The words of the message that become the link; appended when the message lacks them. */
  text: string;
  run(): void;
}

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

/** When a toast leaves on its own, while its countdown runs or stands paused. */
interface Countdown {
  timer: ReturnType<typeof setTimeout> | null;
  /** Milliseconds left when the countdown last stopped or started. */
  remaining: number;
  /** When the running countdown started, from `performance.now()`. */
  started: number;
}

/**
 * Stack of auto-dismissing notifications.
 *
 * @remarks Every toast is announced to assistive technology: an error assertively, anything
 * else politely. While the pointer is over any toast none of them leaves, so the stack holds
 * still while one is being read or its link reached for.
 */
export class ToastHost {
  readonly #element: HTMLElement;
  readonly #countdowns = new Map<HTMLElement, Countdown>();
  /** Toasts under the pointer. More than one only for the moment the pointer crosses a gap. */
  #hovered = 0;

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
  info(message: string, link?: ToastLink): Toast {
    return this.#push('info', message, link);
  }

  /** Reports a degraded mode or a result the user should check. */
  warn(message: string, link?: ToastLink): Toast {
    return this.#push('warn', message, link);
  }

  /** Reports a failure that stopped what the user asked for. */
  error(message: string, link?: ToastLink): Toast {
    return this.#push('error', message, link);
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

  #push(kind: ToastKind, message: string, link?: ToastLink): Toast {
    const toast = document.createElement('div');
    toast.className = `axys-toast is-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    if (link === undefined) {
      text.textContent = message;
    } else {
      const at = message.indexOf(link.text);
      const before = at < 0 ? `${message} ` : message.slice(0, at);
      const after = at < 0 ? '' : message.slice(at + link.text.length);
      const anchor = document.createElement('button');
      anchor.type = 'button';
      anchor.className = 'axys-toast-link';
      anchor.textContent = link.text;
      anchor.addEventListener('click', () => {
        this.#remove(toast);
        link.run();
      });
      text.append(before, anchor, after);
    }
    toast.append(text);
    toast.addEventListener('pointerenter', () => {
      this.#hovered += 1;
      if (this.#hovered === 1) this.#pauseAll();
    });
    toast.addEventListener('pointerleave', () => {
      this.#hovered = Math.max(0, this.#hovered - 1);
      if (this.#hovered === 0) this.#resumeAll();
    });

    const close = button({
      icon: 'close',
      label: 'Dismiss Message',
      onPress: () => {
        this.#remove(toast);
      },
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

    const countdown: Countdown = { timer: null, remaining: LIFETIME[kind], started: 0 };
    this.#countdowns.set(toast, countdown);
    if (this.#hovered === 0) this.#start(toast, countdown);

    return {
      dismiss: () => {
        this.#remove(toast);
      },
    };
  }

  #start(toast: HTMLElement, countdown: Countdown): void {
    countdown.started = performance.now();
    countdown.timer = globalThis.setTimeout(() => {
      this.#remove(toast);
    }, countdown.remaining);
  }

  #pauseAll(): void {
    for (const countdown of this.#countdowns.values()) {
      if (countdown.timer === null) continue;
      globalThis.clearTimeout(countdown.timer);
      countdown.timer = null;
      countdown.remaining = Math.max(
        0,
        countdown.remaining - (performance.now() - countdown.started),
      );
    }
  }

  #resumeAll(): void {
    for (const [toast, countdown] of this.#countdowns) {
      if (countdown.timer === null) this.#start(toast, countdown);
    }
  }

  #remove(toast: HTMLElement): void {
    const countdown = this.#countdowns.get(toast);
    if (countdown !== undefined) {
      if (countdown.timer !== null) globalThis.clearTimeout(countdown.timer);
      this.#countdowns.delete(toast);
    }
    // A toast taken away from under the pointer never reports the pointer leaving it.
    if (toast.matches(':hover')) {
      this.#hovered = Math.max(0, this.#hovered - 1);
      if (this.#hovered === 0) this.#resumeAll();
    }
    animateOut(toast, 'is-leaving', () => {
      toast.remove();
    });
  }
}
