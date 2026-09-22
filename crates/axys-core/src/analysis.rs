// SPDX-License-Identifier: AGPL-3.0-or-later

//! Observations derived from source audio: pitch, energy and provisional segmentation.
//!
//! Analysis never produces edits. Everything here can be recomputed from the source
//! and the recorded parameters, which is why a project may discard it.

pub mod energy;
pub mod f0;
pub mod segment;
