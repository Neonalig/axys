// SPDX-License-Identifier: AGPL-3.0-or-later

//! Saved project documents: schema, versioned migration and media identity.
//!
//! A project separates immutable source facts and analysis parameters from the
//! mutable edit state, so any analysis cache may be discarded and rebuilt
//! without losing user intent.

use serde::{Deserialize, Serialize};

use crate::analysis::f0::{F0Params, PitchTrack};
use crate::analysis::segment::SegmentParams;
use crate::blob::BlobSet;
use crate::dsp::formant::FormantMode;
use crate::edit::History;
use crate::midi::{GuideSelection, NoteMapping};
use crate::mixer::MixerSettings;
use crate::target::{ModulationSettings, ScaleSettings};
use crate::timeline::TimelineMap;
use crate::units::{AccidentalStyle, Tuning};
use crate::{AxysError, Result};

/// Current project schema version.
pub const SCHEMA_VERSION: u32 = 1;

/// Version of the analysis pipeline whose output a stored track came from.
pub const ANALYSER_VERSION: u32 = 1;

/// Immutable facts about the imported source audio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    /// File name the audio was imported under.
    pub name: String,
    /// Sample rate of the decoded source in Hz.
    pub sample_rate: u32,
    /// Channel count of the decoded source.
    pub channels: u16,
    /// Frame count of the decoded source.
    pub frames: usize,
    /// Source duration in seconds.
    pub duration: f64,
    /// FNV-1a 64-bit digest of the decoded mono PCM, used to verify a relink.
    pub fingerprint: String,
    /// Media type reported at import, when one was known.
    #[serde(default)]
    pub mime: Option<String>,
}

/// Parameters and version that produced the stored analysis, so it can be recomputed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnalysisInfo {
    /// Pipeline version the stored track came from.
    pub analyser_version: u32,
    /// Pitch-detection parameters.
    pub f0: F0Params,
    /// Segmentation parameters.
    pub segment: SegmentParams,
}

impl Default for AnalysisInfo {
    fn default() -> Self {
        Self {
            analyser_version: ANALYSER_VERSION,
            f0: F0Params::default(),
            segment: SegmentParams::default(),
        }
    }
}

/// The mutable part of a project: everything an edit operation may change.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditState {
    /// What the project is called.
    ///
    /// The single source of truth for the name: the tab title, the window titlebar, the save
    /// file name and the export default all read it. It lives here rather than beside the
    /// schema version because renaming is an edit like any other, undone and redone with the
    /// rest of the history.
    #[serde(default)]
    pub name: String,
    /// Editable regions of the analysed vocal.
    #[serde(default)]
    pub blobs: BlobSet,
    /// Key and scale used by pitch-scale correction.
    #[serde(default)]
    pub scale: ScaleSettings,
    /// Retained drift and vibrato.
    #[serde(default)]
    pub modulation: ModulationSettings,
    /// How formants are treated while pitch moves.
    #[serde(default)]
    pub formant: FormantMode,
    /// Tempo and meter maps with the musical origin.
    #[serde(default)]
    pub timeline: TimelineMap,
    /// Chosen MIDI guide, when one is active.
    #[serde(default)]
    pub guide: Option<GuideSelection>,
    /// Blob-to-note relationships.
    #[serde(default)]
    pub mappings: Vec<NoteMapping>,
    /// Concert reference tuning.
    #[serde(default)]
    pub tuning: Tuning,
    /// How accidentals are spelled.
    #[serde(default)]
    pub accidentals: AccidentalStyle,
    /// Monitor levels for everything the transport plays.
    #[serde(default)]
    pub mixer: MixerSettings,
}

impl Default for EditState {
    fn default() -> Self {
        Self {
            name: String::new(),
            blobs: BlobSet::new(),
            scale: ScaleSettings::default(),
            modulation: ModulationSettings::default(),
            formant: FormantMode::default(),
            timeline: TimelineMap::default(),
            guide: None,
            mappings: Vec::new(),
            tuning: Tuning::default(),
            accidentals: AccidentalStyle::default(),
            mixer: MixerSettings::default(),
        }
    }
}

/// Saved editor view state, restored on reopen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewState {
    /// Left edge of the visible range in source seconds.
    pub visible_start: f64,
    /// Right edge of the visible range in source seconds.
    pub visible_end: f64,
    /// Lowest visible MIDI note.
    pub low_midi: f64,
    /// Highest visible MIDI note.
    pub high_midi: f64,
    /// Whether the ruler reads in clock time or bars and beats.
    pub time_display: TimeDisplay,
    /// Beat subdivision used for snapping; 1 is beats, 4 is sixteenths.
    pub snap_division: u32,
    /// Playhead position in source seconds.
    pub playhead: f64,
    /// Loop region start in source seconds, when a loop is set.
    #[serde(default)]
    pub loop_start: Option<f64>,
    /// Loop region end in source seconds, when a loop is set.
    #[serde(default)]
    pub loop_end: Option<f64>,
}

impl Default for ViewState {
    fn default() -> Self {
        Self {
            visible_start: 0.0,
            visible_end: 10.0,
            low_midi: 36.0,
            high_midi: 84.0,
            time_display: TimeDisplay::Seconds,
            snap_division: 4,
            playhead: 0.0,
            loop_start: None,
            loop_end: None,
        }
    }
}

/// Whether the ruler reads in clock time or in bars and beats.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimeDisplay {
    /// Minutes, seconds and milliseconds.
    Seconds,
    /// Bars, beats and ticks against the tempo and meter maps.
    BarsBeats,
}

/// A complete saved project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Document schema version.
    pub schema_version: u32,
    /// Build that last wrote the document.
    pub app_version: String,
    /// Project name shown in the editor.
    ///
    /// Written from `edits.name` on save and read back into it on open, so a file carries the
    /// name where a reader expects to find it while the editor keeps one copy of it.
    pub name: String,
    /// Immutable facts about the imported source audio.
    pub source: SourceInfo,
    /// Parameters and version that produced the stored analysis.
    #[serde(default)]
    pub analysis: AnalysisInfo,
    /// Stored analysis output. Discardable: it can be rebuilt from the source and params.
    #[serde(default)]
    pub track: Option<PitchTrack>,
    /// Everything an edit operation may change.
    #[serde(default)]
    pub edits: EditState,
    /// The state the history replays from, which is the analysis plus anything not an edit.
    #[serde(default)]
    pub base: EditState,
    /// Bytes of the imported MIDI file, base64, so the guide survives a reopen.
    #[serde(default)]
    pub midi: Option<String>,
    /// Saved editor view state.
    #[serde(default)]
    pub view: ViewState,
    /// Undo and redo stacks.
    #[serde(default)]
    pub history: History,
}

impl Project {
    /// Creates an empty project over already-decoded source audio.
    pub fn new(name: String, source: SourceInfo, analysis: AnalysisInfo) -> Self {
        let edits = EditState {
            timeline: TimelineMap {
                sample_rate: f64::from(source.sample_rate),
                ..TimelineMap::default()
            },
            ..EditState::default()
        };
        Self {
            schema_version: SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            name,
            source,
            analysis,
            track: None,
            base: edits.clone(),
            edits,
            midi: None,
            view: ViewState::default(),
            history: History::new(),
        }
    }

    /// Serialises the project as a JSON document.
    pub fn to_json(&self) -> Result<String> {
        serde_json::to_string(self)
            .map_err(|e| AxysError::Invalid(format!("project could not be serialised: {e}")))
    }

    /// Parses and migrates a project document of any supported schema version.
    pub fn from_json(json: &str) -> Result<Project> {
        let value: serde_json::Value = serde_json::from_str(json)
            .map_err(|e| AxysError::Invalid(format!("project is not valid JSON: {e}")))?;
        let migrated = migrate(value)?;
        serde_json::from_value(migrated)
            .map_err(|e| AxysError::Invalid(format!("project document is malformed: {e}")))
    }

    /// True when `source` describes the same media as `other`.
    pub fn matches_source(&self, other: &SourceInfo) -> bool {
        self.source.fingerprint == other.fingerprint
            && self.source.sample_rate == other.sample_rate
            && self.source.channels == other.channels
            && self.source.frames == other.frames
    }
}

const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64-bit digest of PCM, rendered as 16 lowercase hex characters.
pub fn fingerprint(samples: &[f32]) -> String {
    let mut hash = FNV_OFFSET_BASIS;
    for sample in samples {
        // Normalise the two zero encodings so a bit-identical signal digests identically.
        let bits = if *sample == 0.0 {
            0u32
        } else {
            sample.to_bits()
        };
        for byte in bits.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    for byte in (samples.len() as u64).to_le_bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    format!("{hash:016x}")
}

/// Upgrades a parsed project document to `SCHEMA_VERSION`.
///
/// Errors on a version newer than this build understands rather than guessing.
/// Each older version gets one match arm that rewrites the document to the
/// current shape.
pub fn migrate(value: serde_json::Value) -> Result<serde_json::Value> {
    let mut value = value;
    if !value.is_object() {
        return Err(AxysError::Invalid(
            "project document is not an object".to_string(),
        ));
    }
    let version = read_schema_version(&value)?;
    match version {
        SCHEMA_VERSION => {}
        // 1 => upgrade_1_to_2(&mut value)?,
        v if v > SCHEMA_VERSION => {
            return Err(AxysError::Unsupported(format!(
                "project schema version {v} is newer than {SCHEMA_VERSION}"
            )))
        }
        v => {
            return Err(AxysError::Invalid(format!(
                "project schema version {v} is not understood"
            )))
        }
    }
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "schemaVersion".to_string(),
            serde_json::Value::from(SCHEMA_VERSION),
        );
    }
    Ok(value)
}

fn read_schema_version(value: &serde_json::Value) -> Result<u32> {
    let raw = value
        .get("schemaVersion")
        .ok_or_else(|| AxysError::Invalid("project document has no schemaVersion".to_string()))?;
    let number = raw
        .as_u64()
        .ok_or_else(|| AxysError::Invalid("schemaVersion is not a whole number".to_string()))?;
    u32::try_from(number)
        .map_err(|_| AxysError::Invalid(format!("schemaVersion {number} is out of range")))
}

const B64_ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Encodes bytes as standard padded base64.
pub fn to_base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = chunk.get(1).map_or(0, |b| u32::from(*b));
        let b2 = chunk.get(2).map_or(0, |b| u32::from(*b));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_ALPHABET[(triple >> 18) as usize & 0x3f] as char);
        out.push(B64_ALPHABET[(triple >> 12) as usize & 0x3f] as char);
        if chunk.len() > 1 {
            out.push(B64_ALPHABET[(triple >> 6) as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_ALPHABET[triple as usize & 0x3f] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn b64_value(byte: u8) -> Option<u32> {
    match byte {
        b'A'..=b'Z' => Some(u32::from(byte - b'A')),
        b'a'..=b'z' => Some(u32::from(byte - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(byte - b'0') + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Decodes standard padded base64, rejecting any character or length that is not valid.
///
/// ASCII whitespace between characters is ignored so line-wrapped input is accepted.
pub fn from_base64(text: &str) -> Result<Vec<u8>> {
    let mut symbols: Vec<u8> = Vec::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => continue,
            b'=' => symbols.push(b'='),
            _ => {
                if b64_value(byte).is_none() {
                    return Err(AxysError::Invalid(format!(
                        "base64 contains an invalid byte {byte:#04x}"
                    )));
                }
                if symbols.last() == Some(&b'=') {
                    return Err(AxysError::Invalid(
                        "base64 has data after its padding".to_string(),
                    ));
                }
                symbols.push(byte);
            }
        }
    }
    if symbols.len() % 4 != 0 {
        return Err(AxysError::Invalid(format!(
            "base64 length {} is not a multiple of four",
            symbols.len()
        )));
    }
    let padding = symbols.iter().rev().take_while(|b| **b == b'=').count();
    if padding > 2 {
        return Err(AxysError::Invalid(
            "base64 has more than two padding characters".to_string(),
        ));
    }
    let mut out = Vec::with_capacity(symbols.len() / 4 * 3);
    for quad in symbols.chunks(4) {
        let mut accumulator = 0u32;
        let mut kept = 0usize;
        for (index, byte) in quad.iter().enumerate() {
            if *byte == b'=' {
                accumulator <<= 6;
                continue;
            }
            let value = b64_value(*byte).ok_or_else(|| {
                AxysError::Invalid("base64 contains an invalid character".to_string())
            })?;
            accumulator = (accumulator << 6) | value;
            kept = index + 1;
        }
        let bytes = accumulator.to_be_bytes();
        let produced = match kept {
            4 => 3,
            3 => 2,
            2 => 1,
            _ => {
                return Err(AxysError::Invalid(
                    "base64 group carries fewer than two data characters".to_string(),
                ))
            }
        };
        out.extend_from_slice(&bytes[1..=produced]);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::{Blob, BlobId};
    use crate::curve::Anchor;
    use crate::edit::EditOp;
    use crate::midi::GuideMode;
    use crate::timeline::TempoEvent;

    fn source() -> SourceInfo {
        SourceInfo {
            name: "take one.wav".to_string(),
            sample_rate: 48_000,
            channels: 2,
            frames: 96_000,
            duration: 2.0,
            fingerprint: fingerprint(&[0.1, 0.2, 0.3]),
            mime: Some("audio/wav".to_string()),
        }
    }

    fn full_project() -> Project {
        let mut project = Project::new("Take One".to_string(), source(), AnalysisInfo::default());

        let mut blob = Blob::new(BlobId(1), 0.5, 1.25, 60.4);
        blob.pitch_offset = -1.5;
        blob.time_offset = 0.02;
        blob.time_scale = 1.1;
        blob.excluded = true;
        blob.curve.insert(Anchor::new(0.6, 60.0));
        blob.curve.insert(Anchor::new(1.0, 61.0));
        let second = Blob::new(BlobId(2), 1.5, 2.0, 64.0);
        project.edits.blobs =
            BlobSet::from_blobs(vec![blob, second]).expect("blobs are non-overlapping");

        project.edits.scale.root = 2;
        project.edits.scale.degrees = vec![0, 2, 4, 5, 7, 9, 11];
        project.edits.scale.strength = 0.75;
        project.edits.scale.excluded = vec![11];
        project.edits.modulation.drift = 0.5;
        project.edits.modulation.vibrato_depth = 1.5;
        project.edits.formant = FormantMode::Shift(-2.0);
        project
            .edits
            .timeline
            .set_tempo(vec![
                TempoEvent {
                    tick: 0,
                    micros_per_quarter: 500_000,
                },
                TempoEvent {
                    tick: 1920,
                    micros_per_quarter: 400_000,
                },
            ])
            .expect("tempo map accepted");
        project.edits.timeline.origin_seconds = -0.25;
        project.edits.guide = Some(GuideSelection {
            track: 1,
            channel: Some(3),
            mode: GuideMode::Combined,
            strength: 0.8,
            muted: true,
        });
        project.edits.mappings = vec![NoteMapping {
            blob: BlobId(1),
            note: Some(4),
            manual: true,
            opted_out: false,
        }];
        project.edits.tuning = Tuning { a4_hz: 442.0 };
        project.edits.accidentals = AccidentalStyle::Flats;

        project.track = Some(PitchTrack {
            sample_rate: 48_000.0,
            hop_seconds: 0.005,
            frames: Vec::new(),
        });
        project.midi = Some(to_base64(b"MThd\0\0\0\x06"));
        project.view = ViewState {
            visible_start: 1.0,
            visible_end: 5.0,
            low_midi: 40.0,
            high_midi: 80.0,
            time_display: TimeDisplay::BarsBeats,
            snap_division: 2,
            playhead: 1.75,
            loop_start: Some(1.0),
            loop_end: Some(3.0),
        };
        project
            .history
            .push(EditOp::SetTimelineOrigin { seconds: 0.25 });
        project.history.push(EditOp::SetPitchOffset {
            blob: BlobId(1),
            semitones: -1.5,
        });
        project
    }

    #[test]
    fn full_project_round_trips_through_json() {
        let project = full_project();
        let json = project.to_json().expect("project serialises");
        let parsed = Project::from_json(&json).expect("project parses");
        assert_eq!(project, parsed);
    }

    #[test]
    fn round_trip_preserves_every_named_field() {
        let project = full_project();
        let parsed =
            Project::from_json(&project.to_json().expect("serialises")).expect("parses back");
        assert_eq!(parsed.schema_version, SCHEMA_VERSION);
        assert_eq!(parsed.app_version, project.app_version);
        assert_eq!(parsed.name, "Take One");
        assert_eq!(parsed.source, project.source);
        assert_eq!(parsed.analysis, project.analysis);
        assert_eq!(parsed.track, project.track);
        assert_eq!(parsed.edits.blobs.len(), 2);
        assert_eq!(parsed.edits.blobs.blobs()[0].curve.len(), 2);
        assert_eq!(parsed.edits.scale, project.edits.scale);
        assert_eq!(parsed.edits.modulation, project.edits.modulation);
        assert_eq!(parsed.edits.formant, FormantMode::Shift(-2.0));
        assert_eq!(parsed.edits.timeline, project.edits.timeline);
        assert_eq!(parsed.edits.guide, project.edits.guide);
        assert_eq!(parsed.edits.mappings, project.edits.mappings);
        assert_eq!(parsed.edits.tuning, project.edits.tuning);
        assert_eq!(parsed.edits.accidentals, AccidentalStyle::Flats);
        assert_eq!(parsed.midi, project.midi);
        assert_eq!(parsed.view, project.view);
        assert_eq!(parsed.history, project.history);
        assert_eq!(parsed.history.applied().len(), 2);
    }

    #[test]
    fn json_uses_camel_case_keys() {
        let json = full_project().to_json().expect("serialises");
        assert!(json.contains("\"schemaVersion\""));
        assert!(json.contains("\"sampleRate\""));
        assert!(json.contains("\"pitchOffset\""));
        assert!(!json.contains("\"schema_version\""));
    }

    #[test]
    fn new_project_takes_its_timeline_rate_from_the_source() {
        let project = Project::new("x".to_string(), source(), AnalysisInfo::default());
        assert_eq!(project.edits.timeline.sample_rate, 48_000.0);
        assert_eq!(project.schema_version, SCHEMA_VERSION);
        assert!(project.track.is_none());
        assert!(!project.app_version.is_empty());
    }

    #[test]
    fn fingerprint_is_stable_and_separates_different_audio() {
        let a = vec![0.0, 0.25, -0.5, 1.0];
        let b = vec![0.0, 0.25, -0.5, 0.999];
        assert_eq!(fingerprint(&a), fingerprint(&a));
        assert_ne!(fingerprint(&a), fingerprint(&b));
        assert_eq!(fingerprint(&a).len(), 16);
        assert!(fingerprint(&a).chars().all(|c| c.is_ascii_hexdigit()));
        assert!(fingerprint(&a).chars().all(|c| !c.is_ascii_uppercase()));
    }

    #[test]
    fn fingerprint_separates_length_from_content() {
        assert_ne!(fingerprint(&[]), fingerprint(&[0.0]));
        assert_ne!(fingerprint(&[0.0]), fingerprint(&[0.0, 0.0]));
        assert_eq!(fingerprint(&[0.0]), fingerprint(&[-0.0]));
    }

    #[test]
    fn matches_source_rejects_a_different_file_with_the_same_name() {
        let project = Project::new("p".to_string(), source(), AnalysisInfo::default());
        let mut same = source();
        same.mime = None;
        assert!(project.matches_source(&same));

        let mut impostor = source();
        impostor.fingerprint = fingerprint(&[0.9, 0.8, 0.7]);
        assert_eq!(impostor.name, project.source.name);
        assert!(!project.matches_source(&impostor));
    }

    #[test]
    fn matches_source_rejects_a_rate_or_layout_change() {
        let project = Project::new("p".to_string(), source(), AnalysisInfo::default());
        let mut resampled = source();
        resampled.sample_rate = 44_100;
        assert!(!project.matches_source(&resampled));
        let mut folded = source();
        folded.channels = 1;
        assert!(!project.matches_source(&folded));
        let mut trimmed = source();
        trimmed.frames = 95_999;
        assert!(!project.matches_source(&trimmed));
    }

    #[test]
    fn base64_round_trips_at_every_padding_length() {
        for len in 0..=32usize {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let text = to_base64(&bytes);
            assert_eq!(text.len() % 4, 0, "length {len}");
            assert_eq!(from_base64(&text).expect("decodes"), bytes, "length {len}");
        }
    }

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(to_base64(b""), "");
        assert_eq!(to_base64(b"f"), "Zg==");
        assert_eq!(to_base64(b"fo"), "Zm8=");
        assert_eq!(to_base64(b"foo"), "Zm9v");
        assert_eq!(to_base64(b"foob"), "Zm9vYg==");
        assert_eq!(to_base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(to_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(from_base64("Zm9vYmFy").expect("decodes"), b"foobar");
        assert_eq!(to_base64(&[0xff, 0xef, 0xbe]), "/+++");
        assert_eq!(
            from_base64("/+++").expect("decodes"),
            vec![0xff, 0xef, 0xbe]
        );
    }

    #[test]
    fn base64_ignores_line_wrapping() {
        let text = format!("{}\n{}", "Zm9v", "YmFy");
        assert_eq!(from_base64(&text).expect("decodes"), b"foobar");
        assert_eq!(from_base64("  Zg==  ").expect("decodes"), b"f");
    }

    #[test]
    fn base64_rejects_bad_input() {
        assert!(
            from_base64("Zm9vYmF").is_err(),
            "length not a multiple of 4"
        );
        assert!(from_base64("Zm9v!mFy").is_err(), "invalid character");
        assert!(from_base64("Zm9vYmF-").is_err(), "url-safe alphabet");
        assert!(from_base64("Zg==Zg==").is_err(), "data after padding");
        assert!(from_base64("Z===").is_err(), "three padding characters");
        assert!(from_base64("====").is_err(), "no data characters");
        assert!(from_base64("Zm\u{00e9}v").is_err(), "non-ascii");
    }

    #[test]
    fn base64_carries_arbitrary_binary() {
        let bytes: Vec<u8> = (0..=255u8).collect();
        assert_eq!(from_base64(&to_base64(&bytes)).expect("decodes"), bytes);
    }

    #[test]
    fn migrate_accepts_the_current_version() {
        let value = serde_json::json!({ "schemaVersion": SCHEMA_VERSION, "name": "x" });
        let out = migrate(value).expect("current version passes through");
        assert_eq!(out["schemaVersion"], serde_json::json!(SCHEMA_VERSION));
        assert_eq!(out["name"], serde_json::json!("x"));
    }

    #[test]
    fn migrate_errors_on_a_future_version() {
        let value = serde_json::json!({ "schemaVersion": 999 });
        let error = migrate(value).expect_err("999 is rejected");
        assert!(matches!(error, AxysError::Unsupported(_)), "{error}");
    }

    #[test]
    fn migrate_errors_on_an_unknown_older_version() {
        let error = migrate(serde_json::json!({ "schemaVersion": 0 })).expect_err("0 is rejected");
        assert!(matches!(error, AxysError::Invalid(_)), "{error}");
    }

    #[test]
    fn migrate_rejects_a_missing_or_malformed_version() {
        assert!(migrate(serde_json::json!({})).is_err());
        assert!(migrate(serde_json::json!({ "schemaVersion": "1" })).is_err());
        assert!(migrate(serde_json::json!({ "schemaVersion": -1 })).is_err());
        assert!(migrate(serde_json::json!({ "schemaVersion": 1.5 })).is_err());
        assert!(migrate(serde_json::json!([1, 2, 3])).is_err());
        assert!(migrate(serde_json::json!("nope")).is_err());
    }

    #[test]
    fn from_json_reports_a_future_version_rather_than_guessing() {
        let mut value: serde_json::Value =
            serde_json::from_str(&full_project().to_json().expect("serialises"))
                .expect("value parses");
        value["schemaVersion"] = serde_json::json!(999);
        let json = serde_json::to_string(&value).expect("re-serialises");
        assert!(matches!(
            Project::from_json(&json),
            Err(AxysError::Unsupported(_))
        ));
    }

    #[test]
    fn a_document_without_optional_fields_still_parses() {
        let json = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "appVersion": "0.0.0",
            "name": "Minimal",
            "source": {
                "name": "a.wav",
                "sampleRate": 48000,
                "channels": 1,
                "frames": 480,
                "duration": 0.01,
                "fingerprint": "0000000000000000"
            }
        })
        .to_string();
        let project = Project::from_json(&json).expect("minimal document parses");
        assert_eq!(project.name, "Minimal");
        assert_eq!(project.source.mime, None);
        assert_eq!(project.analysis, AnalysisInfo::default());
        assert_eq!(project.view, ViewState::default());
        assert_eq!(project.edits, EditState::default());
        assert!(project.track.is_none());
        assert!(project.midi.is_none());
        assert!(!project.history.can_undo());
    }

    #[test]
    fn a_document_missing_a_required_field_is_rejected() {
        let json = serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "appVersion": "0.0.0",
            "name": "Broken"
        })
        .to_string();
        assert!(matches!(
            Project::from_json(&json),
            Err(AxysError::Invalid(_))
        ));
    }

    #[test]
    fn from_json_rejects_malformed_text() {
        assert!(Project::from_json("").is_err());
        assert!(Project::from_json("{").is_err());
        assert!(Project::from_json("[]").is_err());
        assert!(Project::from_json("\u{0}").is_err());
    }
}
