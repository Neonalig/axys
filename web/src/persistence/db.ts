// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Local project storage.
 *
 * Project documents live in IndexedDB under an explicitly versioned set of object stores,
 * alongside the media fallback store used when the Origin Private File System is unavailable.
 */

import { isProject, parseJson } from '../core/json';
import type { Project } from '../core/types';

/** Why a persistence operation could not complete. */
export type PersistenceFailure = 'unavailable' | 'quota' | 'missing' | 'corrupt' | 'io';

/** A storage operation that failed for a reason the user can be told about. */
export class PersistenceError extends Error {
  /** Which failure the caller should report or recover from. */
  readonly kind: PersistenceFailure;

  constructor(kind: PersistenceFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PersistenceError';
    this.kind = kind;
  }
}

/** One row of the project list, enough to show and pick a project without loading it. */
export interface ProjectSummary {
  id: string;
  name: string;
  /** Epoch milliseconds of the last save. */
  updated: number;
  sourceName: string;
  /** Source duration in seconds. */
  duration: number;
}

/** Name of the IndexedDB database holding every Axys project. */
export const DB_NAME = 'axys';

/** Object store version this build reads and writes. */
export const DB_VERSION = 1;

/** Object store holding project documents, keyed by project id. */
export const PROJECT_STORE = 'projects';

/** Object store holding source PCM, keyed by fingerprint, used when OPFS is unavailable. */
export const MEDIA_STORE = 'media';

interface ProjectRecord {
  id: string;
  name: string;
  updated: number;
  sourceName: string;
  duration: number;
  json: string;
}

interface MediaRecord {
  fingerprint: string;
  samples: ArrayBuffer;
}

function isProjectRecord(value: unknown): value is ProjectRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.name === 'string' &&
    typeof row.updated === 'number' &&
    typeof row.sourceName === 'string' &&
    typeof row.duration === 'number' &&
    typeof row.json === 'string'
  );
}

function isMediaRecord(value: unknown): value is MediaRecord {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Record<string, unknown>;
  return typeof row.fingerprint === 'string' && row.samples instanceof ArrayBuffer;
}

function isQuotaError(error: unknown): boolean {
  if (!(error instanceof DOMException)) return false;
  return error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** Wraps a thrown storage error as a `PersistenceError`, keeping a quota failure distinguishable. */
export function toPersistenceError(error: unknown, context: string): PersistenceError {
  if (error instanceof PersistenceError) return error;
  if (isQuotaError(error)) {
    return new PersistenceError(
      'quota',
      `${context} ran out of browser storage. Free space or export the project.`,
      { cause: error },
    );
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new PersistenceError('io', `${context} failed: ${detail}`, { cause: error });
}

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function settled(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
  });
}

function upgrade(db: IDBDatabase, oldVersion: number): void {
  if (oldVersion < 1) {
    const projects = db.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
    projects.createIndex('updated', 'updated');
    db.createObjectStore(MEDIA_STORE, { keyPath: 'fingerprint' });
  }
}

/**
 * Opens the Axys database, running the store migrations for the version found on disk.
 *
 * @throws PersistenceError when IndexedDB is absent or blocked, as it is in some private windows.
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    throw new PersistenceError(
      'unavailable',
      'This browser has no IndexedDB, so projects cannot be saved. Export before closing the tab',
    );
  }
  return new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (cause) {
      reject(
        new PersistenceError('unavailable', 'Browser storage is blocked in this window', {
          cause,
        }),
      );
      return;
    }
    request.onupgradeneeded = (event) => {
      upgrade(request.result, event.oldVersion);
    };
    request.onblocked = () => {
      reject(
        new PersistenceError(
          'unavailable',
          'Another Axys tab is upgrading storage. Close it and try again',
        ),
      );
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(
        new PersistenceError(
          'unavailable',
          'Browser storage is unavailable, which private browsing can cause',
          { cause: request.error },
        ),
      );
    };
  });
}

function summarise(id: string, document: Project, updated: number): ProjectSummary {
  return {
    id,
    name: document.name,
    updated,
    sourceName: document.source.name,
    duration: document.source.duration,
  };
}

/** Project documents in IndexedDB, keyed by project id. */
export class ProjectStore {
  readonly #db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    this.#db = db;
  }

  /** Opens the store, creating or migrating the object stores as needed. */
  static async open(): Promise<ProjectStore> {
    return new ProjectStore(await openDatabase());
  }

  /** Lists every stored project, most recently saved first. */
  async list(): Promise<ProjectSummary[]> {
    try {
      const tx = this.#db.transaction(PROJECT_STORE, 'readonly');
      const rows = await promisify(tx.objectStore(PROJECT_STORE).getAll());
      await settled(tx);
      const summaries: ProjectSummary[] = [];
      for (const row of rows) {
        if (!isProjectRecord(row)) continue;
        summaries.push({
          id: row.id,
          name: row.name,
          updated: row.updated,
          sourceName: row.sourceName,
          duration: row.duration,
        });
      }
      summaries.sort((a, b) => b.updated - a.updated);
      return summaries;
    } catch (error) {
      throw toPersistenceError(error, 'Listing projects');
    }
  }

  /**
   * Reads one project document.
   *
   * @throws PersistenceError with kind `missing` when no project has that id.
   */
  async load(id: string): Promise<string> {
    let row: unknown;
    try {
      const tx = this.#db.transaction(PROJECT_STORE, 'readonly');
      row = await promisify(tx.objectStore(PROJECT_STORE).get(id));
      await settled(tx);
    } catch (error) {
      throw toPersistenceError(error, 'Loading the project');
    }
    if (row === undefined) {
      throw new PersistenceError('missing', `No stored project has the id ${id}.`);
    }
    if (!isProjectRecord(row)) {
      throw new PersistenceError('corrupt', 'The stored project record is unreadable');
    }
    return row.json;
  }

  /**
   * Writes one project document and its summary fields.
   *
   * @param json Project document, validated before it is stored.
   * @throws PersistenceError with kind `corrupt` when the document is not a project.
   */
  async save(id: string, json: string): Promise<void> {
    let document: Project;
    try {
      document = parseJson(json, isProject, 'project');
    } catch (cause) {
      throw new PersistenceError('corrupt', 'Refusing to store a document that is not a project', {
        cause,
      });
    }
    const record: ProjectRecord = { ...summarise(id, document, Date.now()), json };
    try {
      const tx = this.#db.transaction(PROJECT_STORE, 'readwrite');
      tx.objectStore(PROJECT_STORE).put(record);
      await settled(tx);
    } catch (error) {
      throw toPersistenceError(error, 'Saving the project');
    }
  }

  /** Deletes one project document. Deleting an absent project succeeds. */
  async remove(id: string): Promise<void> {
    try {
      const tx = this.#db.transaction(PROJECT_STORE, 'readwrite');
      tx.objectStore(PROJECT_STORE).delete(id);
      await settled(tx);
    } catch (error) {
      throw toPersistenceError(error, 'Deleting the project');
    }
  }

  /** Releases the database connection. */
  close(): void {
    this.#db.close();
  }
}

/** Reads source PCM from the IndexedDB media store. */
export async function readMediaRecord(
  db: IDBDatabase,
  fingerprint: string,
): Promise<Float32Array | null> {
  const tx = db.transaction(MEDIA_STORE, 'readonly');
  const row: unknown = await promisify(tx.objectStore(MEDIA_STORE).get(fingerprint));
  await settled(tx);
  if (row === undefined) return null;
  if (!isMediaRecord(row)) {
    throw new PersistenceError('corrupt', 'The stored audio record is unreadable');
  }
  return new Float32Array(row.samples);
}

/** Writes source PCM to the IndexedDB media store. */
export async function writeMediaRecord(
  db: IDBDatabase,
  fingerprint: string,
  samples: Float32Array,
): Promise<void> {
  const copy = samples.slice();
  const record: MediaRecord = { fingerprint, samples: copy.buffer as ArrayBuffer };
  const tx = db.transaction(MEDIA_STORE, 'readwrite');
  tx.objectStore(MEDIA_STORE).put(record);
  await settled(tx);
}

/** True when the IndexedDB media store holds PCM for this fingerprint. */
export async function hasMediaRecord(db: IDBDatabase, fingerprint: string): Promise<boolean> {
  const tx = db.transaction(MEDIA_STORE, 'readonly');
  const count = await promisify(tx.objectStore(MEDIA_STORE).count(fingerprint));
  await settled(tx);
  return count > 0;
}
