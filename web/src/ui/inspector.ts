// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The inspector: numeric fields for the selected blob and the project-wide correction settings.
 *
 * Every control commits one edit operation, so each change is a single undo step. Controls are
 * built once and refreshed from state, and a control the user is editing is left alone.
 */

import { noteName } from '../core/notes.js';
import {
  bindDragAdjust,
  checkboxInput,
  field,
  guidedLabel,
  numberInput,
  rangeInput,
  selectInput,
  swapGlyph,
  textInput,
} from './controls/index.js';
import type { SelectElement } from './controls/index.js';
import { ICONS, stateIcon } from './icons.js';
import { musicMarkup } from './music.js';
import type { MusicGlyph } from './music.js';
import type { IconName } from './icons.js';
import { setTooltip } from './tooltip.js';
import type { AppState, FollowMode } from '../app/store.js';
import { MAX_GAIN_DB, MIN_GAIN_DB } from '../core/types.js';
import type {
  AccidentalStyle,
  Blob,
  BlobId,
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
  /** Renames the project. One undo step, like any other edit. */
  setProjectName(name: string): void;
  /** Folds the inspector away to its rail, or opens it again. */
  setCollapsed(on: boolean): void;
}

/** Longest a project name may be, matching the limit the core enforces. */
const MAX_PROJECT_NAME = 120;

/*
 * Each division carries the note it divides by, set in Bravura. A triplet has no glyph of its own,
 * so it borrows the note it is three of, which is how a score writes one.
 */
const SNAP_DIVISIONS: readonly { value: number; label: string; glyph: MusicGlyph }[] = [
  { value: 1, label: 'Bar', glyph: 'noteWhole' },
  { value: 2, label: 'Minim (Half Note)', glyph: 'noteHalfUp' },
  { value: 4, label: 'Crotchet (Quarter Note)', glyph: 'noteQuarterUp' },
  { value: 8, label: 'Quaver (Eighth Note)', glyph: 'note8thUp' },
  { value: 12, label: 'Quaver Triplet (Eighth Triplet)', glyph: 'note8thUp' },
  { value: 16, label: 'Semiquaver (Sixteenth Note)', glyph: 'note16thUp' },
  { value: 24, label: 'Semiquaver Triplet (Sixteenth Triplet)', glyph: 'note16thUp' },
  { value: 32, label: 'Demisemiquaver (Thirty-Second)', glyph: 'note32ndUp' },
];

const GUIDE_MODES: readonly { value: GuideMode; label: string }[] = [
  { value: 'visualOnly', label: 'Visual Only' },
  { value: 'pitchOnly', label: 'Pitch Only' },
  { value: 'timingOnly', label: 'Timing Only' },
  { value: 'combined', label: 'Pitch and Timing' },
];

/** A count with its noun, singular where the count is one. */
export function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** How many blobs and notes a guide proposal left over. */
export function describeLeftovers(blobs: number, notes: number): string {
  return `${plural(blobs, 'blob')} and ${plural(notes, 'note')} unmapped.`;
}

/**
 * What an operation acts on, as one line under its controls.
 *
 * @remarks The same sentence everywhere, because what an operation covers is the one thing every
 * operation has to say and saying it differently each time makes it a thing to read rather than
 * a thing to glance at.
 */
export function scopeLine(state: AppState): HTMLElement {
  const line = document.createElement('p');
  line.className = 'axys-hint';
  const count = state.selection.blobs.length;
  line.textContent =
    count === 0
      ? 'No selection. Affects whole project'
      : `Affects ${String(count)} selected ${count === 1 ? 'blob' : 'blobs'}.`;
  return line;
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function setValue(input: HTMLInputElement | SelectElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) {
    input.value = value;
  }
}

/** The dash a field shows when the blobs it addresses do not agree on a value. */
const MIXED = '--';

/**
 * Shows one figure across the selection, or a dash where the selection disagrees.
 *
 * @remarks A blank field with the dash as its placeholder rather than a dash as its value: the
 * field is still empty, so typing in it commits the number typed and nothing has to be cleared
 * first, and leaving it alone commits nothing.
 */
function setShared(input: HTMLInputElement, values: readonly number[], digits: number): void {
  if (document.activeElement === input) {
    return;
  }
  const first = values[0];
  // Agreement is judged at the precision the field shows, so two values that round to the same
  // figure are not reported as a disagreement the field cannot draw.
  const tolerance = 0.5 * 10 ** -digits;
  const agreed =
    first !== undefined && values.every((value) => Math.abs(value - first) < tolerance);
  input.placeholder = agreed ? '' : MIXED;
  setValue(input, agreed && first !== undefined ? first.toFixed(digits) : '');
}

/** Shows a switch across the selection, indeterminate where the selection disagrees. */
function setSharedChecked(input: HTMLInputElement, values: readonly boolean[]): void {
  if (document.activeElement === input) {
    return;
  }
  const agreed = values.every((value) => value === values[0]);
  input.indeterminate = !agreed;
  if (agreed) {
    setChecked(input, values[0] ?? false);
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

/** Output length of a blob in seconds, with its timing edits applied. */
function outputDuration(blob: Blob): number {
  return (blob.end - blob.start) * blob.timeScale;
}

/** One note name across the selection, or a dash where the selection disagrees. */
function noteText(values: readonly number[], style: AccidentalStyle): string {
  const first = values[0];
  if (first === undefined) return MIXED;
  return values.every((value) => Math.abs(value - first) < 5e-3) ? noteName(first, style) : MIXED;
}

/** Longest the blob heading's id list is allowed to run before it is elided. */
const HEADING_CHARS = 26;

/**
 * What the blob panel is headed with: the ids that are selected.
 *
 * @remarks Runs of consecutive ids collapse to a range, and a list too long for the heading
 * keeps its first and last entries with an ellipsis between them, so the heading stays one line
 * whether one blob is selected or two hundred.
 */
export function headingFor(ids: readonly BlobId[]): string {
  if (ids.length === 0) return 'Selected Blob';
  const sorted = [...ids].sort((a, b) => a - b);
  const runs: string[] = [];
  let from = sorted[0] ?? 0;
  let to = from;
  for (const id of sorted.slice(1)) {
    if (id === to + 1) {
      to = id;
      continue;
    }
    runs.push(from === to ? String(from) : `${String(from)}-${String(to)}`);
    from = id;
    to = id;
  }
  runs.push(from === to ? String(from) : `${String(from)}-${String(to)}`);

  let list = runs.join(', ');
  if (list.length > HEADING_CHARS && runs.length > 2) {
    list = `${runs[0] ?? ''}, ..., ${runs[runs.length - 1] ?? ''}`;
  }
  return `${ids.length === 1 ? 'Selected Blob' : 'Selected Blobs'} (#${list})`;
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
  readonly #gain: HTMLInputElement;
  readonly #excluded: HTMLInputElement;
  readonly #blobHeading: HTMLElement;

  readonly #tuning: HTMLInputElement;
  readonly #projectName: HTMLInputElement;
  readonly #accidentals: SelectElement;
  readonly #snap: SelectElement;
  readonly #timeDisplay: SelectElement;
  readonly #followMode: SelectElement;
  readonly #toolbarLabels: HTMLInputElement;

  readonly #guidePanel: HTMLElement;
  readonly #guideMode: SelectElement;
  readonly #guideStrength: HTMLInputElement;
  readonly #guideStrengthReadout: HTMLElement;
  readonly #guideStrengthRow: HTMLElement;
  readonly #guideMuted: HTMLInputElement;
  readonly #guideMutedRow: HTMLElement;
  readonly #guideHint: HTMLElement;

  readonly #tabButtons = new Map<InspectorTab, HTMLButtonElement>();
  readonly #tabPanes = new Map<InspectorTab, HTMLElement>();

  readonly #fold: HTMLButtonElement;
  #collapsed = false;

  #blob: Blob | null = null;
  /** Every selected blob, which is what the bulk-editable fields commit to. */
  #blobs: readonly Blob[] = [];
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

    // The fold control sits beside the tabs rather than inside them: it is not a third thing to
    // look at, it is what gets all of them out of the way of the editor.
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'axys-icon axys-inspector-fold';
    swapGlyph(fold, stateIcon('inspectorFold', true));
    fold.addEventListener('click', () => {
      this.#hooks.setCollapsed(!this.#collapsed);
    });
    fold.setAttribute('aria-label', 'Hide Inspector');
    fold.setAttribute('aria-expanded', 'true');
    setTooltip(fold, 'Hide Inspector');
    this.#fold = fold;

    const head = document.createElement('div');
    head.className = 'axys-inspector-head';
    head.append(tabs, fold);
    element.append(head, project, properties);

    // Blob panel. Its heading names what is selected, so the fields under it need not repeat
    // the word blob, and the actions on a blob stay on the blob, in its own menu.
    const blobPanel = panel('Selected Blob');
    this.#blobHeading = blobPanel.querySelector('h2') ?? blobPanel;
    this.#selectionCount = document.createElement('p');
    this.#selectionCount.className = 'axys-hint axys-selection-count';
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
    this.#gain = numberInput({ step: 0.5, min: MIN_GAIN_DB, max: MAX_GAIN_DB });
    this.#excluded = checkboxInput();

    blobPanel.append(
      field('Start', this.#start, 'Start of the blob in source seconds'),
      field('End', this.#end, 'End of the blob in source seconds'),
      field('Duration', this.#duration, 'Output duration of the blob in seconds'),
      field('Time Offset', this.#timeOffset, 'Seconds the blob is moved along the timeline'),
      this.#readoutField(
        'Detected Centre',
        this.#detected,
        this.#detectedName,
        'Detected pitch centre in MIDI notes. Analysis evidence, not editable',
      ),
      this.#readoutField(
        'Target Centre',
        this.#target,
        this.#targetName,
        'Pitch the blob is corrected to, in MIDI notes',
      ),
      field('Pitch Offset', this.#semitones, 'Semitones the blob is moved in pitch'),
      field('Offset Cents', this.#cents, 'The same pitch offset expressed in cents'),
      field(
        'Gain',
        this.#gain,
        `Level of the blob in decibels, so one word can be lifted or dropped. ${String(MIN_GAIN_DB)} dB is silence.`,
      ),
      field(
        'Exclude',
        this.#excluded,
        'Leaves this blob out of scale correction and MIDI guidance. It still sounds, and edits made on it by hand still apply',
      ),
    );
    properties.append(blobPanel);

    // Correction and voice character are operations rather than settings, so neither is
    // drawn here; each opens its own panel and previews in the editor while it is open.

    // Project panel: what the project is called, which the tab title, the window titlebar, the
    // save file name and the export default all read.
    const projectPanel = panel('Project');
    this.#projectName = textInput(MAX_PROJECT_NAME);
    projectPanel.append(
      field('Name', this.#projectName, 'What this project is called. Renaming is undoable'),
    );
    project.append(projectPanel);

    // Display panel.
    const displayPanel = panel('Display');
    this.#tuning = numberInput({ step: 0.1, min: 380, max: 480 });
    this.#accidentals = selectInput([
      { value: 'sharps', label: 'Sharps', glyph: musicMarkup('accidentalSharp', 'Sharp') },
      { value: 'flats', label: 'Flats', glyph: musicMarkup('accidentalFlat', 'Flat') },
    ]);
    this.#snap = selectInput(
      SNAP_DIVISIONS.map((division) => ({
        value: String(division.value),
        label: division.label,
        glyph: musicMarkup(division.glyph, division.label),
      })),
    );
    this.#timeDisplay = selectInput([
      { value: 'seconds', label: 'Clock Time' },
      { value: 'barsBeats', label: 'Bars and Beats' },
    ]);
    this.#followMode = selectInput([
      { value: 'page', label: 'Page Ahead' },
      { value: 'centre', label: 'Keep Centred' },
    ]);
    this.#toolbarLabels = checkboxInput();

    displayPanel.append(
      field('Tuning Reference', this.#tuning, 'Frequency of A4 in Hz'),
      field('Accidental Style', this.#accidentals, 'How note names spell accidentals'),
      field('Snap Division', this.#snap, 'Grid resolution edits snap to'),
      field(
        'Time Display',
        this.#timeDisplay,
        'Whether the ruler reads clock time or bars and beats',
      ),
      field(
        'Follow Mode',
        this.#followMode,
        'Whether a following view jumps ahead a screen at a time or holds the playhead centred',
      ),
      field('Button Names', this.#toolbarLabels, 'Shows each toolbar button name beside its icon'),
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

    this.#guideStrengthRow = this.#readoutField(
      'Guide Strength',
      this.#guideStrength,
      this.#guideStrengthReadout,
      'How far a mapped blob is pulled onto its note. 0% leaves the vocal where it was sung',
    );
    this.#guideMutedRow = field(
      'Mute Guide',
      this.#guideMuted,
      'Stops the guide sounding and hides its notes. The mapping is kept, so unmuting brings it back as it was',
    );
    guidePanel.append(
      field(
        'Guide Mode',
        this.#guideMode,
        'What the guide contributes: the pitch of each mapped blob, its timing, or both. Visual Only draws the notes and moves nothing',
      ),
      this.#guideStrengthRow,
      this.#guideMutedRow,
      this.#guideHint,
    );
    project.append(guidePanel);
    this.#guidePanel = guidePanel;

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

  /**
   * Folds the panel away, or opens it again.
   *
   * @remarks Only the element's own class and the fold button's face. How wide the column is
   * belongs to the shell, which owns the grid the panel sits in.
   */
  #setCollapsed(on: boolean): void {
    if (this.#collapsed === on) {
      return;
    }
    this.#collapsed = on;
    this.#element.classList.toggle('is-collapsed', on);
    const label = on ? 'Show Inspector' : 'Hide Inspector';
    swapGlyph(this.#fold, stateIcon('inspectorFold', !on));
    this.#fold.setAttribute('aria-label', label);
    this.#fold.setAttribute('aria-expanded', String(!on));
    setTooltip(this.#fold, label);
  }

  /**
   * Opens the project tab and puts the caret in the name, ready to be typed over.
   *
   * @remarks What pressing the title in the toolbar does. The panel has to be unfolded first, and
   * that is the shell's to do, so this asks for it rather than reaching for the grid itself.
   */
  editProjectName(): void {
    this.#hooks.setCollapsed(false);
    this.#setTab('project');
    this.#projectName.focus();
    this.#projectName.select();
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
    this.#setCollapsed(state.inspectorCollapsed);

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

    // Left alone while it holds the caret, so an autosave or a playhead update does not rewrite
    // a name halfway through being typed.
    this.#projectName.disabled = state.projectName === null;
    if (document.activeElement !== this.#projectName) {
      this.#projectName.value = state.projectName ?? '';
    }

    const selected = state.selection.blobs;
    const primary = selected.length > 0 ? selected[selected.length - 1] : undefined;
    const blob = primary === undefined ? null : (state.blobs.find((b) => b.id === primary) ?? null);
    this.#blob = blob;
    const wanted = new Set(selected);
    this.#blobs = state.blobs.filter((candidate) => wanted.has(candidate.id));

    this.#updateBlob(blob, selected, style);
    this.#updateDisplay(state);
    this.#updateGuide(state);
  }

  #updateBlob(blob: Blob | null, selectedIds: readonly BlobId[], style: AccidentalStyle): void {
    const selectedCount = selectedIds.length;
    const controls = [
      this.#start,
      this.#end,
      this.#duration,
      this.#timeOffset,
      this.#target,
      this.#semitones,
      this.#cents,
      this.#gain,
      this.#excluded,
    ];
    for (const control of controls) {
      control.disabled = blob === null;
    }
    if (!blob) {
      this.#blobHeading.textContent = 'Selected Blob';
      this.#selectionCount.hidden = false;
      this.#selectionCount.textContent = 'No blob selected';
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

    this.#blobHeading.textContent = headingFor(selectedIds);
    // One selected blob is what the heading already says, so the count under it is a line that
    // repeats the line above it.
    this.#selectionCount.hidden = selectedCount <= 1;
    this.#selectionCount.textContent = `${plural(selectedCount, 'blob')} selected.`;

    // Start and End are one blob's own boundaries, so they stay on the blob the heading leads
    // with. Everything else is a figure a whole selection can carry, so it reads across the
    // selection and writes back to all of it.
    const blobs = this.#blobs.length > 0 ? this.#blobs : [blob];
    setValue(this.#start, formatSeconds(blob.start));
    setValue(this.#end, formatSeconds(blob.end));
    setShared(this.#duration, blobs.map(outputDuration), 3);
    setShared(
      this.#timeOffset,
      blobs.map((entry) => entry.timeOffset),
      3,
    );
    setShared(
      this.#detected,
      blobs.map((entry) => entry.detectedCenter),
      2,
    );
    setShared(
      this.#target,
      blobs.map((entry) => entry.detectedCenter + entry.pitchOffset),
      2,
    );
    setShared(
      this.#semitones,
      blobs.map((entry) => entry.pitchOffset),
      2,
    );
    setShared(
      this.#cents,
      blobs.map((entry) => Math.round(entry.pitchOffset * 100)),
      0,
    );
    setShared(
      this.#gain,
      blobs.map((entry) => entry.gainDb),
      1,
    );
    setSharedChecked(
      this.#excluded,
      blobs.map((entry) => entry.excluded),
    );
    this.#detectedName.textContent = noteText(
      blobs.map((entry) => entry.detectedCenter),
      style,
    );
    this.#targetName.textContent = noteText(
      blobs.map((entry) => entry.detectedCenter + entry.pitchOffset),
      style,
    );
  }

  /**
   * Commits one edit per selected blob, as one undo step.
   *
   * @remarks The field is read once and written to every blob the selection covers, so a value
   * shown as mixed becomes the value they all carry the moment one is typed.
   */
  #applyToSelection(build: (blob: Blob) => EditOp | null): void {
    const blobs = this.#blobs.length > 0 ? this.#blobs : this.#blob === null ? [] : [this.#blob];
    const ops = blobs.flatMap((blob) => {
      const op = build(blob);
      return op === null ? [] : [op];
    });
    const first = ops[0];
    if (first === undefined) return;
    this.#hooks.applyEdit(ops.length === 1 ? first : { type: 'group', ops });
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

  /**
   * Shows the guide settings, and only the ones that mean something.
   *
   * @remarks The whole panel is hidden until a MIDI file is imported, because a guide panel in a
   * project with no guide is a row of dead controls under a heading about a file that is not
   * there. Strength and Mute go with it while the mode is Visual Only, which moves nothing and
   * makes no sound for either of them to act on.
   */
  #updateGuide(state: AppState): void {
    const guide = state.edits?.guide ?? null;
    const hasMidi = state.midi !== null;
    this.#guidePanel.hidden = !hasMidi;
    if (!hasMidi) {
      return;
    }
    const mode = guide?.mode ?? 'visualOnly';
    const audible = mode !== 'visualOnly';
    this.#guideStrengthRow.hidden = !audible;
    this.#guideMutedRow.hidden = !audible;
    const strength = guide?.strength ?? 1;
    setValue(this.#guideMode, mode);
    setValue(this.#guideStrength, String(strength));
    this.#guideStrengthReadout.textContent = `${String(Math.round(strength * 100))}%`;
    setChecked(this.#guideMuted, guide?.muted ?? false);
    // The line carries what the mapping left over and what overlaps, or nothing. Saying that
    // guide notes are drawn over the vocal describes what is already on screen.
    const report = state.mappingReport;
    const overlaps = state.guideOverlaps.length;
    const parts: string[] = [];
    if (report)
      parts.push(describeLeftovers(report.unmappedBlobs.length, report.unmappedNotes.length));
    if (overlaps > 0) parts.push(`${plural(overlaps, 'overlapping note')}.`);
    this.#guideHint.textContent = parts.join(' ');
    this.#guideHint.hidden = parts.length === 0;
  }

  #readoutField(
    labelText: string,
    control: HTMLInputElement,
    readout: HTMLElement,
    guide: string,
  ): HTMLElement {
    const row = document.createElement('div');
    row.className = 'axys-field';
    const label = guidedLabel(labelText, guide);
    label.htmlFor = control.id;
    const pair = document.createElement('div');
    pair.className = 'axys-control-pair';
    pair.append(control, readout);
    row.append(label, pair);
    bindDragAdjust(control, label);
    return row;
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
      const wanted = readNumber(this.#duration, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) => {
        const source = blob.end - blob.start;
        return source <= 0
          ? null
          : { type: 'setTimeScale', blob: blob.id, scale: Math.max(wanted, 0.01) / source };
      });
    });

    this.#timeOffset.addEventListener('change', () => {
      const wanted = readNumber(this.#timeOffset, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) =>
        wanted === blob.timeOffset
          ? null
          : { type: 'moveTime', blobs: [blob.id], seconds: wanted - blob.timeOffset },
      );
    });

    this.#target.addEventListener('change', () => {
      const wanted = readNumber(this.#target, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) => ({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: wanted - blob.detectedCenter,
      }));
    });

    this.#semitones.addEventListener('change', () => {
      const wanted = readNumber(this.#semitones, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) => ({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: wanted,
      }));
    });

    this.#cents.addEventListener('change', () => {
      const wanted = readNumber(this.#cents, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) => ({
        type: 'setPitchOffset',
        blob: blob.id,
        semitones: wanted / 100,
      }));
    });

    this.#gain.addEventListener('change', () => {
      const wanted = readNumber(this.#gain, Number.NaN);
      if (!Number.isFinite(wanted)) return;
      this.#applyToSelection((blob) =>
        blob.gainDb === wanted ? null : { type: 'setGain', blob: blob.id, gainDb: wanted },
      );
    });

    this.#excluded.addEventListener('change', () => {
      // Pressing a mixed switch settles the whole selection on one answer rather than flipping
      // each blob to the opposite of what it was.
      const excluded = this.#excluded.checked;
      this.#applyToSelection((blob) =>
        blob.excluded === excluded ? null : { type: 'setExcluded', blob: blob.id, excluded },
      );
    });

    // On change rather than on input: one undo step per rename, not one per keystroke. A blank
    // name is put back rather than sent, because the core rejects it and would leave the field
    // holding something the project does not have.
    this.#projectName.addEventListener('change', () => {
      const typed = this.#projectName.value.trim();
      const current = this.#state?.projectName ?? '';
      if (typed === '' || typed === current) {
        this.#projectName.value = current;
        return;
      }
      this.#hooks.setProjectName(typed);
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
