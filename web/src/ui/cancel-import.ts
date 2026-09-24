// SPDX-License-Identifier: AGPL-3.0-or-later

import { Dialog } from './dialog.js';

/** What stopping a batch of files comes to: nothing, the file being worked on, or the rest too. */
export type CancelChoice = 'continue' | 'file' | 'all';

/**
 * Asks whether to stop a batch of files while it waits.
 *
 * @remarks `noun` is what the batch is doing, such as Import or Relink. Closing the panel any
 * other way than its buttons carries on. With one file there is nothing past it to cancel, so
 * Cancel All is not offered.
 */
export function askToCancel(options: {
  noun: string;
  verb: string;
  file: string;
  index: number;
  total: number;
}): Promise<CancelChoice> {
  return new Promise((resolve) => {
    let answer: CancelChoice = 'continue';
    const body = document.createElement('p');
    body.className = 'axys-hint';
    body.textContent =
      options.total > 1
        ? `${options.verb} ${options.file}, ${String(options.index + 1)} of ${String(options.total)}.`
        : `${options.verb} ${options.file}.`;
    const choose =
      (choice: CancelChoice) =>
      (dialog: Dialog): void => {
        answer = choice;
        dialog.close();
      };
    Dialog.open({
      title: `Cancel ${options.noun}?`,
      icon: 'warning',
      content: body,
      actions: [
        { label: 'Continue', kind: 'primary', onSelect: choose('continue') },
        { label: 'Cancel', kind: 'danger', onSelect: choose('file') },
        ...(options.total > 1
          ? [{ label: 'Cancel All', kind: 'danger' as const, onSelect: choose('all') }]
          : []),
      ],
      onClose: () => {
        resolve(answer);
      },
    });
  });
}
