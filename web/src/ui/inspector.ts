// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inspector: numeric fields for the selected blob and the project-wide correction settings.
 *
 * Every control commits one edit operation, so each change is a single undo step. Controls are
 * built once and refreshed from state, and a control the user is editing is left alone.
 */

import { setTooltip } from './tooltip.js';
import type { AppState } from '../app/store.js';
import type {
  AccidentalStyle,
  Blob,
  EditOp,
  FormantMode,
  GuideMode,
  GuideSelection,
  ScaleSettings,
  TimeDisplay,
  ViewState,
} from '../core/types.js';

/** What the inspector needs in order to change the project. */
export interface InspectorHooks {
  /** Applies one operation to the session and refreshes the store. */
  applyEdit(op: EditOp): void;
  /** Changes saved editor view state, such as the snap division or the ruler mode. */
  setView(patch: Partial<ViewState>): void;
  /** Sets the concert reference in Hz. */
  setTuning(a4Hz: number): void;
  /** Sets how accidentals are spelled. */
  setAccidentals(style: AccidentalStyle): void;
}

/** Pitch-class names in each accidental spelling. */
const NOTE_NAMES: Readonly<Record<AccidentalStyle, readonly string[]>> = {
  sharps: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'],
  flats: ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'],
};

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

const SNAP_DIVISIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Bar' },
  { value: 2, label: 'Half Note' },
  { value: 4, label: 'Quarter Note' },
  { value: 8, label: 'Eighth Note' },
  { value: 12, label: 'Eighth Triplet' },
  { value: 16, label: 'Sixteenth Note' },
  { value: 24, label: 'Sixteenth Triplet' },
  { value: 32, label: 'Thirty-Second' },
];

const GUIDE_MODES: readonly { value: GuideMode; label: string }[] = [
  { value: 'visualOnly', label: 'Visual Only' },
  { value: 'pitchOnly', label: 'Pitch Only' },
  { value: 'timingOnly', label: 'Timing Only' },
  { value: 'combined', label: 'Pitch And Timing' },
];

let sequence = 0;

/** A document-unique id for pairing a label with its control. */
export function nextControlId(prefix: string): string {
  sequence += 1;
  return `axys-${prefix}-${String(sequence)}`;
}

/** Wraps a control in a labelled row and gives the control an accessible name and tooltip. */
export function field(labelText: string, control: HTMLElement, tooltip: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'axys-field';
  const label = document.createElement('label');
  if (control.id === '') {
    control.id = nextControlId('control');
  }
  label.htmlFor = control.id;
  label.textContent = labelText;
  setTooltip(control, tooltip);
  row.append(label, control);
  return row;
}

/** Numeric entry with explicit bounds and step. */
export function numberInput(options: {
  min?: number;
  max?: number;
  step: number;
  readOnly?: boolean;
}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.id = nextControlId('num');
  input.step = String(options.step);
  if (options.min !== undefined) {
    input.min = String(options.min);
  }
  if (options.max !== undefined) {
    input.max = String(options.max);
  }
  if (options.readOnly === true) {
    input.readOnly = true;
    input.setAttribute('aria-readonly', 'true');
  }
  return input;
}

/** Slider over a continuous range. */
export function rangeInput(min: number, max: number, step: number): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'range';
  input.id = nextControlId('range');
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  return input;
}

/** Drop-down over a fixed option list. */
export function selectInput(
  options: readonly { value: string; label: string }[],
): HTMLSelectElement {
  const select = document.createElement('select');
  select.id = nextControlId('select');
  for (const option of options) {
    const element = document.createElement('option');
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  return select;
}

/** Checkbox for a boolean setting. */
export function checkboxInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = nextControlId('check');
  return input;
}

/** Note name of a fractional MIDI number, such as `A#3`. */
export function noteName(midi: number, style: AccidentalStyle): string {
  if (!Number.isFinite(midi)) {
    return '--';
  }
  const rounded = Math.round(midi);
  const pitchClass = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  const name = NOTE_NAMES[style][pitchClass] ?? '?';
  return `${name}${String(octave)}`;
}

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

function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) {
    input.value = value;
  }
}

function setChecked(input: HTMLInputElement, value: boolean): void {
  if (document.activeElement !== input && input.checked !== value) {
    input.checked = value;
  }
}

function panel(title: string): HTMLElement {
  const section = document.createElement('section');
  section.className = 'axys-panel';
  const heading = document.createElement('h2');
  heading.textContent = title;
  section.append(heading);
  return section;
}

function formatSeconds(value: number): string {
  return value.toFixed(3);
}

/**
 * The inspector panel.
 *
 * @remarks Blob fields address the primary selection, which is the last blob the user added to
 * the selection. Fields are disabled, not hidden, when nothing is selected, so the panel does
 * not jump as the selection changes.
 */
export class Inspector {
  readonly #hooks: InspectorHooks;
  readonly #element: HTMLElement;

  readonly #selectionCount: HTMLElement;
  readonly #start: HTMLInputElement;
  readonly #end: HTMLInputElement;
  readonly #duration: HTMLInputElement;
  readonly #timeOffset: HTMLInputElement;
  readonly #detected: HTMLInputElement;
  readonly #detectedName: HTMLElement;
  readonly #target: HTMLInputElement;
  readonly #targetName: HTMLElement;
  readonly #semitones: HTMLInputElement;
  readonly #cents: HTMLInputElement;
  readonly #bypass: HTMLInputElement;
  readonly #excluded: HTMLInputElement;
  readonly #splitButton: HTMLButtonElement;
  readonly #resetButton: HTMLButtonElement;
  readonly #joinButton: HTMLButtonElement;

  readonly #key: HTMLSelectElement;
  readonly #scale: HTMLSelectElement;
  readonly #strength: HTMLInputElement;
  readonly #strengthReadout: HTMLElement;
  readonly #excludedNotes: HTMLInputElement[] = [];
  readonly #excludedLabels: HTMLElement[] = [];
  readonly #drift: HTMLInputElement;
  readonly #driftReadout: HTMLElement;
  readonly #vibrato: HTMLInputElement;
  readonly #vibratoReadout: HTMLElement;
  readonly #vibratoSplit: HTMLInputElement;
  readonly #formantMode: HTMLSelectElement;
  readonly #formantShift: HTMLInputElement;
  readonly #globalBypass: HTMLInputElement;

  readonly #tuning: HTMLInputElement;
  readonly #accidentals: HTMLSelectElement;
  readonly #snap: HTMLSelectElement;
  readonly #timeDisplay: HTMLSelectElement;

  readonly #guideMode: HTMLSelectElement;
  readonly #guideStrength: HTMLInputElement;
  readonly #guideStrengthReadout: HTMLElement;
  readonly #guideMuted: HTMLInputElement;
  readonly #guideHint: HTMLElement;

  #blob: Blob | null = null;
  #state: AppState | null = null;

  constructor(hooks: InspectorHooks) {
    this.#hooks = hooks;

    const element = document.createElement('aside');
    element.className = 'axys-inspector';
    element.setAttribute('aria-label', 'Inspector');
    this.#element = element;

    // Blob panel.
    const blobPanel = panel('Selected Blob');
    this.#selectionCount = document.createElement('p');
    this.#selectionCount.className = 'axys-hint';
    blobPanel.append(this.#selectionCount);

    this.#start = numberInput({ step: 0.001, min: 0 });
    this.#end = numberInput({ step: 0.001, min: 0 });
    this.#duration = numberInput({ step: 0.001, min: 0.01 });
    this.#timeOffset = numberInput({ step: 0.001 });
    this.#detected = numberInput({ step: 0.01, readOnly: true });
    this.#detectedName = document.createElement('span');
    this.#detectedName.className = 'axys-readout';
    this.#target = numberInput({ step: 0.01, min: 0, max: 127 });
    this.#targetName = document.createElement('span');
    this.#targetName.className = 'axys-readout';
    this.#semitones = numberInput({ step: 0.01, min: -48, max: 48 });
    this.#cents = numberInput({ step: 1, min: -4800, max: 4800 });
    this.#bypass = checkboxInput();
    this.#excluded = checkboxInput();

    blobPanel.append(
      field('Blob Start', this.#start, 'Start of the blob in source seconds.'),
      field('Blob End', this.#end, 'End of the blob in source seconds.'),
      field('Duration', this.#duration, 'Output duration of the blob in seconds.'),
      field('Time Offset', this.#timeOffset, 'Seconds the blob is moved along the timeline.'),
      this.#readoutField(
        'Detected Centre',
        this.#detected,
        this.#detectedName,
        'Detected pitch centre in MIDI notes. Analysis evidence, not editable.',
      ),
      this.#readoutField(
        'Target Centre',
        this.#target,
        this.#targetName,
        'Pitch the blob is corrected to, in MIDI notes.',
      ),
      field('Pitch Offset', this.#semitones, 'Semitones the blob is moved in pitch.'),
      field('Offset Cents', this.#cents, 'The same pitch offset expressed in cents.'),
      field(
        'Bypass Blob',
        this.#bypass,
        'Plays this blob unprocessed without discarding its edits.',
      ),
      field(
        'Exclude Blob',
        this.#excluded,
        'Leaves this blob out of scale correction and guidance.',
      ),
    );

    const blobActions = document.createElement('div');
    blobActions.className = 'axys-group';
    this.#splitButton = this.#actionButton('Split Blob', 'Splits the blob at the playhead.');
    this.#joinButton = this.#actionButton(
      'Join Blobs',
      'Joins the two selected neighbouring blobs.',
    );
    this.#resetButton = this.#actionButton(
      'Reset Blob',
      'Restores the detected pitch and timing of the blob.',
    );
    blobActions.append(this.#splitButton, this.#joinButton, this.#resetButton);
    blobPanel.append(blobActions);
    element.append(blobPanel);

    // Scale panel.
    const scalePanel = panel('Key And Scale');
    this.#key = selectInput(
      NOTE_NAMES.sharps.map((name, index) => ({ value: String(index), label: name })),
    );
    this.#scale = selectInput([
      ...SCALE_PRESETS.map((preset) => ({ value: preset.id, label: preset.label })),
      { value: 'custom', label: 'Custom' },
    ]);
    this.#strength = rangeInput(0, 1, 0.01);
    this.#strengthReadout = document.createElement('span');
    this.#strengthReadout.className = 'axys-readout';

    scalePanel.append(
      field('Key', this.#key, 'Tonic the scale is built on.'),
      field('Scale', this.#scale, 'Allowed scale degrees used by pitch correction.'),
      this.#readoutField(
        'Correction Strength',
        this.#strength,
        this.#strengthReadout,
        'How strongly detected pitch is pulled to the nearest allowed note.',
      ),
    );

    const excludedSet = document.createElement('fieldset');
    excludedSet.className = 'axys-note-grid';
    const legend = document.createElement('legend');
    legend.textContent = 'Excluded Notes';
    excludedSet.append(legend);
    for (let pitchClass = 0; pitchClass < 12; pitchClass += 1) {
      const wrapper = document.createElement('label');
      wrapper.className = 'axys-note-toggle';
      const box = checkboxInput();
      setTooltip(box, 'Leaves this note out of automatic correction.');
      const caption = document.createElement('span');
      caption.textContent = NOTE_NAMES.sharps[pitchClass] ?? '?';
      wrapper.htmlFor = box.id;
      wrapper.append(box, caption);
      box.addEventListener('change', () => {
        this.#commitScale();
      });
      this.#excludedNotes.push(box);
      this.#excludedLabels.push(caption);
      excludedSet.append(wrapper);
    }
    scalePanel.append(excludedSet);
    element.append(scalePanel);

    // Modulation and formant panel.
    const voicePanel = panel('Voice Character');
    this.#drift = rangeInput(0, 1, 0.01);
    this.#driftReadout = document.createElement('span');
    this.#driftReadout.className = 'axys-readout';
    this.#vibrato = rangeInput(0, 2, 0.01);
    this.#vibratoReadout = document.createElement('span');
    this.#vibratoReadout.className = 'axys-readout';
    this.#vibratoSplit = numberInput({ step: 0.1, min: 0.5, max: 12 });
    this.#formantMode = selectInput([
      { value: 'follow', label: 'Follow Pitch' },
      { value: 'preserve', label: 'Preserve Formants' },
      { value: 'shift', label: 'Shift Formants' },
    ]);
    this.#formantShift = rangeInput(-12, 12, 0.1);
    this.#globalBypass = checkboxInput();

    voicePanel.append(
      this.#readoutField(
        'Pitch Drift',
        this.#drift,
        this.#driftReadout,
        'How much slow pitch drift survives correction.',
      ),
      this.#readoutField(
        'Vibrato Depth',
        this.#vibrato,
        this.#vibratoReadout,
        'Scales detected vibrato; 1 keeps it as sung.',
      ),
      field('Vibrato Split', this.#vibratoSplit, 'Boundary in Hz between drift and vibrato.'),
      field('Formant Mode', this.#formantMode, 'How the vocal tract is treated while pitch moves.'),
      field('Formant Shift', this.#formantShift, 'Independent formant movement in semitones.'),
      field(
        'Global Bypass',
        this.#globalBypass,
        'Plays the source untouched so edits can be compared.',
      ),
    );
    element.append(voicePanel);

    // Display panel.
    const displayPanel = panel('Display');
    this.#tuning = numberInput({ step: 0.1, min: 380, max: 480 });
    this.#accidentals = selectInput([
      { value: 'sharps', label: 'Sharps' },
      { value: 'flats', label: 'Flats' },
    ]);
    this.#snap = selectInput(
      SNAP_DIVISIONS.map((division) => ({
        value: String(division.value),
        label: division.label,
      })),
    );
    this.#timeDisplay = selectInput([
      { value: 'seconds', label: 'Clock Time' },
      { value: 'barsBeats', label: 'Bars And Beats' },
    ]);

    displayPanel.append(
      field('Tuning Reference', this.#tuning, 'Frequency of A4 in Hz.'),
      field('Accidental Style', this.#accidentals, 'How note names spell accidentals.'),
      field('Snap Division', this.#snap, 'Grid resolution edits snap to.'),
      field(
        'Time Display',
        this.#timeDisplay,
        'Whether the ruler reads clock time or bars and beats.',
      ),
    );
    element.append(displayPanel);

    // Guide panel.
    const guidePanel = panel('MIDI Guide');
    this.#guideMode = selectInput(
      GUIDE_MODES.map((mode) => ({ value: mode.value, label: mode.label })),
    );
    this.#guideStrength = rangeInput(0, 1, 0.01);
    this.#guideStrengthReadout = document.createElement('span');
    this.#guideStrengthReadout.className = 'axys-readout';
    this.#guideMuted = checkboxInput();
    this.#guideHint = document.createElement('p');
    this.#guideHint.className = 'axys-hint';

    guidePanel.append(
      field('Guide Mode', this.#guideMode, 'How the MIDI guide contributes to the pitch target.'),
      this.#readoutField(
        'Guide Strength',
        this.#guideStrength,
        this.#guideStrengthReadout,
        'How far the vocal follows the guide.',
      ),
      field('Mute Guide', this.#guideMuted, 'Hides the guide without discarding the mapping.'),
      this.#guideHint,
    );
    element.append(guidePanel);

    this.#bind();
  }

  /** The inspector element, ready to append to the shell. */
  get element(): HTMLElement {
    return this.#element;
  }

  /** Refreshes every control from application state. */
  update(state: AppState): void {
    this.#state = state;
    const edits = state.edits;
    const style = edits?.accidentals ?? 'sharps';

    const selected = state.selection.blobs;
    const primary = selected.length > 0 ? selected[selected.length - 1] : undefined;
    const blob = primary === undefined ? null : (state.blobs.find((b) => b.id === primary) ?? null);
    this.#blob = blob;

    this.#updateBlob(blob, selected.length, style);
    this.#updateScale(edits?.scale ?? null, style);
    this.#updateVoice(state);
    this.#updateDisplay(state);
    this.#updateGuide(state);
  }

  #updateBlob(blob: Blob | null, selectedCount: number, style: AccidentalStyle): void {
    const controls = [
      this.#start,
      this.#end,
      this.#duration,
      this.#timeOffset,
      this.#target,
      this.#semitones,
      this.#cents,
      this.#bypass,
      this.#excluded,
    ];
    for (const control of controls) {
      control.disabled = blob === null;
    }
    this.#splitButton.disabled = blob === null;
    this.#resetButton.disabled = blob === null;
    this.#joinButton.disabled = selectedCount !== 2;

    if (!blob) {
      this.#selectionCount.textContent = 'No blob selected.';
      for (const control of controls) {
        if (control.type === 'checkbox') {
          setChecked(control, false);
        } else {
          setValue(control, '');
        }
      }
      setValue(this.#detected, '');
      this.#detectedName.textContent = '--';
      this.#targetName.textContent = '--';
      return;
    }

    this.#selectionCount.textContent =
      selectedCount > 1 ? `${String(selectedCount)} blobs selected.` : `Blob ${String(blob.id)}.`;

    const start = blob.start + blob.timeOffset;
    const end = start + (blob.end - blob.start) * blob.timeScale;
    setValue(this.#start, formatSeconds(blob.start));
    setValue(this.#end, formatSeconds(blob.end));
    setValue(this.#duration, formatSeconds(end - start));
    setValue(this.#timeOffset, formatSeconds(blob.timeOffset));
    setValue(this.#detected, blob.detectedCenter.toFixed(2));
    this.#detectedName.textContent = noteName(blob.detectedCenter, style);
    const target = blob.detectedCenter + blob.pitchOffset;
    setValue(this.#target, target.toFixed(2));
    this.#targetName.textContent = noteName(target, style);
    setValue(this.#semitones, blob.pitchOffset.toFixed(2));
    setValue(this.#cents, Math.round(blob.pitchOffset * 100).toFixed(0));
    setChecked(this.#bypass, blob.bypassed);
    setChecked(this.#excluded, blob.excluded);
  }

  #updateScale(scale: ScaleSettings | null, style: AccidentalStyle): void {
    const disabled = scale === null;
    this.#key.disabled = disabled;
    this.#scale.disabled = disabled;
    this.#strength.disabled = disabled;
    for (const box of this.#excludedNotes) {
      box.disabled = disabled;
    }
    for (const [index, label] of this.#excludedLabels.entries()) {
      label.textContent = NOTE_NAMES[style][index] ?? '?';
    }
    if (!scale) {
      this.#strengthReadout.textContent = '--';
      return;
    }
    setValue(this.#key, String(scale.root));
    setValue(this.#scale, presetFor(scale.degrees));
    setValue(this.#strength, String(scale.strength));
    this.#strengthReadout.textContent = `${String(Math.round(scale.strength * 100))}%`;
    for (const [index, box] of this.#excludedNotes.entries()) {
      setChecked(box, scale.excluded.includes(index));
    }
  }

  #updateVoice(state: AppState): void {
    const edits = state.edits;
    const disabled = edits === null;
    for (const control of [
      this.#drift,
      this.#vibrato,
      this.#vibratoSplit,
      this.#formantMode,
      this.#formantShift,
      this.#globalBypass,
    ]) {
      control.disabled = disabled;
    }
    if (!edits) {
      this.#driftReadout.textContent = '--';
      this.#vibratoReadout.textContent = '--';
      return;
    }
    const modulation = edits.modulation;
    setValue(this.#drift, String(modulation.drift));
    this.#driftReadout.textContent = `${String(Math.round(modulation.drift * 100))}%`;
    setValue(this.#vibrato, String(modulation.vibratoDepth));
    this.#vibratoReadout.textContent = `${String(Math.round(modulation.vibratoDepth * 100))}%`;
    setValue(this.#vibratoSplit, modulation.vibratoSplitHz.toFixed(1));

    const formant = edits.formant;
    const mode = typeof formant === 'string' ? formant : 'shift';
    setValue(this.#formantMode, mode);
    setValue(this.#formantShift, typeof formant === 'string' ? '0' : String(formant.shift));
    this.#formantShift.disabled = disabled || mode !== 'shift';
    setChecked(this.#globalBypass, edits.globalBypass);
  }

  #updateDisplay(state: AppState): void {
    const edits = state.edits;
    this.#tuning.disabled = edits === null;
    this.#accidentals.disabled = edits === null;
    if (edits) {
      setValue(this.#tuning, edits.tuning.a4Hz.toFixed(1));
      setValue(this.#accidentals, edits.accidentals);
    }
    setValue(this.#snap, String(state.view.snapDivision));
    setValue(this.#timeDisplay, state.view.timeDisplay);
  }

  #updateGuide(state: AppState): void {
    const guide = state.edits?.guide ?? null;
    const hasMidi = state.midi !== null;
    for (const control of [this.#guideMode, this.#guideStrength, this.#guideMuted]) {
      control.disabled = !hasMidi;
    }
    if (!hasMidi) {
      this.#guideHint.textContent = 'Import a MIDI file to guide pitch or timing.';
      this.#guideStrengthReadout.textContent = '--';
      return;
    }
    const strength = guide?.strength ?? 1;
    setValue(this.#guideMode, guide?.mode ?? 'visualOnly');
    setValue(this.#guideStrength, String(strength));
    this.#guideStrengthReadout.textContent = `${String(Math.round(strength * 100))}%`;
    setChecked(this.#guideMuted, guide?.muted ?? false);
    const report = state.mappingReport;
    const overlaps = state.guideOverlaps.length;
    const mapping = report
      ? `${String(report.unmappedBlobs.length)} blobs and ${String(report.unmappedNotes.length)} notes unmapped.`
      : 'Guide notes are shown over the vocal.';
    this.#guideHint.textContent =
      overlaps > 0 ? `${mapping} ${String(overlaps)} overlapping notes.` : mapping;
  }

  #readoutField(
    labelText: string,
    control: HTMLInputElement,
    readout: HTMLElement,
    tooltip: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'axys-field';
    const label = document.createElement('label');
    label.htmlFor = control.id;
    label.textContent = labelText;
    setTooltip(control, tooltip);
    const pair = document.createElement('div');
    pair.className = 'axys-control-pair';
    pair.append(control, readout);
    row.append(label, pair);
    return row;
  }

  #actionButton(label: string, tooltip: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    setTooltip(button, tooltip);
    return button;
  }

  #bind(): void {
    this.#start.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({
        type: 'moveBoundary',
        blob: blob.id,
        edge: 'start',
        time: readNumber(this.#start, blob.start),
      });
    });

    this.#end.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({
        type: 'moveBoundary',
        blob: blob.id,
        edge: 'end',
        time: readNumber(this.#end, blob.end),
      });
    });

    this.#duration.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      const source = blob.end - blob.start;
      if (source <= 0) return;
      const wanted = readNumber(this.#duration, source * blob.timeScale);
      this.#hooks.applyEdit({
        type: 'setTimeScale',
        blob: blob.id,
        scale: Math.max(wanted, 0.01) / source,
      });
    });

    this.#timeOffset.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      const wanted = readNumber(this.#timeOffset, blob.timeOffset);
      this.#hooks.applyEdit({
        type: 'moveTime',
        blobs: [blob.id],
        seconds: wanted - blob.timeOffset,
      });
    });

    this.#target.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      const wanted = readNumber(this.#target, blob.detectedCenter + blob.pitchOffset);
      this.#hooks.applyEdit({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: wanted - blob.detectedCenter,
      });
    });

    this.#semitones.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: readNumber(this.#semitones, blob.pitchOffset),
      });
    });

    this.#cents.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: readNumber(this.#cents, blob.pitchOffset * 100) / 100,
      });
    });

    this.#bypass.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({ type: 'setBypass', blob: blob.id, bypassed: this.#bypass.checked });
    });

    this.#excluded.addEventListener('change', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({
        type: 'setExcluded',
        blob: blob.id,
        excluded: this.#excluded.checked,
      });
    });

    this.#splitButton.addEventListener('click', () => {
      const blob = this.#blob;
      const state = this.#state;
      if (!blob || !state) return;
      this.#hooks.applyEdit({ type: 'splitBlob', blob: blob.id, time: state.view.playhead });
    });

    this.#joinButton.addEventListener('click', () => {
      const state = this.#state;
      if (!state) return;
      const [first, second] = [...state.selection.blobs].sort((a, b) => a - b);
      if (first === undefined || second === undefined) return;
      this.#hooks.applyEdit({ type: 'joinBlobs', first, second });
    });

    this.#resetButton.addEventListener('click', () => {
      const blob = this.#blob;
      if (!blob) return;
      this.#hooks.applyEdit({ type: 'resetBlob', blob: blob.id });
    });

    this.#key.addEventListener('change', () => {
      this.#commitScale();
    });
    this.#scale.addEventListener('change', () => {
      this.#commitScale();
    });
    this.#strength.addEventListener('input', () => {
      this.#strengthReadout.textContent = `${String(Math.round(readNumber(this.#strength, 0) * 100))}%`;
    });
    this.#strength.addEventListener('change', () => {
      this.#commitScale();
    });

    this.#drift.addEventListener('input', () => {
      this.#driftReadout.textContent = `${String(Math.round(readNumber(this.#drift, 0) * 100))}%`;
    });
    this.#vibrato.addEventListener('input', () => {
      this.#vibratoReadout.textContent = `${String(Math.round(readNumber(this.#vibrato, 0) * 100))}%`;
    });
    for (const control of [this.#drift, this.#vibrato, this.#vibratoSplit]) {
      control.addEventListener('change', () => {
        this.#commitModulation();
      });
    }

    this.#formantMode.addEventListener('change', () => {
      this.#commitFormant();
    });
    this.#formantShift.addEventListener('change', () => {
      this.#commitFormant();
    });

    this.#globalBypass.addEventListener('change', () => {
      this.#hooks.applyEdit({
        type: 'setGlobalBypass',
        bypassed: this.#globalBypass.checked,
      });
    });

    this.#tuning.addEventListener('change', () => {
      const current = this.#state?.edits?.tuning.a4Hz ?? 440;
      this.#hooks.setTuning(readNumber(this.#tuning, current));
    });
    this.#accidentals.addEventListener('change', () => {
      this.#hooks.setAccidentals(this.#accidentals.value === 'flats' ? 'flats' : 'sharps');
    });
    this.#snap.addEventListener('change', () => {
      const division = Number.parseInt(this.#snap.value, 10);
      this.#hooks.setView({ snapDivision: Number.isFinite(division) ? division : 4 });
    });
    this.#timeDisplay.addEventListener('change', () => {
      const display: TimeDisplay =
        this.#timeDisplay.value === 'barsBeats' ? 'barsBeats' : 'seconds';
      this.#hooks.setView({ timeDisplay: display });
    });

    this.#guideMode.addEventListener('change', () => {
      this.#commitGuide();
    });
    this.#guideStrength.addEventListener('input', () => {
      this.#guideStrengthReadout.textContent = `${String(Math.round(readNumber(this.#guideStrength, 0) * 100))}%`;
    });
    this.#guideStrength.addEventListener('change', () => {
      this.#commitGuide();
    });
    this.#guideMuted.addEventListener('change', () => {
      this.#commitGuide();
    });
  }

  #commitScale(): void {
    const current = this.#state?.edits?.scale;
    if (!current) return;
    const root = Number.parseInt(this.#key.value, 10);
    const preset = SCALE_PRESETS.find((entry) => entry.id === this.#scale.value);
    const excluded: number[] = [];
    for (const [index, box] of this.#excludedNotes.entries()) {
      if (box.checked) {
        excluded.push(index);
      }
    }
    const scale: ScaleSettings = {
      root: Number.isFinite(root) ? root : current.root,
      degrees: preset ? [...preset.degrees] : [...current.degrees],
      strength: readNumber(this.#strength, current.strength),
      excluded,
    };
    this.#hooks.applyEdit({ type: 'setScale', scale });
  }

  #commitModulation(): void {
    const current = this.#state?.edits?.modulation;
    if (!current) return;
    this.#hooks.applyEdit({
      type: 'setModulation',
      modulation: {
        drift: readNumber(this.#drift, current.drift),
        vibratoDepth: readNumber(this.#vibrato, current.vibratoDepth),
        vibratoSplitHz: readNumber(this.#vibratoSplit, current.vibratoSplitHz),
      },
    });
  }

  #commitFormant(): void {
    if (!this.#state?.edits) return;
    const mode = this.#formantMode.value;
    const formant: FormantMode =
      mode === 'preserve'
        ? 'preserve'
        : mode === 'shift'
          ? { shift: readNumber(this.#formantShift, 0) }
          : 'follow';
    this.#formantShift.disabled = mode !== 'shift';
    this.#hooks.applyEdit({ type: 'setFormant', formant });
  }

  #commitGuide(): void {
    const state = this.#state;
    if (!state || state.midi === null) return;
    const current = state.edits?.guide ?? null;
    const track = current?.track ?? defaultGuideTrack(state);
    if (track === null) return;
    const mode =
      GUIDE_MODES.find((entry) => entry.value === this.#guideMode.value)?.value ?? 'visualOnly';
    const selection: GuideSelection = {
      track,
      channel: current?.channel ?? null,
      mode,
      strength: readNumber(this.#guideStrength, current?.strength ?? 1),
      muted: this.#guideMuted.checked,
    };
    this.#hooks.applyEdit({ type: 'setGuide', selection });
  }
}

/** First non-percussion track with notes, which a guide defaults to. */
function defaultGuideTrack(state: AppState): number | null {
  const tracks = state.midi?.tracks ?? [];
  const melodic = tracks.find((track) => !track.isPercussion && track.noteCount > 0);
  return melodic?.index ?? tracks[0]?.index ?? null;
}
