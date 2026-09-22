// SPDX-License-Identifier: AGPL-3.0-or-later

//! Analysis, editing, timeline and DSP core for Axys.
//!
//! The crate is plain Rust with no browser bindings so every rule can be unit
//! tested natively. [`axys-wasm`] wraps it for the browser.

pub mod analysis;
pub mod audio;
pub mod blob;
pub mod curve;
pub mod dsp;
pub mod edit;
pub mod midi;
pub mod mixer;
pub mod project;
pub mod render;
pub mod target;
pub mod timeline;
pub mod units;

pub use units::{AccidentalStyle, Tuning};

/// Error raised by any core operation that can reject its input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AxysError {
    /// Input was structurally invalid or exceeded a documented safety bound.
    Invalid(String),
    /// A referenced object id does not exist.
    NotFound(String),
    /// The operation is defined but not available for this input.
    Unsupported(String),
}

impl std::fmt::Display for AxysError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AxysError::Invalid(m) => write!(f, "invalid input: {m}"),
            AxysError::NotFound(m) => write!(f, "not found: {m}"),
            AxysError::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

impl std::error::Error for AxysError {}

/// Result alias used throughout the core.
pub type Result<T> = std::result::Result<T, AxysError>;

/// Limits applied to untrusted imported data.
pub mod limits {
    /// Longest accepted source audio, in seconds.
    pub const MAX_AUDIO_SECONDS: f64 = 3600.0;
    /// Highest accepted source sample rate, in Hz.
    pub const MAX_SAMPLE_RATE: u32 = 384_000;
    /// Lowest accepted source sample rate, in Hz.
    pub const MIN_SAMPLE_RATE: u32 = 4_000;
    /// Largest accepted MIDI file, in bytes.
    pub const MAX_MIDI_BYTES: usize = 32 * 1024 * 1024;
    /// Largest accepted MIDI event count across all tracks.
    pub const MAX_MIDI_EVENTS: usize = 2_000_000;
    /// Largest accepted tempo or meter map length.
    pub const MAX_MAP_EVENTS: usize = 100_000;
    /// Largest accepted anchor count in one pitch curve.
    pub const MAX_CURVE_ANCHORS: usize = 100_000;
    /// Largest accepted blob count in one project.
    pub const MAX_BLOBS: usize = 100_000;
    /// Quietest a blob or a mixer strip may be set to, in decibels.
    ///
    /// The floor is silence rather than a level, so a fader taken all the way down is off.
    pub const MIN_GAIN_DB: f64 = -60.0;
    /// Loudest a blob or a mixer strip may be set to, in decibels.
    pub const MAX_GAIN_DB: f64 = 24.0;
}
