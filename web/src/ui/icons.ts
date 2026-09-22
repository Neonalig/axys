// SPDX-License-Identifier: AGPL-3.0-or-later

/** Name of one command icon. */
export type IconName =
  | 'openAudio'
  | 'openMidi'
  | 'openProject'
  | 'save'
  | 'export'
  | 'undo'
  | 'redo'
  | 'play'
  | 'pause'
  | 'stop'
  | 'loop'
  | 'compare'
  | 'split'
  | 'join'
  | 'pitch'
  | 'pen'
  | 'line'
  | 'smooth'
  | 'time'
  | 'follow'
  | 'select'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'metronome'
  | 'barsBeats'
  | 'bypass'
  | 'exclude'
  | 'settings'
  | 'help'
  | 'diagnostics'
  | 'sourceCode'
  | 'warning'
  | 'close';

function stroked(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

function filled(body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" stroke="none" aria-hidden="true" focusable="false">${body}</svg>`;
}

const FOLDER =
  'M1.9 11.6V4.4a1.2 1.2 0 0 1 1.2-1.2h2.6l1.4 1.9h5a1.2 1.2 0 0 1 1.2 1.2v5.3a1.2 1.2 0 0 1-1.2 1.2H3.1a1.2 1.2 0 0 1-1.2-1.2Z';

/**
 * Inline SVG markup per command, 16px on a 16 grid and drawn in `currentColor`.
 *
 * @remarks The markup is author-controlled and safe to assign with `innerHTML`.
 */
export const ICONS: Readonly<Record<IconName, string>> = {
  openAudio: stroked(
    `<path d="${FOLDER}"/><path d="M5.2 9.6v1.4M7.1 8.2v4.2M9 9.1v2.6M10.9 9.9v1.2"/>`,
  ),
  openMidi: stroked(
    `<path d="${FOLDER}"/><circle cx="6.3" cy="11" r="1.3"/><path d="M7.6 11V7.3l3.3.9"/>`,
  ),
  openProject: stroked(
    `<path d="M4 13.5a.9.9 0 0 1-.9-.9V3.4a.9.9 0 0 1 .9-.9h4.6L12.9 6v6.6a.9.9 0 0 1-.9.9Z"/><path d="M8.5 2.6V6h4"/><path d="M6.2 10.3 8 8.5l1.8 1.8M8 8.7v3.3"/>`,
  ),
  save: stroked(
    `<path d="M3 4.2a1.2 1.2 0 0 1 1.2-1.2h6.6L13 5.2v6.6a1.2 1.2 0 0 1-1.2 1.2H4.2A1.2 1.2 0 0 1 3 11.8Z"/><path d="M5.5 3v3.1h4.6V3"/><path d="M5.5 13V9.6h5V13"/>`,
  ),
  export: stroked(
    `<path d="M8 2.4v7.2"/><path d="M5.3 5.1 8 2.4l2.7 2.7"/><path d="M3 9.8v2.6a1.1 1.1 0 0 0 1.1 1.1h7.8a1.1 1.1 0 0 0 1.1-1.1V9.8"/>`,
  ),
  undo: stroked(
    `<path d="M6.1 4.1 3.3 6.9l2.8 2.8"/><path d="M3.3 6.9h6.1a3.3 3.3 0 0 1 0 6.6H6.6"/>`,
  ),
  redo: stroked(
    `<path d="m9.9 4.1 2.8 2.8-2.8 2.8"/><path d="M12.7 6.9H6.6a3.3 3.3 0 0 0 0 6.6h2.8"/>`,
  ),
  play: filled('<path d="M5.1 3.3 12.4 8l-7.3 4.7Z"/>'),
  pause: filled('<path d="M5 3.4h2.1v9.2H5ZM8.9 3.4H11v9.2H8.9Z"/>'),
  stop: filled('<path d="M4.2 4.2h7.6v7.6H4.2Z"/>'),
  loop: stroked(
    `<path d="M3.2 7.4v-.6a2.2 2.2 0 0 1 2.2-2.2h7.4"/><path d="M10.9 2.6 13.1 4.6l-2.2 2"/><path d="M12.8 8.6v.6a2.2 2.2 0 0 1-2.2 2.2H3.2"/><path d="m5.1 13.4-2.2-2 2.2-2"/>`,
  ),
  compare: stroked(
    `<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11"/><path fill="currentColor" stroke="none" d="M8 2.5a5.5 5.5 0 0 0 0 11Z"/>`,
  ),
  split: stroked(`<path d="M8 2v12"/><path d="M5.4 6 3.4 8l2 2"/><path d="m10.6 6 2 2-2 2"/>`),
  join: stroked(`<path d="M8 2v12"/><path d="m3.4 6 2 2-2 2"/><path d="m12.6 6-2 2 2 2"/>`),
  pitch: stroked(
    `<path d="M2.4 11.6c3.6 0 3.6-7.2 7.2-7.2 1.9 0 2.6 1.5 4 1.5"/><circle cx="9.6" cy="4.4" r="1.2"/>`,
  ),
  pen: stroked(`<path d="m2.8 13.2.9-2.9 6.9-6.9 2 2-6.9 6.9Z"/><path d="m9.7 3.4 2 2"/>`),
  line: stroked(
    `<path d="m4.6 11.4 6.8-6.8"/><circle cx="3.6" cy="12.4" r="1.4"/><circle cx="12.4" cy="3.6" r="1.4"/>`,
  ),
  smooth: stroked(`<path d="M2.2 9.6c1-3.2 2.1-3.2 3.1 0s2.1 3.2 3.1 0"/><path d="M9.2 8h4.6"/>`),
  time: stroked(
    `<path d="M3 3.6v8.8M13 3.6v8.8"/><path d="M5.2 8h5.6"/><path d="m6.8 6.4-1.6 1.6 1.6 1.6"/><path d="m9.2 6.4 1.6 1.6-1.6 1.6"/>`,
  ),
  follow: stroked(
    `<path d="M8 2.2v11.6"/><path d="M2.6 8h2.8"/><path d="M4.2 6.4 5.8 8 4.2 9.6"/><path d="M13.4 8h-2.8"/><path d="M11.8 6.4 10.2 8l1.6 1.6"/>`,
  ),
  select: stroked(`<path d="m4 2.5 8.1 5.4-3.7.6 2 3.8-1.8.9-2-3.8-2.6 2.6Z"/>`),
  zoomIn: stroked(
    `<circle cx="6.9" cy="6.9" r="4.2"/><path d="m10 10 3.4 3.4"/><path d="M6.9 5v3.8M5 6.9h3.8"/>`,
  ),
  zoomOut: stroked(
    `<circle cx="6.9" cy="6.9" r="4.2"/><path d="m10 10 3.4 3.4"/><path d="M5 6.9h3.8"/>`,
  ),
  zoomFit: stroked(
    `<path d="M2.6 5.6V2.6h3M13.4 5.6V2.6h-3M2.6 10.4v3h3M13.4 10.4v3h-3"/><path d="M5.4 8h5.2"/>`,
  ),
  metronome: stroked(
    `<path d="M6.3 2.6h3.4l2.7 10.8H3.6Z"/><path d="M4.8 10.4h6.4"/><path d="m8 12.4 3-7.2"/>`,
  ),
  barsBeats: stroked(
    `<path d="M3 2.8v10.4M8 2.8v10.4M13 2.8v10.4"/><path d="M5.3 8h1.2M9.5 8h1.2"/>`,
  ),
  bypass: stroked(`<path d="M8 2.4v5"/><path d="M11.3 4.3a4.6 4.6 0 1 1-6.6 0"/>`),
  exclude: stroked(`<circle cx="8" cy="8" r="5.5"/><path d="m4.1 11.9 7.8-7.8"/>`),
  settings: stroked(
    `<path d="M2.6 5h5.3M11.5 5h1.9M2.6 11h1.9M7.6 11h5.8"/><circle cx="9.7" cy="5" r="1.7"/><circle cx="6" cy="11" r="1.7"/>`,
  ),
  help: stroked(
    `<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.2 1.8c-.5.2-.6.6-.6 1.1"/><path fill="currentColor" stroke="none" d="M8 10.6a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"/>`,
  ),
  diagnostics: stroked(`<path d="M1.8 8.4h2.6L6 4.2l2.6 7.6 1.4-3.4h4.2"/>`),
  sourceCode: stroked(`<path d="M5.9 4.6 2.6 8l3.3 3.4"/><path d="M10.1 4.6 13.4 8l-3.3 3.4"/>`),
  warning: stroked(
    `<path d="M8 2.6 14 13H2Z"/><path d="M8 6.4v3.1"/><path fill="currentColor" stroke="none" d="M8 10.7a.7.7 0 1 1 0 1.4.7.7 0 0 1 0-1.4Z"/>`,
  ),
  close: stroked(`<path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6"/>`),
};

/** Icon markup for a command. */
export function icon(name: IconName): string {
  return ICONS[name];
}
