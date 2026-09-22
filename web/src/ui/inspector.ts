// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inspector: numeric fields for the selected blob and the project-wide correction settings.
 *
 * Every control commits one edit operation, so each change is a single undo step. Controls are
 * built once and refreshed from state, and a control the user is editing is left alone.
 */

import { ICONS } from './icons.js';
import type { IconName } from './icons.js';
import { setTooltip } from './tooltip.js';
import type { AppState, FollowMode } from '../app/store.js';
import type {
  AccidentalStyle,
  Blob,
  EditOp,
  GuideMode,
  GuideSelection,
  TimeDisplay,
  ViewState,
} from '../core/types.js';

/** What the inspector needs in order to change the project. */
export interface InspectorHooks {
  /** Applies one operation to the session and refreshes the store. */
  applyEdit(op: EditOp): void;
  /** Changes saved editor view state, such as the snap division or the ruler mode. */
  setView(patch: Partial<ViewState>): void;
  /** Chooses how the view keeps up with a playing playhead. */
  setFollowMode(mode: FollowMode): void;
  /** Shows or hides the names beside the toolbar icons. */
  setToolbarLabels(on: boolean): void;
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

const SNAP_DIVISIONS: readonly { value: number; label: string }[] = [
  { value: 1, label: 'Bar' },
  { value: 2, label: 'Minim (Half Note)' },
  { value: 4, label: 'Crotchet (Quarter Note)' },
  { value: 8, label: 'Quaver (Eighth Note)' },
  { value: 12, label: 'Quaver Triplet (Eighth Triplet)' },
  { value: 16, label: 'Semiquaver (Sixteenth Note)' },
  { value: 24, label: 'Semiquaver Triplet (Sixteenth Triplet)' },
  { value: 32, label: 'Demisemiquaver (Thirty-Second)' },
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

/** Which half of the inspector is showing. */
export type InspectorTab = 'project' | 'properties';

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
  readonly #excluded: HTMLInputElement;
  readonly #splitButton: HTMLButtonElement;
  readonly #resetButton: HTMLButtonElement;
  readonly #joinButton: HTMLButtonElement;

  readonly #tuning: HTMLInputElement;
  readonly #accidentals: HTMLSelectElement;
  readonly #snap: HTMLSelectElement;
  readonly #timeDisplay: HTMLSelectElement;
  readonly #followMode: HTMLSelectElement;
  readonly #toolbarLabels: HTMLInputElement;

  readonly #guideMode: HTMLSelectElement;
  readonly #guideStrength: HTMLInputElement;
  readonly #guideStrengthReadout: HTMLElement;
  readonly #guideMuted: HTMLInputElement;
  readonly #guideHint: HTMLElement;

  readonly #tabButtons = new Map<InspectorTab, HTMLButtonElement>();
  readonly #tabPanes = new Map<InspectorTab, HTMLElement>();

  #blob: Blob | null = null;
  #state: AppState | null = null;
  #tab: InspectorTab = 'project';
  #hadSelection = false;

  constructor(hooks: InspectorHooks) {
    this.#hooks = hooks;

    const element = document.createElement('aside');
    element.className = 'axys-inspector';
    element.setAttribute('aria-label', 'Inspector');
    this.#element = element;

    // Two tabs rather than one long column: the project settings are always meaningful, while
    // the selection's fields have nothing to say until something is selected.
    const tabs = document.createElement('div');
    tabs.className = 'axys-tabs';
    tabs.setAttribute('role', 'tablist');
    const project = this.#buildTab(tabs, 'project', 'Project', 'settings');
    const properties = this.#buildTab(tabs, 'properties', 'Properties', 'properties');
    element.append(tabs, project, properties);

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
    properties.append(blobPanel);

    // Correction and voice character are operations rather than settings, so neither is
    // drawn here; each opens its own panel and previews in the editor while it is open.

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
    this.#followMode = selectInput([
      { value: 'page', label: 'Page Ahead' },
      { value: 'centre', label: 'Keep Centred' },
    ]);
    this.#toolbarLabels = checkboxInput();

    displayPanel.append(
      field('Tuning Reference', this.#tuning, 'Frequency of A4 in Hz.'),
      field('Accidental Style', this.#accidentals, 'How note names spell accidentals.'),
      field('Snap Division', this.#snap, 'Grid resolution edits snap to.'),
      field(
        'Time Display',
        this.#timeDisplay,
        'Whether the ruler reads clock time or bars and beats.',
      ),
      field(
        'Follow Mode',
        this.#followMode,
        'Whether a following view jumps ahead a screen at a time or holds the playhead centred.',
      ),
      field('Button Names', this.#toolbarLabels, 'Shows each toolbar button name beside its icon.'),
    );
    project.append(displayPanel);

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
    project.append(guidePanel);

    this.#setTab('project');
    this.#bind();
  }

  /** The inspector element, ready to append to the shell. */
  get element(): HTMLElement {
    return this.#element;
  }

  /** Refreshes every control from application state. */
  /** Builds one tab button and its pane, and registers both. */
  #buildTab(tabs: HTMLElement, name: InspectorTab, label: string, icon: IconName): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'axys-tab';
    const mark = document.createElement('span');
    mark.className = 'axys-tab-icon';
    mark.innerHTML = ICONS[icon];
    const text = document.createElement('span');
    text.textContent = label;
    button.append(mark, text);
    button.setAttribute('role', 'tab');
    button.addEventListener('click', () => {
      this.#setTab(name);
    });
    tabs.append(button);

    const pane = document.createElement('div');
    pane.className = 'axys-tab-pane';
    pane.setAttribute('role', 'tabpanel');
    pane.setAttribute('aria-label', label);

    this.#tabButtons.set(name, button);
    this.#tabPanes.set(name, pane);
    return pane;
  }

  /** Shows one tab and marks its button, ignoring a tab that has nothing to show. */
  #setTab(name: InspectorTab): void {
    const button = this.#tabButtons.get(name);
    if (button?.disabled === true) {
      return;
    }
    this.#tab = name;
    for (const [id, pane] of this.#tabPanes) {
      pane.hidden = id !== name;
      this.#tabButtons.get(id)?.setAttribute('aria-selected', String(id === name));
    }
  }

  update(state: AppState): void {
    this.#state = state;

    // Selecting something brings its fields forward; dropping the selection hands the panel
    // back to the project, so the sidebar is never a page of blanks.
    const hasSelection = state.selection.ranges.length > 0 || state.selection.blobs.length > 0;
    this.#tabButtons.get('properties')?.toggleAttribute('disabled', !hasSelection);
    if (hasSelection !== this.#hadSelection) {
      this.#hadSelection = hasSelection;
      this.#setTab(hasSelection ? 'properties' : 'project');
    } else if (!hasSelection && this.#tab === 'properties') {
      this.#setTab('project');
    }
    const edits = state.edits;
    const style = edits?.accidentals ?? 'sharps';

    const selected = state.selection.blobs;
    const primary = selected.length > 0 ? selected[selected.length - 1] : undefined;
    const blob = primary === undefined ? null : (state.blobs.find((b) => b.id === primary) ?? null);
    this.#blob = blob;

    this.#updateBlob(blob, selected.length, style);
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
    setChecked(this.#excluded, blob.excluded);
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
    setValue(this.#followMode, state.followMode);
    setChecked(this.#toolbarLabels, state.toolbarLabels);
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
    this.#followMode.addEventListener('change', () => {
      this.#hooks.setFollowMode(this.#followMode.value === 'centre' ? 'centre' : 'page');
    });
    this.#toolbarLabels.addEventListener('change', () => {
      this.#hooks.setToolbarLabels(this.#toolbarLabels.checked);
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
