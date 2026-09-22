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
- **The time map stretches the gaps between blobs** to absorb blob moves, keeps bypassed blobs at
  their source position, and forces each point strictly past the previous one, so the map stays
  monotone and invertible.
- **Undo is re-derivation, not an inverse patch.** `History` stores operations; the session replays
  them over fresh analysis. That is what guarantees an edit can never corrupt the evidence it was
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
