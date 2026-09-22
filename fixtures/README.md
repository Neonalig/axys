<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Fixtures

Every file here is synthesised by `generate.mjs`, so nothing carries third-party rights and all of
it is redistributable under the project licence. No recorded material is used.

Regenerate with:

```bash
node fixtures/generate.mjs
```

Output is deterministic, so a regeneration that changes a file means the generator changed.

## Audio

`audio/` holds 48 kHz 16-bit mono WAV covering the material `docs/design_bible.md` section 13.2
calls for.

| File                    | Covers                                                                  |
| ----------------------- | ----------------------------------------------------------------------- |
| `sustained-vowel.wav`   | Steady C4, the baseline for F0 accuracy.                                |
| `vibrato.wav`           | 5.5 Hz vibrato at 55 cents depth after a straight entrance.             |
| `drift.wav`             | Slow drift plus a rising tendency, no vibrato.                          |
| `scoop-and-fall.wav`    | Scooped entrance and a falling tail on one note.                        |
| `slide.wav`             | A continuous octave glissando.                                          |
| `rapid-transitions.wav` | Eight 160 ms notes, for transition and onset handling.                  |
| `breathy.wav`           | Few harmonics with added noise, near-spoken.                            |
| `consonants.wav`        | Plosives and sibilants between voiced notes.                            |
| `octave-ambiguity.wav`  | Low E2 with strong harmonics, the classic octave-error case.            |
| `low-confidence.wav`    | Quiet tone buried in noise.                                             |
| `phrase.wav`            | A short multi-note phrase with silences, a sibilant and a vibrato tail. |

## MIDI

`midi/` holds Standard MIDI Files exercising the timeline and guide requirements.

| File               | Covers                                                 |
| ------------------ | ------------------------------------------------------ |
| `melody.mid`       | Four notes, 120 bpm, 4/4. The ordinary case.           |
| `tempo-change.mid` | Two tempo changes, one of them between notes.          |
| `meter-change.mid` | 4/4 to 3/4 to 7/8, one change during a sustained note. |
| `pickup.mid`       | A note before the first downbeat.                      |
| `overlapping.mid`  | Overlapping notes in one monophonic guide.             |
| `percussion.mid`   | A melody track plus a channel 10 drum track.           |
