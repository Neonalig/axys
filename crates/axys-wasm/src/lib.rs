// SPDX-License-Identifier: AGPL-3.0-or-later

//! WebAssembly boundary for the Axys core.
//!
//! The surface is deliberately narrow: large audio buffers cross as typed
//! arrays, everything structured crosses as JSON so the contract stays stable
//! and independently testable from TypeScript.

use wasm_bindgen::prelude::*;

/// Installs a panic hook that reports Rust panics to the browser console.
///
/// Safe to call more than once.
#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Version of the compiled core.
#[wasm_bindgen(js_name = coreVersion)]
pub fn core_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Converts a frequency in Hz to a fractional MIDI note number.
///
/// Returns `NaN` for non-positive or non-finite input.
#[wasm_bindgen(js_name = hzToMidi)]
pub fn hz_to_midi(hz: f64, a4_hz: f64) -> f64 {
    axys_core::Tuning { a4_hz }
        .hz_to_midi(hz)
        .unwrap_or(f64::NAN)
}

/// Converts a fractional MIDI note number to a frequency in Hz.
#[wasm_bindgen(js_name = midiToHz)]
pub fn midi_to_hz(midi: f64, a4_hz: f64) -> f64 {
    axys_core::Tuning { a4_hz }.midi_to_hz(midi)
}
