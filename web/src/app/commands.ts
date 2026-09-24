// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every user-invocable action in Axys, as one flat list.
 *
 * A command is the only way the toolbar, the menu and the keyboard reach the application, so a
 * button and its shortcut can never drift apart. Commands own no state: they read the store and
 * drive the workspace, the audio engine and the editor they are handed.
 */

import {
  blobClipSpans,
  copyBlobs,
  copyClips,
  copyPitch,
  cutClipSpans,
  cutPitchOps,
  pastePitchOps,
  placePitch,
  placeStrokes,
} from './clipboard.js';
import type { ClipboardContent } from './clipboard.js';
import { savePreferences } from './preferences.js';
import { selectionForRanges, selectionInMode, selectionSpan } from './selection.js';
import { othersOf, stepSource } from './sources.js';
import { EDIT_MODES, editModeLabel, projectEnd, projectRate } from './store.js';
import type { AppState, AppStore, EditMode } from './store.js';
import type { AudioEngine } from '../audio/engine.js';
import { clipEnd, clipOf, clipStart, MIN_BLOB_SECONDS } from '../core/types.js';
import type {
  Blob,
  ClipId,
  EditOp,
  OthersView,
  ExportPreview,
  MappingProposal,
  TimelineMap,
} from '../core/types.js';
import type { ClipPart, PasteMode } from '../core/wasm.js';
import type { EditorController } from '../editor/interaction.js';
import { outputToSource } from '../editor/layers/blobs.js';
import { toolWorksIn } from '../editor/tools.js';
import { fitView, isVisible, snapViewTo, Viewport } from '../editor/view.js';
import { showAlignGuide } from '../ui/align-guide.js';
import { openDiagnostics } from '../ui/diagnostics.js';
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

  /**
   * Pastes copied parts of clips as new clips at a project time, as one undo step.
   *
   * @remarks The earliest part lands at `at` and the rest keep their distance from it.
   */
  pasteClips(parts: readonly ClipPart[], at: number, mode?: PasteMode): void;

  /**
   * Takes project spans out of clips on the lane, as one undo step.
   *
   * @remarks A span covering a clip removes it, one reaching an end trims it, and one inside it
   * leaves the clip in two.
   */
  cutClips(parts: readonly { clip: ClipId; start: number; end: number }[], ripple?: boolean): void;

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
  /** Writes the project and its audio as one file, asking where. */
  saveProjectWithAudio(): Promise<void>;

  /** Closes what is open and returns the editor to an empty project. */
  newProject(): Promise<void>;

  /** Opens whatever the user picked, routing it by what kind of file it turned out to be. */
  openAny(): Promise<void>;

  /**
   * Asks for a file and imports it into the open project, or starts a project with it.
   *
   * @remarks A MIDI file becomes the guide. Audio on an open project is a vocal or a reference,
   * whichever the user answers; with nothing open it starts a project as the vocal.
   */
  importAny(): Promise<void>;

  /**
   * Measures what exporting an output range would produce, before any file is written.
   *
   * @remarks `null` when there is no session, or when the core could not measure the range.
   */
  exportPreview(range: ExportRange, withReferences: boolean): ExportPreview | null;

  /** Renders and encodes a WAV file at offline quality. */
  exportWav(choice: ExportChoice): Promise<void>;

  /** Abandons an import still being analysed. Does nothing when none is running. */
  cancelImport(): void;

  /**
   * Proposes blob-to-note mappings against the guide, without applying them.
   *
   * @remarks `clips` limits the proposal to those clips, each mapped on its own; absent is every
   * clip. `null` when there is no session or no guide to align against. The caller commits what
   * it keeps of the proposal as an edit of its own.
   */
  proposeMappings(clips?: readonly ClipId[]): MappingProposal | null;

  /**
   * Brings a clip forward, and sets how the clips outside its layer are shown.
   *
   * @remarks `null` is the first clip. An absent `others` keeps the current one. A view change,
   * not an edit, so it is never undone.
   */
  focus(clip: ClipId | null, others?: OthersView): void;

  /** Source time a source time snaps to on the musical grid. */
  snapTime(seconds: number): number;
}

/** Everything a command may reach. */
export interface CommandContext {
  store: AppStore;
  editor: EditorController;
  audio: AudioEngine;
  toast: ToastHost;
  workspace: Workspace;
  /** The chrome, for the two commands that open a panel over the command list itself. */
  chrome: Chrome;
}

/**
 * What a command may ask the chrome to show.
 *
 * @remarks Only the panels built out of the command list itself. Everything else a command opens
 * is a dialog it builds, because the chrome has no business knowing what an export looks like.
 */
export interface Chrome {
  /** Opens the command palette, or closes it when it is already open. */
  toggleCommandPalette(): void;
  /** Opens the keyboard cheatsheet, or closes it when it is already open. */
  toggleCheatsheet(): void;
}

/** Brings forward the source `step` places after the one in front. */
function stepFocus(ctx: CommandContext, step: number): void {
  const state = ctx.store.state;
  if (state.edits === null) return;
  ctx.workspace.focus(stepSource(state.edits, state.layer[0] ?? null, step));
}

/**
 * Whether the host is Windows, for the one shortcut whose conventional key differs by platform.
 *
 * @remarks Reads `userAgentData` where it exists and falls back to the user agent string, which
 * is all that is needed to tell Windows from everything else. Anything not recognised is treated
 * as not Windows, which is the wider convention.
 */
function isWindows(): boolean {
  const data = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  const platform = data?.platform ?? navigator.userAgent;
  return /win/i.test(platform);
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

/** The clips the selected blobs, or the blob under the playhead, belong to. */
function targetClips(state: AppState): ClipId[] {
  return [...new Set(targetBlobs(state).map((blob) => clipOf(blob.id)))];
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
  const end = state.blobs.at(-1)?.end ?? (projectEnd(state) || 10);
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

/** Whether a clipboard holding `content` pastes in `mode`: audio in Blob and Pitch or Blob. */
function pastesIn(content: ClipboardContent, mode: EditMode): boolean {
  return content.kind === 'pitch' ? mode === 'pitch' : mode !== 'pitch';
}

/** What the clipboard commands act on in a mode, as a message names it. */
function modeNoun(mode: EditMode): string {
  return mode === 'pitch' ? 'pitch' : mode === 'blob' ? 'blobs' : 'clips';
}

/** What Copy takes in the current mode, or `null` when the selection holds none of it. */
function copyFor(state: AppState): ClipboardContent | null {
  switch (state.editMode) {
    case 'blob':
      return copyBlobs(state);
    case 'pitch':
      return copyPitch(state);
    default:
      return copyClips(state);
  }
}

/** Where the playhead is, playing or not. */
function playheadOf(state: AppState): number {
  return state.transport.playing ? state.transport.position : state.view.playhead;
}

/** The clip of the editor's layer heard at the playhead, when the playhead is inside it. */
function clipAtPlayhead(state: AppState): NonNullable<AppState['edits']>['clips'][number] | null {
  const time = playheadOf(state);
  const layer = new Set(state.layer);
  return (
    state.edits?.clips.find(
      (clip) =>
        layer.has(clip.id) &&
        time > clipStart(clip) + MIN_BLOB_SECONDS &&
        time < clipEnd(clip) - MIN_BLOB_SECONDS,
    ) ?? null
  );
}

/**
 * Cuts what the edit mode edits from the selection.
 *
 * @remarks With `ripple`, clips after a cut move earlier by its length, in Blob mode as in Blob
 * and Pitch. A pitch line has no gap to close, so it cuts the same either way.
 */
function cutSelection(ctx: CommandContext, ripple: boolean): void {
  const state = ctx.store.state;
  const content = copyFor(state);
  if (content === null) {
    ctx.toast.warn(`Select ${modeNoun(state.editMode)} to cut`);
    return;
  }
  ctx.store.update({ clipboard: content });
  if (state.editMode === 'pitch') {
    const ops = cutPitchOps(state, state.selection.ranges, state.pitchCutFill);
    if (ops.length > 0) ctx.workspace.apply(grouped(ops));
  } else {
    const spans = state.editMode === 'blob' ? blobClipSpans(state) : cutClipSpans(state);
    ctx.workspace.cutClips(spans, ripple);
  }
  ctx.editor.clearSelection();
}

/**
 * Pastes the clipboard at the playhead.
 *
 * @remarks Audio, copied as clips or as blobs, lands over what is there, moves what starts after
 * the playhead later, or replaces what is under it, as `mode` says. Pitch always replaces the line
 * it lands on.
 */
function pasteClipboard(ctx: CommandContext, mode: PasteMode): void {
  const state = ctx.store.state;
  const content = state.clipboard;
  if (content === null) return;
  if (!pastesIn(content, state.editMode)) {
    const wanted: EditMode = content.kind === 'pitch' ? 'pitch' : 'both';
    ctx.toast.warn(`Switch to ${editModeLabel(wanted)} to paste ${modeNoun(wanted)}`);
    return;
  }
  const at = playheadOf(state);
  if (content.kind === 'clips') {
    ctx.workspace.pasteClips(content.parts, at, mode);
    return;
  }
  const ops = [
    ...pastePitchOps(state, placePitch(content, selectedRange(state), at)),
    ...placeStrokes(state, content, selectedRange(state), at),
  ];
  if (ops.length === 0) {
    ctx.toast.warn('Move the playhead over a blob to paste pitch');
    return;
  }
  ctx.workspace.apply(grouped(ops));
}

/**
 * Sets the edit mode, reading the selected spans again as the new mode selects them.
 *
 * @remarks A tool with nothing to edit in the new mode gives way to the Select tool.
 */
function setEditMode(ctx: CommandContext, mode: EditMode): void {
  const state = ctx.store.state;
  if (state.editMode === mode) return;
  const selection = selectionInMode(selectionForRanges(state.blobs, state.selection.ranges), mode);
  const tool = toolWorksIn(state.tool, mode) ? state.tool : 'select';
  ctx.store.update({ editMode: mode, selection, tool });
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
    enabled: (ctx) =>
      ctx.store.state.phase === 'ready' && toolWorksIn(id, ctx.store.state.editMode),
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
  { id: 'bezier', label: 'Bezier Tool', shortcut: 'N' },
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
      id: 'file.newProject',
      label: 'New Project',
      group: 'File',
      // Not Ctrl+N: the browser answers that one first, with a window of its own.
      shortcut: 'Ctrl+Alt+N',
      // With nothing open there is nothing for it to replace.
      enabled: (ctx) => ctx.workspace.ready && !ctx.workspace.importing,
      run: async (ctx) => {
        await ctx.workspace.newProject();
      },
    },
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
      id: 'file.saveProjectWithAudio',
      label: 'Save with Audio',
      group: 'File',
      enabled: ready,
      run: async (ctx) => {
        await ctx.workspace.saveProjectWithAudio();
      },
    },
    {
      // Its own button rather than one more thing behind Open: an import adds to the open
      // project instead of replacing it, which is the opposite of what Open does.
      id: 'file.import',
      label: 'Import',
      group: 'File',
      shortcut: 'Ctrl+I',
      enabled: (ctx) => !ctx.workspace.importing,
      run: async (ctx) => {
        await ctx.workspace.importAny();
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
          selection,
          sourceRate: projectRate(state) ?? 48_000,
          references: (state.edits?.references.length ?? 0) > 0,
          preview: (range, withReferences) => ctx.workspace.exportPreview(range, withReferences),
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
      id: 'edit.copy',
      label: 'Copy',
      group: 'Edit',
      shortcut: 'Ctrl+C',
      enabled: (ctx) => ready(ctx) && ctx.store.state.selection.ranges.length > 0,
      run: (ctx) => {
        const state = ctx.store.state;
        const content = copyFor(state);
        if (content === null) {
          ctx.toast.warn(`Select ${modeNoun(state.editMode)} to copy`);
          return;
        }
        ctx.store.update({ clipboard: content });
        ctx.toast.info('Copied');
      },
    },
    {
      id: 'edit.cut',
      label: 'Cut',
      group: 'Edit',
      shortcut: 'Ctrl+X',
      enabled: (ctx) => editable(ctx) && ctx.store.state.selection.ranges.length > 0,
      run: (ctx) => {
        cutSelection(ctx, false);
      },
    },
    {
      // Clips after the cut close up the gap it leaves. Blobs and pitch have no gap to close.
      id: 'edit.rippleCut',
      label: 'Ripple Cut',
      group: 'Edit',
      shortcut: 'Ctrl+Shift+X',
      enabled: (ctx) => editable(ctx) && ctx.store.state.selection.ranges.length > 0,
      run: (ctx) => {
        cutSelection(ctx, true);
      },
    },
    {
      // Paste lands at the playhead over whatever is there. Pitch lands at the start of the
      // selection when there is one, at the length it was copied at.
      id: 'edit.paste',
      label: 'Paste',
      group: 'Edit',
      shortcut: 'Ctrl+V',
      enabled: (ctx) => editable(ctx) && ctx.store.state.clipboard !== null,
      run: (ctx) => {
        pasteClipboard(ctx, 'overlap');
      },
    },
    {
      id: 'edit.pasteInsert',
      label: 'Paste Insert',
      group: 'Edit',
      shortcut: 'Ctrl+Shift+V',
      enabled: (ctx) => editable(ctx) && ctx.store.state.clipboard !== null,
      run: (ctx) => {
        pasteClipboard(ctx, 'ripple');
      },
    },
    {
      id: 'edit.pasteReplace',
      label: 'Paste Replace',
      group: 'Edit',
      shortcut: 'Ctrl+Alt+V',
      enabled: (ctx) => editable(ctx) && ctx.store.state.clipboard !== null,
      run: (ctx) => {
        pasteClipboard(ctx, 'replace');
      },
    },
    {
      id: 'edit.trimStart',
      label: 'Trim Start',
      group: 'Edit',
      shortcut: 'Alt+[',
      enabled: (ctx) => editable(ctx) && clipAtPlayhead(ctx.store.state) !== null,
      run: (ctx) => {
        const state = ctx.store.state;
        const clip = clipAtPlayhead(state);
        if (clip === null) {
          ctx.toast.warn('Move the playhead inside a clip to trim');
          return;
        }
        ctx.workspace.apply({
          type: 'trimClip',
          clip: clip.id,
          start: playheadOf(state),
          end: clipEnd(clip),
        });
      },
    },
    {
      id: 'edit.trimEnd',
      label: 'Trim End',
      group: 'Edit',
      shortcut: 'Alt+]',
      enabled: (ctx) => editable(ctx) && clipAtPlayhead(ctx.store.state) !== null,
      run: (ctx) => {
        const state = ctx.store.state;
        const clip = clipAtPlayhead(state);
        if (clip === null) {
          ctx.toast.warn('Move the playhead inside a clip to trim');
          return;
        }
        ctx.workspace.apply({
          type: 'trimClip',
          clip: clip.id,
          start: clipStart(clip),
          end: playheadOf(state),
        });
      },
    },
    {
      id: 'edit.resetTrim',
      label: 'Reset Trim',
      group: 'Edit',
      enabled: (ctx) =>
        editable(ctx) &&
        targetClips(ctx.store.state).some(
          (id) => ctx.store.state.edits?.clips.find((clip) => clip.id === id)?.window !== undefined,
        ),
      run: (ctx) => {
        const state = ctx.store.state;
        const targets = new Set(targetClips(state));
        const ops = (state.edits?.clips ?? [])
          .filter((clip) => targets.has(clip.id) && clip.window !== undefined)
          .map((clip): EditOp => ({
            type: 'trimClip',
            clip: clip.id,
            start: clip.position,
            end: clip.position + clip.source.duration,
          }));
        if (ops.length > 0) ctx.workspace.apply(grouped(ops));
      },
    },
    {
      id: 'edit.undo',
      label: 'Undo',
      group: 'Edit',
      shortcut: 'Ctrl+Z',
      enabled: editable,
      run: (ctx) => {
        if (!ctx.workspace.undo()) ctx.toast.info('Nothing to undo');
      },
    },
    {
      id: 'edit.redo',
      label: 'Redo',
      group: 'Edit',
      // Both keys always run it. Which one is shown follows the platform: Ctrl+Y is what Windows
      // editors train people to reach for, and Cmd+Shift+Z is what macOS does.
      shortcut: isWindows() ? 'Ctrl+Y' : 'Ctrl+Shift+Z',
      altShortcut: isWindows() ? 'Ctrl+Shift+Z' : 'Ctrl+Y',
      enabled: editable,
      run: (ctx) => {
        if (!ctx.workspace.redo()) ctx.toast.info('Nothing to redo');
      },
    },
    {
      // Splitting is the Slice tool's, and only the Slice tool's: a command that split wherever
      // the playhead happened to be was a second way to cut that nothing on screen pointed at.
      id: 'edit.joinBlobs',
      label: 'Join Blob(s)',
      group: 'Edit',
      shortcut: 'J',
      enabled: (ctx) => editable(ctx) && joinRun(ctx.store.state) !== null,
      run: (ctx) => {
        const run = joinRun(ctx.store.state);
        if (!run) {
          ctx.toast.warn('Select two or more neighbouring blobs to join');
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
      label: 'Reset Blob(s)',
      group: 'Edit',
      shortcut: 'R',
      enabled: (ctx) => editable(ctx) && resetTarget(ctx.store.state) !== null,
      run: (ctx) => {
        const op = resetTarget(ctx.store.state);
        if (!op) {
          ctx.toast.warn('Select a blob or a span to reset');
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
          ctx.toast.warn('Select a span inside a blob to smooth');
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
      label: 'Exclude Blob(s)',
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
      // A deleted blob takes the audio under it with it, and Reset Range brings both back.
      id: 'edit.deleteBlobs',
      label: 'Delete Blob(s)',
      group: 'Edit',
      shortcut: 'Delete',
      altShortcut: 'Backspace',
      enabled: (ctx) => editable(ctx) && selectedBlobs(ctx.store.state).length > 0,
      run: (ctx) => {
        const blobs = selectedBlobs(ctx.store.state).map((blob) => blob.id);
        if (blobs.length === 0) return;
        ctx.workspace.apply({ type: 'deleteBlobs', blobs });
        ctx.editor.clearSelection();
      },
    },
    {
      // Pitch mode selects no blobs, so the same key falls through to here.
      id: 'edit.deletePitch',
      label: 'Delete Pitch',
      group: 'Edit',
      shortcut: 'Delete',
      altShortcut: 'Backspace',
      enabled: (ctx) =>
        editable(ctx) &&
        ctx.store.state.editMode === 'pitch' &&
        ctx.store.state.selection.ranges.length > 0,
      run: (ctx) => {
        const state = ctx.store.state;
        const ops = cutPitchOps(state, state.selection.ranges, 'sung');
        if (ops.length > 0) ctx.workspace.apply(grouped(ops));
      },
    },
    {
      id: 'edit.deleteClip',
      label: 'Delete Clip',
      group: 'Edit',
      shortcut: 'Shift+Delete',
      enabled: (ctx) => editable(ctx) && targetClips(ctx.store.state).length > 0,
      run: (ctx) => {
        const clips = targetClips(ctx.store.state);
        if (clips.length === 0) return;
        ctx.workspace.apply(grouped(clips.map((clip): EditOp => ({ type: 'removeClip', clip }))));
        ctx.editor.clearSelection();
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
      // Stop both halts playback and returns the playhead to the start, so it has something to do
      // while either is true and nothing to do when the transport is already stopped at zero.
      enabled: (ctx) =>
        ready(ctx) && (ctx.store.state.transport.playing || ctx.store.state.transport.position > 0),
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
        // A selection is already in output time, which is what the transport loops.
        const wanted = selectedRange(state);
        const loop = state.transport.loop;
        if (loop !== null && (wanted === null || sameRange(loop, wanted))) {
          ctx.audio.setLoop(null);
          return;
        }
        if (wanted === null) {
          ctx.toast.warn('Select a span to loop');
          return;
        }
        ctx.audio.setLoop(wanted);
      },
    },
    {
      id: 'transport.toggleMetronome',
      label: 'Metronome',
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
      id: 'transport.toggleCountIn',
      label: 'Count In',
      group: 'Transport',
      enabled: (ctx) => timelineOf(ctx.store.state) !== null,
      run: (ctx) => {
        ctx.audio.setCountIn(!ctx.store.state.transport.countIn);
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
      id: 'view.sources',
      label: 'Next Source',
      group: 'View',
      shortcut: 'W',
      enabled: (ctx) => editable(ctx) && (ctx.store.state.edits?.clips.length ?? 0) > 1,
      run: (ctx) => {
        stepFocus(ctx, 1);
      },
    },
    {
      id: 'view.previousSource',
      label: 'Previous Source',
      group: 'View',
      shortcut: 'Shift+W',
      enabled: (ctx) => editable(ctx) && (ctx.store.state.edits?.clips.length ?? 0) > 1,
      run: (ctx) => {
        stepFocus(ctx, -1);
      },
    },
    {
      // Show, then Dim, then Hide, then Show again.
      id: 'view.toggleOthers',
      label: 'Toggle Others',
      group: 'View',
      shortcut: '\\',
      enabled: (ctx) => editable(ctx) && (ctx.store.state.edits?.clips.length ?? 0) > 1,
      run: (ctx) => {
        const state = ctx.store.state;
        const mode = othersOf(state.view);
        const next = mode === 'show' ? 'dim' : mode === 'dim' ? 'hide' : 'show';
        ctx.workspace.focus(state.layer[0] ?? null, next);
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
      id: 'tools.nextEditMode',
      label: 'Next Edit Mode',
      group: 'Tools',
      shortcut: 'Q',
      enabled: ready,
      run: (ctx) => {
        const index = EDIT_MODES.indexOf(ctx.store.state.editMode);
        setEditMode(ctx, EDIT_MODES[(index + 1) % EDIT_MODES.length] ?? 'both');
      },
    },
    {
      id: 'tools.previousEditMode',
      label: 'Previous Edit Mode',
      group: 'Tools',
      shortcut: 'Shift+Q',
      enabled: ready,
      run: (ctx) => {
        const index = EDIT_MODES.indexOf(ctx.store.state.editMode);
        const count = EDIT_MODES.length;
        setEditMode(ctx, EDIT_MODES[(index + count - 1) % count] ?? 'both');
      },
    },
    ...EDIT_MODES.map((mode): Command => ({
      id: `tools.editMode.${mode}`,
      label: `${editModeLabel(mode)} Mode`,
      group: 'Tools',
      enabled: ready,
      run: (ctx) => {
        setEditMode(ctx, mode);
      },
    })),
    {
      id: 'view.toggleBarsBeats',
      label: 'Toggle Bars and Beats',
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
      id: 'view.commandPalette',
      label: 'Find Command',
      group: 'View',
      shortcut: 'Ctrl+Shift+P',
      // A backtick is nothing on its own in an editor and is one key rather than three, which is
      // what a palette wants to be reached by.
      altShortcut: '`',
      enabled: () => true,
      run: (ctx) => {
        ctx.chrome.toggleCommandPalette();
      },
    },
    {
      id: 'help.shortcuts',
      label: 'Keyboard Shortcuts',
      group: 'Help',
      shortcut: ',',
      enabled: () => true,
      run: (ctx) => {
        ctx.chrome.toggleCheatsheet();
      },
    },
    {
      // One Help entry: the diagnostics dialog already carries the Source Code offer at its
      // foot, so a second button for it was the same dialog by another name.
      id: 'help.showDiagnostics',
      label: 'Help and Diagnostics',
      group: 'Help',
      shortcut: 'F1',
      enabled: () => true,
      run: async () => {
        await openDiagnostics();
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
