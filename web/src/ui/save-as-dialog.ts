// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Save As: the file name and whether the audio goes with the project.
 *
 * A browser without a save picker writes a download with nothing asked, so the choices are made
 * here. Where the browser has a picker it opens after Save, starting on the name given.
 */

import { Dialog } from './dialog.js';
import { field, selectInput, textInput } from './controls/index.js';

/** Which file Save As writes. */
export type SaveFormat = 'project' | 'package';

/** Opens the panel. `save` runs on Save with the name, without its extension, and the format. */
export function showSaveAs(options: {
  name: string;
  format: SaveFormat;
  save(name: string, format: SaveFormat): void;
}): Dialog {
  const content = document.createElement('div');
  content.className = 'axys-panel';
  const name = textInput(200);
  name.value = options.name;
  const format = selectInput([
    { value: 'project', label: 'Project' },
    { value: 'package', label: 'Project with Audio' },
  ]);
  format.value = options.format;
  content.append(
    field('Name', name, 'File name, without the extension'),
    field('Format', format, 'Whether the audio is saved inside the project'),
  );
  const submit = (dialog: Dialog): void => {
    const chosen = name.value.trim();
    dialog.close();
    options.save(chosen.length > 0 ? chosen : options.name, format.value as SaveFormat);
  };
  const dialog = Dialog.open({
    title: 'Save As',
    icon: 'save',
    content,
    actions: [
      {
        label: 'Cancel',
        onSelect: (panel) => {
          panel.close();
        },
      },
      { label: 'Save', kind: 'primary', onSelect: submit },
    ],
  });
  name.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit(dialog);
    }
  });
  name.focus();
  name.select();
  return dialog;
}
