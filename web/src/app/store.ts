// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  Blob,
  DriftReport,
  EditState,
  GuideOverlap,
  MappingReport,
  MidiFile,
  PitchTrackArrays,
  RenderPlan,
  SourceInfo,
  TimingConflict,
  ViewState,
} from '../core/types.js';

/** The whole application state. Replaced wholesale on each change, never mutated in place. */
export interface AppState {
  phase: 'empty' | 'loading' | 'ready' | 'error';
  message: string | null;
  source: SourceInfo | null;
  track: PitchTrackArrays | null;
  blobs: Blob[];
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
  compare: CompareMode;
  /** Whether the view scrolls to keep the playhead in sight. Panning the view clears it. */
  follow: boolean;
  /** How the view keeps up while following. */
  followMode: FollowMode;
  dirty: boolean;
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
export type ToolId = 'select' | 'split' | 'pitch' | 'pen' | 'line' | 'smooth' | 'time';

/** Which audio the transport plays. */
export type CompareMode = 'processed' | 'original' | 'split';

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
    source: null,
    track: null,
    blobs: [],
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
    compare: 'processed',
    follow: true,
    followMode: 'page',
    dirty: false,
  };
}
