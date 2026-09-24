// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The confirmation for relinking a file that does not match the audio a project recorded.
 *
 * Like Correction, the panel previews while it is open: the chosen source plays the new file
 * straight away, Apply keeps it and Cancel puts back what was there.
 */

import { Dialog } from './dialog.js';
import { field, selectInput } from './controls/index.js';
import type { SourceInfo } from '../core/types.js';
import { formatClock } from '../editor/layers/ruler.js';

/** Audio the file may replace. */
export interface RelinkTarget {
  /** What the source is called in the project. */
  label: string;
  source: SourceInfo;
}

/** Everything the panel needs to open. */
export interface RelinkDialogOptions {
  /** Name and length in seconds of the file being relinked. */
  file: { name: string; duration: number };
  /** Sources the file may replace. More than one offers a choice. */
  targets: readonly RelinkTarget[];
  /** Index into `targets` chosen when the panel opens. */
  initial: number;
  /** Hears the file as `targets[index]`, replacing any earlier preview. */
  preview(index: number): void;
  /** Keeps the preview of `targets[index]`. */
  apply(index: number): void;
  /** Puts back whatever the preview replaced. */
  cancel(): void;
}

function hint(text: string): HTMLParagraphElement {
  const line = document.createElement('p');
  line.className = 'axys-hint';
  line.textContent = text;
  return line;
}

/** How the file's length compares with the source's, or `null` when they are the same. */
function lengthText(file: number, source: SourceInfo): string | null {
  const recorded = formatClock(source.duration);
  if (Math.abs(file - source.duration) < 0.0005) return null;
  return file > source.duration ? `Trimmed to ${recorded}` : `Padded with silence to ${recorded}`;
}

/** Opens the panel with the first preview already playing. */
export function openRelinkDialog(options: RelinkDialogOptions): Dialog {
  const { file, targets } = options;
  let chosen = Math.min(Math.max(0, options.initial), targets.length - 1);
  let settled = false;

  const content = document.createElement('div');
  content.className = 'axys-panel';
  const message = hint('');
  const length = hint('');

  const paint = (): void => {
    const target = targets[chosen];
    if (target === undefined) return;
    message.textContent = `${file.name} does not match ${target.source.name}.`;
    const text = lengthText(file.duration, target.source);
    length.textContent = text ?? '';
    length.hidden = text === null;
  };

  if (targets.length > 1) {
    const select = selectInput(
      targets.map((target, index) => ({
        value: String(index),
        label: target.label,
      })),
    );
    select.value = String(chosen);
    select.addEventListener('change', () => {
      chosen = Number.parseInt(select.value, 10);
      paint();
      options.preview(chosen);
    });
    content.append(field('Source', select, 'Audio the file replaces'));
  }
  content.append(message, length, hint('Play to preview'));
  paint();
  options.preview(chosen);

  const dialog = Dialog.open({
    title: 'Relink Audio',
    icon: 'join',
    content,
    blocking: false,
    actions: [
      {
        label: 'Cancel',
        onSelect: () => {
          settled = true;
          options.cancel();
          dialog.close();
        },
      },
      {
        label: 'Apply',
        kind: 'primary',
        onSelect: () => {
          settled = true;
          options.apply(chosen);
          dialog.close();
        },
      },
    ],
    onClose: () => {
      if (!settled) options.cancel();
    },
  });
  return dialog;
}
