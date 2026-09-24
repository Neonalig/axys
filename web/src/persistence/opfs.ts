// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Source audio storage.
 *
 * Each source is kept as a `stored-audio.ts` entry, written to the Origin Private File System where
 * it exists and to IndexedDB where it does not, so a browser without OPFS still reopens a project
 * with its audio attached. Raw PCM kept by an earlier build is still read.
 */

import {
  MEDIA_STORE,
  PersistenceError,
  hasMediaRecord,
  openDatabase,
  readMediaBytes,
  readMediaRecord,
  toPersistenceError,
  writeMediaBytes,
  writeMediaRecord,
} from './db';
import { parseStored, serialiseStored } from './stored-audio';
import type { StoredAudio } from './stored-audio';

/** Where a `MediaStore` keeps its PCM. */
export type MediaBackend = 'opfs' | 'indexeddb';

/** Directory inside the origin private file system holding source PCM. */
const MEDIA_DIRECTORY = 'media';

function checkedKey(fingerprint: string): string {
  // A fingerprint, or one with a lowercase suffix naming a second copy of the same audio kept in
  // another shape, the way a reference keeps its channels beside a clip's mono.
  if (!/^[0-9a-f]{16}(-[a-z]+)?$/.test(fingerprint)) {
    throw new PersistenceError('corrupt', `Not an audio fingerprint: ${fingerprint}`);
  }
  return fingerprint;
}

/** The file an earlier build kept a source's PCM in. */
function fileName(fingerprint: string): string {
  return `${checkedKey(fingerprint)}.pcm`;
}

/** The file a source's audio is kept in, as `stored-audio.ts` describes. */
function storedName(fingerprint: string): string {
  return `${checkedKey(fingerprint)}.audio`;
}

async function openMediaDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (typeof navigator === 'undefined' || navigator.storage === undefined) return null;
  if (typeof navigator.storage.getDirectory !== 'function') return null;
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle(MEDIA_DIRECTORY, { create: true });
  } catch {
    return null;
  }
}

/** Decoded source audio in the Origin Private File System, keyed by fingerprint. */
export class MediaStore {
  readonly #directory: FileSystemDirectoryHandle | null;
  readonly #db: IDBDatabase | null;

  private constructor(directory: FileSystemDirectoryHandle | null, db: IDBDatabase | null) {
    this.#directory = directory;
    this.#db = db;
  }

  /**
   * Opens the media store, preferring OPFS and falling back to IndexedDB.
   *
   * @throws PersistenceError when neither backend is usable.
   */
  static async open(): Promise<MediaStore> {
    const directory = await openMediaDirectory();
    if (directory !== null) return new MediaStore(directory, null);
    const db = await openDatabase();
    return new MediaStore(null, db);
  }

  /** Which backend this store writes to. */
  get backend(): MediaBackend {
    return this.#directory !== null ? 'opfs' : 'indexeddb';
  }

  /** True when PCM for this fingerprint is already stored. */
  async has(fingerprint: string): Promise<boolean> {
    const name = fileName(fingerprint);
    const directory = this.#directory;
    if (directory !== null) {
      try {
        await directory.getFileHandle(name);
        return true;
      } catch {
        return false;
      }
    }
    const db = this.#db;
    if (db === null) return false;
    try {
      return await hasMediaRecord(db, fingerprint);
    } catch (error) {
      throw toPersistenceError(error, 'Check cached audio');
    }
  }

  /**
   * Reads the stored PCM for a fingerprint.
   *
   * @throws PersistenceError with kind `missing` when nothing is stored for it.
   */
  async read(fingerprint: string): Promise<Float32Array> {
    const name = fileName(fingerprint);
    const directory = this.#directory;
    if (directory !== null) {
      let bytes: ArrayBuffer;
      try {
        const handle = await directory.getFileHandle(name);
        const file = await handle.getFile();
        bytes = await file.arrayBuffer();
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') {
          throw new PersistenceError('missing', 'Cached audio missing. Relink the file.');
        }
        throw toPersistenceError(error, 'Read cached audio');
      }
      if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
        throw new PersistenceError('corrupt', 'Cached audio is truncated. Relink the file.');
      }
      return new Float32Array(bytes);
    }
    const db = this.#db;
    if (db === null) {
      throw new PersistenceError('unavailable', 'This browser cannot store decoded audio');
    }
    let samples: Float32Array | null;
    try {
      samples = await readMediaRecord(db, fingerprint);
    } catch (error) {
      throw toPersistenceError(error, 'Read cached audio');
    }
    if (samples === null) {
      throw new PersistenceError('missing', 'Cached audio missing. Relink the file.');
    }
    return samples;
  }

  /**
   * Stores PCM under a fingerprint, replacing any previous copy.
   *
   * @throws PersistenceError with kind `quota` when the origin is out of storage.
   */
  async write(fingerprint: string, samples: Float32Array): Promise<void> {
    const name = fileName(fingerprint);
    const directory = this.#directory;
    if (directory !== null) {
      try {
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(samples.slice().buffer);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => undefined);
          throw error;
        }
      } catch (error) {
        throw toPersistenceError(error, 'Cache audio');
      }
      return;
    }
    const db = this.#db;
    if (db === null) {
      throw new PersistenceError('unavailable', 'This browser cannot store decoded audio');
    }
    try {
      await writeMediaRecord(db, fingerprint, samples);
    } catch (error) {
      throw toPersistenceError(error, 'Cache audio');
    }
  }

  /** A source's audio as kept by {@link writeStored}, or `null` when none is kept. */
  async readStored(fingerprint: string): Promise<StoredAudio | null> {
    const name = storedName(fingerprint);
    let bytes: Uint8Array<ArrayBuffer> | null;
    const directory = this.#directory;
    try {
      if (directory !== null) {
        const handle = await directory.getFileHandle(name);
        bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
      } else if (this.#db !== null) {
        bytes = await readMediaBytes(this.#db, name);
      } else {
        return null;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return null;
      throw toPersistenceError(error, 'Read cached audio');
    }
    return bytes === null ? null : parseStored(bytes);
  }

  /**
   * Keeps a source's audio, replacing any earlier copy, and drops the PCM an earlier build kept.
   *
   * @throws PersistenceError with kind `quota` when the origin is out of storage.
   */
  async writeStored(fingerprint: string, stored: StoredAudio): Promise<void> {
    const name = storedName(fingerprint);
    const bytes = serialiseStored(stored);
    const directory = this.#directory;
    try {
      if (directory !== null) {
        const handle = await directory.getFileHandle(name, { create: true });
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => undefined);
          throw error;
        }
      } else if (this.#db !== null) {
        await writeMediaBytes(this.#db, name, bytes);
      } else {
        throw new PersistenceError('unavailable', 'This browser cannot store decoded audio');
      }
    } catch (error) {
      throw toPersistenceError(error, 'Cache audio');
    }
    await this.remove(fingerprint).catch(() => undefined);
  }

  /** True when a source's audio is kept, in either shape. */
  async hasAny(fingerprint: string): Promise<boolean> {
    if (await this.has(fingerprint)) return true;
    const directory = this.#directory;
    if (directory !== null) {
      try {
        await directory.getFileHandle(storedName(fingerprint));
        return true;
      } catch {
        return false;
      }
    }
    return this.#db !== null && (await hasMediaRecord(this.#db, storedName(fingerprint)));
  }

  /** Deletes the stored PCM for a fingerprint. Deleting absent audio succeeds. */
  async remove(fingerprint: string): Promise<void> {
    const name = fileName(fingerprint);
    const directory = this.#directory;
    if (directory !== null) {
      try {
        await directory.removeEntry(name);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'NotFoundError') return;
        throw toPersistenceError(error, 'Delete cached audio');
      }
      return;
    }
    const db = this.#db;
    if (db === null) return;
    try {
      const tx = db.transaction(MEDIA_STORE, 'readwrite');
      tx.objectStore(MEDIA_STORE).delete(fingerprint);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => {
          resolve();
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      });
    } catch (error) {
      throw toPersistenceError(error, 'Delete cached audio');
    }
  }
}
