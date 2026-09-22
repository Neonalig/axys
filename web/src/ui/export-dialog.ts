// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Export WAV modal: the range, sample rate and bit depth a file is written with.
 *
 * Every choice is explicit, and the figures the core measures for the chosen range are shown
 * before the user commits, so clipping, silence and unresolved timing are visible rather than
 * discovered in the file.
 */

import { Dialog } from './dialog.js';
import type { BitDepth, ExportPreview } from '../core/types.js';

/** An output range in seconds, or `null` for the whole project. */
export type ExportRange = { start: number; end: number } | null;

/** Everything an export is committed with. */
export interface ExportChoice {
  /** Output seconds to write, or `null` for the whole project. */
  range: ExportRange;
  sampleRate: number;
  depth: BitDepth;
}

/** What the modal needs in order to offer an export and describe it. */
export interface ExportDialogOptions {
  /** Output seconds the current selection covers, or `null` when nothing is selected. */
  selection: ExportRange;
  /** Source sample rate, offered as the default. */
  sourceRate: number;
  /** Measures a range before anything is written. `null` when the core could not report. */
  preview(range: ExportRange): ExportPreview | null;
  /** Runs the export the user committed to. */
  onExport(choice: ExportChoice): void;
}

/** Sample rates offered beside the source rate. */
const STANDARD_RATES: readonly number[] = [44_100, 48_000, 88_200, 96_000];

const DEPTHS: readonly { value: BitDepth; label: string }[] = [
  { value: 'pcm16', label: '16-bit PCM' },
  { value: 'pcm24', label: '24-bit PCM' },
  { value: 'float32', label: '32-bit Float' },
];

/** Silence shorter than this, in seconds, is rounding rather than a gap worth reporting. */
const SILENCE_EPSILON = 1e-3;

/** Opens the Export WAV modal. The export itself runs through `options.onExport`. */
export function showExportDialog(options: ExportDialogOptions): Dialog {
  const content = document.createElement('div');

  const settings = document.createElement('div');
  settings.className = 'axys-panel';
  content.append(settings);

  const figures = document.createElement('div');
  figures.className = 'axys-panel';
  content.append(figures);

  // What was selected is what an export is usually for, so a selection is what the dialog
  // opens on. With nothing selected there is only one range to offer.
  const whole = radio('axys-export-range', 'Whole Project');
  const selected = radio('axys-export-range', 'Selected Range');
  const hasSelection = options.selection !== null;
  selected.input.disabled = !hasSelection;
  selected.input.checked = hasSelection;
  whole.input.checked = !hasSelection;

  const rangeGroup = document.createElement('div');
  rangeGroup.className = 'axys-group axys-segmented';
  rangeGroup.append(whole.label, selected.label);
  settings.append(labelled('Range', rangeGroup));

  const rates = document.createElement('select');
  for (const rate of rateChoices(options.sourceRate)) {
    const option = document.createElement('option');
    option.value = String(rate);
    option.textContent =
      rate === options.sourceRate ? `${String(rate)} Hz (Source)` : `${String(rate)} Hz`;
    rates.append(option);
  }
  rates.value = String(options.sourceRate);
  settings.append(labelled('Sample Rate', rates));

  const depths = document.createElement('select');
  for (const depth of DEPTHS) {
    const option = document.createElement('option');
    option.value = depth.value;
    option.textContent = depth.label;
    depths.append(option);
  }
  depths.value = 'pcm24';
  settings.append(labelled('Bit Depth', depths));

  const chosen = (): ExportChoice => ({
    range: selected.input.checked ? options.selection : null,
    sampleRate: Number(rates.value),
    depth: depthOf(depths.value),
  });

  // Measuring a range renders it, which is the same work the export itself does, so nothing is
  // measured until it is asked for. Changing the range or the format simply invites it again.
  const measure = document.createElement('button');
  measure.type = 'button';
  measure.textContent = 'Measure Range';
  measure.addEventListener('click', () => {
    const choice = chosen();
    describe(figures, options.preview(choice.range), choice);
  });

  const invite = (): void => {
    figures.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = 'Export Preview';
    const line = document.createElement('p');
    line.className = 'axys-hint';
    line.textContent = describeChoice(chosen());
    figures.append(heading, line, measure);
  };
  invite();

  for (const control of [whole.input, selected.input, rates, depths]) {
    control.addEventListener('change', invite);
  }

  return Dialog.open({
    title: 'Export WAV',
    content,
    actions: [
      {
        label: 'Cancel',
        onSelect: (dialog) => {
          dialog.close();
        },
      },
      {
        label: 'Export WAV',
        kind: 'primary',
        onSelect: (dialog) => {
          const choice = chosen();
          dialog.close();
          options.onExport(choice);
        },
      },
    ],
  });
}

/** What an export would write, from what the dialog already knows and without measuring it. */
function describeChoice(choice: ExportChoice): string {
  const range =
    choice.range === null
      ? 'The whole project'
      : `${seconds(choice.range.start)} to ${seconds(choice.range.end)}`;
  return `${range}, at ${String(choice.sampleRate)} Hz, ${depthLabel(choice.depth)}. Measure it for peak level, clipping and timing conflicts.`;
}

/** How a bit depth names itself. */
function depthLabel(depth: BitDepth): string {
  return DEPTHS.find((entry) => entry.value === depth)?.label ?? String(depth);
}

/** Rewrites the figures panel for one range and its chosen format. */
function describe(panel: HTMLElement, preview: ExportPreview | null, choice: ExportChoice): void {
  panel.textContent = '';

  const heading = document.createElement('h2');
  heading.textContent = 'Export Preview';
  panel.append(heading);

  if (!preview) {
    panel.append(warning('This range could not be measured. Exporting it may not produce audio.'));
    return;
  }

  const list = document.createElement('ul');
  list.className = 'axys-caps';
  readout(list, 'Range', `${seconds(preview.start)} to ${seconds(preview.end)}`);
  readout(list, 'Duration', seconds(preview.duration));
  readout(list, 'Frames', String(frameCount(preview, choice.sampleRate)));
  readout(list, 'Peak', `${preview.peak.toFixed(3)} (${decibels(preview.peak)})`);
  panel.append(list);

  if (preview.frames === 0) {
    panel.append(warning('This range is empty, so the file would hold no audio.'));
  }
  if (preview.clips && choice.depth !== 'float32') {
    panel.append(warning('The peak is over full scale, so this export would clip.'));
  }
  if (preview.silent > SILENCE_EPSILON) {
    panel.append(
      warning(`${seconds(preview.silent)} of this range falls outside the source and is silent.`),
    );
  }
  if (preview.conflicts > 0) {
    panel.append(
      warning(
        `${String(preview.conflicts)} timing conflicts overlap this range and may be audible.`,
      ),
    );
  }
}

/** Frames the file holds, which follows the chosen rate rather than the source rate. */
function frameCount(preview: ExportPreview, sampleRate: number): number {
  return Math.round(preview.duration * sampleRate);
}

function rateChoices(sourceRate: number): number[] {
  return [...new Set([sourceRate, ...STANDARD_RATES])].sort((a, b) => a - b);
}

function depthOf(value: string): BitDepth {
  const match = DEPTHS.find((depth) => depth.value === value);
  return match?.value ?? 'pcm24';
}

function seconds(value: number): string {
  return `${value.toFixed(2)} s`;
}

function decibels(peak: number): string {
  if (!(peak > 0)) return 'silent';
  return `${(20 * Math.log10(peak)).toFixed(1)} dBFS`;
}

function readout(list: HTMLElement, name: string, value: string): void {
  const item = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = name;
  const figure = document.createElement('span');
  figure.className = 'axys-readout';
  figure.textContent = value;
  item.append(label, figure);
  list.append(item);
}

function warning(text: string): HTMLElement {
  const line = document.createElement('p');
  line.className = 'axys-hint axys-warning';
  line.textContent = text;
  return line;
}

function labelled(name: string, control: HTMLElement): HTMLElement {
  const field = document.createElement('div');
  field.className = 'axys-field';
  const label = document.createElement('label');
  label.textContent = name;
  if (control instanceof HTMLSelectElement) {
    control.id = `axys-export-${name.toLowerCase().replace(/\s+/g, '-')}`;
    label.htmlFor = control.id;
  }
  field.append(label, control);
  return field;
}

function radio(name: string, label: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const input = document.createElement('input');
  input.type = 'radio';
  input.name = name;
  const wrapper = document.createElement('label');
  wrapper.className = 'axys-note-toggle';
  wrapper.append(input, document.createTextNode(label));
  return { label: wrapper, input };
}
