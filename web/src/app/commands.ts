// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every user-invocable action in Axys, as one flat list.
 *
 * A command is the only way the toolbar, the menu and the keyboard reach the application, so a
 * button and its shortcut can never drift apart. Commands own no state: they read the store and
 * drive the workspace, the audio engine and the editor they are handed.
 */

import type { AppState, AppStore, CompareMode } from './store.js';
import type { AudioEngine } from '../audio/engine.js';
import { MIN_BLOB_SECONDS } from '../core/types.js';
import type { Blob, EditOp, ExportPreview, TimelineMap } from '../core/types.js';
import { probeCapabilities } from '../capabilities.js';
import type { EditorController } from '../editor/interaction.js';
import { outputToSource } from '../editor/layers/blobs.js';
import { fitView, isVisible, snapViewTo, Viewport } from '../editor/view.js';
import { showDiagnostics } from '../ui/diagnostics.js';
import { showExportDialog } from '../ui/export-dialog.js';
import type { ExportChoice, ExportRange } from '../ui/export-dialog.js';
import type { ToastHost } from '../ui/toast.js';

/** A user-invocable action with a stable id, label and optional shortcut. */
export interface Command {
  id: string;
  label: string;
  group: 'File' | 'Edit' | 'Transport' | 'Tools' | 'View' | 'MIDI' | 'Help';
  shortcut?: string;
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

  /** Undoes the newest edit. False when there was nothing to undo. */
  undo(): boolean;

  /** Redoes the most recently undone edit. False when there was nothing to redo. */
  redo(): boolean;

  /** True while an import is being decoded or analysed, so a second one is refused. */
  readonly importing: boolean;

  /** Decodes, analyses and opens an audio file, replacing the open project. */
  openAudioFile(file: File): Promise<void>;

  /** Imports a Standard MIDI File as the guide, adopting its tempo and meter maps. */
  openMidiFile(file: File): Promise<void>;

  /** Opens a `.axys.json` project document. */
  openProjectFile(file: File): Promise<void>;

  /**
   * Writes the project document.
   *
   * @remarks Goes back to the file it was last written to without asking. `askWhere` forces the
   * picker, which is how a copy is saved somewhere else.
   */
  saveProject(askWhere?: boolean): Promise<void>;

  /** Opens whatever the user picked, routing it by what kind of file it turned out to be. */
  openAny(): Promise<void>;

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

  /** Proposes blob-to-note mappings against the guide and reports drift. */
  alignGuide(): void;

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

/** Pitch margin above and below the content Zoom Fit frames, in semitones. */
const FIT_MARGIN = 3;

const COMPARE_ORDER: readonly CompareMode[] = ['processed', 'original', 'split'];

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

/** The selected span in output seconds, or `null` when nothing is selected. */
function selectedRange(state: AppState): { start: number; end: number } | null {
  const range = state.selection.range;
  if (!range) return null;
  const start = Math.min(range.start, range.end);
  const end = Math.max(range.start, range.end);
  return end > start ? { start, end } : null;
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

/** A source time held inside the span a blob was analysed over. */
function clampTo(seconds: number, blob: Blob): number {
  return seconds < blob.start ? blob.start : seconds > blob.end ? blob.end : seconds;
}

/** The pair a Join Blobs command acts on: two selected neighbours, else a blob and its successor. */
function joinPair(state: AppState): { first: Blob; second: Blob } | null {
  const selected = selectedBlobs(state);
  const firstSelected = selected[0];
  if (selected.length >= 2) {
    const second = selected[1];
    if (firstSelected && second) return { first: firstSelected, second };
  }
  const anchor = firstSelected ?? blobAtPlayhead(state);
  if (!anchor) return null;
  const index = state.blobs.indexOf(anchor);
  const next = state.blobs[index + 1];
  if (!next) return null;
  return { first: anchor, second: next };
}

/** True when the playhead sits far enough inside a blob to split it into two usable halves. */
function splitTarget(state: AppState): { blob: Blob; time: number } | null {
  const blob = blobAtPlayhead(state);
  if (!blob) return null;
  const time = state.view.playhead;
  if (time - blob.start < MIN_BLOB_SECONDS || blob.end - time < MIN_BLOB_SECONDS) return null;
  return { blob, time };
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

function toolCommand(id: ToolCommandId, label: string, shortcut: string): Command {
  return {
    id: `tools.${id}`,
    label,
    group: 'Tools',
    shortcut,
    enabled: (ctx) => ctx.store.state.phase === 'ready',
    run: (ctx) => {
      ctx.store.update({ tool: id });
    },
  };
}

type ToolCommandId = AppState['tool'];

const TOOLS: readonly { id: ToolCommandId; label: string; shortcut: string }[] = [
  { id: 'select', label: 'Select Tool', shortcut: '1' },
  { id: 'split', label: 'Split Tool', shortcut: '2' },
  { id: 'pitch', label: 'Pitch Tool', shortcut: '3' },
  { id: 'pen', label: 'Pen Tool', shortcut: '4' },
  { id: 'line', label: 'Line Tool', shortcut: '5' },
  { id: 'smooth', label: 'Smooth Tool', shortcut: '6' },
  { id: 'time', label: 'Time Tool', shortcut: '7' },
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
    ready(ctx) && !ctx.store.state.transport.playing;

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
      label: 'Save A Copy',
      group: 'File',
      shortcut: 'Ctrl+Shift+S',
      enabled: ready,
      run: async (ctx) => {
        await ctx.workspace.saveProject(true);
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
        const selection = state.selection.range;
        showExportDialog({
          selection:
            selection === null
              ? null
              : {
                  start: ctx.workspace.outputAt(Math.min(selection.start, selection.end)),
                  end: ctx.workspace.outputAt(Math.max(selection.start, selection.end)),
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
      enabled: editable,
      run: (ctx) => {
        if (!ctx.workspace.redo()) ctx.toast.info('Nothing To Redo');
      },
    },
    {
      id: 'edit.splitBlob',
      label: 'Split Blob',
      group: 'Edit',
      shortcut: 'S',
      enabled: (ctx) => editable(ctx) && splitTarget(ctx.store.state) !== null,
      run: (ctx) => {
        const target = splitTarget(ctx.store.state);
        if (!target) {
          ctx.toast.warn('Put the playhead inside a blob to split.');
          return;
        }
        ctx.workspace.apply({
          type: 'splitBlob',
          blob: target.blob.id,
          time: ctx.workspace.snapTime(target.time),
        });
      },
    },
    {
      id: 'edit.joinBlobs',
      label: 'Join Blobs',
      group: 'Edit',
      shortcut: 'J',
      enabled: (ctx) =>
        editable(ctx) &&
        (selectedBlobs(ctx.store.state).length >= 2 || joinPair(ctx.store.state) !== null),
      run: (ctx) => {
        const selected = selectedBlobs(ctx.store.state);
        if (selected.length >= 2) {
          // Each join folds the next blob into the first, so the survivor stays addressable and
          // the whole selection ends up as one blob however many were covered.
          const first = selected[0];
          if (first === undefined) return;
          for (const blob of selected.slice(1)) {
            ctx.workspace.apply({ type: 'joinBlobs', first: first.id, second: blob.id });
          }
          return;
        }
        const pair = joinPair(ctx.store.state);
        if (!pair) {
          ctx.toast.warn('Select two or more neighbouring blobs to join.');
          return;
        }
        ctx.workspace.apply({ type: 'joinBlobs', first: pair.first.id, second: pair.second.id });
      },
    },
    {
      id: 'edit.reset',
      label: 'Reset',
      group: 'Edit',
      shortcut: 'Ctrl+R',
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
      shortcut: 'Ctrl+H',
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
      id: 'edit.bypassBlob',
      label: 'Bypass Blob',
      group: 'Edit',
      shortcut: 'B',
      enabled: (ctx) => editable(ctx) && targetBlob(ctx.store.state) !== undefined,
      run: (ctx) => {
        const blob = targetBlob(ctx.store.state);
        if (!blob) return;
        ctx.workspace.apply({ type: 'setBypass', blob: blob.id, bypassed: !blob.bypassed });
      },
    },
    {
      id: 'edit.excludeBlob',
      label: 'Exclude Blob',
      group: 'Edit',
      shortcut: 'X',
      enabled: (ctx) => editable(ctx) && targetBlob(ctx.store.state) !== undefined,
      run: (ctx) => {
        const blob = targetBlob(ctx.store.state);
        if (!blob) return;
        ctx.workspace.apply({ type: 'setExcluded', blob: blob.id, excluded: !blob.excluded });
      },
    },
    {
      id: 'edit.bypassAll',
      label: 'Bypass Edits',
      group: 'Edit',
      shortcut: 'Ctrl+B',
      enabled: editable,
      run: (ctx) => {
        const bypassed = ctx.store.state.edits?.globalBypass ?? false;
        ctx.workspace.apply({ type: 'setGlobalBypass', bypassed: !bypassed });
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
        const state = ctx.store.state;
        if (!state.follow && isVisible(state.view, state.view.playhead)) {
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
      id: 'transport.loopSelection',
      label: 'Loop Selection',
      group: 'Transport',
      shortcut: 'L',
      enabled: (ctx) =>
        ctx.store.state.selection.range !== null || ctx.store.state.transport.loop !== null,
      run: (ctx) => {
        const state = ctx.store.state;
        if (state.transport.loop) {
          ctx.audio.setLoop(null);
          return;
        }
        const range = state.selection.range;
        if (!range) {
          ctx.toast.warn('Select a span to loop.');
          return;
        }
        ctx.audio.setLoop({
          start: ctx.workspace.outputAt(Math.min(range.start, range.end)),
          end: ctx.workspace.outputAt(Math.max(range.start, range.end)),
        });
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
      id: 'transport.toggleCompare',
      label: 'Toggle Compare',
      group: 'Transport',
      shortcut: 'C',
      enabled: ready,
      run: (ctx) => {
        const current = COMPARE_ORDER.indexOf(ctx.store.state.compare);
        const next = COMPARE_ORDER[(current + 1) % COMPARE_ORDER.length] ?? 'processed';
        ctx.audio.setCompare(next);
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
      shortcut: '0',
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
      enabled: (ctx) => (ctx.store.state.edits?.guide ?? null) !== null,
      run: (ctx) => {
        ctx.workspace.alignGuide();
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
    commands.push(toolCommand(tool.id, tool.label, tool.shortcut));
  }
  return commands;
}

/** Looks a command up by id. */
export function findCommand(commands: Command[], id: string): Command | undefined {
  return commands.find((command) => command.id === id);
}
