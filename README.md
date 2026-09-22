<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Axys

Local-first monophonic vocal pitch and timing editor.

Axys analyses an isolated vocal into editable note-like regions called blobs, shows the continuous
detected pitch inside them, and lets you reshape pitch and timing while the voice still sounds like
the voice. It runs entirely in the browser. No account, no server, no upload.

The name is a double entendre on axis, for movement along the time and pitch axes, and on Axolotl.

## What it does

- Import a vocal, get a pitch track and provisional blobs.
- Split, join and re-bound blobs when the analysis guesses wrong, without reanalysing.
- Move note centres in semitones, cents or scale steps while local contour is preserved.
- Draw, smooth, ramp and reset pitch curves, with entrances and tails editable independently.
- Move notes in time and change their length without changing their pitch.
- Import a MIDI guide, align it, and use it for pitch, timing, both or nothing at all.
- Keep tempo and meter maps, bars, beats and pickups correct across changes.
- Audition the processed result against the original, loop a region, and compare.
- Save locally and export WAV that matches what you heard.

## Requirements

- Node 20.19 or newer (see `.nvmrc`).
- Rust stable 1.82 or newer with the `wasm32-unknown-unknown` target (see `rust-toolchain.toml`).
- No C or C++ toolchain. No MSVC, Clang, GCC, CMake or Python.

## Getting started

PowerShell and Bash take the same commands here.

```bash
npm install
npm run doctor
npm run dev
```

`npm run dev` starts the Vite dev server and the Rust-to-WASM watcher together, which is everything
needed for interactive browser testing. Open the URL it prints.

`rustup target add wasm32-unknown-unknown` runs automatically from `rust-toolchain.toml` on first
build. `npm run doctor` tells you if anything is missing and how to fix it.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server plus WASM watcher. |
| `npm run build` | WASM release build, type check, then static output in `dist/`. |
| `npm run preview` | Serves the built `dist/` locally. |
| `npm run test` | Rust tests, then TypeScript and integration tests. |
| `npm run lint` | ESLint, Prettier and Clippy. |
| `npm run check` | Fast Rust, TypeScript and integration validation. |
| `npm run doctor` | Environment and browser-capability diagnostics. |
| `npm run format` | Applies Prettier and `cargo fmt`. |

Rust-only shortcuts: `cargo test --workspace`, `cargo clippy --workspace --all-targets`,
`cargo fmt --all`.

## RustRover

The repository opens directly as a RustRover project. Shared run configurations live in `.run/`:

- **Axys dev** is the one to use for interactive work; it starts the dev server and the WASM watcher.
- **Axys build**, **Axys tests**, **Axys check**, **Axys preview**, **Axys doctor**,
  **Axys WASM watch** and **Rust tests** cover the rest.

Only shared project structure is committed from `.idea/`; user state is ignored.

## Layout

```
crates/axys-core   Rust: analysis, DSP, blobs, curves, timeline, MIDI, project model
crates/axys-wasm   The wasm-bindgen boundary, deliberately narrow
web/src            TypeScript: editor, renderer, audio engine, workers, persistence
docs/              Design bible, recorded decisions, core contracts, deployment
fixtures/          Generated, redistributable audio and MIDI test material
.run/              Shared RustRover run configurations
```

`crates/axys-core` is plain Rust with no browser bindings, so every rule in it is unit tested
natively with `cargo test`.

## Deployment

The build is ordinary static files in `dist/` and needs no running server. It works at a domain
root and at a repository subpath, because assets are referenced relatively and no origin is baked
in.

- Cloudflare Pages is the primary documented target: see [docs/deployment.md](docs/deployment.md).
- A GitHub Actions workflow for GitHub Pages is in `.github/workflows/pages.yml`.

HTTPS is required in production because the browser capabilities Axys uses need a secure context.
Cross-origin isolation is not required.

## Privacy

Audio, MIDI, projects and exports stay on your device. Axys makes no network requests after the
page loads.

## Licence

`AGPL-3.0-or-later`. The full text is in [LICENSE](LICENSE), third-party notices are in
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), and the running application links to its own
corresponding source under Help then Source Code.

If you fork Axys or host a modified version, set `AXYS_SOURCE_REPOSITORY` and
`AXYS_SOURCE_REVISION` at build time so that link resolves to your source rather than to this
repository.
