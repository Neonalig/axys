// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What may be done to a clip whose audio is missing.
 *
 * A missing clip keeps its blobs and its edits, but nothing can be heard or checked against its
 * audio, so the only edits it takes are the ones that remove it or rename it.
 */

import type { ClipId, EditOp } from '../core/types.js';
import { clipOf } from '../core/types.js';

/** Edits a clip with missing audio still takes. */
const ALLOWED: ReadonlySet<EditOp['type']> = new Set(['removeClip', 'deleteBlobs', 'renameClip']);

/** The clips an edit changes, by the blobs and clips it names. */
export function clipsTouched(op: EditOp): ClipId[] {
  const clips = new Set<ClipId>();
  const blob = (id: number): void => {
    clips.add(clipOf(id));
  };
  switch (op.type) {
    case 'group':
      for (const inner of op.ops) for (const clip of clipsTouched(inner)) clips.add(clip);
      break;
    case 'joinBlobs':
      blob(op.first);
      blob(op.second);
      break;
    case 'movePitch':
    case 'moveTime':
    case 'deleteBlobs':
      op.blobs.forEach(blob);
      break;
    case 'addBlobs':
      for (const added of op.blobs) blob(added.id);
      break;
    case 'trimClip':
    case 'moveClip':
    case 'removeClip':
    case 'renameClip':
      clips.add(op.clip);
      break;
    case 'setMapping':
      if (op.mapping.blob !== undefined) blob(op.mapping.blob);
      break;
    case 'setMappings':
      for (const mapping of op.mappings) if (mapping.blob !== undefined) blob(mapping.blob);
      break;
    default:
      if ('blob' in op && typeof op.blob === 'number') blob(op.blob);
  }
  return [...clips];
}

/**
 * An edit with everything it would change on a missing clip taken out, or `null` when nothing
 * is left.
 *
 * @remarks A group loses only its parts that touch a missing clip, so an operation over the
 * whole project still applies to every clip that has audio. An edit that removes or renames a
 * missing clip is kept.
 */
export function withoutOffline(op: EditOp, offline: ReadonlySet<ClipId>): EditOp | null {
  if (offline.size === 0) return op;
  if (op.type === 'group') {
    const ops = op.ops.flatMap((inner) => {
      const kept = withoutOffline(inner, offline);
      return kept === null ? [] : [kept];
    });
    return ops.length === 0 ? null : { type: 'group', ops };
  }
  if (ALLOWED.has(op.type)) return op;
  return clipsTouched(op).some((clip) => offline.has(clip)) ? null : op;
}
