// SPDX-License-Identifier: AGPL-3.0-or-later

//! Standard MIDI File import and the guide layer built on top of it.
//!
//! An imported file is immutable: parsing yields a listing of tracks, a flat note list and the
//! embedded tempo and meter maps. The guide layer decides which track drives pitch and timing,
//! which blob each note addresses, and how far the recording has drifted from the guide.

use serde::{Deserialize, Serialize};

use crate::blob::{Blob, BlobId, BlobSet};
use crate::limits;
use crate::timeline::{MeterEvent, TempoEvent, TimelineMap};
use crate::{AxysError, Result};

/// MIDI channel that General MIDI reserves for percussion, zero-based.
const PERCUSSION_CHANNEL: u8 = 9;

/// General MIDI program range of the Percussive instrument family, zero-based.
const PERCUSSION_PROGRAMS: std::ops::RangeInclusive<u8> = 112..=119;

/// Longest track or instrument name kept from an imported file, in characters.
const MAX_NAME_CHARS: usize = 128;

/// Largest number of overlap pairs reported for one guide selection.
const MAX_OVERLAP_PAIRS: usize = limits::MAX_MAP_EVENTS;

/// A note taken from an imported MIDI file.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiNote {
    /// Index of the track the note came from.
    pub track: usize,
    /// Zero-based MIDI channel.
    pub channel: u8,
    /// MIDI key number, 60 is middle C.
    pub key: u8,
    /// Note-on velocity.
    pub velocity: u8,
    /// Tick of the note-on.
    pub start_tick: u64,
    /// Tick of the note-off.
    pub end_tick: u64,
}

/// A track listed from an imported MIDI file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiTrackInfo {
    /// Position of the track in the file.
    pub index: usize,
    /// Embedded track name.
    pub name: Option<String>,
    /// Embedded instrument name.
    pub instrument: Option<String>,
    /// Channels the track carries notes on, ascending.
    pub channels: Vec<u8>,
    /// Notes the track contributes.
    pub note_count: usize,
    /// Channel 10 or a percussion program, so not offered as a pitch guide by default.
    pub is_percussion: bool,
    /// Tick of the earliest note, or 0 when the track has none.
    pub first_tick: u64,
    /// Tick of the latest note end, or 0 when the track has none.
    pub last_tick: u64,
}

/// A parsed Standard MIDI File.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiFile {
    /// SMF format, 0 single track, 1 parallel, 2 sequential.
    pub format: u8,
    /// Ticks per quarter note.
    pub ppq: u16,
    /// Every track in file order.
    pub tracks: Vec<MidiTrackInfo>,
    /// Every note in the file, ordered by start tick then track.
    pub notes: Vec<MidiNote>,
    /// Tempo changes gathered from all tracks.
    pub tempo: Vec<TempoEvent>,
    /// Meter changes gathered from all tracks.
    pub meter: Vec<MeterEvent>,
}

impl MidiFile {
    /// Notes on one track, optionally restricted to a channel, in tick order.
    pub fn notes_of(&self, track: usize, channel: Option<u8>) -> Vec<MidiNote> {
        self.notes
            .iter()
            .filter(|n| n.track == track && channel.is_none_or(|c| n.channel == c))
            .copied()
            .collect()
    }

    /// Overlapping notes within a guide selection, reported rather than silently resolved.
    pub fn overlaps(&self, track: usize, channel: Option<u8>) -> Vec<(MidiNote, MidiNote)> {
        let notes = self.notes_of(track, channel);
        self.overlap_indices(track, channel)
            .into_iter()
            .filter_map(|(first, second)| Some((*notes.get(first)?, *notes.get(second)?)))
            .collect()
    }

    /// Overlapping note pairs within a guide selection, as indices into
    /// [`MidiFile::notes_of`] for the same selection.
    ///
    /// At most `MAX_OVERLAP_PAIRS` pairs are reported.
    pub fn overlap_indices(&self, track: usize, channel: Option<u8>) -> Vec<(usize, usize)> {
        overlap_pairs(&self.notes_of(track, channel))
    }

    /// Builds a timeline map from the embedded tempo and meter maps.
    pub fn to_timeline(&self, sample_rate: f64, origin_seconds: f64) -> Result<TimelineMap> {
        if !origin_seconds.is_finite() {
            return Err(AxysError::Invalid("origin seconds is not finite".into()));
        }
        let mut map = TimelineMap::new(self.ppq, sample_rate)?;
        map.set_tempo(self.tempo.clone())?;
        map.set_meter(self.meter.clone())?;
        map.origin_seconds = origin_seconds;
        Ok(map)
    }
}

/// Parses a Standard MIDI File.
///
/// Rejects files over `limits::MAX_MIDI_BYTES`, event counts over `limits::MAX_MIDI_EVENTS`,
/// SMPTE timing divisions (unsupported, reported as such), and a zero tick division.
/// Unterminated notes end at the last event of their track rather than being dropped.
pub fn parse_smf(bytes: &[u8]) -> Result<MidiFile> {
    if bytes.len() > limits::MAX_MIDI_BYTES {
        return Err(AxysError::Invalid(format!(
            "midi file of {} bytes exceeds the {} byte limit",
            bytes.len(),
            limits::MAX_MIDI_BYTES
        )));
    }
    let ppq = check_structure(bytes)?;

    let smf = midly::Smf::parse(bytes)
        .map_err(|e| AxysError::Invalid(format!("midi file could not be parsed: {e}")))?;

    let format = match smf.header.format {
        midly::Format::SingleTrack => 0,
        midly::Format::Parallel => 1,
        midly::Format::Sequential => 2,
    };

    let total_events: usize = smf.tracks.iter().map(|t| t.len()).sum();
    if total_events > limits::MAX_MIDI_EVENTS {
        return Err(AxysError::Invalid(format!(
            "midi file holds {total_events} events, over the {} event limit",
            limits::MAX_MIDI_EVENTS
        )));
    }

    let mut file = MidiFile {
        format,
        ppq,
        tracks: Vec::with_capacity(smf.tracks.len()),
        notes: Vec::new(),
        tempo: Vec::new(),
        meter: Vec::new(),
    };

    for (index, track) in smf.tracks.iter().enumerate() {
        let scanned = scan_track(index, track);
        file.notes.extend(scanned.notes);
        file.tempo.extend(scanned.tempo);
        file.meter.extend(scanned.meter);
        file.tracks.push(scanned.info);
        if file.tempo.len() > limits::MAX_MAP_EVENTS || file.meter.len() > limits::MAX_MAP_EVENTS {
            return Err(AxysError::Invalid(format!(
                "midi tempo or meter map exceeds {} events",
                limits::MAX_MAP_EVENTS
            )));
        }
    }

    file.notes
        .sort_by(|a, b| a.start_tick.cmp(&b.start_tick).then(a.track.cmp(&b.track)));
    file.tempo.sort_by_key(|e| e.tick);
    file.meter.sort_by_key(|e| e.tick);
    Ok(file)
}

/// Validates the chunk layout and returns the tick division.
///
/// Reading the header before handing the bytes to the parser is what lets a truncated chunk and
/// an SMPTE division be reported precisely instead of as a generic parse failure.
fn check_structure(bytes: &[u8]) -> Result<u16> {
    if bytes.len() < 14 {
        return Err(AxysError::Invalid(
            "midi file is shorter than a header chunk".into(),
        ));
    }
    if &bytes[0..4] != b"MThd" {
        return Err(AxysError::Invalid("midi file has no MThd header".into()));
    }
    let header_len = read_u32(bytes, 4) as usize;
    if header_len < 6 {
        return Err(AxysError::Invalid("midi header chunk is too short".into()));
    }
    let body_end = 8usize
        .checked_add(header_len)
        .ok_or_else(|| AxysError::Invalid("midi header length overflows".into()))?;
    if body_end > bytes.len() {
        return Err(AxysError::Invalid("midi header chunk is truncated".into()));
    }

    let declared_tracks = u16::from_be_bytes([bytes[10], bytes[11]]) as usize;
    let division = u16::from_be_bytes([bytes[12], bytes[13]]);
    if division & 0x8000 != 0 {
        return Err(AxysError::Unsupported(
            "SMPTE timecode divisions are not supported, only ticks per quarter note".into(),
        ));
    }
    if division == 0 {
        return Err(AxysError::Invalid("midi tick division is zero".into()));
    }

    let mut pos = body_end;
    let mut found_tracks = 0usize;
    while pos + 8 <= bytes.len() {
        let len = read_u32(bytes, pos + 4) as usize;
        let end = pos
            .checked_add(8)
            .and_then(|p| p.checked_add(len))
            .ok_or_else(|| AxysError::Invalid("midi chunk length overflows".into()))?;
        if end > bytes.len() {
            return Err(AxysError::Invalid("midi track chunk is truncated".into()));
        }
        if &bytes[pos..pos + 4] == b"MTrk" {
            found_tracks += 1;
        }
        pos = end;
    }
    if pos != bytes.len() {
        return Err(AxysError::Invalid(
            "midi file ends inside a chunk header".into(),
        ));
    }
    if found_tracks < declared_tracks {
        return Err(AxysError::Invalid(format!(
            "midi header declares {declared_tracks} tracks but the file holds {found_tracks}"
        )));
    }
    Ok(division)
}

fn read_u32(bytes: &[u8], at: usize) -> u32 {
    let mut value = 0u32;
    for i in 0..4 {
        value = (value << 8) | bytes.get(at + i).copied().unwrap_or(0) as u32;
    }
    value
}

/// What one pass over a track yields.
struct ScannedTrack {
    info: MidiTrackInfo,
    notes: Vec<MidiNote>,
    tempo: Vec<TempoEvent>,
    meter: Vec<MeterEvent>,
}

fn scan_track(index: usize, events: &[midly::TrackEvent<'_>]) -> ScannedTrack {
    let mut tick = 0u64;
    let mut notes: Vec<MidiNote> = Vec::new();
    let mut tempo = Vec::new();
    let mut meter = Vec::new();
    let mut open: Vec<MidiNote> = Vec::new();
    let mut channels: Vec<u8> = Vec::new();
    let mut programs: Vec<(u8, u8)> = Vec::new();
    let mut name = None;
    let mut instrument = None;

    for event in events {
        tick = tick.saturating_add(u64::from(event.delta.as_int()));
        match event.kind {
            midly::TrackEventKind::Midi { channel, message } => {
                let channel = channel.as_int();
                match message {
                    midly::MidiMessage::NoteOn { key, vel } if vel.as_int() > 0 => {
                        if !channels.contains(&channel) {
                            channels.push(channel);
                        }
                        open.push(MidiNote {
                            track: index,
                            channel,
                            key: key.as_int(),
                            velocity: vel.as_int(),
                            start_tick: tick,
                            end_tick: tick,
                        });
                    }
                    midly::MidiMessage::NoteOn { key, .. }
                    | midly::MidiMessage::NoteOff { key, .. } => {
                        close_note(&mut open, &mut notes, channel, key.as_int(), tick);
                    }
                    midly::MidiMessage::ProgramChange { program } => {
                        programs.retain(|(c, _)| *c != channel);
                        programs.push((channel, program.as_int()));
                    }
                    _ => {}
                }
            }
            midly::TrackEventKind::Meta(meta) => match meta {
                midly::MetaMessage::TrackName(raw) => name = name.or_else(|| clean_name(raw)),
                midly::MetaMessage::InstrumentName(raw) => {
                    instrument = instrument.or_else(|| clean_name(raw))
                }
                midly::MetaMessage::Tempo(micros) => {
                    let micros_per_quarter = micros.as_int();
                    if micros_per_quarter > 0 {
                        tempo.push(TempoEvent {
                            tick,
                            micros_per_quarter,
                        });
                    }
                }
                midly::MetaMessage::TimeSignature(numerator, denominator_pow, _, _)
                    if numerator > 0 && denominator_pow <= 7 =>
                {
                    meter.push(MeterEvent {
                        tick,
                        numerator,
                        denominator: 1u8 << denominator_pow,
                    });
                }
                _ => {}
            },
            _ => {}
        }
    }

    // An unterminated note runs to the last event of its track rather than being discarded.
    for mut note in open.drain(..) {
        note.end_tick = tick.max(note.start_tick);
        notes.push(note);
    }
    notes.sort_by(|a, b| a.start_tick.cmp(&b.start_tick).then(a.key.cmp(&b.key)));

    channels.sort_unstable();
    let is_percussion = channels.contains(&PERCUSSION_CHANNEL)
        || programs
            .iter()
            .any(|(c, p)| channels.contains(c) && PERCUSSION_PROGRAMS.contains(p));
    let first_tick = notes.iter().map(|n| n.start_tick).min().unwrap_or(0);
    let last_tick = notes.iter().map(|n| n.end_tick).max().unwrap_or(0);

    ScannedTrack {
        info: MidiTrackInfo {
            index,
            name,
            instrument,
            channels,
            note_count: notes.len(),
            is_percussion,
            first_tick,
            last_tick,
        },
        notes,
        tempo,
        meter,
    }
}

/// Closes the oldest open note matching the channel and key.
fn close_note(open: &mut Vec<MidiNote>, out: &mut Vec<MidiNote>, channel: u8, key: u8, tick: u64) {
    if let Some(at) = open
        .iter()
        .position(|n| n.channel == channel && n.key == key)
    {
        let mut note = open.remove(at);
        note.end_tick = tick.max(note.start_tick);
        out.push(note);
    }
}

fn clean_name(raw: &[u8]) -> Option<String> {
    let text: String = String::from_utf8_lossy(raw)
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// How a MIDI guide contributes to the pitch target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GuideMode {
    /// Drawn against the vocal without changing the rendered result.
    VisualOnly,
    /// Contributes pitch targets only.
    PitchOnly,
    /// Contributes onset and duration targets only.
    TimingOnly,
    /// Contributes both pitch and timing targets.
    Combined,
}

/// The user's chosen MIDI guide and how it is aligned and applied.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuideSelection {
    /// Track the guide reads.
    pub track: usize,
    /// Channel within the track, or every channel when absent.
    pub channel: Option<u8>,
    /// What the guide contributes to the render.
    pub mode: GuideMode,
    /// Strength of the guide, 0.0 leaves the vocal alone, 1.0 follows the guide fully.
    pub strength: f64,
    /// Silences the guide's own monitoring playback.
    pub muted: bool,
}

impl Default for GuideSelection {
    fn default() -> Self {
        Self {
            track: 0,
            channel: None,
            mode: GuideMode::VisualOnly,
            strength: 1.0,
            muted: false,
        }
    }
}

/// A proposed or user-set relationship between one blob and one MIDI note.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMapping {
    /// Blob the mapping addresses.
    pub blob: BlobId,
    /// Index into the guide note list, or None when the blob is deliberately unmapped.
    pub note: Option<usize>,
    /// Set by the user rather than proposed by analysis.
    pub manual: bool,
    /// Excluded from guidance entirely.
    pub opted_out: bool,
}

/// Blobs and notes left unmatched or matched more than once by a proposal.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MappingReport {
    /// Blobs no note was proposed for.
    pub unmapped_blobs: Vec<BlobId>,
    /// Note indices no blob was proposed for.
    pub unmapped_notes: Vec<usize>,
    /// Note indices more than one blob maps to.
    pub multiply_mapped_notes: Vec<usize>,
    /// Note indices that sound at once with another note, which a monophonic guide cannot map
    /// cleanly. Reported, never resolved: no note is truncated or dropped.
    pub overlapping_notes: Vec<usize>,
}

/// Weight of temporal agreement in the mapping score.
const OVERLAP_WEIGHT: f64 = 0.7;

/// Weight of pitch agreement in the mapping score.
const PITCH_WEIGHT: f64 = 0.3;

/// Proposes blob-to-note mappings from temporal overlap and pitch proximity.
///
/// Nothing is deleted to force a one-to-one result; leftovers appear in the report.
/// Existing manual mappings in `existing` are preserved.
pub fn propose_mappings(
    blobs: &BlobSet,
    notes: &[MidiNote],
    timeline: &TimelineMap,
    existing: &[NoteMapping],
) -> (Vec<NoteMapping>, MappingReport) {
    let spans = note_spans(notes, timeline);
    let mut resolved: Vec<Option<NoteMapping>> = vec![None; blobs.len()];
    let mut taken = vec![false; notes.len()];

    for mapping in existing {
        if !(mapping.manual || mapping.opted_out) {
            continue;
        }
        let Some(at) = blobs.index_of(mapping.blob) else {
            continue;
        };
        let mut kept = *mapping;
        if let Some(note) = kept.note {
            if note >= notes.len() || kept.opted_out {
                kept.note = None;
            } else {
                taken[note] = true;
            }
        }
        resolved[at] = Some(kept);
    }

    let mut candidates = Vec::new();
    let longest = spans
        .iter()
        .map(|s| s.1 - s.0)
        .fold(0.0f64, |a, b| a.max(b));
    let order = span_order(&spans);

    for (at, blob) in blobs.blobs().iter().enumerate() {
        if resolved[at].is_some() {
            continue;
        }
        let start = blob.edited_start();
        let end = blob.edited_end().max(start);
        for &note in window(&order, &spans, start - longest, end) {
            let (note_start, note_end) = spans[note];
            let score = match match_score(
                start,
                end,
                blob.target_center(),
                note_start,
                note_end,
                notes[note].key,
            ) {
                Some(score) => score,
                None => continue,
            };
            candidates.push((score, at, note));
        }
    }
    candidates.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));

    for (_, at, note) in candidates {
        if resolved[at].is_some() || taken[note] {
            continue;
        }
        taken[note] = true;
        resolved[at] = Some(NoteMapping {
            blob: blobs.blobs()[at].id,
            note: Some(note),
            manual: false,
            opted_out: false,
        });
    }

    let mappings: Vec<NoteMapping> = blobs
        .blobs()
        .iter()
        .enumerate()
        .map(|(at, blob)| {
            resolved[at].unwrap_or(NoteMapping {
                blob: blob.id,
                note: None,
                manual: false,
                opted_out: false,
            })
        })
        .collect();

    let mut counts = vec![0usize; notes.len()];
    let mut unmapped_blobs = Vec::new();
    for mapping in &mappings {
        match mapping.note {
            Some(note) if note < counts.len() => counts[note] += 1,
            _ => {
                if !mapping.opted_out {
                    unmapped_blobs.push(mapping.blob);
                }
            }
        }
    }
    let report = MappingReport {
        unmapped_blobs,
        unmapped_notes: counts
            .iter()
            .enumerate()
            .filter(|(_, c)| **c == 0)
            .map(|(i, _)| i)
            .collect(),
        multiply_mapped_notes: counts
            .iter()
            .enumerate()
            .filter(|(_, c)| **c > 1)
            .map(|(i, _)| i)
            .collect(),
        overlapping_notes: overlapping_notes(notes),
    };
    (mappings, report)
}

/// Overlapping pairs within one tick-ordered note list, as index pairs.
///
/// At most `MAX_OVERLAP_PAIRS` pairs are reported.
fn overlap_pairs(notes: &[MidiNote]) -> Vec<(usize, usize)> {
    let mut pairs = Vec::new();
    for (i, first) in notes.iter().enumerate() {
        for (j, second) in notes.iter().enumerate().skip(i + 1) {
            if second.start_tick >= first.end_tick {
                break;
            }
            if first.start_tick < second.end_tick {
                pairs.push((i, j));
                if pairs.len() >= MAX_OVERLAP_PAIRS {
                    return pairs;
                }
            }
        }
    }
    pairs
}

/// Indices of notes that sound at once with another note in the same list, ascending.
fn overlapping_notes(notes: &[MidiNote]) -> Vec<usize> {
    let mut flagged = vec![false; notes.len()];
    for (first, second) in overlap_pairs(notes) {
        flagged[first] = true;
        flagged[second] = true;
    }
    flagged
        .iter()
        .enumerate()
        .filter(|(_, on)| **on)
        .map(|(i, _)| i)
        .collect()
}

/// Agreement between one blob and one note, or None when they do not overlap in time.
fn match_score(
    blob_start: f64,
    blob_end: f64,
    blob_midi: f64,
    note_start: f64,
    note_end: f64,
    key: u8,
) -> Option<f64> {
    let overlap = blob_end.min(note_end) - blob_start.max(note_start);
    if !overlap.is_finite() || overlap <= 0.0 {
        return None;
    }
    let union = blob_end.max(note_end) - blob_start.min(note_start);
    let temporal = if union > 0.0 { overlap / union } else { 0.0 };
    let distance = (blob_midi - f64::from(key)).abs();
    let pitch = if distance.is_finite() {
        1.0 / (1.0 + distance)
    } else {
        0.0
    };
    Some(OVERLAP_WEIGHT * temporal + PITCH_WEIGHT * pitch)
}

fn note_spans(notes: &[MidiNote], timeline: &TimelineMap) -> Vec<(f64, f64)> {
    notes
        .iter()
        .map(|n| {
            let start = timeline.tick_to_seconds(n.start_tick as f64);
            let end = timeline.tick_to_seconds(n.end_tick as f64);
            (start, end.max(start))
        })
        .collect()
}

fn span_order(spans: &[(f64, f64)]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..spans.len()).collect();
    order.sort_by(|&a, &b| spans[a].0.total_cmp(&spans[b].0));
    order
}

/// Slice of `order` whose note starts lie in `[from, to)`.
fn window<'a>(order: &'a [usize], spans: &[(f64, f64)], from: f64, to: f64) -> &'a [usize] {
    let lo = order.partition_point(|&i| spans[i].0 < from);
    let hi = order.partition_point(|&i| spans[i].0 < to);
    order.get(lo..hi.max(lo)).unwrap_or(&[])
}

/// Offset in seconds that moves `note_tick` onto `target_seconds`.
///
/// Applied by the caller to `TimelineMap::origin_seconds`, so audio never moves.
pub fn anchor_offset(timeline: &TimelineMap, note_tick: u64, target_seconds: f64) -> f64 {
    let current = timeline.tick_to_seconds(note_tick as f64);
    if !current.is_finite() || !target_seconds.is_finite() {
        return 0.0;
    }
    target_seconds - current
}

/// Difference between guide onsets and blob onsets at the start and end of the overlap,
/// which separates a wrong global offset from a wrong tempo map.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriftReport {
    /// Measured error at the earliest compared pair.
    pub early_error_seconds: f64,
    /// Measured error at the latest compared pair.
    pub late_error_seconds: f64,
    /// Constant component: a global offset fixes this.
    pub offset_seconds: f64,
    /// Growing component: only a tempo-map change fixes this.
    pub drift_seconds_per_second: f64,
    /// Number of blob and note onsets compared.
    pub pairs_compared: usize,
}

/// Measures alignment error between mapped blobs and their guide notes.
pub fn measure_drift(
    blobs: &[Blob],
    notes: &[MidiNote],
    mappings: &[NoteMapping],
    timeline: &TimelineMap,
) -> Option<DriftReport> {
    let mut pairs: Vec<(f64, f64)> = Vec::new();
    for mapping in mappings {
        if mapping.opted_out {
            continue;
        }
        let blob = blobs.iter().find(|blob| blob.id == mapping.blob);
        let (Some(note), Some(blob)) = (mapping.note, blob) else {
            continue;
        };
        let Some(note) = notes.get(note) else {
            continue;
        };
        let blob_onset = blob.edited_start();
        let note_onset = timeline.tick_to_seconds(note.start_tick as f64);
        if blob_onset.is_finite() && note_onset.is_finite() {
            pairs.push((blob_onset, note_onset - blob_onset));
        }
    }
    if pairs.is_empty() {
        return None;
    }
    pairs.sort_by(|a, b| a.0.total_cmp(&b.0));

    let n = pairs.len() as f64;
    let mean_t = pairs.iter().map(|p| p.0).sum::<f64>() / n;
    let mean_e = pairs.iter().map(|p| p.1).sum::<f64>() / n;
    let variance: f64 = pairs.iter().map(|p| (p.0 - mean_t).powi(2)).sum();
    let covariance: f64 = pairs
        .iter()
        .map(|p| (p.0 - mean_t) * (p.1 - mean_e))
        .sum::<f64>();
    let slope = if variance > f64::EPSILON {
        covariance / variance
    } else {
        0.0
    };

    Some(DriftReport {
        early_error_seconds: pairs[0].1,
        late_error_seconds: pairs[pairs.len() - 1].1,
        offset_seconds: mean_e - slope * mean_t,
        drift_seconds_per_second: slope,
        pairs_compared: pairs.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blob::Blob;

    fn varlen(mut value: u32, out: &mut Vec<u8>) {
        let mut stack = vec![(value & 0x7f) as u8];
        value >>= 7;
        while value > 0 {
            stack.push(((value & 0x7f) as u8) | 0x80);
            value >>= 7;
        }
        stack.reverse();
        out.extend_from_slice(&stack);
    }

    /// Serialises `(delta, event bytes)` pairs into an MTrk chunk with an end-of-track meta event.
    fn track(events: &[(u32, Vec<u8>)]) -> Vec<u8> {
        let mut body = Vec::new();
        for (delta, bytes) in events {
            varlen(*delta, &mut body);
            body.extend_from_slice(bytes);
        }
        varlen(0, &mut body);
        body.extend_from_slice(&[0xff, 0x2f, 0x00]);
        let mut chunk = b"MTrk".to_vec();
        chunk.extend_from_slice(&(body.len() as u32).to_be_bytes());
        chunk.extend_from_slice(&body);
        chunk
    }

    fn smf(format: u16, division: u16, tracks: &[Vec<u8>]) -> Vec<u8> {
        let mut out = b"MThd".to_vec();
        out.extend_from_slice(&6u32.to_be_bytes());
        out.extend_from_slice(&format.to_be_bytes());
        out.extend_from_slice(&(tracks.len() as u16).to_be_bytes());
        out.extend_from_slice(&division.to_be_bytes());
        for t in tracks {
            out.extend_from_slice(t);
        }
        out
    }

    fn note_on(channel: u8, key: u8, vel: u8) -> Vec<u8> {
        vec![0x90 | channel, key, vel]
    }

    fn note_off(channel: u8, key: u8) -> Vec<u8> {
        vec![0x80 | channel, key, 0x40]
    }

    fn tempo_meta(micros: u32) -> Vec<u8> {
        let b = micros.to_be_bytes();
        vec![0xff, 0x51, 0x03, b[1], b[2], b[3]]
    }

    fn meter_meta(numerator: u8, denominator_pow: u8) -> Vec<u8> {
        vec![0xff, 0x58, 0x04, numerator, denominator_pow, 24, 8]
    }

    fn track_name(name: &str) -> Vec<u8> {
        let mut out = vec![0xff, 0x03];
        varlen(name.len() as u32, &mut out);
        out.extend_from_slice(name.as_bytes());
        out
    }

    #[test]
    fn parses_a_single_note() {
        let bytes = smf(
            0,
            480,
            &[track(&[
                (0, track_name("Lead")),
                (0, note_on(0, 60, 100)),
                (480, note_off(0, 60)),
            ])],
        );
        let file = parse_smf(&bytes).unwrap();
        assert_eq!(file.format, 0);
        assert_eq!(file.ppq, 480);
        assert_eq!(file.notes.len(), 1);
        assert_eq!(file.notes[0].key, 60);
        assert_eq!(file.notes[0].velocity, 100);
        assert_eq!(file.notes[0].start_tick, 0);
        assert_eq!(file.notes[0].end_tick, 480);
        assert_eq!(file.tracks[0].name.as_deref(), Some("Lead"));
        assert_eq!(file.tracks[0].channels, vec![0]);
        assert!(!file.tracks[0].is_percussion);
        assert_eq!(file.tracks[0].last_tick, 480);
    }

    #[test]
    fn note_on_with_zero_velocity_ends_the_note() {
        let bytes = smf(
            0,
            96,
            &[track(&[
                (0, note_on(0, 64, 90)),
                (96, note_on(0, 64, 0)),
                (96, note_on(0, 64, 80)),
                (96, note_off(0, 64)),
            ])],
        );
        let file = parse_smf(&bytes).unwrap();
        assert_eq!(file.notes.len(), 2);
        assert_eq!(file.notes[0].end_tick, 96);
        assert_eq!(file.notes[1].start_tick, 192);
        assert_eq!(file.notes[1].end_tick, 288);
    }

    #[test]
    fn tempo_change_between_notes_lands_the_right_second() {
        let bytes = smf(
            1,
            480,
            &[
                track(&[(0, tempo_meta(500_000)), (960, tempo_meta(1_000_000))]),
                track(&[
                    (0, note_on(0, 60, 100)),
                    (480, note_off(0, 60)),
                    (480, note_on(0, 62, 100)),
                    (480, note_off(0, 62)),
                ]),
            ],
        );
        let file = parse_smf(&bytes).unwrap();
        assert_eq!(file.tempo.len(), 2);
        assert_eq!(file.tempo[0].micros_per_quarter, 500_000);
        assert_eq!(file.tempo[1].tick, 960);

        let timeline = file.to_timeline(48_000.0, 0.0).unwrap();
        // Two quarters at 120 bpm, then one quarter at 60 bpm.
        assert!((timeline.tick_to_seconds(960.0) - 1.0).abs() < 1e-9);
        assert!((timeline.tick_to_seconds(1440.0) - 2.0).abs() < 1e-9);
        let second = file.notes.iter().find(|n| n.key == 62).unwrap();
        assert!((timeline.tick_to_seconds(second.start_tick as f64) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn meter_change_is_kept() {
        let bytes = smf(
            1,
            480,
            &[
                track(&[(0, meter_meta(4, 2)), (1920, meter_meta(3, 2))]),
                track(&[(0, note_on(0, 60, 64)), (3840, note_off(0, 60))]),
            ],
        );
        let file = parse_smf(&bytes).unwrap();
        assert_eq!(file.meter.len(), 2);
        assert_eq!(file.meter[0].numerator, 4);
        assert_eq!(file.meter[0].denominator, 4);
        assert_eq!(file.meter[1].tick, 1920);
        assert_eq!(file.meter[1].numerator, 3);
        assert_eq!(file.meter[1].denominator, 4);
    }

    #[test]
    fn overlapping_notes_are_reported_not_resolved() {
        let bytes = smf(
            0,
            480,
            &[track(&[
                (0, note_on(0, 60, 100)),
                (240, note_on(0, 64, 100)),
                (240, note_off(0, 60)),
                (240, note_off(0, 64)),
            ])],
        );
        let file = parse_smf(&bytes).unwrap();
        assert_eq!(file.notes.len(), 2);
        let overlaps = file.overlaps(0, None);
        assert_eq!(overlaps.len(), 1);
        assert_eq!(overlaps[0].0.key, 60);
        assert_eq!(overlaps[0].1.key, 64);
        assert!(file.overlaps(0, Some(1)).is_empty());
    }

    #[test]
    fn percussion_channel_is_flagged() {
        let bytes = smf(
            1,
            480,
            &[
                track(&[(0, note_on(9, 38, 100)), (120, note_off(9, 38))]),
                track(&[(0, note_on(0, 60, 100)), (120, note_off(0, 60))]),
            ],
        );
        let file = parse_smf(&bytes).unwrap();
        assert!(file.tracks[0].is_percussion);
        assert!(!file.tracks[1].is_percussion);
    }

    #[test]
    fn percussion_program_is_flagged() {
        let program = vec![0xc0, 115];
        let bytes = smf(
            0,
            480,
            &[track(&[
                (0, program),
                (0, note_on(0, 60, 100)),
                (120, note_off(0, 60)),
            ])],
        );
        let file = parse_smf(&bytes).unwrap();
        assert!(file.tracks[0].is_percussion);
    }

    #[test]
    fn truncated_file_is_rejected() {
        let bytes = smf(
            0,
            480,
            &[track(&[(0, note_on(0, 60, 100)), (480, note_off(0, 60))])],
        );
        for cut in [4, 10, 13, 16, bytes.len() - 1] {
            let err = parse_smf(&bytes[..cut]).unwrap_err();
            assert!(matches!(err, AxysError::Invalid(_)), "cut {cut}: {err}");
        }
    }

    #[test]
    fn declared_track_count_must_be_present() {
        let mut bytes = smf(
            1,
            480,
            &[track(&[(0, note_on(0, 60, 100)), (10, note_off(0, 60))])],
        );
        bytes[11] = 4;
        assert!(matches!(parse_smf(&bytes), Err(AxysError::Invalid(_))));
    }

    #[test]
    fn smpte_division_is_unsupported() {
        let bytes = smf(
            0,
            0xE728,
            &[track(&[(0, note_on(0, 60, 100)), (10, note_off(0, 60))])],
        );
        assert!(matches!(parse_smf(&bytes), Err(AxysError::Unsupported(_))));
    }

    #[test]
    fn zero_division_is_rejected() {
        let bytes = smf(0, 0, &[track(&[(0, note_on(0, 60, 100))])]);
        assert!(matches!(parse_smf(&bytes), Err(AxysError::Invalid(_))));
    }

    #[test]
    fn unterminated_note_ends_at_the_last_event() {
        let bytes = smf(
            0,
            480,
            &[track(&[
                (0, note_on(0, 60, 100)),
                (960, note_on(0, 67, 100)),
                (480, note_off(0, 67)),
            ])],
        );
        let file = parse_smf(&bytes).unwrap();
        let held = file.notes.iter().find(|n| n.key == 60).unwrap();
        assert_eq!(held.start_tick, 0);
        assert_eq!(held.end_tick, 1440);
        assert_eq!(file.tracks[0].note_count, 2);
    }

    #[test]
    fn adversarial_input_never_panics() {
        assert!(parse_smf(&[]).is_err());
        assert!(parse_smf(b"not a midi file at all").is_err());
        let mut bogus = b"MThd".to_vec();
        bogus.extend_from_slice(&u32::MAX.to_be_bytes());
        bogus.extend_from_slice(&[0, 0, 0, 1, 1, 0xe0]);
        assert!(parse_smf(&bogus).is_err());

        // The first track chunk claims a length far past the end of the file.
        let mut lying_chunk = smf(0, 480, &[track(&[(0, note_on(0, 60, 1))])]);
        lying_chunk[18..22].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(parse_smf(&lying_chunk).is_err());

        for len in 0..40usize {
            let noise: Vec<u8> = (0..len).map(|i| (i as u8).wrapping_mul(37)).collect();
            let _ = parse_smf(&noise);
        }
    }

    #[test]
    fn oversized_file_is_rejected() {
        let bytes = vec![0u8; limits::MAX_MIDI_BYTES + 1];
        assert!(matches!(parse_smf(&bytes), Err(AxysError::Invalid(_))));
    }

    fn guide_timeline() -> TimelineMap {
        TimelineMap::default()
    }

    fn note(key: u8, start_tick: u64, end_tick: u64) -> MidiNote {
        MidiNote {
            track: 0,
            channel: 0,
            key,
            velocity: 100,
            start_tick,
            end_tick,
        }
    }

    fn blob_set(spec: &[(f64, f64, f64)]) -> BlobSet {
        let blobs = spec
            .iter()
            .enumerate()
            .map(|(i, (start, end, centre))| Blob::new(BlobId(i as u32), *start, *end, *centre))
            .collect();
        BlobSet::from_blobs(blobs).unwrap()
    }

    #[test]
    fn proposals_match_on_overlap_and_pitch() {
        // 480 ppq at 120 bpm: 480 ticks is half a second.
        let notes = [note(60, 0, 480), note(62, 480, 960)];
        let blobs = blob_set(&[(0.02, 0.48, 60.1), (0.52, 0.98, 61.8)]);
        let timeline = guide_timeline();
        let (mappings, report) = propose_mappings(&blobs, &notes, &timeline, &[]);
        assert_eq!(mappings.len(), 2);
        assert_eq!(mappings[0].note, Some(0));
        assert_eq!(mappings[1].note, Some(1));
        assert!(report.unmapped_blobs.is_empty());
        assert!(report.unmapped_notes.is_empty());
        assert!(report.multiply_mapped_notes.is_empty());
    }

    #[test]
    fn leftovers_are_reported_not_deleted() {
        let notes = [note(60, 0, 480), note(72, 4800, 5280)];
        let blobs = blob_set(&[(0.05, 0.45, 60.0), (2.0, 2.4, 64.0)]);
        let (mappings, report) = propose_mappings(&blobs, &notes, &guide_timeline(), &[]);
        assert_eq!(mappings[0].note, Some(0));
        assert_eq!(mappings[1].note, None);
        assert_eq!(report.unmapped_blobs, vec![BlobId(1)]);
        assert_eq!(report.unmapped_notes, vec![1]);
    }

    #[test]
    fn manual_mappings_survive_a_reproposal() {
        let notes = [note(60, 0, 480), note(62, 480, 960)];
        let blobs = blob_set(&[(0.02, 0.48, 60.1), (0.52, 0.98, 61.8)]);
        let existing = [NoteMapping {
            blob: BlobId(0),
            note: Some(1),
            manual: true,
            opted_out: false,
        }];
        let (mappings, report) = propose_mappings(&blobs, &notes, &guide_timeline(), &existing);
        assert_eq!(mappings[0].note, Some(1));
        assert!(mappings[0].manual);
        assert_eq!(mappings[1].note, None);
        assert_eq!(report.unmapped_notes, vec![0]);
    }

    #[test]
    fn opted_out_blobs_are_left_alone() {
        let notes = [note(60, 0, 480)];
        let blobs = blob_set(&[(0.02, 0.48, 60.0)]);
        let existing = [NoteMapping {
            blob: BlobId(0),
            note: None,
            manual: false,
            opted_out: true,
        }];
        let (mappings, report) = propose_mappings(&blobs, &notes, &guide_timeline(), &existing);
        assert_eq!(mappings[0].note, None);
        assert!(mappings[0].opted_out);
        assert!(report.unmapped_blobs.is_empty());
        assert_eq!(report.unmapped_notes, vec![0]);
    }

    #[test]
    fn multiply_mapped_notes_are_reported() {
        let notes = [note(60, 0, 960)];
        let blobs = blob_set(&[(0.0, 0.4, 60.0), (0.5, 0.9, 60.0)]);
        let existing = [
            NoteMapping {
                blob: BlobId(0),
                note: Some(0),
                manual: true,
                opted_out: false,
            },
            NoteMapping {
                blob: BlobId(1),
                note: Some(0),
                manual: true,
                opted_out: false,
            },
        ];
        let (_, report) = propose_mappings(&blobs, &notes, &guide_timeline(), &existing);
        assert_eq!(report.multiply_mapped_notes, vec![0]);
    }

    #[test]
    fn empty_inputs_propose_nothing() {
        let blobs = BlobSet::new();
        let (mappings, report) = propose_mappings(&blobs, &[], &guide_timeline(), &[]);
        assert!(mappings.is_empty());
        assert_eq!(report, MappingReport::default());
    }

    #[test]
    fn anchor_offset_moves_a_note_onto_a_target() {
        let timeline = guide_timeline();
        // 960 ticks at 120 bpm is 1.0 s; asking for 1.25 s needs +0.25 s of origin.
        let offset = anchor_offset(&timeline, 960, 1.25);
        assert!((offset - 0.25).abs() < 1e-12);
        let mut moved = timeline.clone();
        moved.origin_seconds += offset;
        assert!((moved.tick_to_seconds(960.0) - 1.25).abs() < 1e-12);
    }

    #[test]
    fn drift_separates_offset_from_tempo_error() {
        let notes = [note(60, 0, 240), note(62, 960, 1200), note(64, 1920, 2160)];
        // Blobs land 0.1 s late everywhere: a constant offset, no drift.
        let blobs = blob_set(&[(0.1, 0.3, 60.0), (1.1, 1.3, 62.0), (2.1, 2.3, 64.0)]);
        let mappings: Vec<NoteMapping> = (0..3)
            .map(|i| NoteMapping {
                blob: BlobId(i as u32),
                note: Some(i),
                manual: false,
                opted_out: false,
            })
            .collect();
        let report = measure_drift(blobs.blobs(), &notes, &mappings, &guide_timeline()).unwrap();
        assert_eq!(report.pairs_compared, 3);
        assert!((report.offset_seconds + 0.1).abs() < 1e-9);
        assert!(report.drift_seconds_per_second.abs() < 1e-9);
        assert!((report.early_error_seconds + 0.1).abs() < 1e-9);

        // Blobs progressively later: a growing error the tempo map has to absorb.
        let drifting = blob_set(&[(0.0, 0.2, 60.0), (1.1, 1.3, 62.0), (2.2, 2.4, 64.0)]);
        let report = measure_drift(drifting.blobs(), &notes, &mappings, &guide_timeline()).unwrap();
        assert!(report.drift_seconds_per_second < -0.04);
        assert!((report.early_error_seconds).abs() < 1e-9);
        assert!((report.late_error_seconds + 0.2).abs() < 1e-9);
    }

    #[test]
    fn drift_needs_at_least_one_pair() {
        let blobs = blob_set(&[(0.0, 0.2, 60.0)]);
        let notes = [note(60, 0, 240)];
        assert!(measure_drift(blobs.blobs(), &notes, &[], &guide_timeline()).is_none());
        let opted = [NoteMapping {
            blob: BlobId(0),
            note: Some(0),
            manual: false,
            opted_out: true,
        }];
        assert!(measure_drift(blobs.blobs(), &notes, &opted, &guide_timeline()).is_none());
        let dangling = [NoteMapping {
            blob: BlobId(0),
            note: Some(7),
            manual: true,
            opted_out: false,
        }];
        assert!(measure_drift(blobs.blobs(), &notes, &dangling, &guide_timeline()).is_none());
    }

    #[test]
    fn guide_selection_defaults_to_visual_only() {
        let selection = GuideSelection::default();
        assert_eq!(selection.track, 0);
        assert_eq!(selection.channel, None);
        assert_eq!(selection.mode, GuideMode::VisualOnly);
        assert!((selection.strength - 1.0).abs() < f64::EPSILON);
        assert!(!selection.muted);
    }

    #[test]
    fn guide_selection_round_trips_as_camel_case_json() {
        let selection = GuideSelection {
            track: 2,
            channel: Some(3),
            mode: GuideMode::TimingOnly,
            strength: 0.5,
            muted: true,
        };
        let json = serde_json::to_string(&selection).unwrap();
        assert!(json.contains("\"timingOnly\""));
        let back: GuideSelection = serde_json::from_str(&json).unwrap();
        assert_eq!(back, selection);
    }

    #[test]
    fn timeline_rejects_a_non_finite_origin() {
        let bytes = smf(0, 480, &[track(&[(0, note_on(0, 60, 1))])]);
        let file = parse_smf(&bytes).unwrap();
        assert!(file.to_timeline(48_000.0, f64::NAN).is_err());
    }
}
