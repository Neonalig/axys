// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { restoreNewest } from './restore.js';
import type { RestoreSource } from './restore.js';

/** A stored copy, and whether this build can read it. */
interface Stored {
  id: string;
  json: string;
  readable: boolean;
}

/** Records what a restore did to the copies it was given. */
interface Recording extends RestoreSource {
  removed: string[];
  loaded: string[];
  opened: string[];
}

/** Stores `copies` newest first, failing `list` or `remove` where asked. */
function storage(
  copies: readonly Stored[],
  options: { listThrows?: boolean; loadThrows?: readonly string[]; removeThrows?: boolean } = {},
): Recording {
  const remaining = [...copies];
  const removed: string[] = [];
  const loaded: string[] = [];
  return {
    removed,
    loaded,
    opened: [],
    list: () => {
      if (options.listThrows === true) return Promise.reject(new Error('storage is unavailable'));
      return Promise.resolve(remaining.map((copy) => ({ id: copy.id })));
    },
    load: (id) => {
      loaded.push(id);
      if (options.loadThrows?.includes(id) === true) {
        return Promise.reject(new Error('the stored record is unreadable'));
      }
      const copy = remaining.find((entry) => entry.id === id);
      if (!copy) return Promise.reject(new Error('no such copy'));
      return Promise.resolve(copy.json);
    },
    remove: (id) => {
      if (options.removeThrows === true) return Promise.reject(new Error('storage is read only'));
      removed.push(id);
      const at = remaining.findIndex((entry) => entry.id === id);
      if (at >= 0) remaining.splice(at, 1);
      return Promise.resolve();
    },
  };
}

/** Opens a copy when the fixture marked it readable, recording every attempt. */
function opener(copies: readonly Stored[], record: Recording) {
  return (json: string): Promise<boolean> => {
    record.opened.push(json);
    return Promise.resolve(copies.find((copy) => copy.json === json)?.readable ?? false);
  };
}

const READABLE: Stored = { id: 'project-new', json: '{"readable":true}', readable: true };
const OLD_CONTRACT: Stored = { id: 'project-old', json: '{"readable":false}', readable: false };
const OLDER_CONTRACT: Stored = { id: 'project-older', json: '{"older":false}', readable: false };

describe('restoring the newest readable copy', () => {
  it('opens the newest copy and leaves it stored', async () => {
    const copies = [READABLE, OLD_CONTRACT];
    const store = storage(copies);
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: 'project-new', discarded: 0 });
    expect(store.removed).toEqual([]);
    // The older copy is neither read nor touched once a newer one opens.
    expect(store.loaded).toEqual(['project-new']);
  });

  it('opens nothing and discards nothing when nothing is stored', async () => {
    const store = storage([]);
    const result = await restoreNewest(store, opener([], store));

    expect(result).toEqual({ opened: null, discarded: 0 });
    expect(store.removed).toEqual([]);
  });

  it('discards a copy written under an older contract rather than reporting it every launch', async () => {
    const copies = [OLD_CONTRACT];
    const store = storage(copies);
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: null, discarded: 1 });
    expect(store.removed).toEqual(['project-old']);
  });

  it('is clean on the launch after discarding', async () => {
    const copies = [OLD_CONTRACT, OLDER_CONTRACT];
    const store = storage(copies);
    await restoreNewest(store, opener(copies, store));

    const second = await restoreNewest(store, opener(copies, store));
    expect(second).toEqual({ opened: null, discarded: 0 });
    expect(second.discarded).toBe(0);
  });

  it('keeps looking past an unreadable copy so one bad row cannot hide a good one', async () => {
    const copies = [OLD_CONTRACT, OLDER_CONTRACT, READABLE];
    const store = storage(copies);
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: 'project-new', discarded: 2 });
    expect(store.removed).toEqual(['project-old', 'project-older']);
  });

  it('discards a record that will not even load', async () => {
    const copies = [OLD_CONTRACT, READABLE];
    const store = storage(copies, { loadThrows: ['project-old'] });
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: 'project-new', discarded: 1 });
    expect(store.removed).toEqual(['project-old']);
  });

  it('keeps every copy when the storage cannot be listed', async () => {
    const copies = [READABLE];
    const store = storage(copies, { listThrows: true });
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: null, discarded: 0 });
    expect(store.removed).toEqual([]);
  });

  it('reports nothing discarded when the storage refuses to delete', async () => {
    const copies = [OLD_CONTRACT];
    const store = storage(copies, { removeThrows: true });
    const result = await restoreNewest(store, opener(copies, store));

    expect(result).toEqual({ opened: null, discarded: 0 });
    expect(store.removed).toEqual([]);
  });
});
