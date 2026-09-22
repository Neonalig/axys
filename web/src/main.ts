// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Application entry point.
 *
 * Probes the browser, loads the WebAssembly core and wires the store, shell, editor, audio
 * engine, workers and persistence into one running editor. It also owns the session: an edit
 * enters here, the core recompiles the render plan, and the plan goes straight to the worklet,
 * so what the user hears follows what the user edited.
 */

import { buildCommands, findCommand } from './app/commands.js';
import type { Command, CommandContext, Workspace } from './app/commands.js';
import { bindShortcuts } from './app/shortcuts.js';
import { loadPreferences, savePreferences } from './app/preferences.js';
import type { ThemeChoice } from './app/preferences.js';
import { selectionForRange } from './app/selection.js';
import { AppStore, initialState } from './app/store.js';
import type { CompareMode, FollowMode, ToolId } from './app/store.js';
import { decodeAudioFile } from './audio/decode.js';
import { AudioEngine } from './audio/engine.js';
import type { EngineReport } from './audio/engine.js';
import { isSupported, probeCapabilities } from './capabilities.js';
import type { Capability } from './capabilities.js';
import { isProject, parseJson } from './core/json.js';
import { AxysError, loadCore } from './core/wasm.js';
import type { AxysCore, Session } from './core/wasm.js';
import type {
  AccidentalStyle,
  EditOp,
  ExportPreview,
  GuideOverlap,
  Project,
  RenderPlan,
  ViewState,
} from './core/types.js';
import { EditorController } from './editor/interaction.js';
import { buildPeaks, clearPeaks } from './editor/peaks.js';
import { EditorRenderer } from './editor/renderer.js';
import { fitView, followView, MAX_TIME_SPAN, MIN_TIME_SPAN } from './editor/view.js';
import { Autosave } from './persistence/autosave.js';
import { PersistenceError, ProjectStore } from './persistence/db.js';
import { MediaStore } from './persistence/opfs.js';
import {
  EXPORT_KIND,
  openFile,
  OPENABLE,
  PROJECT_KIND,
  saveFileAs,
  writeFile,
} from './persistence/file-access.js';
import type { FileHandle } from './persistence/file-access.js';
import { importProject, relink } from './persistence/project-io.js';
import type { ExportChoice, ExportRange } from './ui/export-dialog.js';
import { showContextMenu } from './ui/menu.js';
import type { MenuEntry } from './ui/menu.js';
import { AppShell } from './ui/shell.js';
import type { ShellHooks } from './ui/shell.js';
import { applyTheme, preferredTheme, watchPreferredTheme } from './ui/theme.js';
import type { ThemeName } from './ui/theme.js';
import type { ToastHost } from './ui/toast.js';
import { AnalysisClient, RenderClient } from './workers/client.js';
import { WorkerCancelled } from './workers/protocol.js';

/** Pitch margin above and below the content the first view frames, in semitones. */
const FIT_MARGIN = 3;

/** Local flag recording that the degraded-capability notice has been shown once. */
const DEGRADED_NOTICE_KEY = 'axys.degraded.notice';

/** Playhead movement below this, in seconds, is not worth a store update. */
const PLAYHEAD_EPSILON = 1e-4;

/** How often the engine's underrun count is read, and the shortest gap between its warnings. */
const UNDERRUN_INTERVAL_MS = 10_000;

/** What an {@link AxysWorkspace} needs to reach the core, the device and the user. */
interface WorkspaceDeps {
  core: AxysCore;
  store: AppStore;
  audio: AudioEngine;
  toast: ToastHost;
  projects: ProjectStore | null;
  media: MediaStore | null;
}

/** A project document waiting for its source audio to be relinked. */
interface PendingProject {
  json: string;
  project: Project;
}

/**
 * The session-backed half of the application.
 *
 * @remarks Owns the one open {@link Session}. Every edit path ends in {@link AxysWorkspace.apply}
 * or one of the file operations, each of which republishes the compiled plan to the audio engine
 * so playback reflects the edit immediately.
 */
class AxysWorkspace implements Workspace {
  readonly #core: AxysCore;
  readonly #store: AppStore;
  readonly #audio: AudioEngine;
  readonly #toast: ToastHost;
  readonly #projects: ProjectStore | null;
  readonly #media: MediaStore | null;
  readonly #analysis = new AnalysisClient();
  readonly #render = new RenderClient();

  #session: Session | null = null;
  #plan: RenderPlan | null = null;
  #name = 'Untitled';
  #projectId: string | null = null;
  #autosave: Autosave | null = null;
  #pending: PendingProject | null = null;
  #importing = false;
  /** Where Save Project last wrote, so a later save needs no picker. */
  #projectFile: FileHandle | null = null;

  constructor(deps: WorkspaceDeps) {
    this.#core = deps.core;
    this.#store = deps.store;
    this.#audio = deps.audio;
    this.#toast = deps.toast;
    this.#projects = deps.projects;
    this.#media = deps.media;
  }

  get ready(): boolean {
    return this.#session !== null;
  }

  get projectName(): string {
    return this.#name;
  }

  get importing(): boolean {
    return this.#importing;
  }

  /**
   * Opens whatever the user picked, routed by what the file turned out to be.
   *
   * @remarks One picker rather than three commands. A project opened from disk also remembers
   * where it came from, so the first Save on it needs no dialog either.
   */
  async openAny(): Promise<void> {
    if (this.#importing) {
      this.#toast.warn('An import is already running.');
      return;
    }
    let picked;
    try {
      picked = await openFile(OPENABLE);
    } catch (error) {
      this.#fail('Open', error);
      return;
    }
    if (picked === null) return;
    switch (kindOf(picked.file)) {
      case 'project':
        this.#projectFile = picked.handle;
        await this.openProjectFile(picked.file);
        return;
      case 'midi':
        await this.openMidiFile(picked.file);
        return;
      default:
        await this.openAudioFile(picked.file);
    }
  }

  apply(op: EditOp): void {
    const session = this.#session;
    if (!session) return;
    const guide = this.#store.state.edits?.guide ?? null;
    try {
      session.applyEdit(op);
    } catch (error) {
      this.#fail('Apply Edit', error);
      return;
    }
    this.#publish();
    if (op.type === 'setGuide') {
      const chosen = op.selection;
      const track = guide?.track !== chosen?.track || guide?.channel !== chosen?.channel;
      this.#reportGuideOverlaps(track);
    }
  }

  undo(): boolean {
    const session = this.#session;
    if (!session) return false;
    let undone = false;
    try {
      undone = session.undo();
    } catch (error) {
      this.#fail('Undo', error);
      return false;
    }
    if (undone) this.#publish();
    return undone;
  }

  redo(): boolean {
    const session = this.#session;
    if (!session) return false;
    let redone = false;
    try {
      redone = session.redo();
    } catch (error) {
      this.#fail('Redo', error);
      return false;
    }
    if (redone) this.#publish();
    return redone;
  }

  async openAudioFile(file: File): Promise<void> {
    if (this.#pending) {
      await this.#relinkPending(file);
      return;
    }
    // One import at a time. A second would race the first onto the same session and leave
    // whichever finished last in charge, which is not a choice anybody made.
    if (this.#importing) {
      this.#toast.warn('An import is already running.');
      return;
    }
    this.#progress('Decode Audio', 0.05);
    this.#importing = true;
    try {
      const decoded = await decodeAudioFile(file);
      const analysed = await this.#analysis.analyse(
        { samples: decoded.mono, sampleRate: decoded.sampleRate, name: decoded.name },
        (stage, progress) => {
          this.#progress(stage, progress);
        },
      );
      const session = this.#core.openSessionFromAnalysis({
        samples: analysed.samples,
        sampleRate: analysed.sampleRate,
        name: analysed.name,
        trackJson: analysed.trackJson,
        blobsJson: analysed.blobsJson,
      });
      await this.#install(session, analysed.samples, analysed.name, null);
      if (decoded.resampled) {
        this.#toast.warn(`Decoded at ${String(decoded.sampleRate)} Hz, not the file's own rate.`);
      }
    } catch (error) {
      if (error instanceof WorkerCancelled) {
        this.#idle();
        this.#store.update({ phase: this.#session ? 'ready' : 'empty', message: null });
        this.#toast.info('Import Cancelled');
      } else {
        this.#fail('Open Audio', error);
      }
    } finally {
      this.#importing = false;
    }
  }

  cancelImport(): void {
    if (!this.#importing) return;
    this.#analysis.cancel();
  }

  async openMidiFile(file: File): Promise<void> {
    const session = this.#session;
    if (!session) {
      this.#toast.warn('Open a vocal before a MIDI guide.');
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const midi = session.loadMidi(bytes);
      this.#store.update({ midi });
      this.#publish();
      this.#toast.info(
        `Imported ${String(midi.tracks.length)} tracks, ${String(midi.notes.length)} notes.`,
      );
    } catch (error) {
      this.#fail('Open MIDI', error);
    }
  }

  async openProjectFile(file: File): Promise<void> {
    try {
      const imported = await importProject(file);
      await this.#openProject(imported.json, imported.project);
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  /** Opens a project document already held on this device. */
  async openProjectJson(json: string): Promise<void> {
    try {
      const project = parseJson(json, isProject, 'project');
      await this.#openProject(json, project);
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  /**
   * Writes the project document, and keeps a copy on the device as a safety net.
   *
   * @remarks The file it last wrote to is reused without a dialog, which is the whole point of a
   * Save worth pressing often. `askWhere` forces the picker so a copy can go elsewhere, and
   * leaves the remembered file alone so the original stays the one Save writes to.
   */
  async saveProject(askWhere = false): Promise<void> {
    const json = this.#projectJson();
    if (json === null) {
      this.#toast.error('Nothing To Save');
      return;
    }
    try {
      const existing = this.#projectFile;
      if (!askWhere && existing !== null) {
        await writeFile(existing, json);
        this.#store.update({ dirty: false });
        this.#toast.info(`Saved ${existing.name}`);
      } else {
        const name = `${this.#name}.axys.json`;
        const handle = await saveFileAs(json, name, PROJECT_KIND, 'application/json');
        if (handle === null && !hasHandleSupport()) {
          this.#toast.info(`Saved ${name}`);
        } else if (handle !== null) {
          if (!askWhere) this.#projectFile = handle;
          this.#toast.info(`Saved ${handle.name}`);
        } else {
          return;
        }
        if (!askWhere) this.#store.update({ dirty: false });
      }
    } catch (error) {
      this.#fail('Save Project', error);
      return;
    }
    await this.#keepLocalCopy(json);
  }

  /** Mirrors the document into device storage, so a lost file is not a lost session. */
  async #keepLocalCopy(json: string): Promise<void> {
    const projects = this.#projects;
    if (!projects) return;
    try {
      await projects.save(this.#projectId ?? 'project', json);
    } catch {
      // The file on disk is the copy that matters; this one is only a safety net.
    }
  }

  exportPreview(range: ExportRange): ExportPreview | null {
    const session = this.#session;
    if (!session) return null;
    try {
      return session.exportPreview(range);
    } catch {
      return null;
    }
  }

  async exportWav(choice: ExportChoice): Promise<void> {
    const session = this.#session;
    const json = this.#projectJson();
    if (!session || json === null) {
      this.#toast.error('Nothing To Export');
      return;
    }
    this.#progress('Export WAV', 0.02);
    try {
      const encoded = await this.#render.exportWav(
        {
          projectJson: json,
          samples: session.source(),
          range: choice.range,
          depth: choice.depth,
          sampleRate: choice.sampleRate,
        },
        (stage, progress) => {
          this.#progress(stage, progress);
        },
      );
      await saveFileAs(toBytes(encoded.bytes), `${this.#name}.wav`, EXPORT_KIND, 'audio/wav');
      if (encoded.report.clippedSamples > 0) {
        this.#toast.warn(
          `Clipped ${String(encoded.report.clippedSamples)} samples. Lower the level and export again.`,
        );
      } else {
        this.#toast.info(`Exported ${this.#name}.wav, peak ${encoded.report.peak.toFixed(2)}`);
      }
    } catch (error) {
      this.#fail('Export WAV', error);
    } finally {
      this.#idle();
    }
  }

  alignGuide(): void {
    const session = this.#session;
    if (!session) return;
    try {
      const report = session.proposeMappings();
      this.#publish();
      this.#store.update({ mappingReport: report, drift: session.drift() });
      this.#toast.info(
        `Guide aligned. ${String(report.unmappedBlobs.length)} blobs and ${String(report.unmappedNotes.length)} notes unmapped.`,
      );
      this.#reportGuideOverlaps(true);
    } catch (error) {
      this.#fail('Align Guide', error);
    }
  }

  /** Sets the concert reference the editor names and measures pitch against. */
  setTuning(a4Hz: number): void {
    this.apply({ type: 'setTuning', tuning: { a4Hz } });
  }

  /** Sets how accidentals are spelled. */
  setAccidentals(style: AccidentalStyle): void {
    this.apply({ type: 'setAccidentals', accidentals: style });
  }

  snapTime(seconds: number): number {
    const session = this.#session;
    if (!session) return seconds;
    try {
      return session.snapSeconds(seconds, this.#store.state.view.snapDivision);
    } catch {
      return seconds;
    }
  }

  outputAt(sourceSeconds: number): number {
    return mapTime(this.#plan, sourceSeconds, 1, 0);
  }

  sourceAt(outputSeconds: number): number {
    return mapTime(this.#plan, outputSeconds, 0, 1);
  }

  /** Releases the session, the workers and the autosave timer. */
  dispose(): void {
    this.#autosave?.dispose();
    this.#analysis.terminate();
    this.#render.terminate();
    this.#session?.free();
    this.#session = null;
  }

  async #openProject(json: string, project: Project): Promise<void> {
    const media = this.#media;
    let samples: Float32Array | null = null;
    if (media) {
      try {
        samples = await media.read(project.source.fingerprint);
      } catch {
        samples = null;
      }
    }
    if (!samples) {
      this.#pending = { json, project };
      this.#store.update({
        phase: 'error',
        message: `Relink "${project.source.name}" to open this project.`,
      });
      this.#toast.warn(`Relink ${project.source.name} to open this project.`);
      return;
    }
    this.#progress('Open Project', 0.4);
    try {
      const session = this.#core.openSession(json, samples);
      await this.#install(session, samples, project.name, project.view);
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  async #relinkPending(file: File): Promise<void> {
    const pending = this.#pending;
    if (!pending) return;
    this.#progress('Open Project', 0.2);
    try {
      const relinked = await relink(file, pending.project.source);
      const session = this.#core.openSession(pending.json, relinked.samples);
      this.#pending = null;
      await this.#install(session, relinked.samples, pending.project.name, pending.project.view);
      this.#toast.info('Audio Relinked');
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  /** Adopts a new session as the open project and hands its audio to the engine. */
  async #install(
    session: Session,
    mono: Float32Array,
    name: string,
    view: ViewState | null,
  ): Promise<void> {
    this.#session?.free();
    this.#autosave?.dispose();
    this.#session = session;
    this.#name = name;
    // A fresh import has no file of its own yet, so the next Save asks where it goes.
    if (view === null) this.#projectFile = null;

    const source = session.sourceInfo();
    const blobs = session.blobs();
    const track = session.track();
    const plan = session.plan();
    this.#plan = plan;
    this.#projectId = `project-${source.fingerprint}`;

    clearPeaks();
    buildPeaks(mono, source.sampleRate, source.fingerprint);

    await this.#audio.loadSource(session.source(), source.sampleRate, session.trackJson());
    this.#audio.setPlan(plan);
    this.#audio.setLoop(null);

    const framed =
      view ??
      fitView(
        this.#store.state.view,
        0,
        source.duration,
        lowestCentre(blobs) - FIT_MARGIN,
        highestCentre(blobs) + FIT_MARGIN,
      );

    this.#store.update({
      phase: 'ready',
      message: null,
      source,
      track,
      blobs,
      conflicts: session.conflicts(),
      edits: session.state(),
      midi: session.midi(),
      mappingReport: null,
      guideOverlaps: session.guideOverlaps(),
      drift: session.drift(),
      selection: { blobs: [], anchors: [], range: null },
      view: { ...framed, playhead: 0 },
      transport: { ...this.#store.state.transport, playing: false, position: 0, loop: null },
      analysis: { running: false, progress: 1, stage: '' },
      dirty: false,
    });

    this.#startAutosave();
    void this.#cacheMedia(source.fingerprint, mono);
  }

  #startAutosave(): void {
    const projects = this.#projects;
    const id = this.#projectId;
    if (!projects || id === null) return;
    this.#autosave = new Autosave({
      store: projects,
      id,
      snapshot: () => this.#projectJson(),
      onStatus: (status) => {
        if (status.state === 'failed' && status.message !== null) this.#toast.error(status.message);
      },
    });
  }

  async #cacheMedia(fingerprint: string, mono: Float32Array): Promise<void> {
    const media = this.#media;
    if (!media) return;
    try {
      if (await media.has(fingerprint)) return;
      await media.write(fingerprint, mono);
    } catch {
      this.#toast.warn('Audio not cached. Reopening will decode again.');
    }
  }

  #projectJson(): string | null {
    const session = this.#session;
    if (!session) return null;
    try {
      return session.project(this.#name, this.#store.state.view);
    } catch (error) {
      this.#fail('Save Project', error);
      return null;
    }
  }

  /**
   * Re-reads the selected guide's overlapping notes into the store.
   *
   * @remarks Warns once per newly selected guide when `announce` is set; the overlaps are
   * reported to the user and never resolved for them.
   */
  #reportGuideOverlaps(announce: boolean): void {
    const session = this.#session;
    if (!session) return;
    let overlaps: GuideOverlap[];
    try {
      overlaps = session.guideOverlaps();
    } catch (error) {
      this.#fail('Read Guide', error);
      return;
    }
    this.#store.update({ guideOverlaps: overlaps });
    if (announce && overlaps.length > 0) {
      this.#toast.warn(
        `Guide has ${String(overlaps.length)} overlapping notes. Each note takes one blob at most.`,
      );
    }
  }

  #publish(): void {
    const session = this.#session;
    if (!session) return;
    try {
      const plan = session.plan();
      this.#plan = plan;
      this.#audio.setPlan(plan);
      const blobs = session.blobs();
      this.#store.update({
        blobs,
        conflicts: session.conflicts(),
        edits: session.state(),
        // An edit can split, join or replace blobs, so what the selected span amounts to is
        // worked out again rather than left naming blobs the edit may have just removed.
        selection: selectionForRange(blobs, this.#store.state.selection.range),
        dirty: true,
      });
    } catch (error) {
      this.#fail('Read Plan', error);
      return;
    }
    this.#autosave?.markDirty();
  }

  #progress(stage: string, progress: number): void {
    this.#store.update({
      phase: this.#session ? this.#store.state.phase : 'loading',
      analysis: { running: true, progress, stage },
    });
  }

  #idle(): void {
    this.#store.update({ analysis: { running: false, progress: 1, stage: '' } });
  }

  /**
   * Reports a failed operation.
   *
   * @remarks The toast carries the detail. With a project still open the phase stays `ready` and
   * no message is kept, because a status line pinned to one past failure goes on contradicting
   * the editor long after the thing it described stopped being true.
   */
  #fail(operation: string, error: unknown): void {
    const message = describe(error);
    this.#toast.error(`${operation} failed. ${message}`);
    const open = this.#session !== null;
    this.#store.update({
      phase: open ? 'ready' : 'error',
      message: open ? null : message,
      analysis: { running: false, progress: 0, stage: '' },
    });
  }
}

function lowestCentre(blobs: readonly { detectedCenter: number }[]): number {
  let low = Number.POSITIVE_INFINITY;
  for (const blob of blobs) {
    if (Number.isFinite(blob.detectedCenter)) low = Math.min(low, blob.detectedCenter);
  }
  return Number.isFinite(low) ? low : 48;
}

function highestCentre(blobs: readonly { detectedCenter: number }[]): number {
  let high = Number.NEGATIVE_INFINITY;
  for (const blob of blobs) {
    if (Number.isFinite(blob.detectedCenter)) high = Math.max(high, blob.detectedCenter);
  }
  return Number.isFinite(high) ? high : 72;
}

/**
 * Reads one axis of the plan's time map against the other.
 *
 * @remarks The map is ascending in both columns, so the same piecewise-linear walk converts
 * either way; `from` and `to` pick which column is searched.
 */
function mapTime(plan: RenderPlan | null, value: number, from: 0 | 1, to: 0 | 1): number {
  const points = plan?.timeMap.points;
  if (!points || points.length < 2) return value;
  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (!point) break;
    if (point[from] <= value) low = middle;
    else high = middle;
  }
  const first = points[low];
  const second = points[high];
  if (!first || !second) return value;
  const span = second[from] - first[from];
  if (!(span > 0)) return first[to];
  return first[to] + ((value - first[from]) / span) * (second[to] - first[to]);
}

function toBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/** Whether a save can hand back a file to write to again without asking. */
function hasHandleSupport(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

function describe(error: unknown): string {
  if (error instanceof AxysError || error instanceof PersistenceError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'the reason was not reported';
}

/**
 * The menu shown over the editor.
 *
 * @remarks Every entry runs a command, so the menu, the toolbar and the keyboard cannot drift
 * apart, and each item carries the key that runs it while the menu is open. Over open canvas the
 * blob entries are shown disabled rather than removed, so the menu keeps its shape.
 */
function blobMenu(onBlob: boolean, hooks: ShellHooks): MenuEntry[] {
  const item = (id: string, label: string, key: string, needsBlob = true): MenuEntry => ({
    label,
    key,
    enabled: (!needsBlob || onBlob) && hooks.isCommandEnabled(id),
    run: () => {
      hooks.runCommand(id);
    },
  });
  return [
    item('edit.reset', 'Reset To Origin', 'r'),
    item('edit.splitBlob', 'Split Blob', 's'),
    item('edit.joinBlobs', 'Join Blobs', 'j'),
    { separator: true },
    item('edit.bypassBlob', 'Bypass Blob', 'b'),
    item('edit.excludeBlob', 'Exclude Blob', 'x'),
    { separator: true },
    item('transport.loopSelection', 'Loop Selection', 'l', false),
    item('file.exportWav', 'Export Audio', 'e', false),
  ];
}

/** Which import a dropped file is, from its name and media type. */
function kindOf(file: File): 'project' | 'midi' | 'audio' {
  const name = file.name.toLowerCase();
  if (name.endsWith('.axys.json') || name.endsWith('.json')) return 'project';
  if (name.endsWith('.mid') || name.endsWith('.midi') || file.type === 'audio/midi') return 'midi';
  return 'audio';
}

/** Accepts audio, MIDI and project files dropped anywhere on the window. */
function bindDragAndDrop(
  target: Window,
  workspace: AxysWorkspace,
  toast: ToastHost,
  shell: AppShell,
): () => void {
  // Counted rather than toggled: dragging across a child element fires a leave before the
  // matching enter, so a boolean flickers the marker off under the cursor.
  let depth = 0;
  const show = (event: DragEvent): void => {
    const item = event.dataTransfer?.items[0];
    shell.setDropTarget(item?.kind === 'file' ? 'Audio, MIDI Or Project' : 'File');
  };
  const onDragEnter = (event: DragEvent): void => {
    if (!event.dataTransfer) return;
    depth += 1;
    show(event);
  };
  const onDragOver = (event: DragEvent): void => {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) shell.setDropTarget(null);
  };
  const onDrop = (event: DragEvent): void => {
    depth = 0;
    shell.setDropTarget(null);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    void openDropped([...files], workspace, toast);
  };
  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragenter', onDragEnter);
    target.removeEventListener('dragover', onDragOver);
    target.removeEventListener('dragleave', onDragLeave);
    target.removeEventListener('drop', onDrop);
  };
}

async function openDropped(
  files: File[],
  workspace: AxysWorkspace,
  toast: ToastHost,
): Promise<void> {
  const project = files.find((file) => kindOf(file) === 'project');
  const audio = files.find((file) => kindOf(file) === 'audio');
  const midi = files.find((file) => kindOf(file) === 'midi');
  if (project) await workspace.openProjectFile(project);
  else if (audio) await workspace.openAudioFile(audio);
  if (midi) {
    if (!project && !audio && !workspace.ready) {
      toast.warn('Open a vocal before a MIDI guide.');
      return;
    }
    await workspace.openMidiFile(midi);
  }
}

/**
 * Takes down the loading splash the document paints before the module graph arrives.
 *
 * @remarks Safe to call more than once, and on every exit from startup including the failure
 * ones, so a browser that cannot run Axys is never left looking at a loading bar.
 */
function dismissSplash(): void {
  document.getElementById('axys-splash')?.remove();
}

/** Replaces the page with a plain explanation when a required capability is missing. */
function showUnsupported(mount: HTMLElement, caps: Capability[]): void {
  mount.textContent = '';
  const section = document.createElement('section');
  section.className = 'axys-unsupported';

  const heading = document.createElement('h1');
  heading.textContent = 'Unsupported Browser';
  section.append(heading);

  const lead = document.createElement('p');
  lead.textContent = 'Axys needs these capabilities and this browser does not provide them.';
  section.append(lead);

  const list = document.createElement('ul');
  for (const cap of caps) {
    if (!cap.required || cap.available) continue;
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = cap.label;
    item.append(name, document.createTextNode(` — ${cap.detail}`));
    list.append(item);
  }
  section.append(list);

  const tail = document.createElement('p');
  tail.textContent = 'A current desktop Chrome, Edge, Firefox or Safari over HTTPS will run Axys.';
  section.append(tail);

  mount.append(section);
}

/** Replaces the page when the core itself will not load, which leaves nothing to run. */
function showFailure(mount: HTMLElement, message: string): void {
  mount.textContent = '';
  const section = document.createElement('section');
  section.className = 'axys-unsupported';
  const heading = document.createElement('h1');
  heading.textContent = 'Load Failed';
  const detail = document.createElement('p');
  detail.textContent = message;
  section.append(heading, detail);
  mount.append(section);
}

/** Tells the user once, on first run, which optional capabilities are missing here. */
function noteDegradedCapabilities(caps: Capability[], toast: ToastHost): void {
  const missing = caps.filter((cap) => !cap.required && !cap.available);
  if (missing.length === 0) return;
  let seen = false;
  try {
    seen = localStorage.getItem(DEGRADED_NOTICE_KEY) !== null;
  } catch {
    seen = false;
  }
  if (seen) return;
  try {
    localStorage.setItem(DEGRADED_NOTICE_KEY, '1');
  } catch {
    // A browser that refuses storage shows the notice again next time, which is harmless.
  }
  const names = missing.map((cap) => cap.label).join(', ');
  toast.warn(`Reduced mode: ${names} unavailable. See Help And Diagnostics.`);
}

/** Resolves with the opened store, or `null` when this browser will not provide it. */
async function openStore<T>(opening: Promise<T>): Promise<T | null> {
  try {
    return await opening;
  } catch {
    return null;
  }
}

/** Reopens the most recently saved project, when one is stored. */
async function restoreLastProject(
  workspace: AxysWorkspace,
  projects: ProjectStore | null,
): Promise<void> {
  if (!projects) return;
  try {
    const newest = (await projects.list())[0];
    if (!newest) return;
    await workspace.openProjectJson(await projects.load(newest.id));
  } catch {
    // Nothing recoverable is stored; the editor opens empty, which is the normal first run.
  }
}

/** Keeps the editor playhead in step with the audio engine, playing or seeking. */
function startPlayheadLoop(
  store: AppStore,
  audio: AudioEngine,
  workspace: AxysWorkspace,
): () => void {
  let running = true;
  const frame = (): void => {
    if (!running) return;
    const state = store.state;
    const output = audio.position;
    const playhead = workspace.sourceAt(output);
    const movedPlayhead = Math.abs(playhead - state.view.playhead) > PLAYHEAD_EPSILON;
    const movedTransport =
      Math.abs(output - state.transport.position) > PLAYHEAD_EPSILON ||
      audio.playing !== state.transport.playing;
    const view = movedPlayhead ? { ...state.view, playhead } : state.view;
    const followed =
      state.follow && audio.playing ? followView(view, playhead, state.followMode) : null;
    if (movedPlayhead || movedTransport || followed !== null) {
      store.update({
        ...(movedPlayhead || followed !== null ? { view: followed ?? view } : {}),
        ...(movedTransport
          ? { transport: { ...state.transport, position: output, playing: audio.playing } }
          : {}),
      });
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => {
    running = false;
  };
}

/**
 * Shows the audio engine's own status wherever it affects the user.
 *
 * @remarks The engine reports through its own subscription rather than the store, and its
 * underrun count rises without a status change, so it is polled on {@link UNDERRUN_INTERVAL_MS}.
 * That interval is also the shortest gap between underrun warnings.
 */
function watchEngine(audio: AudioEngine, shell: AppShell, toast: ToastHost): () => void {
  let reportedFailure: string | null = null;
  let seenUnderruns = audio.report.underruns;

  const show = (report: EngineReport): void => {
    shell.setEngineReport(report);
    if (report.status === 'failed') {
      const message = report.message ?? 'Playback failed and the browser gave no reason.';
      if (message !== reportedFailure) toast.error(message);
      reportedFailure = message;
      return;
    }
    reportedFailure = null;
  };

  show(audio.report);
  const release = audio.subscribe(show);
  const timer = window.setInterval(() => {
    const report = audio.report;
    if (report.underruns <= seenUnderruns) return;
    const missed = report.underruns - seenUnderruns;
    seenUnderruns = report.underruns;
    shell.setEngineReport(report);
    toast.warn(`Dropped ${String(missed)} audio blocks. Close other heavy tabs.`);
  }, UNDERRUN_INTERVAL_MS);

  return () => {
    release();
    window.clearInterval(timer);
  };
}

/** The theme a choice paints as, which for `system` is whatever the device currently asks for. */
function resolvedTheme(choice: ThemeChoice): ThemeName {
  return choice === 'system' ? preferredTheme() : choice;
}

/**
 * Repaints as the system preference changes, while the theme choice is to follow it.
 *
 * @remarks Returns a disposer. A fixed choice needs no watcher, so this returns an empty one.
 */
function watchSystemTheme(choice: ThemeChoice, redraw: () => void): () => void {
  if (choice !== 'system') return () => {};
  return watchPreferredTheme((name) => {
    applyTheme(name);
    redraw();
  });
}

/** Turns shell intent into command runs, edits and view changes. */
function buildHooks(
  store: AppStore,
  commands: Command[],
  context: () => CommandContext | null,
  workspace: () => AxysWorkspace | null,
  audio: AudioEngine,
  redraw: () => void,
  onThemeChoice: (choice: ThemeChoice) => void,
): ShellHooks {
  return {
    runCommand(id: string): void {
      const ctx = context();
      const command = ctx ? findCommand(commands, id) : undefined;
      if (!ctx || !command || !command.enabled(ctx)) return;
      void command.run(ctx);
    },
    isCommandEnabled(id: string): boolean {
      const ctx = context();
      const command = findCommand(commands, id);
      return ctx !== null && command !== undefined && command.enabled(ctx);
    },
    applyEdit(op: EditOp): void {
      workspace()?.apply(op);
    },
    setView(patch: Partial<ViewState>): void {
      // How time reads is a display habit that follows the person between projects, so it is
      // remembered on the device as well as in the project it was set from.
      if (patch.timeDisplay !== undefined) savePreferences({ timeDisplay: patch.timeDisplay });
      store.update({ view: { ...store.state.view, ...patch } });
    },
    setFollowMode(mode: FollowMode): void {
      savePreferences({ followMode: mode });
      store.update({ followMode: mode });
    },
    setSpan(seconds: number): void {
      const view = store.state.view;
      const centre = (view.visibleStart + view.visibleEnd) / 2;
      const span = Math.min(Math.max(seconds, MIN_TIME_SPAN), MAX_TIME_SPAN);
      store.update({
        view: { ...view, visibleStart: centre - span / 2, visibleEnd: centre + span / 2 },
      });
    },
    setTool(tool: ToolId): void {
      store.update({ tool });
    },
    setCompare(mode: CompareMode): void {
      audio.setCompare(mode);
    },
    setTuning(a4Hz: number): void {
      workspace()?.setTuning(a4Hz);
    },
    setAccidentals(style: AccidentalStyle): void {
      workspace()?.setAccidentals(style);
    },
    setTheme(choice: ThemeChoice): void {
      savePreferences({ theme: choice });
      applyTheme(resolvedTheme(choice));
      onThemeChoice(choice);
      // The canvas resolves its colours as it draws, and a theme change alone schedules no
      // frame, so the chrome would recolour while the editor kept the old palette until the
      // next unrelated redraw.
      redraw();
    },
  };
}

async function start(): Promise<void> {
  const mount = document.querySelector<HTMLElement>('#app') ?? document.body;

  const caps = await probeCapabilities();
  if (!isSupported(caps)) {
    dismissSplash();
    showUnsupported(mount, caps);
    return;
  }

  let core: AxysCore;
  try {
    core = await loadCore();
  } catch (error) {
    dismissSplash();
    showFailure(mount, describe(error));
    return;
  }

  const preferences = loadPreferences();
  applyTheme(resolvedTheme(preferences.theme));

  const store = new AppStore(initialState());
  store.update({
    followMode: preferences.followMode,
    view: { ...store.state.view, timeDisplay: preferences.timeDisplay },
  });
  const commands = buildCommands();
  let context: CommandContext | null = null;

  const audio = await AudioEngine.create(store);
  const projectsPromise = openStore(ProjectStore.open());
  const mediaPromise = openStore(MediaStore.open());

  let workspace: AxysWorkspace | null = null;
  let renderer: EditorRenderer | null = null;
  let releaseSystemTheme = (): void => {};
  const redraw = (): void => {
    renderer?.invalidate();
  };
  const hooks = buildHooks(
    store,
    commands,
    () => context,
    () => workspace,
    audio,
    redraw,
    (choice) => {
      releaseSystemTheme();
      releaseSystemTheme = watchSystemTheme(choice, redraw);
    },
  );
  const shell = AppShell.mount({ root: mount, commands, hooks, theme: preferences.theme });
  releaseSystemTheme = watchSystemTheme(preferences.theme, redraw);
  const toast = shell.toasts;
  shell.setCapabilities(caps);

  const projects = await projectsPromise;
  const media = await mediaPromise;
  if (!projects) {
    toast.warn('This browser cannot store projects. Export before closing the tab.');
  }
  if (!media) {
    toast.warn('Audio cannot be cached here. Reopening will ask for the file.');
  }

  workspace = new AxysWorkspace({ core, store, audio, toast, projects, media });
  renderer = new EditorRenderer(shell.canvas);
  const editor = new EditorController({
    canvas: shell.canvas,
    store,
    renderer,
    apply: (op: EditOp) => {
      workspace?.apply(op);
    },
    audition: (start: number, end: number) => {
      audio.audition(start, end);
    },
    seek: (seconds: number) => {
      audio.seek(seconds);
    },
    announce: (message: string) => {
      shell.announce(message);
    },
    contextMenu: (hit, at) => {
      showContextMenu(blobMenu(hit.blob !== null, hooks), at);
    },
  });
  context = { store, editor, audio, toast, workspace };

  dismissSplash();

  const releaseEngine = watchEngine(audio, shell, toast);
  const releaseStore = store.subscribe((state) => {
    shell.update(state);
  });
  shell.update(store.state);

  const releaseShortcuts = bindShortcuts(window, commands, context);
  const releaseDrop = bindDragAndDrop(window, workspace, toast, shell);
  const stopPlayhead = startPlayheadLoop(store, audio, workspace);

  const onUnload = (event: BeforeUnloadEvent): void => {
    if (store.state.dirty) event.preventDefault();
  };
  window.addEventListener('beforeunload', onUnload);

  const open = workspace;
  window.addEventListener(
    'pagehide',
    () => {
      window.removeEventListener('beforeunload', onUnload);
      releaseShortcuts();
      releaseDrop();
      releaseStore();
      releaseEngine();
      releaseSystemTheme();
      stopPlayhead();
      open.dispose();
      editor.dispose();
      renderer?.dispose();
      audio.dispose();
      shell.dispose();
    },
    { once: true },
  );

  await restoreLastProject(workspace, projects);
  noteDegradedCapabilities(caps, toast);
}

await start();
