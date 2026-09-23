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
import { startOffline } from './app/offline.js';
import { bindShortcuts } from './app/shortcuts.js';
import { clampInspectorWidth, loadPreferences, savePreferences } from './app/preferences.js';
import type { ThemeChoice } from './app/preferences.js';
import { emptySelection, selectionForRanges } from './app/selection.js';
import { AppStore, initialState } from './app/store.js';
import type { AppState, FollowMode, ToolId } from './app/store.js';
import { decodeAudioFile, fingerprintOf, mixToMono } from './audio/decode.js';
import { referencePeaksKey } from './editor/layers/references.js';
import { AudioEngine } from './audio/engine.js';
import type { EngineReport, MeterReport } from './audio/engine.js';
import { browserLabel } from './browser.js';
import { isSupported, probeCapabilities } from './capabilities.js';
import type { Capability } from './capabilities.js';
import { isViewState } from './core/json.js';
import { AxysError, loadCore } from './core/wasm.js';
import type { AxysCore, Session } from './core/wasm.js';
import { sourceTitle } from './core/types.js';
import type {
  AccidentalStyle,
  ClipId,
  EditOp,
  EditState,
  ExportPreview,
  GuideOverlap,
  MappingProposal,
  MixerSettings,
  Reference,
  ReferenceId,
  RenderPlan,
  SourceInfo,
  ViewState,
} from './core/types.js';
import { EditorController } from './editor/interaction.js';
import { freePosition } from './editor/tools.js';
import type { PendingClip } from './editor/tools.js';
import { buildPeaks, clearPeaks } from './editor/peaks.js';
import { EditorRenderer } from './editor/renderer.js';
import { fitView, followView, MAX_TIME_SPAN, MIN_TIME_SPAN } from './editor/view.js';
import { Autosave } from './persistence/autosave.js';
import { PersistenceError, ProjectStore } from './persistence/db.js';
import { MediaStore } from './persistence/opfs.js';
import {
  EXPORT_KIND,
  IMPORTABLE,
  openFile,
  OPENABLE,
  PROJECT_KIND,
  saveFileAs,
  writeFile,
} from './persistence/file-access.js';
import type { FileHandle } from './persistence/file-access.js';
import { importProject } from './persistence/project-io.js';
import { restoreNewest } from './persistence/restore.js';
import type { ExportChoice, ExportRange } from './ui/export-dialog.js';
import { confirm as confirmAction } from './ui/dialog.js';
import { showContextMenu } from './ui/menu.js';
import type { MenuEntry } from './ui/menu.js';
import type { IconName } from './ui/icons.js';
import { AppShell } from './ui/shell.js';
import type { ShellHooks } from './ui/shell.js';
import type { AccentName } from './ui/accent.js';
import { applyTheme, preferredTheme, watchPreferredTheme } from './ui/theme.js';
import type { ThemeName } from './ui/theme.js';
import type { ToastHost } from './ui/toast.js';
import { AnalysisClient, RenderClient } from './workers/client.js';
import { WorkerCancelled } from './workers/protocol.js';

/** Pitch margin above and below the content the first view frames, in semitones. */
const FIT_MARGIN = 3;

/**
 * Local record of which stored project is open, so a reload reopens it.
 *
 * @remarks An empty string records that nothing is open, so a reload after New Project stays
 * empty. With no record at all the newest stored project reopens.
 */
const OPEN_PROJECT_KEY = 'axys.project.open';

/** How many projects keep a recovery copy on the device; older ones are deleted. */
const RECOVERY_COPIES = 8;

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

/**
 * Media a reopened project still needs from the user.
 *
 * @remarks The project opens and edits without them; a clip plays and exports once its audio is
 * relinked, and a reference once its own is.
 */
interface MissingMedia {
  clips: { clip: ClipId; source: SourceInfo }[];
  references: Reference[];
}

/** A fresh id for a project's recovery copy, never shared with another project. */
function newProjectId(): string {
  return `project-${crypto.randomUUID()}`;
}

/** Which stored project was open, `''` when none was, or `null` when nothing is recorded. */
function openProjectRecord(): string | null {
  try {
    return localStorage.getItem(OPEN_PROJECT_KEY);
  } catch {
    return null;
  }
}

function recordOpenProject(id: string): void {
  try {
    localStorage.setItem(OPEN_PROJECT_KEY, id);
  } catch {
    // A browser that refuses storage reopens the newest project instead, which is close enough.
  }
}

/** Key a reference's channels are cached under, apart from any clip made from the same file. */
function referenceKey(fingerprint: string): string {
  return `${fingerprint}-reference`;
}

/**
 * The session-backed half of the application.
 *
 * @remarks Owns the one open {@link Session}. Every edit path ends in {@link AxysWorkspace.apply}
 * or one of the file operations, each of which republishes the compiled plans to the audio engine
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
  #projectId: string | null = null;
  #autosave: Autosave | null = null;
  #missing: MissingMedia = { clips: [], references: [] };
  /** Each reference's channels at the project rate, kept so the engine can be handed copies. */
  readonly #references = new Map<ReferenceId, Float32Array[]>();
  #importing = false;
  /** Whether an open operation has a group applied that Apply keeps and Discard takes back. */
  #previewing = false;
  /** Where Save Project last wrote, so a later save needs no picker. */
  #projectFile: FileHandle | null = null;
  #onPending: ((clip: PendingClip | null) => void) | null = null;
  /** Media writes to the device still running. */
  #writes = 0;

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
    return this.#store.state.projectName ?? 'Untitled';
  }

  get importing(): boolean {
    return this.#importing;
  }

  /**
   * Closes what is open and returns the editor to an empty project.
   *
   * @remarks Asks before discarding unsaved work, the same question Open asks, and offers to
   * save first. The device's own settings are left alone: how the editor is laid out is not
   * part of the project being closed.
   */
  async newProject(): Promise<void> {
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    if (!(await this.#mayReplaceProject('Starting a new project', 'Discard and Start'))) return;
    this.#close();
    this.#projectFile = null;
    recordOpenProject('');

    const fresh = initialState();
    const view = this.#store.state.view;
    this.#store.update({
      phase: 'empty',
      message: null,
      projectName: null,
      track: null,
      blobs: [],
      conflicts: [],
      edits: null,
      plan: null,
      // How time reads and what edits snap to follow the person, not the project that closed.
      view: { ...fresh.view, timeDisplay: view.timeDisplay, snapDivision: view.snapDivision },
      midi: null,
      mappingReport: null,
      guideOverlaps: [],
      drift: null,
      selection: emptySelection(),
      transport: fresh.transport,
      analysis: fresh.analysis,
      dirty: false,
    });
  }

  /** Lets go of the session, its media and its autosave. */
  #close(): void {
    this.#autosave?.dispose();
    this.#autosave = null;
    this.#session?.free();
    this.#session = null;
    this.#missing = { clips: [], references: [] };
    this.#references.clear();
    this.#plan = null;
    this.#projectId = null;
    clearPeaks();
    this.#audio.unloadSource();
  }

  /**
   * Opens whatever the user picked, routed by what the file turned out to be.
   *
   * @remarks One picker rather than three commands. A project opened from disk also remembers
   * where it came from, so the first Save on it needs no dialog either.
   */
  async openAny(): Promise<void> {
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    if (!(await this.#mayReplaceProject())) return;
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

  get previewing(): boolean {
    return this.#previewing;
  }

  /**
   * Applies an operation's edits in place of the ones it applied last.
   *
   * @remarks One group, so however many operations an update carries it is one entry to unwind.
   * Dragging a slider therefore leaves the history with one entry rather than one per frame, and
   * discarding leaves it as it was.
   */
  previewEdits(ops: readonly EditOp[]): void {
    const session = this.#session;
    if (!session) return;
    try {
      if (this.#previewing) session.undo();
      if (ops.length > 0) {
        session.applyEdit({ type: 'group', ops: [...ops] });
        this.#previewing = true;
      } else {
        this.#previewing = false;
      }
    } catch (error) {
      this.#previewing = false;
      this.#fail('Apply Edit', error);
      return;
    }
    this.#publish();
  }

  commitPreview(): void {
    this.#previewing = false;
  }

  discardPreview(): void {
    if (!this.#previewing) return;
    this.#previewing = false;
    const session = this.#session;
    if (!session) return;
    try {
      session.undo();
    } catch (error) {
      this.#fail('Undo', error);
      return;
    }
    this.#publish();
  }

  apply(op: EditOp): void {
    const session = this.#session;
    if (!session) return;
    // An edit made elsewhere lands on top of an open operation, so what the operation was
    // previewing is kept rather than unwound out from under the edit that followed it.
    this.commitPreview();
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
    if (op.type === 'setMappings' || op.type === 'setMapping') {
      this.#store.update({ drift: session.drift() });
    }
  }

  undo(): boolean {
    const session = this.#session;
    if (!session) return false;
    let undone: boolean;
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
    let redone: boolean;
    try {
      redone = session.redo();
    } catch (error) {
      this.#fail('Redo', error);
      return false;
    }
    if (redone) this.#publish();
    return redone;
  }

  /**
   * Starts a project from one audio file, replacing whatever is open.
   *
   * @remarks A project still waiting for audio it was made from takes the file as a relink
   * instead, because that is what it asked for.
   */
  async openAudioFile(file: File, ask = false): Promise<void> {
    if (this.#hasMissing()) {
      await this.#relink(file);
      return;
    }
    if (ask && !(await this.#mayReplaceProject())) return;
    // One import at a time. A second would race the first onto the same session and leave
    // whichever finished last in charge, which is not a choice anybody made.
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    this.#progress('Decode Audio', 0.05);
    this.#importing = true;
    try {
      const decoded = await decodeAudioFile(file);
      const analysed = await this.#analyse(decoded.mono, decoded.sampleRate, decoded.name);
      const session = this.#core.openSessionFromAnalysis({
        samples: analysed.samples,
        sampleRate: analysed.sampleRate,
        name: analysed.name,
        trackJson: analysed.trackJson,
        blobsJson: analysed.blobsJson,
      });
      this.#close();
      await this.#install(session, null, null);
      if (decoded.resampled) {
        this.#toast.warn(`Decoded at ${String(decoded.sampleRate)} Hz, not the file's own rate.`);
      }
    } catch (error) {
      this.#importFailed('Open Audio', error);
    } finally {
      this.#importing = false;
    }
  }

  /**
   * Puts another vocal on the lane as one undoable edit, or starts a project with it.
   *
   * @remarks `position` is project seconds, and defaults to the end of the lane so a take
   * stitches onto the one before it. A position that would overlap a clip lands on the nearest
   * free one. The audio is decoded at the project's rate, because every clip is held at one.
   * The decoded waveform is shown where the clip lands while it is analysed, and the view moves
   * to it when it lands out of sight.
   */
  async importClipFile(file: File, position?: number): Promise<void> {
    const session = this.#session;
    if (!session) {
      await this.openAudioFile(file);
      return;
    }
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    this.#progress('Decode Audio', 0.05);
    this.#importing = true;
    try {
      const rate = session.sampleRate();
      const decoded = await decodeAudioFile(file, rate);
      const edits = this.#store.state.edits;
      const at = freePosition(
        (edits?.clips ?? []).map((clip): [number, number] => [
          clip.position,
          clip.position + clip.source.duration,
        ]),
        decoded.duration,
        position ?? laneEnd(this.#store.state),
      );
      buildPeaks(decoded.mono, rate, decoded.fingerprint);
      this.#onPending?.({
        position: at,
        duration: decoded.duration,
        fingerprint: decoded.fingerprint,
        title: sourceTitle(file.name),
      });
      this.#reveal(at, at + decoded.duration);
      const analysed = await this.#analyse(decoded.mono, rate, decoded.name);
      const clip = session.addClip({
        samples: analysed.samples,
        name: analysed.name,
        trackJson: analysed.trackJson,
        blobsJson: analysed.blobsJson,
        position: at,
      });
      buildPeaks(analysed.samples, rate, fingerprintOf(analysed.samples));
      this.#audio.loadClip(clip, session.clipSamples(clip), session.clipTrackJson(clip), null);
      this.#idle();
      this.#publish();
      const placed = session.state().clips.find((entry) => entry.id === clip);
      if (placed) this.#reveal(placed.position, placed.position + placed.source.duration);
      void this.#cacheMedia(fingerprintOf(analysed.samples), analysed.samples);
      this.#toast.info(`Imported ${sourceTitle(file.name)}`);
    } catch (error) {
      this.#importFailed('Import Vocal', error);
    } finally {
      this.#onPending?.(null);
      this.#importing = false;
    }
  }

  /** Shows a clip being imported where it will land, or takes it away with `null`. */
  set onPending(listener: ((clip: PendingClip | null) => void) | null) {
    this.#onPending = listener;
  }

  /**
   * Moves the view to frame the whole lane when a span of it is out of sight.
   *
   * @remarks `start` and `end` are project seconds. A span already on screen leaves the view
   * alone, so importing beside what is being worked on does not jump it.
   */
  #reveal(start: number, end: number): void {
    const state = this.#store.state;
    const view = state.view;
    if (start >= view.visibleStart && end <= view.visibleEnd) return;
    const blobs = state.blobs;
    const framed = fitView(
      view,
      0,
      Math.max(laneEnd(state), end, 1),
      lowestCentre(blobs) - FIT_MARGIN,
      highestCentre(blobs) + FIT_MARGIN,
    );
    this.#store.update({ view: { ...framed, playhead: view.playhead } });
  }

  /**
   * Takes audio dropped on an open project: a relink when the project is waiting for it, and
   * otherwise a vocal or a reference, whichever the user answers.
   *
   * @remarks One question for everything dropped at once. The first file goes at `position`,
   * and each after it follows the one before.
   */
  async dropAudio(files: readonly File[], position: number | null): Promise<void> {
    if (this.#hasMissing()) {
      for (const file of files) await this.#relink(file);
      return;
    }
    const role = await this.#askRole(files);
    if (role === null) return;
    for (const [index, file] of files.entries()) {
      const at = index === 0 ? (position ?? undefined) : undefined;
      if (role === 'vocal') await this.importClipFile(file, at);
      else await this.importReferenceFile(file, at ?? 0);
    }
  }

  /**
   * Asks for a file and imports it, routed by what it turns out to be.
   *
   * @remarks MIDI is always the guide, and audio with nothing open always starts a project as
   * the vocal. Only audio on an open project is asked about.
   */
  async importAny(): Promise<void> {
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    let picked;
    try {
      picked = await openFile(IMPORTABLE);
    } catch (error) {
      this.#fail('Import', error);
      return;
    }
    if (picked === null) return;
    const file = picked.file;
    switch (kindOf(file)) {
      case 'project':
        await this.openProjectFile(file, true);
        return;
      case 'midi':
        await this.openMidiFile(file);
        return;
      default:
        if (!this.#session) {
          await this.openAudioFile(file);
          return;
        }
        await this.dropAudio([file], null);
    }
  }

  /** Asks whether audio is a vocal to edit or a reference to hear. `null` when cancelled. */
  async #askRole(files: readonly File[]): Promise<'vocal' | 'reference' | null> {
    const first = files[0];
    if (first === undefined) return null;
    const what =
      files.length === 1 ? sourceTitle(first.name) : `${String(files.length)} audio files`;
    const answer = await confirmAction({
      title: 'Import Audio',
      message: `Import ${what} as a vocal to edit, or as a reference to hear beside it.`,
      confirm: 'Import Vocal',
      alternative: 'Import Reference',
      icon: 'import',
      kind: 'primary',
    });
    if (answer === 'cancel') return null;
    return answer === 'confirm' ? 'vocal' : 'reference';
  }

  /**
   * Brings in audio to hear beside the vocal, as one undoable edit.
   *
   * @remarks A reference is decoded at the project rate and kept in stereo, and is heard as it
   * is: never analysed and never warped. An export includes it only when asked to.
   */
  async importReferenceFile(file: File, position = 0): Promise<void> {
    const session = this.#session;
    if (!session) {
      this.#toast.warn('Open a vocal before a reference');
      return;
    }
    if (this.#importing) {
      this.#toast.warn('An import is already running');
      return;
    }
    this.#progress('Decode Audio', 0.1);
    this.#importing = true;
    try {
      const rate = session.sampleRate();
      const decoded = await decodeAudioFile(file, rate);
      const channels = stereoOf(decoded.channelData);
      const source: SourceInfo = {
        name: decoded.name,
        sampleRate: decoded.sampleRate,
        channels: channels.length,
        frames: decoded.frames,
        duration: decoded.duration,
        fingerprint: decoded.fingerprint,
        mime: decoded.mime,
      };
      const reference = session.addReference(source, position);
      this.#keepReference(reference, source, channels);
      this.#audio.loadReference(
        reference,
        channels.map((channel) => channel.slice()),
        position,
      );
      this.#idle();
      this.#publish();
      this.#reveal(position, position + decoded.duration);
      void this.#cacheReference(source, channels);
      this.#toast.info(`Imported ${sourceTitle(file.name)} as a reference`);
    } catch (error) {
      this.#fail('Import Reference', error);
    } finally {
      this.#importing = false;
    }
  }

  /**
   * Keeps a reference's channels for the engine and for an export, and its waveform for the
   * reference lane.
   */
  #keepReference(id: ReferenceId, source: SourceInfo, channels: Float32Array[]): void {
    this.#references.set(id, channels);
    this.#session?.attachReference(id, channels);
    const frames = channels[0]?.length ?? 0;
    buildPeaks(
      mixToMono(channels, frames),
      source.sampleRate,
      referencePeaksKey(source.fingerprint),
    );
  }

  /** Runs the analysis worker over mono audio, reporting its stages as import progress. */
  async #analyse(
    samples: Float32Array,
    sampleRate: number,
    name: string,
  ): Promise<{
    samples: Float32Array;
    sampleRate: number;
    name: string;
    trackJson: string;
    blobsJson: string;
  }> {
    return await this.#analysis.analyse({ samples, sampleRate, name }, (stage, progress) => {
      this.#progress(stage, progress);
    });
  }

  #importFailed(operation: string, error: unknown): void {
    if (error instanceof WorkerCancelled) {
      this.#idle();
      this.#store.update({ phase: this.#session ? 'ready' : 'empty', message: null });
      this.#toast.info('Import cancelled');
    } else {
      this.#fail(operation, error);
    }
  }

  cancelImport(): void {
    if (!this.#importing) return;
    this.#analysis.cancel();
  }

  /**
   * Whether opening something else may replace what is open.
   *
   * @remarks Opening, and starting again, replace the whole project, so unsaved work would go
   * without a word. The question offers to save first, because that is what someone who did not
   * mean to discard it wants next, and it names what is about to happen.
   */
  async #mayReplaceProject(
    what = 'Opening something else',
    confirm = 'Discard and Open',
  ): Promise<boolean> {
    if (!this.#session || !this.#store.state.dirty) return true;
    const answer = await confirmAction({
      title: 'Unsaved Changes',
      message: `${this.projectName} has edits that are not saved. ${what} discards them.`,
      confirm,
      alternative: 'Save First',
      icon: 'warning',
    });
    if (answer === 'cancel') return false;
    if (answer === 'alternative') {
      await this.saveProject();
      // A save that was cancelled or failed leaves the work unsaved, so it is not discarded.
      return !this.#store.state.dirty;
    }
    return true;
  }

  async openMidiFile(file: File): Promise<void> {
    const session = this.#session;
    if (!session) {
      this.#toast.warn('Open a vocal before a MIDI guide');
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

  async openProjectFile(file: File, ask = false): Promise<void> {
    if (ask && !(await this.#mayReplaceProject())) return;
    try {
      const imported = await importProject(file, (json) => this.#core.readProject(json));
      await this.#openProject(imported.json, null);
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  /** Opens a project document already held on this device. */
  async openProjectJson(json: string): Promise<void> {
    try {
      await this.#openProject(this.#core.readProject(json).json, null);
    } catch (error) {
      this.#fail('Open Project', error);
    }
  }

  /**
   * Opens a recovery copy, reporting rather than announcing a document it cannot read.
   *
   * @remarks Startup restore is not an action the user took, so a copy written by a build whose
   * project contract has since changed leaves the editor empty rather than showing a failure over
   * an empty canvas. The caller decides what becomes of the copy. `id` is the copy's own, which
   * the project goes on saving to.
   */
  async restoreProjectJson(json: string, id: string): Promise<boolean> {
    try {
      await this.#openProject(this.#core.readProject(json).json, id);
      return true;
    } catch {
      this.#store.update({
        phase: 'empty',
        message: null,
        analysis: { running: false, progress: 0, stage: '' },
      });
      return false;
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
      this.#toast.error('Nothing to save');
      return;
    }
    try {
      const existing = this.#projectFile;
      if (!askWhere && existing !== null) {
        await writeFile(existing, json);
        this.#store.update({ dirty: false });
        this.#toast.info(`Saved ${existing.name}`);
      } else {
        const name = `${this.projectName}.axys.json`;
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

  exportPreview(range: ExportRange, withReferences: boolean): ExportPreview | null {
    const session = this.#session;
    if (!session) return null;
    try {
      return session.exportPreview(range, withReferences);
    } catch {
      return null;
    }
  }

  async exportWav(choice: ExportChoice): Promise<void> {
    const session = this.#session;
    const json = this.#projectJson();
    if (!session || json === null) {
      this.#toast.error('Nothing to export');
      return;
    }
    const unlinked = choice.withReferences ? this.#missing.references[0] : undefined;
    if (unlinked !== undefined) {
      this.#toast.error(`Relink ${unlinked.source.name} to export it with the vocal.`);
      return;
    }
    this.#progress('Export WAV', 0.02);
    try {
      const clips = session
        .media()
        .clips.filter((entry) => entry.attached)
        .map((entry) => ({ clip: entry.clip, samples: session.clipSamples(entry.clip) }));
      const references = choice.withReferences
        ? [...this.#references].map(([reference, channels]) => ({
            reference,
            channels: channels.map((channel) => channel.slice()),
          }))
        : [];
      const encoded = await this.#render.exportWav(
        {
          projectJson: json,
          clips,
          references,
          withReferences: choice.withReferences,
          range: choice.range,
          depth: choice.depth,
          sampleRate: choice.sampleRate,
        },
        (stage, progress) => {
          this.#progress(stage, progress);
        },
      );
      await saveFileAs(toBytes(encoded.bytes), `${this.projectName}.wav`, EXPORT_KIND, 'audio/wav');
      if (encoded.report.clippedSamples > 0) {
        this.#toast.warn(
          `Clipped ${String(encoded.report.clippedSamples)} samples. Lower the level and export again.`,
        );
      } else {
        this.#toast.info(
          `Exported ${this.projectName}.wav, peak ${encoded.report.peak.toFixed(2)}`,
        );
      }
    } catch (error) {
      this.#fail('Export WAV', error);
    } finally {
      this.#idle();
    }
  }

  proposeMappings(): MappingProposal | null {
    const session = this.#session;
    if (!session) return null;
    try {
      const proposal = session.proposeMappingsPreview();
      this.#store.update({ mappingReport: proposal.report });
      return proposal;
    } catch (error) {
      this.#fail('Align Guide', error);
      return null;
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

  /**
   * Opens a project document, attaching whatever audio this device already holds for it.
   *
   * @remarks A project whose audio is not all here still opens and edits. What is missing is
   * named, and the next audio file opened is checked against it. `id` is the recovery copy it
   * was restored from, or `null` for a project that gets a copy of its own.
   */
  async #openProject(json: string, id: string | null): Promise<void> {
    this.#progress('Open Project', 0.3);
    const session = this.#core.openSession(json);
    const references = new Map<ReferenceId, Float32Array[]>();
    const missing: MissingMedia = { clips: [], references: [] };
    const media = session.media();
    for (const entry of media.clips) {
      const samples = await this.#readMedia(entry.source.fingerprint);
      if (samples === null) {
        missing.clips.push({ clip: entry.clip, source: entry.source });
        continue;
      }
      try {
        session.attachClip(entry.clip, samples);
      } catch {
        missing.clips.push({ clip: entry.clip, source: entry.source });
      }
    }
    for (const reference of media.references) {
      const stored = await this.#readMedia(referenceKey(reference.source.fingerprint));
      if (stored === null) {
        missing.references.push(reference);
        continue;
      }
      references.set(reference.id, splitChannels(stored, reference.source.channels));
    }
    this.#close();
    for (const [id, channels] of references) this.#references.set(id, channels);
    this.#missing = missing;
    await this.#install(session, parseView(json), id);
    this.#askForMissing();
  }

  async #readMedia(key: string): Promise<Float32Array | null> {
    const media = this.#media;
    if (!media) return null;
    try {
      return await media.read(key);
    } catch {
      return null;
    }
  }

  #hasMissing(): boolean {
    return this.#missing.clips.length > 0 || this.#missing.references.length > 0;
  }

  /** Names the first piece of audio the open project is still waiting for. */
  #askForMissing(): void {
    const first = this.#missing.clips[0]?.source ?? this.#missing.references[0]?.source;
    if (first === undefined) return;
    const count = this.#missing.clips.length + this.#missing.references.length;
    this.#toast.warn(
      count === 1
        ? `Open ${first.name} to relink it.`
        : `Open ${first.name} to relink it. ${String(count)} files are missing.`,
    );
  }

  /**
   * Accepts a file as audio the open project is waiting for, when it is.
   *
   * @remarks Matched by fingerprint rather than by name, so a different file with the same name
   * is refused and a renamed copy of the right one is taken.
   */
  async #relink(file: File): Promise<void> {
    const session = this.#session;
    if (!session) return;
    this.#progress('Relink Audio', 0.2);
    try {
      const rate = session.sampleRate();
      const decoded = await decodeAudioFile(file, rate);
      const clip = this.#missing.clips.find(
        (entry) => entry.source.fingerprint === decoded.fingerprint,
      );
      const reference = this.#missing.references.find(
        (entry) => entry.source.fingerprint === decoded.fingerprint,
      );
      if (clip) {
        session.attachClip(clip.clip, decoded.mono);
        this.#missing.clips = this.#missing.clips.filter((entry) => entry !== clip);
        buildPeaks(decoded.mono, rate, decoded.fingerprint);
        this.#audio.loadClip(
          clip.clip,
          session.clipSamples(clip.clip),
          session.clipTrackJson(clip.clip),
          null,
        );
        void this.#cacheMedia(decoded.fingerprint, decoded.mono);
      } else if (reference) {
        const channels = stereoOf(decoded.channelData);
        this.#keepReference(reference.id, reference.source, channels);
        this.#missing.references = this.#missing.references.filter((entry) => entry !== reference);
        this.#audio.loadReference(
          reference.id,
          channels.map((channel) => channel.slice()),
          reference.position,
        );
        void this.#cacheReference(reference.source, channels);
      } else {
        throw new PersistenceError(
          'corrupt',
          `${file.name} is not audio this project is waiting for.`,
        );
      }
      this.#idle();
      this.#publish();
      this.#toast.info('Audio relinked');
      this.#askForMissing();
    } catch (error) {
      this.#fail('Relink Audio', error);
    }
  }

  /**
   * Adopts a new session as the open project and hands its audio to the engine.
   *
   * @remarks `id` is the recovery copy the project was restored from. Any other project gets a
   * fresh copy written straight away, so a reload reopens it rather than an older project.
   */
  async #install(session: Session, view: ViewState | null, id: string | null): Promise<void> {
    this.#session = session;
    // A fresh import has no file of its own yet, so the next Save asks where it goes.
    if (view === null) this.#projectFile = null;

    const blobs = session.blobs();
    const track = session.track();
    const plan = session.plan();
    const edits = session.state();
    this.#plan = plan;
    this.#projectId = id ?? newProjectId();

    const rate = session.sampleRate();
    await this.#audio.loadProject(rate);
    const plans = session.clipPlans();
    for (const entry of session.media().clips) {
      if (!entry.attached) continue;
      const samples = session.clipSamples(entry.clip);
      buildPeaks(samples, rate, entry.source.fingerprint);
      const placed = plans.find((candidate) => candidate.clip === entry.clip) ?? null;
      this.#audio.loadClip(entry.clip, samples, session.clipTrackJson(entry.clip), placed);
      void this.#cacheMedia(entry.source.fingerprint, session.clipSamples(entry.clip));
    }
    for (const reference of edits.references) {
      const channels = this.#references.get(reference.id);
      if (!channels) continue;
      this.#keepReference(reference.id, reference.source, channels);
      this.#audio.loadReference(
        reference.id,
        channels.map((channel) => channel.slice()),
        reference.position,
      );
    }
    this.#audio.setPlans(plans, plan);
    this.#audio.placeReferences(edits.references);
    this.#audio.setMixer(edits.mixer);
    this.#audio.setLoop(null);

    const framed =
      view ??
      fitView(
        this.#store.state.view,
        0,
        Math.max(laneEndOf(edits), 1),
        lowestCentre(blobs) - FIT_MARGIN,
        highestCentre(blobs) + FIT_MARGIN,
      );

    this.#store.update({
      phase: 'ready',
      message: null,
      projectName: edits.name,
      track,
      blobs,
      plan,
      conflicts: session.conflicts(),
      edits,
      midi: session.midi(),
      mappingReport: null,
      guideOverlaps: session.guideOverlaps(),
      drift: session.drift(),
      selection: emptySelection(),
      view: { ...framed, playhead: 0 },
      transport: { ...this.#store.state.transport, playing: false, position: 0, loop: null },
      analysis: { running: false, progress: 1, stage: '' },
      dirty: false,
    });

    this.#startAutosave();
    if (id === null && this.#autosave) {
      this.#autosave.markDirty();
      void this.#autosave
        .flush()
        .then(() => this.#projects?.prune(RECOVERY_COPIES))
        .catch(() => {
          // An old copy that will not delete is only space, and the next import tries again.
        });
    }
  }

  #startAutosave(): void {
    const projects = this.#projects;
    const id = this.#projectId;
    if (!projects || id === null) return;
    recordOpenProject(id);
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
    this.#writes += 1;
    try {
      if (await media.has(fingerprint)) return;
      await media.write(fingerprint, mono);
    } catch {
      this.#toast.warn('Audio not cached. Reopening will decode again');
    } finally {
      this.#writes -= 1;
    }
  }

  /**
   * Whether leaving now would lose something a reload cannot bring back.
   *
   * @remarks A project already in its recovery copy reopens on reload, so only an import still
   * running, an edit not yet written there, or audio still being cached counts. Without device
   * storage there is no recovery copy, so any unsaved edit counts.
   */
  get unflushed(): boolean {
    if (this.#importing || this.#writes > 0) return true;
    if (!this.#session) return false;
    if (!this.#autosave) return this.#store.state.dirty;
    return this.#autosave.dirty;
  }

  /** Writes the recovery copy now if an edit is waiting for it. */
  flush(): void {
    void this.#autosave?.flush();
  }

  /** Keeps a reference's channels on the device, one after the other in one buffer. */
  async #cacheReference(source: SourceInfo, channels: readonly Float32Array[]): Promise<void> {
    const media = this.#media;
    if (!media) return;
    const key = referenceKey(source.fingerprint);
    this.#writes += 1;
    try {
      if (await media.has(key)) return;
      await media.write(key, joinChannels(channels));
    } catch {
      this.#toast.warn('Audio not cached. Reopening will decode again');
    } finally {
      this.#writes -= 1;
    }
  }

  #projectJson(): string | null {
    const session = this.#session;
    if (!session) return null;
    try {
      return session.project(this.#store.state.view);
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
      const edits = session.state();
      this.#audio.setPlans(session.clipPlans(), plan);
      this.#audio.placeReferences(edits.references);
      // The desk is monitoring rather than a plan input, so it reaches the worklet on its own
      // path. It still travels with the project, which is why it is read back from the session.
      this.#audio.setMixer(edits.mixer);
      const blobs = session.blobs();
      this.#store.update({
        blobs,
        // The track moves with the clips, so it is read again whenever a clip may have moved.
        track: session.track(),
        // The plan is what correction, guidance and modulation actually amount to, and the
        // editor draws the pitch target from it. Leaving it out drew the blob edits alone, so
        // an operation the plan carried moved nothing on screen.
        plan,
        conflicts: session.conflicts(),
        edits,
        // Renaming is an ordinary edit, so the name comes back with the rest of the state and
        // needs no path of its own.
        projectName: edits.name,
        // An edit can split, join or replace blobs, so what the selected span amounts to is
        // worked out again rather than left naming blobs the edit may have just removed.
        selection: selectionForRanges(blobs, this.#store.state.selection.ranges),
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

/** Project seconds at which the last clip on the lane ends, which is where the next one goes. */
function laneEndOf(edits: EditState): number {
  let end = 0;
  for (const clip of edits.clips) end = Math.max(end, clip.position + clip.source.duration);
  return end;
}

function laneEnd(state: AppState): number {
  return state.edits === null ? 0 : laneEndOf(state.edits);
}

/** The first two channels of decoded audio, or the one there is. */
function stereoOf(channels: readonly Float32Array[]): Float32Array[] {
  return channels.slice(0, 2).map((channel) => channel.slice());
}

/** Channels one after the other in one buffer, which is how the media store keeps them. */
function joinChannels(channels: readonly Float32Array[]): Float32Array {
  const frames = channels[0]?.length ?? 0;
  const joined = new Float32Array(frames * channels.length);
  channels.forEach((channel, index) => {
    joined.set(channel.subarray(0, frames), index * frames);
  });
  return joined;
}

/** Undoes {@link joinChannels}. */
function splitChannels(joined: Float32Array, count: number): Float32Array[] {
  const channels = Math.max(1, Math.min(2, count));
  const frames = Math.floor(joined.length / channels);
  return Array.from({ length: channels }, (_, index) =>
    joined.slice(index * frames, (index + 1) * frames),
  );
}

/** The saved view in a project document, or `null` when it has none worth restoring. */
function parseView(json: string): ViewState | null {
  try {
    const value: unknown = JSON.parse(json);
    if (typeof value === 'object' && value !== null && 'view' in value) {
      const view = (value as { view: unknown }).view;
      return isViewState(view) ? view : null;
    }
  } catch {
    return null;
  }
  return null;
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
 * @remarks Every entry runs a command and takes its key and its icon from that command, so the
 * menu, the toolbar and the keyboard cannot drift apart, and the key shown is the one that works
 * whether or not the menu is open. Over open canvas the blob entries are shown disabled rather
 * than removed, so the menu keeps its shape.
 */
function blobMenu(onBlob: boolean, commands: readonly Command[], hooks: ShellHooks): MenuEntry[] {
  const item = (id: string, label: string, icon: IconName, needsBlob = true): MenuEntry => ({
    label,
    icon,
    key: findCommand(commands, id)?.shortcut,
    enabled: (!needsBlob || onBlob) && hooks.isCommandEnabled(id),
    run: () => {
      hooks.runCommand(id);
    },
  });
  return [
    item('edit.reset', 'Reset to Origin', 'reset'),
    item('edit.joinBlobs', 'Join Blobs', 'join'),
    { separator: true },
    item('edit.excludeBlob', 'Exclude Blob', 'exclude'),
    { separator: true },
    item('edit.deleteBlobs', 'Delete Blobs', 'delete'),
    item('edit.deleteClip', 'Delete Clip', 'delete'),
    { separator: true },
    item('transport.loopSelection', 'Loop Selection', 'loop', false),
    item('file.exportWav', 'Export Audio', 'export', false),
  ];
}

/** The menu shown over a reference's band. */
function referenceMenu(reference: ReferenceId, hooks: ShellHooks): MenuEntry[] {
  return [
    {
      label: 'Delete Reference',
      icon: 'delete',
      run: () => {
        hooks.applyEdit({ type: 'removeReference', reference });
      },
    },
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
  editor: EditorController,
): () => void {
  // Counted rather than toggled: dragging across a child element fires a leave before the
  // matching enter, so a boolean flickers the marker off under the cursor.
  let depth = 0;
  const show = (event: DragEvent): void => {
    const item = event.dataTransfer?.items[0];
    shell.setDropTarget(
      item?.kind !== 'file'
        ? 'Drop To Open File'
        : workspace.ready
          ? 'Drop To Import'
          : 'Drop To Open Audio Or Project',
    );
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
    // Over the canvas of an open project, a vocal lands where it is let go, so the lane shows
    // where that is before it happens.
    if (workspace.ready) editor.previewDrop(event.clientX, event.clientY);
  };
  const onDragLeave = (): void => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      shell.setDropTarget(null);
      editor.endDrop();
    }
  };
  const onDrop = (event: DragEvent): void => {
    depth = 0;
    shell.setDropTarget(null);
    const at = workspace.ready ? editor.previewDrop(event.clientX, event.clientY) : null;
    editor.endDrop();
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    void openDropped([...files], workspace, toast, at);
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

/**
 * Opens or imports what was dropped.
 *
 * @remarks A project replaces what is open and asks first, as Open does. Audio dropped on an open
 * project is a vocal or a reference, whichever the user answers, at `at` for the first file and
 * after it for the rest, which is how takes are stitched. With nothing open the first audio file
 * starts a project and the rest join it as vocals.
 */
async function openDropped(
  files: File[],
  workspace: AxysWorkspace,
  toast: ToastHost,
  at: number | null,
): Promise<void> {
  const project = files.find((file) => kindOf(file) === 'project');
  const audio = files.filter((file) => kindOf(file) === 'audio');
  const midi = files.find((file) => kindOf(file) === 'midi');
  if (project) {
    await workspace.openProjectFile(project, true);
  } else if (audio.length > 0) {
    const [first, ...rest] = audio;
    if (first && !workspace.ready) {
      await workspace.openAudioFile(first, true);
      for (const file of rest) await workspace.importClipFile(file);
    } else {
      await workspace.dropAudio(audio, at);
    }
  }
  if (midi) {
    if (!workspace.ready) {
      toast.warn('Open a vocal before a MIDI guide');
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
  lead.textContent = `Axys cannot run in ${browserLabel()}. Missing required features:`;
  section.append(lead);

  const list = document.createElement('ul');
  for (const cap of caps) {
    if (!cap.required || cap.available) continue;
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = cap.label;
    item.append(name, document.createTextNode(`\n${cap.reason}`));
    list.append(item);
  }
  section.append(list);

  const tail = document.createElement('p');
  tail.textContent = 'Supported Browsers: current Chrome, Edge, Firefox and Safari, over HTTPS.';
  section.append(tail);

  mount.append(section);
}

/**
 * Replaces the page when the core itself will not load, which leaves nothing to run.
 *
 * @remarks Drawn with the splash's own inline styles, since a failed load may have fetched no
 * stylesheet. A failed fetch is named as the connection it is, with the browser's text under it.
 */
function showFailure(mount: HTMLElement, error: unknown, part = 'audio core'): void {
  mount.textContent = '';
  const section = document.createElement('section');
  section.className = 'axys-failure';
  section.setAttribute('role', 'alert');
  const mark = document.createElement('div');
  mark.className = 'axys-splash-mark';
  mark.textContent = 'AXYS';
  const heading = document.createElement('h1');
  heading.textContent = 'Load Failed';
  const lead = document.createElement('p');
  lead.textContent =
    lostConnection(error) || (error instanceof Error && lostConnection(error.cause))
      ? `Axys could not download its ${part}. Check the connection, then reload.`
      : `Axys could not start its ${part}.`;
  const detail = document.createElement('p');
  detail.className = 'axys-failure-detail';
  detail.textContent = describe(error);
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => {
    location.reload();
  });
  section.append(mark, heading, lead, detail, retry);
  mount.append(section);
}

/**
 * Whether an error is a download that never arrived.
 *
 * @remarks A failed `fetch` is a `TypeError`, and a worklet module that would not load is an
 * `AbortError` or `NetworkError` `DOMException`.
 */
function lostConnection(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    error instanceof DOMException && (error.name === 'AbortError' || error.name === 'NetworkError')
  );
}

/** Tells the user once, on first run, which optional capabilities are missing here. */
function noteDegradedCapabilities(caps: Capability[], toast: ToastHost): void {
  const missing = caps.filter((cap) => !cap.required && !cap.available);
  if (missing.length === 0) return;
  let seen: boolean;
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
  toast.warn(`Unavailable Features: ${names}. See Help and Diagnostics for details.`);
}

/** Resolves with the opened store, or `null` when this browser will not provide it. */
async function openStore<T>(opening: Promise<T>): Promise<T | null> {
  try {
    return await opening;
  } catch {
    return null;
  }
}

/**
 * Reopens the newest stored project this build can still read.
 *
 * @remarks The project that was open when the page closed comes back first, and after New
 * Project nothing does. A copy that cannot be read is discarded by {@link restoreNewest}, so the
 * one report the user gets is this one, and only when something was actually thrown away.
 */
async function restoreLastProject(
  workspace: AxysWorkspace,
  projects: ProjectStore | null,
  toast: ToastHost,
): Promise<void> {
  if (!projects) return;
  const open = openProjectRecord();
  if (open === '') return;
  const { discarded } = await restoreNewest(
    projects,
    (json, id) => workspace.restoreProjectJson(json, id),
    open,
  );
  if (discarded > 0) {
    toast.info(
      discarded === 1
        ? 'Discarded a recovery copy this version cannot read'
        : `Discarded ${String(discarded)} recovery copies this version cannot read`,
    );
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
    // The playing playhead is drawn at the output position, so that is what the view follows.
    const followed =
      state.follow && audio.playing ? followView(view, output, state.followMode) : null;
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
      const message = report.message ?? 'Playback failed and the browser gave no reason';
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
function watchSystemTheme(
  choice: ThemeChoice,
  accent: () => AccentName,
  redraw: () => void,
): () => void {
  if (choice !== 'system') return () => {};
  return watchPreferredTheme((name) => {
    applyTheme(name, accent());
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
    setProjectName(name: string): void {
      workspace()?.apply({ type: 'setName', name });
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
    previewMixer(mixer: MixerSettings): void {
      audio.setMixer(mixer);
    },
    meters(): MeterReport | null {
      return audio.playing ? audio.meters : null;
    },
    setTuning(a4Hz: number): void {
      workspace()?.setTuning(a4Hz);
    },
    setAccidentals(style: AccidentalStyle): void {
      workspace()?.setAccidentals(style);
    },
    setToolbarLabels(on: boolean): void {
      savePreferences({ toolbarLabels: on });
      store.update({ toolbarLabels: on });
    },
    setInspectorCollapsed(on: boolean): void {
      savePreferences({ inspectorCollapsed: on });
      store.update({ inspectorCollapsed: on });
    },
    setInspectorWidth(pixels: number): void {
      const width = clampInspectorWidth(pixels);
      savePreferences({ inspectorWidth: width });
      store.update({ inspectorWidth: width });
    },
    setTheme(choice: ThemeChoice): void {
      const saved = savePreferences({ theme: choice });
      applyTheme(resolvedTheme(choice), saved.accent);
      onThemeChoice(choice);
      // The canvas resolves its colours as it draws, and a theme change alone schedules no
      // frame, so the chrome would recolour while the editor kept the old palette until the
      // next unrelated redraw.
      redraw();
    },
    setAccent(accent: AccentName): void {
      const saved = savePreferences({ accent });
      applyTheme(resolvedTheme(saved.theme), accent);
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
    showFailure(mount, error);
    return;
  }

  const preferences = loadPreferences();
  applyTheme(resolvedTheme(preferences.theme), preferences.accent);

  const store = new AppStore(initialState());
  store.update({
    followMode: preferences.followMode,
    toolbarLabels: preferences.toolbarLabels,
    inspectorCollapsed: preferences.inspectorCollapsed,
    mixerCollapsed: preferences.mixerCollapsed,
    inspectorWidth: preferences.inspectorWidth,
    view: { ...store.state.view, timeDisplay: preferences.timeDisplay },
  });
  const commands = buildCommands();
  let context: CommandContext | null = null;

  const audio = await AudioEngine.create(store);
  // Nothing plays without the core and the renderer, so a download lost during the first load is
  // the failure screen rather than an editor that cannot play.
  if (audio.loadError !== null) {
    audio.dispose();
    dismissSplash();
    showFailure(mount, audio.loadError, 'audio engine');
    return;
  }
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
      releaseSystemTheme = watchSystemTheme(choice, () => loadPreferences().accent, redraw);
    },
  );
  const shell = AppShell.mount({
    root: mount,
    commands,
    hooks,
    theme: preferences.theme,
    accent: preferences.accent,
    toolbarLabels: preferences.toolbarLabels,
  });
  releaseSystemTheme = watchSystemTheme(preferences.theme, () => loadPreferences().accent, redraw);
  const toast = shell.toasts;
  shell.setCapabilities(caps);

  const projects = await projectsPromise;
  const media = await mediaPromise;
  if (!projects) {
    toast.warn('This browser cannot store projects. Export before closing the tab');
  }
  if (!media) {
    toast.warn('Audio cannot be cached here. Reopening will ask for the file');
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
    setLoop: (range) => {
      audio.setLoop(range);
    },
    announce: (message: string) => {
      shell.announce(message);
    },
    contextMenu: (hit, at) => {
      const reference = hit.reference;
      showContextMenu(
        reference === null
          ? blobMenu(hit.blob !== null, commands, hooks)
          : referenceMenu(reference, hooks),
        at,
      );
    },
  });
  context = { store, editor, audio, toast, workspace, chrome: shell };

  dismissSplash();

  // Only the built app has a worker to register. In development the module graph is served
  // file by file, so there is nothing precached and nothing to update against.
  const releaseOffline = import.meta.env.PROD ? startOffline() : (): void => {};

  const releaseEngine = watchEngine(audio, shell, toast);
  const releaseStore = store.subscribe((state) => {
    shell.update(state);
  });
  shell.update(store.state);

  const releaseShortcuts = bindShortcuts(window, commands, context);
  const releaseDrop = bindDragAndDrop(window, workspace, toast, shell, editor);
  const stopPlayhead = startPlayheadLoop(store, audio, workspace);

  // A reload reopens the recovery copy, so only work that has not reached it yet is worth a
  // warning. Starting the write here usually lands it while the warning is still up.
  const onUnload = (event: BeforeUnloadEvent): void => {
    if (!workspace.unflushed) return;
    workspace.flush();
    event.preventDefault();
  };
  window.addEventListener('beforeunload', onUnload);

  const open = workspace;
  workspace.onPending = (clip) => {
    editor.showPending(clip);
  };
  let tornDown = false;
  let releaseLoadWatch = (): void => {};
  const teardown = (): void => {
    if (tornDown) return;
    tornDown = true;
    window.removeEventListener('beforeunload', onUnload);
    releaseLoadWatch();
    releaseShortcuts();
    releaseDrop();
    releaseStore();
    releaseEngine();
    releaseOffline();
    releaseSystemTheme();
    stopPlayhead();
    open.dispose();
    editor.dispose();
    renderer?.dispose();
    audio.dispose();
    shell.dispose();
  };
  window.addEventListener('pagehide', teardown, { once: true });
  // The renderer module is added when the first project opens, so a download lost then ends the
  // session the same way. The project is written to its recovery copy first, so a reload keeps it.
  releaseLoadWatch = audio.subscribe(() => {
    const error = audio.loadError;
    if (error === null || tornDown) return;
    open.flush();
    queueMicrotask(() => {
      teardown();
      showFailure(mount, error, 'audio engine');
    });
  });

  await restoreLastProject(workspace, projects, toast);
  noteDegradedCapabilities(caps, toast);
}

await start();
