// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Debounced recovery saves of the project document.
 *
 * Autosave protects work in progress between explicit saves. It writes the document only, never
 * the decoded media, and reports a failure as a state the shell can show rather than throwing
 * into the editor.
 */

import { PersistenceError, toPersistenceError } from './db';
import type { ProjectStore } from './db';

/** Milliseconds of quiet before a pending autosave runs. */
export const AUTOSAVE_DELAY_MS = 4000;

/** What autosave is doing, and whether the last attempt worked. */
export type AutosaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'failed';

/** Autosave state as the shell displays it. */
export interface AutosaveStatus {
  state: AutosaveState;
  /** True when edits have happened since the last successful save. */
  dirty: boolean;
  /** Epoch milliseconds of the last successful save, or null when nothing has been saved. */
  lastSaved: number | null;
  /** Failure text to show, or null. */
  message: string | null;
}

/** How an `Autosave` reaches the document and reports itself. */
export interface AutosaveOptions {
  store: ProjectStore;
  /** Project id every autosave writes to. */
  id: string;
  /** Returns the current document JSON, or null when there is nothing worth saving. */
  snapshot: () => string | null;
  delayMs?: number;
  onStatus?: (status: AutosaveStatus) => void;
}

/**
 * Saves the project document a short while after the last edit.
 *
 * @remarks Complements explicit save and export; it is never the only copy of the user's work,
 * and a quota or private-browsing failure leaves the editor running with a `failed` status.
 */
export class Autosave {
  readonly #store: ProjectStore;
  readonly #id: string;
  readonly #snapshot: () => string | null;
  readonly #delayMs: number;
  readonly #onStatus: ((status: AutosaveStatus) => void) | null;

  #timer: ReturnType<typeof setTimeout> | null = null;
  #state: AutosaveState = 'idle';
  #dirty = false;
  #lastSaved: number | null = null;
  #message: string | null = null;
  #running: Promise<void> | null = null;
  #disposed = false;

  constructor(options: AutosaveOptions) {
    this.#store = options.store;
    this.#id = options.id;
    this.#snapshot = options.snapshot;
    this.#delayMs = options.delayMs ?? AUTOSAVE_DELAY_MS;
    this.#onStatus = options.onStatus ?? null;
  }

  /** Current status. */
  get status(): AutosaveStatus {
    return {
      state: this.#state,
      dirty: this.#dirty,
      lastSaved: this.#lastSaved,
      message: this.#message,
    };
  }

  /** True when edits have happened since the last successful save. */
  get dirty(): boolean {
    return this.#dirty;
  }

  /** Epoch milliseconds of the last successful save, or null. */
  get lastSaved(): number | null {
    return this.#lastSaved;
  }

  /** Records an edit and schedules a save once editing pauses. */
  markDirty(): void {
    if (this.#disposed) return;
    this.#dirty = true;
    this.#set('pending', this.#message);
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#delayMs);
  }

  /**
   * Saves now, if there is anything to save.
   *
   * @remarks Never rejects; a failure surfaces through `status`.
   */
  async flush(): Promise<AutosaveStatus> {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#running !== null) await this.#running;
    if (this.#disposed || !this.#dirty) return this.status;
    const json = this.#snapshot();
    if (json === null) {
      this.#dirty = false;
      this.#set('idle', null);
      return this.status;
    }
    this.#set('saving', this.#message);
    const attempt = this.#write(json);
    this.#running = attempt;
    await attempt;
    this.#running = null;
    return this.status;
  }

  /** Cancels any pending save and stops responding to edits. */
  dispose(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#disposed = true;
  }

  async #write(json: string): Promise<void> {
    try {
      await this.#store.save(this.#id, json);
      this.#dirty = false;
      this.#lastSaved = Date.now();
      this.#set('saved', null);
    } catch (error) {
      const failure =
        error instanceof PersistenceError ? error : toPersistenceError(error, 'Autosave');
      // Storage failures already name their fix; anything else gets the one that always works.
      const message = /export/i.test(failure.message)
        ? failure.message
        : `${failure.message} Export the project to keep your changes.`;
      this.#set('failed', message);
    }
  }

  #set(state: AutosaveState, message: string | null): void {
    this.#state = state;
    this.#message = message;
    this.#onStatus?.(this.status);
  }
}
