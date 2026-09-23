// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ClipboardContent, PitchCutFill } from './clipboard.js';
import type { OtherSource } from './sources.js';
import type {
  Blob,
  ClipId,
  DriftReport,
  EditState,
  GuideOverlap,
  MappingReport,
  MidiFile,
  PitchTrackArrays,
  RenderPlan,
  TimingConflict,
  ViewState,
} from '../core/types.js';
import { clipEnd } from '../core/types.js';
import { barSecondsAt } from '../core/timeline.js';

/** The whole application state. Replaced wholesale on each change, never mutated in place. */
export interface AppState {
  phase: 'empty' | 'loading' | 'ready' | 'error';
  message: string | null;
  /** What the project is called, or `null` with nothing open. */
  projectName: string | null;
  /** Detected pitch across the editor's layer. */
  track: PitchTrackArrays | null;
  /** Blobs of the editor's layer, the clips it edits: one ordered, non-overlapping set. */
  blobs: Blob[];
  /** The clips of the editor's layer, active clip first. */
  layer: ClipId[];
  /** Every clip outside the layer, drawn behind it. */
  others: OtherSource[];
  /** Timing conflicts within each clip, across every clip. */
  conflicts: TimingConflict[];
  edits: EditState | null;
  /** The plan the core last compiled from the edits, or null before a project is open. */
  plan: RenderPlan | null;
  view: ViewState;
  midi: MidiFile | null;
  mappingReport: MappingReport | null;
  /** Overlapping note pairs in the selected guide, reported and never resolved for the user. */
  guideOverlaps: GuideOverlap[];
  drift: DriftReport | null;
  selection: Selection;
  tool: ToolId;
  transport: TransportState;
  analysis: { running: boolean; progress: number; stage: string };
  /** Whether the view scrolls to keep the playhead in sight. Panning the view clears it. */
  follow: boolean;
  /** How the view keeps up while following. */
  followMode: FollowMode;
  /** Whether the toolbar buttons carry their names beside their icons. */
  toolbarLabels: boolean;
  /** Whether the inspector is folded away to its rail. */
  inspectorCollapsed: boolean;
  /** Whether the mixer is folded away to its bar. */
  mixerCollapsed: boolean;
  /** How wide the inspector column is, in pixels. */
  inspectorWidth: number;
  /** What editing acts on: blobs and the pitch in them together, blobs alone, or pitch alone. */
  editMode: EditMode;
  /** Whether detected pitch outside every blob is drawn and can be edited. */
  outsidePitch: boolean;
  /** What cutting pitch leaves in the span it came from. */
  pitchCutFill: PitchCutFill;
  /** What Copy or Cut last took, or `null` before either has. */
  clipboard: ClipboardContent | null;
  /** The kept curve picked up with the selection, which Delete deletes. */
  activeStroke: number | null;
  dirty: boolean;
}

/**
 * What editing acts on.
 *
 * @remarks `both` moves a blob's audio, its pitch and its edits together. `blob` changes which
 * audio a blob covers and moves nothing heard. `pitch` changes the pitch line and moves no audio.
 */
export type EditMode = 'both' | 'blob' | 'pitch';

/** The edit modes in the order the toolbar and the cycle key present them. */
export const EDIT_MODES: readonly EditMode[] = ['both', 'blob', 'pitch'];

/** What an edit mode is called in the UI. */
export function editModeLabel(mode: EditMode): string {
  return mode === 'both' ? 'Blob and Pitch' : mode === 'blob' ? 'Blob' : 'Pitch';
}

/**
 * What the user currently has selected.
 *
 * @remarks `ranges` holds one span per disjoint region, in time order and never overlapping.
 * `blobs` and `anchors` are what those spans cover, derived by `app/selection.ts`.
 */
export interface Selection {
  blobs: number[];
  anchors: { blob: number; index: number }[];
  ranges: { start: number; end: number }[];
}

/** Editor tool in use. */
export type ToolId = 'select' | 'split' | 'pitch' | 'pen' | 'bezier' | 'time';

/**
 * How the view keeps up with a playing playhead.
 *
 * @remarks `page` jumps the window forward a screen at a time, which holds the material still
 * while it is being read. `centre` keeps the playhead in the middle and slides the material past
 * it, which suits following a part closely.
 */
export type FollowMode = 'page' | 'centre';

/** Transport position and mode. */
export interface TransportState {
  playing: boolean;
  position: number;
  loop: { start: number; end: number } | null;
  returnToStart: boolean;
  metronome: boolean;
  countIn: boolean;
}

/**
 * Observable state container. The only mutable singleton in the app.
 *
 * @remarks Subscribers run synchronously in subscription order. A subscriber that throws is
 * reported to the console and does not stop the others. A subscriber that unsubscribes during a
 * notification is not called again for that notification. Each notification carries the state its
 * own update produced, so a nested update notifies separately instead of changing it.
 */
export class AppStore {
  #state: AppState;
  readonly #subscribers = new Set<(state: AppState) => void>();

  constructor(initial: AppState) {
    this.#state = initial;
  }

  get state(): AppState {
    return this.#state;
  }

  /** Applies a partial update and notifies subscribers once. */
  update(patch: Partial<AppState>): void {
    this.#state = { ...this.#state, ...patch };
    const current = this.#state;
    for (const fn of [...this.#subscribers]) {
      if (!this.#subscribers.has(fn)) {
        continue;
      }
      try {
        fn(current);
      } catch (error) {
        console.error('A store subscriber threw while handling an update.', error);
      }
    }
  }

  /** Subscribes to changes; returns an unsubscribe function. */
  subscribe(fn: (state: AppState) => void): () => void {
    this.#subscribers.add(fn);
    return () => {
      this.#subscribers.delete(fn);
    };
  }
}

/**
 * Applies several patches as a single update, so subscribers run once.
 *
 * @remarks Later patches win over earlier ones key by key. An empty list changes nothing and
 * notifies nobody.
 */
export function batchUpdate(store: AppStore, patches: readonly Partial<AppState>[]): void {
  if (patches.length === 0) {
    return;
  }
  const merged: Partial<AppState> = {};
  for (const patch of patches) {
    Object.assign(merged, patch);
  }
  store.update(merged);
}

/** The view a project opens at before it has been framed to its content. */
function initialView(): ViewState {
  return {
    visibleStart: 0,
    visibleEnd: 10,
    lowMidi: 36,
    highMidi: 84,
    timeDisplay: 'seconds',
    snapDivision: 4,
    playhead: 0,
    loopStart: null,
    loopEnd: null,
  };
}

/** The state an empty editor starts from. */
export function initialState(): AppState {
  return {
    phase: 'empty',
    message: null,
    projectName: null,
    track: null,
    blobs: [],
    layer: [],
    others: [],
    conflicts: [],
    edits: null,
    plan: null,
    view: initialView(),
    midi: null,
    mappingReport: null,
    guideOverlaps: [],
    drift: null,
    selection: { blobs: [], anchors: [], ranges: [] },
    tool: 'select',
    transport: {
      playing: false,
      position: 0,
      loop: null,
      returnToStart: true,
      metronome: false,
      countIn: false,
    },
    analysis: { running: false, progress: 0, stage: '' },
    follow: true,
    followMode: 'centre',
    toolbarLabels: false,
    inspectorCollapsed: false,
    mixerCollapsed: true,
    inspectorWidth: 328,
    editMode: 'both',
    outsidePitch: false,
    pitchCutFill: 'sung',
    clipboard: null,
    activeStroke: null,
    dirty: false,
  };
}

/**
 * Project seconds at which the last source on the lane ends.
 *
 * @remarks The later of every clip's source, every reference and every blob's edited end, so a
 * blob moved past the end of its clip still counts. Zero with nothing open.
 */
export function projectEnd(state: AppState): number {
  const edits = state.edits;
  if (edits === null) return 0;
  let end = 0;
  for (const clip of edits.clips) end = Math.max(end, clipEnd(clip));
  for (const reference of edits.references) {
    end = Math.max(end, reference.position + reference.source.duration);
  }
  for (const blob of [...state.blobs, ...state.others.flatMap((other) => other.blobs)]) {
    end = Math.max(end, blob.start + blob.timeOffset + (blob.end - blob.start) * blob.timeScale);
  }
  return end;
}

/**
 * Seconds playback runs past {@link projectEnd}: one bar at the tempo and meter there.
 *
 * @remarks Zero with nothing open.
 */
export function endLeniency(state: AppState): number {
  const timeline = state.edits?.timeline;
  if (timeline === undefined) return 0;
  const bar = barSecondsAt(timeline, projectEnd(state));
  return Number.isFinite(bar) && bar > 0 ? bar : 0;
}

/** Project seconds at which playback stops, or zero with nothing open. */
export function playbackEnd(state: AppState): number {
  const end = projectEnd(state);
  return end > 0 ? end + endLeniency(state) : 0;
}

/** The sample rate every source in the open project is held at, or `null` with nothing open. */
export function projectRate(state: AppState): number | null {
  return state.edits?.clips[0]?.source.sampleRate ?? state.edits?.timeline.sampleRate ?? null;
}
