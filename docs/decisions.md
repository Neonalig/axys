# Axys decisions

Material implementation choices, the reasoning behind them, and the limitations that remain open.
`docs/design_bible.md` section 15 lists what must eventually be recorded here; each of those has an
entry below.

## Platform and toolchain

### Rust to WebAssembly with wasm-pack from npm

`wasm-pack` is installed as an npm devDependency rather than through `cargo install`. The npm
package downloads a prebuilt binary, so a contributor needs Node and Rust and nothing else.
`cargo install wasm-pack` would compile it locally, which is slow and on some platforms wants a
linker the design bible rules out. Rejected: `trunk` (assumes a Rust-side frontend), raw
`wasm-bindgen-cli` (one more thing to version-match by hand).

### No C or C++ anywhere in the dependency graph

Every crate in the tree is pure Rust: `serde`, `serde_json`, `midly`, `rustfft`, `wasm-bindgen`,
`js-sys`, `console_error_panic_hook`. No `cc` build script is pulled in, so the documented
workflow needs no MSVC, Clang, GCC or CMake. Rejected for this reason: `symphonia` was considered
for decoding and is pure Rust and MPL-2.0 compatible, but it is a large build for a capability the
browser already provides (see below); `rubato` and `hound` were unnecessary once resampling and
RIFF handling were written directly against the product's needs.

### Audio decoding uses the browser, WAV handling is ours

`AudioContext.decodeAudioData` decodes every format the host browser supports, which covers WAV,
FLAC, MP3, AAC/M4A and Ogg without shipping a decoder. Axys keeps its own RIFF WAVE reader and
writer in `axys-core::audio::wav` because export needs a writer anyway, because it gives exact
source facts for WAV without trusting the browser's resampling, and because it is testable
natively. Limitation: a format the user's browser cannot decode is reported as unsupported rather
than handled, and `decodeAudioData` resamples to the AudioContext rate, so Axys opens a context at
the file's own rate where the browser allows it and records the original rate either way.

### Canvas 2D is the editor renderer, WebGPU is detected and reported

The design bible asks for WebGPU only where measurement shows a real benefit. The editor draws on
the order of a few thousand line segments and rectangles per frame at typical zoom, which Canvas 2D
with a layered redraw and decimated pitch polylines holds comfortably inside a 16 ms budget on the
declared baseline. A WebGPU path would add a shader pipeline, a text-rendering problem and a
hit-testing problem for no measured gain at this data density. WebGPU availability is feature
detected and surfaced in `npm run doctor` and the in-app diagnostics, so the decision can be
revisited against real measurements rather than assumption. Nothing in the renderer interface
assumes Canvas, so a second backend can be added without touching the editor model.

### Realtime audio is an AudioWorklet with the WASM renderer inside it

Playback runs `axys-core::render::Renderer` inside an `AudioWorklet`. The worklet receives the
source PCM once as a transferred buffer and receives compiled render plans as messages, so the
audio thread never allocates, never blocks and never touches the DOM. Analysis, plan compilation
and offline export run in Web Workers.

### No `SharedArrayBuffer`, no cross-origin isolation requirement

The worklet owns its own copy of the source PCM, so nothing needs shared memory and the app works
without COOP/COEP headers. `_headers` ships the isolation headers commented out, documented as an
optional optimisation only. WASM threading is not used.

### Single canonical interpretation of edits

`target::RenderPlan` is the only thing either playback or export reads, and
`render::Renderer::render_range` is pure in the output sample position. Preview and export
therefore cannot disagree about pitch, timing, alignment or boundaries; they differ only in
`render::Quality`, which changes how much formant work is done per grain, never what the edit
means.

## Audio and DSP

### Pitch analysis is pYIN-style YIN with a Viterbi pass

YIN's cumulative mean normalised difference function with parabolic lag interpolation gives cheap,
accurate F0 on monophonic voice. A Viterbi pass over a bounded candidate set per frame, with a
transition cost in log-frequency, removes most octave errors and isolated dropouts, which raw YIN
produces freely on breathy material. References: de Cheveigne and Kawahara, *YIN, a fundamental
frequency estimator for speech and music*, JASA 2002; Mauch and Dixon, *pYIN: a fundamental
frequency estimator using probabilistic threshold distributions*, ICASSP 2014. Rejected: plain
autocorrelation (octave-prone), cepstral F0 (poor at low F0 with short windows), CREPE and other
learned estimators (a model download and a licence question, against a local-first product).

### Resynthesis is TD-PSOLA

Time-domain pitch-synchronous overlap-add transforms pitch and time independently, preserves
consonants better than a plain phase vocoder, is cheap enough for the realtime path, and degrades
predictably. Reference: Moulines and Charpentier, *Pitch-synchronous waveform processing techniques
for text-to-speech synthesis using diphones*, Speech Communication 1990. Rejected for now: phase
vocoder (transient smearing on plosives), sinusoidal modelling (heavier and harder to make
deterministic per output block). The DSP sits behind `dsp::psola` and `render::Renderer`, so a
second method can be compared without touching the UI or the project model.

### Formants are preserved by default

`FormantMode::Preserve` holds the spectral envelope while pitch moves, estimated by cepstral
liftering. Below roughly three semitones the difference is subtle; above that, following formants
is audibly wrong on voice, so preserve is the default and `Follow` is offered for the cases where a
user wants the resampled character. `Shift` exposes an independent adjustment.

### Modulation is split by a zero-phase low-pass

Drift and vibrato are separated at a configurable boundary, 3 Hz by default, using a
forward-backward one-pole so the split introduces no phase error and the two parts sum back to the
original contour exactly. That is what lets correction strength and vibrato depth be independent
controls rather than one blunt amount.

## Edit model

### What dragging each blob edge means

Dragging the start edge moves the boundary between this blob and its predecessor: it changes where
this blob's edits begin and, when the blobs touch, where the previous one ends. It does not stretch
audio. Dragging the end edge is the mirror of that. Both are clamped so neither side falls below
`blob::MIN_BLOB_SECONDS` and so a blob never crosses a neighbour. Stretching is a separate
operation on `time_scale`, so a user can never stretch audio by accident while fixing a
segmentation mistake.

### How timing edits treat gaps, overlaps and neighbours

Timing edits are local by default: moving or scaling a blob does not ripple into its neighbours, so
source duration outside the changed region stays stable. That makes overlaps and gaps possible, and
`BlobSet::timing_conflicts` reports every one of them. Conflicts are drawn in the editor and listed
before export rather than being silently resolved. Where blobs overlap, the render plan's time map
stays monotone by crossfading the contested span, so the output never plays backwards.

### How intent sources compose

Fixed order, each stage seeing the previous result: detected pitch, then scale correction, then
MIDI pitch guidance, then blob pitch offset, then drawn curve anchors, then modulation settings. A
later stage can always override an earlier one, and nothing deletes what an earlier stage produced
because each stage is recomputed from the immutable analysis on every plan compile. A blob's
`bypassed` flag skips every stage for that blob; `excluded` skips only scale correction and MIDI
guidance, leaving the user's own offsets and anchors intact.

### MIDI guidance is live, not committed

Changing guide mode, strength or alignment recompiles the plan immediately and is undoable as a
single operation. Guidance is never baked into anchors, so turning it off restores the previous
result exactly and manual curve edits are never overwritten.

### How interpolation crosses boundaries

Pitch targets are continuous across blob boundaries: a curve is evaluated over the whole timeline,
and a blob only contributes anchors within its own span. Across an unvoiced subregion the target is
held rather than interpolated, and no pitch transform is applied there, so consonants are not
dragged toward a pitch they never had. Across a gap between blobs the source is left untouched.

### Which project data is embedded, cached or linked

Embedded in the project document: source identity and fingerprint, all edits, tempo and meter maps,
mappings, guide selection, view state, and the imported MIDI file bytes as base64. Cached and
discardable: the pitch track, energy track and waveform peaks, all rebuildable from the source and
the recorded analysis parameters. Linked, never embedded: the source audio itself, which stays in
the browser's Origin Private File System and is verified on relink by fingerprint rather than by
name.

## Persistence

### Origin Private File System for media, IndexedDB for documents

Project documents are small JSON and live in IndexedDB with explicit schema versioning. Decoded
source audio is large and lives in OPFS, keyed by fingerprint. Explicit project import and export
write a single `.axys.json` file, so the only recoverable copy of a user's work is never trapped in
an opaque browser cache. Autosave writes the document, not the media.

## Licensing

- Application code is `AGPL-3.0-or-later`; `LICENSE` holds the full text and every
  application-owned source file carries an SPDX identifier.
- Every dependency is MIT, Apache-2.0 or dual MIT/Apache-2.0, all compatible with
  `AGPL-3.0-or-later`. `THIRD_PARTY_LICENSES.md` lists them.
- The npm dependencies are development tooling only. Nothing third-party is bundled into `dist/`
  beyond the application's own compiled output.
- The in-app Source Code entry resolves to the repository and the build's revision, supplied at
  build time by `AXYS_SOURCE_REPOSITORY` and `AXYS_SOURCE_REVISION` so a fork or third-party host
  can point it at their own corresponding source.

## Supported envelope

- Browsers: current Chrome, Edge and Firefox on desktop, and Safari 17 or newer. `AudioWorklet`,
  WebAssembly, IndexedDB and OPFS are required; WebGPU, OPFS `createSyncAccessHandle` and
  cross-origin isolation are optional and feature-detected.
- Baseline hardware for the stated performance envelope: a 2020-or-later x86-64 laptop, four cores,
  8 GB RAM.
- Representative project: one mono vocal of up to ten minutes at 44.1 or 48 kHz with one MIDI
  guide. Analysis is chunked and cancellable; longer files work but analysis time grows linearly
  and memory with it.
- Hard limits live in `axys_core::limits` and are enforced on import.

## Known limitations

- TD-PSOLA is honest but not mature. Large downward shifts on breathy material can sound rough, and
  very rapid pitch gestures can buzz. The interface is replaceable by design.
- Formant preservation is cepstral, not source-filter. It holds vowel character well for moderate
  shifts and becomes approximate past roughly seven semitones.
- Analysis assumes one dominant pitched voice. Strong bleed, heavy reverb, chorus or clipping
  produce unreliable F0, which the confidence track shows rather than hides.
- Octave ambiguity on very low or very breathy voices still occurs; the Viterbi pass reduces it, it
  does not eliminate it. Manual correction is the intended remedy.
- Time stretching beyond roughly 1.5x or below 0.7x begins to show granularity.
- Scrubbing plays short grains from the rendered stream rather than a continuously varying-rate
  render.
