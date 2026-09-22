// SPDX-License-Identifier: AGPL-3.0-or-later

//! Editable note-like regions of the analysed vocal and the set that owns them.
//!
//! A blob is a musical segmentation decision over immutable analysis: it carries the
//! detected pitch centre, the user's pitch and timing offsets, a classification of its
//! interior into voiced, unvoiced and silent subregions, and a drawn pitch curve. The set
//! keeps blobs ordered and non-overlapping in source time and owns the structural edits
//! (split, join, boundary moves, reclassification) that must preserve existing edits.

use crate::analysis::f0::PitchTrack;
use crate::curve::{Anchor, PitchCurve};
use crate::{limits, AxysError, Result};
use serde::{Deserialize, Serialize};

/// Shortest blob a boundary edit may produce, in seconds.
pub const MIN_BLOB_SECONDS: f64 = 0.01;

/// Tolerance used when comparing source times for adjacency.
const EPS: f64 = 1e-9;

/// Stable identifier for a blob within one project.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, Default,
)]
pub struct BlobId(pub u32);

/// How a subregion of a blob was classified by analysis or by the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Voicing {
    /// Pitched material that follows the target contour.
    Voiced,
    /// Unpitched material such as a fricative, passed through rather than repitched.
    Unvoiced,
    /// No signal worth treating as either.
    Silence,
}

/// A classified span inside a blob.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Subregion {
    /// Span start in source seconds.
    pub start: f64,
    /// Span end in source seconds.
    pub end: f64,
    /// Classification of the span.
    pub voicing: Voicing,
}

impl Subregion {
    /// Creates a subregion.
    pub fn new(start: f64, end: f64, voicing: Voicing) -> Self {
        Self {
            start,
            end,
            voicing,
        }
    }

    /// Span length in seconds.
    pub fn duration(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }
}

/// An editable note-like region of the analysed vocal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blob {
    /// Identity within the owning set.
    pub id: BlobId,
    /// Detected start in source seconds.
    pub start: f64,
    /// Detected end in source seconds.
    pub end: f64,
    /// Representative detected pitch, fractional MIDI.
    pub detected_center: f64,
    /// Semitone offset the user has applied to the whole blob.
    pub pitch_offset: f64,
    /// Seconds the blob has been moved along the timeline.
    pub time_offset: f64,
    /// Scale factor applied to the blob duration; 1.0 leaves it unchanged.
    pub time_scale: f64,
    /// Interior classification, ordered and non-overlapping.
    pub subregions: Vec<Subregion>,
    /// Anchors editing the target inside this blob, in source seconds.
    pub curve: PitchCurve,
    /// Excludes the blob from automatic scale correction.
    pub excluded: bool,
    /// Level applied to the blob in the render, in decibels; 0.0 leaves it as sung.
    #[serde(default)]
    pub gain_db: f64,
}

impl Blob {
    /// Creates a blob spanning `start..end` classified wholly as voiced.
    pub fn new(id: BlobId, start: f64, end: f64, detected_center: f64) -> Self {
        let end = end.max(start);
        Self {
            id,
            start,
            end,
            detected_center,
            pitch_offset: 0.0,
            time_offset: 0.0,
            time_scale: 1.0,
            subregions: vec![Subregion::new(start, end, Voicing::Voiced)],
            curve: PitchCurve::new(),
            excluded: false,
            gain_db: 0.0,
        }
    }

    /// Detected length in seconds.
    pub fn duration(&self) -> f64 {
        (self.end - self.start).max(0.0)
    }

    /// Edited start, after `time_offset`.
    pub fn edited_start(&self) -> f64 {
        self.start + self.time_offset
    }

    /// Edited end, after `time_offset` and `time_scale`.
    pub fn edited_end(&self) -> f64 {
        self.edited_start() + self.duration() * self.time_scale
    }

    /// True when `time` falls in the detected span, end exclusive.
    pub fn contains(&self, time: f64) -> bool {
        time >= self.start && time < self.end
    }

    /// Target pitch centre: detected centre plus the user offset.
    pub fn target_center(&self) -> f64 {
        self.detected_center + self.pitch_offset
    }

    /// Classification at `time`, `Silence` where nothing is classified.
    pub fn voicing_at(&self, time: f64) -> Voicing {
        for region in &self.subregions {
            if time >= region.start && time < region.end {
                return region.voicing;
            }
        }
        if let Some(last) = self.subregions.last() {
            if (time - last.end).abs() <= EPS {
                return last.voicing;
            }
        }
        Voicing::Silence
    }

    /// Re-derives `detected_center` from `track` over the blob span, keeping the old value
    /// when the span holds no voiced frame.
    fn rederive_center(&mut self, track: Option<&PitchTrack>) {
        if let Some(track) = track {
            if let Some(midi) = track.median_midi(self.start, self.end) {
                self.detected_center = midi;
            }
        }
    }
}

/// Which edge of a blob a boundary edit addresses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Edge {
    /// The earlier boundary.
    Start,
    /// The later boundary.
    End,
}

/// Whether edited blobs collide or leave a hole.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictKind {
    /// Two blobs claim the same output time.
    Overlap,
    /// Timing edits opened a hole that the detected layout did not have.
    Gap,
}

/// An overlap or gap between edited blob positions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimingConflict {
    /// Earlier blob by edited start.
    pub first: BlobId,
    /// Later blob by edited start.
    pub second: BlobId,
    /// Start of the contested or empty span, in source seconds.
    pub start: f64,
    /// End of the contested or empty span, in source seconds.
    pub end: f64,
    /// Whether the span is contested or empty.
    pub kind: ConflictKind,
}

/// An ordered, non-overlapping set of blobs.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlobSet {
    blobs: Vec<Blob>,
    next_id: u32,
}

impl BlobSet {
    /// Creates an empty set.
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a set from blobs, sorting by start and rejecting overlaps.
    pub fn from_blobs(blobs: Vec<Blob>) -> Result<Self> {
        if blobs.len() > limits::MAX_BLOBS {
            return Err(AxysError::Invalid(format!(
                "{} blobs, limit is {}",
                blobs.len(),
                limits::MAX_BLOBS
            )));
        }
        let mut set = Self::default();
        let mut sorted = blobs;
        for blob in &sorted {
            validate_blob(blob)?;
        }
        sorted.sort_by(|a, b| a.start.total_cmp(&b.start));
        for pair in sorted.windows(2) {
            if pair[1].start < pair[0].end - EPS {
                return Err(AxysError::Invalid(format!(
                    "blobs {:?} and {:?} overlap",
                    pair[0].id, pair[1].id
                )));
            }
        }
        let mut seen: Vec<u32> = sorted.iter().map(|b| b.id.0).collect();
        seen.sort_unstable();
        if seen.windows(2).any(|w| w[0] == w[1]) {
            return Err(AxysError::Invalid("duplicate blob id".into()));
        }
        set.next_id = seen.last().map_or(0, |id| id.saturating_add(1));
        set.blobs = sorted;
        Ok(set)
    }

    /// Blobs in start order.
    pub fn blobs(&self) -> &[Blob] {
        &self.blobs
    }

    /// Number of blobs.
    pub fn len(&self) -> usize {
        self.blobs.len()
    }

    /// True when the set holds no blob.
    pub fn is_empty(&self) -> bool {
        self.blobs.is_empty()
    }

    /// Blob with `id`.
    pub fn get(&self, id: BlobId) -> Option<&Blob> {
        self.blobs.iter().find(|b| b.id == id)
    }

    /// Mutable blob with `id`.
    pub fn get_mut(&mut self, id: BlobId) -> Option<&mut Blob> {
        self.blobs.iter_mut().find(|b| b.id == id)
    }

    /// Position of `id` in start order.
    pub fn index_of(&self, id: BlobId) -> Option<usize> {
        self.blobs.iter().position(|b| b.id == id)
    }

    /// Blob whose detected span contains `time`.
    pub fn at_time(&self, time: f64) -> Option<&Blob> {
        self.blobs.iter().find(|b| b.contains(time))
    }

    /// Replaces every blob overlapping a source span with the analysed blobs from `original`.
    ///
    /// Blobs are matched on the span they were analysed from rather than on where editing has
    /// since moved them, so material dragged out of the span is still restored with it. A blob
    /// the span only partly covers is restored whole, because a segmentation cannot be half
    /// undone: the span decides which blobs are reset, not how much of each one.
    pub fn restore_range(&mut self, original: &BlobSet, start: f64, end: f64) -> Result<()> {
        if !start.is_finite() || !end.is_finite() || end <= start {
            return Err(AxysError::Invalid(format!(
                "reset range {start}..{end} is not a positive span"
            )));
        }
        self.blobs
            .retain(|blob| !spans_overlap(blob.start, blob.end, start, end));
        for blob in original.blobs() {
            if spans_overlap(blob.start, blob.end, start, end) {
                self.blobs.push(blob.clone());
            }
        }
        self.blobs.sort_by(|a, b| a.start.total_cmp(&b.start));
        for blob in &self.blobs {
            self.next_id = self.next_id.max(blob.id.0.saturating_add(1));
        }
        Ok(())
    }

    /// Adds a blob, keeping start order; errors when it overlaps an existing blob.
    ///
    /// A clashing id is replaced with a fresh one, and the id actually stored is returned.
    pub fn insert(&mut self, mut blob: Blob) -> Result<BlobId> {
        if self.blobs.len() >= limits::MAX_BLOBS {
            return Err(AxysError::Invalid(format!(
                "blob limit {} reached",
                limits::MAX_BLOBS
            )));
        }
        validate_blob(&blob)?;
        if let Some(other) = self
            .blobs
            .iter()
            .find(|b| blob.start < b.end - EPS && b.start < blob.end - EPS)
        {
            return Err(AxysError::Invalid(format!(
                "blob overlaps existing blob {:?}",
                other.id
            )));
        }
        if self.blobs.iter().any(|b| b.id == blob.id) {
            blob.id = self.next_id();
        } else {
            self.next_id = self.next_id.max(blob.id.0.saturating_add(1));
        }
        let id = blob.id;
        let at = self.blobs.partition_point(|b| b.start <= blob.start);
        self.blobs.insert(at, blob);
        Ok(id)
    }

    /// Removes and returns the blob with `id`.
    pub fn remove(&mut self, id: BlobId) -> Result<Blob> {
        let index = self
            .index_of(id)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))?;
        Ok(self.blobs.remove(index))
    }

    /// Allocates an unused id.
    pub fn next_id(&mut self) -> BlobId {
        let mut candidate = self.next_id;
        while self.blobs.iter().any(|b| b.id.0 == candidate) {
            candidate = candidate.saturating_add(1);
        }
        self.next_id = candidate.saturating_add(1);
        BlobId(candidate)
    }

    /// Splits `id` at `time`, returning the two resulting ids in time order.
    ///
    /// Both halves keep the original edits: subregions are cut at `time`, the curve is
    /// distributed by anchor time with a boundary anchor added where it crossed the cut,
    /// and each half re-derives its detected centre from `track` when one is given.
    pub fn split(
        &mut self,
        id: BlobId,
        time: f64,
        track: Option<&PitchTrack>,
    ) -> Result<(BlobId, BlobId)> {
        if !time.is_finite() {
            return Err(AxysError::Invalid("split time is not finite".into()));
        }
        if self.blobs.len() >= limits::MAX_BLOBS {
            return Err(AxysError::Invalid(format!(
                "blob limit {} reached",
                limits::MAX_BLOBS
            )));
        }
        let index = self
            .index_of(id)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))?;
        let original = self.blobs[index].clone();
        if time < original.start + MIN_BLOB_SECONDS || time > original.end - MIN_BLOB_SECONDS {
            return Err(AxysError::Invalid(format!(
                "split at {time} leaves a side under {MIN_BLOB_SECONDS} s"
            )));
        }
        let right_id = self.next_id();

        let mut left = original.clone();
        left.end = time;
        left.subregions = clip_subregions(&original.subregions, original.start, time);
        left.curve = slice_curve(&original.curve, f64::NEG_INFINITY, time)?;

        let mut right = original.clone();
        right.id = right_id;
        right.start = time;
        right.subregions = clip_subregions(&original.subregions, time, original.end);
        right.curve = slice_curve(&original.curve, time, f64::INFINITY)?;
        // The second half starts where the first ended, so its offset keeps it in place.

        left.rederive_center(track);
        right.rederive_center(track);

        self.blobs[index] = left;
        self.blobs.insert(index + 1, right);
        Ok((id, right_id))
    }

    /// Joins two adjacent blobs into the earlier id.
    ///
    /// Errors when the blobs are not neighbours in the set. The gap between them, if any,
    /// becomes part of the joined blob as a `Silence` subregion. The joined blob keeps the
    /// earlier blob's offsets and flags, and both curves survive.
    pub fn join(
        &mut self,
        first: BlobId,
        second: BlobId,
        track: Option<&PitchTrack>,
    ) -> Result<BlobId> {
        if first == second {
            return Err(AxysError::Invalid("cannot join a blob with itself".into()));
        }
        let a = self
            .index_of(first)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", first.0)))?;
        let b = self
            .index_of(second)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", second.0)))?;
        let (lo, hi) = if a < b { (a, b) } else { (b, a) };
        if hi != lo + 1 {
            return Err(AxysError::Invalid(format!(
                "blobs {} and {} are not neighbours",
                first.0, second.0
            )));
        }

        let later = self.blobs.remove(hi);
        let earlier = &mut self.blobs[lo];
        let gap_start = earlier.end;
        let gap_end = later.start;

        let mut subregions = earlier.subregions.clone();
        if gap_end - gap_start > EPS {
            subregions.push(Subregion::new(gap_start, gap_end, Voicing::Silence));
        }
        subregions.extend(later.subregions.iter().copied());

        let mut anchors: Vec<Anchor> = earlier.curve.anchors().to_vec();
        anchors.extend(later.curve.anchors().iter().copied());
        earlier.curve = PitchCurve::from_anchors(anchors)?;

        earlier.end = later.end.max(earlier.end);
        earlier.subregions = merge_subregions(subregions);
        if track.is_some() {
            earlier.rederive_center(track);
        } else {
            let wa = (gap_start - earlier.start).max(0.0);
            let wb = later.duration();
            let total = wa + wb;
            if total > 0.0 {
                earlier.detected_center =
                    (earlier.detected_center * wa + later.detected_center * wb) / total;
            }
        }
        Ok(earlier.id)
    }

    /// Moves a boundary, clamped so neither side collapses below `MIN_BLOB_SECONDS`
    /// and so the blob never crosses its neighbours.
    ///
    /// Subregions are trimmed or extended to the new span and the curve keeps a boundary
    /// anchor wherever it was cut, so the target does not jump.
    pub fn move_boundary(&mut self, id: BlobId, edge: Edge, time: f64) -> Result<()> {
        if !time.is_finite() {
            return Err(AxysError::Invalid("boundary time is not finite".into()));
        }
        let index = self
            .index_of(id)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))?;
        let prev_end = if index > 0 {
            Some(self.blobs[index - 1].end)
        } else {
            None
        };
        let next_start = self.blobs.get(index + 1).map(|b| b.start);
        let blob = &mut self.blobs[index];

        match edge {
            Edge::Start => {
                let upper = blob.end - MIN_BLOB_SECONDS;
                let lower = prev_end.unwrap_or(f64::NEG_INFINITY);
                let target = if lower > upper {
                    upper
                } else {
                    time.clamp(lower, upper)
                };
                blob.start = target;
            }
            Edge::End => {
                let lower = blob.start + MIN_BLOB_SECONDS;
                let upper = next_start.unwrap_or(f64::INFINITY);
                let target = if upper < lower {
                    lower
                } else {
                    time.clamp(lower, upper)
                };
                blob.end = target;
            }
        }

        let (start, end) = (blob.start, blob.end);
        blob.subregions = fit_subregions(&blob.subregions, start, end);
        blob.curve = slice_curve(&blob.curve, start, end)?;
        Ok(())
    }

    /// Reclassifies `[start, end]` inside `id`, merging touching subregions of equal voicing.
    ///
    /// The span is clamped to the blob.
    pub fn set_voicing(
        &mut self,
        id: BlobId,
        start: f64,
        end: f64,
        voicing: Voicing,
    ) -> Result<()> {
        if !start.is_finite() || !end.is_finite() {
            return Err(AxysError::Invalid("voicing span is not finite".into()));
        }
        let blob = self
            .get_mut(id)
            .ok_or_else(|| AxysError::NotFound(format!("blob {}", id.0)))?;
        let lo = start.max(blob.start);
        let hi = end.min(blob.end);
        if hi - lo <= EPS {
            return Err(AxysError::Invalid(
                "voicing span is empty inside the blob".into(),
            ));
        }
        let mut regions = Vec::with_capacity(blob.subregions.len() + 2);
        for region in &blob.subregions {
            if region.start < lo {
                regions.push(Subregion::new(
                    region.start,
                    region.end.min(lo),
                    region.voicing,
                ));
            }
            if region.end > hi {
                regions.push(Subregion::new(
                    region.start.max(hi),
                    region.end,
                    region.voicing,
                ));
            }
        }
        regions.push(Subregion::new(lo, hi, voicing));
        regions.retain(|r| r.duration() > EPS);
        blob.subregions = merge_subregions(regions);
        Ok(())
    }

    /// Overlaps and gaps produced by timing edits, for display before export.
    ///
    /// Every overlap of edited spans is reported. A gap is reported only when timing edits
    /// widened it beyond the hole the detected segmentation already had.
    pub fn timing_conflicts(&self) -> Vec<TimingConflict> {
        let mut order: Vec<&Blob> = self.blobs.iter().collect();
        order.sort_by(|a, b| a.edited_start().total_cmp(&b.edited_start()));
        let mut out = Vec::new();
        for pair in order.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let a_end = a.edited_end();
            let b_start = b.edited_start();
            if b_start < a_end - EPS {
                out.push(TimingConflict {
                    first: a.id,
                    second: b.id,
                    start: b_start,
                    end: a_end,
                    kind: ConflictKind::Overlap,
                });
            } else {
                let edited_gap = b_start - a_end;
                let detected_gap = (b.start - a.end).max(0.0);
                if edited_gap > detected_gap + EPS {
                    out.push(TimingConflict {
                        first: a.id,
                        second: b.id,
                        start: a_end,
                        end: b_start,
                        kind: ConflictKind::Gap,
                    });
                }
            }
        }
        out
    }
}

/// Rejects a blob whose geometry cannot be placed in a set.
fn validate_blob(blob: &Blob) -> Result<()> {
    if !blob.start.is_finite() || !blob.end.is_finite() {
        return Err(AxysError::Invalid("blob bounds are not finite".into()));
    }
    if !blob.time_offset.is_finite() || !blob.time_scale.is_finite() || blob.time_scale <= 0.0 {
        return Err(AxysError::Invalid("blob timing edit is not usable".into()));
    }
    if !blob.pitch_offset.is_finite() || !blob.detected_center.is_finite() {
        return Err(AxysError::Invalid("blob pitch is not finite".into()));
    }
    if blob.end - blob.start < MIN_BLOB_SECONDS {
        return Err(AxysError::Invalid(format!(
            "blob is shorter than {MIN_BLOB_SECONDS} s"
        )));
    }
    Ok(())
}

/// Keeps the part of each subregion inside `[start, end]`, dropping empty results.
fn clip_subregions(regions: &[Subregion], start: f64, end: f64) -> Vec<Subregion> {
    let mut out: Vec<Subregion> = regions
        .iter()
        .map(|r| Subregion::new(r.start.max(start), r.end.min(end), r.voicing))
        .filter(|r| r.duration() > EPS)
        .collect();
    out.sort_by(|a, b| a.start.total_cmp(&b.start));
    merge_subregions(out)
}

/// Clips subregions to `[start, end]` and stretches the outermost ones to cover it.
fn fit_subregions(regions: &[Subregion], start: f64, end: f64) -> Vec<Subregion> {
    let mut out = clip_subregions(regions, start, end);
    match out.first_mut() {
        Some(first) => first.start = start,
        None => return vec![Subregion::new(start, end, Voicing::Voiced)],
    }
    if let Some(last) = out.last_mut() {
        last.end = end;
    }
    out
}

/// Joins touching subregions that share a voicing, keeping time order.
fn merge_subregions(mut regions: Vec<Subregion>) -> Vec<Subregion> {
    regions.retain(|r| r.duration() > EPS);
    regions.sort_by(|a, b| a.start.total_cmp(&b.start));
    let mut out: Vec<Subregion> = Vec::with_capacity(regions.len());
    for region in regions {
        match out.last_mut() {
            Some(prev) if prev.voicing == region.voicing && region.start <= prev.end + EPS => {
                prev.end = prev.end.max(region.end);
            }
            _ => out.push(region),
        }
    }
    out
}

/// Takes the part of `curve` inside `[start, end]`, adding boundary anchors where it was cut.
///
/// A cut through a segment keeps the evaluated value at the cut, so neither side of a split
/// or a moved boundary hears the target jump.
fn slice_curve(curve: &PitchCurve, start: f64, end: f64) -> Result<PitchCurve> {
    if curve.is_empty() {
        return Ok(PitchCurve::new());
    }
    let anchors = curve.anchors();
    let mut kept: Vec<Anchor> = anchors
        .iter()
        .copied()
        .filter(|a| a.time >= start && a.time <= end)
        .collect();
    let first = anchors[0].time;
    let last = anchors[anchors.len() - 1].time;
    if start.is_finite()
        && start > first
        && start < last
        && kept.first().map(|a| a.time) != Some(start)
    {
        if let Some(midi) = curve.eval(start) {
            kept.insert(0, Anchor::new(start, midi));
        }
    }
    if end.is_finite() && end < last && end > first && kept.last().map(|a| a.time) != Some(end) {
        if let Some(midi) = curve.eval(end) {
            let interp = anchors
                .iter()
                .rev()
                .find(|a| a.time <= end)
                .map(|a| a.interp)
                .unwrap_or_default();
            kept.push(Anchor::with_interp(end, midi, interp));
        }
    }
    PitchCurve::from_anchors(kept)
}

/// Whether two half-open spans share any time.
fn spans_overlap(a_start: f64, a_end: f64, b_start: f64, b_end: f64) -> bool {
    a_end > b_start && a_start < b_end
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::analysis::f0::PitchFrame;
    use crate::curve::Interp;

    fn blob(id: u32, start: f64, end: f64, center: f64) -> Blob {
        Blob::new(BlobId(id), start, end, center)
    }

    fn set_of(spans: &[(f64, f64, f64)]) -> BlobSet {
        let blobs = spans
            .iter()
            .enumerate()
            .map(|(i, &(s, e, c))| blob(i as u32, s, e, c))
            .collect();
        BlobSet::from_blobs(blobs).expect("valid set")
    }

    fn track_of(points: &[(f64, f64)]) -> PitchTrack {
        PitchTrack {
            sample_rate: 48_000.0,
            hop_seconds: 0.005,
            frames: points
                .iter()
                .map(|&(time, midi)| PitchFrame {
                    time,
                    f0: 440.0,
                    midi,
                    confidence: 0.9,
                    rms: 0.2,
                    voiced: true,
                })
                .collect(),
        }
    }

    #[test]
    fn blob_geometry_follows_timing_edits() {
        let mut b = blob(0, 1.0, 2.0, 60.0);
        assert_eq!(b.duration(), 1.0);
        assert_eq!(b.edited_start(), 1.0);
        assert_eq!(b.edited_end(), 2.0);
        b.time_offset = 0.5;
        b.time_scale = 2.0;
        assert_eq!(b.edited_start(), 1.5);
        assert_eq!(b.edited_end(), 3.5);
        assert!(b.contains(1.5));
        assert!(!b.contains(2.0));
        b.pitch_offset = -3.0;
        assert_eq!(b.target_center(), 57.0);
    }

    #[test]
    fn voicing_at_reads_subregions() {
        let mut b = blob(0, 0.0, 1.0, 60.0);
        b.subregions = vec![
            Subregion::new(0.0, 0.2, Voicing::Unvoiced),
            Subregion::new(0.2, 1.0, Voicing::Voiced),
        ];
        assert_eq!(b.voicing_at(0.1), Voicing::Unvoiced);
        assert_eq!(b.voicing_at(0.5), Voicing::Voiced);
        assert_eq!(b.voicing_at(1.0), Voicing::Voiced);
        assert_eq!(b.voicing_at(5.0), Voicing::Silence);
    }

    #[test]
    fn from_blobs_sorts_and_rejects_overlap() {
        let set = BlobSet::from_blobs(vec![blob(1, 2.0, 3.0, 60.0), blob(0, 0.0, 1.0, 62.0)])
            .expect("valid");
        assert_eq!(set.blobs()[0].id, BlobId(0));
        assert_eq!(set.len(), 2);
        assert!(
            BlobSet::from_blobs(vec![blob(0, 0.0, 1.0, 60.0), blob(1, 0.5, 1.5, 60.0)]).is_err()
        );
        assert!(
            BlobSet::from_blobs(vec![blob(0, 0.0, 1.0, 60.0), blob(0, 2.0, 3.0, 60.0)]).is_err()
        );
        assert!(BlobSet::from_blobs(vec![blob(0, 0.0, 0.001, 60.0)]).is_err());
        assert!(BlobSet::from_blobs(vec![blob(0, 0.0, f64::NAN, 60.0)]).is_err());
    }

    #[test]
    fn insert_rejects_overlaps_and_keeps_order() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (2.0, 3.0, 62.0)]);
        assert!(set.insert(blob(9, 0.5, 1.5, 61.0)).is_err());
        assert!(set.insert(blob(9, 2.9, 4.0, 61.0)).is_err());
        let id = set.insert(blob(9, 1.0, 2.0, 61.0)).expect("fits the hole");
        assert_eq!(id, BlobId(9));
        assert_eq!(
            set.blobs().iter().map(|b| b.id.0).collect::<Vec<_>>(),
            vec![0, 9, 1]
        );
        let reused = set.insert(blob(9, 5.0, 6.0, 61.0)).expect("id reassigned");
        assert_ne!(reused, BlobId(9));
        assert_eq!(set.len(), 4);
    }

    #[test]
    fn lookup_remove_and_next_id() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 62.0)]);
        assert_eq!(set.at_time(1.5).map(|b| b.id), Some(BlobId(1)));
        assert!(set.at_time(9.0).is_none());
        assert_eq!(set.index_of(BlobId(1)), Some(1));
        set.get_mut(BlobId(0)).expect("present").pitch_offset = 2.0;
        assert_eq!(set.get(BlobId(0)).expect("present").target_center(), 62.0);
        let fresh = set.next_id();
        assert!(set.get(fresh).is_none());
        let removed = set.remove(BlobId(0)).expect("removed");
        assert_eq!(removed.id, BlobId(0));
        assert!(set.remove(BlobId(0)).is_err());
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn split_distributes_curve_and_cuts_subregions() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        {
            let b = set.get_mut(BlobId(0)).expect("present");
            b.subregions = vec![
                Subregion::new(0.0, 0.2, Voicing::Unvoiced),
                Subregion::new(0.2, 1.0, Voicing::Voiced),
            ];
            b.curve = PitchCurve::from_anchors(vec![
                Anchor::with_interp(0.1, 60.0, Interp::Linear),
                Anchor::with_interp(0.9, 64.0, Interp::Linear),
            ])
            .expect("curve");
            b.pitch_offset = 1.5;
        }
        let (left, right) = set.split(BlobId(0), 0.5, None).expect("split");
        assert_eq!(left, BlobId(0));
        assert_ne!(right, left);
        assert_eq!(set.len(), 2);

        let l = set.get(left).expect("left");
        let r = set.get(right).expect("right");
        assert_eq!(l.end, 0.5);
        assert_eq!(r.start, 0.5);
        assert_eq!(l.pitch_offset, 1.5);
        assert_eq!(r.pitch_offset, 1.5);
        assert_eq!(l.subregions.len(), 2);
        assert_eq!(l.subregions[1].end, 0.5);
        assert_eq!(
            r.subregions,
            vec![Subregion::new(0.5, 1.0, Voicing::Voiced)]
        );

        // The cut value is shared, so the target is continuous across the new boundary.
        let left_end = l.curve.eval(0.5).expect("left value");
        let right_start = r.curve.eval(0.5).expect("right value");
        assert!((left_end - right_start).abs() < 1e-9);
        assert!((left_end - 62.0).abs() < 1e-9);
        assert_eq!(l.curve.anchors().len(), 2);
        assert_eq!(r.curve.anchors().len(), 2);
    }

    #[test]
    fn split_rederives_centres_from_the_track() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        let track = track_of(&[(0.1, 60.0), (0.2, 60.0), (0.7, 67.0), (0.8, 67.0)]);
        let (left, right) = set.split(BlobId(0), 0.5, Some(&track)).expect("split");
        assert_eq!(set.get(left).expect("left").detected_center, 60.0);
        assert_eq!(set.get(right).expect("right").detected_center, 67.0);
    }

    #[test]
    fn split_rejects_bad_times() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        assert!(set.split(BlobId(0), 0.001, None).is_err());
        assert!(set.split(BlobId(0), 0.999, None).is_err());
        assert!(set.split(BlobId(0), f64::NAN, None).is_err());
        assert!(set.split(BlobId(7), 0.5, None).is_err());
        assert_eq!(set.len(), 1);
    }

    #[test]
    fn join_fills_the_gap_with_silence_and_merges_curves() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.2, 2.0, 64.0)]);
        set.get_mut(BlobId(0)).expect("present").curve =
            PitchCurve::from_anchors(vec![Anchor::new(0.5, 60.0)]).expect("curve");
        set.get_mut(BlobId(1)).expect("present").curve =
            PitchCurve::from_anchors(vec![Anchor::new(1.5, 64.0)]).expect("curve");

        let id = set.join(BlobId(0), BlobId(1), None).expect("join");
        assert_eq!(id, BlobId(0));
        assert_eq!(set.len(), 1);
        let joined = set.get(id).expect("joined");
        assert_eq!(joined.start, 0.0);
        assert_eq!(joined.end, 2.0);
        assert_eq!(
            joined.subregions,
            vec![
                Subregion::new(0.0, 1.0, Voicing::Voiced),
                Subregion::new(1.0, 1.2, Voicing::Silence),
                Subregion::new(1.2, 2.0, Voicing::Voiced),
            ]
        );
        assert_eq!(joined.curve.anchors().len(), 2);
        assert!((joined.curve.eval(0.5).expect("value") - 60.0).abs() < 1e-9);
        assert!((joined.curve.eval(1.5).expect("value") - 64.0).abs() < 1e-9);
        // Duration-weighted centre of a 1.0 s blob at 60 and a 0.8 s blob at 64.
        assert!((joined.detected_center - (60.0 + 64.0 * 0.8) / 1.8).abs() < 1e-9);
    }

    #[test]
    fn join_of_touching_blobs_merges_voicing_and_rederives() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 60.0)]);
        let track = track_of(&[(0.5, 62.0), (1.5, 62.0)]);
        let id = set.join(BlobId(1), BlobId(0), Some(&track)).expect("join");
        assert_eq!(id, BlobId(0));
        let joined = set.get(id).expect("joined");
        assert_eq!(
            joined.subregions,
            vec![Subregion::new(0.0, 2.0, Voicing::Voiced)]
        );
        assert_eq!(joined.detected_center, 62.0);
    }

    #[test]
    fn join_rejects_non_neighbours() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 61.0), (2.0, 3.0, 62.0)]);
        assert!(set.join(BlobId(0), BlobId(2), None).is_err());
        assert!(set.join(BlobId(0), BlobId(0), None).is_err());
        assert!(set.join(BlobId(0), BlobId(9), None).is_err());
        assert_eq!(set.len(), 3);
    }

    #[test]
    fn move_boundary_clamps_against_neighbours_and_minimum() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.5, 3.0, 62.0)]);

        set.move_boundary(BlobId(1), Edge::Start, 0.5)
            .expect("clamped");
        assert_eq!(set.get(BlobId(1)).expect("present").start, 1.0);

        set.move_boundary(BlobId(1), Edge::Start, 5.0)
            .expect("clamped");
        let second_start = set.get(BlobId(1)).expect("present").start;
        assert!((second_start - (3.0 - MIN_BLOB_SECONDS)).abs() < 1e-12);

        set.move_boundary(BlobId(0), Edge::End, 9.0)
            .expect("clamped");
        assert_eq!(set.get(BlobId(0)).expect("present").end, second_start);

        set.move_boundary(BlobId(0), Edge::End, -1.0)
            .expect("clamped");
        assert!((set.get(BlobId(0)).expect("present").end - MIN_BLOB_SECONDS).abs() < 1e-12);

        assert!(set.move_boundary(BlobId(0), Edge::End, f64::NAN).is_err());
        assert!(set.move_boundary(BlobId(7), Edge::End, 0.5).is_err());
    }

    #[test]
    fn move_boundary_refits_subregions_and_curve() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        {
            let b = set.get_mut(BlobId(0)).expect("present");
            b.subregions = vec![
                Subregion::new(0.0, 0.3, Voicing::Unvoiced),
                Subregion::new(0.3, 1.0, Voicing::Voiced),
            ];
            b.curve = PitchCurve::from_anchors(vec![
                Anchor::with_interp(0.0, 60.0, Interp::Linear),
                Anchor::with_interp(1.0, 70.0, Interp::Linear),
            ])
            .expect("curve");
        }
        set.move_boundary(BlobId(0), Edge::End, 0.5).expect("moved");
        let b = set.get(BlobId(0)).expect("present");
        assert_eq!(
            b.subregions,
            vec![
                Subregion::new(0.0, 0.3, Voicing::Unvoiced),
                Subregion::new(0.3, 0.5, Voicing::Voiced),
            ]
        );
        assert!((b.curve.eval(0.5).expect("value") - 65.0).abs() < 1e-9);
        assert_eq!(b.curve.end(), Some(0.5));

        set.move_boundary(BlobId(0), Edge::Start, 0.4)
            .expect("moved");
        let b = set.get(BlobId(0)).expect("present");
        assert_eq!(b.subregions.len(), 1);
        assert_eq!(b.subregions[0].start, 0.4);
        assert_eq!(b.subregions[0].end, 0.5);
        assert_eq!(b.subregions[0].voicing, Voicing::Voiced);
    }

    #[test]
    fn set_voicing_replaces_a_span_and_merges_equal_neighbours() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        set.set_voicing(BlobId(0), 0.2, 0.4, Voicing::Unvoiced)
            .expect("set");
        assert_eq!(
            set.get(BlobId(0)).expect("present").subregions,
            vec![
                Subregion::new(0.0, 0.2, Voicing::Voiced),
                Subregion::new(0.2, 0.4, Voicing::Unvoiced),
                Subregion::new(0.4, 1.0, Voicing::Voiced),
            ]
        );

        // A touching span of the same voicing collapses into one region.
        set.set_voicing(BlobId(0), 0.4, 0.6, Voicing::Unvoiced)
            .expect("set");
        assert_eq!(
            set.get(BlobId(0)).expect("present").subregions,
            vec![
                Subregion::new(0.0, 0.2, Voicing::Voiced),
                Subregion::new(0.2, 0.6, Voicing::Unvoiced),
                Subregion::new(0.6, 1.0, Voicing::Voiced),
            ]
        );

        // Covering everything leaves a single region.
        set.set_voicing(BlobId(0), -5.0, 5.0, Voicing::Silence)
            .expect("clamped");
        assert_eq!(
            set.get(BlobId(0)).expect("present").subregions,
            vec![Subregion::new(0.0, 1.0, Voicing::Silence)]
        );

        assert!(set
            .set_voicing(BlobId(0), 2.0, 3.0, Voicing::Voiced)
            .is_err());
        assert!(set
            .set_voicing(BlobId(0), 0.0, f64::INFINITY, Voicing::Voiced)
            .is_err());
        assert!(set
            .set_voicing(BlobId(7), 0.0, 0.5, Voicing::Voiced)
            .is_err());
    }

    #[test]
    fn timing_conflicts_reports_overlaps_and_new_gaps() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 62.0), (2.0, 3.0, 64.0)]);
        assert!(set.timing_conflicts().is_empty());

        set.get_mut(BlobId(1)).expect("present").time_offset = -0.25;
        set.get_mut(BlobId(2)).expect("present").time_offset = 0.4;
        let conflicts = set.timing_conflicts();
        assert_eq!(conflicts.len(), 2);

        let overlap = conflicts[0];
        assert_eq!(overlap.kind, ConflictKind::Overlap);
        assert_eq!((overlap.first, overlap.second), (BlobId(0), BlobId(1)));
        assert!((overlap.start - 0.75).abs() < 1e-12);
        assert!((overlap.end - 1.0).abs() < 1e-12);

        let gap = conflicts[1];
        assert_eq!(gap.kind, ConflictKind::Gap);
        assert_eq!((gap.first, gap.second), (BlobId(1), BlobId(2)));
        assert!((gap.start - 1.75).abs() < 1e-12);
        assert!((gap.end - 2.4).abs() < 1e-12);
    }

    #[test]
    fn timing_conflicts_ignores_a_gap_the_analysis_already_had() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.5, 2.0, 62.0)]);
        assert!(set.timing_conflicts().is_empty());
        set.get_mut(BlobId(1)).expect("present").time_offset = -0.2;
        assert!(set.timing_conflicts().is_empty());
        set.get_mut(BlobId(0)).expect("present").time_scale = 0.5;
        let conflicts = set.timing_conflicts();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].kind, ConflictKind::Gap);
    }

    #[test]
    fn timing_conflicts_sees_a_stretched_blob_run_into_the_next() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 62.0)]);
        set.get_mut(BlobId(0)).expect("present").time_scale = 1.5;
        let conflicts = set.timing_conflicts();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].kind, ConflictKind::Overlap);
        assert!((conflicts[0].end - 1.5).abs() < 1e-12);
    }

    #[test]
    fn split_then_join_restores_one_blob_with_its_edits() {
        let mut set = set_of(&[(0.0, 1.0, 60.0)]);
        set.get_mut(BlobId(0)).expect("present").curve =
            PitchCurve::from_anchors(vec![Anchor::new(0.25, 61.0), Anchor::new(0.75, 63.0)])
                .expect("curve");
        let (left, right) = set.split(BlobId(0), 0.5, None).expect("split");
        let id = set.join(left, right, None).expect("join");
        let joined = set.get(id).expect("joined");
        assert_eq!(set.len(), 1);
        assert_eq!(joined.start, 0.0);
        assert_eq!(joined.end, 1.0);
        assert_eq!(
            joined.subregions,
            vec![Subregion::new(0.0, 1.0, Voicing::Voiced)]
        );
        assert!((joined.curve.eval(0.25).expect("value") - 61.0).abs() < 1e-9);
        assert!((joined.curve.eval(0.75).expect("value") - 63.0).abs() < 1e-9);
    }

    #[test]
    fn serde_round_trips_a_set() {
        let mut set = set_of(&[(0.0, 1.0, 60.0), (1.0, 2.0, 62.0)]);
        set.get_mut(BlobId(1)).expect("present").subregions =
            vec![Subregion::new(1.0, 2.0, Voicing::Unvoiced)];
        let json = serde_json::to_string(&set).expect("encode");
        assert!(json.contains("\"unvoiced\""));
        assert!(json.contains("nextId"));
        let back: BlobSet = serde_json::from_str(&json).expect("decode");
        assert_eq!(back, set);
    }
}
