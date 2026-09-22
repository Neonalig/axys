// SPDX-License-Identifier: AGPL-3.0-or-later

//! Sample-rate conversion, fractional reads and channel downmixing.
//!
//! Fractional reads use Catmull-Rom, which is cheap enough for the per-grain
//! inner loops. Rate conversion uses a windowed-sinc kernel whose cutoff tracks
//! the lower of the two Nyquist frequencies, so downsampling does not alias.

/// Widest rate change the resampler accepts, as a target-over-source ratio.
const MAX_RATIO: f64 = 128.0;

/// Upper bound on kernel half-width in source samples, which bounds the work
/// per output sample at extreme downsampling ratios.
const MAX_HALF_WIDTH: f64 = 2048.0;

/// Fraction of the target Nyquist the anti-alias cutoff sits at.
const CUTOFF_MARGIN: f64 = 0.97;

/// Reads `source` at a fractional sample position with Catmull-Rom interpolation.
///
/// Positions outside the buffer read as silence.
pub fn sample_at(source: &[f32], position: f64) -> f32 {
    if !position.is_finite() || source.is_empty() {
        return 0.0;
    }
    let last = (source.len() - 1) as f64;
    if position < 0.0 || position > last {
        return 0.0;
    }

    let base = position.floor();
    let t = (position - base) as f32;
    let i = base as i64;

    let p0 = tap(source, i - 1);
    let p1 = tap(source, i);
    let p2 = tap(source, i + 1);
    let p3 = tap(source, i + 2);

    let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    let c = -0.5 * p0 + 0.5 * p2;
    ((a * t + b) * t + c) * t + p1
}

/// Resamples `source` to `target_rate` with a windowed-sinc kernel.
///
/// `quality` is the half-width of the kernel in source samples; 16 is a good default.
///
/// Returns an empty buffer when either rate is not a positive finite number or
/// the rates differ by more than a factor of 128.
pub fn resample(source: &[f32], source_rate: f64, target_rate: f64, quality: usize) -> Vec<f32> {
    if source.is_empty()
        || !source_rate.is_finite()
        || !target_rate.is_finite()
        || source_rate <= 0.0
        || target_rate <= 0.0
    {
        return Vec::new();
    }

    let ratio = target_rate / source_rate;
    if !(1.0 / MAX_RATIO..=MAX_RATIO).contains(&ratio) {
        return Vec::new();
    }
    if (ratio - 1.0).abs() < f64::EPSILON {
        return source.to_vec();
    }

    let quality = quality.clamp(2, 64) as f64;
    let cutoff = if ratio < 1.0 {
        ratio * CUTOFF_MARGIN
    } else {
        1.0
    };
    let half = (quality / cutoff).min(MAX_HALF_WIDTH);

    let out_len = (source.len() as f64 * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);

    for n in 0..out_len {
        let centre = n as f64 / ratio;
        let first = (centre - half).ceil() as i64;
        let last = (centre + half).floor() as i64;

        let mut acc = 0.0f64;
        let mut norm = 0.0f64;
        for j in first..=last {
            let x = centre - j as f64;
            let weight = sinc(std::f64::consts::PI * cutoff * x)
                * blackman_harris((x + half) / (2.0 * half));
            norm += weight;
            acc += weight * f64::from(tap(source, j));
        }

        let value = if norm.abs() > 1e-12 { acc / norm } else { 0.0 };
        out.push(value as f32);
    }

    out
}

/// Mixes interleaved multi-channel audio down to mono.
///
/// A trailing partial frame is discarded.
pub fn to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels == 0 || interleaved.is_empty() {
        return Vec::new();
    }
    if channels == 1 {
        return interleaved.to_vec();
    }

    let frames = interleaved.len() / channels;
    let scale = 1.0 / channels as f32;
    let mut out = Vec::with_capacity(frames);
    for frame in 0..frames {
        let base = frame * channels;
        let mut sum = 0.0f32;
        for c in 0..channels {
            sum += interleaved[base + c];
        }
        out.push(sum * scale);
    }
    out
}

/// Reads one sample, treating anything outside the buffer as silence.
fn tap(source: &[f32], index: i64) -> f32 {
    if index < 0 {
        return 0.0;
    }
    let index = index as usize;
    if index < source.len() {
        source[index]
    } else {
        0.0
    }
}

/// Normalised sinc, `sin(x) / x`, with the removable singularity filled in.
fn sinc(x: f64) -> f64 {
    if x.abs() < 1e-12 {
        1.0
    } else {
        x.sin() / x
    }
}

/// Four-term Blackman-Harris window evaluated over `u` in `0.0..=1.0`.
fn blackman_harris(u: f64) -> f64 {
    if !(0.0..=1.0).contains(&u) {
        return 0.0;
    }
    let t = 2.0 * std::f64::consts::PI * u;
    0.35875 - 0.48829 * t.cos() + 0.14128 * (2.0 * t).cos() - 0.01168 * (3.0 * t).cos()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(len: usize, rate: f64, hz: f64) -> Vec<f32> {
        (0..len)
            .map(|n| (2.0 * std::f64::consts::PI * hz * n as f64 / rate).sin() as f32 * 0.5)
            .collect()
    }

    fn rms(samples: &[f32]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f64 = samples.iter().map(|s| f64::from(*s) * f64::from(*s)).sum();
        (sum / samples.len() as f64).sqrt()
    }

    #[test]
    fn sample_at_hits_integer_positions() {
        let source = [0.0, 0.25, -0.5, 1.0, 0.125];
        for (i, expected) in source.iter().enumerate() {
            assert!((sample_at(&source, i as f64) - expected).abs() < 1e-6);
        }
    }

    #[test]
    fn sample_at_is_linear_on_a_ramp() {
        let source: Vec<f32> = (0..16).map(|n| n as f32).collect();
        for step in 1..13 {
            let p = step as f64 + 0.5;
            assert!((sample_at(&source, p) - p as f32).abs() < 1e-4, "at {p}");
        }
    }

    #[test]
    fn sample_at_is_silent_out_of_bounds() {
        let source = [1.0, 1.0, 1.0];
        assert_eq!(sample_at(&source, -0.001), 0.0);
        assert_eq!(sample_at(&source, -50.0), 0.0);
        assert_eq!(sample_at(&source, 2.001), 0.0);
        assert_eq!(sample_at(&source, 1e12), 0.0);
        assert_eq!(sample_at(&source, f64::NAN), 0.0);
        assert_eq!(sample_at(&source, f64::INFINITY), 0.0);
        assert_eq!(sample_at(&source, f64::NEG_INFINITY), 0.0);
        assert_eq!(sample_at(&[], 0.0), 0.0);
    }

    #[test]
    fn sample_at_end_points_use_silent_neighbours() {
        let source = [1.0, 1.0];
        assert!((sample_at(&source, 0.0) - 1.0).abs() < 1e-6);
        assert!((sample_at(&source, 1.0) - 1.0).abs() < 1e-6);
        assert!(sample_at(&source, 0.5).is_finite());
    }

    #[test]
    fn identity_resample_returns_the_source() {
        let source = sine(512, 48_000.0, 440.0);
        let out = resample(&source, 48_000.0, 48_000.0, 16);
        assert_eq!(out, source);
    }

    #[test]
    fn resample_rejects_bad_input() {
        let source = sine(64, 48_000.0, 440.0);
        assert!(resample(&[], 48_000.0, 44_100.0, 16).is_empty());
        assert!(resample(&source, 0.0, 44_100.0, 16).is_empty());
        assert!(resample(&source, 48_000.0, 0.0, 16).is_empty());
        assert!(resample(&source, -48_000.0, 44_100.0, 16).is_empty());
        assert!(resample(&source, f64::NAN, 44_100.0, 16).is_empty());
        assert!(resample(&source, 48_000.0, f64::INFINITY, 16).is_empty());
        assert!(resample(&source, 48_000.0, 1.0, 16).is_empty());
        assert!(resample(&source, 1.0, 48_000.0, 16).is_empty());
    }

    #[test]
    fn resample_length_follows_the_ratio() {
        let source = sine(4_800, 48_000.0, 200.0);
        let out = resample(&source, 48_000.0, 24_000.0, 16);
        assert_eq!(out.len(), 2_400);
        let up = resample(&source, 48_000.0, 96_000.0, 16);
        assert_eq!(up.len(), 9_600);
    }

    #[test]
    fn downsample_keeps_a_passband_tone() {
        let source = sine(24_000, 48_000.0, 1_000.0);
        let out = resample(&source, 48_000.0, 24_000.0, 32);
        let interior = &out[2_000..10_000];
        assert!(
            (rms(interior) - 0.3536).abs() < 0.01,
            "passband rms {}",
            rms(interior)
        );
    }

    #[test]
    fn downsample_does_not_alias_a_tone_above_target_nyquist() {
        let source = sine(24_000, 48_000.0, 16_000.0);
        let out = resample(&source, 48_000.0, 24_000.0, 32);
        let interior = &out[2_000..10_000];
        assert!(
            rms(interior) < 0.004,
            "alias rms {} should be near silent",
            rms(interior)
        );
    }

    #[test]
    fn round_trip_44100_48000_44100_stays_close() {
        let source = sine(22_050, 44_100.0, 440.0);
        let up = resample(&source, 44_100.0, 48_000.0, 32);
        let back = resample(&up, 48_000.0, 44_100.0, 32);
        assert!((back.len() as i64 - source.len() as i64).abs() <= 1);

        let lo = 1_000;
        let hi = source.len() - 1_000;
        let mut worst = 0.0f64;
        for i in lo..hi {
            let diff = (f64::from(back[i]) - f64::from(source[i])).abs();
            worst = worst.max(diff);
        }
        assert!(worst < 0.005, "worst round-trip error {worst}");
    }

    #[test]
    fn upsample_preserves_a_tone() {
        let source = sine(4_410, 44_100.0, 440.0);
        let out = resample(&source, 44_100.0, 88_200.0, 32);
        let interior = &out[500..8_000];
        assert!(
            (rms(interior) - 0.3536).abs() < 0.01,
            "rms {}",
            rms(interior)
        );
    }

    #[test]
    fn resample_handles_a_single_sample() {
        let out = resample(&[1.0], 48_000.0, 44_100.0, 16);
        assert_eq!(out.len(), 1);
        assert!(out[0].is_finite());
    }

    #[test]
    fn resample_output_is_finite_for_extreme_input() {
        let source: Vec<f32> = (0..256)
            .map(|n| if n % 2 == 0 { 1.0 } else { -1.0 })
            .collect();
        let out = resample(&source, 48_000.0, 8_000.0, 64);
        assert!(out.iter().all(|s| s.is_finite()));
    }

    #[test]
    fn to_mono_averages_channels() {
        let interleaved = [1.0, 0.0, -1.0, 1.0, 0.5, 0.5];
        let out = to_mono(&interleaved, 2);
        assert_eq!(out, vec![0.5, 0.0, 0.5]);
    }

    #[test]
    fn to_mono_passes_mono_through() {
        let interleaved = [0.25, -0.5, 1.0];
        assert_eq!(to_mono(&interleaved, 1), interleaved.to_vec());
    }

    #[test]
    fn to_mono_drops_a_partial_frame() {
        let interleaved = [1.0, 1.0, 1.0, 1.0, 1.0];
        assert_eq!(to_mono(&interleaved, 2), vec![1.0, 1.0]);
    }

    #[test]
    fn to_mono_handles_degenerate_arguments() {
        assert!(to_mono(&[1.0, 2.0], 0).is_empty());
        assert!(to_mono(&[], 2).is_empty());
        assert!(to_mono(&[1.0], 4).is_empty());
    }

    #[test]
    fn blackman_harris_is_symmetric_and_bounded() {
        assert!((blackman_harris(0.5) - 1.0).abs() < 1e-9);
        assert!(blackman_harris(0.0).abs() < 1e-3);
        for k in 0..=100 {
            let u = k as f64 / 100.0;
            let w = blackman_harris(u);
            assert!((w - blackman_harris(1.0 - u)).abs() < 1e-9);
            assert!((-1e-9..=1.0 + 1e-9).contains(&w));
        }
        assert_eq!(blackman_harris(-0.1), 0.0);
        assert_eq!(blackman_harris(1.1), 0.0);
    }
}
