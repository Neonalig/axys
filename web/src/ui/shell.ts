// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The application chrome: toolbar, canvas, inspector, status bar and notification layer.
 *
 * The editor itself is a canvas, but everything around it is ordinary semantic HTML, so every
 * command and setting is reachable by keyboard and named for assistive technology.
 */

import '../styles.css';

import type { ThemeChoice } from '../app/preferences.js';
import { selectionSpan } from '../app/selection.js';
import type { AppState, CompareMode, FollowMode, ToolId } from '../app/store.js';
import type { Capability } from '../capabilities.js';
import type { EngineReport } from '../audio/engine.js';
import type { AccidentalStyle, EditOp, ViewState } from '../core/types.js';
import { noteCapabilities, noteEngineReport } from './diagnostics.js';
import { ICONS, type IconName } from './icons.js';
import { Inspector } from './inspector.js';
import { THEME_LABELS, THEME_NAMES } from './theme.js';
import { ToastHost } from './toast.js';
import { Scrollbar } from './scrollbar.js';
import { setTooltip, TooltipHost } from './tooltip.js';
import { ZoomControl } from './zoom-control.js';

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
  /** Chooses how the view keeps up with a playing playhead. */
  setFollowMode(mode: FollowMode): void;
  /** Zooms the time axis to a visible span in seconds, about the centre of the view. */
  setSpan(seconds: number): void;
  /** Chooses which audio the transport plays. */
  setCompare(mode: CompareMode): void;
  /** Sets the concert reference in Hz. */
  setTuning(a4Hz: number): void;
  /** Sets how accidentals are spelled. */
  setAccidentals(style: AccidentalStyle): void;
  /** Applies and remembers a colour theme, or defers to the operating system. */
  setTheme(choice: ThemeChoice): void;
}

/** What the chrome is built from. */
export interface ShellOptions {
  /** Element the chrome replaces the contents of. */
  root: HTMLElement;
  commands: readonly ShellCommand[];
  hooks: ShellHooks;
  /** Theme choice shown as selected. Applying it is the caller's job. */
  theme?: ThemeChoice;
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
];

/** Theme entries the chrome offers, with following the operating system first and default. */
const THEME_CHOICES: readonly ThemeChoice[] = ['system', ...THEME_NAMES];

/**
 * How each compare mode presents itself on the one transport toggle.
 *
 * @remarks One control with three faces rather than a button beside a drop-down: what is being
 * monitored is a single choice, and the icon is what says which.
 */
const COMPARE_FACES: Readonly<Record<CompareMode, { icon: IconName; tip: string }>> = {
  processed: { icon: 'compareProcessed', tip: 'Playing Processed' },
  original: { icon: 'compareOriginal', tip: 'Playing Original' },
  split: { icon: 'compareSplit', tip: 'Playing Original Left, Processed Right' },
};

/**
 * Commands the toolbar does not draw.
 *
 * @remarks They stay in the registry, so their shortcuts and their enabled state are unchanged;
 * they are simply presented somewhere the toolbar is not. Zoom lives in the footer, and how time
 * reads is a display setting in the inspector.
 */
const PRESENTED_ELSEWHERE: ReadonlySet<string> = new Set([
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomFit',
  'view.toggleBarsBeats',
  // A project-wide bypass is a state of the project, not a transport button, and it reads as a
  // duplicate of Compare while it sits beside it.
  'edit.bypassAll',
  // Cancelling an import belongs under the progress it is cancelling.
  'file.cancelImport',
  // Selecting everything is a keyboard action; a button for it would say nothing a drag does not.
  'edit.selectAll',
]);

/** Commands drawn in their own group ahead of the rest of theirs. */
const HISTORY_COMMANDS: ReadonlySet<string> = new Set(['edit.undo', 'edit.redo']);

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
  Open: 'openProject',
  'Save Project': 'save',
  'Save A Copy': 'save',
  'Export Audio': 'export',
  Undo: 'undo',
  Redo: 'redo',
  'Split Blob': 'split',
  'Join Blobs': 'join',
  Reset: 'undo',
  'Smooth Span': 'smooth',
  'Bypass Blob': 'bypass',
  'Exclude Blob': 'exclude',
  Play: 'play',
  Pause: 'pause',
  Stop: 'stop',
  'Loop Selection': 'loop',
  'Toggle Compare': 'compareProcessed',
  'Zoom In': 'zoomIn',
  'Zoom Out': 'zoomOut',
  'Zoom Fit': 'zoomFit',
  'Toggle Bars Beats': 'barsBeats',
  'Follow Playhead': 'follow',
  'Toggle Metronome': 'metronome',
  'Align Guide': 'time',
  'Help And Diagnostics': 'help',
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

/**
 * One labelled readout in the status bar.
 *
 * @remarks Returns the wrapper as well as the value, so a readout with nothing to report can be
 * hidden outright rather than left saying nothing at some width.
 */
function statusItem(
  parent: HTMLElement,
  label: string,
): { wrapper: HTMLElement; value: HTMLElement } {
  const wrapper = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'axys-readout-label';
  name.textContent = `${label} `;
  const value = document.createElement('span');
  value.className = 'axys-readout';
  value.textContent = '--';
  wrapper.append(name, value);
  parent.append(wrapper);
  return { wrapper, value };
}

/**
 * What the status bar says is selected.
 *
 * @remarks A selection is a span, so the span is what it reports. "None" while a span is drawn
 * would be a lie, and a blob count alone never says where.
 */
function describeSelection(state: AppState): string {
  const ranges = state.selection.ranges;
  const hull = selectionSpan(ranges);
  if (hull === null) {
    return 'None';
  }
  const span = `${formatClock(hull.start)} to ${formatClock(hull.end)}`;
  const count = state.selection.blobs.length;
  const blobs = count === 0 ? '' : ` (${String(count)} ${count === 1 ? 'blob' : 'blobs'})`;
  const spans = ranges.length > 1 ? ` in ${String(ranges.length)} spans` : '';
  return `${span}${spans}${blobs}`;
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
  readonly #tooltips: TooltipHost;
  readonly #inspector: Inspector;

  readonly #commandButtons = new Map<string, HTMLButtonElement>();
  readonly #commandLabels = new Map<string, ShellCommand>();
  readonly #toolButtons = new Map<ToolId, HTMLButtonElement>();

  readonly #statusPhase: { wrapper: HTMLElement; value: HTMLElement };
  readonly #statusPosition: HTMLElement;
  readonly #statusSelection: HTMLElement;
  readonly #statusConflicts: { wrapper: HTMLElement; value: HTMLElement };
  readonly #statusPlayback: { wrapper: HTMLElement; value: HTMLElement };
  readonly #progress: HTMLProgressElement;
  readonly #timeBar: Scrollbar;
  readonly #pitchBar: Scrollbar;
  readonly #zoom: ZoomControl;
  readonly #busy: HTMLElement;
  readonly #busyStage: HTMLElement;
  readonly #busyProgress: HTMLProgressElement;
  readonly #drop: HTMLElement;

  #announced = '';
  #lastSelection = '';

  /** The newest view state, for the controls that report a change relative to it. */
  #view: ViewState | null = null;

  /** Whether the transport button currently draws the pause icon, so it is rewritten only on a change. */
  #showingPause = false;

  /** Compare mode the toggle currently shows, so its icon is rewritten only on a change. */
  #showingCompare: CompareMode | null = null;

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

    const theme = this.#buildTheme(options.theme ?? 'system');

    for (const name of GROUP_ORDER) {
      if (name === 'Tools') {
        // The tool palette already presents these, so the commands stay in the
        // registry for shortcuts without being drawn a second time.
        header.append(this.#buildToolGroup());
        continue;
      }
      const commands = (byGroup.get(name) ?? []).filter(
        (command) => !PRESENTED_ELSEWHERE.has(command.id),
      );
      if (commands.length === 0) {
        continue;
      }
      // Undo and redo get their own rule. They act on the last thing done rather than on
      // anything selected, so grouping them with the edits invites reading them as one set.
      const history = commands.filter((command) => HISTORY_COMMANDS.has(command.id));
      if (history.length > 0) {
        const section = group('History');
        for (const command of history) {
          section.append(this.#buildCommandButton(command));
        }
        header.append(section);
      }
      const rest = commands.filter((command) => !HISTORY_COMMANDS.has(command.id));
      if (rest.length === 0 && name !== 'Transport' && name !== 'View') {
        continue;
      }
      const section = group(`${name} Commands`);
      for (const command of rest) {
        section.append(this.#buildCommandButton(command));
      }
      if (name === 'View') {
        section.append(theme.wrapper);
      }
      header.append(section);
    }

    if (theme.wrapper.parentElement === null) {
      const extras = group('View Settings');
      extras.append(theme.wrapper);
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
    // No `title`: the renderer draws its own readout, and a host tooltip over the canvas would
    // be a second one that disagrees about when to appear. `aria-label` names it instead.
    canvas.setAttribute('aria-label', 'Pitch Editor');
    main.append(canvas);
    this.#canvas = canvas;

    this.#timeBar = new Scrollbar({
      orientation: 'horizontal',
      label: 'Scroll Time',
      onScroll: (start) => {
        const view = this.#view;
        if (view === null) return;
        const span = view.visibleEnd - view.visibleStart;
        this.#hooks.setView({ visibleStart: start, visibleEnd: start + span });
      },
    });
    this.#pitchBar = new Scrollbar({
      orientation: 'vertical',
      label: 'Scroll Pitch',
      onScroll: (low) => {
        const view = this.#view;
        if (view === null) return;
        const range = view.highMidi - view.lowMidi;
        this.#hooks.setView({ lowMidi: low, highMidi: low + range });
      },
    });
    main.append(this.#timeBar.element, this.#pitchBar.element);

    // Import covers the editor rather than sitting beside it: the timeline underneath is not
    // the project being opened, and letting it be clicked invites edits that are about to be
    // thrown away. Cancel lives here, under the progress it cancels.
    const busy = document.createElement('div');
    busy.className = 'axys-busy';
    busy.hidden = true;
    busy.setAttribute('role', 'status');
    busy.setAttribute('aria-live', 'polite');

    const busyStage = document.createElement('p');
    busyStage.className = 'axys-busy-stage';
    const busyProgress = document.createElement('progress');
    busyProgress.className = 'axys-busy-progress';
    busyProgress.max = 1;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel Import';
    cancel.addEventListener('click', () => {
      this.#hooks.runCommand('file.cancelImport');
    });
    busy.append(busyStage, busyProgress, cancel);
    main.append(busy);
    this.#busy = busy;
    this.#busyStage = busyStage;
    this.#busyProgress = busyProgress;

    const drop = document.createElement('div');
    drop.className = 'axys-drop';
    drop.hidden = true;
    main.append(drop);
    this.#drop = drop;

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
      setFollowMode: (mode) => {
        this.#hooks.setFollowMode(mode);
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
    this.#statusPosition = statusItem(footer, 'Position').value;
    this.#statusSelection = statusItem(footer, 'Selection').value;
    this.#statusConflicts = statusItem(footer, 'Conflicts');
    this.#statusPlayback = statusItem(footer, 'Playback');

    const progress = document.createElement('progress');
    progress.max = 1;
    progress.value = 0;
    progress.hidden = true;
    setTooltip(progress, 'Analysis Progress');
    progress.setAttribute('aria-label', 'Analysis Progress');
    footer.append(progress);
    this.#progress = progress;

    const spacerEnd = document.createElement('span');
    spacerEnd.className = 'axys-spacer';
    this.#zoom = new ZoomControl({
      onSpan: (seconds) => {
        this.#hooks.setSpan(seconds);
      },
      onFit: () => {
        this.#hooks.runCommand('view.zoomFit');
      },
    });
    footer.append(spacerEnd, this.#zoom.element);

    this.#root.append(header, main, this.#inspector.element, footer);
    this.#toasts = new ToastHost(document.body);
    this.#tooltips = TooltipHost.install(this.#root);
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

  /**
   * Shows the newest playback report and hands it to the diagnostics dialog.
   *
   * @remarks Only a failure earns a line. That the transport is idle, or that audio waits for a
   * gesture, is what the transport controls themselves say. Show Diagnostics carries the rest.
   */
  setEngineReport(report: EngineReport): void {
    noteEngineReport(report);
    const failed = report.status === 'failed';
    this.#statusPlayback.wrapper.hidden = !failed;
    this.#statusPlayback.value.textContent = report.message ?? 'Failed';
    this.#statusPlayback.value.classList.toggle('axys-error', failed);
  }

  /**
   * Shows or clears the marker for a file being dragged over the editor.
   *
   * @remarks `null` while nothing is being dragged. Opening a file replaces the whole project,
   * so the marker names what would open rather than implying a position it would land at.
   */
  setDropTarget(name: string | null): void {
    this.#drop.hidden = name === null;
    this.#drop.textContent = name === null ? '' : `Drop To Open ${name}`;
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
    if (play && state.transport.playing !== this.#showingPause) {
      const playing = state.transport.playing;
      this.#showingPause = playing;
      const command = this.#commandLabels.get(play.id);
      play.button.innerHTML = playing ? ICONS.pause : ICONS.play;
      play.button.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      setTooltip(play.button, playing ? 'Pause' : command ? tooltipFor(command) : 'Play');
      play.button.setAttribute('aria-pressed', String(playing));
    }

    for (const [tool, button] of this.#toolButtons) {
      button.setAttribute('aria-pressed', String(state.tool === tool));
      button.disabled = state.phase !== 'ready';
    }

    const compare = this.#byLabel('Toggle Compare');
    if (compare && state.compare !== this.#showingCompare) {
      this.#showingCompare = state.compare;
      const face = COMPARE_FACES[state.compare];
      compare.button.innerHTML = ICONS[face.icon];
      compare.button.setAttribute('aria-label', `Toggle Compare: ${face.tip}`);
      setTooltip(compare.button, `${face.tip} (C)`);
    }

    // A readout earns its place only while it has something to say. A working editor reporting
    // "ready", "0 conflicts" and "nothing selected" is a row of noise to read past.
    const working = state.phase === 'ready';
    this.#statusPhase.wrapper.hidden = working;
    this.#statusPhase.value.textContent = state.message ?? state.phase;
    this.#statusPhase.value.classList.toggle('axys-error', state.phase === 'error');

    this.#statusPosition.textContent = formatClock(state.transport.position);
    this.#statusSelection.textContent = describeSelection(state);

    this.#statusConflicts.wrapper.hidden = state.conflicts.length === 0;
    this.#statusConflicts.value.textContent = String(state.conflicts.length);
    this.#statusConflicts.value.classList.add('axys-warning');

    this.#busy.hidden = !state.analysis.running;
    this.#busyStage.textContent = state.analysis.stage === '' ? 'Working' : state.analysis.stage;
    // A stage that reports no progress leaves the bar indeterminate rather than pinned at zero,
    // which reads as stalled.
    if (state.analysis.progress > 0) {
      this.#busyProgress.value = state.analysis.progress;
    } else {
      this.#busyProgress.removeAttribute('value');
    }

    this.#progress.hidden = !state.analysis.running;
    this.#progress.value = state.analysis.progress;
    setTooltip(
      this.#progress,
      state.analysis.stage === '' ? 'Analysis Progress' : state.analysis.stage,
    );

    this.#canvas.setAttribute(
      'aria-label',
      state.source === null ? 'Pitch Editor' : `Pitch Editor: ${state.source.name}`,
    );

    this.#view = state.view;
    const duration = state.source?.duration ?? 0;
    this.#timeBar.update({
      min: Math.min(0, state.view.visibleStart),
      max: Math.max(duration, state.view.visibleEnd),
      start: state.view.visibleStart,
      end: state.view.visibleEnd,
    });
    this.#pitchBar.update({
      min: 0,
      max: 127,
      start: state.view.lowMidi,
      end: state.view.highMidi,
    });
    this.#zoom.update(state.view.visibleEnd - state.view.visibleStart);

    this.#announceSelection(state);
    this.#inspector.update(state);
  }

  /** Removes the chrome and its notification layer. */
  dispose(): void {
    this.#timeBar.dispose();
    this.#pitchBar.dispose();
    this.#tooltips.dispose();
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
    const ranges = state.selection.ranges;
    const key = `${ids.join(',')}|${ranges
      .map((range) => `${String(range.start)}-${String(range.end)}`)
      .join(' ')}`;
    if (key === this.#lastSelection) {
      return;
    }
    this.#lastSelection = key;
    if (ids.length === 0 && ranges.length === 0) {
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
    for (const range of ranges) {
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
    setTooltip(button, tooltipFor(command));
    button.addEventListener('click', () => {
      this.#hooks.runCommand(command.id);
    });
    this.#commandButtons.set(command.id, button);
    this.#commandLabels.set(command.id, command);
    return button;
  }

  #buildToolGroup(): HTMLElement {
    const section = group('Editing Tools');
    // Segmented, so it reads as one control with one answer rather than eight loose buttons.
    section.classList.add('axys-segmented');
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'axys-icon';
      button.innerHTML = ICONS[tool.icon];
      button.setAttribute('aria-label', tool.label);
      button.setAttribute('aria-pressed', 'false');
      setTooltip(button, `${tool.label}: ${tool.tooltip}`);
      button.addEventListener('click', () => {
        this.#hooks.setTool(tool.id);
        this.announce(`${tool.label} active.`);
      });
      this.#toolButtons.set(tool.id, button);
      section.append(button);
    }
    return section;
  }

  #buildTheme(current: ThemeChoice): { wrapper: HTMLElement; select: HTMLSelectElement } {
    const wrapper = document.createElement('span');
    wrapper.className = 'axys-field';
    const select = document.createElement('select');
    select.id = 'axys-theme';
    for (const choice of THEME_CHOICES) {
      const element = document.createElement('option');
      element.value = choice;
      element.textContent = choice === 'system' ? 'Follow System' : THEME_LABELS[choice];
      select.append(element);
    }
    select.value = current;
    setTooltip(select, 'Colour scheme used by the chrome and the canvas.');
    const label = document.createElement('label');
    label.htmlFor = select.id;
    label.textContent = 'Theme';
    select.addEventListener('change', () => {
      const chosen = THEME_CHOICES.find((choice) => choice === select.value);
      if (chosen) {
        this.#hooks.setTheme(chosen);
        this.announce(chosen === 'system' ? 'Following System Theme' : THEME_LABELS[chosen]);
      }
    });
    wrapper.append(label, select);
    return { wrapper, select };
  }
}
