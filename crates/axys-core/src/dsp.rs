// SPDX-License-Identifier: AGPL-3.0-or-later

//! Signal processing primitives and the pitch and time transformation.
//!
//! Each piece sits behind its own module so an implementation can be compared or
//! replaced without touching the editor or the project model.

pub mod formant;
pub mod psola;
pub mod resample;
pub mod window;
