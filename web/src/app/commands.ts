// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every user-invocable action in Axys, as one flat list.
 *
 * A command is the only way the toolbar, the menu and the keyboard reach the application, so a
 * button and its shortcut can never drift apart. Commands own no state: they read the store and
 * drive the workspace, the audio engine and the editor they are handed.
 */

import { savePreferences } from './preferences.js';
import { selectionSpan } from './selection.js';
import type { AppState, AppStore } from './store.js';
import type { AudioEngine } from '../audio/engine.js';
import { DEFAULT_MIXER, swapped, vocalMonitor } from '../audio/mixer.js';
import type { Blob, EditOp, ExportPreview, MappingProposal, TimelineMap } from '../core/types.js';
import { probeCapabilities } from '../capabilities.js';
import type { EditorController } from '../editor/interaction.js';
import { outputToSource } from '../editor/layers/blobs.js';
import { fitView, isVisible, snapViewTo, Viewport } from '../editor/view.js';
import { showAlignGuide } from '../ui/align-guide.js';
import { showDiagnostics } from '../ui/diagnostics.js';
import { showCorrection, showVoiceCharacter } from '../ui/operations.js';
import { showExportDialog } from '../ui/export-dialog.js';
import type { ExportChoice, ExportRange } from '../ui/export-dialog.js';
import type { ToastHost } from '../ui/toast.js';

/** A user-invocable action with a stable id, label and optional shortcut. */
export interface Command {
  id: string;
  label: string;
  group: 'File' | 'Edit' | 'Transport' | 'Tools' | 'View' | 'MIDI' | 'Help';
  shortcut?: string;
  /**
   * A second key that runs the same command.
   *
   * @remarks Never shown. It is there for the keys a second editor has trained people to reach
   * for, such as Ctrl+Y for redo, and the one the toolbar names stays the one it names.
   */
  altShortcut?: string;
  enabled(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

/**
 * The session-backed half of the application.
 *
 * @remarks Implemented by the entry point, which owns the WebAssembly session, the persistence
 * stores and the workers. Every method reports its own failures through a toast and never
 * rejects, so a command may call one without catching.
 */
export interface Workspace {
  /** True once a source has been analysed and the editor holds a session. */
  readonly ready: boolean;

  /** Name the project saves and exports under. */
  readonly projectName: string;

  /**
   * Applies one edit, recompiles the render plan and pushes it to the audio engine.
   *
   * @remarks One call is one undo step.
   */
  apply(op: EditOp): void;

  /**
   * Applies edits as the outstanding preview of an operation.
   *
   * @remarks One group, replacing whatever the previous call applied, so an operation whose
   * sliders are being dragged leaves one entry in the history rather than one per frame. Ends
   * with {@link Workspace.commitPreview} or {@link Workspace.discardPreview}.
   */
  previewEdits(ops: readonly EditOp[]): void;

  /** Keeps the outstanding preview and ends the run. */
  commitPreview(): void;

  /** Undoes the outstanding preview and ends the run. */
  discardPreview(): void;

  /** True while an operation is previewing, which is when undo and redo are not the user's. */
  readonly previewing: boolean;

  /** Undoes the newest edit. False when there was nothing to undo. */
  undo(): boolean;

  /** Redoes the most recently undone edit. False when there was nothing to redo. */
  redo(): boolean;

  /** True while an import is being decoded or analysed, so a second one is refused. */
  readonly importing: boolean;

  /** Decodes, analyses and opens an audio file, replacing the open project. */
  openAudioFile(file: File, ask?: boolean): Promise<void>;

  /** Imports a Standard MIDI File as the guide, adopting its tempo and meter maps. */
  openMidiFile(file: File): Promise<void>;

  /** Opens a `.axys.json` project document. */
  openProjectFile(file: File, ask?: boolean): Promise<void>;

  /**
   * Writes the project document.
   *
   * @remarks Goes back to the file it was last written to without asking. `askWhere` forces the
   * picker, which is how a copy is saved somewhere else.
   */
  saveProject(askWhere?: boolean): Promise<void>;

  /** Opens whatever the user picked, routing it by what kind of file it turned out to be. */
  openAny(): Promise<void>;

  /** Asks for a Standard MIDI File and imports it as the guide for the open project. */
  importMidi(): Promise<void>;

  /**
   * Measures what exporting an output range would produce, before any file is written.
   *
   * @remarks `null` when there is no session, or when the core could not measure the range.
   */
  exportPreview(range: ExportRange): ExportPreview | null;

  /** Renders and encodes a WAV file at offline quality. */
  exportWav(choice: ExportChoice): Promise<void>;

  /** Abandons an import still being analysed. Does nothing when none is running. */
  cancelImport(): void;

  /**
   * Proposes blob-to-note mappings against the guide, without applying them.
   *
   * @remarks `null` when there is no session or no guide to align against. The caller commits
   * what it keeps of the proposal as an edit of its own.
   */
  proposeMappings(): MappingProposal | null;

  /** Source time a source time snaps to on the musical grid. */
  snapTime(seconds: number): number;

  /** Output time the current plan puts a source time at. */
  outputAt(sourceSeconds: number): number;

  /** Source time the current plan reads at an output time. */
  sourceAt(outputSeconds: number): number;
}

/** Everything a command may reach. */
export interface CommandContext {
  store: AppStore;
  editor: EditorController;
  audio: AudioEngine;
  toast: ToastHost;
  workspace: Workspace;
}

/** Nominal viewport the zoom commands measure against, so zoom needs no canvas. */
const ZOOM_WIDTH = 1000;
const ZOOM_HEIGHT = 400;
const ZOOM_STEP = 1.6;

/** Default span a Smooth Span command applies when the user has not set an amount. */
const SMOOTH_AMOUNT = 0.5;

/** Longest gap in seconds two blobs may leave between them and still count as neighbours. */
const ADJACENT_SECONDS = 0.05;

/** Pitch margin above and below the content Zoom Fit frames, in semitones. */
const FIT_MARGIN = 3;

/** One edit when there is one, and one group when there are several. */
function grouped(ops: readonly EditOp[]): EditOp {
  return ops.length === 1 && ops[0] !== undefined ? ops[0] : { type: 'group', ops: [...ops] };
}

/** Blobs the selection covers, in time order. */
function selectedBlobs(state: AppState): Blob[] {
  const wanted = new Set(state.selection.blobs);
  return state.blobs.filter((blob) => wanted.has(blob.id));
}

/** The blob under the playhead, or `undefined` when the playhead sits in a gap. */
function blobAtPlayhead(state: AppState): Blob | undefined {
  const time = state.view.playhead;
  return state.blobs.find((blob) => time >= blob.start && time <= blob.end);
}

/** The blob a single-object command acts on: the selected one, else the one under the playhead. */
function targetBlob(state: AppState): Blob | undefined {
  return selectedBlobs(state)[0] ?? blobAtPlayhead(state);
}

/** Every blob a command acts on: the selection, else the blob under the playhead. */
function targetBlobs(state: AppState): Blob[] {
  const selected = selectedBlobs(state);
  if (selected.length > 0) return selected;
  const blob = blobAtPlayhead(state);
  return blob === undefined ? [] : [blob];
}

/**
 * The span the selection reaches across, in output seconds, or `null` when nothing is selected.
 *
 * @remarks Disjoint spans report their hull. Commands that act blob by blob read the blob list
 * instead, so a gap between two selected phrases is never edited on their behalf.
 */
function selectedRange(state: AppState): { start: number; end: number } | null {
  const hull = selectionSpan(state.selection.ranges);
  if (hull === null) return null;
  return hull.end > hull.start ? hull : null;
}

/** The span a span command acts on, clipped to the blob that holds it, in source seconds. */
function targetSpan(state: AppState): { blob: Blob; start: number; end: number } | null {
  const range = selectedRange(state);
  if (!range) return null;
  const blob =
    selectedBlobs(state)[0] ??
    state.blobs.find((candidate) => candidate.end > range.start && candidate.start < range.end);
  if (!blob) return null;
  const start = Math.max(blob.start, outputToSource(blob, range.start));
  const end = Math.min(blob.end, outputToSource(blob, range.end));
  if (!(end > start)) return null;
  return { blob, start, end };
}

/**
 * The one edit a Reset commits.
 *
 * @remarks Always a restore of the analysed material, so splits and joins go back with the pitch
 * and timing rather than surviving a reset. The selected span decides how much: it is converted
 * to source seconds per blob, because a stretched blob's output span is not the span it was
 * analysed over. With nothing selected the blob under the playhead is reset on its own.
 */
function resetTarget(state: AppState): EditOp | null {
  const blobs = selectedBlobs(state);
  const range = selectedRange(state);
  if (range !== null && blobs.length > 0) {
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const blob of blobs) {
      start = Math.min(start, clampTo(outputToSource(blob, range.start), blob));
      end = Math.max(end, clampTo(outputToSource(blob, range.end), blob));
    }
    if (end > start) return { type: 'resetRange', start, end };
  }
  const blob = targetBlob(state);
  return blob === undefined ? null : { type: 'resetBlob', blob: blob.id };
}

/** Whether two output spans name the same region, within a millisecond. */
function sameRange(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return Math.abs(a.start - b.start) < 1e-3 && Math.abs(a.end - b.end) < 1e-3;
}

/** A source time held inside the span a blob was analysed over. */
function clampTo(seconds: number, blob: Blob): number {
  return seconds < blob.start ? blob.start : seconds > blob.end ? blob.end : seconds;
}

/**
 * The blobs a Join Blobs command folds together.
 *
 * @remarks Two or more selected neighbours, and nothing else. Joining the blob under the playhead
 * with whatever followed it took a neighbour nobody had pointed at, and the pair it chose was
 * invisible until the join had already happened.
 */
function joinRun(state: AppState): Blob[] | null {
  const selected = selectedBlobs(state);
  if (selected.length < 2) return null;
  for (let index = 1; index < selected.length; index += 1) {
    const previous = selected[index - 1];
    const current = selected[index];
    if (!previous || !current) return null;
    if (state.blobs.indexOf(current) !== state.blobs.indexOf(previous) + 1) return null;
    if (current.start - previous.end > ADJACENT_SECONDS) return null;
  }
  return selected;
}

/**
 * Whether the whole loop is on screen.
 *
 * @remarks A loop both of whose bounds are in sight needs no scrolling to be watched, so a view
 * that follows the playhead round it only swings back and forth.
 */
function loopFullyVisible(state: AppState): boolean {
  const loop = state.transport.loop;
  if (loop === null) return false;
  return isVisible(state.view, loop.start) && isVisible(state.view, loop.end);
}

function zoomBy(store: AppStore, factor: number): void {
  const viewport = new Viewport(ZOOM_WIDTH, ZOOM_HEIGHT, store.state.view);
  store.update({ view: viewport.zoomTime(factor, ZOOM_WIDTH / 2) });
}

function fitToContent(store: AppStore): void {
  const state = store.state;
  const end = state.blobs.at(-1)?.end ?? state.source?.duration ?? 10;
  const start = state.blobs[0]?.start ?? 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const blob of state.blobs) {
    const centre = blob.detectedCenter + blob.pitchOffset;
    if (Number.isFinite(centre)) {
      low = Math.min(low, centre);
      high = Math.max(high, centre);
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    low = state.view.lowMidi;
    high = state.view.highMidi;
  }
  store.update({
    view: fitView(state.view, Math.min(start, 0), end, low - FIT_MARGIN, high + FIT_MARGIN),
  });
}

function timelineOf(state: AppState): TimelineMap | null {
  return state.edits?.timeline ?? null;
}

function toolCommand(
  id: ToolCommandId,
  label: string,
  shortcut: string,
  alt: string | undefined,
): Command {
  return {
    id: `tools.${id}`,
    label,
    group: 'Tools',
    shortcut,
    ...(alt === undefined ? {} : { altShortcut: alt }),
    enabled: (ctx) => ctx.store.state.phase === 'ready',
    run: (ctx) => {
      ctx.store.update({ tool: id });
    },
  };
}

type ToolCommandId = AppState['tool'];

/**
 * The tool keys, in the letters Melodyne and Ableton have already trained.
 *
 * @remarks Slice answers to both X and S, because the two editors disagree about which one it is
 * and neither is worth being wrong about.
 */
const TOOLS: readonly { id: ToolCommandId; label: string; shortcut: string; alt?: string }[] = [
  { id: 'select', label: 'Select Tool', shortcut: 'V' },
  { id: 'split', label: 'Slice Tool', shortcut: 'X', alt: 'S' },
  { id: 'pitch', label: 'Pitch Tool', shortcut: 'P' },
  { id: 'pen', label: 'Draw Tool', shortcut: 'B' },
  { id: 'line', label: 'Ramp Tool', shortcut: 'N' },
  { id: 'time', label: 'Time Tool', shortcut: 'T' },
];

/** Builds the full command list. */
export function buildCommands(): Command[] {
  const ready = (ctx: CommandContext): boolean => ctx.store.state.phase === 'ready';

  /**
   * True when an edit may be committed.
   *
   * @remarks Editing is barred while the transport runs. Several edit commands are enabled by
   * what the playhead is over, so during playback their answer changes every frame and the
   * toolbar flickers; an edit mid-playback also swaps the plan under the renderer.
   */
  const editable = (ctx: CommandContext): boolean =>
    ready(ctx) && !ctx.store.state.transport.playing && !ctx.workspace.previewing;

  const commands: Command[] = [
    {
      // One Open. The picker lists the kinds, so choosing a project, a vocal or a guide is a
      // choice made in the host's own dialog rather than before reaching it.
      id: 'file.open',
      label: 'Open',
      group: 'File',
      shortcut: 'Ctrl+O',
      enabled: (ctx) => !ctx.workspace.importing,
      run: async (ctx) => {
        await ctx.workspace.openAny();
      },
    },
    {
      id: 'file.saveProject',
      label: 'Save Project',
      group: 'File',
      shortcut: 'Ctrl+S',
      enabled: ready,
      run: async (ctx) => {
        await ctx.workspace.saveProject();
      },
    },
    {
      id: 'file.saveProjectAs',
      label: 'Save As',
      group: 'File',
      shortcut: 'Ctrl+Shift+S',
      enabled: ready,
      run: async (ctx) => {
        await ctx.workspace.saveProject(true);
      },
    },
    {
      // Its own button rather than one more thing behind Open: a guide is imported into an open
      // project instead of replacing it, which is the opposite of what Open does.
      id: 'file.importMidi',
      label: 'Import MIDI',
      group: 'File',
      shortcut: 'Ctrl+I',
      enabled: (ctx) => ready(ctx) && !ctx.workspace.importing,
      run: async (ctx) => {
        await ctx.workspace.importMidi();
      },
    },
    {
      id: 'file.exportWav',
      label: 'Export Audio',
      group: 'File',
      shortcut: 'Ctrl+E',
      enabled: ready,
      run: (ctx) => {
        const state = ctx.store.state;
        const selection = selectedRange(state);
        showExportDialog({
          selection:
            selection === null
              ? null
              : {
                  start: ctx.workspace.outputAt(selection.start),
                  end: ctx.workspace.outputAt(selection.end),
                },
          sourceRate: state.source?.sampleRate ?? 48_000,
          preview: (range) => ctx.workspace.exportPreview(range),
          onExport: (choice) => {
            void ctx.workspace.exportWav(choice);
          },
        });
      },
    },
    {
      id: 'file.cancelImport',
      label: 'Cancel Import',
      group: 'File',
      enabled: (ctx) => ctx.store.state.analysis.running,
      run: (ctx) => {
        ctx.workspace.cancelImport();
      },
    },

    {
      // Voice Character before Correction, so the buttons sit in the order their keys do.
      id: 'edit.voiceCharacter',
      label: 'Voice Character',
      group: 'Edit',
      shortcut: 'I',
      enabled: (ctx) => editable(ctx) && ctx.store.state.edits !== null,
      run: (ctx) => {
        showVoiceCharacter(ctx);
      },
    },
    {
      // Correction is an operation, not a project setting: it is chosen, watched against the
      // material, and then kept or thrown away. With a span selected it applies to that span.
      id: 'edit.correction',
      label: 'Correction',
      group: 'Edit',
      shortcut: 'O',
      enabled: (ctx) => editable(ctx) && ctx.store.state.edits !== null,
      run: (ctx) => {
        showCorrection(ctx);
      },
    },
    {
      id: 'edit.selectAll',
      label: 'Select All',
      group: 'Edit',
      shortcut: 'Ctrl+A',
      enabled: (ctx) => ready(ctx) && ctx.store.state.blobs.length > 0,
      run: (ctx) => {
        ctx.editor.selectAll();
      },
    },
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      shortcut: 'Ctrl+Z',
      enabled: editable,
      run: (ctx) => {
        if (!ctx.workspace.undo()) ctx.toast.info('Nothing To Undo');
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      shortcut: 'Ctrl+Shift+Z',
      altShortcut: 'Ctrl+Y',
      enabled: editable,
      run: (ctx) => {
        if (!ctx.workspace.redo()) ctx.toast.info('Nothing To Redo');
      },
    },
    {
      // Splitting is the Slice tool's, and only the Slice tool's: a command that split wherever
      // the playhead happened to be was a second way to cut that nothing on screen pointed at.
      id: 'edit.joinBlobs',
      label: 'Join Blobs',
      group: 'Edit',
      shortcut: 'J',
      enabled: (ctx) => editable(ctx) && joinRun(ctx.store.state) !== null,
      run: (ctx) => {
        const run = joinRun(ctx.store.state);
        if (!run) {
          ctx.toast.warn('Select two or more neighbouring blobs to join.');
          return;
        }
        // Each join folds the next blob into the first, so the survivor stays addressable and
        // the whole selection ends up as one blob however many were covered. One group, so
        // undoing a join of six blobs is one press rather than five.
        const first = run[0];
        if (first === undefined) return;
        ctx.workspace.apply(
          grouped(
            run.slice(1).map((blob) => ({ type: 'joinBlobs', first: first.id, second: blob.id })),
          ),
        );
      },
    },
    {
      id: 'edit.reset',
      label: 'Reset',
      group: 'Edit',
      shortcut: 'R',
      enabled: (ctx) => editable(ctx) && resetTarget(ctx.store.state) !== null,
      run: (ctx) => {
        const op = resetTarget(ctx.store.state);
        if (!op) {
          ctx.toast.warn('Select a blob or a span to reset.');
          return;
        }
        ctx.workspace.apply(op);
      },
    },
    {
      id: 'edit.smoothSpan',
      label: 'Smooth Span',
      group: 'Edit',
      shortcut: 'H',
      enabled: (ctx) => editable(ctx) && targetSpan(ctx.store.state) !== null,
      run: (ctx) => {
        const span = targetSpan(ctx.store.state);
        if (!span) {
          ctx.toast.warn('Select a span inside a blob to smooth.');
          return;
        }
        ctx.workspace.apply({
          type: 'smoothSpan',
          blob: span.blob.id,
          start: span.start,
          end: span.end,
          amount: SMOOTH_AMOUNT,
        });
      },
    },
    {
      // Acts on every selected blob, so the key does what the menu on any one of them does,
      // whether or not the menu is open. Mixed selections are excluded rather than toggled one
      // by one, because half a selection changing state is not a result anybody asked for.
      // Exclusion is about automatic correction only: the blob still sounds, and the edits made
      // on it by hand still apply.
      // `E` rather than a digit: the digits address the take by proportion, all ten of them.
      id: 'edit.excludeBlob',
      label: 'Exclude Blob',
      group: 'Edit',
      shortcut: 'E',
      enabled: (ctx) => editable(ctx) && targetBlobs(ctx.store.state).length > 0,
      run: (ctx) => {
        const blobs = targetBlobs(ctx.store.state);
        if (blobs.length === 0) return;
        const excluded = !blobs.every((blob) => blob.excluded);
        const ops = blobs
          .filter((blob) => blob.excluded !== excluded)
          .map((blob): EditOp => ({ type: 'setExcluded', blob: blob.id, excluded }));
        if (ops.length > 0) ctx.workspace.apply(grouped(ops));
      },
    },

    {
      id: 'transport.play',
      label: 'Play',
      group: 'Transport',
      shortcut: 'Space',
      enabled: ready,
      run: async (ctx) => {
        if (ctx.audio.playing) {
          ctx.audio.pause();
          return;
        }
        // Playing from a playhead already in sight is a request to watch it, so the view
        // takes the playhead back up. Playing from one off screen leaves the view alone.
        // A loop whose bounds are both on screen is watched where it is, so following it is
        // scrolling for the sake of scrolling.
        const state = ctx.store.state;
        if (
          !state.follow &&
          isVisible(state.view, state.view.playhead) &&
          !loopFullyVisible(state)
        ) {
          ctx.store.update({ follow: true });
        }
        await ctx.audio.play();
      },
    },
    {
      id: 'transport.stop',
      label: 'Stop',
      group: 'Transport',
      shortcut: 'Shift+Space',
      enabled: ready,
      run: (ctx) => {
        ctx.audio.stop();
      },
    },
    {
      // Looping follows the selection while there is one to follow. Selecting somewhere else and
      // pressing L again moves the loop there rather than switching it off, because switching it
      // off is what pressing L over the span already looping means.
      id: 'transport.loopSelection',
      label: 'Loop Selection',
      group: 'Transport',
      shortcut: 'L',
      enabled: (ctx) =>
        selectedRange(ctx.store.state) !== null || ctx.store.state.transport.loop !== null,
      run: (ctx) => {
        const state = ctx.store.state;
        const range = selectedRange(state);
        const wanted =
          range === null
            ? null
            : {
                start: ctx.workspace.outputAt(range.start),
                end: ctx.workspace.outputAt(range.end),
              };
        const loop = state.transport.loop;
        if (loop !== null && (wanted === null || sameRange(loop, wanted))) {
          ctx.audio.setLoop(null);
          return;
        }
        if (wanted === null) {
          ctx.toast.warn('Select a span to loop.');
          return;
        }
        ctx.audio.setLoop(wanted);
      },
    },
    {
      id: 'transport.toggleMetronome',
      label: 'Toggle Metronome',
      group: 'Transport',
      shortcut: 'M',
      enabled: (ctx) => timelineOf(ctx.store.state) !== null,
      run: (ctx) => {
        const timeline = timelineOf(ctx.store.state);
        if (!timeline) return;
        ctx.audio.setMetronome(!ctx.store.state.transport.metronome, timeline);
      },
    },
    {
      id: 'transport.swapVocal',
      label: 'Swap Vocal',
      group: 'Transport',
      shortcut: 'C',
      enabled: ready,
      run: (ctx) => {
        const mixer = ctx.store.state.edits?.mixer ?? DEFAULT_MIXER;
        // Hearing both, or neither, is an answer a swap cannot improve on, so it says so
        // rather than silently changing which strip is muted.
        if (vocalMonitor(mixer) === 'processed' || vocalMonitor(mixer) === 'original') {
          ctx.workspace.apply({ type: 'setMixer', mixer: swapped(mixer) });
          return;
        }
        ctx.toast.info('Mute One Vocal To Swap');
      },
    },

    {
      id: 'view.toggleMixer',
      label: 'Toggle Mixer',
      group: 'View',
      shortcut: 'K',
      enabled: () => true,
      run: (ctx) => {
        // A device preference like the theme: how the editor is laid out follows the person
        // rather than the project.
        const collapsed = !ctx.store.state.mixerCollapsed;
        savePreferences({ mixerCollapsed: collapsed });
        ctx.store.update({ mixerCollapsed: collapsed });
      },
    },
    {
      id: 'view.zoomIn',
      label: 'Zoom In',
      group: 'View',
      shortcut: '=',
      enabled: () => true,
      run: (ctx) => {
        zoomBy(ctx.store, ZOOM_STEP);
      },
    },
    {
      id: 'view.zoomOut',
      label: 'Zoom Out',
      group: 'View',
      shortcut: '-',
      enabled: () => true,
      run: (ctx) => {
        zoomBy(ctx.store, 1 / ZOOM_STEP);
      },
    },
    {
      id: 'view.zoomFit',
      label: 'Zoom Fit',
      group: 'View',
      shortcut: '.',
      enabled: () => true,
      run: (ctx) => {
        fitToContent(ctx.store);
      },
    },
    {
      id: 'view.followPlayhead',
      label: 'Follow Playhead',
      group: 'View',
      shortcut: 'F',
      enabled: () => true,
      run: (ctx) => {
        const state = ctx.store.state;
        if (state.follow) {
          ctx.store.update({ follow: false });
          return;
        }
        const span = state.view.visibleEnd - state.view.visibleStart;
        const view =
          state.followMode === 'centre'
            ? {
                ...state.view,
                visibleStart: state.view.playhead - span / 2,
                visibleEnd: state.view.playhead + span / 2,
              }
            : snapViewTo(state.view, state.view.playhead);
        ctx.store.update({ follow: true, view });
      },
    },
    {
      id: 'view.toggleBarsBeats',
      label: 'Toggle Bars Beats',
      group: 'View',
      shortcut: 'Ctrl+Alt+B',
      enabled: () => true,
      run: (ctx) => {
        const view = ctx.store.state.view;
        ctx.store.update({
          view: { ...view, timeDisplay: view.timeDisplay === 'seconds' ? 'barsBeats' : 'seconds' },
        });
      },
    },

    {
      id: 'midi.alignGuide',
      label: 'Align Guide',
      group: 'MIDI',
      shortcut: 'Ctrl+Alt+A',
      // A file being loaded is not a guide; the core refuses until a track is chosen.
      enabled: (ctx) => editable(ctx) && (ctx.store.state.edits?.guide ?? null) !== null,
      run: (ctx) => {
        showAlignGuide(ctx);
      },
    },

    {
      // One Help entry: the diagnostics dialog already carries the Source Code offer at its
      // foot, so a second button for it was the same dialog by another name.
      id: 'help.showDiagnostics',
      label: 'Help And Diagnostics',
      group: 'Help',
      shortcut: 'F1',
      enabled: () => true,
      run: async (ctx) => {
        showDiagnostics({ capabilities: await probeCapabilities(), engine: ctx.audio.report });
      },
    },
  ];

  for (const tool of TOOLS) {
    commands.push(toolCommand(tool.id, tool.label, tool.shortcut, tool.alt));
  }
  return commands;
}

/** Looks a command up by id. */
export function findCommand(commands: readonly Command[], id: string): Command | undefined {
  return commands.find((command) => command.id === id);
}
