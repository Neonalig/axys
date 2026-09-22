<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Axys web contracts

Authoritative module and API contract for `web/src`. Implement these names and shapes exactly;
other modules compile against them.

House rules for every TypeScript file:

- First line `// SPDX-License-Identifier: AGPL-3.0-or-later`, blank line, then the code.
- Strict TypeScript. No `any`, no non-null `!` on values that can genuinely be absent, no `as`
  casts that hide a real type problem. `import type` for type-only imports.
- Every exported symbol gets a TSDoc comment describing the abstraction, not the implementation.
  Simple code gets no comment. No changelog or journal comments.
- No global mutable state outside the one `AppStore`. Modules take their dependencies as
  constructor or function arguments.
- No network requests of any kind. No analytics. No CDN.
- Player-facing text is short conventional Title Case verb-noun, two or three words: "Split Blob",
  "Reset Span", "Export WAV", "Add Anchor". Never sentences on a button.
- Errors that affect the user surface as a toast or an inline state, never only `console`.
- Keep the realtime audio path free of allocation, DOM work and blocking.

## Type mirrors: `core/types.ts`

Hand-written TypeScript mirrors of the serde contracts in `docs/core_contracts.md`, all
`camelCase`, matching the JSON exactly. Export `interface` or `type` for: `Tuning`,
`AccidentalStyle`, `Interp`, `Anchor`, `PitchCurve`, `PitchFrame`, `PitchTrack`,
`PitchTrackArrays`, `F0Params`, `EnergyTrack`, `SegmentParams`, `BlobId`, `Voicing`, `Subregion`,
`Blob`, `BlobSet`, `Edge`, `TimingConflict`, `ConflictKind`, `TempoEvent`, `MeterEvent`, `BarBeat`,
`TimelineMap`, `BeatGridPoint`, `MidiNote`, `MidiTrackInfo`, `MidiFile`, `GuideMode`,
`GuideSelection`, `NoteMapping`, `MappingReport`, `GuideOverlap`, `DriftReport`, `SampledCurve`, `TimeMap`,
`ScaleSettings`, `ModulationSettings`, `FormantMode`, `RenderPlan`, `EditOp`, `History`,
`BitDepth`, `ExportReport`, `ExportPreview`, `SourceInfo`, `AnalysisInfo`, `EditState`, `ViewState`, `TimeDisplay`,
`Project`, `Quality`.

`EditOp` is a discriminated union on `type`, matching serde's `#[serde(tag = "type")]` with
`camelCase` variant names, so `{ type: 'splitBlob', blob: 3, time: 1.25 }`.

Tuning and accidental spelling are edits like any other, so both persist in the project and appear
in undo:

- `{ type: 'setTuning', tuning: { a4Hz: number } }` replaces the concert reference. The core
  rejects an `a4Hz` outside 380 to 480, which surfaces as a toast.
- `{ type: 'setAccidentals', accidentals: 'sharps' | 'flats' }` replaces the spelling convention.

`isEditOp` in `core/json.ts` accepts both.

`core/notes.ts` is the one spelling of a note name: `SHARP_NAMES`, `FLAT_NAMES`, `pitchClass`,
`isBlackKey`, `noteName(midi, style)` and `noteNameWithCents(midi, style)`. Nothing else builds a
pitch-class table, so the grid, the inspector and the scale key always agree.

`core/timeline.ts` is the one TypeScript copy of musical time: `ppqOf`, `tempoAt`, `meterAt`,
`bpmAt`, `tickToSeconds`, `secondsToTick`, `barBeatAt` and `beatGrid`. It mirrors `timeline.rs` so
the ruler, the tools and the metronome can be drawn and scheduled without a WebAssembly call per
frame; `tests/timeline-parity.test.ts` holds the two to the same answers.

A blob carries its own level, so one word can be lifted or dropped:

- `{ type: 'setGain', blob: BlobId, gainDb: number }` sets one blob's level in decibels, clamped to
  `MIN_GAIN_DB` and `MAX_GAIN_DB`, where the floor is silence. It reaches the plan as `gain`, an
  amplitude curve indexed by source time, so it is heard in preview and written on export alike.
  The field is in the Properties tab and reads across the whole selection like the others.

`FormantMode` serialises as `"follow"`, `"preserve"` or `{ shift: number }`.

Also export the named constants `MIN_BLOB_SECONDS = 0.01`, `SCHEMA_VERSION = 1`,
`MIN_GAIN_DB = -60` and `MAX_GAIN_DB = 24`.

## WASM facade: `core/wasm.ts`

```ts
/** Loads and initialises the WebAssembly core exactly once. */
export function loadCore(): Promise<AxysCore>;

/** Typed facade over the wasm-bindgen exports. */
export interface AxysCore {
  version: string;
  createSession(input: SessionInput): Session;
  /** Builds a session from an analysis produced elsewhere, without re-analysing the audio. */
  openSessionFromAnalysis(input: AnalysedSessionInput): Session;
  openSession(projectJson: string, samples: Float32Array): Session;
  parseMidi(bytes: Uint8Array): MidiFile;
  hzToMidi(hz: number, a4: number): number;
  midiToHz(midi: number, a4: number): number;
}
```

`Session` wraps the Rust `Session` class: `applyEdit(op: EditOp): void`, `undo(): boolean`,
`redo(): boolean`, `state(): EditState`, `track(): PitchTrackArrays`, `blobs(): Blob[]`,
`plan(): RenderPlan`, `conflicts(): TimingConflict[]`, `guideOverlaps(): GuideOverlap[]`,
`proposeMappingsPreview(): MappingProposal`, `history(): { undo: string | null; redo:
string | null }`, `project(name: string, view: ViewState): string`, `exportPreview(range): ExportPreview`,
`exportWav(range, depth, sampleRate?): { bytes: Uint8Array; report: ExportReport }`,
`free(): void`.

`AnalysedSessionInput` carries `samples`, `sampleRate`, `name`, the analysis worker's `trackJson`
and `blobsJson`, and the optional `f0` and `segment` parameters it ran with. It is the import path:
the analysis runs in the worker and only the session assembly happens on the main thread.

`proposeMappingsPreview()` proposes blob-to-note mappings and returns them with their report
without applying anything, so Align Guide can narrow the proposal to a selection and commit what it
kept as a `setMappings` edit of its own. That makes an alignment one preview and one undo step,
which is what lets it be an operation rather than a button that has already happened.

`exportPreview(range)` measures an output range without encoding anything, so the Export WAV modal
can report duration, frames, peak, clipping, timing conflicts and silent spans before a file is
written. `range` is in output seconds and `null` covers the whole output. `exportWav` takes the
same range plus an explicit bit depth and sample rate, resampling when the rate differs from the
source.

Every method that can fail throws an `AxysError` carrying the Rust message. Wrap the raw
wasm-bindgen calls so nothing outside this file touches generated bindings.

## Capabilities: `capabilities.ts`

```ts
/** One probed browser capability. */
export interface Capability {
  id: string;
  label: string;
  available: boolean;
  required: boolean;
  detail: string;
}

/** Probes every capability Axys cares about. Never throws. */
export function probeCapabilities(): Promise<Capability[]>;

/** True when every required capability is available. */
export function isSupported(caps: Capability[]): boolean;
```

Probe: WebAssembly, `AudioWorklet`, `AudioContext`, IndexedDB, OPFS, OPFS sync access handles,
secure context, `WebGPU`, `SharedArrayBuffer`, cross-origin isolation, WASM threads,
`WebCodecs`, and `decodeAudioData` support for wav/flac/mp3/aac/ogg. Optional capabilities that
are missing must never block startup.

## State: `app/store.ts`

```ts
/** The whole application state. Replaced wholesale on each change, never mutated in place. */
export interface AppState {
  phase: 'empty' | 'loading' | 'ready' | 'error';
  message: string | null;
  source: SourceInfo | null;
  track: PitchTrackArrays | null;
  blobs: Blob[];
  conflicts: TimingConflict[];
  edits: EditState | null;
  view: ViewState;
  midi: MidiFile | null;
  mappingReport: MappingReport | null;
  drift: DriftReport | null;
  selection: Selection;
  tool: ToolId;
  transport: TransportState;
  analysis: { running: boolean; progress: number; stage: string };
  follow: boolean;
  followMode: FollowMode;
  /** Whether the toolbar buttons carry their names beside their icons. */
  toolbarLabels: boolean;
  /** Whether the mixer is folded away to its bar. */
  mixerCollapsed: boolean;
  dirty: boolean;
}

/**
 * What the user currently has selected.
 *
 * A selection is the spans in `ranges`, in time order and never overlapping. `blobs` and
 * `anchors` are what those spans cover, derived by `selectionForRanges` in `app/selection.ts` and
 * recomputed whenever an edit changes the blob set, never stored independently of the spans.
 * Coverage is strict: a span that ends exactly where the next blob begins does not select it.
 */
export interface Selection {
  blobs: number[];
  anchors: { blob: number; index: number }[];
  ranges: { start: number; end: number }[];
}

/** How the view keeps up with a playing playhead. */
export type FollowMode = 'page' | 'centre';

/** Editor tool in use. */
export type ToolId = 'select' | 'split' | 'pitch' | 'pen' | 'line' | 'time';

/** Transport position and mode. */
export interface TransportState {
  playing: boolean;
  position: number;
  loop: { start: number; end: number } | null;
  returnToStart: boolean;
  metronome: boolean;
  countIn: boolean;
}

/** Observable state container. The only mutable singleton in the app. */
export class AppStore {
  constructor(initial: AppState);
  get state(): AppState;
  /** Applies a partial update and notifies subscribers once. */
  update(patch: Partial<AppState>): void;
  /** Subscribes to changes; returns an unsubscribe function. */
  subscribe(fn: (state: AppState) => void): () => void;
}

/** The state an empty editor starts from. */
export function initialState(): AppState;
```

## Commands: `app/commands.ts`

```ts
/** A user-invocable action with a stable id, label and optional shortcut. */
export interface Command {
  id: string;
  label: string;
  group: 'File' | 'Edit' | 'Transport' | 'Tools' | 'View' | 'MIDI' | 'Help';
  shortcut?: string;
  /** A second key that runs the same command, never shown. */
  altShortcut?: string;
  enabled(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

/** Everything a command may reach. */
export interface CommandContext {
  store: AppStore;
  editor: EditorController;
  audio: AudioEngine;
  toast: ToastHost;
}

/** Builds the full command list. */
export function buildCommands(): Command[];

/** Looks a command up by id. */
export function findCommand(commands: Command[], id: string): Command | undefined;
```

Commands must cover, at minimum: Open, Save Project, Save As, Import MIDI, Export Audio, Cancel
Import, Undo, Redo, Select All, Join Blobs, Reset, Smooth Span, Exclude Blob, Correction, Voice
Character, Play, Stop, Loop Selection, Toggle Metronome, Toggle Mixer, Zoom In, Zoom Out, Zoom Fit,
Follow Playhead, Toggle Bars Beats, Align Guide, Help And Diagnostics. New Project empties the
editor and comes before Open, asking the same question about unsaved work.

Not every command is drawn where its group is: the mixer is opened from the footer, beside the zoom.

One Open covers a project or a vocal; a MIDI guide is imported into an open project and has its own
command. Reset is one command whose extent comes from the selected span. A command that addresses a
blob addresses every selected blob, so its key does what its menu entry does whether or not the
menu is open. Splitting is the Slice tool's alone, and Join Blobs takes two or more selected
neighbours and nothing else. Not every command is drawn in the toolbar: zoom lives in the footer,
Save As lives in the Save button's own menu, the bars-and-beats toggle lives in the inspector, and
Cancel Import lives under the import progress it cancels. Each keeps its shortcut wherever it is
presented.

The tools carry the letters Melodyne and Ableton have already trained: `V` select, `X` or `S`
slice, `P` pitch, `B` draw, `N` ramp, `T` time. The operations sit beside them on `I` and `O`, and
the two buttons sit in that order. Everything else avoids the chords the browser answers first, so
Reset is `R` and Smooth Span is `H` rather than `Ctrl+R` and `Ctrl+H`. Zoom Fit is `.` and Exclude
Blob is `E`; no command takes a bare digit, because the digits belong to the transport.

An operation previews through the workspace rather than committing as it goes:

```ts
/** Applies edits as one group, replacing whatever the previous call applied. */
previewEdits(ops: readonly EditOp[]): void;
/** Keeps the outstanding preview and ends the run. */
commitPreview(): void;
/** Undoes the outstanding preview and ends the run. */
discardPreview(): void;
/** True while an operation is previewing, which is when undo and redo are not the user's. */
readonly previewing: boolean;
```

## Shortcuts: `app/shortcuts.ts`

```ts
/** Binds keyboard shortcuts for a command list to a target element. Returns a disposer. */
export function bindShortcuts(
  target: EventTarget,
  commands: Command[],
  ctx: CommandContext,
): () => void;
```

Space toggles play, Escape clears selection, arrow keys nudge, Ctrl/Cmd+Z undoes and Ctrl/Cmd+Shift+Z
or Ctrl+Y redoes. Home and End take the playhead to the start and the end, and the page keys page
the view along the timeline, with Shift keeping them on the pitch axis. The ten digits jump the
playhead across the take, `1` at the start through `0` at the end, evenly spaced; either row
answers, and they are read by `code` so a layout that puts a symbol on an unshifted digit still
works. Shortcuts must not fire while a text input has focus.

## Audio: `audio/engine.ts`

```ts
/** Owns the AudioContext, the worklet and the transport. */
export class AudioEngine {
  static create(store: AppStore): Promise<AudioEngine>;
  /** Hands the worklet its source audio. Transfers the buffer. */
  loadSource(samples: Float32Array, sampleRate: number, trackJson: string): Promise<void>;
  /** Pushes a compiled plan to the worklet. Cheap, safe to call on every edit. */
  setPlan(plan: RenderPlan): void;
  /** Hands the worklet the monitor desk: level, pan, mute and solo for every strip. */
  setMixer(mixer: MixerSettings): void;
  play(from?: number): Promise<void>;
  pause(): void;
  stop(): void;
  seek(seconds: number): void;
  setLoop(range: { start: number; end: number } | null): void;
  setMetronome(on: boolean, timeline: TimelineMap): void;
  /** Plays a short region once, for scrubbing and audition. */
  audition(start: number, end: number): void;
  get position(): number;
  get playing(): boolean;
  dispose(): void;
}
```

The worklet is `audio/worklet/renderer-worklet.ts`, built as a separate module and registered with
`addModule`. It instantiates the WASM core itself, holds the source PCM and a `PlaybackRenderer`,
and answers `process()` from `renderRange`. It must never allocate in `process()`, must report
underruns and a stale or failed plan back to the main thread rather than emitting garbage, and must
output silence rather than noise on any failure.

`audio/decode.ts` exports `decodeAudioFile(file: File): Promise<DecodedSource>` using
`AudioContext.decodeAudioData`, preserving the original sample rate, channel count and a
fingerprint, and reporting an unsupported format clearly.

## Workers

`workers/analysis.worker.ts` runs `detect_f0`, `analyse_energy` and `segment` off the main thread,
posting `{ stage, progress }` messages and honouring a cancel message. `workers/render.worker.ts`
runs offline rendering and WAV encoding at `Quality.Offline`, with progress and cancel, taking the
chosen `depth` and `sampleRate` on its `exportWav` request. The import path runs through the
analysis worker rather than the main thread, reports its real stage and progress, and is
cancellable by the Cancel Import command. Both are typed by `workers/protocol.ts`, which exports the request and response unions.

## Editor: `editor/`

```ts
/** Maps between screen pixels and the time/pitch domain. */
export class Viewport {
  constructor(width: number, height: number, view: ViewState);
  timeToX(seconds: number): number;
  xToTime(x: number): number;
  midiToY(midi: number): number;
  yToMidi(y: number): number;
  get secondsPerPixel(): number;
  /** Zooms about a fixed screen point so the point under the cursor stays put. */
  zoomTime(factor: number, anchorX: number): ViewState;
  zoomPitch(factor: number, anchorY: number): ViewState;
  pan(dx: number, dy: number): ViewState;
}
```

`editor/renderer.ts` exports `class EditorRenderer` with
`constructor(canvas: HTMLCanvasElement)`, `render(state: AppState, viewport: Viewport): void` and
`dispose()`. It draws to Canvas 2D, respects `devicePixelRatio`, decimates the pitch polyline to at
most one point per pixel column, and keeps a frame under 16 ms for the representative project.

`editor/view.ts` owns screen geometry only. Musical time lives in `core/timeline.ts`, because the
audio engine needs it too and must not import from the editor.

Layers in `editor/layers/`, each a pure draw function taking
`(ctx, state, viewport, theme)`: `grid.ts` (pitch rows, octave labels, cents guides), `ruler.ts`
(seconds or bars and beats), `waveform.ts` (peak envelope behind the blobs), `pitch.ts` (detected
track with confidence, target curve, unvoiced spans), `blobs.ts` (bounds, centres, handles,
conflicts), `midi.ts` (guide notes and mapping links), `overlay.ts` (selection, playhead, loop
range, hover readout, drag preview).

`editor/interaction.ts` exports `class EditorController` owning pointer handling. Requirements:

- A click anywhere that is not a hot control places the playhead; the middle button pans; Alt over
  open canvas or the ruler plays a snippet without moving the playhead.
- A drag across the ruler draws a loop and a double-click on it clears one, so a loop is undrawn
  where it was drawn.
- A right-click opens the context menu for what is under it, selecting it first when it was not
  already selected.

- Dragging previews on the dragged object itself before commitment.
- Modifiers: Shift constrains, Alt is fine adjustment, Ctrl/Cmd toggles snap. With the Select tool
  Ctrl adds a span of its own to the selection and Shift stretches the one that is there.
- A pen or line stroke starts anywhere, including over open canvas, and applies to every blob it
  crosses, as one `EditOp::Group` so undo is one step.
- Every other gesture commits exactly one `EditOp`, so undo is one step.
- Numeric entry for the selected object's pitch and time coexists with dragging.
- `hitTest(x, y)` returns what is under the cursor, so the cursor and tooltip can reflect it.

## UI: `ui/`

Styles live in `web/src/styles/`, one file per area, imported by `web/src/styles.css`. A colour or
a measurement written into a rule instead of a token is a defect; design bible section 14 lists
the tokens and their permitted use.

`app/preferences.ts` holds the settings that belong to the person rather than to the project: the
theme choice including `system`, the follow mode and the time display. They live in local storage
and never in the project document.

`app/selection.ts` exports `selectionForRanges(blobs, ranges)`, `selectionForRange(blobs, range)`,
`selectionSpan(ranges)` and `withRange(ranges, range)`: the one place spans are turned into the
blobs and anchors they cover, and the one place spans are merged.

`persistence/file-access.ts` opens and writes files through the File System Access API where the
host has one, and through a hidden input and a download where it does not. It exports `openFile`,
`saveFileAs`, `writeFile`, `downloadFile`, `hasFileSystemAccess` and the `OPENABLE`, `PROJECT_KIND`
and `EXPORT_KIND` type lists.

`ui/tooltip.ts` exports `TooltipHost` and `setTooltip`. Nothing in the application sets `title`:
the host tooltip appears only after its own delay and only while the window holds focus. `ui/menu.ts`
exports `showContextMenu`, whose items each name the key that runs them while the menu is open. It
takes the control the menu hangs off, and pressing that control again closes the menu rather than
reopening it.
`ui/scrollbar.ts` and `ui/zoom-control.ts` are the navigation controls around and below the canvas.

`ui/shell.ts` builds the whole DOM chrome with semantic elements: a `<header>` toolbar of
`<button>` elements, `<select>` and `<input>` for settings, a `<main>` holding the canvas, and
`<aside>` inspector panels. Every control has an accessible name and a tooltip. The canvas gets
`role="application"` with a keyboard-reachable focus ring and an off-screen live region announcing
selection and edit results.

`ui/icons.ts` exports concise inline SVG strings, one per command group, 16px on a 16 grid, using
`currentColor`. `ui/toast.ts` exports `class ToastHost` with `info`, `warn` and `error`, each
auto-dismissing and stacking.

`ui/dialog.ts` exports `class Dialog`, the one panel system every panel goes through, export
included. Each is draggable by its title bar, where the gap between the title and the close button
carries a dotted grip saying so, and closes on Escape, on its close button, or on a press outside
it. A panel that has been dragged reopens where it was left, by title and on the device; a
remembered position that would put it off the edge of a window this size is dropped and the panel
opens centred, without forgetting the position. `blocking` defaults to true,
which darkens what is behind and keeps the keyboard inside; an operation that shows its result in
the editor passes `false`, so the transport and the canvas stay reachable.

`ui/progress.ts` exports `class ProgressBar`, the one bar the chrome draws. `set(null)` marches a
short fill from one edge to the other and starts again, the way the platform draws work of unknown
length; the host `<progress>` element draws that differently per browser and differently again at a
second size, which is why neither the import cover nor the status bar uses one.

`ui/operations.ts` exports `showCorrection(ctx)` and `showVoiceCharacter(ctx)`, and
`ui/align-guide.ts` exports `showAlignGuide(ctx)`. Each opens a non-blocking panel that applies its
settings through the workspace preview API as its controls are moved, so the blobs move and the
transport plays the result while the panel is open, and leaves the history with one entry however
long it was open. Apply keeps it; Discard, Escape and closing throw it away. With a span selected
the operation applies to that span by excluding every blob outside it, and those exclusions are
part of what Discard takes back. Align Guide narrows its proposal to the selected blobs instead,
leaving every blob outside the selection mapped as it was.

Each names its extent in one line, the same line everywhere: `Affects 3 selected blobs.` or `No
selection. Affects whole project.` Nothing else goes in it.

`ui/export-dialog.ts` exports `showExportDialog(options: ExportDialogOptions): Dialog`, the Export
WAV panel: a range choice of whole project or selection defaulting to the selection when there is
one, a sample rate, and a bit depth of 16-bit, 24-bit or 32-bit float. Measuring a range renders
it, so the `exportPreview` figures and their warnings are shown on request rather than on every
change. It commits an `ExportChoice` of `{ range, sampleRate, depth }` through `onExport`.

`ui/mixer.ts` exports `class MixerPanel`, the desk across the bottom of the editor: one strip per
audio source, laid out the way a desk lays one out, with the name, the pan above the fader, a
vertical fader and mute and solo under it. Pressing a mute or a solo settles the desk on that strip
alone and Ctrl or Cmd adds to what is already on, so more than one strip can be muted or soloed at a
time. A fader is heard as it moves, through `previewMixer`, and committed as one `setMixer` edit
when it is let go, so one drag is one undo step, and a control under the hand is never rewritten
from the state behind it. Pan lands on centre when it is dragged within a detent of it, which the
arrow keys step past. The panel is opened from the footer, beside the zoom, and whether it is open
is a device preference like the inspector's fold.

The mixer is monitoring and never reaches the render plan, so an export is unchanged by it. It
supersedes Compare outright: which vocal is playing is the processed and original strips with their
own mutes, and there is no command or button beside them. `audio/mixer.ts` is the one place the desk
is turned into amplitudes, read by the worklet and by the blob layer that draws what is audible.

`ui/inspector.ts` shows the selection's numeric fields, the display settings and the guide
settings, each bound to an `EditOp`. Correction and voice character are not here: they are
operations.

The panel folds away to a rail carrying the one control that opens it again, and the divider
between it and the canvas is dragged to set its width. Both are device preferences rather than
project state. The shell owns the column width and the divider, because the grid is the shell's;
the panel owns nothing but its own class. The divider is a grid column of its own rather than
something laid over either neighbour, because the inspector scrolls and a handle inside it would
scroll away with the settings.

A number field is dragged sideways to set it, from the field or from its label, one step per pixel
with Shift for ten and Alt for a tenth. The pointer is captured for the length of the drag and the
cursor is left visible; pointer lock is not used. A press on the field itself is taken over, so it
never selects the field's own text, and a press that stays a press focuses the field with its whole
value offered to be typed over; the spinner arrows are not drawn. The drag commits once, on release,
and gives focus back before it does.

A field's explainer hangs off its label, marked with an info icon, rather than off the control: a
tooltip over the control covers the slider or the drop-down being reached for. The blob panel is
headed with the ids that are selected, collapsing runs to ranges and eliding a long list, and the
count under it appears only above one. Every field but Start and End reads across the whole
selection, showing a dash where the selection disagrees and writing what is typed to all of it as
one undo step; Start and End are one blob's own boundaries and stay on the blob the heading leads
with. The guide panel is hidden until a MIDI file is imported, and its strength and mute go with it
while the mode is Visual Only.

`editor/layers/readout.ts` draws every readout the canvas floats over itself, in a monospaced face
and sized in whole character columns, so a figure counting up does not resize its own box. `ui/diagnostics.ts` renders the capability probe and the Source Code entry with the
build version and revision from `__AXYS_VERSION__`, `__AXYS_REVISION__` and `__AXYS_REPOSITORY__`.
`ui/theme.ts` exports the colour tokens as CSS custom properties with a high-contrast variant.

## Persistence: `persistence/`

```ts
/** Project documents in IndexedDB, keyed by project id. */
export class ProjectStore {
  static open(): Promise<ProjectStore>;
  list(): Promise<ProjectSummary[]>;
  load(id: string): Promise<string>;
  save(id: string, json: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Decoded source audio in the Origin Private File System, keyed by fingerprint. */
export class MediaStore {
  static open(): Promise<MediaStore>;
  has(fingerprint: string): Promise<boolean>;
  read(fingerprint: string): Promise<Float32Array>;
  write(fingerprint: string, samples: Float32Array): Promise<void>;
}
```

`persistence/project-io.ts` exports `exportProject(json, name)` writing a `.axys.json` download and
`importProject(file)` reading one back, plus `relink(file, expected: SourceInfo)` which verifies the
fingerprint and refuses a different file with a clear message. `persistence/autosave.ts` debounces
a save of the document only, never the media, and never becomes the sole copy of the user's work.

`persistence/restore.ts` exports `restoreNewest(source, open)`, which picks the newest stored copy
this build can still read. A copy is written only after passing the project contract, so one that
no longer opens was written under an earlier contract and has no version to migrate from. It is
discarded and the next is tried, because keeping it is a failure on every launch for a document
nothing can open.

## Offline install: `app/service-worker.ts` and `app/offline.ts`

`app/service-worker.ts` is the service worker, compiled on its own by the `axys-service-worker`
plugin in `vite.config.ts` and emitted as `sw.js` beside the page with two constants injected:
`__AXYS_PRECACHE__`, every file the build produced, and `__AXYS_CACHE__`, a cache name carrying the
version and the revision. Install fills one cache with the whole list in one `addAll`, so the core
and the bindings that call it are cached together or not at all. Activate drops every older `axys-`
cache. A GET to this origin is answered from the cache, a navigation falls back to the cached page,
and the worker swaps to a new build only when the page sends it `{ type: 'skipWaiting' }`.

```ts
/** Registers the worker and watches for a newer build. Returns a disposer. */
export function startOffline(): () => void;
```

The plugin also writes `version.json`, which `startOffline` reads past every cache on regaining the
network and on returning to the tab. A different revision asks the registration to update; the new
worker installs and waits, and a non-blocking Dialog offers Reload. Registration happens in the
production build only.

## Entry: `main.ts`

Probes capabilities, shows an explicit unsupported-browser state when a required one is missing,
loads the core, builds the store, shell, editor and audio engine, wires commands and shortcuts, and
shows a first-run toast when an optional capability is degraded.
