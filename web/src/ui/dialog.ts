// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one panel system: help, export, and the operations that preview while they are open.
 *
 * Every panel is draggable by its own title bar and can be closed with Escape, with the close
 * button, or by pressing outside it. A panel is blocking only when what it asks for has to be
 * answered before anything else can happen; an operation that shows its result in the editor is
 * not blocking, because the editor is where its result appears.
 */

import { button as iconButton } from './controls/index.js';
import { ICONS } from './icons.js';
import type { IconName } from './icons.js';
import { setTooltip } from './tooltip.js';

/** A button in a panel's footer. */
export interface DialogAction {
  /** Short Title Case label, two or three words. */
  label: string;
  /** Marks the action the panel leads with, or the destructive one. */
  kind?: 'primary' | 'danger';
  /** Runs when the action is chosen. The panel stays open unless the handler closes it. */
  onSelect(dialog: Dialog): void;
}

/** Everything a panel needs to open. */
export interface DialogOptions {
  /** Short Title Case heading. */
  title: string;
  /** Icon shown beside the heading. */
  icon?: IconName;
  /** Body content, adopted by the panel. */
  content: Node;
  actions?: readonly DialogAction[];
  /**
   * Whether the panel blocks the rest of the editor.
   *
   * @remarks Default. A panel that previews its result in the editor passes `false`, so the
   * transport and the canvas stay reachable while it is open.
   */
  blocking?: boolean;
  /** Element the panel is appended to. Defaults to the document body. */
  parent?: HTMLElement;
  /** Runs once, after the panel has closed. */
  onClose?: () => void;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Distance in pixels a panel is kept from the viewport edge while it is dragged. */
const MARGIN = 8;

/** Local storage key holding where each panel was last left. */
const POSITIONS_KEY = 'axys.dialog.positions';

/** Where each panel was last dragged to, by title. */
type Positions = Record<string, { x: number; y: number }>;

function storedPositions(): Positions {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(POSITIONS_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Positions) : {};
  } catch {
    return {};
  }
}

function rememberPosition(title: string, x: number, y: number): void {
  const positions = storedPositions();
  positions[title] = { x: Math.round(x), y: Math.round(y) };
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {
    // The position still holds for this session, which is the most a refusing browser allows.
  }
}

/**
 * Whether a remembered position still lands the panel on screen.
 *
 * @remarks A panel opens where it was left, but the window it was left in may have been a
 * different size, so a position that would put it off the edge is dropped rather than followed.
 * The stored value is kept: the window may be that size again.
 */
function onScreen(x: number, y: number, width: number, height: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || width <= 0 || height <= 0) return false;
  return (
    x >= MARGIN &&
    y >= MARGIN &&
    x + width <= window.innerWidth - MARGIN &&
    y + height <= window.innerHeight - MARGIN
  );
}

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.offsetParent !== null || element === document.activeElement,
  );
}

/**
 * One panel.
 *
 * @remarks Opening a second panel stacks it above the first. A blocking panel darkens what is
 * behind it and keeps the keyboard inside itself; a non-blocking one does neither.
 */
export class Dialog {
  readonly #element: HTMLElement;
  readonly #backdrop: HTMLElement | null;
  readonly #body: HTMLElement;
  readonly #opener: Element | null;
  readonly #onClose: (() => void) | undefined;
  readonly #blocking: boolean;
  readonly #title: string;
  #closed = false;
  #dragFrom: { x: number; y: number } | null = null;
  #position: { x: number; y: number } | null = null;

  private constructor(options: DialogOptions) {
    this.#opener = document.activeElement;
    this.#onClose = options.onClose;
    this.#blocking = options.blocking !== false;
    this.#title = options.title;

    const parent = options.parent ?? document.body;

    const backdrop = document.createElement('div');
    backdrop.className = 'axys-backdrop';
    backdrop.addEventListener('pointerdown', () => {
      this.close();
    });
    this.#backdrop = this.#blocking ? backdrop : null;
    if (this.#backdrop !== null) {
      parent.append(this.#backdrop);
    }

    const element = document.createElement('div');
    element.className = 'axys-dialog';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', String(this.#blocking));
    element.setAttribute('aria-label', options.title);
    element.tabIndex = -1;

    const head = document.createElement('div');
    head.className = 'axys-dialog-head';

    if (options.icon !== undefined) {
      const mark = document.createElement('span');
      mark.className = 'axys-dialog-icon';
      mark.innerHTML = ICONS[options.icon];
      head.append(mark);
    }

    const heading = document.createElement('h2');
    heading.textContent = options.title;
    head.append(heading);

    // The gap between the title and the close button was already the grab area; the dots are
    // there to say so. One area, where the hand was going anyway.
    const grip = document.createElement('span');
    grip.className = 'axys-spacer axys-dialog-grip';
    grip.setAttribute('aria-hidden', 'true');
    head.append(grip);

    head.append(
      iconButton({
        icon: 'close',
        label: 'Close Dialog',
        onPress: () => {
          this.close();
        },
      }),
    );
    head.addEventListener('pointerdown', this.#onDragStart);
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

    parent.append(element);
    this.#element = element;
  }

  /** Opens a panel and focuses its first control. */
  static open(options: DialogOptions): Dialog {
    const dialog = new Dialog(options);
    dialog.#show();
    return dialog;
  }

  /** The panel element, for tests and for styling hooks. */
  get element(): HTMLElement {
    return this.#element;
  }

  /** The content area, so a caller can replace what it shows while the panel is open. */
  get body(): HTMLElement {
    return this.#body;
  }

  /** True until the panel has closed. */
  get open(): boolean {
    return !this.#closed;
  }

  /** Closes the panel and restores focus. */
  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragEnd);
    document.removeEventListener('pointerdown', this.#onOutside, true);
    this.#backdrop?.remove();
    this.#element.remove();
    if (this.#opener instanceof HTMLElement) {
      this.#opener.focus();
    }
    this.#onClose?.();
  }

  #show(): void {
    this.#restorePosition();
    const first = focusableIn(this.#element)[0];
    (first ?? this.#element).focus();
    if (!this.#blocking) {
      // A panel that does not block still closes when the next thing pressed is outside it and
      // outside the editor's own controls, which is what pressing "somewhere else" means.
      document.addEventListener('pointerdown', this.#onOutside, true);
    }
  }

  /** Opens the panel where it was last left, or centred when that would be off screen. */
  #restorePosition(): void {
    const stored = storedPositions()[this.#title];
    if (stored === undefined) return;
    const bounds = this.#element.getBoundingClientRect();
    if (!onScreen(stored.x, stored.y, bounds.width, bounds.height)) return;
    this.#element.style.left = `${String(stored.x)}px`;
    this.#element.style.top = `${String(stored.y)}px`;
    this.#element.style.transform = 'none';
  }

  #onOutside = (event: Event): void => {
    if (event.target instanceof Node && !this.#element.contains(event.target)) {
      // Only a press on another panel or on the page chrome dismisses it; the editor canvas is
      // where this panel's result is shown, so pressing there is part of using it.
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.axys-canvas-area') === null) {
        this.close();
      }
    }
  };

  #onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key !== 'Tab' || !this.#blocking) {
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

  #onDragStart = (event: PointerEvent): void => {
    if (event.button !== 0 || event.target instanceof HTMLButtonElement) {
      return;
    }
    const bounds = this.#element.getBoundingClientRect();
    this.#position = { x: bounds.left, y: bounds.top };
    this.#dragFrom = { x: event.clientX, y: event.clientY };
    this.#element.classList.add('is-dragging');
    window.addEventListener('pointermove', this.#onDragMove);
    window.addEventListener('pointerup', this.#onDragEnd);
    event.preventDefault();
  };

  #onDragMove = (event: PointerEvent): void => {
    const from = this.#dragFrom;
    const at = this.#position;
    if (from === null || at === null) {
      return;
    }
    const bounds = this.#element.getBoundingClientRect();
    const left = clamp(
      at.x + (event.clientX - from.x),
      MARGIN,
      Math.max(MARGIN, window.innerWidth - bounds.width - MARGIN),
    );
    const top = clamp(
      at.y + (event.clientY - from.y),
      MARGIN,
      Math.max(MARGIN, window.innerHeight - bounds.height - MARGIN),
    );
    this.#element.style.left = `${String(Math.round(left))}px`;
    this.#element.style.top = `${String(Math.round(top))}px`;
    this.#element.style.transform = 'none';
  };

  #onDragEnd = (): void => {
    if (this.#dragFrom !== null) {
      const bounds = this.#element.getBoundingClientRect();
      rememberPosition(this.#title, bounds.left, bounds.top);
    }
    this.#dragFrom = null;
    this.#element.classList.remove('is-dragging');
    window.removeEventListener('pointermove', this.#onDragMove);
    window.removeEventListener('pointerup', this.#onDragEnd);
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** One answer to a confirmation. */
export type Confirmation = 'confirm' | 'alternative' | 'cancel';

/**
 * Asks a question that has to be answered before anything else happens.
 *
 * @remarks Resolves with what was chosen, and with `cancel` when the panel was dismissed, so
 * closing it by Escape or by pressing outside is the answer that changes nothing.
 */
export function confirm(options: {
  title: string;
  message: string;
  /** The action that goes ahead, such as Discard. */
  confirm: string;
  /** A second way forward, such as saving first. Omitted when there is only one. */
  alternative?: string;
  icon?: IconName;
}): Promise<Confirmation> {
  return new Promise((resolve) => {
    let answer: Confirmation = 'cancel';
    const body = document.createElement('p');
    body.className = 'axys-hint';
    body.textContent = options.message;
    const actions: DialogAction[] = [
      {
        label: 'Cancel',
        onSelect: (dialog) => {
          dialog.close();
        },
      },
    ];
    if (options.alternative !== undefined) {
      actions.push({
        label: options.alternative,
        onSelect: (dialog) => {
          answer = 'alternative';
          dialog.close();
        },
      });
    }
    actions.push({
      label: options.confirm,
      kind: 'danger',
      onSelect: (dialog) => {
        answer = 'confirm';
        dialog.close();
      },
    });
    Dialog.open({
      title: options.title,
      ...(options.icon === undefined ? {} : { icon: options.icon }),
      content: body,
      actions,
      onClose: () => {
        resolve(answer);
      },
    });
  });
}
