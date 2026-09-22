// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Align Guide, as an operation rather than as a one-shot button.
 *
 * Aligning is a quantisation: it proposes a note for every blob and then moves the vocal onto
 * those notes. It is chosen, watched against the material and then kept or thrown away, the same
 * way Correction and Voice Character are, so how far it pulls and what it pulls are visible
 * before anything is committed. With blobs selected only those are remapped; with nothing
 * selected the whole project is.
 */

import { Dialog } from './dialog.js';
import {
  describeLeftovers,
  field,
  guidedLabel,
  rangeInput,
  scopeLine,
  selectInput,
} from './inspector.js';
import type { CommandContext } from '../app/commands.js';
import type { AppState } from '../app/store.js';
import type { EditOp, GuideMode, GuideSelection, NoteMapping } from '../core/types.js';

/** Guide modes, in the order they are offered. */
const GUIDE_MODES: readonly { value: GuideMode; label: string }[] = [
  { value: 'pitchOnly', label: 'Pitch Only' },
  { value: 'timingOnly', label: 'Timing Only' },
  { value: 'combined', label: 'Pitch And Timing' },
  { value: 'visualOnly', label: 'Visual Only' },
];

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The mappings a proposal contributes, narrowed to the selection.
 *
 * @remarks Every blob outside the selection keeps whatever it is mapped to now, so aligning a
 * phrase leaves the rest of the take where the last alignment put it.
 */
function narrow(
  proposed: readonly NoteMapping[],
  current: readonly NoteMapping[],
  selected: ReadonlySet<number>,
): NoteMapping[] {
  if (selected.size === 0) return [...proposed];
  const kept = new Map<number, NoteMapping>();
  for (const mapping of current) kept.set(mapping.blob, mapping);
  for (const mapping of proposed) {
    if (selected.has(mapping.blob)) kept.set(mapping.blob, mapping);
  }
  return [...kept.values()].sort((a, b) => a.blob - b.blob);
}

/** Opens the Align Guide operation. */
export function showAlignGuide(ctx: CommandContext): Dialog {
  const state: AppState = ctx.store.state;
  const guide = state.edits?.guide ?? null;
  if (guide === null) {
    ctx.toast.warn('Choose a MIDI guide track before aligning it.');
    return Dialog.open({ title: 'Align Guide', content: document.createElement('div') });
  }
  const selected = new Set(state.selection.blobs);
  // Proposed once, against the project as the panel found it. The mapping follows from the
  // blobs and the notes; mode and strength decide what is done with it, not what it is.
  const proposal = ctx.workspace.proposeMappings();
  if (proposal === null) {
    ctx.toast.warn('This guide could not be aligned.');
    return Dialog.open({ title: 'Align Guide', content: document.createElement('div') });
  }
  const mappings = narrow(proposal.mappings, state.edits?.mappings ?? [], selected);

  const content = document.createElement('div');
  content.className = 'axys-panel';

  const mode = selectInput(
    GUIDE_MODES.map((entry) => ({ value: entry.value, label: entry.label })),
  );
  // Aligning to leave the vocal where it is says nothing, so the operation opens on the mode
  // that moves pitch and leaves Visual Only as the thing someone chooses on purpose.
  mode.value = guide.mode === 'visualOnly' ? 'pitchOnly' : guide.mode;

  const strength = rangeInput(0, 1, 0.01);
  strength.value = String(guide.strength);
  const strengthReadout = document.createElement('span');
  strengthReadout.className = 'axys-readout';

  const strengthRow = document.createElement('div');
  strengthRow.className = 'axys-field';
  const strengthLabel = guidedLabel(
    'Guide Strength',
    'How far a mapped blob is pulled onto its note. 0% leaves the vocal where it was sung.',
  );
  strengthLabel.htmlFor = strength.id;
  const pair = document.createElement('div');
  pair.className = 'axys-control-pair';
  pair.append(strength, strengthReadout);
  strengthRow.append(strengthLabel, pair);

  const result = document.createElement('p');
  result.className = 'axys-hint';
  result.textContent = describeLeftovers(
    proposal.report.unmappedBlobs.length,
    proposal.report.unmappedNotes.length,
  );

  content.append(
    field(
      'Guide Mode',
      mode,
      'What the guide moves. A blob mapped to a note is pulled onto that note; Visual Only maps the notes and moves nothing, which is how a mapping is checked before it is used.',
    ),
    strengthRow,
    scopeLine(state),
    result,
  );

  const apply = (): void => {
    strengthReadout.textContent = `${String(Math.round(readNumber(strength, 0) * 100))}%`;
    const selection: GuideSelection = {
      track: guide.track,
      channel: guide.channel,
      mode: GUIDE_MODES.find((entry) => entry.value === mode.value)?.value ?? 'pitchOnly',
      strength: readNumber(strength, guide.strength),
      muted: guide.muted,
    };
    const ops: EditOp[] = [
      { type: 'setGuide', selection },
      { type: 'setMappings', mappings },
    ];
    ctx.workspace.previewEdits(ops);
  };

  strength.addEventListener('input', apply);
  mode.addEventListener('change', apply);
  apply();

  let settled = false;
  const dialog = Dialog.open({
    title: 'Align Guide',
    icon: 'time',
    content,
    blocking: false,
    actions: [
      {
        label: 'Discard',
        onSelect: () => {
          settled = true;
          ctx.workspace.discardPreview();
          dialog.close();
        },
      },
      {
        label: 'Apply',
        kind: 'primary',
        onSelect: () => {
          settled = true;
          ctx.workspace.commitPreview();
          dialog.close();
        },
      },
    ],
    onClose: () => {
      if (!settled) ctx.workspace.discardPreview();
    },
  });
  return dialog;
}
