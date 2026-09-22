// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The application chrome: toolbar, canvas, inspector, status bar and notification layer.
 *
 * The editor itself is a canvas, but everything around it is ordinary semantic HTML, so every
 * command and setting is reachable by keyboard and named for assistive technology.
 */

import '../styles.css';

import type { AppState, CompareMode, ToolId } from '../app/store.js';
import type { Capability } from '../capabilities.js';
import type { EngineReport } from '../audio/engine.js';
import type { AccidentalStyle, EditOp, ViewState } from '../core/types.js';
import { noteCapabilities, noteEngineReport } from './diagnostics.js';
import { ICONS, type IconName } from './icons.js';
import { Inspector } from './inspector.js';
import { THEME_LABELS, THEME_NAMES, type ThemeName } from './theme.js';
import { ToastHost } from './toast.js';

/** Toolbar section a command belongs to. */
export type CommandGroup = 'File' | 'Edit' | 'Transport' | 'Tools' | 'View' | 'MIDI' | 'Help';

/** The part of a command the toolbar needs in order to show it. */
export interface ShellCommand {
  id: string;
  label: string;
  group: CommandGroup;
  shortcut?: string;
}

/** Everything the chrome needs in order to act on the user's behalf. */
export interface ShellHooks {
  /** Runs the command with this id. */
  runCommand(id: string): void;
  /** Whether the command can run against the current state. */
  isCommandEnabled(id: string): boolean;
  /** Applies one edit operation to the session. */
  applyEdit(op: EditOp): void;
  /** Changes saved editor view state. */
  setView(patch: Partial<ViewState>): void;
  /** Selects the active editing tool. */
  setTool(tool: ToolId): void;
  /** Chooses which audio the transport plays. */
  setCompare(mode: CompareMode): void;
  /** Sets the concert reference in Hz. */
  setTuning(a4Hz: number): void;
  /** Sets how accidentals are spelled. */
  setAccidentals(style: AccidentalStyle): void;
  /** Applies and remembers a colour theme. */
  setTheme(name: ThemeName): void;
}

/** What the chrome is built from. */
export interface ShellOptions {
  /** Element the chrome replaces the contents of. */
  root: HTMLElement;
  commands: readonly ShellCommand[];
  hooks: ShellHooks;
  /** Theme shown as selected. Applying it is the caller's job. */
  theme?: ThemeName;
}

interface ToolEntry {
  id: ToolId;
  label: string;
  icon: IconName;
  tooltip: string;
}

const TOOLS: readonly ToolEntry[] = [
  { id: 'select', label: 'Select Tool', icon: 'select', tooltip: 'Selects blobs and anchors.' },
  { id: 'split', label: 'Split Tool', icon: 'split', tooltip: 'Splits a blob where you click.' },
  { id: 'pitch', label: 'Pitch Tool', icon: 'pitch', tooltip: 'Drags whole blobs in pitch.' },
  { id: 'pen', label: 'Pen Tool', icon: 'pen', tooltip: 'Draws a freehand pitch target.' },
  { id: 'line', label: 'Line Tool', icon: 'line', tooltip: 'Draws a straight pitch transition.' },
  { id: 'smooth', label: 'Smooth Tool', icon: 'smooth', tooltip: 'Reduces jitter over a span.' },
  { id: 'time', label: 'Time Tool', icon: 'time', tooltip: 'Moves and stretches blobs in time.' },
  {
    id: 'audition',
    label: 'Audition Tool',
    icon: 'audition',
    tooltip: 'Plays a short region under the cursor.',
  },
];

const COMPARE_OPTIONS: readonly { value: CompareMode; label: string }[] = [
  { value: 'processed', label: 'Processed' },
  { value: 'original', label: 'Original' },
  { value: 'split', label: 'Split Compare' },
];

const GROUP_ORDER: readonly CommandGroup[] = [
  'File',
  'Edit',
  'Tools',
  'Transport',
  'MIDI',
  'View',
  'Help',
];

const GROUP_ICON: Readonly<Record<CommandGroup, IconName>> = {
  File: 'openProject',
  Edit: 'pen',
  Transport: 'play',
  Tools: 'select',
  View: 'zoomFit',
  MIDI: 'openMidi',
  Help: 'help',
};

const LABEL_ICON: Readonly<Record<string, IconName>> = {
  'Open Audio': 'openAudio',
  'Open MIDI': 'openMidi',
  'Open Project': 'openProject',
  'Save Project': 'save',
  'Export Project': 'save',
  'Export WAV': 'export',
  Undo: 'undo',
  Redo: 'redo',
  'Split Blob': 'split',
  'Join Blobs': 'join',
  'Reset Blob': 'undo',
  'Reset Span': 'undo',
  'Smooth Span': 'smooth',
  'Bypass Blob': 'bypass',
  'Exclude Blob': 'exclude',
  Play: 'play',
  Pause: 'pause',
  Stop: 'stop',
  'Loop Selection': 'loop',
  'Toggle Compare': 'compare',
  'Zoom In': 'zoomIn',
  'Zoom Out': 'zoomOut',
  'Zoom Fit': 'zoomFit',
  'Toggle Bars Beats': 'barsBeats',
  'Toggle Metronome': 'metronome',
  'Align Guide': 'time',
  'Show Diagnostics': 'diagnostics',
  'Show Source Code': 'sourceCode',
};

function iconFor(command: ShellCommand): IconName {
  return LABEL_ICON[command.label] ?? GROUP_ICON[command.group];
}

function tooltipFor(command: ShellCommand): string {
  return command.shortcut === undefined ? command.label : `${command.label} (${command.shortcut})`;
}

function group(label: string): HTMLElement {
  const element = document.createElement('div');
  element.className = 'axys-group';
  element.setAttribute('role', 'group');
  element.setAttribute('aria-label', label);
  return element;
}

function statusItem(parent: HTMLElement, label: string): HTMLElement {
  const wrapper = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'axys-readout-label';
  name.textContent = `${label} `;
  const value = document.createElement('span');
  value.className = 'axys-readout';
  value.textContent = '--';
  wrapper.append(name, value);
  parent.append(wrapper);
  return value;
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(seconds, 0) : 0;
  const minutes = Math.floor(safe / 60);
  return `${String(minutes)}:${(safe - minutes * 60).toFixed(3).padStart(6, '0')}`;
}

/**
 * The DOM chrome around the editor canvas.
 *
 * @remarks The shell owns no application state. It reflects the state passed to
 * {@link AppShell.update} and reports intent through its hooks.
 */
export class AppShell {
  readonly #hooks: ShellHooks;
  readonly #root: HTMLElement;
  readonly #canvas: HTMLCanvasElement;
  readonly #live: HTMLElement;
  readonly #toasts: ToastHost;
  readonly #inspector: Inspector;

  readonly #commandButtons = new Map<string, HTMLButtonElement>();
  readonly #commandLabels = new Map<string, ShellCommand>();
  readonly #toolButtons = new Map<ToolId, HTMLButtonElement>();
  readonly #compare: HTMLSelectElement;

  readonly #statusPhase: HTMLElement;
  readonly #statusPosition: HTMLElement;
  readonly #statusSelection: HTMLElement;
  readonly #statusConflicts: HTMLElement;
  readonly #statusPlayback: HTMLElement;
  readonly #progress: HTMLProgressElement;

  #announced = '';
  #lastSelection = '';

  private constructor(options: ShellOptions) {
    this.#hooks = options.hooks;
    this.#root = options.root;
    this.#root.replaceChildren();

    const header = document.createElement('header');
    header.className = 'axys-toolbar';
    header.setAttribute('role', 'toolbar');
    header.setAttribute('aria-label', 'Editor Commands');

    const byGroup = new Map<CommandGroup, ShellCommand[]>();
    for (const command of options.commands) {
      const bucket = byGroup.get(command.group);
      if (bucket) {
        bucket.push(command);
      } else {
        byGroup.set(command.group, [command]);
      }
    }

    const compare = this.#buildCompare();
    const theme = this.#buildTheme(options.theme ?? 'dark');
    this.#compare = compare.select;

    for (const name of GROUP_ORDER) {
      if (name === 'Tools') {
        // The tool palette already presents these, so the commands stay in the
        // registry for shortcuts without being drawn a second time.
        header.append(this.#buildToolGroup());
        continue;
      }
      const commands = byGroup.get(name) ?? [];
      if (commands.length === 0) {
        continue;
      }
      const section = group(`${name} Commands`);
      for (const command of commands) {
        section.append(this.#buildCommandButton(command));
      }
      if (name === 'Transport') {
        section.append(compare.wrapper);
      }
      if (name === 'View') {
        section.append(theme.wrapper);
      }
      header.append(section);
    }

    const extras = group('Playback And View');
    if (compare.wrapper.parentElement === null) {
      extras.append(compare.wrapper);
    }
    if (theme.wrapper.parentElement === null) {
      extras.append(theme.wrapper);
    }
    if (extras.childElementCount > 0) {
      header.append(extras);
    }

    const spacer = document.createElement('span');
    spacer.className = 'axys-spacer';
    header.append(spacer);

    const main = document.createElement('main');
    main.className = 'axys-canvas-area';

    const canvas = document.createElement('canvas');
    canvas.className = 'axys-canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-label', 'Pitch Editor');
    canvas.title = 'Pitch Editor';
    main.append(canvas);
    this.#canvas = canvas;

    const live = document.createElement('div');
    live.className = 'axys-visually-hidden';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    main.append(live);
    this.#live = live;

    this.#inspector = new Inspector({
      applyEdit: (op) => {
        this.#hooks.applyEdit(op);
      },
      setView: (patch) => {
        this.#hooks.setView(patch);
      },
      setTuning: (a4Hz) => {
        this.#hooks.setTuning(a4Hz);
      },
      setAccidentals: (style) => {
        this.#hooks.setAccidentals(style);
      },
    });

    const footer = document.createElement('footer');
    footer.className = 'axys-status';
    this.#statusPhase = statusItem(footer, 'State');
    this.#statusPosition = statusItem(footer, 'Position');
    this.#statusSelection = statusItem(footer, 'Selection');
    this.#statusConflicts = statusItem(footer, 'Conflicts');
    this.#statusPlayback = statusItem(footer, 'Playback');

    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = 0;
    progress.hidden = true;
    progress.title = 'Analysis Progress';
    progress.setAttribute('aria-label', 'Analysis Progress');
    footer.append(progress);
    this.#progress = progress;

    this.#root.append(header, main, this.#inspector.element, footer);
    this.#toasts = new ToastHost(document.body);
  }

  /** Builds the chrome inside `root` and returns it. */
  static mount(options: ShellOptions): AppShell {
    return new AppShell(options);
  }

  /** The editor canvas, for the renderer and the pointer controller. */
  get canvas(): HTMLCanvasElement {
    return this.#canvas;
  }

  /** The notification stack. */
  get toasts(): ToastHost {
    return this.#toasts;
  }

  /** The settings panel. */
  get inspector(): Inspector {
    return this.#inspector;
  }

  /** Records the capability probe, so the diagnostics dialog reports this browser. */
  setCapabilities(capabilities: readonly Capability[]): void {
    noteCapabilities(capabilities);
  }

  /** Shows the newest playback report and hands it to the diagnostics dialog. */
  setEngineReport(report: EngineReport): void {
    noteEngineReport(report);
    this.#statusPlayback.textContent =
      report.message === null ? report.status : `${report.status}: ${report.message}`;
    this.#statusPlayback.classList.toggle('axys-error', report.status === 'failed');
    this.#statusPlayback.classList.toggle('axys-warning', report.status === 'blocked');
  }

  /** Announces a selection change or an edit result through the off-screen live region. */
  announce(message: string): void {
    if (message === this.#announced) {
      this.#live.textContent = '';
    }
    this.#announced = message;
    this.#live.textContent = message;
  }

  /** Reflects application state in every control. */
  update(state: AppState): void {
    for (const [id, button] of this.#commandButtons) {
      button.disabled = !this.#hooks.isCommandEnabled(id);
    }

    const play = this.#byLabel('Play');
    if (play) {
      const playing = state.transport.playing;
      const command = this.#commandLabels.get(play.id);
      play.button.innerHTML = playing ? ICONS.pause : ICONS.play;
      play.button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      play.button.title = playing ? 'Pause' : command ? tooltipFor(command) : 'Play';
      play.button.setAttribute('aria-pressed', String(playing));
    }

    for (const [tool, button] of this.#toolButtons) {
      button.setAttribute('aria-pressed', String(state.tool === tool));
      button.disabled = state.phase !== 'ready';
    }

    if (document.activeElement !== this.#compare) {
      this.#compare.value = state.compare;
    }
    this.#compare.disabled = state.phase !== 'ready';

    this.#statusPhase.textContent = state.message ?? state.phase;
    this.#statusPhase.classList.toggle('axys-error', state.phase === 'error');
    this.#statusPosition.textContent = formatClock(state.transport.position);
    this.#statusSelection.textContent =
      state.selection.blobs.length === 0 ? 'None' : `${String(state.selection.blobs.length)} blobs`;
    this.#statusConflicts.textContent = String(state.conflicts.length);
    this.#statusConflicts.classList.toggle('axys-warning', state.conflicts.length > 0);

    this.#progress.hidden = !state.analysis.running;
    this.#progress.value = state.analysis.progress;
    this.#progress.title = state.analysis.stage === '' ? 'Analysis Progress' : state.analysis.stage;

    this.#canvas.setAttribute(
      'aria-label',
      state.source === null ? 'Pitch Editor' : `Pitch Editor: ${state.source.name}`,
    );

    this.#announceSelection(state);
    this.#inspector.update(state);
  }

  /** Removes the chrome and its notification layer. */
  dispose(): void {
    this.#toasts.dispose();
    this.#root.replaceChildren();
  }

  #byLabel(label: string): { id: string; button: HTMLButtonElement } | undefined {
    for (const [id, command] of this.#commandLabels) {
      if (command.label === label) {
        const button = this.#commandButtons.get(id);
        if (button) {
          return { id, button };
        }
      }
    }
    return undefined;
  }

  #announceSelection(state: AppState): void {
    const ids = state.selection.blobs;
    const range = state.selection.range;
    const key = `${ids.join(',')}|${range ? `${String(range.start)}-${String(range.end)}` : ''}`;
    if (key === this.#lastSelection) {
      return;
    }
    this.#lastSelection = key;
    if (ids.length === 0 && !range) {
      this.announce('Selection cleared.');
      return;
    }
    const parts: string[] = [];
    if (ids.length === 1) {
      const id = ids[0];
      const blob = state.blobs.find((candidate) => candidate.id === id);
      parts.push(
        blob
          ? `Blob ${String(blob.id)} selected, ${blob.start.toFixed(2)} to ${blob.end.toFixed(2)} seconds.`
          : 'One blob selected.',
      );
    } else if (ids.length > 1) {
      parts.push(`${String(ids.length)} blobs selected.`);
    }
    if (range) {
      parts.push(`Range ${range.start.toFixed(2)} to ${range.end.toFixed(2)} seconds.`);
    }
    this.announce(parts.join(' '));
  }

  #buildCommandButton(command: ShellCommand): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'axys-icon';
    button.innerHTML = ICONS[iconFor(command)];
    button.setAttribute('aria-label', command.label);
    button.title = tooltipFor(command);
    button.addEventListener('click', () => {
      this.#hooks.runCommand(command.id);
    });
    this.#commandButtons.set(command.id, button);
    this.#commandLabels.set(command.id, command);
    return button;
  }

  #buildToolGroup(): HTMLElement {
    const section = group('Editing Tools');
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'axys-icon';
      button.innerHTML = ICONS[tool.icon];
      button.setAttribute('aria-label', tool.label);
      button.setAttribute('aria-pressed', 'false');
      button.title = `${tool.label}: ${tool.tooltip}`;
      button.addEventListener('click', () => {
        this.#hooks.setTool(tool.id);
        this.announce(`${tool.label} active.`);
      });
      this.#toolButtons.set(tool.id, button);
      section.append(button);
    }
    return section;
  }

  #buildCompare(): { wrapper: HTMLElement; select: HTMLSelectElement } {
    const wrapper = document.createElement('span');
    wrapper.className = 'axys-field';
    const select = document.createElement('select');
    select.id = 'axys-compare';
    for (const option of COMPARE_OPTIONS) {
      const element = document.createElement('option');
      element.value = option.value;
      element.textContent = option.label;
      select.append(element);
    }
    select.title = 'Which audio the transport plays.';
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = 'Compare';
    select.addEventListener('change', () => {
      const mode = COMPARE_OPTIONS.find((entry) => entry.value === select.value)?.value;
      if (mode) {
        this.#hooks.setCompare(mode);
      }
    });
    wrapper.append(label, select);
    return { wrapper, select };
  }

  #buildTheme(current: ThemeName): { wrapper: HTMLElement; select: HTMLSelectElement } {
    const wrapper = document.createElement('span');
    wrapper.className = 'axys-field';
    const select = document.createElement('select');
    select.id = 'axys-theme';
    for (const name of THEME_NAMES) {
      const element = document.createElement('option');
      element.value = name;
      element.textContent = THEME_LABELS[name];
      select.append(element);
    }
    select.value = current;
    select.title = 'Colour scheme used by the chrome and the canvas.';
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = 'Theme';
    select.addEventListener('change', () => {
      const chosen = THEME_NAMES.find((name) => name === select.value);
      if (chosen) {
        this.#hooks.setTheme(chosen);
        this.announce(`${THEME_LABELS[chosen]} applied.`);
      }
    });
    wrapper.append(label, select);
    return { wrapper, select };
  }
}
