// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The application chrome: toolbar, canvas, inspector, status bar and notification layer.
 *
 * The editor itself is a canvas, but everything around it is ordinary semantic HTML, so every
 * command and setting is reachable by keyboard and named for assistive technology.
 */

import '../styles.css';

import type { ThemeChoice } from '../app/preferences.js';
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
} from '../app/preferences.js';
import { selectionSpan } from '../app/selection.js';
import { toolDefinition } from '../editor/tools.js';
import { barBeatAt, bpmAt, secondsToTick } from '../editor/view.js';
import type { AppState, FollowMode, ToolId } from '../app/store.js';
import type { Capability } from '../capabilities.js';
import type { EngineReport } from '../audio/engine.js';
import type { AccidentalStyle, EditOp, MixerSettings, ViewState } from '../core/types.js';
import { noteCapabilities, noteEngineReport } from './diagnostics.js';
import { button as control } from './controls/index.js';
import { ICONS, STATE_ICONS, stateIcon, type IconName } from './icons.js';
import { Inspector } from './inspector.js';
import { MixerPanel } from './mixer.js';
import { showContextMenu } from './menu.js';
import type { MenuEntry } from './menu.js';
import type { AccentName } from './accent.js';
import { ACCENT_LABELS, ACCENT_NAMES, DEFAULT_ACCENT, accentTokens } from './accent.js';
import { THEME_LABELS, THEME_NAMES, currentTheme, isDarkTheme } from './theme.js';
import { ToastHost } from './toast.js';
import { ProgressBar } from './progress.js';
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
  /** Hands the engine a desk that has not been committed yet, so a dragged fader is audible. */
  previewMixer(mixer: MixerSettings): void;
  /** Sets the concert reference in Hz. */
  setTuning(a4Hz: number): void;
  /** Sets how accidentals are spelled. */
  setAccidentals(style: AccidentalStyle): void;
  /** Applies and remembers a colour theme, or defers to the operating system. */
  setTheme(choice: ThemeChoice): void;
  /** Applies and remembers the accent the chrome takes. */
  setAccent(accent: AccentName): void;
  /** Renames the project. One undo step, like any other edit. */
  setProjectName(name: string): void;
  /** Shows or hides the names beside the toolbar icons, and remembers the choice. */
  setToolbarLabels(on: boolean): void;
  /** Folds the inspector away to its rail, or opens it again, and remembers the choice. */
  setInspectorCollapsed(on: boolean): void;
  /** Sets how wide the inspector column is, and remembers it. */
  setInspectorWidth(pixels: number): void;
}

/** What the chrome is built from. */
export interface ShellOptions {
  /** Element the chrome replaces the contents of. */
  root: HTMLElement;
  commands: readonly ShellCommand[];
  hooks: ShellHooks;
  /** Theme choice shown as selected. Applying it is the caller's job. */
  theme?: ThemeChoice;
  /** Accent shown as selected. Applying it is the caller's job. */
  accent?: AccentName;
  /** Whether the toolbar buttons start with their names beside their icons. */
  toolbarLabels?: boolean;
}

interface ToolEntry {
  id: ToolId;
  label: string;
  icon: IconName;
  tooltip: string;
}

const TOOLS: readonly ToolEntry[] = [
  { id: 'select', label: 'Select Tool', icon: 'select', tooltip: 'Selects blobs and anchors.' },
  { id: 'split', label: 'Slice Tool', icon: 'split', tooltip: 'Slices a blob where you click.' },
  { id: 'pitch', label: 'Pitch Tool', icon: 'pitch', tooltip: 'Drags whole blobs in pitch.' },
  { id: 'pen', label: 'Draw Tool', icon: 'pen', tooltip: 'Draws a freehand pitch target.' },
  { id: 'line', label: 'Ramp Tool', icon: 'line', tooltip: 'Draws a straight pitch transition.' },
  { id: 'time', label: 'Time Tool', icon: 'time', tooltip: 'Moves and stretches blobs in time.' },
];

/** How long the metronome flash takes to fade, in seconds. */
const PULSE_SECONDS = 0.12;

/** Pixels one arrow press moves the inspector divider, by modifier. */
const RESIZE_STEP = 8;
const RESIZE_STEP_COARSE = 32;

/** Theme entries the chrome offers, with following the operating system first and default. */
const THEME_CHOICES: readonly ThemeChoice[] = ['system', ...THEME_NAMES];

/**
 * Names the toolbar shows instead of a command's full label.
 *
 * @remarks A toolbar name is read beside an icon that already says which group it belongs to, so
 * "Blob" and "Audio" are the words the icon repeats. Anything not listed shows its own label.
 */
const SHORT_LABEL: Readonly<Record<string, string>> = {
  'file.newProject': 'New',
  'file.saveProject': 'Save',
  'file.exportWav': 'Export',
  'file.importMidi': 'Import',
  'edit.joinBlobs': 'Join',
  'edit.excludeBlob': 'Exclude',
  'edit.voiceCharacter': 'Voice',
  'edit.smoothSpan': 'Smooth',
  'transport.loopSelection': 'Loop',
  'transport.toggleMetronome': 'Metronome',
  'view.followPlayhead': 'Follow',
  'midi.alignGuide': 'Align',
  'help.showDiagnostics': 'Help',
};

/** A menu a toolbar button carries, beyond the command the button itself runs. */
interface ButtonMenu {
  /** Second tooltip line saying the menu is there. */
  hint: string;
  /** Whether pressing the button opens the menu instead of running the command. */
  onPress?: boolean;
  entries(shell: AppShell): MenuEntry[];
}

/**
 * The menus toolbar buttons carry.
 *
 * @remarks Save is one button because saving is one action; where the file goes is the variation,
 * and a variation belongs under the button rather than beside it. Import opens its menu on press
 * because there is no one import to default to.
 */
const BUTTON_MENUS: Readonly<Record<string, ButtonMenu>> = {
  'file.saveProject': {
    hint: 'Save As (Ctrl+Shift+S). Right-click for both',
    entries: (shell) => [
      {
        label: 'Save Project',
        icon: 'save',
        key: 'Ctrl+S',
        enabled: shell.can('file.saveProject'),
        run: () => {
          shell.run('file.saveProject');
        },
      },
      {
        label: 'Save As',
        icon: 'save',
        key: 'Ctrl+Shift+S',
        enabled: shell.can('file.saveProjectAs'),
        run: () => {
          shell.run('file.saveProjectAs');
        },
      },
    ],
  },
  'file.importMidi': {
    hint: 'Choose what to import',
    onPress: true,
    entries: (shell) => [
      {
        label: 'MIDI Guide',
        icon: 'openMidi',
        enabled: shell.can('file.importMidi'),
        run: () => {
          shell.run('file.importMidi');
        },
      },
    ],
  },
};

/** How a theme choice names itself in the menu. */
function themeLabel(choice: ThemeChoice): string {
  return choice === 'system' ? 'Follow System' : THEME_LABELS[choice];
}

/** The theme button's tooltip: what pressing it does, and which theme is on. */
function themeTip(choice: ThemeChoice): string {
  return `Pick Theme (${choice === 'system' ? 'System' : THEME_LABELS[choice]})`;
}

/**
 * The accent swatches, as a radio group inside the theme menu.
 *
 * @remarks Each swatch is painted in the accent it selects, on the ground the current theme
 * paints, so the row shows the choice rather than describing it. High Contrast takes no accent,
 * so the row is disabled there rather than hidden: a control that comes and goes is harder to
 * find again than one that says why it cannot be used.
 */
function buildAccentRow(shell: AppShell): HTMLElement {
  const group = document.createElement('div');
  group.className = 'axys-accent-row';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Accent Colour');

  const theme = currentTheme();
  const dark = isDarkTheme(theme);
  const ignored = theme === 'contrast';
  if (ignored) {
    setTooltip(group, 'High Contrast uses its own colours');
  }

  for (const name of ACCENT_NAMES) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'axys-accent';
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-checked', String(shell.accent === name));
    swatch.setAttribute('aria-label', ACCENT_LABELS[name]);
    swatch.disabled = ignored;
    swatch.style.setProperty('--axys-swatch', accentTokens(name, dark).accent);
    if (!ignored) {
      setTooltip(swatch, ACCENT_LABELS[name]);
    }
    swatch.addEventListener('click', () => {
      shell.chooseAccent(name);
      for (const sibling of group.children) {
        sibling.setAttribute('aria-checked', String(sibling === swatch));
      }
      swatch.style.setProperty('--axys-swatch', accentTokens(name, dark).accent);
    });
    group.append(swatch);
  }
  return group;
}

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
  // Cancelling an import belongs under the progress it is cancelling.
  'file.cancelImport',
  // Selecting everything is a keyboard action; a button for it would say nothing a drag does not.
  'edit.selectAll',
  // The mixer is opened from the footer, beside the other controls that say how the editor
  // is laid out rather than what is in it.
  'view.toggleMixer',
  // Where a save goes is a variation on Save, so it lives in that button's own menu.
  'file.saveProjectAs',
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
  'New Project': 'newProject',
  Open: 'openProject',
  'Save Project': 'save',
  'Save As': 'save',
  'Import MIDI': 'openMidi',
  'Export Audio': 'export',
  Undo: 'undo',
  Redo: 'redo',
  'Join Blobs': 'join',
  Reset: 'reset',
  Correction: 'correct',
  'Voice Character': 'voice',
  'Smooth Span': 'smooth',
  'Exclude Blob': 'exclude',
  Play: 'play',
  Pause: 'pause',
  Stop: 'stop',
  'Loop Selection': 'loop',
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

/**
 * One toolbar button, kept whole so its face can be rewritten.
 *
 * @remarks A button whose meaning changes with state, such as Play becoming Pause, rewrites its
 * icon, its name, its tooltip and its pressed state together through {@link AppShell.setFace},
 * so the four can never disagree.
 */
interface ToolbarButton {
  button: HTMLButtonElement;
  icon: HTMLElement;
  text: HTMLElement;
  command: ShellCommand;
  face: string;
}

/** What a button shows. */
interface ButtonFace {
  icon: IconName;
  label: string;
  tooltip: string;
  /** Whether the button reads as switched on. Omitted for a button that is not a toggle. */
  pressed?: boolean;
}

/** What sits between the project's name and the application's in a window title. */
const TITLE_SEPARATOR = ' - ';

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
  readonly #mixer: MixerPanel;

  readonly #commandButtons = new Map<string, ToolbarButton>();
  readonly #toolButtons = new Map<ToolId, HTMLButtonElement>();
  readonly #header: HTMLElement;
  readonly #footer: HTMLElement;
  readonly #mixerToggle: HTMLButtonElement;
  /* Assigned by #buildMixerToggle, which the constructor calls before anything reads it. */
  #mixerIcon!: HTMLElement;
  readonly #themeButton: HTMLButtonElement;
  readonly #title: HTMLElement;
  readonly #resizer: HTMLElement;
  /** Distance from the pointer to the column's edge when the drag started, so the bar stays put. */
  #resizeGrab = 0;

  #themeChoice: ThemeChoice;
  #accent: AccentName;

  readonly #statusPhase: { wrapper: HTMLElement; value: HTMLElement };
  readonly #statusPosition: HTMLElement;
  readonly #statusSelection: HTMLElement;
  readonly #statusConflicts: { wrapper: HTMLElement; value: HTMLElement };
  readonly #statusPlayback: { wrapper: HTMLElement; value: HTMLElement };
  readonly #progress: ProgressBar;
  readonly #timeBar: Scrollbar;
  readonly #pitchBar: Scrollbar;
  readonly #zoom: ZoomControl;
  readonly #busy: HTMLElement;
  readonly #busyStage: HTMLElement;
  readonly #busyProgress: ProgressBar;
  readonly #drop: HTMLElement;

  #announced = '';
  #lastSelection = '';

  /** The newest view state, for the controls that report a change relative to it. */
  #view: ViewState | null = null;

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

    this.#header = header;
    this.#themeChoice = options.theme ?? 'system';
    this.#accent = options.accent ?? DEFAULT_ACCENT;
    const theme = this.#buildTheme();
    this.#themeButton = theme;

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
        section.append(theme);
      }
      header.append(section);
    }

    if (theme.parentElement === null) {
      const extras = group('View Settings');
      extras.append(theme);
      header.append(extras);
    }

    header.classList.toggle('is-labelled', options.toolbarLabels === true);

    const spacer = document.createElement('span');
    spacer.className = 'axys-spacer';
    header.append(spacer);

    // The project's name at the end of the bar, which is the window's titlebar once the app is
    // installed. In a browser tab it simply reads as one more thing the bar says.
    const title = document.createElement('span');
    title.className = 'axys-title';
    title.hidden = true;
    header.append(title);
    this.#title = title;

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
    const busyProgress = new ProgressBar('Import Progress');
    busyProgress.element.classList.add('axys-busy-progress');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel Import';
    cancel.addEventListener('click', () => {
      this.#hooks.runCommand('file.cancelImport');
    });
    busy.append(busyStage, busyProgress.element, cancel);
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
      setProjectName: (name) => {
        this.#hooks.setProjectName(name);
      },
      setView: (patch) => {
        this.#hooks.setView(patch);
      },
      setFollowMode: (mode) => {
        this.#hooks.setFollowMode(mode);
      },
      setToolbarLabels: (on) => {
        this.#hooks.setToolbarLabels(on);
      },
      setTuning: (a4Hz) => {
        this.#hooks.setTuning(a4Hz);
      },
      setAccidentals: (style) => {
        this.#hooks.setAccidentals(style);
      },
      setCollapsed: (on) => {
        this.#hooks.setInspectorCollapsed(on);
      },
    });

    this.#mixer = new MixerPanel({
      applyEdit: (op) => {
        this.#hooks.applyEdit(op);
      },
      previewMixer: (mixer) => {
        this.#hooks.previewMixer(mixer);
      },
    });

    const footer = document.createElement('footer');
    footer.className = 'axys-status';
    this.#statusPhase = statusItem(footer, 'State');
    this.#statusPosition = statusItem(footer, 'Position').value;
    this.#statusSelection = statusItem(footer, 'Selection').value;
    this.#statusConflicts = statusItem(footer, 'Conflicts');
    this.#statusPlayback = statusItem(footer, 'Playback');

    const progress = new ProgressBar('Analysis Progress');
    progress.element.hidden = true;
    setTooltip(progress.element, 'Analysis Progress');
    footer.append(progress.element);
    this.#progress = progress;

    const spacerEnd = document.createElement('span');
    spacerEnd.className = 'axys-spacer';
    this.#mixerToggle = this.#buildMixerToggle();
    this.#zoom = new ZoomControl({
      onSpan: (seconds) => {
        this.#hooks.setSpan(seconds);
      },
      onFit: () => {
        this.#hooks.runCommand('view.zoomFit');
      },
    });
    footer.append(spacerEnd, this.#mixerToggle, this.#zoom.element);
    this.#footer = footer;

    this.#resizer = this.#buildResizer();
    this.#root.append(
      header,
      main,
      this.#resizer,
      this.#inspector.element,
      this.#mixer.element,
      footer,
    );
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
    for (const [id, entry] of this.#commandButtons) {
      entry.button.disabled = !this.#hooks.isCommandEnabled(id);
    }

    const playing = state.transport.playing;
    this.#setFace('transport.play', {
      icon: playing ? STATE_ICONS.transport.on : STATE_ICONS.transport.off,
      label: playing ? 'Pause' : 'Play',
      tooltip: playing ? 'Pause (Space)' : 'Play (Space)',
      pressed: playing,
    });

    for (const [tool, button] of this.#toolButtons) {
      button.setAttribute('aria-pressed', String(state.tool === tool));
      button.disabled = state.phase !== 'ready';
    }

    // Following, looping and the metronome are switches, so each says whether it is on rather
    // than only what pressing it would do. The first two swap their glyph with it; Lucide ships
    // no off metronome, so that one carries its state in its pressed styling alone.
    this.#setFace('view.followPlayhead', {
      icon: state.follow ? STATE_ICONS.follow.on : STATE_ICONS.follow.off,
      label: 'Follow',
      tooltip: state.follow ? 'Following Playhead (F)' : 'Follow Playhead (F)',
      pressed: state.follow,
    });
    const looping = state.transport.loop !== null;
    this.#setFace('transport.loopSelection', {
      icon: looping ? STATE_ICONS.loop.on : STATE_ICONS.loop.off,
      label: 'Loop',
      tooltip: looping ? 'Stop Looping (L)' : 'Loop Selection (L)',
      pressed: looping,
    });
    const metronome = state.transport.metronome;
    this.#pulse(state, metronome && playing);
    this.#setFace('transport.toggleMetronome', {
      icon: 'metronome',
      label: 'Metronome',
      tooltip: metronome ? 'Metronome On (M)' : 'Metronome Off (M)',
      pressed: metronome,
    });

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
    // One reading of the same work, so the cover and the status bar never show two different
    // pictures of one import.
    const measured = state.analysis.progress > 0 ? state.analysis.progress : null;
    this.#busyProgress.set(measured);
    this.#progress.set(measured);

    this.#progress.element.hidden = !state.analysis.running;
    setTooltip(
      this.#progress.element,
      state.analysis.stage === '' ? 'Analysis Progress' : state.analysis.stage,
    );

    this.#canvas.setAttribute(
      'aria-label',
      state.source === null ? 'Pitch Editor' : `Pitch Editor: ${state.source.name}`,
    );

    const mixerOpen = !state.mixerCollapsed;
    const mixerLabel = mixerOpen ? 'Hide Mixer' : 'Show Mixer';
    this.#mixerIcon.innerHTML = stateIcon('mixerFold', mixerOpen);
    this.#mixerToggle.setAttribute('aria-label', mixerLabel);
    this.#mixerToggle.setAttribute('aria-pressed', String(mixerOpen));
    setTooltip(this.#mixerToggle, `${mixerLabel} (K)`);

    // `Axys` with nothing open, `Take 3 - Axys` open and saved, `*Take 3 - Axys` unsaved. The
    // marker leads, so a truncated tab still shows it.
    const name = state.projectName;
    const title = name === null ? 'Axys' : `${state.dirty ? '*' : ''}${name}${TITLE_SEPARATOR}Axys`;
    if (document.title !== title) {
      document.title = title;
    }
    this.#title.textContent = name ?? '';
    this.#title.hidden = name === null;

    this.setToolbarLabels(state.toolbarLabels);
    // The column width is the grid's, so the shell carries the folded state and the width rather
    // than the panel that asked for either.
    this.#root.classList.toggle('is-inspector-collapsed', state.inspectorCollapsed);
    // The rail width is a rule on the folded class, and an inline custom property outranks any
    // rule, so the width is written only while the column is open. Writing it either way is what
    // left the panel its full width with nothing but its rail drawn in it.
    if (state.inspectorCollapsed) {
      this.#root.style.removeProperty('--axys-inspector-width');
    } else {
      this.#root.style.setProperty('--axys-inspector-width', `${String(state.inspectorWidth)}px`);
    }
    this.#resizer.setAttribute('aria-valuenow', String(state.inspectorWidth));
    this.#resizer.hidden = state.inspectorCollapsed;
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
    this.#mixer.update(state);
  }

  /** Removes the chrome and its notification layer. */
  dispose(): void {
    this.#timeBar.dispose();
    this.#pitchBar.dispose();
    this.#tooltips.dispose();
    this.#toasts.dispose();
    this.#root.replaceChildren();
  }

  /**
   * Flashes the metronome button on each beat.
   *
   * @remarks Read from the playhead rather than from a timer of its own, so the flash lands
   * where the click lands and follows a tempo change with it. The attack is the beat itself and
   * the tail fades over {@link PULSE_SECONDS}, because what a click reports is its start.
   */
  #pulse(state: AppState, running: boolean): void {
    const entry = this.#commandButtons.get('transport.toggleMetronome');
    if (entry === undefined) {
      return;
    }
    entry.button.classList.toggle('is-pulsing', running);
    const timeline = state.edits?.timeline ?? null;
    if (!running || timeline === null) {
      entry.button.style.removeProperty('--axys-pulse');
      return;
    }
    const position = state.view.playhead;
    const beat = barBeatAt(timeline, position);
    const beatSeconds =
      (60 / bpmAt(timeline, secondsToTick(timeline, position))) * (4 / beat.beatUnit);
    const sinceBeat = (beat.beat - Math.floor(beat.beat)) * beatSeconds;
    const level = Math.max(0, 1 - sinceBeat / PULSE_SECONDS);
    entry.button.style.setProperty('--axys-pulse', level.toFixed(2));
  }

  /** Shows or hides the names beside the icons, wherever the chrome draws one. */
  setToolbarLabels(on: boolean): void {
    this.#header.classList.toggle('is-labelled', on);
    this.#footer.classList.toggle('is-labelled', on);
  }

  /**
   * The control that opens the mixer, in the footer beside the zoom.
   *
   * @remarks A bar of its own to open a panel is two bars where one would do, and the footer is
   * already where the controls that say how the editor is laid out live.
   */
  #buildMixerToggle(): HTMLButtonElement {
    const element = control({
      icon: 'mixerClosed',
      label: 'Show Mixer',
      onPress: () => {
        this.#hooks.runCommand('view.toggleMixer');
      },
    });
    this.#mixerIcon = element.querySelector<HTMLElement>('.axys-button-icon') as HTMLElement;
    return element;
  }

  /** Shows a theme as the chosen one, without applying it. */
  setTheme(choice: ThemeChoice): void {
    this.#themeChoice = choice;
    setTooltip(this.#themeButton, themeTip(choice));
  }

  /**
   * Rewrites what a button shows.
   *
   * @remarks Cheap to call on every update: a face that has not changed rewrites nothing, so a
   * button under the cursor is not rebuilt sixty times a second.
   */
  #setFace(id: string, face: ButtonFace): void {
    const entry = this.#commandButtons.get(id);
    if (entry === undefined) {
      return;
    }
    const key = `${face.icon}|${face.label}|${face.tooltip}|${String(face.pressed)}`;
    if (entry.face === key) {
      return;
    }
    entry.face = key;
    entry.icon.innerHTML = ICONS[face.icon];
    entry.text.textContent = face.label;
    entry.button.setAttribute('aria-label', face.label);
    setTooltip(entry.button, face.tooltip);
    if (face.pressed === undefined) {
      entry.button.removeAttribute('aria-pressed');
    } else {
      entry.button.setAttribute('aria-pressed', String(face.pressed));
    }
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
    const button = control({
      icon: iconFor(command),
      label: command.label,
      tooltip: tooltipFor(command),
    });
    const icon = button.querySelector<HTMLElement>('.axys-button-icon') as HTMLElement;
    const text = button.querySelector<HTMLElement>('.axys-button-label') as HTMLElement;
    // The toolbar's own shorter name where the command has one, while the accessible name stays
    // the command's, so a screen reader and the menus never disagree about what it is called.
    text.textContent = SHORT_LABEL[command.id] ?? command.label;
    button.addEventListener('click', () => {
      this.#hooks.runCommand(command.id);
    });
    const menu = BUTTON_MENUS[command.id];
    if (menu !== undefined) {
      setTooltip(button, `${tooltipFor(command)}\n${menu.hint}`);
      const open = (event: Event): void => {
        event.preventDefault();
        this.#openButtonMenu(button, menu.entries);
      };
      button.addEventListener('contextmenu', open);
      if (menu.onPress) {
        button.addEventListener('click', open);
      }
    }
    this.#commandButtons.set(command.id, {
      button,
      icon,
      text,
      command,
      face: '',
    });
    return button;
  }

  /** Opens a button's own menu directly under it, or closes the one it has open. */
  #openButtonMenu(button: HTMLButtonElement, entries: (shell: AppShell) => MenuEntry[]): void {
    const bounds = button.getBoundingClientRect();
    showContextMenu(entries(this), { x: bounds.left, y: bounds.bottom + 4 }, button);
  }

  /** Runs a command from a button menu. */
  run(id: string): void {
    this.#hooks.runCommand(id);
  }

  /** Whether a command can run, for a button menu. */
  can(id: string): boolean {
    return this.#hooks.isCommandEnabled(id);
  }

  /** The theme currently chosen, for the theme menu. */
  get themeChoice(): ThemeChoice {
    return this.#themeChoice;
  }

  /** Applies and remembers a theme, for the theme menu. */
  chooseTheme(choice: ThemeChoice): void {
    this.#hooks.setTheme(choice);
    this.setTheme(choice);
    this.announce(themeLabel(choice));
  }

  /** The accent currently chosen, for the theme menu. */
  get accent(): AccentName {
    return this.#accent;
  }

  /** Applies and remembers an accent, for the theme menu. */
  chooseAccent(accent: AccentName): void {
    this.#accent = accent;
    this.#hooks.setAccent(accent);
    this.announce(ACCENT_LABELS[accent]);
  }

  /**
   * The bar between the canvas and the inspector, dragged to set the column width.
   *
   * @remarks A grid column of its own rather than something laid over either neighbour: the
   * inspector scrolls, and a handle inside it would scroll away with the settings. Arrow keys
   * move it too, so the width is reachable without a pointer.
   */
  #buildResizer(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'axys-resizer';
    bar.tabIndex = 0;
    bar.setAttribute('role', 'separator');
    bar.setAttribute('aria-orientation', 'vertical');
    bar.setAttribute('aria-label', 'Resize Inspector');
    bar.setAttribute('aria-valuemin', String(INSPECTOR_MIN_WIDTH));
    bar.setAttribute('aria-valuemax', String(INSPECTOR_MAX_WIDTH));
    setTooltip(bar, 'Resize Inspector');

    bar.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      this.#resizeGrab =
        this.#root.getBoundingClientRect().right - event.clientX - this.#inspectorWidth();
      bar.setPointerCapture(event.pointerId);
      bar.classList.add('is-dragging');
      event.preventDefault();
    });
    bar.addEventListener('pointermove', (event: PointerEvent) => {
      if (!bar.hasPointerCapture(event.pointerId)) return;
      const edge = this.#root.getBoundingClientRect().right;
      this.#hooks.setInspectorWidth(edge - event.clientX - this.#resizeGrab);
    });
    const end = (event: PointerEvent): void => {
      if (!bar.hasPointerCapture(event.pointerId)) return;
      bar.releasePointerCapture(event.pointerId);
      bar.classList.remove('is-dragging');
    };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);

    bar.addEventListener('keydown', (event: KeyboardEvent) => {
      const step = event.shiftKey ? RESIZE_STEP_COARSE : RESIZE_STEP;
      if (event.key === 'ArrowLeft') {
        this.#hooks.setInspectorWidth(this.#inspectorWidth() + step);
      } else if (event.key === 'ArrowRight') {
        this.#hooks.setInspectorWidth(this.#inspectorWidth() - step);
      } else {
        return;
      }
      // Stopped here as well as defaulted: the shortcuts listen on the window, and an arrow that
      // reached them would nudge the selection while the divider was being moved.
      event.preventDefault();
      event.stopPropagation();
    });
    // Double-clicking a divider puts it back where it started, which is what every other one does.
    bar.addEventListener('dblclick', () => {
      this.#hooks.setInspectorWidth(INSPECTOR_DEFAULT_WIDTH);
    });
    return bar;
  }

  /** The width the inspector column is drawn at now. */
  #inspectorWidth(): number {
    return this.#inspector.element.getBoundingClientRect().width;
  }

  #buildToolGroup(): HTMLElement {
    const section = group('Editing Tools');
    // Segmented, so it reads as one control with one answer rather than eight loose buttons.
    section.classList.add('axys-segmented');
    for (const tool of TOOLS) {
      const key = toolDefinition(tool.id).key;
      const named = key === '' ? tool.label : `${tool.label} (${key})`;
      const button = control({
        icon: tool.icon,
        label: tool.label,
        tooltip: `${named}: ${tool.tooltip}`,
      });
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        this.#hooks.setTool(tool.id);
        this.announce(`${tool.label} active.`);
      });
      this.#toolButtons.set(tool.id, button);
      section.append(button);
    }
    return section;
  }

  /**
   * The theme control: a button that opens its choices.
   *
   * @remarks A drop-down among icon buttons reads as a form field in a row of controls, and its
   * closed face is a value rather than an action. A button opens the same choices and sits in
   * the toolbar as one more control.
   */
  #buildTheme(): HTMLButtonElement {
    const button = control({
      icon: 'theme',
      label: 'Theme',
      tooltip: themeTip(this.#themeChoice),
    });
    button.setAttribute('aria-label', 'Choose A Theme');
    button.setAttribute('aria-haspopup', 'menu');
    button.addEventListener('click', () => {
      this.#openButtonMenu(button, (shell) =>
        // No icon per entry: four copies of the same palette would say nothing, and the mark
        // against the current choice is what the menu is here to show.
        [
          ...THEME_CHOICES.map((choice) => ({
            label: themeLabel(choice),
            checked: shell.themeChoice === choice,
            run: () => {
              shell.chooseTheme(choice);
            },
          })),
          { separator: true as const },
          { render: () => buildAccentRow(shell) },
        ],
      );
    });
    return button;
  }
}
