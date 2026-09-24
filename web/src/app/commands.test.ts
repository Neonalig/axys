// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { buildCommands } from './commands.js';

/**
 * Keys more than one command answers to, each set only ever enabled one at a time, so the key
 * runs whichever the context allows.
 */
const SHARED_KEYS: Readonly<Record<string, readonly string[]>> = {
  Delete: ['edit.deleteBlobs', 'edit.deletePitch', 'edit.deleteReference'],
  Backspace: ['edit.deleteBlobs', 'edit.deletePitch', 'edit.deleteReference'],
};

describe('buildCommands', () => {
  const commands = buildCommands();

  it('gives every command a key', () => {
    expect(commands.filter((command) => command.shortcut === undefined).map((c) => c.id)).toEqual(
      [],
    );
  });

  it('gives every command an id of its own', () => {
    const ids = commands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('binds a key to one command unless the commands can never run together', () => {
    const owners = new Map<string, string[]>();
    for (const command of commands) {
      for (const key of [command.shortcut, command.altShortcut]) {
        if (key === undefined) continue;
        owners.set(key, [...(owners.get(key) ?? []), command.id]);
      }
    }
    const clashes = [...owners].filter(
      ([key, ids]) => ids.length > 1 && !ids.every((id) => SHARED_KEYS[key]?.includes(id)),
    );
    expect(clashes).toEqual([]);
  });
});
