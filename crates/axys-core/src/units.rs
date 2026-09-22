// SPDX-License-Identifier: AGPL-3.0-or-later

//! Frequency, MIDI note, cents and note-name conversions.

use serde::{Deserialize, Serialize};

/// Concert reference tuning.
///
/// `a4_hz` is the frequency assigned to MIDI note 69.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tuning {
    /// Frequency of A4 in Hz.
    pub a4_hz: f64,
}

impl Default for Tuning {
    fn default() -> Self {
        Self { a4_hz: 440.0 }
    }
}

/// How accidentals are spelled when a note is named.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AccidentalStyle {
    /// C#, D#, F#, G#, A#.
    #[default]
    Sharps,
    /// Db, Eb, Gb, Ab, Bb.
    Flats,
}

const SHARP_NAMES: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];
const FLAT_NAMES: [&str; 12] = [
    "C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B",
];

impl Tuning {
    /// Converts a frequency in Hz to a fractional MIDI note number.
    ///
    /// Returns `None` for non-positive or non-finite input.
    pub fn hz_to_midi(&self, hz: f64) -> Option<f64> {
        if !hz.is_finite() || hz <= 0.0 {
            return None;
        }
        Some(69.0 + 12.0 * (hz / self.a4_hz).log2())
    }

    /// Converts a fractional MIDI note number to a frequency in Hz.
    pub fn midi_to_hz(&self, midi: f64) -> f64 {
        self.a4_hz * ((midi - 69.0) / 12.0).exp2()
    }
}

/// Difference between two frequencies in cents.
///
/// Returns `None` when either frequency is non-positive or non-finite.
pub fn cents_between(from_hz: f64, to_hz: f64) -> Option<f64> {
    if !from_hz.is_finite() || !to_hz.is_finite() || from_hz <= 0.0 || to_hz <= 0.0 {
        return None;
    }
    Some(1200.0 * (to_hz / from_hz).log2())
}

/// Converts a semitone offset to cents.
pub fn semitones_to_cents(semitones: f64) -> f64 {
    semitones * 100.0
}

/// Converts cents to a semitone offset.
pub fn cents_to_semitones(cents: f64) -> f64 {
    cents / 100.0
}

/// Names the nearest chromatic note to a fractional MIDI number.
///
/// Uses scientific pitch notation, so MIDI 60 is `C4`.
pub fn midi_to_name(midi: f64, style: AccidentalStyle) -> String {
    let nearest = midi.round() as i64;
    let pc = nearest.rem_euclid(12) as usize;
    let octave = nearest.div_euclid(12) - 1;
    let names = match style {
        AccidentalStyle::Sharps => SHARP_NAMES,
        AccidentalStyle::Flats => FLAT_NAMES,
    };
    format!("{}{}", names[pc], octave)
}

/// Signed cents deviation of a fractional MIDI number from its nearest chromatic note.
pub fn midi_cents_deviation(midi: f64) -> f64 {
    (midi - midi.round()) * 100.0
}

/// Parses scientific pitch notation such as `C4`, `F#3` or `Bb-1` into a MIDI number.
pub fn name_to_midi(name: &str) -> Option<i32> {
    let bytes = name.as_bytes();
    if bytes.is_empty() {
        return None;
    }
    let step = match bytes[0].to_ascii_uppercase() {
        b'C' => 0,
        b'D' => 2,
        b'E' => 4,
        b'F' => 5,
        b'G' => 7,
        b'A' => 9,
        b'B' => 11,
        _ => return None,
    };
    let mut idx = 1;
    let mut alter = 0i32;
    while idx < bytes.len() {
        match bytes[idx] {
            b'#' => alter += 1,
            b'b' | b'B' => alter -= 1,
            _ => break,
        }
        idx += 1;
    }
    let octave: i32 = name[idx..].parse().ok()?;
    Some((octave + 1) * 12 + step + alter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a4_round_trips() {
        let t = Tuning::default();
        assert!((t.hz_to_midi(440.0).unwrap() - 69.0).abs() < 1e-9);
        assert!((t.midi_to_hz(69.0) - 440.0).abs() < 1e-9);
    }

    #[test]
    fn octave_is_twelve_semitones() {
        let t = Tuning::default();
        assert!((t.midi_to_hz(81.0) - 880.0).abs() < 1e-9);
        assert!((cents_between(440.0, 880.0).unwrap() - 1200.0).abs() < 1e-9);
    }

    #[test]
    fn rejects_non_positive_frequency() {
        let t = Tuning::default();
        assert!(t.hz_to_midi(0.0).is_none());
        assert!(t.hz_to_midi(-1.0).is_none());
        assert!(cents_between(0.0, 440.0).is_none());
    }

    #[test]
    fn names_use_scientific_pitch() {
        assert_eq!(midi_to_name(60.0, AccidentalStyle::Sharps), "C4");
        assert_eq!(midi_to_name(61.0, AccidentalStyle::Flats), "Db4");
        assert_eq!(midi_to_name(21.0, AccidentalStyle::Sharps), "A0");
        assert_eq!(name_to_midi("C4"), Some(60));
        assert_eq!(name_to_midi("Bb3"), Some(58));
        assert_eq!(name_to_midi("C-1"), Some(0));
    }

    #[test]
    fn alternate_tuning_shifts_everything() {
        let t = Tuning { a4_hz: 432.0 };
        assert!((t.midi_to_hz(69.0) - 432.0).abs() < 1e-9);
        assert!((t.hz_to_midi(432.0).unwrap() - 69.0).abs() < 1e-9);
    }

    #[test]
    fn cents_deviation_is_signed() {
        assert!((midi_cents_deviation(60.25) - 25.0).abs() < 1e-9);
        assert!((midi_cents_deviation(59.75) + 25.0).abs() < 1e-9);
    }
}
