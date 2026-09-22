// SPDX-License-Identifier: AGPL-3.0-or-later

//! Monitor levels for everything the transport plays.
//!
//! One strip per audio source, with the controls a desk has: level, pan, mute and solo. The
//! mixer is monitoring rather than an edit to the take, so it never reaches the render plan and
//! an export is unchanged by it. It lives in the project document because how a take is listened
//! to is part of the work, and it is set by an edit operation like anything else, so it undoes.

use serde::{Deserialize, Serialize};

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
}

impl Default for MixerStrip {
    fn default() -> Self {
        Self::new(0.0, false)
    }
}

/// The monitor desk: one strip per audio source the transport plays.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MixerSettings {
    /// The take as the edits make it sound.
    pub processed: MixerStrip,
    /// The take as it was sung, on the same transport clock.
    pub original: MixerStrip,
    /// The metronome.
    pub click: MixerStrip,
}

impl Default for MixerSettings {
    fn default() -> Self {
        Self {
            processed: MixerStrip::default(),
            // The edited take is what the editor is for, so the original starts muted and is
            // brought in to compare against it.
            original: MixerStrip::new(0.0, true),
            click: MixerStrip::new(DEFAULT_CLICK_DB, false),
        }
    }
}

impl MixerSettings {
    /// Every strip, in the order the desk draws them.
    pub fn strips(&self) -> [&MixerStrip; 3] {
        [&self.processed, &self.original, &self.click]
    }

    /// Whether any strip is soloed, which is what silences the ones that are not.
    pub fn soloed(&self) -> bool {
        self.strips().iter().any(|strip| strip.solo)
    }

    /// The same settings with every figure brought inside its bounds.
    ///
    /// A level out of range is clamped rather than refused, because a fader is dragged to its
    /// end rather than typed; a figure that is not a number is refused, because it is a bug.
    pub fn validated(&self) -> Result<Self> {
        let mut settings = *self;
        for strip in [
            &mut settings.processed,
            &mut settings.original,
            &mut settings.click,
        ] {
            if !strip.gain_db.is_finite() || !strip.pan.is_finite() {
                return Err(AxysError::Invalid("mixer setting is not finite".into()));
            }
            strip.gain_db = strip
                .gain_db
                .clamp(limits::MIN_GAIN_DB, limits::MAX_GAIN_DB);
            strip.pan = strip.pan.clamp(-1.0, 1.0);
        }
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_desk_starts_on_the_edited_take_with_the_click_below_it() {
        let mixer = MixerSettings::default();
        assert!(!mixer.processed.mute);
        assert!(mixer.original.mute);
        assert!(!mixer.soloed());
        assert!(mixer.click.amplitude() < mixer.processed.amplitude());
    }

    #[test]
    fn levels_and_pans_are_clamped_rather_than_refused() {
        let mut mixer = MixerSettings::default();
        mixer.processed.gain_db = 1000.0;
        mixer.original.pan = -4.0;
        let checked = mixer.validated().expect("clamped");
        assert_eq!(checked.processed.gain_db, limits::MAX_GAIN_DB);
        assert_eq!(checked.original.pan, -1.0);
    }

    #[test]
    fn a_setting_that_is_not_a_number_is_refused() {
        let mut mixer = MixerSettings::default();
        mixer.click.gain_db = f64::NAN;
        assert!(mixer.validated().is_err());
    }
}
