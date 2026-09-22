// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a selected span covers.
 *
 * A selection is a span of output time. Which blobs and anchors that amounts to is derived from
 * the span rather than stored beside it, so an edit that splits, joins or resets blobs cannot
 * leave the selection naming objects that no longer exist.
 */

import type { Selection } from './store.js';
import type { Blob } from '../core/types.js';
import { blobOutputEnd, blobOutputStart, sourceToOutput } from '../editor/layers/blobs.js';

/** Everything a span of output seconds selects. */
export function selectionForRange(
  blobs: readonly Blob[],
  range: { start: number; end: number } | null,
): Selection {
  if (range === null) {
    return { blobs: [], anchors: [], range: null };
  }
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  const selected: number[] = [];
  const anchors: { blob: number; index: number }[] = [];
  for (const blob of blobs) {
    if (blobOutputEnd(blob) < start || blobOutputStart(blob) > end) {
      continue;
    }
    selected.push(blob.id);
    for (let index = 0; index < blob.curve.anchors.length; index += 1) {
      const anchor = blob.curve.anchors[index];
      if (anchor === undefined) {
        continue;
      }
      const at = sourceToOutput(blob, anchor.time);
      if (at >= start && at <= end) {
        anchors.push({ blob: blob.id, index });
      }
    }
  }
  return { blobs: selected, anchors, range: { start, end } };
}
