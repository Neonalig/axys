// SPDX-License-Identifier: AGPL-3.0-or-later

//! Sources placed on the project timeline: vocal clips and reference tracks.
//!
//! A clip is one imported vocal with its own analysis and its own blobs, placed at a position on
//! the timeline. Clips may overlap, a lead under its harmonies say, and each keeps its own blobs.
//! Everything inside a clip stays in that clip's source seconds, so its analysis, blobs and
//! render plan never change meaning when it moves; only the position does. Project seconds are
//! clip seconds plus the clip's position.
//!
//! The editor edits one [`layer`] at a time: the active clip and every clip that can sit beside
//! it without overlapping, so the blobs it reads are still one ordered set.
//!
//! Blob ids are partitioned by clip, [`CLIP_ID_BITS`] low bits per clip, so a blob id alone says
//! which clip owns it and an edit operation addressing a blob needs no clip field.
//!
//! A reference is audio heard beside the vocal and never edited. It is already in output time, so
//! it carries a position and nothing else of the edit model.

use serde::{Deserialize, Serialize};

use crate::blob::{Blob, BlobId, BlobSet, Edge};
use crate::project::SourceInfo;
use crate::{AxysError, Result};

/// Low bits of a blob id that number blobs within their clip.
pub const CLIP_ID_BITS: u32 = 20;

/// Most clips one project may hold.
pub const MAX_CLIPS: usize = 64;

/// Most references one project may hold.
pub const MAX_REFERENCES: usize = 32;

/// Stable identifier for a clip within one project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ClipId(pub u32);

impl ClipId {
    /// First blob id this clip's blobs are numbered from.
    pub fn first_blob(self) -> BlobId {
        BlobId(self.0 << CLIP_ID_BITS)
    }
}

/// The clip a blob belongs to.
pub fn clip_of(blob: BlobId) -> ClipId {
    ClipId(blob.0 >> CLIP_ID_BITS)
}

/// Stable identifier for a reference within one project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ReferenceId(pub u32);

/// A span of source seconds.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Span {
    /// Start in source seconds.
    pub start: f64,
    /// End in source seconds, never before `start`.
    pub end: f64,
}

/// One imported vocal placed on the project timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Clip {
    /// Identity within the project.
    pub id: ClipId,
    /// Facts about the audio the clip was imported from.
    pub source: SourceInfo,
    /// Project seconds at which the clip's source second 0 sits. Never negative.
    pub position: f64,
    /// Editable regions of the clip, in clip source seconds.
    #[serde(default)]
    pub blobs: BlobSet,
    /// Material deleted with its blobs, in clip source seconds, rendered as silence.
    ///
    /// Ordered and never overlapping.
    #[serde(default)]
    pub silenced: Vec<Span>,
    /// What the clip is called on the desk and over its blobs, in place of its file's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl Clip {
    /// A clip over a source at a position, with the given blobs and nothing silenced.
    pub fn new(id: ClipId, source: SourceInfo, position: f64, blobs: BlobSet) -> Self {
        Self {
            id,
            source,
            position,
            blobs,
            silenced: Vec::new(),
            name: None,
        }
    }

    /// Project seconds at which the clip's source ends.
    pub fn end(&self) -> f64 {
        self.position + self.source.duration
    }

    /// The clip's blobs moved into project seconds.
    pub fn project_blobs(&self) -> Vec<Blob> {
        self.blobs
            .blobs()
            .iter()
            .map(|blob| blob.shifted(self.position))
            .collect()
    }

    /// Adds a span to the silenced material, merging it with any it touches.
    pub fn silence(&mut self, span: Span) {
        if span.end <= span.start || span.end.is_nan() || span.start.is_nan() {
            return;
        }
        let mut merged = span;
        let mut kept = Vec::with_capacity(self.silenced.len() + 1);
        for existing in self.silenced.drain(..) {
            if existing.end < merged.start || existing.start > merged.end {
                kept.push(existing);
            } else {
                merged.start = merged.start.min(existing.start);
                merged.end = merged.end.max(existing.end);
            }
        }
        kept.push(merged);
        kept.sort_by(|a, b| a.start.total_cmp(&b.start));
        self.silenced = kept;
    }

    /// Restores the silenced material inside `[start, end]`, trimming spans that cross it.
    pub fn unsilence(&mut self, start: f64, end: f64) {
        let mut kept = Vec::with_capacity(self.silenced.len() + 1);
        for span in self.silenced.drain(..) {
            if span.end <= start || span.start >= end {
                kept.push(span);
                continue;
            }
            if span.start < start {
                kept.push(Span {
                    start: span.start,
                    end: start,
                });
            }
            if span.end > end {
                kept.push(Span {
                    start: end,
                    end: span.end,
                });
            }
        }
        self.silenced = kept;
    }
}

/// Renumbers an analysed blob set into a clip's id range, keeping time order.
///
/// Errors when the set has more blobs than one clip can number.
pub fn renumber(blobs: &BlobSet, clip: ClipId) -> Result<BlobSet> {
    let base = clip.first_blob().0;
    let limit = 1u32 << CLIP_ID_BITS;
    if blobs.len() >= limit as usize {
        return Err(AxysError::Invalid(format!(
            "a clip holds at most {limit} blobs"
        )));
    }
    let renumbered = blobs
        .blobs()
        .iter()
        .enumerate()
        .map(|(index, blob)| {
            let mut blob = blob.clone();
            blob.id = BlobId(base + index as u32);
            blob
        })
        .collect();
    BlobSet::from_blobs(renumbered)
}

/// Pulls any blob edge that lies outside `0..duration` back inside it.
///
/// Analysis may place a last edge a hop past the end of the audio. Kept there, it would overlap
/// the first blob of a clip placed right after this one, so every clip's blobs are held inside its
/// own source span.
pub fn fit_to_source(blobs: &mut BlobSet, duration: f64) {
    let spills: Vec<(BlobId, bool, bool)> = blobs
        .blobs()
        .iter()
        .map(|blob| (blob.id, blob.start < 0.0, blob.end > duration))
        .filter(|(_, early, late)| *early || *late)
        .collect();
    for (id, early, late) in spills {
        // A blob lying wholly outside the audio cannot be pulled in, and is left as it was.
        if early {
            let _ = blobs.move_boundary(id, Edge::Start, 0.0);
        }
        if late {
            let _ = blobs.move_boundary(id, Edge::End, duration);
        }
    }
}

/// Whether every blob in a set is numbered inside a clip's id range.
pub fn numbered_for(blobs: &BlobSet, clip: ClipId) -> bool {
    blobs.blobs().iter().all(|blob| clip_of(blob.id) == clip)
}

/// The position nearest `wanted` at which a span of `duration` overlaps no other clip.
///
/// `others` are the `(start, end)` project spans of every other clip. A span that fits where it
/// was asked stays there; otherwise it lands against the nearest neighbour it would have
/// overlapped, before or after it, whichever is the shorter move. Never negative.
pub fn free_position(others: &[(f64, f64)], duration: f64, wanted: f64) -> f64 {
    let wanted = if wanted.is_finite() {
        wanted.max(0.0)
    } else {
        0.0
    };
    let duration = duration.max(0.0);
    let fits = |at: f64| {
        at >= 0.0
            && others
                .iter()
                .all(|(start, end)| at + duration <= *start + 1e-9 || at >= *end - 1e-9)
    };
    if fits(wanted) {
        return wanted;
    }
    let mut candidates: Vec<f64> = Vec::with_capacity(others.len() * 2 + 1);
    candidates.push(0.0);
    for (start, end) in others {
        candidates.push(*end);
        candidates.push(start - duration);
    }
    candidates
        .into_iter()
        .filter(|at| fits(*at))
        .min_by(|a, b| (a - wanted).abs().total_cmp(&(b - wanted).abs()))
        .unwrap_or_else(|| others.iter().map(|(_, end)| *end).fold(0.0, f64::max))
}

/// Where a span of `duration` asked for at `wanted` is inserted, and how far the clips after it
/// move to make room, as `(position, shift)`.
///
/// `others` are the `(start, end)` project spans of the clips on the lane. A position inside a
/// clip moves to that clip's nearer edge. Every clip starting at or after the returned position
/// moves later by `shift`, so the gaps between them are kept; `shift` is `0.0` when the span
/// already fits. The position is never negative.
pub fn ripple_insert(others: &[(f64, f64)], duration: f64, wanted: f64) -> (f64, f64) {
    let mut at = if wanted.is_finite() {
        wanted.max(0.0)
    } else {
        0.0
    };
    if let Some((start, end)) = others
        .iter()
        .find(|(start, end)| at > *start + 1e-9 && at < *end - 1e-9)
    {
        at = if at - start <= end - at { *start } else { *end };
    }
    let next = others
        .iter()
        .map(|(start, _)| *start)
        .filter(|start| *start >= at - 1e-9)
        .fold(f64::INFINITY, f64::min);
    let shift = if next.is_finite() {
        (at + duration.max(0.0) - next).max(0.0)
    } else {
        0.0
    };
    (at, shift)
}

/// The clips the editor edits together: `active` first, then every clip in `clips` order that
/// overlaps none already chosen.
///
/// Clips that only touch do not overlap. With no clip overlapping another the layer is every
/// clip. An `active` clip not in `clips` falls back to the first. With `isolate`, the layer is
/// the active clip alone. Empty when `clips` is.
pub fn layer(clips: &[Clip], active: Option<ClipId>, isolate: bool) -> Vec<ClipId> {
    let Some(first) = active
        .and_then(|id| clips.iter().find(|clip| clip.id == id))
        .or_else(|| clips.first())
    else {
        return Vec::new();
    };
    let mut chosen: Vec<&Clip> = vec![first];
    if !isolate {
        for clip in clips {
            let clear = chosen.iter().all(|other| {
                clip.end() <= other.position + 1e-9 || clip.position >= other.end() - 1e-9
            });
            if clear {
                chosen.push(clip);
            }
        }
    }
    chosen.iter().map(|clip| clip.id).collect()
}

/// Audio heard beside the vocal and never edited or warped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Reference {
    /// Identity within the project.
    pub id: ReferenceId,
    /// Facts about the audio the reference was imported from.
    pub source: SourceInfo,
    /// Project seconds at which the reference starts. Never negative.
    pub position: f64,
    /// What the reference is called on the desk and on its band, in place of its file's name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[cfg(test)]
pub(crate) fn test_source(name: &str, duration: f64) -> SourceInfo {
    SourceInfo {
        name: name.to_string(),
        sample_rate: 48_000,
        channels: 1,
        frames: (duration * 48_000.0) as usize,
        duration,
        fingerprint: "0000000000000000".to_string(),
        mime: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_blob_id_names_its_clip() {
        let clip = ClipId(3);
        assert_eq!(clip_of(clip.first_blob()), clip);
        assert_eq!(clip_of(BlobId(clip.first_blob().0 + 41)), clip);
        assert_eq!(clip_of(BlobId(7)), ClipId(0));
    }

    #[test]
    fn renumbering_moves_blobs_into_the_clip_range_in_order() {
        let set = BlobSet::from_blobs(vec![
            Blob::new(BlobId(9), 1.0, 2.0, 60.0),
            Blob::new(BlobId(4), 0.0, 1.0, 62.0),
        ])
        .expect("set");
        let renumbered = renumber(&set, ClipId(2)).expect("renumbered");
        let ids: Vec<u32> = renumbered.blobs().iter().map(|b| b.id.0).collect();
        let base = ClipId(2).first_blob().0;
        assert_eq!(ids, vec![base, base + 1]);
        assert!(numbered_for(&renumbered, ClipId(2)));
        assert!(!numbered_for(&set, ClipId(2)));
    }

    #[test]
    fn a_rippled_clip_pushes_the_clips_after_it_by_its_overlap() {
        // A 2-second clip at 3.0 before a clip at 4.0 needs one second of room.
        assert_eq!(
            ripple_insert(&[(0.0, 2.0), (4.0, 6.0)], 2.0, 3.0),
            (3.0, 1.0)
        );
        assert_eq!(
            ripple_insert(&[(0.0, 2.0), (8.0, 9.0)], 2.0, 3.0),
            (3.0, 0.0)
        );
        assert_eq!(ripple_insert(&[], 2.0, -1.0), (0.0, 0.0));
    }

    #[test]
    fn a_rippled_clip_asked_for_inside_another_lands_on_its_nearer_edge() {
        // Near the start of 0..4 inserts before it, pushing it; near the end inserts after it.
        assert_eq!(ripple_insert(&[(0.0, 4.0)], 1.0, 1.0), (0.0, 1.0));
        assert_eq!(
            ripple_insert(&[(0.0, 4.0), (5.0, 6.0)], 2.0, 3.0),
            (4.0, 1.0)
        );
    }

    #[test]
    fn a_clip_that_fits_stays_where_it_was_asked() {
        assert_eq!(free_position(&[(0.0, 2.0)], 1.0, 3.0), 3.0);
        assert_eq!(free_position(&[], 1.0, -4.0), 0.0);
    }

    #[test]
    fn an_overlapping_clip_lands_against_the_nearer_neighbour_edge() {
        // Asked for 1.5 over a clip spanning 1..4: after it is 2.5 away, before it 1.5 away.
        assert_eq!(free_position(&[(1.0, 4.0)], 1.0, 1.5), 0.0);
        assert_eq!(free_position(&[(1.0, 4.0)], 1.0, 3.5), 4.0);
    }

    #[test]
    fn a_clip_too_long_for_a_gap_skips_past_it() {
        let others = [(0.0, 2.0), (2.5, 5.0)];
        assert_eq!(free_position(&others, 1.0, 2.1), 5.0);
    }

    #[test]
    fn silencing_merges_touching_spans_and_unsilencing_cuts_them() {
        let mut clip = Clip::new(ClipId(0), test_source("a", 10.0), 0.0, BlobSet::new());
        clip.silence(Span {
            start: 1.0,
            end: 2.0,
        });
        clip.silence(Span {
            start: 3.0,
            end: 4.0,
        });
        clip.silence(Span {
            start: 2.0,
            end: 3.0,
        });
        assert_eq!(
            clip.silenced,
            vec![Span {
                start: 1.0,
                end: 4.0
            }]
        );
        clip.unsilence(2.0, 2.5);
        assert_eq!(
            clip.silenced,
            vec![
                Span {
                    start: 1.0,
                    end: 2.0
                },
                Span {
                    start: 2.5,
                    end: 4.0
                }
            ]
        );
    }

    #[test]
    fn a_blob_past_the_audio_is_pulled_back_inside_it() {
        let mut set = BlobSet::from_blobs(vec![
            Blob::new(BlobId(0), 0.0, 1.0, 60.0),
            Blob::new(BlobId(1), 1.0, 2.04, 62.0),
        ])
        .expect("set");
        fit_to_source(&mut set, 2.0);
        assert_eq!(set.get(BlobId(1)).expect("kept").end, 2.0);
        assert_eq!(set.get(BlobId(0)).expect("kept").end, 1.0);
    }

    fn placed(id: u32, position: f64, duration: f64) -> Clip {
        Clip::new(
            ClipId(id),
            test_source("a", duration),
            position,
            BlobSet::new(),
        )
    }

    #[test]
    fn a_layer_without_overlaps_is_every_clip() {
        let clips = [
            placed(0, 0.0, 2.0),
            placed(1, 2.0, 2.0),
            placed(2, 5.0, 1.0),
        ];
        assert_eq!(
            layer(&clips, None, false),
            vec![ClipId(0), ClipId(1), ClipId(2)]
        );
        assert_eq!(layer(&clips, Some(ClipId(1)), true), vec![ClipId(1)]);
        assert!(layer(&[], None, false).is_empty());
    }

    #[test]
    fn a_layer_leaves_out_what_overlaps_the_active_clip() {
        // 1 overlaps 0; 2 overlaps 1 but not 0; 3 overlaps 2 but not 0.
        let clips = [
            placed(0, 0.0, 4.0),
            placed(1, 3.0, 4.0),
            placed(2, 6.0, 2.0),
            placed(3, 7.0, 2.0),
        ];
        assert_eq!(layer(&clips, None, false), vec![ClipId(0), ClipId(2)]);
        assert_eq!(
            layer(&clips, Some(ClipId(1)), false),
            vec![ClipId(1), ClipId(3)]
        );
        assert_eq!(
            layer(&clips, Some(ClipId(3)), false),
            vec![ClipId(3), ClipId(0)]
        );
        assert_eq!(
            layer(&clips, Some(ClipId(9)), false),
            vec![ClipId(0), ClipId(2)]
        );
    }

    #[test]
    fn project_blobs_are_offset_by_the_position() {
        let set = BlobSet::from_blobs(vec![Blob::new(BlobId(0), 0.5, 1.0, 60.0)]).expect("set");
        let clip = Clip::new(ClipId(0), test_source("a", 2.0), 3.0, set);
        let blobs = clip.project_blobs();
        assert_eq!(blobs[0].start, 3.5);
        assert_eq!(blobs[0].end, 4.0);
        assert_eq!(clip.end(), 5.0);
    }
}
