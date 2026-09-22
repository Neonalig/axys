// SPDX-License-Identifier: AGPL-3.0-or-later

//! Provisional segmentation of analysed audio into editable blobs.
//!
//! Voiced spans are the candidate notes. Sustained pitch steps and spectral-flux onsets cut
//! them, fragments too short to edit merge into a neighbour, and leading unvoiced consonant
//! material joins the note it introduces.

use serde::{Deserialize, Serialize};

use crate::analysis::energy::{is_unvoiced_consonant, EnergyTrack};
use crate::analysis::f0::PitchTrack;
use crate::blob::{Blob, BlobId, BlobSet, Subregion, Voicing};
use crate::{limits, AxysError, Result};

/// Longest accepted analysis hop, in seconds.
const MAX_HOP_SECONDS: f64 = 1.0;

/// Longest run of leading consonant noise attached to a following blob, in seconds.
const MAX_CONSONANT_SECONDS: f64 = 0.25;

/// Multiple of the hold time used for the corroborating wide pitch window.
const LONG_WINDOW_FACTOR: f64 = 4.0;

/// Shortest corroborating wide pitch window, in seconds.
///
/// Wide enough to span a vibrato cycle, so a modulated note reads as one level at this scale.
const MIN_LONG_WINDOW_SECONDS: f64 = 0.18;

/// Parameters controlling provisional blob segmentation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentParams {
    /// Shortest blob the segmenter will emit, in seconds.
    pub min_blob_seconds: f64,
    /// Shortest unvoiced gap that separates two notes rather than sitting inside one.
    pub min_silence_seconds: f64,
    /// Sustained pitch step that splits a note, in semitones.
    pub pitch_change_semitones: f64,
    /// How long a pitch step must hold to count as a new note, in seconds.
    pub pitch_hold_seconds: f64,
    /// Normalised spectral-flux level a peak must reach to cut a note.
    pub onset_threshold: f32,
    /// Attaches leading unvoiced consonant material to the following blob.
    pub attach_consonants: bool,
}

impl Default for SegmentParams {
    fn default() -> Self {
        Self {
            min_blob_seconds: 0.06,
            min_silence_seconds: 0.05,
            pitch_change_semitones: 0.9,
            pitch_hold_seconds: 0.045,
            onset_threshold: 0.35,
            attach_consonants: true,
        }
    }
}

/// Produces provisional blobs from pitch, energy and onset evidence.
///
/// Voiced spans become candidate notes, sustained pitch steps and flux onsets split them,
/// short fragments merge into their nearest neighbour, and leading unvoiced consonant
/// material attaches to the following blob when `attach_consonants` is set.
pub fn segment(
    track: &PitchTrack,
    energy: &EnergyTrack,
    params: &SegmentParams,
) -> Result<BlobSet> {
    validate(params)?;
    if track.frames.is_empty() {
        return Ok(BlobSet::new());
    }
    let hop = track.hop_seconds;
    if !hop.is_finite() || hop <= 0.0 || hop > MAX_HOP_SECONDS {
        return Err(AxysError::Invalid(format!(
            "pitch track hop {hop} outside 0..={MAX_HOP_SECONDS}"
        )));
    }

    let mut regions = Vec::new();
    for span in voiced_runs(track, params.min_silence_seconds) {
        let cuts = cut_points(track, energy, span, params);
        let mut from = span.0;
        for cut in cuts {
            regions.push((from, cut - 1));
            from = cut;
        }
        regions.push((from, span.1));
    }

    merge_short(&mut regions, track, params);
    if params.attach_consonants {
        attach_consonants(&mut regions, track, energy);
    }

    if regions.len() > limits::MAX_BLOBS {
        return Err(AxysError::Invalid(format!(
            "segmentation produced {} blobs, over the {} limit",
            regions.len(),
            limits::MAX_BLOBS
        )));
    }

    let mut blobs = Vec::with_capacity(regions.len());
    for (index, &(first, last)) in regions.iter().enumerate() {
        let start = track.frames[first].time;
        let end = track.frames[last].time + hop;
        let Some(centre) = track.median_midi(start, end) else {
            continue;
        };
        let id = BlobId(u32::try_from(index).unwrap_or(u32::MAX));
        let mut blob = Blob::new(id, start, end, centre);
        blob.subregions = subregions(track, energy, first, last, start, end);
        blobs.push(blob);
    }
    for (index, blob) in blobs.iter_mut().enumerate() {
        blob.id = BlobId(u32::try_from(index).unwrap_or(u32::MAX));
    }
    BlobSet::from_blobs(blobs)
}

/// Rejects parameters that would make segmentation meaningless or unbounded.
fn validate(params: &SegmentParams) -> Result<()> {
    let finite = params.min_blob_seconds.is_finite()
        && params.min_silence_seconds.is_finite()
        && params.pitch_change_semitones.is_finite()
        && params.pitch_hold_seconds.is_finite()
        && params.onset_threshold.is_finite();
    if !finite {
        return Err(AxysError::Invalid(
            "segment parameters must be finite".into(),
        ));
    }
    if params.min_blob_seconds <= 0.0 || params.min_blob_seconds > MAX_HOP_SECONDS * 60.0 {
        return Err(AxysError::Invalid(format!(
            "min blob seconds {} must be positive",
            params.min_blob_seconds
        )));
    }
    if params.min_silence_seconds < 0.0 {
        return Err(AxysError::Invalid(format!(
            "min silence seconds {} must not be negative",
            params.min_silence_seconds
        )));
    }
    if params.pitch_change_semitones <= 0.0 {
        return Err(AxysError::Invalid(format!(
            "pitch change semitones {} must be positive",
            params.pitch_change_semitones
        )));
    }
    if params.pitch_hold_seconds <= 0.0 {
        return Err(AxysError::Invalid(format!(
            "pitch hold seconds {} must be positive",
            params.pitch_hold_seconds
        )));
    }
    Ok(())
}

/// Inclusive frame ranges of voiced material, bridging gaps under `min_silence`.
fn voiced_runs(track: &PitchTrack, min_silence: f64) -> Vec<(usize, usize)> {
    let hop = track.hop_seconds;
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for (index, frame) in track.frames.iter().enumerate() {
        if !frame.voiced || !frame.midi.is_finite() {
            continue;
        }
        match runs.last_mut() {
            Some(last) if last.1 + 1 == index => last.1 = index,
            _ => runs.push((index, index)),
        }
    }

    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(runs.len());
    for run in runs {
        match merged.last_mut() {
            Some(previous) => {
                let gap = (run.0 - previous.1 - 1) as f64 * hop;
                if gap < min_silence {
                    previous.1 = run.1;
                } else {
                    merged.push(run);
                }
            }
            None => merged.push(run),
        }
    }
    merged
}

/// Frame indices inside `span` where a new blob begins, ascending.
fn cut_points(
    track: &PitchTrack,
    energy: &EnergyTrack,
    span: (usize, usize),
    params: &SegmentParams,
) -> Vec<usize> {
    let hop = track.hop_seconds;
    let separation = (params.min_blob_seconds / hop).ceil().max(1.0) as usize;

    let mut candidates = pitch_step_candidates(track, span, params);
    candidates.sort_by(|a, b| b.rank().total_cmp(&a.rank()).then(a.index.cmp(&b.index)));

    let mut kept: Vec<usize> = Vec::new();
    for cut in candidates {
        let index = cut.index;
        if kept.iter().any(|&other| index.abs_diff(other) < separation) {
            continue;
        }
        kept.push(index);
    }

    for time in energy.onsets(params.onset_threshold, params.min_blob_seconds) {
        let Some(index) = track.frame_index_at(time) else {
            continue;
        };
        if index <= span.0 || index > span.1 {
            continue;
        }
        if kept.iter().any(|&other| index.abs_diff(other) < separation) {
            continue;
        }
        kept.push(index);
    }

    kept.sort_unstable();
    kept
}

/// A frame where the pitch steps to a new level, with the evidence for it.
#[derive(Debug, Clone, Copy)]
struct Cut {
    index: usize,
    /// Size of the sustained step across the frame, in semitones.
    step: f64,
    /// Size of the frame-to-frame move, which separates a sharp step from a glide.
    jump: f64,
}

impl Cut {
    /// Combined strength, used to choose between competing cuts.
    fn rank(&self) -> f64 {
        self.step + self.jump
    }
}

/// Frames where the pitch steps and holds, ranked by the strength of the step.
///
/// A step must show at both the hold scale and a wider scale, so vibrato, which averages
/// out over the wider window, does not split a note.
fn pitch_step_candidates(
    track: &PitchTrack,
    span: (usize, usize),
    params: &SegmentParams,
) -> Vec<Cut> {
    let hop = track.hop_seconds;
    let short = (params.pitch_hold_seconds / hop).round().max(1.0) as usize;
    let long_seconds =
        (params.pitch_hold_seconds * LONG_WINDOW_FACTOR).max(MIN_LONG_WINDOW_SECONDS);
    let long = (long_seconds / hop).round().max(short as f64) as usize;

    let mut found = Vec::new();
    for index in (span.0 + 1)..=span.1 {
        let Some(short_step) = window_step(track, span, index, short) else {
            continue;
        };
        if short_step.abs() < params.pitch_change_semitones {
            continue;
        }
        let Some(long_step) = window_step(track, span, index, long) else {
            continue;
        };
        if long_step.abs() < params.pitch_change_semitones {
            continue;
        }
        if short_step.signum() != long_step.signum() {
            continue;
        }
        found.push(Cut {
            index,
            step: short_step.abs(),
            jump: frame_jump(track, index),
        });
    }
    prune_plateaus(found)
}

/// Absolute pitch move between a frame and the one before it, 0.0 when either is unvoiced.
fn frame_jump(track: &PitchTrack, index: usize) -> f64 {
    let Some(before) = index.checked_sub(1) else {
        return 0.0;
    };
    let (Some(previous), Some(current)) = (track.frames.get(before), track.frames.get(index))
    else {
        return 0.0;
    };
    if !previous.voiced
        || !current.voiced
        || !previous.midi.is_finite()
        || !current.midi.is_finite()
    {
        return 0.0;
    }
    (current.midi - previous.midi).abs()
}

/// Median pitch after `index` minus median pitch before it, over `width` frames each side.
fn window_step(
    track: &PitchTrack,
    span: (usize, usize),
    index: usize,
    width: usize,
) -> Option<f64> {
    let before_first = index.saturating_sub(width).max(span.0);
    let after_last = (index + width - 1).min(span.1);
    let before = median_midi(track, before_first, index - 1)?;
    let after = median_midi(track, index, after_last)?;
    Some(after - before)
}

/// Median fractional MIDI over voiced frames in the inclusive index range.
fn median_midi(track: &PitchTrack, first: usize, last: usize) -> Option<f64> {
    if first > last {
        return None;
    }
    let mut values: Vec<f64> = track
        .frames
        .get(first..=last)?
        .iter()
        .filter(|frame| frame.voiced && frame.midi.is_finite())
        .map(|frame| frame.midi)
        .collect();
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    let mid = values.len() / 2;
    if values.len() % 2 == 1 {
        Some(values[mid])
    } else {
        Some(0.5 * (values[mid - 1] + values[mid]))
    }
}

/// Keeps the strongest cut of each run of adjacent candidates.
fn prune_plateaus(candidates: Vec<Cut>) -> Vec<Cut> {
    let mut pruned: Vec<Cut> = Vec::new();
    let mut best: Option<Cut> = None;
    let mut run_end = 0usize;
    for candidate in candidates {
        match best {
            Some(current) if run_end + 1 == candidate.index => {
                if candidate.rank() > current.rank() {
                    best = Some(candidate);
                }
                run_end = candidate.index;
            }
            Some(current) => {
                pruned.push(current);
                best = Some(candidate);
                run_end = candidate.index;
            }
            None => {
                best = Some(candidate);
                run_end = candidate.index;
            }
        }
    }
    pruned.extend(best);
    pruned
}

/// Folds regions shorter than `min_blob_seconds` into the nearest touching neighbour.
///
/// A short region with no neighbour inside `min_silence_seconds` is dropped: it is a
/// detection blip rather than a fragment of a note.
fn merge_short(regions: &mut Vec<(usize, usize)>, track: &PitchTrack, params: &SegmentParams) {
    let hop = track.hop_seconds;
    let duration = |region: (usize, usize)| (region.1 + 1 - region.0) as f64 * hop;
    let gap = |left: (usize, usize), right: (usize, usize)| (right.0 - left.1 - 1) as f64 * hop;

    let mut guard = regions.len() + 1;
    while guard > 0 {
        guard -= 1;
        let Some(index) = (0..regions.len())
            .filter(|&i| duration(regions[i]) < params.min_blob_seconds)
            .min_by(|&a, &b| duration(regions[a]).total_cmp(&duration(regions[b])))
        else {
            return;
        };

        let before = index
            .checked_sub(1)
            .map(|i| (i, gap(regions[i], regions[index])));
        let after = regions
            .get(index + 1)
            .map(|&next| (index + 1, gap(regions[index], next)));
        let target = match (before, after) {
            (Some(a), Some(b)) => Some(if b.1 < a.1 { b } else { a }),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };

        match target {
            Some((neighbour, distance)) if distance < params.min_silence_seconds => {
                let merged = (
                    regions[neighbour].0.min(regions[index].0),
                    regions[neighbour].1.max(regions[index].1),
                );
                regions[neighbour] = merged;
                regions.remove(index);
            }
            _ => {
                regions.remove(index);
            }
        }
    }
}

/// Extends each region backwards over contiguous unvoiced consonant frames.
fn attach_consonants(regions: &mut [(usize, usize)], track: &PitchTrack, energy: &EnergyTrack) {
    let hop = track.hop_seconds;
    let limit = (MAX_CONSONANT_SECONDS / hop).round().max(1.0) as usize;
    let mut floor = 0usize;
    for region in regions.iter_mut() {
        let (first, last) = *region;
        let mut start = first;
        while start > floor && first - start < limit {
            let candidate = start - 1;
            let frame = &track.frames[candidate];
            let (rms, zcr) = energy_at(energy, frame.time);
            if frame.voiced || !is_unvoiced_consonant(rms, zcr, frame.voiced) {
                break;
            }
            start = candidate;
        }
        *region = (start, last);
        floor = last + 1;
    }
}

/// Frame RMS and zero-crossing rate nearest `time`, or zeroes when the grid is empty.
fn energy_at(energy: &EnergyTrack, time: f64) -> (f32, f32) {
    if energy.times.is_empty() || !time.is_finite() {
        return (0.0, 0.0);
    }
    let upper = energy.times.partition_point(|&t| t < time);
    let index = if upper == 0 {
        0
    } else if upper >= energy.times.len() {
        energy.times.len() - 1
    } else if (time - energy.times[upper - 1]).abs() <= (energy.times[upper] - time).abs() {
        upper - 1
    } else {
        upper
    };
    (
        energy.rms.get(index).copied().unwrap_or(0.0),
        energy.zero_crossing_rate.get(index).copied().unwrap_or(0.0),
    )
}

/// Voicing classification of every frame in the region, as merged spans covering it whole.
fn subregions(
    track: &PitchTrack,
    energy: &EnergyTrack,
    first: usize,
    last: usize,
    start: f64,
    end: f64,
) -> Vec<Subregion> {
    let hop = track.hop_seconds;
    let mut spans: Vec<Subregion> = Vec::new();
    for index in first..=last {
        let frame = &track.frames[index];
        let voicing = if frame.voiced && frame.midi.is_finite() {
            Voicing::Voiced
        } else {
            let (rms, zcr) = energy_at(energy, frame.time);
            if is_unvoiced_consonant(rms, zcr, false) {
                Voicing::Unvoiced
            } else {
                Voicing::Silence
            }
        };
        let from = frame.time.max(start);
        let to = (frame.time + hop).min(end);
        match spans.last_mut() {
            Some(previous) if previous.voicing == voicing => previous.end = to,
            _ => spans.push(Subregion {
                start: from,
                end: to,
                voicing,
            }),
        }
    }
    if let Some(head) = spans.first_mut() {
        head.start = start;
    }
    if let Some(tail) = spans.last_mut() {
        tail.end = end;
    }
    spans
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::energy::analyse_energy;
    use crate::analysis::f0::{detect_f0, F0Params, PitchFrame};

    const HOP: f64 = 0.005;
    const RATE: f64 = 48_000.0;

    /// Builds a track from per-frame MIDI values, None meaning unvoiced.
    fn track_of(levels: &[Option<f64>]) -> PitchTrack {
        PitchTrack {
            sample_rate: RATE,
            hop_seconds: HOP,
            frames: levels
                .iter()
                .enumerate()
                .map(|(index, level)| PitchFrame {
                    time: index as f64 * HOP,
                    f0: level.map_or(0.0, |midi| 440.0 * 2f64.powf((midi - 69.0) / 12.0)),
                    midi: level.unwrap_or(f64::NAN),
                    confidence: if level.is_some() { 0.9 } else { 0.0 },
                    rms: if level.is_some() { 0.2 } else { 0.0 },
                    voiced: level.is_some(),
                })
                .collect(),
        }
    }

    /// Builds a flat energy grid matching a track built by `track_of`.
    fn energy_of(len: usize, rms: f32, zcr: f32) -> EnergyTrack {
        EnergyTrack {
            hop_seconds: HOP,
            times: (0..len).map(|i| i as f64 * HOP).collect(),
            rms: vec![rms; len],
            rms_db: vec![20.0 * rms.max(1e-6).log10(); len],
            spectral_flux: vec![0.0; len],
            zero_crossing_rate: vec![zcr; len],
        }
    }

    fn repeat(level: Option<f64>, frames: usize) -> Vec<Option<f64>> {
        vec![level; frames]
    }

    /// Renders a phase-continuous sine of the given per-segment frequencies.
    fn tone(segments: &[(f64, f64)]) -> Vec<f32> {
        let mut out = Vec::new();
        let mut phase = 0.0f64;
        for &(hz, seconds) in segments {
            let count = (seconds * RATE) as usize;
            for i in 0..count {
                let amplitude = if hz <= 0.0 {
                    0.0
                } else {
                    let fade = (i as f64 / (0.01 * RATE)).min(1.0);
                    let tail = ((count - i) as f64 / (0.01 * RATE)).min(1.0);
                    0.5 * fade * tail
                };
                out.push((amplitude * phase.sin()) as f32);
                phase += std::f64::consts::TAU * hz / RATE;
            }
        }
        out
    }

    fn analyse(samples: &[f32]) -> (PitchTrack, EnergyTrack) {
        let params = F0Params::default();
        let track = detect_f0(samples, RATE, &params).expect("pitch analysis");
        let energy =
            analyse_energy(samples, RATE, params.frame_seconds, HOP).expect("energy analysis");
        (track, energy)
    }

    #[test]
    fn empty_track_gives_no_blobs() {
        let set = segment(
            &PitchTrack::default(),
            &EnergyTrack::default(),
            &SegmentParams::default(),
        )
        .expect("segment");
        assert!(set.is_empty());
    }

    #[test]
    fn invalid_parameters_are_rejected() {
        let track = track_of(&repeat(Some(60.0), 40));
        let energy = energy_of(40, 0.2, 0.05);
        for params in [
            SegmentParams {
                min_blob_seconds: 0.0,
                ..Default::default()
            },
            SegmentParams {
                pitch_hold_seconds: -1.0,
                ..Default::default()
            },
            SegmentParams {
                pitch_change_semitones: f64::NAN,
                ..Default::default()
            },
            SegmentParams {
                min_silence_seconds: -0.1,
                ..Default::default()
            },
        ] {
            assert!(segment(&track, &energy, &params).is_err());
        }
    }

    #[test]
    fn zero_hop_is_rejected() {
        let mut track = track_of(&repeat(Some(60.0), 40));
        track.hop_seconds = 0.0;
        let energy = energy_of(40, 0.2, 0.05);
        assert!(segment(&track, &energy, &SegmentParams::default()).is_err());
    }

    #[test]
    fn two_notes_separated_by_silence_give_two_blobs() {
        let mut levels = repeat(Some(60.0), 60);
        levels.extend(repeat(None, 40));
        levels.extend(repeat(Some(67.0), 60));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 2);
        let blobs = set.blobs();
        assert!((blobs[0].detected_center - 60.0).abs() < 1e-9);
        assert!((blobs[1].detected_center - 67.0).abs() < 1e-9);
        assert!(blobs[0].end <= blobs[1].start);
    }

    #[test]
    fn short_unvoiced_dip_does_not_split_a_note() {
        let mut levels = repeat(Some(60.0), 60);
        levels.extend(repeat(None, 4));
        levels.extend(repeat(Some(60.0), 60));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn vibrato_stays_one_blob() {
        let frames = 200;
        let levels: Vec<Option<f64>> = (0..frames)
            .map(|i| {
                let t = i as f64 * HOP;
                Some(62.0 + 0.5 * (std::f64::consts::TAU * 5.5 * t).sin())
            })
            .collect();
        let energy = energy_of(frames, 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 1);
        assert!((set.blobs()[0].detected_center - 62.0).abs() < 0.2);
    }

    #[test]
    fn a_sustained_whole_tone_step_splits_the_note() {
        let mut levels = repeat(Some(60.0), 100);
        levels.extend(repeat(Some(62.0), 100));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 2);
        let blobs = set.blobs();
        assert!((blobs[0].end - 0.5).abs() < 2.0 * HOP, "{}", blobs[0].end);
        assert!((blobs[0].detected_center - 60.0).abs() < 1e-9);
        assert!((blobs[1].detected_center - 62.0).abs() < 1e-9);
        assert!((blobs[1].start - blobs[0].end).abs() < 1e-9);
    }

    #[test]
    fn a_brief_step_does_not_split_the_note() {
        let mut levels = repeat(Some(60.0), 100);
        levels.extend(repeat(Some(62.0), 4));
        levels.extend(repeat(Some(60.0), 100));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn a_short_fragment_merges_into_its_neighbour() {
        let mut levels = repeat(Some(60.0), 4);
        levels.extend(repeat(Some(64.0), 100));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 1);
        let blob = &set.blobs()[0];
        assert!(blob.start.abs() < 1e-9);
        assert!(blob.duration() > 0.5);
    }

    #[test]
    fn an_isolated_blip_is_dropped() {
        let mut levels = repeat(Some(60.0), 3);
        levels.extend(repeat(None, 40));
        levels.extend(repeat(Some(67.0), 60));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 1);
        assert!((set.blobs()[0].detected_center - 67.0).abs() < 1e-9);
    }

    #[test]
    fn a_leading_noise_burst_attaches_to_the_following_blob() {
        let mut levels = repeat(None, 20);
        levels.extend(repeat(Some(60.0), 80));
        let track = track_of(&levels);
        let mut energy = energy_of(levels.len(), 0.2, 0.4);
        for index in 0..10 {
            energy.rms[index] = 0.0;
            energy.zero_crossing_rate[index] = 0.0;
        }

        let set = segment(&track, &energy, &SegmentParams::default()).expect("segment");
        assert_eq!(set.len(), 1);
        let blob = &set.blobs()[0];
        assert!((blob.start - 0.05).abs() < 1e-9, "{}", blob.start);
        assert_eq!(
            blob.subregions.first().map(|s| s.voicing),
            Some(Voicing::Unvoiced)
        );
        assert!(blob.subregions.iter().any(|s| s.voicing == Voicing::Voiced));
        assert!((blob.subregions[0].start - blob.start).abs() < 1e-9);
        assert!((blob.subregions[blob.subregions.len() - 1].end - blob.end).abs() < 1e-9);
    }

    #[test]
    fn consonant_attachment_can_be_turned_off() {
        let mut levels = repeat(None, 20);
        levels.extend(repeat(Some(60.0), 80));
        let track = track_of(&levels);
        let mut energy = energy_of(levels.len(), 0.2, 0.4);
        for index in 0..10 {
            energy.rms[index] = 0.0;
            energy.zero_crossing_rate[index] = 0.0;
        }
        let params = SegmentParams {
            attach_consonants: false,
            ..Default::default()
        };
        let set = segment(&track, &energy, &params).expect("segment");
        assert!((set.blobs()[0].start - 0.1).abs() < 1e-9);
    }

    #[test]
    fn subregions_cover_the_blob_without_gaps() {
        let mut levels = repeat(Some(60.0), 40);
        levels.extend(repeat(None, 4));
        levels.extend(repeat(Some(60.0), 40));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        let blob = &set.blobs()[0];
        assert!(blob.subregions.len() >= 3);
        assert!((blob.subregions[0].start - blob.start).abs() < 1e-9);
        for pair in blob.subregions.windows(2) {
            assert!((pair[0].end - pair[1].start).abs() < 1e-9);
        }
        assert!((blob.subregions.last().expect("tail").end - blob.end).abs() < 1e-9);
    }

    #[test]
    fn blob_ids_are_unique_and_ordered() {
        let mut levels = repeat(Some(60.0), 60);
        levels.extend(repeat(None, 40));
        levels.extend(repeat(Some(67.0), 60));
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let set = segment(&track_of(&levels), &energy, &SegmentParams::default()).expect("segment");

        let ids: Vec<u32> = set.blobs().iter().map(|b| b.id.0).collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len());
        for pair in set.blobs().windows(2) {
            assert!(pair[0].start <= pair[1].start);
        }
    }

    #[test]
    fn two_recorded_notes_across_silence_segment_apart() {
        let samples = tone(&[(220.0, 0.45), (0.0, 0.25), (261.63, 0.45)]);
        let (track, energy) = analyse(&samples);
        let set = segment(&track, &energy, &SegmentParams::default()).expect("segment");

        assert_eq!(set.len(), 2, "{:?}", set.blobs());
        let blobs = set.blobs();
        assert!((blobs[0].detected_center - 57.0).abs() < 0.3);
        assert!((blobs[1].detected_center - 60.0).abs() < 0.3);
    }

    #[test]
    fn a_recorded_slur_of_a_whole_tone_splits() {
        let samples = tone(&[(220.0, 0.5), (246.94, 0.5)]);
        let (track, energy) = analyse(&samples);
        let set = segment(&track, &energy, &SegmentParams::default()).expect("segment");

        assert!(set.len() >= 2, "{:?}", set.blobs());
        let blobs = set.blobs();
        assert!((blobs[0].detected_center - 57.0).abs() < 0.5);
        assert!((blobs[blobs.len() - 1].detected_center - 59.0).abs() < 0.5);
    }

    #[test]
    fn segmentation_is_deterministic() {
        let mut levels = repeat(Some(60.0), 60);
        levels.extend(repeat(None, 40));
        levels.extend(repeat(Some(67.0), 60));
        let track = track_of(&levels);
        let energy = energy_of(levels.len(), 0.0, 0.0);
        let first = segment(&track, &energy, &SegmentParams::default()).expect("segment");
        let second = segment(&track, &energy, &SegmentParams::default()).expect("segment");
        assert_eq!(first, second);
    }
}
