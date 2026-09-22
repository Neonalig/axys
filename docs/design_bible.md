# Axys Design Bible

**Product:** Axys  
**Purpose:** Authoritative product and technical requirements for a local-first monophonic vocal pitch and timing editor  
**Status:** Working design reference  
**Priority order:** Core, Wanted, Nice-to-have  
**Licence:** AGPL-3.0-or-later  

## 1. Document authority

This document defines what Axys must enable, how editing should behave, the technical and distribution constraints, and the quality bar used to judge the result. It is the authoritative requirements document for implementation decisions.

The named technologies and algorithms are investigation pointers unless this document explicitly labels them as constraints. Where a choice remains open, select it using measured browser compatibility, audio quality, maintainability, reproducibility, contributor setup cost and licence compatibility. Record material choices and unresolved limitations in `docs/decisions.md`.

The feature groups express priority and dependency, not fixed release phases. Work may draw from a later group when that resolves a core workflow or major research risk. A functional Core product takes priority over broad but shallow feature coverage.

## 2. Product definition

Axys is a visual editor for isolated, predominantly monophonic vocal recordings. It analyses a vocal into editable note-like regions called blobs, displays the continuous detected pitch inside them, and lets the user reshape pitch and timing while retaining a recognisable, natural voice.

The name is a double entendre on axis, referring to movement along the time and pitch axes, and Axolotl or Axy.

### 2.1 Primary promise

A user can see what a vocal actually sang, decide what it should sing, correct local pitch and timing, audition the result, and export it without conventional waveform surgery or a full digital audio workstation.

### 2.2 Problems to solve

- Entry-level pitch editors commonly expose note-centre correction while restricting detailed transitions, tails and curve drawing.
- General audio editors expose samples and automation but do not present pitch as the main editable musical object.
- MIDI and notation can describe intended notes and rhythm but normally cannot be aligned directly against a recording and used as its correction target.
- Existing open tools often separate analysis from practical non-destructive vocal correction.

### 2.3 Intended users and source material

The primary user is a musician, arranger, hobbyist or audio editor correcting a solo vocal or speech-like melodic line.

The preferred input is a dry or lightly processed recording with one dominant pitched voice and limited background bleed. The product should handle bounded adverse cases gracefully but does not promise clean results from arbitrary mixed or heavily processed audio.

The primary environment is a desktop-class browser. Installation, user accounts and server-side processing are not required.

### 2.4 Product principles

**Musical first.** The editor speaks in notes, cents, beats, bars, tempo and meter while retaining seconds, sample positions and waveform context where useful.

**Non-destructive.** Source audio is immutable. Analysis and edits remain separate data until audition or export. Every edit can be revised, undone or reset.

**Human-correctable.** Automatic analysis is expected to make mistakes. Splitting, joining, reclassifying, remapping and redrawing are normal direct operations.

**Local first.** Audio, MIDI, projects and rendered output remain on the user's device unless the user explicitly exports them.

**Audible quality over nominal correctness.** A mathematically valid transform is not acceptable if it produces avoidable warble, phase smearing, clicks, lost consonants or unstable timbre.

**Simple contributor setup.** A contributor with Node, Rust and RustRover should be able to clone, install the documented WASM tooling and begin work without a C or C++ toolchain.

### 2.5 Explicit non-goals

- Polyphonic source separation or editing multiple simultaneous pitched voices within one mixed track.
- Automatic transcription of complete commercial mixes into stems, notation or MIDI.
- A full DAW, notation package, synthesiser, mastering suite or cloud collaboration platform.
- Perfect repair of heavy reverb, distortion, chorus, clipping or strong accompaniment bleed.
- A mandatory backend, account system, subscription service or cloud-processing pipeline.
- Initial parity with every specialised algorithm or quality mode of established commercial pitch editors.

## 3. Experience model

### 3.1 Editable objects

| Object | Requirement |
| --- | --- |
| Source audio | Immutable imported media and decoded PCM with original sample-rate, channel and identity metadata. |
| Pitch track | Time-varying detected fundamental pitch with confidence, energy context and unvoiced gaps. |
| Blob | Editable note-like region with boundaries, pitch centre, local contour, timing and voiced or unvoiced subregions. |
| Pitch target | Desired pitch through time after interpreting blob movement, drawn curves, correction tools and optional MIDI guidance. |
| MIDI guide | Imported tracks, channels, notes, tempo events, meter events and alignment information. |
| Timeline map | Deterministic relationship among samples, seconds, MIDI ticks, beats and bars, including tempo and time-signature changes. |
| Edit operation | Serializable, undoable user intent applied over immutable evidence rather than destructive media changes. |

Analysis produces observations, not permanent edits. The edit model stores user intent separately. Reanalysis must not silently destroy user edits.

### 3.2 Main editor surface

- A vertical pitch grid labelled by piano key or note name, with octave context and optional cents guides.
- A horizontal timeline that can show clock time and bars or beats. Bars and beats are the principal musical view when a tempo map is available.
- Waveform context behind or adjacent to blobs without overpowering pitch information.
- Distinguishable layers for detected pitch, pitch target, blob bounds, selection, handles, playhead, loop range, MIDI notes, confidence and unvoiced material.
- Smooth zoom and pan that do not alter edit meaning or make controls impractical to acquire.
- A modern fluent visual language using concise SVG iconography, tooltips, contextual hints and toasts rather than persistent verbose prose.
- Semantic DOM controls for commands and settings even where the editor itself uses a GPU or canvas renderer.

### 3.3 Interaction requirements

- Direct manipulation should change the visible object being dragged and preview the result before commitment.
- Free dragging, snapping, modifiers, fine adjustment and numeric entry should coexist.
- Selection, split, pitch, curve or pen, line, smoothing, timing and audition behaviours must be visually unambiguous.
- Undo and redo cover all musical edits, segmentation, mappings, alignment and tempo or meter changes.
- Reset can target an appropriate point, span, blob, selection or project.
- Original, detected, targeted and rendered states remain inspectable rather than silently replacing one another.
- Errors, unsupported capabilities and degraded modes should be explained where they affect the user, not hidden in developer logs.

## 4. Feature priorities

### 4.1 Core capabilities

Core defines the smallest coherent product: import a vocal, understand its pitch, edit pitch and timing, hear the processed result, save the work and export it.

| Capability | Requirement | Acceptance signal |
| --- | --- | --- |
| Audio import | Load common uncompressed and compressed audio using browser-compatible decoding or compatible Rust support. Preserve source facts. | A normal vocal file opens without external conversion. |
| Pitch analysis | Estimate continuous F0, confidence or voicing, energy and unvoiced spans at sufficient temporal resolution for bends and vibrato. | The displayed track agrees perceptually with representative clean vocals. |
| Blob segmentation | Produce provisional regions using silence, voicing, pitch movement, energy and onset evidence. | Most sustained notes become useful editable units. |
| Manual segmentation | Split at arbitrary times, join compatible neighbours, move boundaries and correct voiced or unvoiced classification. | Analysis mistakes do not block editing. |
| Pitch-centre editing | Move one or more blobs by semitone, cents, scale step or free amount while preserving local contour by default. | Note centres change predictably without flattening expression. |
| Curve editing | Add, move and remove anchors; draw freehand or straight targets; smooth and reset bounded spans; edit entrances and tails independently. | Transitions can be intentionally reshaped. |
| Timing editing | Move blobs and adjust start, end or duration without inherently changing pitch. | Notes can be aligned while surrounding audio remains intelligible. |
| Processed playback | Play, pause, seek, loop, and compare edited and original states from the playhead. | Controls alter audible playback rather than only visuals. |
| Local project state | Preserve source identity, analysis, edits, musical maps, view state and schema versions locally. | Work can be closed and reopened without losing intent. |
| WAV export | Deterministically render a selected range or the full result with all active edits. | Reimported output matches auditioned timing and pitch intent. |

### 4.2 Wanted capabilities

Wanted capabilities make Axys practical for repeated musical work and distinguish it from a basic automatic pitch corrector.

| Capability | Requirement | Acceptance signal |
| --- | --- | --- |
| MIDI import | Import Standard MIDI Files, expose tracks and channels, and display selected notes over the vocal. | The intended melody guide can be selected. |
| MIDI as target | Use MIDI as optional pitch, onset, duration or combined guidance without discarding vocal analysis. | The vocal can follow score intent with controllable strength. |
| MIDI alignment | Provide a global offset and precise anchors. Reveal mismatches instead of silently guessing. | Initial alignment and later drift can be diagnosed separately. |
| Tempo and meter maps | Preserve tempo changes, time-signature changes, bar numbering, beat subdivision, pickup handling and snap resolution. | The musical ruler remains correct across changes. |
| Manual musical map | Permit a project tempo and meter map when MIDI metadata is missing or unsuitable. | Audio-only projects can use a deterministic musical grid. |
| Pitch-scale tools | Display a chosen key or scale, quantise by an amount and exclude selected notes from automatic correction. | Correction can follow musical context without forcing it. |
| Modulation controls | Control drift and vibrato depth, and expose rate or regularity only where supported reliably. | Strong correction need not erase all expression. |
| Formant handling | Preserve vocal character during pitch movement and optionally expose an independent formant adjustment. | Moderate shifts avoid obvious chipmunk or giant artefacts. |
| Higher-quality export | Permit a slower offline rendering path when it measurably improves fidelity. | Export improves quality without changing edit interpretation. |
| Comparison tools | Switch between the processed and the original audio, compare detected and target pitch, and level-match where practical. | Users can judge whether an edit improved the result. |

### 4.3 Nice-to-have capabilities

These are valuable extensions but must not complicate the central note-and-curve workflow or redefine Axys as a DAW.

| Capability | Requirement |
| --- | --- |
| Multiple references | Display additional audio or MIDI references while retaining one editable monophonic vocal lane. |
| Advanced mapping | Explicitly map one blob across several MIDI notes or several blobs to one note for melismas and segmentation differences. |
| Groove and swing | Represent swung subdivisions or groove references separately from the base tempo map. |
| Markers and regions | Named markers, comments, colour labels and export regions. |
| Interchange | Export detected or edited pitch as MIDI or documented data and support a documented project interchange format. |
| Offline PWA shell | Cache the application and support install-like launching or file associations where browser support permits. |
| Native wrapper | Permit later desktop packaging without requiring the core editor or processing model to be rewritten. |
| Accessibility depth | Keyboard-complete editing, scalable contrast themes, alternate pitch encodings and deeper screen-reader support. |

## 5. Pitch, blobs and curves

### 5.1 Pitch representation

- Store pitch continuously rather than only as integer MIDI notes. Fractional semitone or cents precision must survive analysis, editing and serialization.
- Distinguish detected pitch, statistical blob centre and user target. Moving a centre must not erase the original evidence.
- Represent unvoiced content and low-confidence analysis without fabricating stable pitch.
- Support configurable concert reference tuning and an explicit accidental naming convention.
- Retain enough curve resolution for bends, scoops, falls, vibrato and short transitions without presenting raw frame noise as deliberate musical intent.

### 5.2 Blob behaviour

- A blob boundary is a musical segmentation decision, not necessarily a destructive audio cut.
- A blob may contain voiced and unvoiced subregions so attached consonants can be treated differently from vowels.
- Moving a blob in pitch normally translates its target contour while preserving deviations unless another tool explicitly reduces them.
- Moving or resizing a blob must have defined behaviour for gaps, overlaps, neighbours and attached consonants. Preview the selected behaviour.
- Split and join operations preserve audible continuity and existing edits as far as the resulting segmentation permits.
- Overlaps, truncation and generated gaps caused by timing edits must be visible before export.

### 5.3 Pitch-curve editing

| Operation | Requirement |
| --- | --- |
| Local bend | Change a bounded span and reconnect smoothly to untouched pitch on either side. |
| Control points | Create anchors with editable time, pitch and interpolation character. |
| Freehand pen | Convert a gesture at the current zoom into a stable curve with controllable simplification or smoothing. |
| Line or ramp | Create a straight or curved transition between endpoints. |
| Smooth | Reduce local jitter or modulation by an amount rather than replacing the contour wholesale. |
| Reset | Restore detected or original-relative behaviour for the selected span. |

Imported pitch should sound unchanged when no target-changing edit is active. Any simplified editable representation must preserve the original detected contour as immutable evidence and need not force a finite editable curve to pass through every analysis frame. The rendered target can combine the editable representation with preserved residual detail where required.

### 5.4 Timing and transient handling

- Pitch and time transforms are independently controllable.
- Consonants, plosives, breaths and sibilants must not be naively forced to pitched targets.
- Boundary and stretch behaviour should minimise clicks, duplicated attacks, swallowed consonants and unstable transitions.
- Source duration outside a changed region remains stable unless the user deliberately chooses ripple-like behaviour.
- Realtime preview and offline export interpret the same canonical target and time maps.

## 6. MIDI, tempo, meter and timeline

### 6.1 MIDI as reference and intent

Imported MIDI remains immutable and separately inspectable. The user chooses whether it is visual guidance only or contributes pitch and timing targets. Original audio analysis remains available in every mode.

Support visual-only, pitch-only, timing-only and combined guidance. MIDI-derived proposals must be visible and reversible. Manual curve edits and MIDI-derived intent must coexist without one silently overwriting the other.

### 6.2 Track selection and eligibility

- List tracks and channels using embedded names where available.
- Allow visibility, mute, solo and guide selection where relevant.
- Detect overlapping notes in a monophonic guide and apply a documented policy or require user resolution.
- Do not interpret percussion tracks as vocal pitch by default.
- Preserve useful metadata such as velocity without making it a mandatory vocal control.

### 6.3 Mapping blobs to MIDI notes

- Automatic proposals may consider temporal overlap, pitch proximity, ordering and confidence.
- Show unmapped, multiply mapped and conflicting objects.
- Never silently delete blobs or MIDI notes to force one-to-one correspondence.
- Permit manual reassignment and per-object opt-out.
- Keep the common one-blob to one-note workflow simple while supporting later melisma and segmentation-mismatch handling.

### 6.4 Alignment

- Support a user-defined relationship between audio zero and MIDI musical time.
- Provide precise anchor operations such as aligning a selected MIDI onset with the playhead or a detected blob onset.
- Distinguish incorrect global offset from an incorrect tempo map.
- Changing guide alignment must not destructively shift source audio unless the user explicitly requests an audio timing edit.

### 6.5 Tempo and meter maps

Represent tempo and meter as ordered maps rather than single project-wide values.

The model must support:

- MIDI pulses or ticks per quarter note;
- MIDI tempo events;
- time-signature numerator and denominator changes;
- deterministic conversion among ticks, beats, bars, seconds and samples;
- bar numbering and beat accents across meter changes;
- musical origins before or after audio zero for pickups;
- manual maps when MIDI metadata is absent or unsuitable;
- visible snapping to notes, blobs, transients, beats and subdivisions;
- clock-time and bars-or-beats display modes.

Do not flatten imported tempo maps or discard meter information silently.

Define and test behaviour when MIDI begins before or after audio, extends beyond it, contains multiple tracks, contains overlapping notes, changes tempo between notes, changes meter during a sustained note, or disagrees substantially with the performed rhythm.

### 6.6 Intent precedence

The product must define how MIDI guidance, manual drawing, blob movement, scale correction and timing edits compose when they disagree. The model must be visible, reversible and localisable per region. No source of intent may silently erase another.

## 7. Playback, rendering and audio quality

### 7.1 Transport

- Play, pause, stop, seek, loop selection and configurable return-to-start behaviour.
- Keyboard transport shortcuts.
- A playhead aligned across waveform, pitch, MIDI and ruler layers.
- Optional count-in and metronome driven by the same tempo and meter maps as the timeline.
- Scrubbing or short-region audition where feasible without destabilising ordinary playback.

### 7.2 Processing separation

Realtime playback must remain bounded and separate from expensive analysis and offline rendering. Avoid allocation, blocking coordination, DOM work and unbounded processing in the realtime audio path.

Pitch analysis, segmentation, waveform generation, project migration and high-quality rendering should run outside the realtime callback and support progress, cancellation and failure reporting.

Preview may trade fidelity for latency, but it must preserve target curves, timing, alignment and boundaries. Stale, missing or failed preview regions must be reported rather than presented as valid output.

### 7.3 Audible quality bars

| Quality | Requirement |
| --- | --- |
| Pitch fidelity | Rendered F0 follows the target within documented tolerance on voiced analysable material. |
| Continuity | Ordinary edit boundaries do not introduce clicks or abrupt pitch or phase discontinuities. |
| Timbre | Moderate pitch movement retains recognisable speaker identity and avoids unnecessary formant movement. |
| Transients | Consonants and attacks remain intelligible and sensibly placed during time edits. |
| Modulation | Vibrato and bends are retained, reduced or replaced only according to explicit settings. |
| Determinism | Equivalent input, project state and render settings produce equivalent output. |
| Safety | Failure falls back to the unprocessed source or to silence rather than uncontrolled output. |

Natural-sounding transformation is an iterative engineering target. Functional, replaceable implementations take priority over pretending initial DSP is mature. Known artefacts and unsupported material must be documented honestly.

### 7.4 Export

- Export PCM WAV with explicit sample-rate and bit-depth choices and protection against accidental clipping.
- Export the full project or selected range.
- Define whether timeline offset becomes leading silence or exported metadata.
- Report failed, unsupported or partially rendered spans before producing a final file.
- Treat dither, normalisation, compressed formats and MIDI or data export as separate optional concerns.

## 8. Application and technical constraints

### 8.1 Required languages

- Use TypeScript for the browser application and UI-facing code.
- Use Rust compiled to WebAssembly for application-owned DSP, audio analysis, MIDI and time-map processing, and other performance-sensitive numerical work.
- HTML, CSS, WGSL, JSON, TOML and small platform-specific scripts or configuration files are permitted where appropriate.
- Do not add C, C++, C# or other native-language source components to the application.
- Do not link C or C++ DSP libraries into the WebAssembly build.
- Do not require Python as a project build dependency.

Ordinary Node development tooling is acceptable when it does not create a production server requirement or require contributors to compile native C or C++ dependencies locally.

The development workflow must not require MSVC, Visual Studio Build Tools, Clang, GCC, CMake or a C or C++ package manager.

### 8.2 Rust and WebAssembly boundary

- Keep the TypeScript-to-WASM API explicit, narrow and independently testable.
- Avoid unnecessary copying of large audio buffers across the boundary.
- Use stable serialisable contracts for analysis, edit and timeline data.
- Isolate specialised DSP behind replaceable interfaces so implementations can be compared without rewriting the UI or project model.
- Prefer compatible Rust crates for foundations such as FFT, resampling, filters, numerical operations, audio parsing, MIDI parsing, serialization and browser bindings.
- Implement missing specialised DSP in Rust using published algorithms, papers and original engineering work.

### 8.3 Browser architecture

Axys is entirely client-side and local-first. Do not introduce a required backend, database, application server, server-side rendering system, account system, cloud-processing service, telemetry service or upload service.

Browser capabilities worth evaluating include Web Audio, AudioWorklet, Web Workers, IndexedDB, Origin Private File System, WebGPU, WebGL, Canvas 2D, WebCodecs and PWA APIs. Their mention is not a requirement to use all of them.

Prefer WebGPU for the main editor renderer when measurement shows a real benefit. Feature-detect it and provide either a suitable fallback or a clear unsupported-browser state.

Do not make cross-origin isolation, `SharedArrayBuffer`, WASM threading or WebGPU mandatory for basic operation. If threading or isolation is an optimisation:

- detect it at runtime;
- retain a functional single-threaded path;
- show a performance warning beside the relevant setting;
- show a first-startup toast explaining the degraded mode;
- document optional host headers.

### 8.4 Security and privacy

- Treat audio, MIDI and project files as untrusted structured input.
- Bound allocation, event counts, durations and parsing work.
- Reject malformed timing divisions, impossible sizes and pathological metadata without damaging the open project.
- Keep processing isolated from durable project state where practical.
- Do not send source audio, derived vocal data or project material over the network in the core workflow.
- Any later optional network feature must identify exactly what leaves the device and require explicit participation.

## 9. Project persistence

Persist projects locally without a remote service. The project model must preserve:

- source-audio identity, fingerprint and relevant metadata;
- analysis results or deterministic analysis parameters and version;
- blobs and voiced or unvoiced subdivisions;
- pitch targets, curves and control points;
- timing transforms;
- imported MIDI and selected guides;
- tempo and meter maps;
- audio-to-MIDI alignment and mappings;
- tuning, key and scale information;
- exclusion and reset states;
- application and project-format versions;
- relevant editor view state.

Use explicit schema versioning and migration. Large derived caches may be discarded if rebuilding them cannot lose user intent.

Autosave or recovery should protect meaningful work while retaining explicit save, export and version choices. Do not keep the only recoverable project state in an opaque browser cache. Provide explicit project import and export.

Relinking must verify media identity rather than silently accepting a different file.

## 10. Licensing requirements

### 10.1 Axys licence

License all application-owned source code under `AGPL-3.0-or-later`.

Axys may be used, modified, redistributed, sold or offered as a paid hosted service subject to the AGPL. Modified versions distributed to users or offered for network interaction must provide the corresponding source as required by that licence.

Do not add non-commercial, field-of-use, anti-business or other custom restrictions. These would make the project less interoperable and may prevent it from qualifying as open source.

Include:

- the complete AGPL-3.0 text in `LICENSE`;
- appropriate SPDX identifiers in application-owned source files;
- `THIRD_PARTY_LICENSES.md`;
- all required attribution and asset notices;
- an accessible Source Code entry within the application;
- production build metadata identifying the source revision.

The Source Code entry should resolve to the corresponding repository and revision when configured. Document how forks and third-party hosts supply their own source repository information.

### 10.2 Dependency and asset policy

- Dependencies must be compatible with `AGPL-3.0-or-later`.
- Do not use proprietary, commercial-only, non-commercial, source-available or otherwise incompatible code or assets.
- Do not copy implementation code from incompatible projects.
- Published algorithm descriptions and papers may be used as references; cite material that materially guides an implementation.
- Record accepted and rejected dependency decisions when licensing, maintenance or portability is significant.
- Keep test fixtures short and redistributable under documented compatible terms.

## 11. Development workflow

### 11.1 Repository and RustRover

The repository must open directly as a RustRover project.

Commit shared run configurations under `.run/` for:

- complete local development;
- tests;
- production build;
- Rust/WASM build or watch operation where separate;
- local production preview.

The main development configuration must start everything needed for interactive browser testing, including the frontend development server and Rust-to-WASM build or watcher.

Do not commit user-specific IDE state or the complete `.idea` directory. Follow current official JetBrains guidance for shared settings and ignored state.

### 11.2 Canonical commands

Provide platform-independent package scripts where practical:

```text
npm run dev
npm run build
npm run test
npm run lint
npm run check
npm run doctor
npm run preview
```

`npm run dev` must launch the complete local development environment after prerequisites and dependencies are installed.

`npm run check` should run the relevant fast Rust, TypeScript and integration validation.

`npm run doctor` should report actionable diagnostics for incompatible Node or Rust versions, a missing WASM target or tool, unsupported browser capabilities, unavailable WebGPU, insecure context, audio permission or autoplay restrictions, and unavailable optional threading features.

Document PowerShell and Bash or Git Bash commands where they differ. Pin or declare Node and Rust versions, commit dependency lockfiles, and document required WASM tooling.

### 11.3 Engineering practice

- Keep the repository buildable and runnable throughout implementation.
- Prefer small modules with explicit state ownership.
- Avoid hidden global mutable state, unnecessary service layers and speculative abstractions.
- Keep the source audio immutable and edits serialisable.
- Keep the realtime path bounded and observable.
- Record material implementation decisions and unresolved DSP limitations in `docs/decisions.md`.

## 12. Static deployment

The production output must be ordinary static files in a directory such as `dist/`. It must not require a permanently running Node, Rust or application server.

Support static hosting on Cloudflare Pages, GitHub Pages, GitLab Pages, Render Static Sites, Netlify and equivalent hosts.

The build must support both a domain root and a repository subpath. Do not hardcode a hostname, origin or deployment path. Load JavaScript, CSS, WASM, workers, shaders and other assets through browser-compatible paths. Serve WASM with correct MIME handling.

Production deployment requires HTTPS because relevant browser capabilities may require a secure context.

No paid hosting service is required. Repository configuration and documentation may be produced, but no real deployment or domain change should occur without explicit authority.

### 12.1 Cloudflare Pages

Treat Cloudflare Pages as the primary documented target. Document:

- build command and output directory;
- Node version and non-secret build variables;
- repository integration and preview deployments;
- root and custom-domain setup;
- cache behaviour;
- required or optional `_headers` configuration;
- source repository and revision metadata.

Do not make optional cross-origin-isolation headers mandatory.

### 12.2 GitHub Pages

Include a GitHub Actions workflow that installs the declared Node and Rust versions, installs the WASM target and tooling, restores locked dependencies, runs validation and the production build, uploads the static artefact, and deploys it to GitHub Pages.

Account for project-site subpaths and document the repository settings needed to enable Actions-based Pages deployment.

## 13. Validation and testing

### 13.1 Deterministic automated coverage

Test at least:

- frequency, MIDI note and cents conversion;
- pitch-curve evaluation and interpolation;
- pitch correction transforms;
- sample, seconds and original-to-edited time conversion;
- MIDI tick, beat, bar and time conversion;
- tempo changes and meter changes;
- pickup or musical-origin handling;
- MIDI and audio alignment;
- blob creation, splitting, joining and boundary editing;
- non-destructive composition and reset of edits;
- project serialization and migration;
- Rust/WASM APIs and TypeScript integration;
- static asset loading at `/` and repository subpaths;
- malformed or adversarial import limits.

### 13.2 DSP fixtures

Maintain representative, compatibly licensed fixtures and reference renders for:

- sustained vowels;
- vibrato and drift;
- scoops, falls and slides;
- rapid transitions;
- breathy or near-spoken vocals;
- unvoiced consonants, plosives and sibilants;
- octave ambiguity and low-confidence detection;
- moderate and large pitch movement;
- time expansion and compression;
- simultaneous pitch and timing edits;
- tempo and time-signature changes in MIDI guides.

Automatic checks should measure relevant F0, timing, discontinuity, peak and determinism properties. Document a repeatable level-matched listening procedure for perceptual qualities that numerical checks cannot establish.

### 13.3 Performance envelope

Declare baseline hardware and browsers rather than claiming universal realtime performance. A representative project contains one several-minute mono vocal at 44.1 or 48 kHz, one MIDI guide, fine-grained analysis data and continuous playback while the editor redraws.

Measure UI frame time, interaction latency, analysis cancellation, memory use, preview generation and playback underruns. Performance should degrade explicitly and gracefully when optional acceleration is unavailable.

### 13.4 Core workflow acceptance

1. Import a clean solo vocal and obtain a navigable pitch track with provisional blobs.
2. Repair an incorrect boundary without rerunning the entire analysis.
3. Move a note centre, reshape its entrance or tail, and change timing independently.
4. Loop the region and compare processed and original playback.
5. Save and reopen the project without losing audible intent.
6. Export WAV whose pitch and timing match the active edits.

### 13.5 MIDI workflow acceptance

1. Import MIDI, choose a melody track or channel, and display its notes against the vocal grid.
2. Align a known MIDI onset to the recording.
3. Diagnose later drift through the tempo map rather than hiding it with an offset.
4. Preserve correct bar lines, beats, playhead readout and metronome behaviour through tempo and meter changes.
5. Select visual-only, pitch-only, timing-only or combined guidance.
6. Override individual mappings without destroying source analysis or manual curves.

### 13.6 Completion checks

Before considering implementation complete:

- Core capabilities must be functional rather than placeholders or silent stubs.
- Editing must alter actual processed playback or deterministic rendering.
- Rust tests, TypeScript tests and integration tests must pass.
- Formatting, lint and type checks must pass.
- The production build and local production preview must succeed.
- Root and repository-subpath deployments must be tested.
- WASM and worker assets must load correctly.
- Basic operation must work without mandatory cross-origin isolation.
- Local persistence and explicit project import or export must work.
- Audio and MIDI import, tempo changes and meter changes must be verified.
- Source-code and third-party licence notices must be present and accurate.

## 14. Technology investigation map

These are research directions rather than prescribed implementations.

### 14.1 Analysis

- YIN and pYIN-family F0 estimation;
- McLeod pitch methods;
- autocorrelation and cepstral approaches;
- voiced or unvoiced classification;
- confidence calibration;
- energy, onset, pitch-change and hysteresis segmentation.

### 14.2 Transformation

- PSOLA and TD-PSOLA;
- WSOLA;
- phase-vocoder variants with transient handling;
- sinusoidal models;
- source-filter analysis and resynthesis;
- formant envelope estimation;
- continuously varying pitch targets;
- hybrid preview and offline rendering strategies.

### 14.3 Browser execution and rendering

- AudioWorklet with WASM;
- Web Workers and transferable buffers;
- optional shared memory and threading;
- WebGPU, WebGL and Canvas rendering tradeoffs;
- GPU hit-testing and text-rendering implications;
- browser codec and file-system support;
- capability detection and reduced-function operation.

### 14.4 Evaluation questions

- Does the method follow arbitrary target curves without losing intelligibility or stable phase?
- How are consonants attached to blobs and preserved through timing changes?
- How are melisma, rests, overlaps and segmentation differences represented during MIDI mapping?
- Can preview and high-quality rendering share one canonical interpretation of edits?
- At what shift size does formant treatment become necessary for representative voices?
- Which browser limitations materially alter supported file length, latency or quality?

## 15. Required recorded decisions

The implementation must eventually decide and record:

- what dragging each blob edge means;
- how timing edits treat gaps, overlaps and neighbours;
- whether MIDI guidance updates live or is committed as an undoable operation;
- how intent sources compose and take precedence;
- how interpolation crosses blob and voiced or unvoiced boundaries;
- which project data is embedded, cached or externally linked;
- supported browsers, file durations and hardware envelope;
- preview and export quality differences;
- chosen pitch-analysis and resynthesis methods;
- all material dependency and licensing decisions.

## 16. Interface design system

Every value the chrome draws with is a token. A number written into a rule is a number nobody can
change consistently later, so a literal in `web/src/styles.css` outside `:root` is a defect.

### 16.1 Tokens

| Scale | Tokens | Permitted use |
| --- | --- | --- |
| Spacing | `--axys-space-1` 4px, `-2` 8px, `-3` 12px, `-4` 16px, `-6` 24px | Every gap, margin and padding. A 4px base, so nothing lands off the grid. |
| Radius | `--axys-radius-sm` 4px, `--axys-radius` 6px, `--axys-radius-lg` 10px, `--axys-radius-pill` 999px | `sm` for a control inside a control, the default for a control, `lg` for a dialog, `pill` for a thumb. |
| Elevation | `--axys-elevation-1` `0 1px 2px`, `-2` `0 4px 12px`, `-3` `0 12px 32px` | 1 raised controls, the inspector rail, the mixer bar. 2 menus, dropdowns, tooltips. 3 dialogs, toasts, the backdrop layer. |
| Weight | `--axys-weight-body` 400, `--axys-weight-control` 500, `--axys-weight-strong` 600 | Body text, a control's own label, a heading or a checked state. |
| Size | `--axys-size-sm` 12px, `--axys-size-md` 13px, `--axys-size-lg` 16px | Secondary text, body and controls, headings. 12px is the floor everywhere, canvas labels included. |
| Duration | `--axys-duration-fast` 90ms, `-base` 150ms, `-slow` 240ms | See 16.3. |
| Easing | `--axys-ease-standard`, `-enter`, `-exit` | Standard for a move, enter for something arriving, exit for something leaving. |
| Icon | `--axys-icon` | 20px in the toolbar and tool palette, 16px everywhere else. No third size. |

Colour tokens are listed in `web/src/ui/theme.ts`, and the eight derived from the accent are
generated by `web/src/ui/accent.ts` rather than authored. Nothing outside those two files names a
colour.

Focus is a two-layer `box-shadow` ring, 1px of `bg` inside and 2px of `focus` outside, never an
outline: a shadow follows whatever radius the element already has.

### 16.2 Component inventory

Every control is defined once, in `web/src/ui/controls/`. A container arranges controls; it does
not restyle them.

| Control | Built by | Rest | Hover | Active | Disabled | Focus | Checked |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Button | `controls/button.ts` | `surface-raised` on `border` | `border-strong`, sunken ground | Pressed down one pixel | 45% opacity, default cursor | Ring | n/a |
| Toggle | `controls/button.ts` | As button | As button | As button | As button | Ring | `accent` ground, `accent-text`, glyph swapped |
| Segmented set | `.axys-segmented` | Buttons joined, one border between | As button | As button | As button | Ring, raised above its neighbours | As toggle |
| Number field | `controls/field.ts` | Sunken ground, tabular figures | `border-strong` | Dragging, page unselectable | 45% opacity | Ring | n/a |
| Slider | `controls/field.ts` | Track in `border`, thumb in `accent` | Thumb grows | Thumb held | 45% opacity | Ring on the thumb | n/a |
| Checkbox | `controls/field.ts` | Native box, `accent-color` | Native | Native | 45% opacity | Ring | `accent` fill |
| Select | `controls/select.ts` | Sunken ground, chosen face and caret | `border-strong` | List open, `accent` border | 45% opacity | Ring | Mark against the open list's chosen row |
| Menu item | `ui/menu.ts` | Transparent, muted icon column | `accent` ground, `accent-text` | As hover | 45% opacity | As hover | Mark after the label |
| Tab | `.axys-tab` | Transparent, muted text | Text brightens | n/a | 40% opacity | Ring | Raised ground, full-strength text |

A control that would be a tenth row here is a control that should have been one of the nine.

### 16.3 Motion

| Animation | Duration | Easing |
| --- | --- | --- |
| Tooltip fade | fast | standard |
| Menu and dropdown enter | fast | enter |
| Menu and dropdown exit | fast | exit |
| Toast enter | base | enter |
| Toast exit | fast | exit |
| Dialog and backdrop enter | base | enter |
| Inspector and mixer fold | base | standard |
| Toolbar label toggle | base | standard |
| Theme and accent change | slow | standard |
| State icon swap | fast | standard |

Never animate the playhead, a canvas drag, a value scrub, zoom, or anything else the editor drives
per frame. Latency reads as lag in an editor.

### 16.4 Writing style

Strings follow the GNOME Human Interface Guidelines. It is written for desktop application chrome
rather than for marketing pages, and it matches the house style already in use.

- Header capitalisation for anything that is not a sentence: buttons, menu items, switch labels,
  tooltips, headings.
- Sentence capitalisation for checkboxes, radio buttons, body text and dialog description lines.
- A tooltip is at most one sentence, and short.
- A tooltip never repeats the label beside it. Either supplement it or rephrase it.
- Every control in a container has a tooltip, or none of them do. Mixed is worse than absent.
- Standard labels for standard controls. Do not invent a synonym for Back, Search or Main Menu.
- A menu or search tooltip may name what it applies to: Search Documents, Document Menu.
- No period on a heading, a description, or a single-sentence string.
- Ellipsis only where further input or confirmation follows.
- Familiar task words, not system jargon. No Latin abbreviations, write "for example".
- Never build one sentence across two controls. It breaks translation and screen readers.
- No rationale in a label. A control says what it does, never why it exists.
- No tooltip carries essential information on its own. It is unreachable on touch and often
  unreachable to assistive technology.
- A toggle's tooltip names what pressing it will do, and follows the state icon.

## 17. Glossary

| Term | Meaning |
| --- | --- |
| Blob | A visible editable region representing a note-like portion of analysed vocal audio. |
| F0 | Fundamental frequency, the primary periodic frequency perceived as pitch. |
| Pitch centre | A representative pitch for a blob, distinct from its continuous track. |
| Pitch track | Detected pitch as a function of time, including fractional semitone values and gaps. |
| Pitch target | Desired pitch as a function of time after interpreting active edits and guidance. |
| Voiced | Audio with sufficiently periodic structure for stable pitch estimation. |
| Formants | Vocal-tract resonances that strongly affect perceived voice identity and vowel character. |
| Tempo map | Ordered tempo events used to convert musical positions to elapsed time. |
| Meter map | Ordered time-signature events defining beat grouping and bar boundaries. |
| PPQ | MIDI pulses per quarter note. |
| PSOLA | Pitch-synchronous overlap-add, a family of time and pitch transformation methods. |
| WSOLA | Waveform-similarity overlap-add, a family of time-stretching methods. |
| Phase vocoder | A frequency-domain analysis and resynthesis method used for time and pitch modification. |
| WASM | WebAssembly, the portable binary format used for the Rust processing core. |
| AudioWorklet | Browser facility for custom low-latency audio processing outside the main UI thread. |
