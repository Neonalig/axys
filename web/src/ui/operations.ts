// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Correction and voice character, as operations rather than as settings.
 *
 * Each opens a panel that applies its edits to the open project as its controls are moved, so
 * the blobs move and the transport plays what the settings produce while the panel is still
 * open. Keeping the result is one button and throwing it away is the other; nothing is decided
 * by closing the panel by accident, because closing it throws the preview away.
 *
 * With a span selected the operation applies to that span, by leaving every blob outside it out
 * of correction. With nothing selected it applies to the whole project.
 */

import { Dialog } from './dialog.js';
import { scopeLine } from './inspector.js';
import {
  checkboxInput,
  field,
  guidedLabel,
  numberInput,
  rangeInput,
  selectInput,
} from './controls/index.js';
import type { CommandContext } from '../app/commands.js';
import type { AppState } from '../app/store.js';
import type { EditOp, FormantMode, ScaleSettings } from '../core/types.js';

/** Pitch-class names, in the spelling the toggles are labelled with. */
const PITCH_CLASSES: readonly string[] = [
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
];

interface ScalePreset {
  id: string;
  label: string;
  degrees: readonly number[];
}

const SCALE_PRESETS: readonly ScalePreset[] = [
  { id: 'major', label: 'Major', degrees: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', label: 'Natural Minor', degrees: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'harmonic', label: 'Harmonic Minor', degrees: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'melodic', label: 'Melodic Minor', degrees: [0, 2, 3, 5, 7, 9, 11] },
  { id: 'dorian', label: 'Dorian', degrees: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'phrygian', label: 'Phrygian', degrees: [0, 1, 3, 5, 7, 8, 10] },
  { id: 'lydian', label: 'Lydian', degrees: [0, 2, 4, 6, 7, 9, 11] },
  { id: 'mixolydian', label: 'Mixolydian', degrees: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'locrian', label: 'Locrian', degrees: [0, 1, 3, 5, 6, 8, 10] },
  { id: 'pentaMajor', label: 'Major Pentatonic', degrees: [0, 2, 4, 7, 9] },
  { id: 'pentaMinor', label: 'Minor Pentatonic', degrees: [0, 3, 5, 7, 10] },
  { id: 'blues', label: 'Blues', degrees: [0, 3, 5, 6, 7, 10] },
  { id: 'chromatic', label: 'Chromatic', degrees: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

function sameDegrees(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function presetFor(degrees: readonly number[]): string {
  return SCALE_PRESETS.find((preset) => sameDegrees(preset.degrees, degrees))?.id ?? 'custom';
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

/** A line of explanation under an operation's controls. */
function hint(text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'axys-hint';
  line.textContent = text;
  return line;
}

/**
 * The edits that confine an operation to the selection.
 *
 * @remarks Correction is compiled project-wide, so applying it to a span means leaving every
 * blob outside that span out of it. Those exclusions are part of the operation: discarding it
 * takes them back with everything else.
 */
function scopeOf(state: AppState): EditOp[] {
  const selected = new Set(state.selection.blobs);
  if (selected.size === 0 || state.blobs.length === 0) {
    return [];
  }
  const ops: EditOp[] = [];
  for (const blob of state.blobs) {
    const wanted = !selected.has(blob.id);
    if (blob.excluded !== wanted) {
      ops.push({ type: 'setExcluded', blob: blob.id, excluded: wanted });
    }
  }
  return ops;
}

/** Opens an operation panel and wires Apply and Discard to the preview it is running. */
function openOperation(options: {
  ctx: CommandContext;
  title: string;
  icon: 'correct' | 'voice';
  content: HTMLElement;
}): Dialog {
  const { ctx } = options;
  let settled = false;
  const dialog = Dialog.open({
    title: options.title,
    icon: options.icon,
    content: options.content,
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
      // Closing without answering throws the preview away, so a panel dismissed by Escape or by
      // pressing elsewhere leaves the project as it was rather than committing by omission.
      if (!settled) ctx.workspace.discardPreview();
    },
  });
  return dialog;
}

/** Opens the Correction operation. */
export function showCorrection(ctx: CommandContext): Dialog {
  const state = ctx.store.state;
  const current = state.edits?.scale ?? null;
  if (current === null) {
    ctx.toast.warn('Open a vocal before correcting it');
    return Dialog.open({ title: 'Correction', content: hint('Nothing to correct') });
  }
  const scopeOps = scopeOf(state);

  const content = document.createElement('div');
  content.className = 'axys-panel';

  const key = selectInput(
    PITCH_CLASSES.map((name, index) => ({ value: String(index), label: name })),
  );
  key.value = String(current.root);
  const scale = selectInput([
    ...SCALE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
    { value: 'custom', label: 'Custom' },
  ]);
  scale.value = presetFor(current.degrees);
  const strength = rangeInput(0, 1, 0.01);
  strength.value = String(current.strength);
  const strengthReadout = document.createElement('span');
  strengthReadout.className = 'axys-readout';
  strengthReadout.textContent = `${String(Math.round(current.strength * 100))}%`;

  const strengthRow = document.createElement('div');
  strengthRow.className = 'axys-field';
  const strengthLabel = guidedLabel(
    'Strength',
    'How far correction pulls a blob onto its scale degree. 0% leaves it where it was sung',
  );
  strengthLabel.htmlFor = strength.id;
  const pair = document.createElement('div');
  pair.className = 'axys-control-pair';
  pair.append(strength, strengthReadout);
  strengthRow.append(strengthLabel, pair);

  const excluded = document.createElement('fieldset');
  excluded.className = 'axys-note-grid';
  const legend = document.createElement('legend');
  legend.textContent = 'Excluded Notes';
  excluded.append(legend);
  const boxes: HTMLInputElement[] = [];
  for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
    const wrapper = document.createElement('label');
    wrapper.className = 'axys-note-toggle';
    const box = checkboxInput();
    box.checked = current.excluded.includes(pitchClass);
    const caption = document.createElement('span');
    caption.textContent = PITCH_CLASSES[pitchClass] ?? '?';
    wrapper.htmlFor = box.id;
    wrapper.append(box, caption);
    excluded.append(wrapper);
    boxes.push(box);
  }

  content.append(
    field('Key', key, 'Tonic the scale is built on. Every scale degree is measured from it'),
    field(
      'Scale',
      scale,
      'The degrees correction is allowed to pull a blob onto. Anything not in the scale is moved to the nearest degree that is',
    ),
    strengthRow,
    excluded,
    scopeLine(state),
  );

  const apply = (): void => {
    const preset = SCALE_PRESETS.find((entry) => entry.id === scale.value);
    const root = Number.parseInt(key.value, 10);
    const settings: ScaleSettings = {
      root: Number.isFinite(root) ? root : current.root,
      degrees: preset ? [...preset.degrees] : [...current.degrees],
      strength: readNumber(strength, current.strength),
      excluded: boxes.flatMap((box, index) => (box.checked ? [index] : [])),
    };
    ctx.workspace.previewEdits([...scopeOps, { type: 'setScale', scale: settings }]);
  };

  strength.addEventListener('input', () => {
    strengthReadout.textContent = `${String(Math.round(readNumber(strength, 0) * 100))}%`;
    apply();
  });
  for (const control of [key, scale, ...boxes]) {
    control.addEventListener('change', apply);
  }

  apply();
  return openOperation({ ctx, title: 'Correction', icon: 'correct', content });
}

/** Opens the Voice Character operation. */
export function showVoiceCharacter(ctx: CommandContext): Dialog {
  const state = ctx.store.state;
  const edits = state.edits;
  if (edits === null) {
    ctx.toast.warn('Open a vocal before shaping it');
    return Dialog.open({ title: 'Voice Character', content: hint('Nothing to shape') });
  }
  const modulation = edits.modulation;
  const formant = edits.formant;

  const content = document.createElement('div');
  content.className = 'axys-panel';

  const drift = rangeInput(0, 1, 0.01);
  drift.value = String(modulation.drift);
  const driftReadout = document.createElement('span');
  driftReadout.className = 'axys-readout';
  const vibrato = rangeInput(0, 2, 0.01);
  vibrato.value = String(modulation.vibratoDepth);
  const vibratoReadout = document.createElement('span');
  vibratoReadout.className = 'axys-readout';
  const shift = rangeInput(-12, 12, 0.1);
  shift.value = typeof formant === 'string' ? '0' : String(formant.shift);
  const shiftReadout = document.createElement('span');
  shiftReadout.className = 'axys-readout';
  const split = numberInput({ step: 0.1, min: 0.5, max: 12 });
  split.value = modulation.vibratoSplitHz.toFixed(1);
  const mode = selectInput([
    { value: 'follow', label: 'Follow Pitch' },
    { value: 'preserve', label: 'Preserve Formants' },
    { value: 'shift', label: 'Shift Formants' },
  ]);
  mode.value = typeof formant === 'string' ? formant : 'shift';

  const row = (
    labelText: string,
    control: HTMLInputElement,
    readout: HTMLElement,
    guide: string,
  ): HTMLElement => {
    const wrapper = document.createElement('div');
    wrapper.className = 'axys-field';
    const label = guidedLabel(labelText, guide);
    label.htmlFor = control.id;
    const pair = document.createElement('div');
    pair.className = 'axys-control-pair';
    pair.append(control, readout);
    wrapper.append(label, pair);
    return wrapper;
  };

  content.append(
    row('Pitch Drift', drift, driftReadout, 'How much slow pitch drift survives correction'),
    row('Vibrato Depth', vibrato, vibratoReadout, 'Scales detected vibrato; 100% keeps it'),
    field('Vibrato Split', split, 'Boundary in Hz between drift and vibrato'),
    field('Formant Mode', mode, 'How the vocal tract is treated while pitch moves'),
    row('Formant Shift', shift, shiftReadout, 'Independent formant movement in semitones'),
    // Drift, vibrato and formants are properties of the voice rather than of a span, and the
    // core compiles them over the whole take, so this one has no selection to narrow it to.
    hint('Affects whole project'),
  );

  const readouts = (): void => {
    driftReadout.textContent = `${String(Math.round(readNumber(drift, 0) * 100))}%`;
    vibratoReadout.textContent = `${String(Math.round(readNumber(vibrato, 0) * 100))}%`;
    shiftReadout.textContent = `${readNumber(shift, 0).toFixed(1)} st`;
  };
  readouts();

  const apply = (): void => {
    readouts();
    shift.disabled = mode.value !== 'shift';
    const chosen: FormantMode =
      mode.value === 'preserve'
        ? 'preserve'
        : mode.value === 'shift'
          ? { shift: readNumber(shift, 0) }
          : 'follow';
    ctx.workspace.previewEdits([
      {
        type: 'setModulation',
        modulation: {
          drift: readNumber(drift, modulation.drift),
          vibratoDepth: readNumber(vibrato, modulation.vibratoDepth),
          vibratoSplitHz: readNumber(split, modulation.vibratoSplitHz),
        },
      },
      { type: 'setFormant', formant: chosen },
    ]);
  };
  shift.disabled = mode.value !== 'shift';

  for (const control of [drift, vibrato, shift]) {
    control.addEventListener('input', apply);
  }
  mode.addEventListener('change', apply);
  split.addEventListener('change', apply);

  return openOperation({ ctx, title: 'Voice Character', icon: 'voice', content });
}
