// SPDX-License-Identifier: AGPL-3.0-or-later

//! Editable pitch curves built from time-ordered anchors.

use crate::{limits, AxysError, Result};
use serde::{Deserialize, Serialize};

/// Interpolation character leaving an anchor toward the next one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Interp {
    /// Straight line in semitones against time.
    Linear,
    /// Monotone cubic Hermite, tangent-limited so no overshoot is introduced.
    #[default]
    Cubic,
    /// Holds the anchor value until the next anchor time.
    Hold,
    /// Smoothstep ease between the two anchor values.
    Smooth,
}

/// One editable point on a pitch curve.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Position in source seconds.
    pub time: f64,
    /// Fractional MIDI note number.
    pub midi: f64,
    /// Interpolation used from this anchor to the next.
    #[serde(default)]
    pub interp: Interp,
}

impl Anchor {
    /// Creates an anchor with the default interpolation.
    pub fn new(time: f64, midi: f64) -> Self {
        Self {
            time,
            midi,
            interp: Interp::default(),
        }
    }

    /// Creates an anchor with an explicit interpolation.
    pub fn with_interp(time: f64, midi: f64, interp: Interp) -> Self {
        Self { time, midi, interp }
    }
}

/// An ordered set of anchors evaluated as a continuous pitch function.
///
/// Anchors stay sorted by time. Evaluating outside the anchor range clamps to
/// the first or last anchor value.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchCurve {
    anchors: Vec<Anchor>,
}

impl PitchCurve {
    /// Creates an empty curve.
    pub fn new() -> Self {
        Self::default()
    }

    /// Creates a curve from anchors, sorting them by time.
    pub fn from_anchors(mut anchors: Vec<Anchor>) -> Result<Self> {
        if anchors.len() > limits::MAX_CURVE_ANCHORS {
            return Err(AxysError::Invalid(format!(
                "curve has {} anchors, limit is {}",
                anchors.len(),
                limits::MAX_CURVE_ANCHORS
            )));
        }
        if anchors
            .iter()
            .any(|a| !a.time.is_finite() || !a.midi.is_finite())
        {
            return Err(AxysError::Invalid("anchor has a non-finite value".into()));
        }
        anchors.sort_by(|a, b| a.time.total_cmp(&b.time));
        Ok(Self { anchors })
    }

    /// Anchors in time order.
    pub fn anchors(&self) -> &[Anchor] {
        &self.anchors
    }

    /// True when the curve has no anchors.
    pub fn is_empty(&self) -> bool {
        self.anchors.is_empty()
    }

    /// Number of anchors.
    pub fn len(&self) -> usize {
        self.anchors.len()
    }

    /// Inserts an anchor in time order and returns its index.
    pub fn insert(&mut self, anchor: Anchor) -> usize {
        let idx = self.anchors.partition_point(|a| a.time <= anchor.time);
        self.anchors.insert(idx, anchor);
        idx
    }

    /// Removes the anchor at `index`.
    pub fn remove(&mut self, index: usize) -> Result<Anchor> {
        if index >= self.anchors.len() {
            return Err(AxysError::NotFound(format!("anchor {index}")));
        }
        Ok(self.anchors.remove(index))
    }

    /// Moves the anchor at `index`, restoring time order and returning its new index.
    pub fn move_anchor(&mut self, index: usize, time: f64, midi: f64) -> Result<usize> {
        if index >= self.anchors.len() {
            return Err(AxysError::NotFound(format!("anchor {index}")));
        }
        if !time.is_finite() || !midi.is_finite() {
            return Err(AxysError::Invalid("anchor has a non-finite value".into()));
        }
        let mut a = self.anchors.remove(index);
        a.time = time;
        a.midi = midi;
        Ok(self.insert(a))
    }

    /// Removes every anchor whose time lies in `[start, end]`.
    pub fn clear_span(&mut self, start: f64, end: f64) {
        self.anchors.retain(|a| a.time < start || a.time > end);
    }

    /// Time of the first anchor.
    pub fn start(&self) -> Option<f64> {
        self.anchors.first().map(|a| a.time)
    }

    /// Time of the last anchor.
    pub fn end(&self) -> Option<f64> {
        self.anchors.last().map(|a| a.time)
    }

    /// Evaluates the curve at `time`, in fractional MIDI note numbers.
    ///
    /// Returns `None` only when the curve has no anchors.
    pub fn eval(&self, time: f64) -> Option<f64> {
        match self.anchors.len() {
            0 => None,
            1 => Some(self.anchors[0].midi),
            _ => Some(self.eval_multi(time)),
        }
    }

    fn eval_multi(&self, time: f64) -> f64 {
        let n = self.anchors.len();
        if time <= self.anchors[0].time {
            return self.anchors[0].midi;
        }
        if time >= self.anchors[n - 1].time {
            return self.anchors[n - 1].midi;
        }
        let hi = self.anchors.partition_point(|a| a.time <= time);
        let i = hi - 1;
        let a = self.anchors[i];
        let b = self.anchors[i + 1];
        let span = b.time - a.time;
        if span <= 0.0 {
            return b.midi;
        }
        let t = ((time - a.time) / span).clamp(0.0, 1.0);
        match a.interp {
            Interp::Hold => a.midi,
            Interp::Linear => a.midi + (b.midi - a.midi) * t,
            Interp::Smooth => {
                let s = t * t * (3.0 - 2.0 * t);
                a.midi + (b.midi - a.midi) * s
            }
            Interp::Cubic => {
                let prev = if i > 0 {
                    Some(self.anchors[i - 1])
                } else {
                    None
                };
                let next = if i + 2 < n {
                    Some(self.anchors[i + 2])
                } else {
                    None
                };
                monotone_hermite(prev, a, b, next, t)
            }
        }
    }
}

/// Monotone cubic Hermite between `a` and `b` using neighbour-aware tangents.
///
/// Tangents follow the Fritsch-Carlson limiter, so a segment never overshoots
/// the two values it connects.
fn monotone_hermite(
    prev: Option<Anchor>,
    a: Anchor,
    b: Anchor,
    next: Option<Anchor>,
    t: f64,
) -> f64 {
    let h = b.time - a.time;
    let d = (b.midi - a.midi) / h;

    let slope_of = |from: Anchor, to: Anchor| -> f64 {
        let dt = to.time - from.time;
        if dt > 0.0 {
            (to.midi - from.midi) / dt
        } else {
            d
        }
    };
    let d_prev = prev.map(|p| slope_of(p, a)).unwrap_or(d);
    let d_next = next.map(|n| slope_of(b, n)).unwrap_or(d);

    let m0 = limited_tangent(d_prev, d);
    let m1 = limited_tangent(d, d_next);

    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * a.midi + h10 * h * m0 + h01 * b.midi + h11 * h * m1
}

/// Averages two secant slopes, flattening at extrema and clamping to three
/// times the smaller magnitude.
fn limited_tangent(left: f64, right: f64) -> f64 {
    if left * right <= 0.0 {
        return 0.0;
    }
    let mean = 0.5 * (left + right);
    let bound = 3.0 * left.abs().min(right.abs());
    mean.clamp(-bound, bound)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn curve(points: &[(f64, f64)], interp: Interp) -> PitchCurve {
        PitchCurve::from_anchors(
            points
                .iter()
                .map(|&(t, m)| Anchor::with_interp(t, m, interp))
                .collect(),
        )
        .unwrap()
    }

    #[test]
    fn empty_curve_has_no_value() {
        assert!(PitchCurve::new().eval(0.0).is_none());
    }

    #[test]
    fn single_anchor_is_constant() {
        let c = curve(&[(1.0, 60.0)], Interp::Linear);
        assert_eq!(c.eval(-5.0), Some(60.0));
        assert_eq!(c.eval(99.0), Some(60.0));
    }

    #[test]
    fn linear_interpolates_and_clamps() {
        let c = curve(&[(0.0, 60.0), (1.0, 72.0)], Interp::Linear);
        assert!((c.eval(0.5).unwrap() - 66.0).abs() < 1e-9);
        assert_eq!(c.eval(-1.0), Some(60.0));
        assert_eq!(c.eval(2.0), Some(72.0));
    }

    #[test]
    fn hold_keeps_the_left_value() {
        let c = curve(&[(0.0, 60.0), (1.0, 72.0)], Interp::Hold);
        assert_eq!(c.eval(0.99), Some(60.0));
        assert_eq!(c.eval(1.0), Some(72.0));
    }

    #[test]
    fn smooth_is_symmetric_about_the_midpoint() {
        let c = curve(&[(0.0, 60.0), (1.0, 62.0)], Interp::Smooth);
        assert!((c.eval(0.5).unwrap() - 61.0).abs() < 1e-9);
        let below = c.eval(0.25).unwrap() - 60.0;
        let above = 62.0 - c.eval(0.75).unwrap();
        assert!((below - above).abs() < 1e-9);
    }

    #[test]
    fn cubic_passes_through_anchors_without_overshoot() {
        let c = curve(
            &[(0.0, 60.0), (1.0, 62.0), (2.0, 62.0), (3.0, 67.0)],
            Interp::Cubic,
        );
        assert!((c.eval(1.0).unwrap() - 62.0).abs() < 1e-9);
        assert!((c.eval(2.0).unwrap() - 62.0).abs() < 1e-9);
        for i in 0..=100 {
            let t = 1.0 + i as f64 / 100.0;
            let v = c.eval(t).unwrap();
            assert!((61.999..=62.001).contains(&v), "overshoot at {t}: {v}");
        }
    }

    #[test]
    fn cubic_stays_within_the_endpoints_on_a_rise() {
        let c = curve(
            &[(0.0, 60.0), (1.0, 61.0), (2.0, 65.0), (3.0, 66.0)],
            Interp::Cubic,
        );
        for i in 0..=200 {
            let t = i as f64 * 3.0 / 200.0;
            let v = c.eval(t).unwrap();
            assert!((59.999..=66.001).contains(&v), "out of range at {t}: {v}");
        }
    }

    #[test]
    fn insert_keeps_time_order() {
        let mut c = curve(&[(0.0, 60.0), (2.0, 64.0)], Interp::Linear);
        let idx = c.insert(Anchor::new(1.0, 62.0));
        assert_eq!(idx, 1);
        let times: Vec<f64> = c.anchors().iter().map(|a| a.time).collect();
        assert_eq!(times, vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn move_reorders() {
        let mut c = curve(&[(0.0, 60.0), (1.0, 62.0), (2.0, 64.0)], Interp::Linear);
        let idx = c.move_anchor(0, 1.5, 61.0).unwrap();
        assert_eq!(idx, 1);
        let times: Vec<f64> = c.anchors().iter().map(|a| a.time).collect();
        assert_eq!(times, vec![1.0, 1.5, 2.0]);
    }

    #[test]
    fn clear_span_removes_an_inclusive_range() {
        let mut c = curve(
            &[(0.0, 60.0), (1.0, 62.0), (2.0, 64.0), (3.0, 66.0)],
            Interp::Linear,
        );
        c.clear_span(1.0, 2.0);
        let times: Vec<f64> = c.anchors().iter().map(|a| a.time).collect();
        assert_eq!(times, vec![0.0, 3.0]);
    }

    #[test]
    fn rejects_non_finite_anchors() {
        assert!(PitchCurve::from_anchors(vec![Anchor::new(f64::NAN, 60.0)]).is_err());
        assert!(PitchCurve::from_anchors(vec![Anchor::new(0.0, f64::INFINITY)]).is_err());
    }

    #[test]
    fn unsorted_input_is_sorted() {
        let c = curve(&[(2.0, 64.0), (0.0, 60.0), (1.0, 62.0)], Interp::Linear);
        let times: Vec<f64> = c.anchors().iter().map(|a| a.time).collect();
        assert_eq!(times, vec![0.0, 1.0, 2.0]);
    }

    #[test]
    fn serialization_round_trips() {
        let c = curve(&[(0.0, 60.0), (1.0, 62.5)], Interp::Cubic);
        let json = serde_json::to_string(&c).unwrap();
        let back: PitchCurve = serde_json::from_str(&json).unwrap();
        assert_eq!(c, back);
    }
}
