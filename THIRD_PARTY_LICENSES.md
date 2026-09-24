# Third-party licences

Axys itself is licensed under `AGPL-3.0-or-later`; see [LICENSE](LICENSE).

Everything listed below is compatible with `AGPL-3.0-or-later`. No proprietary, non-commercial or
source-available component is used, and no implementation code has been copied from an incompatible
project.

## Shipped in the build

These crates compile into the WebAssembly module in `dist/`.

| Crate                                    | Licence                              |
| ---------------------------------------- | ------------------------------------ |
| `arrayvec`                               | MIT OR Apache-2.0                    |
| `bitflags`                               | MIT OR Apache-2.0                    |
| `bumpalo`                                | MIT OR Apache-2.0                    |
| `bytemuck`                               | Zlib OR Apache-2.0 OR MIT            |
| `cfg-if`                                 | MIT OR Apache-2.0                    |
| `console_error_panic_hook`               | MIT OR Apache-2.0                    |
| `encoding_rs`                            | (Apache-2.0 OR MIT) AND BSD-3-Clause |
| `extended`                               | MIT                                  |
| `js-sys`                                 | MIT OR Apache-2.0                    |
| `itoa`                                   | MIT OR Apache-2.0                    |
| `lazy_static`                            | MIT OR Apache-2.0                    |
| `log`                                    | MIT OR Apache-2.0                    |
| `memchr`                                 | Unlicense OR MIT                     |
| `midly`                                  | Unlicense                            |
| `num-complex`                            | MIT OR Apache-2.0                    |
| `num-integer`                            | MIT OR Apache-2.0                    |
| `num-traits`                             | MIT OR Apache-2.0                    |
| `once_cell`                              | MIT OR Apache-2.0                    |
| `primal-check`                           | MIT OR Apache-2.0                    |
| `rustfft`                                | MIT OR Apache-2.0                    |
| `serde`, `serde_core`, `serde_derive`    | MIT OR Apache-2.0                    |
| `serde_json`                             | MIT OR Apache-2.0                    |
| `strength_reduce`                        | MIT OR Apache-2.0 OR Zlib            |
| `symphonia` and its `symphonia-*` crates | MPL-2.0                              |
| `transpose`                              | MIT OR Apache-2.0                    |
| `wasm-bindgen` and its macro crates      | MIT OR Apache-2.0                    |
| `zmij`                                   | MIT                                  |

No JavaScript library is bundled into `dist/`. The application's own TypeScript is the only script
that ships.

### Icons

Lucide 1.47.0, ISC licensed. No package is installed: `scripts/build-icons.mjs` fetches the
fifty-odd glyphs named in `scripts/icon-map.json` from the CDN and writes
`web/src/ui/icons.ts`, which is committed. `lucide-static` unpacks to roughly 50MB for that
handful, and a runtime icon dependency would break `currentColor` theming.

### Fonts

| Font                                | Licence | Files                                                              |
| ----------------------------------- | ------- | ------------------------------------------------------------------ |
| Atkinson Hyperlegible Next Variable | OFL 1.1 | `web/src/fonts/atkinson-hyperlegible-next-latin-wght-normal.woff2` |
| Atkinson Hyperlegible Mono Variable | OFL 1.1 | `web/src/fonts/atkinson-hyperlegible-mono-latin-wght-normal.woff2` |
| Bravura, subset                     | OFL 1.1 | `web/src/fonts/bravura-subset.woff2`                               |

Both are from the Braille Institute of America and carry the SIL Open Font License 1.1, which the
AGPL permits shipping alongside. The licence reserves the names "ATKINSON" and "HYPERLEGIBLE": a
modified font may not use them. Neither restricts embedding or subsetting, and Axys ships the
upstream Latin upright files unmodified.

Bravura is Steinberg's SMuFL reference font, also OFL 1.1. `scripts/build-music-font.mjs` subsets
it to the six codepoint ranges Axys sets, 316 KB down to 16 KB. The licence reserves the name
"Bravura" and requires a derivative to stay OFL; a subset is a derivative, so the shipped file
remains under OFL 1.1 and is named `bravura-subset.woff2` rather than `Bravura`.

Run `cargo tree --workspace -e normal` for the exact resolved versions of the above, and
`cargo metadata --format-version 1` for their licence fields as declared upstream.

## Development tooling only

These are npm devDependencies. They build and check the project and are not distributed with it.

| Package                | Licence           |
| ---------------------- | ----------------- |
| `@eslint/js`, `eslint` | MIT               |
| `@types/node`          | MIT               |
| `globals`              | MIT               |
| `npm-run-all2`         | MIT               |
| `prettier`             | MIT               |
| `typescript`           | Apache-2.0        |
| `typescript-eslint`    | MIT               |
| `vite`                 | MIT               |
| `vitest`               | MIT               |
| `wasm-pack`            | MIT OR Apache-2.0 |

Run `npm ls --all` for the exact resolved tree.

## Assets

The application icon, all editor iconography and the colour themes are original work by the Axys
authors, covered by the project licence. No third-party font, icon set or image is bundled.

## Test fixtures

Audio and MIDI fixtures under `fixtures/` are generated by `fixtures/generate.mjs` from synthesis
code in this repository. They contain no recorded material, so they are covered by the project
licence and are redistributable without further attribution.

## Algorithm references

These papers describe methods Axys implements. They guided the implementations named beside them;
no code was copied from any accompanying release.

- A. de Cheveigne and H. Kawahara, "YIN, a fundamental frequency estimator for speech and music",
  _Journal of the Acoustical Society of America_ 111(4), 2002. Implemented in
  `crates/axys-core/src/analysis/f0.rs`.
- M. Mauch and S. Dixon, "pYIN: a fundamental frequency estimator using probabilistic threshold
  distributions", _ICASSP_, 2014. Candidate selection and the Viterbi pass in the same file.
- E. Moulines and F. Charpentier, "Pitch-synchronous waveform processing techniques for
  text-to-speech synthesis using diphones", _Speech Communication_ 9(5-6), 1990. Implemented in
  `crates/axys-core/src/dsp/psola.rs`.
- F. N. Fritsch and R. E. Carlson, "Monotone piecewise cubic interpolation", _SIAM Journal on
  Numerical Analysis_ 17(2), 1980. Tangent limiting in `crates/axys-core/src/curve.rs`.
