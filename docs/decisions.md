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
produces freely on breathy material. References: de Cheveigne and Kawahara, _YIN, a fundamental
frequency estimator for speech and music_, JASA 2002; Mauch and Dixon, _pYIN: a fundamental
frequency estimator using probabilistic threshold distributions_, ICASSP 2014. Rejected: plain
autocorrelation (octave-prone), cepstral F0 (poor at low F0 with short windows), CREPE and other
learned estimators (a model download and a licence question, against a local-first product).

### Resynthesis is TD-PSOLA

Time-domain pitch-synchronous overlap-add transforms pitch and time independently, preserves
consonants better than a plain phase vocoder, is cheap enough for the realtime path, and degrades
predictably. Reference: Moulines and Charpentier, _Pitch-synchronous waveform processing techniques
for text-to-speech synthesis using diphones_, Speech Communication 1990. Rejected for now: phase
vocoder (transient smearing on plosives), sinusoidal modelling (heavier and harder to make
deterministic per output block). The DSP sits behind `dsp::psola` and `render::Renderer`, so a
second method can be compared without touching the UI or the project model.

### Formants are preserved by default

`FormantMode::Preserve` holds the spectral envelope while pitch moves. TD-PSOLA does that
inherently when grain content is copied untouched, so Preserve is the cheap path the realtime
renderer uses; export adds a cepstral envelope correction on top to tidy what the grain
approximation leaves. Below roughly three semitones the difference is subtle; above that, following
formants is audibly wrong on voice, so Preserve is the default and `Follow` is offered for the
cases where a user wants the resampled character. `Shift` exposes an independent adjustment.

### Pitch marks are picked by correlation on a free-running grid

`dsp::psola::build_epochs` places each voiced mark by normalised cross-correlation of the
candidate neighbourhood against the window around the previous mark, and predicts the next mark on
a free-running grid stepped by the local period rather than re-anchoring on the mark it just
picked.

The first implementation took the raw squared-energy argmax and re-anchored on it. A harmonically
rich glottal pulse has several energy maxima inside the search window, so the pick could land on a
secondary lobe, and re-anchoring made that error permanent: the sequence settled into a fixed two-
or four-mark cycle of alternating phase. Overlap-adding grains whose content is displaced by that
jitter gives an output whose true period is two or four times the fundamental, so an unedited
passthrough rendered notes an octave or two octaves down. Measured on `fixtures/audio/phrase.wav`,
four source notes came back as nine fragments, one of them 24 semitones low, and a vowel of
`consonants.wav` rendered at 13 percent of its source level.

Three details carry the fix. Candidate spacings are confined to within five percent of the local
period. Among candidates within 0.01 correlation of the best, the one nearest the prediction wins,
without which the pick locks onto a constant integer spacing and walks off a fractional grid. And
each mark stores its actual spacing to the next mark rather than the nominal period, because the
synthesiser walks marks by summing periods and a fractional error there leaves every grain reading
content up to half a sample off its own mark. That rounding alone cost 26 percent of RMS.

The passthrough now correlates 1.0000 with the source and recovers every fixture's span count
within about a cent.

### Export restores each frame's level after envelope correction

`Quality::Offline` adds a cepstral envelope pass that `Quality::Preview` does not run. The pass
matches the rendered and source envelopes on their log means, not their energy, so it moves a
frame's level by tens of percent wherever the two spectra differ. Preview and export then disagree
by about 35 percent on level, which breaks the rule that the two paths differ in fidelity and never
in interpretation. `render::Renderer` therefore restores each frame's pre-correction RMS after the
correction, so the envelope pass changes spectral shape only.

### Modulation is split by a zero-phase low-pass

Drift and vibrato are separated at a configurable boundary, 3 Hz by default, using a 2nd-order
Butterworth biquad run forward and backward, so the split introduces no phase error and the two
parts sum back to the original contour exactly. A one-pole pair was tried first and rejected: at
only -8 dB one octave above the split it left audible vibrato in the drift band. That is what lets correction strength and vibrato depth be independent
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
`excluded` flag skips scale correction and MIDI guidance for it, leaving the user's own offsets
and anchors intact.

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
- Rendering an output range costs a grain-phase integration from output sample 0, because
  determinism forbids carrying phase in state. `render::Renderer` memoises phase checkpoints so
  sequential playback and seeking stay bounded, but a cold seek deep into a very long file does
  measurable work before the first block.
- PSOLA snaps each output mark to the nearest source epoch, which leaves up to half a period of
  phase error where the mark grid drifts against the epoch grid. Inaudible as a constant sub-period
  delay on steady material; it is the main residual artefact on unstable pitch.
- Cepstral liftering at order 40 smooths the log spectrum over roughly 500 to 600 Hz, so closely
  spaced formants merge and an estimated peak can sit up to 200 Hz from the true formant. Good
  enough to hold timbre under moderate pitch movement, not an accurate formant tracker.
- Repitching material with little harmonic content, a near-pure sine for instance, produces quiet
  output at the new pitch. This is inherent to TD-PSOLA; real vocal material is unaffected.
- A slow glissando through more than the segmentation step threshold is split where the two-scale
  test first fires, which may not be where a musician would put the boundary.
- Blob ids are stable within one segmentation run only, so a re-analysis renumbers them.
- A project document written by a newer build is refused rather than parsed best-effort.
- Format 2 MIDI files are read as if their tracks were parallel, and SMPTE timecode divisions are
  rejected outright.
- WAV import does not support RF64/BW64, ADPCM, A-law or mu-law; export writes 16-bit, 24-bit and
  32-bit float only, with no dither or normalisation.

## Implementation decisions recorded during the core build

These were resolved while implementing `crates/axys-core`. Each names the module that owns it.

### Analysis

- **`analysis/f0.rs`** computes YIN's difference function through an FFT autocorrelation rather than
  a direct double loop, packing the two real inputs into one complex transform. Frame centres sit on
  exact multiples of the realised hop so the pitch and energy grids line up. At the buffer edges the
  window slides inside the buffer instead of zero-padding, so no frame is analysed against half
  silence. Viterbi costs are 0.08 per semitone of transition, 0.15 per voicing switch and an
  unvoiced observation cost of twice the YIN threshold; these are tuned against the fixture battery,
  not taken from the paper.
- **NaN crosses JSON as null.** `serde_json` cannot represent NaN, and an unvoiced frame's MIDI
  value is NaN. `PitchFrame` and `PitchTrackArrays` carry serde shims mapping it to and from `null`,
  so a project containing any unvoiced frame reopens. Without this the round trip silently failed.
- **`analysis/energy.rs`** normalises spectral flux by the track maximum, so an onset threshold is
  relative to the loudest transient in the clip rather than an absolute level. Crowded onset peaks
  resolve strongest-first, so a weak precursor cannot mask the real attack.
- **`analysis/segment.rs`** confirms a sustained pitch step at two window scales, because one
  hold-length window cannot tell a real step from the steep part of a 5 to 6 Hz vibrato. Leading
  consonant attachment is capped at 250 ms and never crosses the previous blob's end.

### Transformation

- **Formant modes are acoustic, not literal.** Plain TD-PSOLA already preserves the spectral
  envelope when grain content is copied untouched, so `Preserve` copies 1:1, `Follow` resamples
  grain content by the pitch ratio so the envelope rides pitch the way plain resampling would, and
  `Shift(s)` resamples by `2^(s/12)`. Resampling under the name Preserve would have moved formants,
  which design bible 7.3 forbids.
- **Overlap-add is normalised by accumulated window weight**, not by a fixed gain. The weight sums
  to roughly the pitch ratio, so this doubles as gain compensation and keeps level constant under a
  varying ratio without clicks. Below a weight of 0.05 the sample is left un-normalised rather than
  amplified.
- **The mark phase seed is epoch 0 mapped into output time**, not output sample 0. It stays a pure
  function of the closures and the epoch map, so determinism holds, and it is what makes a unit
  ratio render reproduce the source rather than delaying it by a fraction of a period.
- **Clamps that keep a bad plan controlled**: pitch ratio 0.25 to 4.0, grain content resampling 0.5
  to 2.0, grain half-width 50 ms, output magnitude 4.0, formant shift one octave either way.
- **`dsp/window.rs::hann_symmetric` uses the half-sample grid**, `0.5 - 0.5 cos(2 pi (n + 0.5) / N)`.
  The textbook symmetric Hann is symmetric but fails constant overlap-add; the periodic Hann
  satisfies overlap-add but is not symmetric. The half-sample form is the only one that is both.
- **`dsp/resample.rs`** normalises kernel weights per output sample rather than using an analytic
  gain, which makes an identity-ratio conversion exact. The anti-alias cutoff sits at 0.97 of the
  target Nyquist, trading a sliver of top end for real stopband rejection at practical kernel widths.
- **`render.rs` Quality tiers differ in fidelity, never in intent.** `Offline` adds a short-time
  cepstral envelope pass on top of PSOLA, gain-matched so it moves spectral shape only. Its frame
  grid is anchored at absolute output sample 0, which keeps block-split offline rendering bit-exact.
  `Preview` relies on the PSOLA approximation alone and caps each synthesiser call at 4096 frames to
  bound per-block work.
- **Rendering past the end of the source is silence, not a repeated grain.** PSOLA clamps a grain to
  the nearest pitch mark, so `render_range` masks any output sample whose mapped source position
  lies outside the buffer.

### Edit model

- **`target.rs` splits modulation with a 2nd-order Butterworth biquad run forward and backward.** A
  compensated one-pole pair only reaches about -8 dB one octave above the split and left audible
  vibrato in the drift band; the biquad reaches about -24 dB there and still sums back exactly.
- **Scale correction and MIDI pitch guidance apply a constant semitone offset per blob**, computed
  from its detected centre, rather than per analysis frame. That preserves the contour's deviations
  inside the blob and makes "strength 0.5 moves halfway" exactly observable.
- **A drawn curve replaces the corrected target rather than adding to it**, but the blob's own pitch
  offset still translates it, so moving a blob moves its drawn contour with it.
- **The time map stretches the gaps between blobs** to absorb blob moves and forces each point
  strictly past the previous one, so the map stays monotone and invertible.
- **Undo is re-derivation, not an inverse patch.** `History` stores operations; the session replays
  them over the base state. That is what guarantees an edit can never corrupt the evidence it was
  made against. The applied stack is capped at 10,000 operations to bound browser memory.
- **`blob.rs` split and join preserve audible continuity** by writing a boundary anchor at the
  evaluated curve value on each side of a cut, rather than snapping to the nearest surviving anchor.
  A join keeps the earlier blob's id and turns any gap into a `Silence` subregion.
- **`timing_conflicts` reports a gap only when the edited gap exceeds the gap the detected
  segmentation already had**, so ordinary silence between notes is not reported as an edit conflict.

### Import and persistence

- **`midi.rs` validates the SMF chunk layout itself before calling `midly`**, because `midly` is
  lenient about truncated trailing chunks and would return a partial file instead of an error.
  Tempo and meter events are collected from every track, so format 0 and sloppy format 1 both work.
  Percussion is detected from channel 10 or a General MIDI percussive program.
- **Mapping score is 0.7 temporal intersection-over-union plus 0.3 pitch proximity**, requiring real
  overlap, with ties broken by index so proposals are deterministic. Nothing is deleted to force a
  one-to-one result; leftovers go in the report.
- **Overlapping notes in a monophonic guide are reported, never resolved.** `Session.guideOverlaps`
  lists every overlapping pair in the selected track and channel, and the editor warns and shows the
  count beside the mapping report. No note is truncated, moved or deleted to force monophony, and
  mapping assigns at most one blob per note, so the extra notes appear as unmapped rather than
  merged. Resolving an overlap is the user's call.
- **`timeline.rs` accepts 60,000 to 16,777,215 microseconds per quarter**, the upper bound being the
  24-bit maximum a Standard MIDI File can carry. A meter change lands a bar line even mid-bar, so
  the interrupted bar is short.
- **`audio/wav.rs` never fails an export over one bad sample**: NaN writes as zero, infinities clamp
  to full scale, and both are counted in the clipping report. `peak` reports the largest pre-clamp
  magnitude, so a caller can see how far over full scale a render went.
- **`project.rs` fingerprints sample bit patterns and then the sample count**, so two buffers
  differing only in trailing silence cannot collide. `matches_source` compares fingerprint, rate,
  channels and frames and deliberately ignores the file name, so a renamed identical file relinks
  and a different file with the same name is refused.

### Limitations found during implementation

Added to the list at the end of this document rather than repeated here: the PSOLA seek cost, the
half-period phase error on unstable pitch, cepstral formant estimation accuracy, segmentation of
slow glissandi, and the base64 and schema-migration leniencies. See Known limitations.

## Implementation decisions recorded during the browser build

### The AudioWorklet calls the WebAssembly ABI directly

`web/src/audio/worklet/renderer-worklet.ts` does not import the generated wasm-bindgen glue. An
AudioWorklet module is loaded as a single file with no import support in Chrome, and the worklet
scope has neither `fetch` nor `TextEncoder`/`TextDecoder`, all of which the generated glue needs at
module scope. The worklet therefore builds its own import object, matching each mangled import by
its stable prefix read from `WebAssembly.Module.imports` and throwing a named error on anything it
does not recognise, then calls `playbackrenderer_create`, `setPlan`, `render` and `outputFrames`
directly on the instance the main thread posts to it.

This couples the worklet to the wasm-bindgen ABI, which is the real cost of the decision. It is
accepted because the alternative is a second, hand-written C-style export surface on the Rust side
purely for the audio thread, which would duplicate the contract and give two things to keep in
step instead of one. The unknown-import error makes an ABI change fail loudly at startup rather
than silently producing wrong audio, and `npm run check` builds both halves together so a drift
cannot reach a user.

Plan and track JSON are encoded to UTF-8 on the main thread and posted as `Uint8Array`, so the
worklet needs no text encoder and a plan update costs one memcpy on the audio thread.

### The core crosses to the worklet as bytes, not as a compiled module

`AudioEngine` fetches the WebAssembly module and posts the raw `ArrayBuffer` to the worklet,
which compiles it there with `new WebAssembly.Module(bytes)`. Synchronous compilation is
permitted off the main thread, so this costs nothing.

Posting an already-compiled `WebAssembly.Module` does not work: an AudioWorklet is a separate
agent cluster, and a module structured-cloned across one is **dropped silently**. There is no
exception on the sending side and no message on the receiving side. The worklet then holds a
source, a track and a plan but no core, renders nothing, and reports a healthy transport while
every block is silence. That is exactly how this shipped until it was measured, so the engine now
also arms a five-second readiness timer on every source load and reports a failure if the renderer
never confirms it is ready. Playing nothing has to be visible, not quiet.

### The worklet reports its position about twenty times a second

The playhead is drawn from the worklet's status messages. Reporting once per second made the
playhead jump in one-second steps however smooth the audio was, so the report interval is 2048
frames, roughly 43 ms at 48 kHz. That is one small message per interval, below the rate the editor
redraws at, and well inside the realtime budget.

### The AudioContext opens at the source sample rate

Where the host refuses that rate, the worklet resamples its output by the ratio rather than letting
the plan and the device disagree about what a second is. A rejected plan leaves the previous plan
rendering and reports the failure to the main thread; a failed render, a missing renderer or a
missing core outputs silence and counts an underrun. Nothing in the audio path ever emits noise on
failure.

### Compare modes

`original` plays the source on the same transport clock as the processed output rather than through
the time map, so A/B on a timing edit lets the user hear the original timing against the new one.
`split` puts original left and processed right. `processed` is the default.

### One path from edit to sound

Every edit path in `main.ts` ends in a single method that reads `session.plan()`, hands it to
`AudioEngine.setPlan`, and then updates blobs, conflicts and edit state in one store patch. The
audible result and the drawn result therefore cannot disagree, and a control that does not reach
that method is dead by construction rather than by accident.

### Bars and beats are computed in TypeScript for drawing

The ruler and grid layers derive bar lines from `state.edits.timeline` rather than calling
`Session.beatGridJson` per frame, so layers stay pure draw functions with no WebAssembly call
inside the render loop. The arithmetic mirrors the Rust contract and is capped at 4096 grid points.
The core remains the authority for snapping and for the playhead readout, where exactness matters
more than frame cost.

### Time domains

The store's `view.playhead` is in source seconds; the engine's position and loop range are in
output seconds. The workspace converts between them through the plan's time map, so a loop set from
a selection follows timing edits instead of drifting off them.

### Gestures and undo

Each gesture commits exactly one `EditOp`. Previews are held as controller state and drawn by the
renderer rather than by mutating the store, so an in-flight drag can never be mistaken for a
committed edit and undo is always one step per gesture. Modifier meaning is uniform across tools:
Shift constrains, Alt is fine adjustment at a fifth of the travel with snapping off, and Ctrl or
Cmd toggles snapping.

### Persistence details

`project-io.ts` carries a TypeScript mirror of `axys_core::project::fingerprint`, verified byte for
byte against the Rust implementation, because relinking has to digest a candidate file before a
session exists to ask. Relink decodes through an `OfflineAudioContext` at the project's own sample
rate, so no hardware device is opened and the digest is comparable. `MediaStore` picks OPFS or
IndexedDB once at `open()` and keeps it, so a project never has half its audio in one and half in
the other.

## Editor interaction, after the first testing round

### The playhead is one object, reachable anywhere

`view.playhead`, `transport.position` and a separate audition tool were three ways of saying where
the editor is looking. Clicking anywhere that is not a hot control now places the playhead, and
Alt over open canvas or the ruler plays a snippet without moving it. The audition tool is gone: it
existed only to do what a plain click should already have done, and its presence made the playhead
unreachable everywhere else. "Play from the start" is Stop then Play rather than a modifier,
because Stop returns to the beginning.

Limitation: the snippet gesture is Alt, which is also fine adjustment on a blob. The two never
overlap because the snippet is only offered where there is no blob to adjust.

### Transport commands carry a sequence number

The renderer reports its position on a timer, so a report posted just before a pause arrives just
after it and used to restore the transport the pause had stopped. Every transport message now
carries a monotonic `seq` the renderer echoes, and a report older than the newest command issued is
ignored for transport state. Underruns and failures are still taken from stale reports, because
those are counts rather than state.

### Selection is a span

A selection is a range of output time. Which blobs and anchors it amounts to is derived from that
span by `app/selection.ts` rather than stored beside it, and is recomputed whenever an edit changes
the blob set, so a selection can never name a blob a split or join has removed. Pitch is not part
of a selection: a drag along one pitch selects everything it passes under, which is what the shaded
region on screen already showed.

### One Reset, and a structural reset in the core

`EditOp::ResetRange` restores the analysed segmentation across a span, which is the only way a
split or a join is undone by anything other than undo. `EditState` does not carry the analysed
blobs; the baseline lives in the wasm `Session`, which already reconstructed it for history replay,
and reaches `edit::apply_with_baseline` as a parameter. A blob the span only partly covers is
restored whole, because a segmentation cannot be half undone.

Limitation: a curve-only reset over part of a blob is no longer reachable from the UI. `ResetSpan`
remains in the core for callers that want it.

### The development wasm is optimised

`npm run dev` builds the core with `--dev`, and an unoptimised analysis pass is what a contributor
measures import against. `[profile.dev] opt-level = 2` with `opt-level = 3` for dependencies brings
a take's analysis back into the seconds it takes in release while leaving debug assertions and
incremental builds on. Measured on the project's own test suite: 51.6 s to 2.9 s.

### Tooltips and menus are drawn by the page

A host tooltip appears only after a delay the page cannot set and only while the window holds
focus, which is exactly when a control's name is least readable. `ui/tooltip.ts` owns one delegated
tooltip layer keyed on a `data-axys-tip` attribute, and no control carries `title`. The canvas
carries none either: the renderer draws its own readout, and both together showed two tooltips that
disagreed about when to appear. Accessible names stay on the controls, and the shown tooltip is
pointed at by `aria-describedby`.

### File access prefers the host's own picker

`persistence/file-access.ts` uses the File System Access API where it exists, which gives one picker
listing every kind Axys opens and a handle to write back to, so a second Save needs no dialog.
Firefox and Safari fall back to a hidden input and a download, where every save asks again. The
project document is also mirrored into device storage on every save, so a lost file is not a lost
session.

Limitation: dropping an audio file replaces the whole project. The drop marker names what would
open rather than implying a position it would land at, because a project is one source and placing
a clip at an offset would be a timeline feature the core does not have.

### What the canvas says about itself

The waveform is drawn inside each blob, in that blob's own vertical extent and over its own source
span, so it moves with the blob rather than floating behind the material it belongs to. Compare
draws what is being heard solid and what is not transient, with the analysed positions in their own
colour, so the picture and the monitoring choice cannot disagree. Guide notes are hatched and
borderless: a guide is read, never edited, so it must not carry the border that means "grab this"
on a blob.

## Editor interaction, after the second testing round

### A selection is several spans

`Selection.ranges` holds one span per region, in time order and never overlapping. Ctrl adds a
region of its own and Shift stretches the one that is there, which is the pair every editor with a
multi-selection uses. Coverage is strict at both edges: a span that ends exactly where the next
blob begins no longer selects that blob, which is what made clicking one blob select its neighbour.
`selectionSpan` reports the hull for the operations that want one span, such as looping and the
export range.

Limitation: everything that reads a span still reads the hull, so looping a disjoint selection
loops across the material between its parts.

### Bypass is gone

Blob bypass and project-wide bypass both answered "hear this without its edits", which is what
Compare and Reset already answer, one for listening and one for committing. Two more ways to say it
made four controls to reason about and no new capability. Nothing of either remains: the ops, the
`Blob::bypassed` and `EditState::global_bypass` fields and the plan's bypass flag are all gone,
because nothing has shipped that could be holding one.

Rendering kept what the bypass path was good for. `RenderPlan::is_identity` recognises a plan that
asks for nothing, and `render_range` copies the source rather than resynthesising it, so an
unedited take exports as the file that was imported.

Exclusion survives and is now drawn as what it is: dim, dotted and without the marks that invite an
edit. It means "no automatic correction here", not "no sound here": the blob still plays and the
edits made on it by hand still apply.

### Correction and voice character are operations

Both were rows in the inspector, which made a decision about a take look like a preference about
the editor. Each is now a button that opens a panel, applies its settings as they are moved, and
ends in Apply or Discard. With a span selected the operation applies to that span by excluding
every blob outside it.

Previewing without filling the history needed the workspace to own the run: `previewEdits` unwinds
whatever the previous call applied before applying the next, `pinPreview` fixes the part that does
not change as the controls move, and the run ends in `commitPreview` or `discardPreview`. Dragging
a slider therefore leaves one history entry, and discarding leaves none. Undo and redo are disabled
while a run is open, because the top of the stack is the operation's rather than the user's, and an
edit made anywhere else commits the run rather than being unwound out from under.

Limitation: correction is compiled project-wide, so "apply to the selection" is expressed as
excluding everything else. A project that already had blobs excluded by hand has those exclusions
folded into the operation and restored by Discard, but Apply cannot tell the two apart afterwards.

### The compiled plan reaches the store

`AppState.plan` existed and was never written, so the editor drew the pitch target from the blob
edits alone and everything the plan carried — scale correction, guidance, modulation — moved
nothing on screen. The plan is published with every edit, and the target line is drawn from it.

### Readouts are drawn in whole columns

Every chip the canvas floats over itself is drawn in a monospaced face and sized in character
columns rounded up to a multiple of four. A figure counting up as the transport runs no longer
resizes its own box on every frame. The playhead readout ends after the clock where the take is
unvoiced, rather than naming the absence.

### The rulers are not special

The time ruler and the note gutter report the position under the cursor the way the plot does, with
no readout of their own and no selection gesture of their own; a loop comes from the selection
through Loop Selection and its edges are dragged once it exists. Each ruler previews only the axis
it measures: a vertical line over the time ruler, a horizontal one over the note gutter.

### A stroke belongs to the take, not to a blob

The pen and the line start anywhere, including over open canvas, and apply to every blob they
cross. Each blob is given the part of the stroke that falls inside it, with a point interpolated at
each edge the stroke crosses so a curve reaches the boundary instead of stopping at the last sample
inside it.

Limitation: one stroke is one `EditOp` per blob, so undoing a stroke across four blobs is four
steps, the same as joining four blobs.

### The detected line is cut on a fixed grid

The pitch columns are cut on a grid anchored at time zero rather than at the left edge of the view,
so panning no longer moves frames between columns and reshuffles the line as the view slides under
it. A column is given a minimum height, because a steady note spans no pitch at all and its column
was a hairline that only landed on a pixel at some sub-pixel offsets. The detected line is drawn
dotted and the target solid, so the two are told apart by shape as well as by colour.

### A toggle says whether it is on

Follow, Loop, the metronome and Compare each carry `aria-pressed` from the state rather than only a
label saying what pressing would do, and their tooltips are rewritten under the cursor when a
keyboard shortcut changes them. The metronome pulses its ground while it is clicking, and still
reads as on while the transport is stopped.

### One panel system

`ui/dialog.ts` is the only panel system, and every panel is draggable and dismissible by pressing
outside it. Blocking is a property of the panel rather than a separate kind: the export panel
blocks because its question has to be answered before anything else happens, and an operation panel
does not, because the editor behind it is where its result appears. Help is what the diagnostics
panel is called, because that is what someone opens it to get.

### Export measures when it is asked to

Measuring a range renders it, which is the work the export itself does, so opening the panel and
switching between whole project and selection no longer render anything. The figures and their
warnings are behind Measure Range, and what will be written is described from what the panel
already knows. The range defaults to the selection whenever there is one.

### Toolbar names are a setting, and the file buttons carry menus

The toolbar is icons by default and Button Names in the inspector puts each name beside its icon,
with the names that change with state following the state. Save is one button whose menu carries
Save and Save As, because where a file goes is a variation on saving rather than a second action.
Import is its own button with its own menu, because a guide is imported into an open project rather
than opening one, which is the opposite of what Open does.

### File pickers are a reported capability

A host without the File System Access API downloads every save and cannot offer Save As a picker at
all. That was invisible and read as a bug, so the capability is probed and reported in Help beside
the rest.

## Editor interaction, after the third testing round

### Undo replays from a base state

`Session::replay` rebuilt the edit state from a fresh `EditState::default()` and resegmented blobs,
so an undo silently discarded everything the history had never recorded. The timeline a MIDI import
adopted was the visible one: every guide note and bar line moved on the first Ctrl+Z, the project
autosaved in that state, and reopening it kept the damage. A reopened project was worse still,
because its scale, modulation, formant and guide settings live in the document rather than in the
history, and the replay reset them all.

The session now holds a `base: EditState` and replays the applied ops over a clone of it. The base
is the analysis for a new project, the document's own `base` for a reopened one, and a MIDI import
writes its timeline into both the base and the state, because an import is not an edit. The project
document carries the base for the same reason.

Removing the resegmentation also removed the freeze: the first undo after reopening used to run
energy analysis and segmentation over the whole take on the main thread, which is the "lags the
whole site" in the report, and the several seconds the first slider of an operation cost.

### A group is one undo step

`EditOp::Group` applies several operations as one history entry. A stroke across four blobs, a join
across a selection, excluding a selection and an operation panel's whole preview are each one
press of undo. The preview machinery got simpler with it: one group is one entry, so `previewEdits`
undoes exactly one thing before applying the next, and the pinning that kept an operation's scope
out of the replaced part is gone.

### The plan carries the target pitch

The editor drew the gold target line by reading the plan's pitch ratio and adding it to its own
detected track. The core compiles the ratio against its own reading of the same track, and the two
disagree wherever detection is uncertain, so every octave-ambiguous frame drew a spike a semitone
or an octave tall. `RenderPlan::target_midi` publishes the absolute target, 0.0 where the plan
leaves pitch alone, and the editor draws that.

Sampling it needed care of its own: interpolating between an edited sample and the zero beyond it
drew a line plunging towards MIDI zero at every span edge, which is what the spikes at the ends of
a drawn stroke were. The sampler mixes two samples only when both carry a target.

### Both pitch lines are cut on a fixed grid

The detected line was already sampled on a grid anchored at time zero; the target line was still
sampled per screen column, so a following view resampled it into a slightly different shape every
frame and it shimmered. It is now read at the same absolute times whatever the view is doing.

### One renderer per session

`Renderer::new` builds an epoch map across the whole source, and every export preview built a new
one, so asking what one second of a long take would export cost a pass over the take. The session
keeps one renderer and swaps the plan into it on recompile, which also keeps the grain checkpoints
that let a range late in the output be rendered without walking to it. Measuring a two-second
selection seventeen seconds into a one-minute take went from a whole-take render to 64 ms.

### Opening asks before discarding

Open and a dropped file both replace the whole project, and neither asked. Both now put the
question when the project is dirty, and offer to save first rather than only to discard.

### The metronome flash is read from the playhead

A CSS animation on a timer of its own was never on the beat and its brightest point was the middle
of the cycle. The flash is now computed from the playhead against the timeline: full brightness at
the click, fading over 120 ms, over a darkened ground that still says the metronome is on while the
transport is stopped.

## Editor interaction, after the fourth testing round

### The tools answer to letters, not to a numbered row

The tools had no keys of their own beyond the digits `1` to `7`, which is a row nobody reaches for
and an order nobody remembers. They now carry the letters Melodyne and Ableton have already
trained: `V` select, `X` or `S` slice, `P` pitch, `B` draw, `T` time. Slice answers to both because
the two editors disagree about which one it is and neither is worth being wrong about. That took
`X` off Exclude Blob, which moved to `0`, which took `0` off Zoom Fit, which moved to `.`.

Commands now carry an optional `altShortcut` alongside `shortcut`. It is never shown, so the key a
button names stays the key it names, and it is what lets Redo answer to `Ctrl+Y` as well as to
`Ctrl+Shift+Z`, and Slice to both of its letters.

### One way to cut, one way to smooth

Splitting existed twice: a Slice tool, and a Split Blob command on the playhead with a context-menu
entry beside it. The command cut wherever the playhead happened to be, which is not where anyone
was pointing, and it is gone. Join Blobs lost its other half too: it used to fall back to the blob
under the playhead and its successor, which took a neighbour nobody had named. It now needs two or
more selected blobs that are actually neighbours.

Smoothing existed twice the same way, as a tool and as a command. The tool is gone; Smooth Span on
`H` reads the selected span, which is the same span the rest of the span commands read.

### Aligning the guide is an operation

Align Guide was a button that had already happened: it proposed mappings, committed them and put
the result in a toast, and with the guide in Visual Only it moved nothing at all, which is what made
it look broken. It is now an operation like Correction and Voice Character. It carries the guide
mode and strength, previews against the material while it is open, and is kept with Apply or thrown
away with Discard.

That needed a proposal the core would hand back without applying it. `proposeMappingsPreview`
returns the mappings and the report; the panel narrows them to the selection, leaving every blob
outside it mapped as it was, and commits what it kept as one `setMappings` edit inside the preview
group. One alignment is therefore one undo step whatever it covered.

### An explainer belongs on the label, not on the control

Every field put its description on the control, so the tooltip appeared over the slider or the
drop-down at the moment it was being reached for. The description now hangs off the label, marked
with an info icon, and the control carries none. Hovering the label or the icon shows it; hovering
the field shows nothing.

The same rule settled what an operation says about its extent. Each now says `Affects 3 selected
blobs.` or `No selection. Affects whole project.` and nothing else. The line is read at a glance
before pressing Apply, and the sentence about playing to hear it was read once and then read past
forever.

### A selection is one set of fields with one dash

The blob panel addressed the primary selection and said "One blob selected." under a heading that
had already named it. The heading now names the whole selection, collapsing runs to ranges and
eliding a list too long for a line, and the count under it appears only above one blob. Every field
but Start and End reads across the selection: a figure they agree on, or a dash where they do not,
and typing into one writes it to all of them as a single undo step. Start and End are one blob's
own boundaries, so they stay on the blob the heading leads with.

### The guide panel is not there until there is a guide

A MIDI Guide panel in a project with no MIDI is a row of dead controls under a heading about a file
that is not there. It is hidden until one is imported. Strength and Mute go with it while the mode
is Visual Only, which moves nothing and makes no sound for either of them to act on.

### One progress bar, marching rather than bouncing

The import cover and the status bar both used `<progress>`, which draws its own indeterminate state
differently per browser and differently again at a second size, so one import was reported by two
different animations. Both now use `ui/progress.ts`, drawn by the page: a short fill crossing from
one edge to the other and starting again, the way the platform draws work of unknown length. A fill
that bounces back reads as something going wrong and being retried.

### The ruler draws loops

A loop could only come from Loop Selection, and dragging the ruler scrubbed. A press on the ruler
still places the playhead, and a drag across it now draws a loop, which is where every other editor
puts it. Dragging a loop edge also reaches the audio engine now: it used to write the loop to the
store alone, so the drawn loop and the loop being played disagreed.

### A loop in sight is not followed

Playing from a visible playhead switched following on, which is right until there is a loop whose
bounds are both on screen. Then the view swings back and forth round a loop that needed no
scrolling to be watched. Following now defaults on only when the playhead is visible and the loop
is not wholly visible with it.

### The detected line is joined across the frames a zoom leaves between

Zoomed in past one frame per pixel, most columns of the detected track hold no frame at all, and
the line fell apart into ticks that drew further apart the further in the zoom went. A gap no wider
than the frame spacing is the zoom rather than an unvoiced stretch, so the frames either side of it
are joined; anything wider is material with no pitch in it and stays open. The collection window
also reaches one frame past each edge of the view, so the line reaches the edges.

### The digits are a line across the take

The ten digit keys sit in a line, and the take is laid out in a line, so the row maps onto it: `1`
is the start, `0` is the end, and the eight between them are evenly spaced. Stepping in tens
instead would leave the last tenth of the take with no key on it, which is the one position the
row's last key should reach. Either digit row answers, and both are read by `KeyboardEvent.code`
rather than by `key`, so a layout that puts a symbol on an unshifted digit still works.

That took the digits away from the commands: Exclude Blob moved from `0` to `E`. No command takes a
bare digit now, because a digit that sometimes scrubbed and sometimes edited would be neither.

### The inspector folds to a rail

The editor is the thing being looked at and the panel beside it is not always wanted, so the
column folds to a rail carrying the one control that opens it again. The choice is a device
preference, like the theme: it follows the person rather than the project. The shell owns the
column width because the grid is the shell's; the panel owns nothing but its own class.

The column also got wider. The info icon added to every label pushed "Tuning Reference" onto two
lines, so the label column is sized for the longest label with its icon beside it rather than for
the label alone.

### The grip went where the hand already was

The first grip was a dotted strip above the title bar, which added an area rather than marking one.
The gap between the title and the close button was already draggable and is where a hand reaches
for a panel, so the dots moved into it and the strip is gone.

### The inspector divider is a grid column

Folding the panel away was not the whole of it: the width someone wants depends on the take and on
the screen, so the divider between the canvas and the inspector is dragged to set it. It is a grid
column of its own rather than a handle laid over either neighbour, because the inspector scrolls
and a handle inside it would scroll away with the settings. Arrow keys move it and a double-click
puts it back, which is what every other divider does. The width is a device preference, and it is
clamped so the column can be neither hidden nor made to swallow the editor.

## Offline install

### One cache per build, filled as one unit

The service worker precaches the whole build into a cache named for the version and the revision,
in a single `addAll`. The core is WebAssembly and the bindings that call it are JavaScript with a
matched ABI, so a cache holding new bindings and an old core is not a slow editor, it is a broken
one. `addAll` is all-or-nothing: a partial download leaves the previous build serving as it was,
and a build that does install never mixes its files with another's. Activation deletes every other
`axys-` cache and nobody else's.

The precache list is the build's own output rather than a list kept by hand, emitted by a plugin in
`vite.config.ts` that reads the bundle and the public directory. A file that stops being emitted
stops being cached, and one that starts being emitted is cached without anyone remembering to say
so.

### The worker is compiled separately and lands at the scope root

`web/src/app/service-worker.ts` is TypeScript like everything else, but it does not go through the
bundler. A worker can only control what sits under it, so a hashed name in `assets/` would scope it
to `assets/` and could never be replaced. The plugin compiles it with the esbuild Vite already
carries and emits it as `sw.js` beside the page, with the file list and the cache name injected as
constants.

### An update is offered, never taken

`version.json` is written beside the page with the same version and revision the page was built
with. On regaining the network, and on returning to the tab, Axys reads it past every cache and
asks the worker to update only when the revision differs. The new worker installs and then waits:
the swap happens when the user presses Reload in the panel, because an update that replaced the
running build under an open project would reload the editor out from under an edit.

Nothing is lost either way. Projects are in IndexedDB and their audio is in OPFS, and a reload
touches neither.

### Development registers nothing

`npm run dev` serves the module graph file by file, so there is no build to precache and no stamp
to compare against. Registration happens in the production build only, which also keeps a stale
worker from serving yesterday's bundle over a dev server.

## Per-blob gain

### A level is a plan stage, not a mixer strip

A blob's `gain_db` compiles into `RenderPlan::gain`, an amplitude curve indexed by source time
alongside the pitch ratio, and `render_range` applies it last on both the copy path and the
synthesis path. So a level is the same multiplier whichever produced the sample under it, and it
reaches the export as surely as it reaches playback, which is what makes it an edit rather than a
monitoring choice.

The curve holds the level flat across the blob and reads 1.0 outside it, so the grid's own
interpolation ramps over one 5 ms hop at each edge rather than stepping the level at a boundary.
Decibels, not an amplitude, because that is what a level is read and typed in, and the floor is
silence rather than -60 dB of signal, so a field taken all the way down is off.

## The mixer

### The desk supersedes Compare

Compare was one toolbar button with three faces, and it answered one question: which take is
audible. A mixer answers it with the control everyone already knows, and answers the questions
Compare could not: how loud the original is against the processed one, where each sits in the
field, and how loud the click is. `CompareMode` is gone with the button, and the split mode with
it: original hard left and processed hard right is two pan controls rather than a mode.

Swap Vocal keeps `C`, and exchanges which of the two vocal strips is heard. It moves mute and solo
only: a swap answers which take is being listened to, and taking each strip's level and pan with it
would answer a question nobody asked. With both strips up, or both down, it says so rather than
silently picking one.

### The mixer is monitoring, not an edit to the take

Strip levels never reach `compile_plan`, so an export is exactly what it was before the fader
moved. A blob's own gain is the opposite: it is a plan stage and is written on export. The two are
different questions, and folding them together would mean either an export that changes when the
monitor does or a monitor that cannot be turned down without changing the file.

The desk still lives in the project document, in `EditState` beside the scale and modulation
settings, because how a take is listened to is part of the work. That also makes it an `EditOp`
like everything else, so it undoes and autosaves with no machinery of its own.

### The worklet mixes voices rather than switching between them

The realtime path summed processed, original and click and then switched on a compare mode. It now
resolves the desk to a left and right amplitude per voice when a message arrives, and every block
is a sum of those, so the audio thread does no mixing arithmetic beyond two multiplies per voice
per sample. A voice nothing can be heard from is not rendered at all, so a muted processed strip
costs no synthesis.

Pan is equal power, so a strip swept across the field holds its loudness instead of dipping through
the middle. `audio/mixer.ts` is the one place the desk becomes amplitudes, shared by the worklet,
the blob layer that draws what is audible, and the toolbar face that names it.

### A fader is heard as it moves and kept when it is let go

Dragging a fader sends the desk straight to the engine and commits one `setMixer` when the pointer
is released, so the sound follows the hand and the history gets one entry per drag rather than one
per frame. It is the same shape as the guide strength slider, without the operation machinery,
because a fader has nothing to discard.

### Mute and solo are exclusive until Ctrl says otherwise

Pressing a mute or a solo settles the desk on that strip alone, which is what someone wants nine
times in ten. Ctrl or Cmd adds instead, which is how more than one strip is muted or soloed at a
time. The same modifier that adds a span to a selection.

## Editor interaction, after the fifth testing round

### The mixer is a panel, opened from the footer

The first mixer was a bar of its own across the bottom, carrying the control that folded it away.
That is two bars where one would do, and the footer already holds the controls that say how the
editor is laid out rather than what is in it. The fold moved there, beside the zoom, and it takes
its name from Button Names like every other control that has one. The panel itself is now only the
desk.

The strips are laid out the way a desk lays one out: the name, the pan above the fader, a vertical
fader, its level, and mute and solo under it. A horizontal row of sliders is quicker to write and
slower to read, and a level is a height everywhere else it is drawn. The fader carries both
spellings of a vertical range input, the modern `writing-mode` and the older `slider-vertical`, so
it stands up in every browser in the supported envelope.

### Compare has no button at all

Which vocal is playing is two strips with their own mutes, so a toolbar button that says the same
thing is a second control to keep in step with the first. Swap Vocal keeps `C`, because a one-key
A/B is worth having without opening the panel, and it is drawn nowhere.

The click strip is called Metronome, which is what the transport control that starts it is called.
Two names for one sound is a thing to work out rather than a thing to read.

### A control under the hand is not rewritten from behind it

The store updates on every animation frame while the transport runs, and the panel refreshed every
control from it, so a fader being dragged was fighting the value it had not committed yet. Each
control is now left alone while it has focus, readouts included.

### Pan has a detent and no explainer

A continuous pan cannot be put back on centre by hand, so a drag that ends within six percent of the
middle lands there. The detent belongs to the drag rather than to the value: the arrow keys step
through that span one hundredth at a time and must still reach every value in it.

The strips carry no tooltips. A strip named Processed, Original or Metronome is not a thing that
needs explaining, and a tip on every control is a tip on nothing.

### A loop is undrawn where it was drawn

A loop comes from dragging across the ruler, so a double-click there clears it. Anywhere else is
left alone, because a loop is not what is under the cursor there.

### A panel reopens where it was left

Where a panel sits is a working arrangement, and dragging Export or Voice Character out of the way
of the material only for it to come back over that material is the editor forgetting something the
user said. Positions are kept by title on the device.

A remembered position is checked against the window before it is used: a panel left near the right
edge of a wide screen would open off a narrow one, so a position that no longer fits is ignored and
the panel opens centred. It is not forgotten, because the window may be that size again.

### The guide panel says what is left over, or nothing

"Guide notes are shown over the vocal" described what was already on screen. The line now carries
what the mapping left unmapped and how many notes overlap, and is hidden when there is neither.

### The mixer answers for the monitoring on its own

Swap Vocal is gone, command and all. Two strips with their own mutes already say which take is
playing and set it, and a second way to say it is a second thing to keep in step. `C` is free.

### A strip's value sits under its control

The pan readout was beside the slider, which left the slider about sixty pixels to say the whole
stereo field in. Each control now gets the width of the strip and its value gets the line under it.

The centre detent had the same fault in a different place: it wrote the detented value back to the
slider mid-drag, which does not move the drag the browser is running, so the raw position came back
on release and a pan dragged to centre landed a few percent off it. The slider is left where the
pointer puts it and the detent is applied to what is heard and committed, which is what the readout
was already saying.

### New Project is a command of its own

Opening a file replaced the project and nothing emptied it. New Project sits before Open, asks the
same question about unsaved work in its own words, and returns the editor to the state it starts a
session in, leaving the device's own settings alone. It lets go of the source in the worklet as
well, so an empty editor has nothing to play; the context and the processor stay up for the next
project. Not `Ctrl+N`, which the browser answers first with a window of its own.

### A number field is dragged sideways

Typing a figure is exact and slow, and a slider is fast and imprecise. Every number field in the
inspector is now also a drag, from the field or from its label, one step per pixel with the
modifiers the canvas already uses: Shift coarse, Alt fine.

The pointer is captured for the length of the drag and the cursor is left where it is, which is
what the design tools people already use do. Pointer lock was tried first, for the wrapping cursor
a native editor has, and is wrong in a browser twice over: the page takes the cursor away behind a
notice about controlling it, and taking the lock releases the pointer capture the drag is tracked
by, so the field stops following the hand the moment the lock engages.

Three details make it behave. The drag takes focus so the panel does not rewrite the field under the
hand, and gives it back before committing, or the field goes on showing the number the drag wrote
while the project holds another. The click that ends a drag is swallowed, because a label's click
puts the keyboard back in the field it names.

And a press inside the field is taken over outright, with its default prevented. A press in a form
control starts that control's own text selection, which `user-select` does not govern and clearing
the selection does not stop: dragging back across the digits selected them again on every move.
Focus is given instead on release, with the whole number offered, which is what a press on a
scrubbable field is for: drag it, or type over it. The spinner arrows go with the default, and are
not drawn; they were a two-pixel target on a field that is now dragged, and the arrow keys still
step it.

### Pressing a menu button again closes its menu

A menu dismisses itself on a press outside it, and that press is the button's own, so the click
that followed reopened it and the menu never closed. The menu now knows which control it hangs off
and ignores the click from the press that dismissed it.

### An inline width outranked the rail

Folding the inspector added `is-inspector-collapsed`, which sets the column to the rail width, and
the shell also wrote the dragged width to the same custom property inline. An inline property beats
any rule, so the class changed nothing and the panel kept its full width with only its rail drawn
in it. The width is written while the column is open and removed when it folds, so the rule applies.

The control carries a sidebar icon rather than an arrow, because what it shows and hides is a panel
beside a pane, and an arrow that flipped said only which way something was about to move.

## Interface design system

### The accent is a generated ramp, not a picked colour

`#4cc2ff` was picked by eye, and the seven tokens that hang off it, `focus`, `selection`,
`selectionFill`, `blobFill`, `blobFillSelected`, `blobBounds` and `accentText`, were each nudged
into place by hand. That is how a set drifts: eight accents times seven tokens times two themes is
112 values nobody can keep consistent.

`ui/accent.ts` takes a hue and a chroma multiplier per accent and computes the rest. Lightness and
the chroma ceiling are fixed per role, so every accent lands on the same contrast relationships.
Lightness is 0.70 in dark and 0.52 in light because blue runs out of gamut early: above 0.77 every
blue washes out to a maximum chroma near 0.12, while at 0.70 the same hues hold 0.16.

Hex out, not `oklch()` or `color-mix()`. `resolveTheme()` hands token text straight to Canvas 2D,
and `fillStyle` would take either as unresolved text.

The eight hues each sit at least 25 degrees from `pitchTarget`, `pitchDetected`, `midiNote` and
`playhead`, which leaves three usable arcs and is why the set leans blue and green. Slate is
Cerulean at a third of its chroma, so the neutral option costs no hue budget. Cerulean leads
because the name plays on both axis and axolotl.

High Contrast ignores the accent and keeps `#00e5ff`. Its colours are chosen against a floor the
ramp does not promise. The swatches are shown disabled there rather than hidden, because a control
that comes and goes is harder to find again than one that says why it cannot be used.

`web/src/ui/accent.test.ts` asserts 4.5:1 for `accentText` on `accent` and 3:1 for `accent`
against the surface behind it, over every accent in both themes, so a ninth cannot be added
without clearing them.

### A ring rather than an outline for focus

`:focus-visible` drew a 2px outline and forced `border-radius` onto every element that could take
focus, so a pill control got a rounded-rectangle ring. It is now a two-layer `box-shadow`, 1px of
`bg` inside and 2px of `focus` outside, which follows whatever radius the element already has. The
global radius override goes away with it.

### Chrome leaves on an animation, so it is removed after one

An element entering can animate from its own rule, because it is in the document for the length of
the animation. An element leaving cannot: removing it ends the animation before it is seen.
`ui/motion.ts` plays the exit class, waits on the element's own animations, then removes it, and
falls straight through under `prefers-reduced-motion`.

Nothing the editor draws per frame goes through it. The playhead, canvas drags, value scrubs and
zoom are answered on the frame they are asked for; an eased delay on any of those reads as lag.

### Atkinson Hyperlegible, one variable file per face

Atkinson Hyperlegible Next and Atkinson Hyperlegible Mono replace `system-ui` and `ui-monospace`,
which stay as fallbacks. Both ship as one variable Latin upright woff2 covering the whole weight
axis: 34.0 KB and 17.8 KB against 37.5 KB for the three static sans weights alone, so the variable
file is smaller than what it replaces and gives every weight in between for free. No italics and
no `latin-ext` until localisation lands.

The files sit in `web/src/fonts` rather than `web/public`, so the bundler hashes them and the
service worker precaches them with the rest of the build. `font-display: swap`, because the shell
paints before the WebAssembly core is ready and holding the text back would put a blank toolbar in
front of that.

The 11px floor goes. Hyperlegible is drawn for legibility at reading sizes and looks loose below
12px, so the size scale starts at 12 and the canvas grid, ruler and readout labels come up with it.

Figures are set tabular wherever a number is read or dragged. The sans defaults to proportional
lining figures, so a readout jitters in width while its value changes. Canvas 2D takes no
`font-variant-numeric`, so the readout layer is set in the mono face, whose figures are one width
already.

The face is wider than `system-ui`, so the inspector opens at 344px rather than 328 and may be
dragged down to 256 rather than 240. The 640 maximum is unchanged.

### Lucide, generated into a committed file

`scripts/build-icons.mjs` fetches the glyphs named in `scripts/icon-map.json` from the CDN at a
pinned version and writes `web/src/ui/icons.ts`, which is committed. So a build and a test run need
no network, the application carries no runtime icon dependency, and `currentColor` keeps working.
`lucide-static` is not installed at all: it unpacks to roughly 50MB for the fifty-odd glyphs used
here. `node scripts/build-icons.mjs --check` says whether the committed file is still what the map
produces, and the generator formats its own output so that comparison is about the glyphs rather
than the wrapping.

The markup is taken unmodified but for the intrinsic size, which the stylesheet supplies. No stroke
override, no `non-scaling-stroke`, no regridding to 16. Lucide's rule is stroke width equal to size
over twelve, and the shipped `viewBox="0 0 24 24"` at `stroke-width="2"` gives 1.67 at 20px and
1.33 at 16px for free, against the 1.4 the hand-drawn set used at every size.

Two rendered sizes and no others: 20px in the toolbar and tool palette, 16px in menus, inspector
rows and the status bar, both set from one `--axys-icon` property.

`exclude` is `circle-minus`, not `circle-slash`. Slash reads as blocked; minus reads as removed
from the set, which is what excluding a blob from analysis means.

### A toggle swaps its glyph, it does not dim one

`STATE_ICONS` pairs a control with the two glyphs it picks between, and the transport, loop,
follow, inspector fold, mixer fold and channel mute all swap. A dimmed icon reads as disabled
rather than off. `aria-pressed` carries the state either way, so the swap is decoration and no
control depends on it.

Where Lucide ships no off variant, the metronome and solo are the two here, the control keeps one
glyph and carries its state in its pressed styling. A hand-drawn slashed variant beside real Lucide
pairs is immediately visible.

Four pairs in the table have no control yet: loop-one-range, monitoring, blob excluded and
diagnostics. They are in `STATE_ICONS` so the control that grows them has the pair already settled
rather than picking a glyph on the day.

### Bravura, subset by codepoint

No general icon pack carries accidentals, note durations, rests, dotted values or metronome marks,
so Axys ships the SMuFL reference font for them. SMuFL puts every glyph in the private use area, so
the subset is specified by codepoint like any other font: full Bravura is 316 KB, the six ranges
Axys sets come to 16 KB, and accidentals alone would be 4.7 KB.

`scripts/build-music-font.mjs` runs `pyftsubset` and, from the same metadata, generates
`web/src/ui/music.ts` holding each glyph's name, character and extents. Both outputs are committed,
so a build and a test run need neither the network nor a Python toolchain, and the script's
`--check` mode says whether the module still matches the published metadata.

A music glyph is set in its own run at its own size, never inheriting the body text's. SMuFL draws
to a staff rather than to a text baseline, so an accidental left to inherit sits low and small. The
vertical shift comes from the glyph's own bounding box in Bravura's metadata rather than from a
number somebody nudged until it looked right.

Note letters and octave numbers stay in the UI face; Bravura sets the accidental glyph only. In
running text a note name uses U+266F, U+266D and U+266E rather than SMuFL, so an ordinary label
does not pull a 16 KB font in behind it. Neither shipped face carries those three, so the browser
falls back per character to a system face that does, which every target platform has.

### One definition per control, in `ui/controls/`

Controls that disagree about their own states are the single biggest tell of an immature interface,
and the toolbar, the inspector, the mixer and the dialogs were each building a button their own
way. `web/src/ui/controls/` now holds the button, toggle, field, slider and select, and a container
arranges controls rather than restyling them. Design bible section 16.2 names every control once
with its rest, hover, active, disabled, focus and checked states.

### The select is the context menu, not a native one

A native `option` holds text and nothing else, which is what stopped the accidental style offering
its own accidental and the snap division offering its note. `ui/menu.ts` already did per-item
icons, check marks, disabled state and shortcut hints, so the list is that menu and the closed
control is a button wearing the chosen option's face.

It keeps `value` and fires `change`, the two things the native element was used for, so a field
holding one needs to know nothing else about it. Combobox semantics are whole: `role="combobox"`,
type to select, Home and End, arrows to step without opening, Alt and an arrow to open, Escape to
dismiss, focus back to the trigger either way.

Every native select went, not only the three in the export dialog and the inspector. A set where
some are native and some are not is exactly the inconsistency the primitives exist to end.

### In-app translucency, because system Mica needs a native shell

Mica is a DWM system backdrop for native windows. It is not exposed to web apps, and
`backdrop-filter` samples only what is inside the page, never the desktop wallpaper behind it. A
browser tab and an installed PWA both fall outside it. This is settled: do not reopen it without a
native shell.

What is available is the part of Mica Alt that actually matters, which is panels taking colour from
the editor underneath them: `backdrop-filter: blur(20px) saturate(1.4)` over the surface at 72%
alpha in dark and 78% in light, on menus, dropdowns, tooltips, dialogs, toasts, the inspector and
the mixer. A ground layer behind the canvas gives them something to sample past the end of a
project, because a blurred panel over a flat surface is only a slightly different flat surface.

High Contrast opts out and stays opaque: its promise is a fixed contrast floor and anything showing
through would break it. So does a browser with no `backdrop-filter`, where the blur would only be a
thinner panel.

The installed app draws its own titlebar through `window-controls-overlay` in `display_override`,
the `titlebar-area-*` environment variables and `app-region`. The toolbar rises into the overlay and
carries the project name. Every browser tab reports a zero-height title area and keeps the ordinary
toolbar, so there is one layout with one extra rule rather than two.

### The project's name lives in the edit state

Renaming has to be undoable like any other edit, and the history replays `EditOp`s over the base
state, so the name is a field of `EditState` and `SetName` is an ordinary operation. `Project.name`
stays at the top of the saved file, written from `edits.name` on save and read back into it on open,
so a file carries the name where a reader expects to find it while the editor keeps one copy.

It opens as the imported audio's file name with the extension stripped, and it is edited in the
inspector's Project panel. The tab title, the window titlebar, the save file name and the export
default all read that one field. Title format: `Axys` with nothing open, `Take 3 - Axys` open and
saved, `*Take 3 - Axys` while `store.dirty`; the marker leads so a truncated tab still shows it.

Renaming does not move an already-saved file. Save writes to the handle it is bound to; the new
name is what Save As and Export offer.

### The palette and the cheatsheet read the command list, nothing else

`Ctrl+Shift+P` opens the command palette and `?` the keyboard cheatsheet, both over the same
commands the toolbar and the menus already show. A command reaches either by existing, not by being
registered a second time, so neither can drift out of date.

Matching is a subsequence over the label and its group rather than a substring, so `expwav` finds
Export Audio without anybody maintaining a keyword list. A label prefix sorts first, then a
substring, then the toolbar's own order. The row Enter would run is marked rather than focused,
because the caret stays in the search field.

Opening either needs the chrome, so `CommandContext` carries a `Chrome` with exactly two methods.
Everything else a command opens is a dialog the command builds, because the chrome has no business
knowing what an export looks like.

### A shifted punctuation key ignores Shift

`?` never fired: the chord parsed as the bare key with Shift off, while the keystroke arrived with
Shift on, so they never matched. On most layouts `?` _is_ Shift and the slash key, so demanding
Shift be off means the chord can never be pressed, and demanding it be on binds a key nobody wrote
down. A chord whose key is a single punctuation character now matches whatever Shift is doing.

### The toolbar folds rather than wraps

The bar had `flex-wrap: wrap`, so a narrow window gave it a second line, which moves the editor down
and changes how tall it is. It now folds groups into an overflow menu from the right, so the file
and edit commands that anchor the bar are the last to go. What fits is measured from the header's
own `scrollWidth` against its `clientWidth`, so the check needs to know no control's width, and it
is re-measured on resize and whenever the button names are turned on or off.

### An empty canvas says how to start

Before anything is imported the editor drew an empty grid. It now offers the ways in: a drop
target, the words saying a file can be dropped, and buttons, because a drop target alone is
unreachable from the keyboard and a button alone hides that dropping works.

### Lines are snapped in device pixels, not CSS pixels

The canvas is scaled by the device pixel ratio and every layer draws in CSS pixels, so the usual
`Math.round(x) + 0.5` lands on a CSS-pixel centre, which is a device-pixel centre only at a ratio
of 1. At 125 and 150 percent scaling, which is what most Windows laptops ship at, every grid line,
ruler tick and blob bound was drawn as a blurred band.

`Viewport.crisp(value, width)` snaps the centre and `Viewport.crispWidth(width)` rounds the width
to whole device pixels, at least one. The width has to come into it: a line an odd number of device
pixels wide is centred on a half pixel, an even one on a whole pixel. At a ratio of 1 or 2 nothing
changes; at 1.25 a one-pixel rule becomes one device pixel rather than one and a quarter.
`web/src/editor/view.test.ts` checks both edges of a one- and a two-pixel line land on whole device
pixels at 1, 1.25, 1.5, 2 and 3.

### The pen carries its own cursor, drawn from its own glyph

A cursor image is composited by the host, so it cannot take a colour from a theme token and has no
ground behind it. `editor/cursors.ts` draws each glyph twice, a heavy dark pass and the light shape
over it, which is what keeps it legible over the waveform, a light surface and a selection fill
alike. Every custom cursor is 24px with a declared hotspot and a stock fallback, so a host that
refuses the image still shapes the pointer for what the tool does. The pen's hotspot is the nib, at
the glyph's bottom left, so the ink lands where the pointer is rather than where the barrel is.

A boundary drag is `col-resize` rather than `ew-resize`: it is a divider between two things that
share a span, which is what `col-resize` means everywhere else.

A band being dragged takes `crosshair` for as long as the drag lasts, because a marquee is not the
select tool resting over a blob.

### The marquee marches from the clock

The band's dashes travel at one period of `--axys-march`, the same rate the indeterminate progress
bar marches at, so the two read as one idea. The offset comes from the clock rather than from a
frame counter, so the speed does not depend on how often the editor happens to redraw, and the only
continuous frame request in the renderer is the one that keeps the ants moving while the pointer is
still. Under reduced motion the dashes hold still and say the same thing.
