# Axys Design Maturity

**Purpose:** Agreed changes that take the interface from working to mature  
**Status:** Implemented. Kept as the record of what was agreed and why  
**Authority:** Subordinate to `docs/design_bible.md`. Every choice below is settled and every box is ticked; the design system itself now lives in design bible section 16, and each decision is recorded in `docs/decisions.md`.

## 1. Settled choices

| Choice           | Decision                                                       | Licence | AGPL compatible |
| ---------------- | -------------------------------------------------------------- | ------- | --------------- |
| Icon set         | Lucide, `viewBox="0 0 24 24"`, stroke 2, rendered at 20 and 16 | ISC     | Yes             |
| Music glyphs     | Bravura, SMuFL, subset to 16.4 KB                              | OFL 1.1 | Yes             |
| UI typeface      | Atkinson Hyperlegible Next, variable, Latin, upright only      | OFL 1.1 | Yes             |
| Readout typeface | Atkinson Hyperlegible Mono, variable, Latin                    | OFL 1.1 | Yes             |
| Accent identity  | Cerulean, OKLCH hue 248, `#34a4ff` dark and `#006cb5` light    | n/a     | n/a             |
| Window material  | In-app translucency, not system Mica                           | n/a     | n/a             |
| String standard  | GNOME HIG writing style and tooltips                           | n/a     | n/a             |

Bravura reserves the name "Bravura" and derivatives must stay OFL. Atkinson reserves "ATKINSON" and "HYPERLEGIBLE". Neither restricts embedding or subsetting. Add all three to `THIRD_PARTY_LICENSES.md` as they land.

## 2. Token scales

Each scale below replaces one or two values plus a scatter of inline literals.

**Spacing**, 4px base, replacing `--axys-gap` and `--axys-pad`:

`--axys-space-1: 4px`, `-2: 8px`, `-3: 12px`, `-4: 16px`, `-6: 24px`

**Radius**, replacing the nine inline `2px`, `3px`, `4px` and `999px` values:

`--axys-radius-sm: 4px`, `--axys-radius: 6px`, `--axys-radius-lg: 10px`, `--axys-radius-pill: 999px`

**Elevation**, three levels drawn from the existing `shadow` token:

| Token                | Shadow        | Used by                                    |
| -------------------- | ------------- | ------------------------------------------ |
| `--axys-elevation-1` | `0 1px 2px`   | Raised controls, inspector rail, mixer bar |
| `--axys-elevation-2` | `0 4px 12px`  | Menus, dropdowns, tooltips                 |
| `--axys-elevation-3` | `0 12px 32px` | Dialogs, toasts, the backdrop layer        |

**Weight**, currently absent:

`--axys-weight-body: 400`, `--axys-weight-control: 500`, `--axys-weight-strong: 600`

**Size**, revised for the wider face in section 4:

`--axys-size-sm: 12px`, `--axys-size-md: 13px`, `--axys-size-lg: 16px`

- [x] Add the four scales and retire `--axys-gap`, `--axys-pad` and every inline radius.
- [x] Replace the `:focus-visible` outline with a two-layer `box-shadow` ring: 1px of `bg` inside, 2px of `focus` outside. `box-shadow` follows the element's own radius, so the current global `border-radius` override on `:focus-visible` goes away with it.
- [x] Document every token and its permitted use in the design bible.

## 3. Motion

Animations are wanted. `prefers-reduced-motion` is already handled, so all of this collapses under the existing block.

`--axys-duration-fast: 90ms`, `--axys-duration-base: 150ms`, `--axys-duration-slow: 240ms`

`--axys-ease-standard: cubic-bezier(0.2, 0, 0, 1)`, `--axys-ease-enter: cubic-bezier(0, 0, 0, 1)`, `--axys-ease-exit: cubic-bezier(0.3, 0, 1, 1)`

| Animation                 | Duration | Easing   |
| ------------------------- | -------- | -------- |
| Tooltip fade              | fast     | standard |
| Menu and dropdown enter   | fast     | enter    |
| Menu and dropdown exit    | fast     | exit     |
| Toast enter               | base     | enter    |
| Toast exit                | fast     | exit     |
| Dialog and backdrop enter | base     | enter    |
| Inspector and mixer fold  | base     | standard |
| Toolbar label toggle      | base     | standard |
| Theme and accent change   | slow     | standard |
| State icon swap           | fast     | standard |

- [x] Add the duration and easing tokens, retire `--axys-motion`.
- [x] Apply the table above.
- [x] Never animate the playhead, canvas drags, value scrubs, zoom or anything driven per frame by the editor. Latency reads as lag in an editor.

## 4. Typography

Variable wins on size as well as range. Latin upright, measured from Fontsource 5.3.0:

| File                                   | Size    |
| -------------------------------------- | ------- |
| Sans variable, whole weight axis       | 34.0 KB |
| Sans static, one weight                | 12.1 KB |
| Sans static, the three weights we need | 37.5 KB |
| Mono variable, whole weight axis       | 17.8 KB |

- [x] Ship the two variable Latin woff2 files, 51.8 KB total. No italics, no `latin-ext` until localisation lands.
- [x] `--axys-font` becomes Atkinson Hyperlegible Next, `--axys-font-mono` becomes Atkinson Hyperlegible Mono, `system-ui` and `ui-monospace` stay as fallbacks.
- [x] Adopt the revised size scale in section 2. The 11px floor goes; Hyperlegible is drawn for legibility at reading sizes and looks loose below 12px.
- [x] Set `font-variant-numeric: tabular-nums` on the status bar, the inspector numeric fields, the readout layer and the mixer. The sans defaults to proportional lining figures, so readouts jitter in width while a value is dragged.
- [x] Widen the inspector for the wider face: `--axys-inspector-width` 328 to 344, `INSPECTOR_MIN_WIDTH` 240 to 256. The 640 maximum is unchanged.
- [x] Re-measure the toolbar at its narrowest after the swap; it feeds the overflow menu in section 11.
- [x] Bravura needs no typographic pairing. It is set in its own runs at its own size, with baseline and size offsets from the SMuFL metadata, never inherited from body text.

## 5. Iconography

Lucide's own rule is stroke width equal to size over twelve, and it sanctions 16, 20, 24 and 32 as the rendered sizes. Keeping the shipped `viewBox="0 0 24 24"` and `stroke-width="2"` gives that for free: 1.67 at 20px, 1.33 at 16px, against the 1.4 in use today.

- [x] Take Lucide markup unmodified. No stroke overrides, no `non-scaling-stroke`, no regridding to 16.
- [x] Two rendered sizes only. 20px in the toolbar and tool palette, 16px in menus, inspector rows and the status bar.
- [x] `scripts/build-icons.mjs` generates `ui/icons.ts` in its current shape from a checked-in name map, so there is no runtime icon dependency and `currentColor` keeps working. Do not ship `lucide-static`; it unpacks to roughly 50MB.
- [x] Settle the five ambiguous names now, map the rest one to one at migration:

| Current          | Lucide                                     |
| ---------------- | ------------------------------------------ |
| `properties`     | `wrench`                                   |
| `settings`       | `settings`                                 |
| Inspector toggle | `sliders-horizontal`                       |
| `sidebar`        | `panel-right-open` and `panel-right-close` |
| `exclude`        | `circle-minus`                             |

`circle-slash` reads as blocked. `circle-minus` reads as removed from the set, which is what excluding from analysis means.

### 5.1 State icons

Lucide ships open and closed, on and off pairs, and a toggle should swap the glyph rather than only dim one. `IconName` becomes a pair for these, and the control picks by state.

| Control         | On, or open         | Off, or closed       |
| --------------- | ------------------- | -------------------- |
| Inspector fold  | `panel-right-open`  | `panel-right-close`  |
| Mixer fold      | `panel-bottom-open` | `panel-bottom-close` |
| Transport       | `pause`             | `play`               |
| Loop            | `repeat`            | `repeat-off`         |
| Loop one range  | `repeat-1`          | `repeat-off`         |
| Follow playhead | `locate-fixed`      | `locate-off`         |
| Channel mute    | `volume-2`          | `volume-x`           |
| Monitoring      | `mic`               | `mic-off`            |
| Blob excluded   | `eye`               | `eye-off`            |
| Diagnostics     | `bug`               | `bug-off`            |

- [x] Widen `ICONS` to carry state pairs and have the toggles swap on state.
- [x] Where Lucide ships no off variant, and `metronome` and `magnet` are the two that matter here, keep the single glyph and carry the state on the control's pressed styling. Never hand-draw a slashed variant; a bespoke off glyph beside real Lucide pairs is immediately visible.
- [x] `aria-pressed` carries the state regardless of which glyph is showing. The swap is decoration.

## 6. Music glyphs

SMuFL places glyphs in the private use area, so the subset is specified by codepoint like any other font. Measured against the real `Bravura.otf`:

| Subset            | woff2   |
| ----------------- | ------- |
| Accidentals alone | 4.7 KB  |
| The set below     | 16.4 KB |
| Full Bravura      | 316 KB  |
| Full BravuraText  | 447 KB  |

Locked codepoints:

`E260-E264` accidentals, `E1D2-E1DB` noteheads and stemmed notes, `E1E7` augmentation dot, `E4E3-E4E7` rests, `E080-E09F` time signature digits, `ECA0-ECA9` metronome marks

- [x] Add a `pyftsubset --flavor=woff2 --layout-features='*' --no-hinting --desubroutinize` step beside the icon generator, budgeted at 16.4 KB.
- [x] Use Bravura for accidentals, note durations, rests, dotted values and metronome marks. No general icon pack carries these.
- [x] Use U+266F, U+266D and U+266E for sharp, flat and natural in running text, so an ordinary label does not pull the font in.
- [x] Note letters and octave numbers stay in the UI face. Bravura sets the accidental glyph only.
- [x] Give the accidental and snap dropdowns their glyphs once section 7 lands.

## 7. Components

Controls that disagree about their own states are the single biggest tell of an immature interface.

- [x] Component inventory section in the design bible. Every control named once with rest, hover, active, disabled, focus and checked defined.
- [x] Add `ui/controls/` holding button, toggle, field, select and slider primitives, so the toolbar, inspector, mixer and dialogs stop styling the same control three ways.
- [x] Build the select out of `ui/menu.ts`, which already does per-item icons, check marks, disabled state and shortcut hints.
- [x] Replace the three native selects with it: `ui/export-dialog.ts:75`, `ui/export-dialog.ts:86`, `ui/inspector.ts:307`. Native options cannot hold markup, which is what blocks icons in dropdowns today.
- [x] Keep combobox semantics on the replacement: `role="combobox"`, type to select, Home and End, Escape to dismiss, focus returned to the trigger.
- [x] Bring the custom scrollbar and zoom control onto the primitives.

## 8. Accent colour

Accent is not one token. `focus`, `selection`, `selectionFill`, `blobFill`, `blobFillSelected`, `blobBounds` and `accentText` are all derived from it by hand in `ui/theme.ts`.

The current `#4cc2ff` is not a designed colour and is retired. The palette below is generated rather than picked: each accent is an OKLCH hue taken to the sRGB gamut boundary at a fixed lightness, `0.70` in dark and `0.52` in light. That lightness is chosen because blue runs out of gamut early. Above `0.77` every blue washes out to a maximum chroma near `0.12`, while at `0.70` the same hues hold `0.16`.

Derivation rule: an accent supplies a hue and a chroma multiplier. Lightness and the chroma ceiling are fixed per role, so every accent lands on the same contrast relationships.

| Role            | Dark                        | Light                       |
| --------------- | --------------------------- | --------------------------- |
| `accent`        | L 0.70 at the gamut ceiling | L 0.52 at the gamut ceiling |
| `focus`         | L 0.80, chroma x 0.75       | as `accent`                 |
| `selection`     | as `accent`                 | as `accent`                 |
| `selectionFill` | `accent` at 20% alpha       | `accent` at 15% alpha       |
| `blobFill`      | L 0.45 at 35% alpha         | `accent` at 14% alpha       |
| `blobBounds`    | L 0.82, chroma x 0.50       | L 0.45, chroma x 0.70       |
| `accentText`    | black                       | white                       |

`accentText` resolves the same way for all eight, so it is a constant per theme rather than a computed value.

### 8.1 The palette

Every hue sits at least 25 degrees from each semantic layer hue, which are `pitchTarget` 86, `pitchDetected` 163, `midiNote` 300 and `playhead` 347. That leaves three usable arcs, 12 to 61, 111 to 138, and 188 to 275, which is why the set leans blue and green rather than spreading evenly round the wheel. Blue leads because the name plays on both axis and axolotl.

| Name              | Hue | Chroma | Dark      | Contrast on sunken | Light     | Contrast on surface |
| ----------------- | --- | ------ | --------- | ------------------ | --------- | ------------------- |
| Cerulean, default | 248 | 1.00   | `#34a4ff` | 7.32               | `#006cb5` | 5.51                |
| Lagoon            | 212 | 1.00   | `#00b2ca` | 7.62               | `#007687` | 5.33                |
| Sea Glass         | 190 | 1.00   | `#00b6af` | 7.70               | `#007974` | 5.27                |
| Abyssal           | 270 | 1.00   | `#7997ff` | 7.12               | `#3843ff` | 6.15                |
| Kelp              | 130 | 1.00   | `#76b400` | 7.69               | `#4d7800` | 5.25                |
| Coral             | 22  | 1.00   | `#ff6266` | 6.66               | `#c5002b` | 6.16                |
| Ember             | 48  | 1.00   | `#f97000` | 6.81               | `#a74900` | 5.84                |
| Slate             | 248 | 0.35   | `#82a2c1` | 7.31               | `#536c84` | 5.46                |

Slate is Cerulean at a third of its chroma, so the neutral option costs no hue budget and cannot collide with anything. The hexes above are the computed values; they are the expected output of the derivation, not a hand-maintained table.

All eight clear 4.5:1 for `accentText` on `accent` and 3:1 for `accent` against the surface behind it, in both themes. The tightest are Coral at 6.66 in dark and Sea Glass at 5.27 in light, both comfortably clear.

- [x] Derive the ramp in TypeScript, OKLCH in and hex out. `resolveTheme()` hands token text straight to Canvas 2D, so a `color-mix()` token would reach `fillStyle` as unresolved text.
- [x] Accent drives chrome only. `pitchDetected`, `pitchTarget`, `midiNote` and `playhead` keep their own hues at every setting.
- [x] High Contrast ignores the accent entirely and keeps `#00e5ff`, or the theme stops meeting its own promise.
- [x] Add `accent` to `Preferences` beside `theme`, defaulting to Cerulean.
- [x] Theme menu presents the accents as a radio group, each swatch carrying its colour name as its accessible name, and the name in the tooltip.
- [x] Assert the two contrast floors in a unit test over the generated ramp, so a future accent cannot be added without clearing them.

## 9. Translucency and window

Real Mica is a DWM system backdrop for native windows. It is not exposed to web apps, and `backdrop-filter` only samples content inside the page, never the desktop wallpaper. A browser tab and an installed PWA both fall outside it.

Settled treatment: `backdrop-filter: blur(20px) saturate(1.4)` over the surface token at 72% alpha in dark and 78% in light.

- [x] Apply it to menus, dropdowns, tooltips, dialogs, toasts, the inspector and the mixer. Panels floating over the waveform is most of what Mica Alt gives.
- [x] Add a ground layer behind the canvas so translucent chrome has something to sample past the end of a project.
- [x] High Contrast opts out and stays opaque.
- [x] `@supports not (backdrop-filter: blur(1px))` falls back to opaque surfaces.
- [x] Custom titlebar for the installed app: `window-controls-overlay` in `display_override`, the `titlebar-area-*` environment variables, `app-region` drag regions. It carries the project name from section 10 and falls back to the normal toolbar in every browser tab.
- [x] Record in `docs/decisions.md` that system Mica needs a native shell, so it stops being reopened.

## 10. Project name and title

- [x] Add a project name to the document model, derived from the first audio import with its extension stripped.
- [x] Edit it in a project settings section of the inspector. That is sufficient on two conditions: it is the single source of truth, and renaming is undoable like any other edit.
- [x] Tab title, the `window-controls-overlay` titlebar, the save filename `persistence/project-io.ts` sanitises, and the export default name all read that field.
- [x] Title format: `Axys` with nothing open, `Take 3 - Axys` open and saved, `*Take 3 - Axys` when `store.dirty`.
- [x] Renaming does not move an already-saved file. The next save uses the new name.

## 11. Chrome and shell

- [x] Command palette on `Ctrl+Shift+P`, `Cmd+Shift+P` on macOS, over the 39 commands in `app/commands.ts` and reusing the shortcut registry. Largest single gain in perceived maturity, and the data already exists.
- [x] Toolbar overflow menu below the width measured in section 4, rather than letting the bar wrap.
- [x] Keyboard cheatsheet on `?`, from the same command and shortcut data the menus already show.
- [x] Canvas empty state before any import: a drop target, a keyboard alternative, and the three ways in.
- [x] First-paint skeleton while the wasm loads, so the shell does not flash unstyled and then populate.

## 12. Editor feel

Cursor per tool, all custom cursors 24px with a declared hotspot and a stock fallback:

| Tool               | Cursor                                      |
| ------------------ | ------------------------------------------- |
| Select             | `default`                                   |
| Marquee            | `crosshair`                                 |
| Pen                | custom pen, hotspot at the nib, bottom left |
| Line               | `crosshair`                                 |
| Smooth             | custom brush, hotspot centre                |
| Time               | `ew-resize`                                 |
| Number field scrub | `ew-resize`                                 |
| Boundary drag      | `col-resize`                                |

- [x] Add the cursor set.
- [x] Name the fine-adjust modifier in the tooltip of every scrubbable number field.
- [x] Confirm grid, ruler and bounds lines land on pixel centres at each device pixel ratio, or they blur at 125 and 150 percent scaling.
- [x] Bring the marquee onto the existing `axys-march` animation.

## 13. String sweep

Every user-facing string gets read once against the GNOME HIG. It is specific, it is written for desktop application chrome rather than marketing pages, and it matches the house style already in use.

- Header capitalisation for anything that is not a sentence: buttons, menu items, switch labels, tooltips, headings.
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
- No tooltip carries essential information on its own. It is unreachable on touch and often unreachable to assistive technology.
- A toggle's tooltip names what pressing it will do, and follows the state icon.

Work:

- [x] Sweep every string in `web/src`, including toasts, dialogs, diagnostics, status items and error messages.
- [x] Rich tooltips on tools only: header-capitalised title, at most one supplementary line, shortcut. No examples, no explanation of why.
- [x] Add the rules to the design bible so the next string is written right the first time.

## 14. Identity

- [x] Cerulean is the identity: OKLCH hue 248, `#34a4ff` in dark and `#006cb5` in light. It is the default accent in every theme and the seed for Slate. The old `#4cc2ff` is retired.
- [x] Full app icon set. One `favicon.svg` and one maskable is the floor; add the install and taskbar sizes and a monochrome variant.

## 15. Verify against the running editor

Decided and computed, but each needs one look before it is called done.

- [x] The palette clears its contrast floors arithmetically. Confirm on the canvas that a selection in Sea Glass or Abyssal still separates from the detected and target pitch traces, which is a perceptual judgement the ratios do not make.
- [x] Atkinson is wider than `system-ui`. Check the toolbar, status bar and inspector rows at the new sizes before fixing the overflow threshold.
- [x] Check the state icon pairs read at 16px as well as 20px. `panel-right-open` against `panel-right-close` is the narrowest difference in the set.

## 16. Sources

- Lucide licence and sizing rule: https://lucide.dev/guide/lucide/basics/sizing
- Bravura and SMuFL licensing: https://www.smufl.org/fonts/
- Atkinson Hyperlegible licence and Next release: https://www.brailleinstitute.org/freefont/
- fontTools subsetter: https://fonttools.readthedocs.io/en/latest/subset/
- Window Controls Overlay: https://web.dev/articles/window-controls-overlay
- Mica material, native only: https://learn.microsoft.com/en-us/windows/apps/design/style/mica
- GNOME HIG tooltips: https://developer.gnome.org/hig/patterns/feedback/tooltips.html
- GNOME HIG writing style: https://developer.gnome.org/hig/guidelines/writing-style.html
