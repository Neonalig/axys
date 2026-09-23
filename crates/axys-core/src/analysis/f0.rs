// SPDX-License-Identifier: AGPL-3.0-or-later

//! Fundamental-frequency estimation and the detected pitch track it produces.
//!
//! The estimator is pYIN-shaped: the cumulative mean normalised difference function of
//! de Cheveigne and Kawahara, "YIN, a fundamental frequency estimator for speech and
//! music" (JASA 111(4), 2002), with parabolic interpolation of the chosen lag, followed by
//! the Viterbi decoding over per-frame lag candidates and a voiced/unvoiced state described
//! by Mauch and Dixon, "pYIN: a fundamental frequency estimator using probabilistic
//! threshold distributions" (ICASSP 2014). Decoding in log-frequency is what keeps octave
//! errors and isolated dropouts out of the track.
//!
//! The difference function is evaluated through an FFT cross-correlation, so the cost per
//! frame is set by the frame length rather than by the product of window length and lag
//! range, and every buffer is allocated once for the whole run.

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::ops::Range;
use std::sync::Arc;

use crate::{limits, AxysError, Result};

/// Serde shim mapping the NaN that marks an unvoiced frame to and from JSON null.
mod nan_as_null {
    use super::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(value: &f64, out: S) -> core::result::Result<S::Ok, S::Error> {
        match value.is_finite() {
            true => out.serialize_f64(*value),
            false => out.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(input: D) -> core::result::Result<f64, D::Error> {
        Ok(Option::<f64>::deserialize(input)?.unwrap_or(f64::NAN))
    }
}

/// Serde shim mapping NaN entries of a flat array to and from JSON null.
mod nan_vec_as_null {
    use super::{Deserialize, Deserializer, Serializer};
    use serde::ser::SerializeSeq;

    pub fn serialize<S: Serializer>(
        values: &[f32],
        out: S,
    ) -> core::result::Result<S::Ok, S::Error> {
        let mut seq = out.serialize_seq(Some(values.len()))?;
        for value in values {
            match value.is_finite() {
                true => seq.serialize_element(value)?,
                false => seq.serialize_element(&Option::<f32>::None)?,
            }
        }
        seq.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        input: D,
    ) -> core::result::Result<Vec<f32>, D::Error> {
        Ok(Vec::<Option<f32>>::deserialize(input)?
            .into_iter()
            .map(|v| v.unwrap_or(f32::NAN))
            .collect())
    }
}

/// Parameters controlling fundamental-frequency estimation.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct F0Params {
    /// Lowest frequency the estimator will report, in Hz.
    pub min_hz: f64,
    /// Highest frequency the estimator will report, in Hz.
    pub max_hz: f64,
    /// Length of the analysis window, in seconds.
    pub frame_seconds: f64,
    /// Spacing between frame centres, in seconds.
    pub hop_seconds: f64,
    /// YIN absolute threshold on the normalised difference function.
    pub threshold: f64,
    /// Frame RMS below which a frame can only be unvoiced.
    pub voiced_rms_floor: f32,
    /// Raises `threshold` to suit the clip, for material whose pitch dips less deeply than a dry
    /// vocal's: reverb, compression, lossy encoding or doubled parts.
    ///
    /// Off for analyses stored before it existed, so they decode as they did.
    #[serde(default)]
    pub auto_threshold: bool,
}

impl Default for F0Params {
    fn default() -> Self {
        Self {
            min_hz: 65.0,
            max_hz: 1000.0,
            frame_seconds: 0.0464,
            hop_seconds: 0.005,
            threshold: 0.15,
            voiced_rms_floor: 0.0015,
            auto_threshold: true,
        }
    }
}

/// One analysis frame of detected pitch.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchFrame {
    /// Frame centre in source seconds.
    pub time: f64,
    /// Detected frequency in Hz, 0.0 when unvoiced.
    pub f0: f64,
    /// Fractional MIDI at A4 = 440 Hz, `f64::NAN` when unvoiced.
    #[serde(with = "nan_as_null")]
    pub midi: f64,
    /// Periodicity confidence in 0.0..=1.0.
    pub confidence: f32,
    /// RMS of the source over the analysis window.
    pub rms: f32,
    /// Whether the frame carries a periodic pitch.
    pub voiced: bool,
}

/// Detected pitch over time, stored as ordered frames on a uniform hop.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTrack {
    /// Sample rate the analysis ran at, in Hz.
    pub sample_rate: f64,
    /// Spacing between frame centres, in seconds.
    pub hop_seconds: f64,
    /// Frames in ascending time order.
    pub frames: Vec<PitchFrame>,
}

/// Flat arrays of a pitch track for cheap transfer to JavaScript.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchTrackArrays {
    /// Frame centres in source seconds.
    pub times: Vec<f32>,
    /// Fractional MIDI per frame, NaN where unvoiced.
    #[serde(with = "nan_vec_as_null")]
    pub midi: Vec<f32>,
    /// Periodicity confidence per frame.
    pub confidence: Vec<f32>,
    /// Frame RMS per frame.
    pub rms: Vec<f32>,
}

impl PitchTrack {
    /// Time covered by the track, in seconds.
    pub fn duration(&self) -> f64 {
        match self.frames.last() {
            Some(last) => last.time + self.hop_seconds.max(0.0),
            None => 0.0,
        }
    }

    /// Nearest frame index to `time`, or None when empty.
    pub fn frame_index_at(&self, time: f64) -> Option<usize> {
        if self.frames.is_empty() || !time.is_finite() {
            return None;
        }
        let upper = self.frames.partition_point(|f| f.time < time);
        if upper == 0 {
            return Some(0);
        }
        if upper >= self.frames.len() {
            return Some(self.frames.len() - 1);
        }
        let before = upper - 1;
        let d_before = (time - self.frames[before].time).abs();
        let d_after = (self.frames[upper].time - time).abs();
        Some(if d_after < d_before { upper } else { before })
    }

    /// Linearly interpolated MIDI at `time`; None inside unvoiced spans or outside the track.
    pub fn midi_at(&self, time: f64) -> Option<f64> {
        let (a, b, t) = self.bracket(time)?;
        Some(lerp(a.midi, b.midi, t))
    }

    /// Linearly interpolated F0 in Hz at `time`; None inside unvoiced spans or outside the track.
    pub fn hz_at(&self, time: f64) -> Option<f64> {
        let (a, b, t) = self.bracket(time)?;
        Some(lerp(a.f0, b.f0, t))
    }

    /// Median MIDI over `[start, end]` across voiced frames only.
    ///
    /// An even count averages the two central values.
    pub fn median_midi(&self, start: f64, end: f64) -> Option<f64> {
        if !start.is_finite() || !end.is_finite() || end < start {
            return None;
        }
        let mut values: Vec<f64> = self
            .frames
            .iter()
            .filter(|f| f.voiced && f.midi.is_finite() && f.time >= start && f.time <= end)
            .map(|f| f.midi)
            .collect();
        if values.is_empty() {
            return None;
        }
        values.sort_by(|a, b| a.total_cmp(b));
        let mid = values.len() / 2;
        if values.len() % 2 == 1 {
            Some(values[mid])
        } else {
            Some(0.5 * (values[mid - 1] + values[mid]))
        }
    }

    /// Contiguous voiced spans as (start, end) in seconds.
    ///
    /// A span runs from the first voiced frame centre to one hop past the last, so a single
    /// voiced frame still has non-zero length.
    pub fn voiced_spans(&self) -> Vec<(f64, f64)> {
        let hop = self.hop_seconds.max(0.0);
        let mut spans = Vec::new();
        let mut open: Option<(f64, f64)> = None;
        for frame in &self.frames {
            if frame.voiced {
                match open.as_mut() {
                    Some(span) => span.1 = frame.time + hop,
                    None => open = Some((frame.time, frame.time + hop)),
                }
            } else if let Some(span) = open.take() {
                spans.push(span);
            }
        }
        if let Some(span) = open {
            spans.push(span);
        }
        spans
    }

    /// Struct-of-arrays view for the WASM boundary.
    pub fn to_arrays(&self) -> PitchTrackArrays {
        let n = self.frames.len();
        let mut arrays = PitchTrackArrays {
            times: Vec::with_capacity(n),
            midi: Vec::with_capacity(n),
            confidence: Vec::with_capacity(n),
            rms: Vec::with_capacity(n),
        };
        for frame in &self.frames {
            arrays.times.push(frame.time as f32);
            arrays.midi.push(if frame.voiced {
                frame.midi as f32
            } else {
                f32::NAN
            });
            arrays.confidence.push(frame.confidence);
            arrays.rms.push(frame.rms);
        }
        arrays
    }

    /// Voiced frames bracketing `time`, with the interpolation fraction between them.
    fn bracket(&self, time: f64) -> Option<(&PitchFrame, &PitchFrame, f64)> {
        if !time.is_finite() || self.frames.is_empty() {
            return None;
        }
        let last = self.frames.len() - 1;
        if time < self.frames[0].time || time > self.frames[last].time {
            return None;
        }
        let upper = self.frames.partition_point(|f| f.time <= time);
        let (lo, hi) = if upper == 0 {
            (0, 0)
        } else if upper > last {
            (last, last)
        } else {
            (upper - 1, upper)
        };
        let a = &self.frames[lo];
        let b = &self.frames[hi];
        let span = b.time - a.time;
        let t = if span > 0.0 {
            ((time - a.time) / span).clamp(0.0, 1.0)
        } else {
            0.0
        };
        // Only the endpoints the interpolation actually reads need to be voiced. A query
        // landing exactly on the last voiced frame of a span weights its unvoiced
        // neighbour at zero, and rejecting it there would punch a hole in the target at
        // the release of every note.
        if (t < 1.0 && !a.voiced) || (t > 0.0 && !b.voiced) {
            return None;
        }
        Some((a, b, t))
    }
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

/// Most candidate lags carried forward from one frame.
const MAX_CANDIDATES: usize = 16;
/// Viterbi states per frame: the candidate lags plus one unvoiced state.
const MAX_STATES: usize = MAX_CANDIDATES + 1;
/// Cost charged per semitone of frame-to-frame pitch movement.
const PITCH_TRANSITION_COST: f64 = 0.08;
/// Cost charged for entering or leaving the unvoiced state.
const VOICING_SWITCH_COST: f64 = 0.15;
/// Discount applied to the lowest lag whose normalised difference clears the threshold.
const THRESHOLD_BONUS: f64 = 0.15;
/// Multiplier turning the YIN threshold into the cost of the unvoiced state.
const UNVOICED_COST_SCALE: f64 = 2.0;
/// Most frames one analysis may produce.
const MAX_FRAMES: usize = 4_000_000;

/// Estimates F0 over `samples` using a pYIN-style probabilistic YIN.
///
/// Implements the cumulative mean normalised difference function of de Cheveigne and
/// Kawahara (YIN, 2002) with parabolic interpolation of the chosen lag, then a Viterbi
/// pass over candidate lags per frame in the manner of Mauch and Dixon (pYIN, 2014) so
/// octave errors and isolated dropouts are penalised by transition cost.
///
/// Frame centres sit at exact multiples of the realised hop, which is `hop_seconds` rounded
/// to a whole number of samples and reported on the returned track.
pub fn detect_f0(samples: &[f32], sample_rate: f64, params: &F0Params) -> Result<PitchTrack> {
    let layout = F0Frames::new(samples.len(), sample_rate, params)?;
    let candidates = observe_f0(&layout, params, samples, 0, 0..layout.count())?;
    decode_f0(&layout, params, &candidates)
}

/// Frame layout of one F0 run over a source buffer.
///
/// Frame centres sit at multiples of the realised hop, which is `hop_seconds` rounded to a whole
/// number of samples.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct F0Frames {
    sample_rate: f64,
    len: usize,
    hop_samples: usize,
    frame_len: usize,
    count: usize,
}

impl F0Frames {
    /// Lays out the frames for a source buffer of `len` samples.
    ///
    /// # Errors
    /// Invalid parameters, a sample rate or duration outside the core's limits, or more frames
    /// than one run may produce.
    pub fn new(len: usize, sample_rate: f64, params: &F0Params) -> Result<Self> {
        validate(len, sample_rate, params)?;
        let hop_samples = ((params.hop_seconds * sample_rate).round() as usize).max(1);
        let frame_len = ((params.frame_seconds * sample_rate).round() as usize).max(4);
        let count = len.div_ceil(hop_samples);
        if count > MAX_FRAMES {
            return Err(AxysError::Invalid(format!(
                "analysis would produce {count} frames, over the {MAX_FRAMES} limit"
            )));
        }
        Ok(Self {
            sample_rate,
            len,
            hop_samples,
            frame_len,
            count,
        })
    }

    /// Frames the buffer yields.
    pub fn count(&self) -> usize {
        self.count
    }

    /// Spacing between frame centres, in seconds.
    pub fn hop_seconds(&self) -> f64 {
        self.hop_samples as f64 / self.sample_rate
    }

    /// The source samples the frames in `frames` read.
    pub fn samples_for(&self, frames: Range<usize>) -> Range<usize> {
        if frames.is_empty() {
            return 0..0;
        }
        let start = self.window_start(frames.start);
        let end = (self.window_start(frames.end - 1) + self.frame_len).min(self.len);
        start..end
    }

    /// First sample of the window for frame `index`, sliding inside the buffer at the edges.
    fn window_start(&self, index: usize) -> usize {
        if self.len >= self.frame_len {
            (index * self.hop_samples)
                .saturating_sub(self.frame_len / 2)
                .min(self.len - self.frame_len)
        } else {
            0
        }
    }
}

/// Collects the YIN candidates for the frames in `frames`, before decoding.
///
/// `window` holds source samples starting at sample `offset` and must cover
/// [`F0Frames::samples_for`] of the same frames. Spans collected apart and joined in order with
/// [`F0Candidates::append`] decode exactly as one run over the whole buffer.
///
/// # Errors
/// Frames past the layout, a window that does not cover them, a non-finite sample, or a frame
/// too short for the pitch range.
pub fn observe_f0(
    layout: &F0Frames,
    params: &F0Params,
    window: &[f32],
    offset: usize,
    frames: Range<usize>,
) -> Result<F0Candidates> {
    if frames.start > frames.end || frames.end > layout.count {
        return Err(AxysError::Invalid(format!(
            "frames {}..{} outside the run's {} frames",
            frames.start, frames.end, layout.count
        )));
    }
    let needed = layout.samples_for(frames.clone());
    if needed.start < offset || needed.end > offset + window.len() {
        return Err(AxysError::Invalid(format!(
            "samples {}..{} do not cover the {}..{} the frames read",
            offset,
            offset + window.len(),
            needed.start,
            needed.end
        )));
    }
    if window.iter().any(|s| !s.is_finite()) {
        return Err(AxysError::Invalid(
            "samples contain a non-finite value".into(),
        ));
    }

    let mut candidates = F0Candidates::with_capacity(frames.len());
    if frames.is_empty() {
        return Ok(candidates);
    }
    let mut yin = Yin::new(layout, params)?;
    for index in frames {
        let start = layout.window_start(index);
        let end = (start + layout.frame_len).min(layout.len);
        yin.load_window(&window[start - offset..end - offset]);
        let rms = yin.window_rms();
        yin.difference();
        candidates.begin_frame(rms);
        if rms >= params.voiced_rms_floor {
            yin.collect_candidates(params.threshold, &mut candidates);
        }
        candidates.end_frame();
    }
    Ok(candidates)
}

/// Decodes the candidates for every frame of a run into its pitch track.
///
/// # Errors
/// Candidates that do not hold exactly one entry per frame of `layout`.
pub fn decode_f0(
    layout: &F0Frames,
    params: &F0Params,
    candidates: &F0Candidates,
) -> Result<PitchTrack> {
    if candidates.len() != layout.count {
        return Err(AxysError::Invalid(format!(
            "{} frames of candidates for a run of {} frames",
            candidates.len(),
            layout.count
        )));
    }
    let threshold = if params.auto_threshold {
        clip_threshold(candidates, params)
    } else {
        params.threshold
    };
    let states = decode(candidates, threshold);
    let hop_seconds = layout.hop_seconds();
    Ok(PitchTrack {
        sample_rate: layout.sample_rate,
        hop_seconds,
        frames: candidates.to_frames(&states, hop_seconds),
    })
}

/// Fraction of the clip's 95th percentile frame RMS above which a frame counts as sung.
const AUTO_LOUD_FRACTION: f32 = 0.15;

/// Quantile of the sung frames' best dip that the automatic threshold lets through.
const AUTO_QUANTILE: f64 = 0.6;

/// Highest threshold the automatic threshold reaches, past which noise starts to read as pitch.
const AUTO_CEILING: f64 = 0.35;

/// The voicing threshold that suits a clip: the depth most of its sung frames dip to.
///
/// Sung frames are those well above the clip's own level floor. Their best dips' quantile
/// becomes the threshold, never below `params.threshold` and never above [`AUTO_CEILING`], so a
/// clean take decodes exactly as with the fixed threshold.
fn clip_threshold(candidates: &F0Candidates, params: &F0Params) -> f64 {
    let rms = candidates.rms();
    let mut levels: Vec<f32> = rms.to_vec();
    levels.sort_by(f32::total_cmp);
    let Some(loud) = levels.get(levels.len() * 95 / 100).copied() else {
        return params.threshold;
    };
    let floor = (loud * AUTO_LOUD_FRACTION).max(params.voiced_rms_floor);
    let mut best: Vec<f64> = (0..candidates.len())
        .filter(|frame| rms[*frame] > floor)
        .map(|frame| {
            candidates.dprime[candidates.range(frame)]
                .iter()
                .copied()
                .fold(1.0, f64::min)
        })
        .collect();
    if best.is_empty() {
        return params.threshold;
    }
    best.sort_by(f64::total_cmp);
    let at = ((best.len() as f64 * AUTO_QUANTILE) as usize).min(best.len() - 1);
    best[at].clamp(params.threshold, AUTO_CEILING.max(params.threshold))
}

fn validate(len: usize, sample_rate: f64, params: &F0Params) -> Result<()> {
    if !sample_rate.is_finite()
        || sample_rate < f64::from(limits::MIN_SAMPLE_RATE)
        || sample_rate > f64::from(limits::MAX_SAMPLE_RATE)
    {
        return Err(AxysError::Invalid(format!(
            "sample rate {sample_rate} outside {}..={}",
            limits::MIN_SAMPLE_RATE,
            limits::MAX_SAMPLE_RATE
        )));
    }
    let duration = len as f64 / sample_rate;
    if duration > limits::MAX_AUDIO_SECONDS {
        return Err(AxysError::Invalid(format!(
            "audio of {duration} s is over the {} s limit",
            limits::MAX_AUDIO_SECONDS
        )));
    }
    let finite = params.min_hz.is_finite()
        && params.max_hz.is_finite()
        && params.frame_seconds.is_finite()
        && params.hop_seconds.is_finite()
        && params.threshold.is_finite()
        && params.voiced_rms_floor.is_finite();
    if !finite {
        return Err(AxysError::Invalid("F0 parameters must be finite".into()));
    }
    if params.min_hz <= 0.0 || params.max_hz <= params.min_hz {
        return Err(AxysError::Invalid(format!(
            "pitch range {}..{} Hz is empty",
            params.min_hz, params.max_hz
        )));
    }
    if params.max_hz >= sample_rate * 0.5 {
        return Err(AxysError::Invalid(format!(
            "max_hz {} is at or above the Nyquist frequency",
            params.max_hz
        )));
    }
    if params.frame_seconds <= 0.0 || params.frame_seconds > 1.0 {
        return Err(AxysError::Invalid(format!(
            "frame_seconds {} outside 0..=1",
            params.frame_seconds
        )));
    }
    if params.hop_seconds <= 0.0 || params.hop_seconds > 1.0 {
        return Err(AxysError::Invalid(format!(
            "hop_seconds {} outside 0..=1",
            params.hop_seconds
        )));
    }
    if !(0.0..=1.0).contains(&params.threshold) {
        return Err(AxysError::Invalid(format!(
            "threshold {} outside 0..=1",
            params.threshold
        )));
    }
    if params.voiced_rms_floor < 0.0 {
        return Err(AxysError::Invalid("voiced_rms_floor is negative".into()));
    }
    Ok(())
}

/// Linear cross-correlation of two short slices through a single complex FFT pair.
struct Correlator {
    forward: Arc<dyn Fft<f64>>,
    inverse: Arc<dyn Fft<f64>>,
    size: usize,
    packed: Vec<Complex<f64>>,
    product: Vec<Complex<f64>>,
}

impl Correlator {
    fn new(size: usize) -> Self {
        let mut planner = FftPlanner::<f64>::new();
        Self {
            forward: planner.plan_fft_forward(size),
            inverse: planner.plan_fft_inverse(size),
            size,
            packed: vec![Complex::new(0.0, 0.0); size],
            product: vec![Complex::new(0.0, 0.0); size],
        }
    }

    /// Writes `sum_j a[j] * b[j + lag]` into `out[lag]` for every lag `out` has room for.
    ///
    /// `a.len() + b.len()` must not exceed the transform size, so no lag wraps around.
    fn correlate(&mut self, a: &[f32], b: &[f32], out: &mut [f64]) {
        let n = self.size;
        for (slot, index) in self.packed.iter_mut().zip(0..n) {
            let re = a.get(index).copied().unwrap_or(0.0) as f64;
            let im = b.get(index).copied().unwrap_or(0.0) as f64;
            *slot = Complex::new(re, im);
        }
        self.forward.process(&mut self.packed);

        // Unpack the two real spectra from one complex transform, then multiply conj(A) by B.
        let scale = 1.0 / n as f64;
        for k in 0..n {
            let zk = self.packed[k];
            let zm = self.packed[(n - k) % n].conj();
            let spec_a = (zk + zm) * 0.5;
            let spec_b = (zk - zm) * Complex::new(0.0, -0.5);
            self.product[k] = spec_a.conj() * spec_b;
        }
        self.inverse.process(&mut self.product);
        for (lag, slot) in out.iter_mut().enumerate() {
            *slot = self.product[lag].re * scale;
        }
    }
}

/// Reusable YIN scratch for one run.
struct Yin {
    sample_rate: f64,
    frame_len: usize,
    /// Length of the comparison segment, `frame_len - max_lag`.
    seg_len: usize,
    min_lag: usize,
    max_lag: usize,
    correlator: Correlator,
    window: Vec<f32>,
    valid: usize,
    cumsq: Vec<f64>,
    corr: Vec<f64>,
    d: Vec<f64>,
    dprime: Vec<f64>,
}

impl Yin {
    fn new(layout: &F0Frames, params: &F0Params) -> Result<Self> {
        let sample_rate = layout.sample_rate;
        let frame_len = layout.frame_len;
        let max_lag = (sample_rate / params.min_hz).ceil() as usize;
        let min_lag = ((sample_rate / params.max_hz).floor() as usize).max(2);
        // Two periods of the lowest frequency must fit, or the range is silently narrowed.
        if max_lag > frame_len / 2 || min_lag + 2 >= max_lag {
            return Err(AxysError::Invalid(format!(
                "frame of {frame_len} samples is too short for {}..{} Hz",
                params.min_hz, params.max_hz
            )));
        }
        let seg_len = frame_len - max_lag;
        let size = (frame_len + seg_len).next_power_of_two();
        Ok(Self {
            sample_rate,
            frame_len,
            seg_len,
            min_lag,
            max_lag,
            correlator: Correlator::new(size),
            window: vec![0.0; frame_len],
            valid: 0,
            cumsq: vec![0.0; frame_len + 1],
            corr: vec![0.0; max_lag + 1],
            d: vec![0.0; max_lag + 1],
            dprime: vec![0.0; max_lag + 1],
        })
    }

    /// Fills the window from `source`, zero-padding past its end.
    fn load_window(&mut self, source: &[f32]) {
        let valid = source.len().min(self.frame_len);
        self.window[..valid].copy_from_slice(&source[..valid]);
        self.window[valid..].fill(0.0);
        self.valid = valid;
    }

    fn window_rms(&self) -> f32 {
        if self.valid == 0 {
            return 0.0;
        }
        let sum: f64 = self.window[..self.valid]
            .iter()
            .map(|s| f64::from(*s) * f64::from(*s))
            .sum();
        (sum / self.valid as f64).sqrt() as f32
    }

    /// Computes the difference function and its cumulative mean normalisation.
    fn difference(&mut self) {
        let seg_len = self.seg_len;
        let max_lag = self.max_lag;

        self.cumsq[0] = 0.0;
        for index in 0..self.frame_len {
            let value = f64::from(self.window[index]);
            self.cumsq[index + 1] = self.cumsq[index] + value * value;
        }
        let energy = self.cumsq[seg_len];

        self.correlator.correlate(
            &self.window[..seg_len],
            &self.window[..self.frame_len],
            &mut self.corr,
        );

        if energy <= 1e-12 {
            self.d[0] = 0.0;
            for slot in self.dprime.iter_mut() {
                *slot = 1.0;
            }
            return;
        }

        self.d[0] = 0.0;
        self.dprime[0] = 1.0;
        let mut running = 0.0;
        for lag in 1..=max_lag {
            let tail = self.cumsq[lag + seg_len] - self.cumsq[lag];
            let value = (energy + tail - 2.0 * self.corr[lag]).max(0.0);
            self.d[lag] = value;
            running += value;
            self.dprime[lag] = if running > 0.0 {
                value * lag as f64 / running
            } else {
                1.0
            };
        }
    }

    /// Pushes the best local minima of the normalised difference into the observation store.
    fn collect_candidates(&self, threshold: f64, out: &mut F0Candidates) {
        let lo = self.min_lag.max(2);
        let hi = self.max_lag.saturating_sub(1);
        if lo > hi {
            return;
        }
        let mut first_below: Option<usize> = None;
        let mut found: Vec<(usize, f64)> = Vec::with_capacity(MAX_CANDIDATES * 2);
        for lag in lo..=hi {
            let here = self.dprime[lag];
            if here < self.dprime[lag - 1] && here <= self.dprime[lag + 1] && here < 1.0 {
                if first_below.is_none() && here < threshold {
                    first_below = Some(lag);
                }
                found.push((lag, here));
            }
        }
        if found.is_empty() {
            return;
        }
        found.sort_by(|a, b| a.1.total_cmp(&b.1));
        found.truncate(MAX_CANDIDATES);
        for (lag, value) in found {
            let refined = self.refine(lag);
            if refined <= 0.0 {
                continue;
            }
            let freq = self.sample_rate / refined;
            // YIN's absolute threshold rule: prefer the lowest lag that clears it, which is
            // what keeps a half-frequency minimum of equal depth from winning.
            let bonus = if first_below == Some(lag) {
                THRESHOLD_BONUS
            } else {
                0.0
            };
            out.push_candidate(freq, value, value - bonus);
        }
    }

    /// Parabolic interpolation of the normalised difference around an integer lag.
    fn refine(&self, lag: usize) -> f64 {
        if lag == 0 || lag + 1 > self.max_lag {
            return lag as f64;
        }
        let prev = self.dprime[lag - 1];
        let here = self.dprime[lag];
        let next = self.dprime[lag + 1];
        let denom = prev - 2.0 * here + next;
        if denom.abs() < 1e-18 {
            return lag as f64;
        }
        let shift = (0.5 * (prev - next) / denom).clamp(-1.0, 1.0);
        lag as f64 + shift
    }
}

/// YIN candidate lags per frame in flat arrays, collected before Viterbi decoding.
#[derive(Debug, Clone, PartialEq)]
pub struct F0Candidates {
    freq: Vec<f64>,
    dprime: Vec<f64>,
    cost: Vec<f64>,
    offsets: Vec<usize>,
    rms: Vec<f32>,
}

impl F0Candidates {
    /// Rebuilds candidates from their flat arrays: `counts` holds the candidates per frame, and
    /// `freq`, `dprime` and `cost` hold every frame's candidates back to back.
    ///
    /// # Errors
    /// Arrays whose lengths disagree, a frame with more candidates than one frame may hold, or a
    /// non-finite or negative value.
    pub fn from_parts(
        freq: Vec<f64>,
        dprime: Vec<f64>,
        cost: Vec<f64>,
        counts: &[u32],
        rms: Vec<f32>,
    ) -> Result<Self> {
        if counts.len() != rms.len() {
            return Err(AxysError::Invalid(format!(
                "{} candidate counts for {} frames",
                counts.len(),
                rms.len()
            )));
        }
        let mut offsets = Vec::with_capacity(counts.len() + 1);
        let mut total = 0usize;
        offsets.push(total);
        for &count in counts {
            let count = count as usize;
            if count > MAX_CANDIDATES {
                return Err(AxysError::Invalid(format!(
                    "a frame holds {count} candidates, over the {MAX_CANDIDATES} limit"
                )));
            }
            total += count;
            offsets.push(total);
        }
        if freq.len() != total || dprime.len() != total || cost.len() != total {
            return Err(AxysError::Invalid(format!(
                "{total} candidates counted, but {} frequencies, {} depths and {} costs",
                freq.len(),
                dprime.len(),
                cost.len()
            )));
        }
        let finite = freq.iter().all(|f| f.is_finite() && *f > 0.0)
            && dprime.iter().chain(&cost).all(|v| v.is_finite())
            && rms.iter().all(|r| r.is_finite() && *r >= 0.0);
        if !finite {
            return Err(AxysError::Invalid(
                "candidates contain a non-finite or negative value".into(),
            ));
        }
        Ok(Self {
            freq,
            dprime,
            cost,
            offsets,
            rms,
        })
    }

    /// Joins the candidates for the frames that follow this span's last.
    pub fn append(&mut self, next: F0Candidates) {
        let base = self.freq.len();
        self.freq.extend(next.freq);
        self.dprime.extend(next.dprime);
        self.cost.extend(next.cost);
        self.offsets
            .extend(next.offsets.iter().skip(1).map(|offset| base + offset));
        self.rms.extend(next.rms);
    }

    /// Candidate frequencies in Hz, every frame's back to back.
    pub fn freq(&self) -> &[f64] {
        &self.freq
    }

    /// Normalised difference at each candidate lag.
    pub fn dprime(&self) -> &[f64] {
        &self.dprime
    }

    /// Observation cost of each candidate.
    pub fn cost(&self) -> &[f64] {
        &self.cost
    }

    /// Candidates per frame.
    pub fn counts(&self) -> Vec<u32> {
        self.offsets
            .windows(2)
            .map(|pair| (pair[1] - pair[0]) as u32)
            .collect()
    }

    /// Window RMS per frame.
    pub fn rms(&self) -> &[f32] {
        &self.rms
    }

    fn with_capacity(frames: usize) -> Self {
        let mut offsets = Vec::with_capacity(frames + 1);
        offsets.push(0);
        Self {
            freq: Vec::with_capacity(frames * 4),
            dprime: Vec::with_capacity(frames * 4),
            cost: Vec::with_capacity(frames * 4),
            offsets,
            rms: Vec::with_capacity(frames),
        }
    }

    fn begin_frame(&mut self, rms: f32) {
        self.rms.push(rms);
    }

    fn push_candidate(&mut self, freq: f64, dprime: f64, cost: f64) {
        self.freq.push(freq);
        self.dprime.push(dprime);
        self.cost.push(cost);
    }

    fn end_frame(&mut self) {
        self.offsets.push(self.freq.len());
    }

    /// Frames held.
    pub fn len(&self) -> usize {
        self.rms.len()
    }

    /// True when no frames are held.
    pub fn is_empty(&self) -> bool {
        self.rms.is_empty()
    }

    fn range(&self, frame: usize) -> std::ops::Range<usize> {
        self.offsets[frame]..self.offsets[frame + 1]
    }

    fn count(&self, frame: usize) -> usize {
        self.range(frame).len()
    }

    /// Builds the output frames from the decoded state per frame.
    fn to_frames(&self, states: &[usize], hop_seconds: f64) -> Vec<PitchFrame> {
        let mut frames = Vec::with_capacity(self.len());
        for index in 0..self.len() {
            let time = index as f64 * hop_seconds;
            let rms = self.rms[index];
            let range = self.range(index);
            let state = states.get(index).copied().unwrap_or(range.len());
            if state < range.len() {
                let slot = range.start + state;
                let f0 = self.freq[slot];
                let confidence = (1.0 - self.dprime[slot]).clamp(0.0, 1.0) as f32;
                frames.push(PitchFrame {
                    time,
                    f0,
                    midi: 69.0 + 12.0 * (f0 / 440.0).log2(),
                    confidence,
                    rms,
                    voiced: true,
                });
            } else {
                frames.push(PitchFrame {
                    time,
                    f0: 0.0,
                    midi: f64::NAN,
                    confidence: 0.0,
                    rms,
                    voiced: false,
                });
            }
        }
        frames
    }
}

/// Viterbi decoding over the candidate lags, with one extra unvoiced state per frame.
///
/// Returns the chosen state index per frame; an index equal to the frame's candidate count
/// means the unvoiced state.
fn decode(obs: &F0Candidates, threshold: f64) -> Vec<usize> {
    let frames = obs.len();
    let mut chosen = vec![0usize; frames];
    if frames == 0 {
        return chosen;
    }
    let unvoiced_cost = (threshold * UNVOICED_COST_SCALE).max(1e-3);

    let mut back = vec![0u8; frames * MAX_STATES];
    let mut prev = [f64::INFINITY; MAX_STATES];
    let mut cur = [f64::INFINITY; MAX_STATES];
    let mut prev_freq = [0.0f64; MAX_STATES];
    let mut cur_freq = [0.0f64; MAX_STATES];
    let mut prev_count = 0usize;

    for frame in 0..frames {
        let range = obs.range(frame);
        let count = range.len();
        for (slot, source) in cur_freq.iter_mut().zip(range.clone()) {
            *slot = obs.freq[source];
        }
        for state in 0..=count {
            let observation = if state < count {
                obs.cost[range.start + state]
            } else {
                unvoiced_cost
            };
            if frame == 0 {
                cur[state] = observation;
                back[state] = 0;
                continue;
            }
            let mut best = f64::INFINITY;
            let mut best_from = 0usize;
            for from in 0..=prev_count {
                let base = prev[from];
                if !base.is_finite() {
                    continue;
                }
                let transition = match (from < prev_count, state < count) {
                    (true, true) => {
                        let semitones = 12.0 * (cur_freq[state] / prev_freq[from]).log2();
                        PITCH_TRANSITION_COST * semitones.abs()
                    }
                    (false, false) => 0.0,
                    _ => VOICING_SWITCH_COST,
                };
                let total = base + transition;
                if total < best {
                    best = total;
                    best_from = from;
                }
            }
            cur[state] = best + observation;
            back[frame * MAX_STATES + state] = best_from as u8;
        }
        cur[count + 1..].fill(f64::INFINITY);
        prev.copy_from_slice(&cur);
        prev_freq = cur_freq;
        prev_count = count;
    }

    let last = frames - 1;
    let mut state = (0..=obs.count(last))
        .filter(|s| prev[*s].is_finite())
        .min_by(|a, b| prev[*a].total_cmp(&prev[*b]))
        .unwrap_or(obs.count(last));
    chosen[last] = state;
    for frame in (1..frames).rev() {
        state = usize::from(back[frame * MAX_STATES + state]);
        chosen[frame - 1] = state;
    }
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 48_000.0;

    /// Collects `audio` in `pieces` spans, each reading only its own samples, and decodes the join.
    fn detect_in_pieces(audio: &[f32], params: &F0Params, pieces: usize) -> PitchTrack {
        let layout = F0Frames::new(audio.len(), SR, params).unwrap();
        let count = layout.count();
        let mut joined = F0Candidates::with_capacity(count);
        for piece in 0..pieces {
            let frames = count * piece / pieces..count * (piece + 1) / pieces;
            let span = layout.samples_for(frames.clone());
            let part =
                observe_f0(&layout, params, &audio[span.clone()], span.start, frames).unwrap();
            joined.append(part);
        }
        decode_f0(&layout, params, &joined).unwrap()
    }

    #[test]
    fn spans_collected_apart_decode_as_one_run() {
        let params = F0Params::default();
        let long = swept(1.3, 0.5, |t| 180.0 + 90.0 * t);
        let short = sine(220.0, 0.03, 0.5);
        for audio in [&long, &short] {
            let whole = serde_json::to_string(&detect_f0(audio, SR, &params).unwrap()).unwrap();
            for pieces in [1, 2, 3, 7] {
                let split =
                    serde_json::to_string(&detect_in_pieces(audio, &params, pieces)).unwrap();
                assert_eq!(split, whole, "{pieces} pieces of {} samples", audio.len());
            }
        }
    }

    #[test]
    fn a_window_short_of_its_frames_is_rejected() {
        let params = F0Params::default();
        let audio = sine(220.0, 0.5, 0.5);
        let layout = F0Frames::new(audio.len(), SR, &params).unwrap();
        let span = layout.samples_for(10..20);
        let short = &audio[span.start + 1..span.end];
        assert!(observe_f0(&layout, &params, short, span.start + 1, 10..20).is_err());
    }

    #[test]
    fn candidates_survive_their_flat_arrays() {
        let params = F0Params::default();
        let audio = sine(220.0, 0.2, 0.5);
        let layout = F0Frames::new(audio.len(), SR, &params).unwrap();
        let candidates = observe_f0(&layout, &params, &audio, 0, 0..layout.count()).unwrap();
        let rebuilt = F0Candidates::from_parts(
            candidates.freq().to_vec(),
            candidates.dprime().to_vec(),
            candidates.cost().to_vec(),
            &candidates.counts(),
            candidates.rms().to_vec(),
        )
        .unwrap();
        assert_eq!(rebuilt, candidates);
        assert!(F0Candidates::from_parts(vec![220.0], vec![], vec![], &[1], vec![0.1]).is_err());
    }

    /// Fraction of frames a track marks voiced.
    fn voiced_share(track: &PitchTrack) -> f64 {
        let voiced = track.frames.iter().filter(|frame| frame.voiced).count();
        voiced as f64 / track.frames.len().max(1) as f64
    }

    #[test]
    fn the_automatic_threshold_leaves_a_clean_tone_alone() {
        let audio = sine(220.0, 1.0, 0.5);
        let fixed = F0Params {
            auto_threshold: false,
            ..F0Params::default()
        };
        let clean = detect_f0(&audio, SR, &fixed).unwrap();
        let auto = detect_f0(&audio, SR, &F0Params::default()).unwrap();
        assert_eq!(clean.frames, auto.frames);
    }

    #[test]
    fn the_automatic_threshold_voices_a_noisy_tone() {
        // A tone under enough noise that its dips sit above the fixed threshold.
        let mut state = 0x2545_f491_u32;
        let audio: Vec<f32> = sine(220.0, 1.0, 0.5)
            .into_iter()
            .map(|sample| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                sample + (state as f32 / u32::MAX as f32 - 0.5) * 0.9
            })
            .collect();
        let fixed = F0Params {
            auto_threshold: false,
            ..F0Params::default()
        };
        let before = voiced_share(&detect_f0(&audio, SR, &fixed).unwrap());
        let after = voiced_share(&detect_f0(&audio, SR, &F0Params::default()).unwrap());
        assert!(
            after > before + 0.2,
            "voiced {before:.2} fixed, {after:.2} automatic"
        );
    }

    fn sine(freq: f64, seconds: f64, amp: f32) -> Vec<f32> {
        let n = (seconds * SR) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / SR;
                (amp as f64 * (std::f64::consts::TAU * freq * t).sin()) as f32
            })
            .collect()
    }

    /// Sine whose instantaneous frequency comes from `freq_at`, integrated for phase continuity.
    fn swept(seconds: f64, amp: f32, freq_at: impl Fn(f64) -> f64) -> Vec<f32> {
        let n = (seconds * SR) as usize;
        let mut phase = 0.0f64;
        let mut out = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f64 / SR;
            out.push((amp as f64 * phase.sin()) as f32);
            phase += std::f64::consts::TAU * freq_at(t) / SR;
        }
        out
    }

    /// Frames away from the buffer edges, where the window holds only the intended signal.
    fn interior(track: &PitchTrack, guard: f64) -> Vec<&PitchFrame> {
        let end = track.duration() - guard;
        track
            .frames
            .iter()
            .filter(|f| f.time >= guard && f.time <= end)
            .collect()
    }

    fn cents(a: f64, b: f64) -> f64 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn correlator_matches_the_direct_sum() {
        let a: Vec<f32> = (0..61)
            .map(|i| ((i * 37 % 19) as f32 - 9.0) / 9.0)
            .collect();
        let b: Vec<f32> = (0..97)
            .map(|i| ((i * 53 % 23) as f32 - 11.0) / 11.0)
            .collect();
        let mut correlator = Correlator::new((a.len() + b.len()).next_power_of_two());
        let mut out = vec![0.0; 36];
        correlator.correlate(&a, &b, &mut out);
        for (lag, value) in out.iter().enumerate() {
            let direct: f64 = a
                .iter()
                .enumerate()
                .map(|(j, x)| f64::from(*x) * f64::from(b[j + lag]))
                .sum();
            assert!(
                (direct - value).abs() < 1e-9,
                "lag {lag}: {direct} vs {value}"
            );
        }
    }

    #[test]
    fn steady_sine_is_detected_within_five_cents() {
        let samples = sine(220.0, 1.0, 0.5);
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let frames = interior(&track, 0.05);
        assert!(!frames.is_empty());
        for frame in frames {
            assert!(frame.voiced, "frame at {} went unvoiced", frame.time);
            assert!(
                cents(frame.f0, 220.0).abs() < 5.0,
                "frame at {} read {} Hz",
                frame.time,
                frame.f0
            );
            assert!(frame.confidence > 0.8);
        }
    }

    #[test]
    fn low_and_high_sines_land_on_the_right_note() {
        for hz in [82.41, 440.0, 880.0] {
            let samples = sine(hz, 0.8, 0.4);
            let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
            let median = track.median_midi(0.1, 0.7).expect("voiced frames");
            let expect = 69.0 + 12.0 * (hz / 440.0).log2();
            assert!((median - expect).abs() < 0.06, "{hz} Hz gave MIDI {median}");
        }
    }

    #[test]
    fn glissando_is_tracked_monotonically() {
        let samples = swept(1.5, 0.5, |t| 200.0 + (400.0 - 200.0) * (t / 1.5));
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let frames = interior(&track, 0.06);
        assert!(frames.len() > 200);
        let mut previous = frames[0].midi;
        for frame in &frames {
            assert!(frame.voiced);
            assert!(
                frame.midi >= previous - 0.05,
                "fell from {previous} to {} at {}",
                frame.midi,
                frame.time
            );
            previous = previous.max(frame.midi);
        }
        let first = frames[0];
        let last = frames[frames.len() - 1];
        assert!(cents(first.f0, 200.0 + 200.0 * (first.time / 1.5)).abs() < 40.0);
        assert!(cents(last.f0, 200.0 + 200.0 * (last.time / 1.5)).abs() < 40.0);
    }

    #[test]
    fn silence_is_unvoiced() {
        let samples = vec![0.0f32; 24_000];
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        assert!(!track.frames.is_empty());
        assert!(track.frames.iter().all(|f| !f.voiced));
        assert!(track.frames.iter().all(|f| f.f0 == 0.0));
        assert!(track.frames.iter().all(|f| f.midi.is_nan()));
        assert!(track.voiced_spans().is_empty());
    }

    #[test]
    fn a_quiet_passage_is_unvoiced() {
        let mut samples = sine(220.0, 0.4, 0.5);
        samples.extend(sine(220.0, 0.4, 0.0002));
        samples.extend(sine(220.0, 0.4, 0.5));
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let quiet: Vec<_> = track
            .frames
            .iter()
            .filter(|f| f.time > 0.48 && f.time < 0.72)
            .collect();
        assert!(!quiet.is_empty());
        assert!(
            quiet.iter().all(|f| !f.voiced),
            "quiet frames stayed voiced"
        );
        assert!(track.midi_at(0.6).is_none());
        assert!(track.hz_at(0.6).is_none());
        let loud = track.median_midi(0.1, 0.35).expect("voiced");
        assert!((loud - 57.0).abs() < 0.1);
    }

    #[test]
    fn octave_change_does_not_leak_inside_either_half() {
        let mut samples = sine(220.0, 0.9, 0.5);
        samples.extend(sine(440.0, 0.9, 0.5));
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        for frame in interior(&track, 0.06) {
            if frame.time < 0.84 {
                assert!(
                    cents(frame.f0, 220.0).abs() < 60.0,
                    "first half read {} Hz at {}",
                    frame.f0,
                    frame.time
                );
            } else if frame.time > 0.96 {
                assert!(
                    cents(frame.f0, 440.0).abs() < 60.0,
                    "second half read {} Hz at {}",
                    frame.f0,
                    frame.time
                );
            }
        }
    }

    #[test]
    fn vibrato_depth_is_tracked() {
        let depth = 0.5; // semitones either side of centre
        let rate = 5.0;
        let samples = swept(1.6, 0.5, |t| {
            let semis = depth * (std::f64::consts::TAU * rate * t).sin();
            220.0 * (semis / 12.0).exp2()
        });
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let frames = interior(&track, 0.1);
        assert!(frames.iter().all(|f| f.voiced));
        let lo = frames.iter().map(|f| f.midi).fold(f64::MAX, f64::min);
        let hi = frames.iter().map(|f| f.midi).fold(f64::MIN, f64::max);
        let measured = hi - lo;
        assert!(
            (measured - 2.0 * depth).abs() < 0.25,
            "vibrato depth measured {measured} semitones"
        );
        let centre = track.median_midi(0.1, 1.5).expect("voiced");
        assert!((centre - 57.0).abs() < 0.15, "centre drifted to {centre}");
    }

    #[test]
    fn noise_is_not_reported_as_stable_pitch() {
        let mut state = 0x2545_f491_4f6c_dd1du64;
        let samples: Vec<f32> = (0..48_000)
            .map(|_| {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                ((state >> 40) as f32 / 8388608.0 - 1.0) * 0.4
            })
            .collect();
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let voiced = track.frames.iter().filter(|f| f.voiced).count();
        assert!(
            voiced * 4 < track.frames.len(),
            "{voiced} of {} noise frames were called voiced",
            track.frames.len()
        );
    }

    #[test]
    fn empty_input_yields_an_empty_track() {
        let track = detect_f0(&[], SR, &F0Params::default()).expect("analysis");
        assert!(track.frames.is_empty());
        assert_eq!(track.duration(), 0.0);
        assert_eq!(track.frame_index_at(0.0), None);
        assert_eq!(track.midi_at(0.0), None);
        assert_eq!(track.median_midi(0.0, 1.0), None);
        assert!(track.to_arrays().times.is_empty());
    }

    #[test]
    fn very_short_input_is_handled() {
        let samples = sine(220.0, 0.004, 0.5);
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        assert!(!track.frames.is_empty());
    }

    #[test]
    fn invalid_sample_rate_is_rejected() {
        let samples = sine(220.0, 0.2, 0.5);
        for rate in [0.0, -48_000.0, 100.0, 1_000_000.0, f64::NAN] {
            assert!(matches!(
                detect_f0(&samples, rate, &F0Params::default()),
                Err(AxysError::Invalid(_))
            ));
        }
    }

    #[test]
    fn non_finite_samples_are_rejected() {
        let mut samples = sine(220.0, 0.2, 0.5);
        samples[1000] = f32::NAN;
        assert!(detect_f0(&samples, SR, &F0Params::default()).is_err());
        samples[1000] = f32::INFINITY;
        assert!(detect_f0(&samples, SR, &F0Params::default()).is_err());
    }

    #[test]
    fn malformed_parameters_are_rejected() {
        let samples = sine(220.0, 0.2, 0.5);
        let bad = [
            F0Params {
                min_hz: 0.0,
                ..Default::default()
            },
            F0Params {
                min_hz: 900.0,
                max_hz: 100.0,
                ..Default::default()
            },
            F0Params {
                max_hz: 30_000.0,
                ..Default::default()
            },
            F0Params {
                frame_seconds: 0.0,
                ..Default::default()
            },
            F0Params {
                frame_seconds: f64::NAN,
                ..Default::default()
            },
            F0Params {
                hop_seconds: -1.0,
                ..Default::default()
            },
            F0Params {
                threshold: 4.0,
                ..Default::default()
            },
            F0Params {
                voiced_rms_floor: -1.0,
                ..Default::default()
            },
            // A window shorter than one period of min_hz cannot resolve the range.
            F0Params {
                frame_seconds: 0.004,
                ..Default::default()
            },
        ];
        for params in bad {
            assert!(
                detect_f0(&samples, SR, &params).is_err(),
                "accepted {params:?}"
            );
        }
    }

    fn track_of(voiced: &[bool]) -> PitchTrack {
        PitchTrack {
            sample_rate: SR,
            hop_seconds: 0.01,
            frames: voiced
                .iter()
                .enumerate()
                .map(|(i, v)| PitchFrame {
                    time: i as f64 * 0.01,
                    f0: if *v { 100.0 + i as f64 } else { 0.0 },
                    midi: if *v { 60.0 + i as f64 } else { f64::NAN },
                    confidence: if *v { 0.9 } else { 0.0 },
                    rms: 0.1,
                    voiced: *v,
                })
                .collect(),
        }
    }

    #[test]
    fn accessors_respect_voicing_and_bounds() {
        let track = track_of(&[true, true, false, false, true, true]);
        assert!((track.duration() - 0.06).abs() < 1e-12);
        assert_eq!(track.frame_index_at(-1.0), Some(0));
        assert_eq!(track.frame_index_at(0.0), Some(0));
        assert_eq!(track.frame_index_at(0.014), Some(1));
        assert_eq!(track.frame_index_at(0.016), Some(2));
        assert_eq!(track.frame_index_at(99.0), Some(5));
        assert_eq!(track.frame_index_at(f64::NAN), None);

        assert_eq!(track.midi_at(0.005), Some(60.5));
        assert_eq!(track.hz_at(0.005), Some(100.5));
        assert_eq!(track.midi_at(0.015), None, "inside an unvoiced span");
        assert_eq!(track.hz_at(0.025), None);
        assert_eq!(track.midi_at(0.02), None, "on an unvoiced frame");
        assert_eq!(track.midi_at(0.045), Some(64.5));
        assert_eq!(track.midi_at(-0.001), None, "before the track");
        assert_eq!(track.midi_at(0.061), None, "after the track");
        assert_eq!(track.midi_at(0.05), Some(65.0), "last frame exactly");
    }

    #[test]
    fn median_ignores_unvoiced_frames() {
        let track = track_of(&[true, false, true, false, true]);
        // Voiced MIDI values are 60, 62 and 64.
        assert_eq!(track.median_midi(0.0, 0.05), Some(62.0));
        assert_eq!(track.median_midi(0.0, 0.025), Some(61.0));
        assert_eq!(track.median_midi(0.01, 0.01), None);
        assert_eq!(track.median_midi(1.0, 2.0), None);
        assert_eq!(track.median_midi(0.05, 0.0), None);
        assert_eq!(track.median_midi(f64::NAN, 1.0), None);
    }

    #[test]
    fn voiced_spans_merge_adjacent_frames() {
        let track = track_of(&[false, true, true, true, false, true, false]);
        let spans = track.voiced_spans();
        assert_eq!(spans.len(), 2);
        assert!((spans[0].0 - 0.01).abs() < 1e-12);
        assert!((spans[0].1 - 0.04).abs() < 1e-12);
        assert!((spans[1].0 - 0.05).abs() < 1e-12);
        assert!((spans[1].1 - 0.06).abs() < 1e-12);

        let all = track_of(&[true, true]);
        assert_eq!(all.voiced_spans().len(), 1);
    }

    #[test]
    fn the_last_voiced_frame_of_a_span_still_reads() {
        // Frame 3 is the last voiced frame before an unvoiced one. Querying exactly on it
        // weights the unvoiced neighbour at zero, so it must resolve rather than report a
        // gap; the unvoiced frame after it must still report one.
        let track = track_of(&[false, true, true, true, false, true, false]);
        let hop = track.hop_seconds;

        let last_voiced = track.frames[3].time;
        assert!(
            track.midi_at(last_voiced).is_some(),
            "the last voiced frame of a span must resolve"
        );
        assert!(track.hz_at(last_voiced).is_some());

        let first_voiced = track.frames[1].time;
        assert!(
            track.midi_at(first_voiced).is_some(),
            "the first voiced frame of a span must resolve"
        );

        assert!(
            track.midi_at(track.frames[4].time).is_none(),
            "an unvoiced frame must report a gap"
        );
        assert!(
            track.midi_at(last_voiced + hop * 0.5).is_none(),
            "a query between a voiced and an unvoiced frame must report a gap"
        );
    }

    #[test]
    fn arrays_mark_unvoiced_frames_with_nan() {
        let track = track_of(&[true, false, true]);
        let arrays = track.to_arrays();
        assert_eq!(arrays.times.len(), 3);
        assert!(arrays.midi[0].is_finite());
        assert!(arrays.midi[1].is_nan());
        assert!(arrays.midi[2].is_finite());
        assert_eq!(arrays.confidence[1], 0.0);
        assert_eq!(arrays.rms.len(), 3);
    }

    #[test]
    fn track_round_trips_through_json() {
        let track = track_of(&[true, false, true]);
        let json = serde_json::to_string(&track).expect("serialise");
        assert!(json.contains("hopSeconds"));
        assert!(json.contains("null"), "unvoiced MIDI must survive as null");
        let back: PitchTrack = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(back.frames.len(), 3);
        assert_eq!(back.frames[0], track.frames[0]);
        assert!(back.frames[1].midi.is_nan());
        assert!(!back.frames[1].voiced);

        let arrays = track.to_arrays();
        let json = serde_json::to_string(&arrays).expect("serialise");
        let back: PitchTrackArrays = serde_json::from_str(&json).expect("deserialise");
        assert!(back.midi[1].is_nan());
        assert_eq!(back.midi[0], arrays.midi[0]);
    }

    #[test]
    fn a_missing_midi_field_deserialises_as_unvoiced() {
        let json = r#"{"time":0.0,"f0":0.0,"midi":null,"confidence":0.0,"rms":0.0,"voiced":false}"#;
        let frame: PitchFrame = serde_json::from_str(json).expect("deserialise");
        assert!(frame.midi.is_nan());
    }

    #[test]
    fn params_round_trip_through_json() {
        let params = F0Params::default();
        let json = serde_json::to_string(&params).expect("serialise");
        assert!(json.contains("voicedRmsFloor"));
        let back: F0Params = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(back, params);
    }

    #[test]
    fn frames_sit_on_the_realised_hop() {
        let samples = sine(220.0, 0.5, 0.5);
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        assert!((track.hop_seconds - 0.005).abs() < 1e-12);
        for (index, frame) in track.frames.iter().enumerate() {
            assert!((frame.time - index as f64 * track.hop_seconds).abs() < 1e-12);
        }
    }

    #[test]
    fn a_dc_offset_does_not_produce_pitch() {
        let samples = vec![0.6f32; 48_000];
        let track = detect_f0(&samples, SR, &F0Params::default()).expect("analysis");
        let voiced = track.frames.iter().filter(|f| f.voiced).count();
        assert_eq!(voiced, 0, "constant signal reported as pitched");
    }
}
