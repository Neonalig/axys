// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Choosing which stored copy of a project to reopen on startup.
 *
 * A recovery copy is written only after passing the project contract, so one that no longer opens
 * was written by an earlier build whose contract has since changed. `schemaVersion` records the
 * format and the core migrates between versions, which leaves nothing to migrate a copy from when
 * it fails while claiming the current version: that shape belongs to no version the build knows.
 * Such a copy is discarded rather than kept, because keeping it is a failure on every launch for a
 * document nothing can open, and the search moves on to the next newest rather than stopping.
 */

/** The stored copies a restore chooses between, newest first. */
export interface RestoreSource {
  list(): Promise<readonly { id: string }[]>;
  load(id: string): Promise<string>;
  remove(id: string): Promise<void>;
}

/** What a restore did. */
export interface RestoreResult {
  /** Id of the copy that opened, or `null` when none did. */
  opened: string | null;
  /** How many copies were discarded because this build cannot read them. */
  discarded: number;
}

/**
 * Opens the newest stored copy that this build can still read.
 *
 * @param open Opens one document, answering whether it opened. It must not throw, and must not
 * report a failure to the user: a copy that cannot be read is this function's to report.
 * @remarks A copy that neither loads nor opens is removed and the next is tried, so one bad copy
 * cannot hide a good older one. Only a failure to list the copies at all ends the search, which
 * leaves every copy in place for a later attempt.
 */
export async function restoreNewest(
  source: RestoreSource,
  open: (json: string) => Promise<boolean>,
): Promise<RestoreResult> {
  let stored: readonly { id: string }[];
  try {
    stored = await source.list();
  } catch {
    return { opened: null, discarded: 0 };
  }

  let discarded = 0;
  for (const copy of stored) {
    let json: string | null;
    try {
      json = await source.load(copy.id);
    } catch {
      json = null;
    }
    if (json !== null && (await open(json))) {
      return { opened: copy.id, discarded };
    }
    try {
      await source.remove(copy.id);
      discarded += 1;
    } catch {
      // Storage that will not delete is storage that will not be fixed from here. The editor is
      // already empty, so the only cost is trying this copy again next launch.
    }
  }
  return { opened: null, discarded };
}
