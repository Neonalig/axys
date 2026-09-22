// SPDX-License-Identifier: AGPL-3.0-or-later

//! Window functions and slice statistics shared by the analysis and synthesis paths.

use std::f32::consts::TAU;

/// Builds a periodic Hann window of `len` samples.
///
/// The periodic form is the one an FFT wants: it omits the duplicate endpoint, so a
/// length-1 window is a single zero.
pub fn hann(len: usize) -> Vec<f32> {
    if len == 0 {
        return Vec::new();
    }
    let n = len as f32;
    (0..len)
        .map(|i| 0.5 - 0.5 * (TAU * i as f32 / n).cos())
        .collect()
}

/// Builds a symmetric Hann window of `len` samples, which sums to unity at 50% overlap.
///
/// Sampled on the half-sample grid, so the window reads the same forwards and backwards
/// and constant overlap-add holds exactly for an even `len` at a hop of `len / 2`.
pub fn hann_symmetric(len: usize) -> Vec<f32> {
    if len == 0 {
        return Vec::new();
    }
    let n = len as f32;
    (0..len)
        .map(|i| 0.5 - 0.5 * (TAU * (i as f32 + 0.5) / n).cos())
        .collect()
}

/// Normalised cross-correlation of two equal-length slices, in -1.0..=1.0.
///
/// Zero when the lengths differ, either slice is empty, or either carries no energy.
pub fn normalised_correlation(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut energy_a = 0.0f64;
    let mut energy_b = 0.0f64;
    for (&x, &y) in a.iter().zip(b.iter()) {
        let x = x as f64;
        let y = y as f64;
        dot += x * y;
        energy_a += x * x;
        energy_b += y * y;
    }
    let denominator = (energy_a * energy_b).sqrt();
    if !denominator.is_finite() || denominator <= 0.0 {
        return 0.0;
    }
    let value = dot / denominator;
    if value.is_finite() {
        (value as f32).clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

/// Peak absolute value of a slice.
///
/// Zero for an empty slice. Non-finite samples are ignored.
pub fn peak(samples: &[f32]) -> f32 {
    let mut best = 0.0f32;
    for &s in samples {
        let magnitude = s.abs();
        if magnitude.is_finite() && magnitude > best {
            best = magnitude;
        }
    }
    best
}

/// Root mean square of a slice.
///
/// Zero for an empty slice.
pub fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    let sum: f64 = samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
    let value = (sum / samples.len() as f64).sqrt() as f32;
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_windows_are_empty() {
        assert!(hann(0).is_empty());
        assert!(hann_symmetric(0).is_empty());
    }

    #[test]
    fn hann_is_periodic() {
        let w = hann(8);
        assert_eq!(w.len(), 8);
        assert!(w[0].abs() < 1e-6);
        assert!((w[4] - 1.0).abs() < 1e-6);
        // Periodic Hann mirrors about the peak, not about the last sample.
        for i in 1..4 {
            assert!((w[i] - w[8 - i]).abs() < 1e-6, "index {i}");
        }
    }

    #[test]
    fn hann_never_leaves_zero_to_one() {
        for len in [1usize, 2, 3, 15, 64, 1024] {
            for &v in hann(len).iter().chain(hann_symmetric(len).iter()) {
                assert!((0.0..=1.0).contains(&v), "len {len} produced {v}");
            }
        }
    }

    #[test]
    fn hann_periodic_sums_to_unity_at_half_overlap() {
        let len = 64;
        let w = hann(len);
        for i in 0..len / 2 {
            assert!((w[i] + w[i + len / 2] - 1.0).abs() < 1e-5, "index {i}");
        }
    }

    #[test]
    fn hann_symmetric_is_symmetric() {
        for len in [2usize, 3, 16, 33, 128] {
            let w = hann_symmetric(len);
            for i in 0..len {
                assert!(
                    (w[i] - w[len - 1 - i]).abs() < 1e-6,
                    "len {len} index {i}: {} vs {}",
                    w[i],
                    w[len - 1 - i]
                );
            }
        }
    }

    #[test]
    fn hann_symmetric_satisfies_cola_at_half_overlap() {
        for len in [16usize, 64, 512, 2048] {
            let hop = len / 2;
            let w = hann_symmetric(len);
            let total = len * 4;
            let mut acc = vec![0.0f32; total];
            let mut start = 0usize;
            while start + len <= total {
                for i in 0..len {
                    acc[start + i] += w[i];
                }
                start += hop;
            }
            // Only the fully overlapped interior is expected to reach unity.
            for (i, &v) in acc.iter().enumerate().take(start).skip(hop) {
                assert!((v - 1.0).abs() < 1e-5, "len {len} index {i} summed to {v}");
            }
        }
    }

    #[test]
    fn hann_symmetric_length_one_is_unity() {
        let w = hann_symmetric(1);
        assert!((w[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn correlation_of_identical_signals_is_one() {
        let a: Vec<f32> = (0..256)
            .map(|i| (TAU * 3.0 * i as f32 / 256.0).sin())
            .collect();
        assert!((normalised_correlation(&a, &a) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn correlation_of_opposite_signals_is_minus_one() {
        let a: Vec<f32> = (0..256)
            .map(|i| (TAU * 3.0 * i as f32 / 256.0).sin())
            .collect();
        let b: Vec<f32> = a.iter().map(|&v| -v).collect();
        assert!((normalised_correlation(&a, &b) + 1.0).abs() < 1e-5);
    }

    #[test]
    fn correlation_of_orthogonal_signals_is_zero() {
        let n = 256;
        let a: Vec<f32> = (0..n)
            .map(|i| (TAU * 3.0 * i as f32 / n as f32).sin())
            .collect();
        let b: Vec<f32> = (0..n)
            .map(|i| (TAU * 3.0 * i as f32 / n as f32).cos())
            .collect();
        assert!(normalised_correlation(&a, &b).abs() < 1e-5);
    }

    #[test]
    fn correlation_ignores_amplitude() {
        let a: Vec<f32> = (0..64).map(|i| i as f32 - 32.0).collect();
        let b: Vec<f32> = a.iter().map(|&v| v * 7.5).collect();
        assert!((normalised_correlation(&a, &b) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn correlation_rejects_degenerate_input() {
        assert_eq!(normalised_correlation(&[], &[]), 0.0);
        assert_eq!(normalised_correlation(&[1.0, 2.0], &[1.0]), 0.0);
        assert_eq!(normalised_correlation(&[0.0, 0.0], &[1.0, 2.0]), 0.0);
        assert_eq!(
            normalised_correlation(&[f32::NAN, 1.0], &[1.0, 1.0]),
            0.0,
            "a NaN sample must not produce a NaN correlation"
        );
        assert_eq!(
            normalised_correlation(&[f32::INFINITY, 1.0], &[1.0, 1.0]),
            0.0
        );
    }

    #[test]
    fn correlation_stays_in_range_for_huge_samples() {
        let a = vec![f32::MAX, f32::MAX, -f32::MAX];
        let c = normalised_correlation(&a, &a);
        assert!((-1.0..=1.0).contains(&c));
        assert!((c - 1.0).abs() < 1e-5);
    }

    #[test]
    fn peak_reports_largest_magnitude() {
        assert_eq!(peak(&[]), 0.0);
        assert_eq!(peak(&[0.2, -0.9, 0.5]), 0.9);
        assert_eq!(peak(&[-3.0, 1.0]), 3.0);
        assert_eq!(peak(&[0.0, -0.0]), 0.0);
    }

    #[test]
    fn peak_ignores_non_finite_samples() {
        assert_eq!(peak(&[f32::NAN, 0.25]), 0.25);
        assert_eq!(peak(&[f32::INFINITY, 0.25]), 0.25);
        assert_eq!(peak(&[f32::NEG_INFINITY]), 0.0);
    }

    #[test]
    fn rms_matches_known_values() {
        assert_eq!(rms(&[]), 0.0);
        assert_eq!(rms(&[0.0; 16]), 0.0);
        assert!((rms(&[1.0, -1.0, 1.0, -1.0]) - 1.0).abs() < 1e-6);
        assert!((rms(&[3.0, 4.0]) - 12.5f32.sqrt()).abs() < 1e-6);
    }

    #[test]
    fn rms_of_a_sine_is_amplitude_over_root_two() {
        let n = 4096;
        let a: Vec<f32> = (0..n)
            .map(|i| (TAU * 8.0 * i as f32 / n as f32).sin())
            .collect();
        assert!((rms(&a) - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-3);
    }

    #[test]
    fn rms_of_non_finite_input_is_zero() {
        assert_eq!(rms(&[f32::NAN, 1.0]), 0.0);
        assert_eq!(rms(&[f32::INFINITY, 1.0]), 0.0);
    }

    #[test]
    fn rms_does_not_overflow_on_large_samples() {
        let r = rms(&[f32::MAX, f32::MAX]);
        assert!(r.is_finite());
        assert!((r - f32::MAX).abs() <= f32::MAX * 1e-3);
    }
}
