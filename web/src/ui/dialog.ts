// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Modal panels for diagnostics, licence information and confirmations.
 *
 * Focus stays inside an open dialog, Escape closes it, and the element that opened it is focused
 * again afterwards.
 */

import { ICONS } from './icons.js';
import { setTooltip } from './tooltip.js';

/** A button in a dialog's footer. */
export interface DialogAction {
  /** Short Title Case label, two or three words. */
  label: string;
  /** Marks the action the dialog leads with, or the destructive one. */
  kind?: 'primary' | 'danger';
  /** Runs when the action is chosen. The dialog stays open unless the handler closes it. */
  onSelect(dialog: Dialog): void;
}

/** Everything a dialog needs to open. */
export interface DialogOptions {
  /** Short Title Case heading. */
  title: string;
  /** Body content, adopted by the dialog. */
  content: Node;
  actions?: readonly DialogAction[];
  /** Element the dialog is appended to. Defaults to the document body. */
  parent?: HTMLElement;
  /** Runs once, after the dialog has closed. */
  onClose?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * One modal dialog.
 *
 * @remarks Only one dialog is expected at a time; opening a second stacks it in the browser's
 * top layer above the first.
 */
export class Dialog {
  readonly #element: HTMLDialogElement;
  readonly #body: HTMLElement;
  readonly #opener: Element | null;
  readonly #onClose: (() => void) | undefined;
  #closed = false;

  private constructor(options: DialogOptions) {
    this.#opener = document.activeElement;
    this.#onClose = options.onClose;

    const element = document.createElement('dialog');
    element.className = 'axys-dialog';

    const head = document.createElement('div');
    head.className = 'axys-dialog-head';

    const heading = document.createElement('h2');
    heading.textContent = options.title;
    head.append(heading);

    const spacer = document.createElement('span');
    spacer.className = 'axys-spacer';
    head.append(spacer);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'axys-icon';
    close.innerHTML = ICONS.close;
    close.setAttribute('aria-label', 'Close Dialog');
    setTooltip(close, 'Close Dialog');
    close.addEventListener('click', () => {
      this.close();
    });
    head.append(close);
    element.append(head);

    const body = document.createElement('div');
    body.className = 'axys-dialog-body';
    body.append(options.content);
    element.append(body);
    this.#body = body;

    const actions = options.actions ?? [];
    if (actions.length > 0) {
      const footer = document.createElement('div');
      footer.className = 'axys-group axys-dialog-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = action.label;
        setTooltip(button, action.label);
        if (action.kind === 'primary') {
          button.classList.add('is-active');
        } else if (action.kind === 'danger') {
          button.classList.add('axys-danger');
        }
        button.addEventListener('click', () => {
          action.onSelect(this);
        });
        footer.append(button);
      }
      element.append(footer);
    }

    element.addEventListener('keydown', (event: KeyboardEvent) => {
      this.#onKeyDown(event);
    });
    element.addEventListener('close', () => {
      this.#afterClose();
    });

    (options.parent ?? document.body).append(element);
    this.#element = element;
  }

  /** Opens a modal dialog and focuses its first control. */
  static open(options: DialogOptions): Dialog {
    const dialog = new Dialog(options);
    dialog.#show();
    return dialog;
  }

  /** The dialog element, for tests and for styling hooks. */
  get element(): HTMLDialogElement {
    return this.#element;
  }

  /** The content area, so a caller can replace what it shows while the dialog is open. */
  get body(): HTMLElement {
    return this.#body;
  }

  /** True until the dialog has closed. */
  get open(): boolean {
    return !this.#closed;
  }

  /** Closes the dialog and restores focus. */
  close(): void {
    if (this.#closed) {
      return;
    }
    if (this.#element.open) {
      this.#element.close();
    } else {
      this.#afterClose();
    }
  }

  #show(): void {
    this.#element.showModal();
    const first = focusableIn(this.#element)[0];
    first?.focus();
  }

  #onKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = focusableIn(this.#element);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === this.#element)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  #afterClose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#element.remove();
    if (this.#opener instanceof HTMLElement) {
      this.#opener.focus();
    }
    this.#onClose?.();
  }
}
