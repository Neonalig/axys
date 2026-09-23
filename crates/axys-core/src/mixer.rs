// SPDX-License-Identifier: AGPL-3.0-or-later

//! Monitor levels for everything the transport plays.
//!
//! The desk has a track per vocal clip carrying two strips, the take as edited and the take as
//! sung, a strip per reference, and one for the click. Each strip has the controls a desk has:
//! level, pan, mute and solo. The mixer is monitoring rather than an edit to the take, so it never
//! reaches the render plan and an export is unchanged by it. It lives in the project document
//! because how a take is listened to is part of the work, and it is set by an edit operation like
//! anything else, so it undoes.

use serde::{Deserialize, Serialize};

use crate::clip::{ClipId, ReferenceId, MAX_CLIPS, MAX_REFERENCES};
use crate::units::decibels_to_amplitude;
use crate::{limits, AxysError, Result};

/// Level the click is heard at until it is moved, in decibels.
pub const DEFAULT_CLICK_DB: f64 = -11.0;

/// One audio source on the monitor desk.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerStrip {
    /// Level in decibels; 0.0 is unity and [`limits::MIN_GAIN_DB`] is silence.
    pub gain_db: f64,
    /// Position across the stereo field, -1.0 hard left to 1.0 hard right.
    pub pan: f64,
    /// Silences the strip.
    pub mute: bool,
    /// Silences every strip that is not soloed.
    pub solo: bool,
}

impl MixerStrip {
    /// A strip at a level, muted or not, centred and unsoloed.
    pub fn new(gain_db: f64, mute: bool) -> Self {
        Self {
            gain_db,
            pan: 0.0,
            mute,
            solo: false,
        }
    }

    /// Linear amplitude of the strip's level.
    pub fn amplitude(&self) -> f64 {
        decibels_to_amplitude(self.gain_db)
    }

    fn validated(&self) -> Result<Self> {
        if !self.gain_db.is_finite() || !self.pan.is_finite() {
            return Err(AxysError::Invalid("mixer setting is not finite".into()));
        }
        Ok(Self {
            gain_db: self.gain_db.clamp(limits::MIN_GAIN_DB, limits::MAX_GAIN_DB),
            pan: self.pan.clamp(-1.0, 1.0),
            ..*self
        })
    }
}

impl Default for MixerStrip {
    fn default() -> Self {
        Self::new(0.0, false)
    }
}

/// A vocal clip's track on the desk: the take as edited and as sung, side by side.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipStrips {
    /// The clip the track belongs to.
    pub clip: ClipId,
    /// The take as the edits make it sound.
    pub processed: MixerStrip,
    /// The take as it was sung, on the same transport clock.
    pub original: MixerStrip,
}

impl ClipStrips {
    /// The track a clip starts with: the edited take up, the original muted.
    pub fn new(clip: ClipId) -> Self {
        Self {
            clip,
            processed: MixerStrip::default(),
            // The edited take is what the editor is for, so the original starts muted and is
            // brought in to compare against it.
            original: MixerStrip::new(0.0, true),
        }
    }
}

/// A reference's strip on the desk.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceStrip {
    /// The reference the strip belongs to.
    pub reference: ReferenceId,
    /// Its level, pan, mute and solo.
    pub strip: MixerStrip,
}

/// The monitor desk.
///
/// A clip or reference with no entry reads as the strips it starts with, so a source is on the
/// desk from the moment it is imported without an edit to put it there.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSettings {
    /// One track per vocal clip.
    #[serde(default)]
    pub clips: Vec<ClipStrips>,
    /// One strip per reference.
    #[serde(default)]
    pub references: Vec<ReferenceStrip>,
    /// The metronome.
    pub click: MixerStrip,
}

impl Default for MixerSettings {
    fn default() -> Self {
        Self {
            clips: Vec::new(),
            references: Vec::new(),
            click: MixerStrip::new(DEFAULT_CLICK_DB, false),
        }
    }
}

impl MixerSettings {
    /// A clip's track, or the one it starts with when the desk has no entry for it.
    pub fn clip(&self, clip: ClipId) -> ClipStrips {
        self.clips
            .iter()
            .find(|entry| entry.clip == clip)
            .copied()
            .unwrap_or_else(|| ClipStrips::new(clip))
    }

    /// A reference's strip, or the one it starts with when the desk has no entry for it.
    pub fn reference(&self, reference: ReferenceId) -> MixerStrip {
        self.references
            .iter()
            .find(|entry| entry.reference == reference)
            .map_or_else(MixerStrip::default, |entry| entry.strip)
    }

    /// Every strip the desk has an entry for, the click last.
    pub fn strips(&self) -> Vec<&MixerStrip> {
        let mut strips: Vec<&MixerStrip> = Vec::new();
        for entry in &self.clips {
            strips.push(&entry.processed);
            strips.push(&entry.original);
        }
        for entry in &self.references {
            strips.push(&entry.strip);
        }
        strips.push(&self.click);
        strips
    }

    /// Whether any strip is soloed, which is what silences the ones that are not.
    pub fn soloed(&self) -> bool {
        self.strips().iter().any(|strip| strip.solo)
    }

    /// The same settings with every figure brought inside its bounds.
    ///
    /// A level out of range is clamped rather than refused, because a fader is dragged to its
    /// end rather than typed; a figure that is not a number is refused, because it is a bug. A
    /// source listed twice keeps its first entry.
    pub fn validated(&self) -> Result<Self> {
        if self.clips.len() > MAX_CLIPS || self.references.len() > MAX_REFERENCES {
            return Err(AxysError::Invalid("the desk has too many strips".into()));
        }
        let mut clips: Vec<ClipStrips> = Vec::with_capacity(self.clips.len());
        for entry in &self.clips {
            if clips.iter().any(|kept| kept.clip == entry.clip) {
                continue;
            }
            clips.push(ClipStrips {
                clip: entry.clip,
                processed: entry.processed.validated()?,
                original: entry.original.validated()?,
            });
        }
        let mut references: Vec<ReferenceStrip> = Vec::with_capacity(self.references.len());
        for entry in &self.references {
            if references
                .iter()
                .any(|kept| kept.reference == entry.reference)
            {
                continue;
            }
            references.push(ReferenceStrip {
                reference: entry.reference,
                strip: entry.strip.validated()?,
            });
        }
        Ok(Self {
            clips,
            references,
            click: self.click.validated()?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_clip_starts_on_the_edited_take_with_the_click_below_it() {
        let mixer = MixerSettings::default();
        let track = mixer.clip(ClipId(0));
        assert!(!track.processed.mute);
        assert!(track.original.mute);
        assert!(!mixer.soloed());
        assert!(mixer.click.amplitude() < track.processed.amplitude());
    }

    #[test]
    fn a_reference_starts_at_unity() {
        let mixer = MixerSettings::default();
        assert_eq!(mixer.reference(ReferenceId(4)), MixerStrip::default());
    }

    #[test]
    fn levels_and_pans_are_clamped_rather_than_refused() {
        let mut mixer = MixerSettings::default();
        let mut track = ClipStrips::new(ClipId(0));
        track.processed.gain_db = 1000.0;
        track.original.pan = -4.0;
        mixer.clips.push(track);
        let checked = mixer.validated().expect("clamped");
        assert_eq!(
            checked.clip(ClipId(0)).processed.gain_db,
            limits::MAX_GAIN_DB
        );
        assert_eq!(checked.clip(ClipId(0)).original.pan, -1.0);
    }

    #[test]
    fn a_setting_that_is_not_a_number_is_refused() {
        let mut mixer = MixerSettings::default();
        mixer.click.gain_db = f64::NAN;
        assert!(mixer.validated().is_err());
    }

    #[test]
    fn a_source_listed_twice_keeps_its_first_entry() {
        let mut mixer = MixerSettings::default();
        let mut first = ClipStrips::new(ClipId(1));
        first.processed.gain_db = -6.0;
        mixer.clips.push(first);
        mixer.clips.push(ClipStrips::new(ClipId(1)));
        let checked = mixer.validated().expect("valid");
        assert_eq!(checked.clips.len(), 1);
        assert_eq!(checked.clip(ClipId(1)).processed.gain_db, -6.0);
    }

    #[test]
    fn a_soloed_reference_counts_as_a_solo() {
        let mut mixer = MixerSettings::default();
        mixer.references.push(ReferenceStrip {
            reference: ReferenceId(0),
            strip: MixerStrip {
                solo: true,
                ..MixerStrip::default()
            },
        });
        assert!(mixer.soloed());
    }
}
