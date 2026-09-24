// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Transient notifications shown over the editor.
 *
 * The host is a fixed layer, so a toast appearing or leaving never reflows the shell.
 */

import { button } from './controls/index.js';
import { animateOut } from './motion.js';
import { setTooltip } from './tooltip.js';

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

/** How long the copy button shows it has copied, in milliseconds. */
const COPIED_MS = 1200;

/** Puts text on the clipboard, reporting whether the host allowed it. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stack of auto-dismissing notifications.
 *
 * @remarks Every toast is announced to assistive technology: an error assertively, anything
 * else politely. While the pointer is anywhere over the stack, gaps included, or focus is inside
 * it, none of them leaves. A line along each toast's foot shows the time it has left.
 *
 * Ctrl+C over a toast copies its message when no text is selected.
 */
export class ToastHost {
  readonly #element: HTMLElement;
  /** Each toast's countdown, drawn as the line along its foot; the toast leaves when it ends. */
  readonly #countdowns = new Map<HTMLElement, Animation>();
  readonly #messages = new Map<HTMLElement, string>();
  #hovered = false;
  #focused = false;
  #paused = false;

  constructor(parent: HTMLElement = document.body) {
    const element = document.createElement('div');
    element.className = 'axys-toast-host';
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-relevant', 'additions text');
    element.addEventListener('pointerenter', () => {
      this.#hovered = true;
      this.#sync();
    });
    element.addEventListener('pointerleave', () => {
      this.#hovered = false;
      this.#sync();
    });
    element.addEventListener('focusin', () => {
      this.#focused = true;
      this.#sync();
    });
    element.addEventListener('focusout', (event) => {
      this.#focused = event.relatedTarget instanceof Node && element.contains(event.relatedTarget);
      this.#sync();
    });
    parent.append(element);
    this.#element = element;
    // Capture, so the editor's own Copy never sees a press meant for a toast.
    window.addEventListener('keydown', this.#onKeyDown, true);
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
    window.removeEventListener('keydown', this.#onKeyDown, true);
    this.#element.remove();
  }

  #onKeyDown = (event: KeyboardEvent): void => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'c') {
      return;
    }
    const selected = document.getSelection();
    if (selected !== null && !selected.isCollapsed && selected.toString().length > 0) return;
    const toast = [...this.#messages.keys()].find(
      (candidate) => candidate.matches(':hover') || candidate.contains(document.activeElement),
    );
    const message = toast === undefined ? undefined : this.#messages.get(toast);
    if (message === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    void copyText(message);
  };

  #push(kind: ToastKind, message: string, link?: ToastLink): Toast {
    const toast = document.createElement('div');
    toast.className = `axys-toast is-${kind}`;
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    const text = document.createElement('span');
    text.className = 'axys-toast-text';
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

    const copy = button({
      icon: 'copy',
      label: 'Copy Message',
      className: 'axys-toast-copy',
      onPress: () => {
        void copyText(text.textContent).then((copied) => {
          if (!copied) return;
          copy.classList.add('is-copied');
          setTooltip(copy, 'Copied');
          globalThis.setTimeout(() => {
            copy.classList.remove('is-copied');
            setTooltip(copy, 'Copy Message');
          }, COPIED_MS);
        });
      },
    });
    const close = button({
      icon: 'close',
      label: 'Dismiss Message',
      onPress: () => {
        this.#remove(toast);
      },
    });
    const timer = document.createElement('span');
    timer.className = 'axys-toast-timer';
    timer.setAttribute('aria-hidden', 'true');
    toast.append(copy, close, timer);

    this.#element.append(toast);
    // Toasts still playing their exit are on their way out and do not count.
    const staying = [...this.#countdowns.keys()];
    for (const oldest of staying.slice(0, Math.max(0, staying.length + 1 - MAX_STACK))) {
      this.#remove(oldest);
    }

    // The line is the clock, so a throttled background tab cannot leave the two disagreeing.
    const countdown = timer.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration: LIFETIME[kind],
      fill: 'forwards',
    });
    if (this.#paused) countdown.pause();
    countdown.finished.then(
      () => {
        this.#remove(toast);
      },
      () => {
        // Cancelled by an earlier removal.
      },
    );
    this.#countdowns.set(toast, countdown);
    this.#messages.set(toast, text.textContent);

    return {
      dismiss: () => {
        this.#remove(toast);
      },
    };
  }

  /** Pauses or resumes every countdown to match where the pointer and focus are. */
  #sync(): void {
    const paused = this.#hovered || this.#focused;
    if (paused === this.#paused) return;
    this.#paused = paused;
    for (const countdown of this.#countdowns.values()) {
      if (paused) {
        countdown.pause();
      } else {
        countdown.play();
      }
    }
  }

  #remove(toast: HTMLElement): void {
    const countdown = this.#countdowns.get(toast);
    if (countdown === undefined) return;
    this.#countdowns.delete(toast);
    countdown.pause();
    this.#messages.delete(toast);
    animateOut(toast, 'is-leaving', () => {
      toast.remove();
      // A stack that shrinks out from under the pointer never reports the pointer leaving it.
      if (this.#hovered && !this.#element.matches(':hover')) {
        this.#hovered = false;
        this.#sync();
      }
    });
  }
}
