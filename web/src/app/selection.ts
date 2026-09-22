// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What a selected span covers.
 *
 * A selection is one or more spans of output time. Which blobs and anchors those spans amount to
 * is derived from them rather than stored beside them, so an edit that splits, joins or resets
 * blobs cannot leave the selection naming objects that no longer exist.
 */

import type { Selection } from './store.js';
import type { Blob } from '../core/types.js';
import { blobOutputEnd, blobOutputStart, sourceToOutput } from '../editor/layers/blobs.js';

/** A span of output seconds. */
export interface TimeRange {
  start: number;
  end: number;
}

/**
 * Seconds of slack allowed at a span's edges.
 *
 * @remarks A span drawn onto a blob ends exactly where the blob ends, and its neighbour starts at
 * the same instant, so an inclusive test selects both. Coverage is measured strictly and this is
 * how much floating-point drift still counts as touching rather than covering.
 */
const EDGE_EPSILON = 1e-9;

/** A span with its ends in order. */
export function orderRange(range: TimeRange): TimeRange {
  return range.start <= range.end
    ? { start: range.start, end: range.end }
    : { start: range.end, end: range.start };
}

/**
 * Whether a span covers any of a blob.
 *
 * @remarks Touching at an edge is not coverage. A zero-width span is a point, which is covered
 * when it falls inside the blob.
 */
function covers(range: TimeRange, blob: Blob): boolean {
  const start = blobOutputStart(blob);
  const end = blobOutputEnd(blob);
  if (range.end - range.start <= EDGE_EPSILON) {
    return range.start >= start - EDGE_EPSILON && range.start <= end + EDGE_EPSILON;
  }
  return end - range.start > EDGE_EPSILON && range.end - start > EDGE_EPSILON;
}

/** Whether a point in output seconds falls inside a span. */
function holds(range: TimeRange, at: number): boolean {
  return at >= range.start - EDGE_EPSILON && at <= range.end + EDGE_EPSILON;
}

/**
 * Adds a span to a set of spans, merging any it meets.
 *
 * @remarks Spans that touch or overlap become one, so a set never holds two spans that draw as a
 * single region. The result stays in time order.
 */
export function withRange(ranges: readonly TimeRange[], range: TimeRange): TimeRange[] {
  const added = orderRange(range);
  const merged: TimeRange[] = [];
  let start = added.start;
  let end = added.end;
  for (const existing of ranges) {
    if (existing.end < start - EDGE_EPSILON || existing.start > end + EDGE_EPSILON) {
      merged.push(existing);
      continue;
    }
    start = Math.min(start, existing.start);
    end = Math.max(end, existing.end);
  }
  merged.push({ start, end });
  return merged.sort((a, b) => a.start - b.start);
}

/** The one span covering every selected span, or `null` when nothing is selected. */
export function selectionSpan(ranges: readonly TimeRange[]): TimeRange | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const range of ranges) {
    start = Math.min(start, range.start);
    end = Math.max(end, range.end);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

/** Everything a set of output spans selects. */
export function selectionForRanges(
  blobs: readonly Blob[],
  ranges: readonly TimeRange[],
): Selection {
  const ordered = ranges.map(orderRange).sort((a, b) => a.start - b.start);
  if (ordered.length === 0) {
    return { blobs: [], anchors: [], ranges: [] };
  }
  const selected: number[] = [];
  const anchors: { blob: number; index: number }[] = [];
  for (const blob of blobs) {
    if (!ordered.some((range) => covers(range, blob))) {
      continue;
    }
    selected.push(blob.id);
    for (let index = 0; index < blob.curve.anchors.length; index += 1) {
      const anchor = blob.curve.anchors[index];
      if (anchor === undefined) {
        continue;
      }
      const at = sourceToOutput(blob, anchor.time);
      if (ordered.some((range) => holds(range, at))) {
        anchors.push({ blob: blob.id, index });
      }
    }
  }
  return { blobs: selected, anchors, ranges: ordered };
}

/** Everything one output span selects. */
export function selectionForRange(blobs: readonly Blob[], range: TimeRange | null): Selection {
  return selectionForRanges(blobs, range === null ? [] : [range]);
}

/** The empty selection. */
export function emptySelection(): Selection {
  return { blobs: [], anchors: [], ranges: [] };
}
