// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';
import { clipsTouched, withoutOffline } from './missing.js';

/** A blob id in `clip`, the way the core partitions them. */
function blobIn(clip: number, index: number): number {
  return clip * 2 ** 20 + index;
}

describe('clipsTouched', () => {
  it('names the clips of every blob and clip an edit names', () => {
    expect(
      clipsTouched({ type: 'movePitch', blobs: [blobIn(0, 1), blobIn(2, 3)], semitones: 1 }),
    ).toEqual([0, 2]);
    expect(clipsTouched({ type: 'setGain', blob: blobIn(1, 0), gainDb: 3 })).toEqual([1]);
    expect(clipsTouched({ type: 'moveClip', clip: 4, position: 2 })).toEqual([4]);
    expect(clipsTouched({ type: 'setName', name: 'Take' })).toEqual([]);
  });
});

describe('withoutOffline', () => {
  const offline = new Set([1]);

  it('refuses an edit on a missing clip and keeps the rest', () => {
    expect(withoutOffline({ type: 'setGain', blob: blobIn(1, 0), gainDb: 3 }, offline)).toBeNull();
    const edit = { type: 'setGain' as const, blob: blobIn(0, 0), gainDb: 3 };
    expect(withoutOffline(edit, offline)).toBe(edit);
  });

  it('still removes, deletes from and renames a missing clip', () => {
    expect(withoutOffline({ type: 'removeClip', clip: 1 }, offline)).not.toBeNull();
    expect(withoutOffline({ type: 'deleteBlobs', blobs: [blobIn(1, 0)] }, offline)).not.toBeNull();
    expect(withoutOffline({ type: 'renameClip', clip: 1, name: 'Old' }, offline)).not.toBeNull();
  });

  it('takes a missing clip out of a group without dropping the group', () => {
    const kept = withoutOffline(
      {
        type: 'group',
        ops: [
          { type: 'setExcluded', blob: blobIn(1, 0), excluded: true },
          { type: 'setExcluded', blob: blobIn(0, 0), excluded: true },
          { type: 'setTuning', tuning: { a4Hz: 442 } },
        ],
      },
      offline,
    );
    expect(kept).toEqual({
      type: 'group',
      ops: [
        { type: 'setExcluded', blob: blobIn(0, 0), excluded: true },
        { type: 'setTuning', tuning: { a4Hz: 442 } },
      ],
    });
  });
});
