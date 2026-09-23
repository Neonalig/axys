// SPDX-License-Identifier: AGPL-3.0-or-later

//! RIFF WAVE decoding and encoding.
//!
//! Imported audio is untrusted: every chunk length, channel count, sample rate and
//! duration is checked against [`crate::limits`] before anything is allocated, and no
//! input can make the parser panic. Decoding accepts PCM at 8, 16, 24 and 32 bits and
//! IEEE float at 32 and 64 bits, in plain or `WAVE_FORMAT_EXTENSIBLE` files. Encoding
//! writes 16- or 24-bit PCM, or 32-bit float.

use serde::{Deserialize, Serialize};

use crate::{limits, AxysError, Result};

/// Highest accepted channel count in an imported or exported file.
pub const MAX_CHANNELS: u16 = 64;

/// Bit depth of an exported WAV file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BitDepth {
    /// Signed 16-bit integer PCM.
    Pcm16,
    /// Signed 24-bit integer PCM.
    Pcm24,
    /// 32-bit IEEE float.
    Float32,
}

/// Decoded PCM audio with its source facts.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    /// Sample rate in Hz.
    pub sample_rate: u32,
    /// Channel count, equal to `data.len()`.
    pub channels: u16,
    /// Deinterleaved channels.
    pub data: Vec<Vec<f32>>,
}

impl DecodedAudio {
    /// Frame count, the length of the shortest channel.
    pub fn frames(&self) -> usize {
        self.data.iter().map(Vec::len).min().unwrap_or(0)
    }

    /// Length in seconds.
    pub fn duration(&self) -> f64 {
        if self.sample_rate == 0 {
            return 0.0;
        }
        self.frames() as f64 / f64::from(self.sample_rate)
    }

    /// Channel average as a single mono buffer.
    pub fn to_mono(&self) -> Vec<f32> {
        let frames = self.frames();
        let channels = self.data.len();
        if frames == 0 || channels == 0 {
            return Vec::new();
        }
        if channels == 1 {
            return self.data[0][..frames].to_vec();
        }
        let scale = 1.0 / channels as f32;
        let mut out = vec![0.0f32; frames];
        for channel in &self.data {
            for (o, s) in out.iter_mut().zip(channel.iter()) {
                *o += *s;
            }
        }
        for o in &mut out {
            *o *= scale;
        }
        out
    }
}

/// What an export produced.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    /// Frames written per channel.
    pub frames: usize,
    /// Largest input magnitude seen, before clamping.
    pub peak: f32,
    /// Samples that exceeded the representable range and were clamped.
    pub clipped_samples: usize,
}

const FORMAT_PCM: u16 = 1;
const FORMAT_FLOAT: u16 = 3;
const FORMAT_EXTENSIBLE: u16 = 0xFFFE;

/// Trailing 14 bytes shared by every `KSDATAFORMAT_SUBTYPE_*` GUID.
const SUBFORMAT_TAIL: [u8; 14] = [
    0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71, 0x00, 0x00,
];

fn invalid(message: &str) -> AxysError {
    AxysError::Invalid(message.to_string())
}

fn unsupported(message: String) -> AxysError {
    AxysError::Unsupported(message)
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    bytes
        .get(offset..offset.checked_add(2)?)
        .and_then(|b| <[u8; 2]>::try_from(b).ok())
        .map(u16::from_le_bytes)
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    bytes
        .get(offset..offset.checked_add(4)?)
        .and_then(|b| <[u8; 4]>::try_from(b).ok())
        .map(u32::from_le_bytes)
}

fn sample_u8(bytes: &[u8]) -> f32 {
    match bytes.first() {
        Some(&v) => (f32::from(v) - 128.0) / 128.0,
        None => 0.0,
    }
}

fn sample_i16(bytes: &[u8]) -> f32 {
    match <[u8; 2]>::try_from(bytes) {
        Ok(b) => f32::from(i16::from_le_bytes(b)) / 32_768.0,
        Err(_) => 0.0,
    }
}

fn sample_i24(bytes: &[u8]) -> f32 {
    if bytes.len() < 3 {
        return 0.0;
    }
    let raw = i32::from(bytes[0]) | (i32::from(bytes[1]) << 8) | (i32::from(bytes[2] as i8) << 16);
    raw as f32 / 8_388_608.0
}

fn sample_i32(bytes: &[u8]) -> f32 {
    match <[u8; 4]>::try_from(bytes) {
        Ok(b) => i32::from_le_bytes(b) as f32 / 2_147_483_648.0,
        Err(_) => 0.0,
    }
}

fn sample_f32(bytes: &[u8]) -> f32 {
    match <[u8; 4]>::try_from(bytes) {
        Ok(b) => {
            let v = f32::from_le_bytes(b);
            if v.is_finite() {
                v
            } else {
                0.0
            }
        }
        Err(_) => 0.0,
    }
}

fn sample_f64(bytes: &[u8]) -> f32 {
    match <[u8; 8]>::try_from(bytes) {
        Ok(b) => {
            let v = f64::from_le_bytes(b);
            if v.is_finite() {
                v as f32
            } else {
                0.0
            }
        }
        Err(_) => 0.0,
    }
}

/// Byte width of one sample and the conversion from those bytes to a normalised float.
type SampleDecoder = (usize, fn(&[u8]) -> f32);

/// Fields of a parsed `fmt ` chunk, with an extensible subformat already resolved.
struct Format {
    codec: u16,
    channels: u16,
    sample_rate: u32,
    bits: u16,
}

fn parse_format(body: &[u8]) -> Result<Format> {
    if body.len() < 16 {
        return Err(invalid("fmt chunk shorter than 16 bytes"));
    }
    let mut codec = read_u16(body, 0).ok_or_else(|| invalid("fmt chunk truncated"))?;
    let channels = read_u16(body, 2).ok_or_else(|| invalid("fmt chunk truncated"))?;
    let sample_rate = read_u32(body, 4).ok_or_else(|| invalid("fmt chunk truncated"))?;
    let bits = read_u16(body, 14).ok_or_else(|| invalid("fmt chunk truncated"))?;

    if codec == FORMAT_EXTENSIBLE {
        let extension_len =
            read_u16(body, 16).ok_or_else(|| invalid("extensible fmt truncated"))?;
        if extension_len < 22 {
            return Err(invalid("extensible fmt extension shorter than 22 bytes"));
        }
        let guid = body
            .get(24..40)
            .ok_or_else(|| invalid("extensible fmt subformat truncated"))?;
        let tail = guid
            .get(2..16)
            .ok_or_else(|| invalid("subformat truncated"))?;
        if tail != SUBFORMAT_TAIL {
            return Err(unsupported(
                "WAVE subformat GUID is not a PCM family GUID".to_string(),
            ));
        }
        codec = read_u16(guid, 0).ok_or_else(|| invalid("subformat truncated"))?;
    }

    Ok(Format {
        codec,
        channels,
        sample_rate,
        bits,
    })
}

fn decoder_for(format: &Format) -> Result<SampleDecoder> {
    match (format.codec, format.bits) {
        (FORMAT_PCM, 8) => Ok((1, sample_u8 as fn(&[u8]) -> f32)),
        (FORMAT_PCM, 16) => Ok((2, sample_i16 as fn(&[u8]) -> f32)),
        (FORMAT_PCM, 24) => Ok((3, sample_i24 as fn(&[u8]) -> f32)),
        (FORMAT_PCM, 32) => Ok((4, sample_i32 as fn(&[u8]) -> f32)),
        (FORMAT_FLOAT, 32) => Ok((4, sample_f32 as fn(&[u8]) -> f32)),
        (FORMAT_FLOAT, 64) => Ok((8, sample_f64 as fn(&[u8]) -> f32)),
        (FORMAT_PCM, bits) | (FORMAT_FLOAT, bits) => Err(unsupported(format!(
            "WAVE bit depth {bits} is not supported"
        ))),
        (codec, _) => Err(unsupported(format!("WAVE codec {codec} is not supported"))),
    }
}

/// Parses a RIFF WAVE file of PCM or IEEE float samples.
///
/// Rejects sizes, rates and channel counts outside `crate::limits`, truncated chunks and
/// unsupported codecs, without panicking on any input.
pub fn decode_wav(bytes: &[u8]) -> Result<DecodedAudio> {
    if bytes.len() < 12 {
        return Err(invalid("file shorter than a RIFF header"));
    }
    if &bytes[0..4] != b"RIFF" {
        if &bytes[0..4] == b"RF64" {
            return Err(unsupported("RF64 files are not supported".to_string()));
        }
        return Err(invalid("missing RIFF signature"));
    }
    if &bytes[8..12] != b"WAVE" {
        return Err(invalid("RIFF container is not WAVE"));
    }

    // The declared RIFF size is advisory: trailing garbage is tolerated, a short file is not.
    let declared = read_u32(bytes, 4).unwrap_or(0) as usize;
    let available = bytes.len() - 8;
    if declared > available {
        return Err(invalid("RIFF size exceeds the file"));
    }

    let mut format: Option<Format> = None;
    let mut data: Option<&[u8]> = None;
    let mut position = 12usize;

    while position + 8 <= bytes.len() {
        let id = &bytes[position..position + 4];
        let size = read_u32(bytes, position + 4).unwrap_or(0) as usize;
        let body_start = position + 8;
        let body_end = body_start
            .checked_add(size)
            .ok_or_else(|| invalid("chunk size overflows"))?;
        if body_end > bytes.len() {
            return Err(invalid("chunk size exceeds the file"));
        }
        let body = &bytes[body_start..body_end];

        if id == b"fmt " {
            if format.is_none() {
                format = Some(parse_format(body)?);
            }
        } else if id == b"data" && data.is_none() {
            data = Some(body);
        }

        position = body_end
            .checked_add(size & 1)
            .ok_or_else(|| invalid("chunk padding overflows"))?;
    }

    let format = format.ok_or_else(|| invalid("no fmt chunk"))?;
    let data = data.ok_or_else(|| invalid("no data chunk"))?;

    if format.channels == 0 {
        return Err(invalid("channel count is zero"));
    }
    if format.channels > MAX_CHANNELS {
        return Err(invalid("channel count exceeds the supported maximum"));
    }
    if !(limits::MIN_SAMPLE_RATE..=limits::MAX_SAMPLE_RATE).contains(&format.sample_rate) {
        return Err(invalid("sample rate outside the supported range"));
    }

    let (bytes_per_sample, convert) = decoder_for(&format)?;
    let channels = usize::from(format.channels);
    let frame_bytes = bytes_per_sample * channels;
    let frames = data.len() / frame_bytes;

    if frames as f64 / f64::from(format.sample_rate) > limits::MAX_AUDIO_SECONDS {
        return Err(invalid("audio longer than the supported maximum"));
    }

    let mut planes = vec![vec![0.0f32; frames]; channels];
    for frame in 0..frames {
        let base = frame * frame_bytes;
        for (channel, plane) in planes.iter_mut().enumerate() {
            let offset = base + channel * bytes_per_sample;
            let value = data
                .get(offset..offset + bytes_per_sample)
                .map_or(0.0, convert);
            plane[frame] = value;
        }
    }

    Ok(DecodedAudio {
        sample_rate: format.sample_rate,
        channels: format.channels,
        data: planes,
    })
}

/// Clamps `value` into -1.0..=1.0, mapping non-finite input to a finite substitute.
///
/// Returns the clamped value and whether the input was out of range.
fn clamp_sample(value: f32) -> (f32, bool) {
    if value.is_nan() {
        return (0.0, true);
    }
    if value > 1.0 {
        return (1.0, true);
    }
    if value < -1.0 {
        return (-1.0, true);
    }
    (value, false)
}

fn push_chunk_header(out: &mut Vec<u8>, id: &[u8; 4], size: u32) {
    out.extend_from_slice(id);
    out.extend_from_slice(&size.to_le_bytes());
}

/// Writes mono or interleaved PCM as a RIFF WAVE file.
///
/// Samples are clamped to the representable range, and `peak` in the returned report says
/// whether clipping was reached so the caller can warn before saving.
pub fn encode_wav(
    channels: &[Vec<f32>],
    sample_rate: u32,
    depth: BitDepth,
) -> Result<(Vec<u8>, ExportReport)> {
    if channels.is_empty() {
        return Err(invalid("no channels to encode"));
    }
    if channels.len() > usize::from(MAX_CHANNELS) {
        return Err(invalid("channel count exceeds the supported maximum"));
    }
    let frames = channels[0].len();
    if channels.iter().any(|c| c.len() != frames) {
        return Err(invalid("channels have unequal lengths"));
    }
    if !(limits::MIN_SAMPLE_RATE..=limits::MAX_SAMPLE_RATE).contains(&sample_rate) {
        return Err(invalid("sample rate outside the supported range"));
    }
    if frames as f64 / f64::from(sample_rate) > limits::MAX_AUDIO_SECONDS {
        return Err(invalid("audio longer than the supported maximum"));
    }

    let channel_count = channels.len();
    let bytes_per_sample: usize = match depth {
        BitDepth::Pcm16 => 2,
        BitDepth::Pcm24 => 3,
        BitDepth::Float32 => 4,
    };
    let data_size = frames
        .checked_mul(channel_count)
        .and_then(|s| s.checked_mul(bytes_per_sample))
        .ok_or_else(|| invalid("exported data size overflows"))?;
    let pad = data_size & 1;
    let float = matches!(depth, BitDepth::Float32);
    let fmt_size: usize = if float { 18 } else { 16 };
    let fact_size: usize = if float { 12 } else { 0 };
    let riff_size = 4 + (8 + fmt_size) + fact_size + (8 + data_size + pad);
    if riff_size > u32::MAX as usize {
        return Err(invalid("exported file is over the 4 GiB WAV limit"));
    }

    let mut out = Vec::with_capacity(riff_size + 8);
    push_chunk_header(&mut out, b"RIFF", riff_size as u32);
    out.extend_from_slice(b"WAVE");

    let bits = (bytes_per_sample * 8) as u16;
    let block_align = (bytes_per_sample * channel_count) as u32;
    let byte_rate = block_align.saturating_mul(sample_rate);
    push_chunk_header(&mut out, b"fmt ", fmt_size as u32);
    out.extend_from_slice(&(if float { FORMAT_FLOAT } else { FORMAT_PCM }).to_le_bytes());
    out.extend_from_slice(&(channel_count as u16).to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&byte_rate.to_le_bytes());
    out.extend_from_slice(&(block_align as u16).to_le_bytes());
    out.extend_from_slice(&bits.to_le_bytes());
    if float {
        out.extend_from_slice(&0u16.to_le_bytes());
        push_chunk_header(&mut out, b"fact", 4);
        out.extend_from_slice(&(frames as u32).to_le_bytes());
    }

    push_chunk_header(&mut out, b"data", data_size as u32);

    let mut peak = 0.0f32;
    let mut clipped = 0usize;
    for frame in 0..frames {
        for channel in channels {
            let raw = channel[frame];
            if raw.is_finite() {
                let magnitude = raw.abs();
                if magnitude > peak {
                    peak = magnitude;
                }
            }
            let (value, out_of_range) = clamp_sample(raw);
            if out_of_range {
                clipped += 1;
            }
            match depth {
                BitDepth::Pcm16 => {
                    let scaled = (value * 32_767.0).round() as i16;
                    out.extend_from_slice(&scaled.to_le_bytes());
                }
                BitDepth::Pcm24 => {
                    let scaled = (value * 8_388_607.0).round() as i32;
                    let b = scaled.to_le_bytes();
                    out.extend_from_slice(&b[0..3]);
                }
                BitDepth::Float32 => out.extend_from_slice(&value.to_le_bytes()),
            }
        }
    }
    if pad == 1 {
        out.push(0);
    }

    Ok((
        out,
        ExportReport {
            frames,
            peak,
            clipped_samples: clipped,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(frames: usize, hz: f64, rate: f64) -> Vec<f32> {
        (0..frames)
            .map(|i| (std::f64::consts::TAU * hz * i as f64 / rate).sin() as f32 * 0.8)
            .collect()
    }

    /// Builds a minimal WAVE file around a raw `fmt ` body and raw sample bytes.
    fn build(fmt_body: &[u8], data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"RIFF");
        let size = 4 + 8 + fmt_body.len() + 8 + data.len();
        out.extend_from_slice(&(size as u32).to_le_bytes());
        out.extend_from_slice(b"WAVE");
        out.extend_from_slice(b"fmt ");
        out.extend_from_slice(&(fmt_body.len() as u32).to_le_bytes());
        out.extend_from_slice(fmt_body);
        out.extend_from_slice(b"data");
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    fn pcm_fmt(codec: u16, channels: u16, rate: u32, bits: u16) -> Vec<u8> {
        let block_align = u32::from(channels) * u32::from(bits) / 8;
        let mut f = Vec::new();
        f.extend_from_slice(&codec.to_le_bytes());
        f.extend_from_slice(&channels.to_le_bytes());
        f.extend_from_slice(&rate.to_le_bytes());
        f.extend_from_slice(&block_align.saturating_mul(rate).to_le_bytes());
        f.extend_from_slice(&(block_align as u16).to_le_bytes());
        f.extend_from_slice(&bits.to_le_bytes());
        f
    }

    #[test]
    fn round_trips_pcm16() {
        let source = sine(2000, 220.0, 48_000.0);
        let (bytes, report) =
            encode_wav(std::slice::from_ref(&source), 48_000, BitDepth::Pcm16).unwrap();
        assert_eq!(report.frames, 2000);
        assert_eq!(report.clipped_samples, 0);
        let decoded = decode_wav(&bytes).unwrap();
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.frames(), 2000);
        for (a, b) in source.iter().zip(decoded.data[0].iter()) {
            assert!((a - b).abs() < 1.0 / 16_000.0, "{a} vs {b}");
        }
    }

    #[test]
    fn round_trips_pcm24() {
        let source = sine(500, 440.0, 44_100.0);
        let (bytes, _) =
            encode_wav(std::slice::from_ref(&source), 44_100, BitDepth::Pcm24).unwrap();
        let decoded = decode_wav(&bytes).unwrap();
        assert_eq!(decoded.sample_rate, 44_100);
        for (a, b) in source.iter().zip(decoded.data[0].iter()) {
            assert!((a - b).abs() < 1e-6, "{a} vs {b}");
        }
    }

    #[test]
    fn round_trips_float32_exactly() {
        let source = sine(500, 100.0, 48_000.0);
        let (bytes, _) =
            encode_wav(std::slice::from_ref(&source), 48_000, BitDepth::Float32).unwrap();
        let decoded = decode_wav(&bytes).unwrap();
        assert_eq!(decoded.data[0], source);
    }

    #[test]
    fn round_trips_stereo_and_deinterleaves() {
        let left: Vec<f32> = (0..64).map(|i| i as f32 / 128.0).collect();
        let right: Vec<f32> = (0..64).map(|i| -(i as f32) / 128.0).collect();
        let (bytes, report) =
            encode_wav(&[left.clone(), right.clone()], 48_000, BitDepth::Float32).unwrap();
        assert_eq!(report.frames, 64);
        let decoded = decode_wav(&bytes).unwrap();
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.data[0], left);
        assert_eq!(decoded.data[1], right);
        let mono = decoded.to_mono();
        assert!(mono.iter().all(|v| v.abs() < 1e-7));
    }

    #[test]
    fn clipping_is_clamped_and_counted() {
        let source = vec![2.0f32, -3.0, 0.5, f32::NAN, f32::INFINITY, 1.0];
        let (bytes, report) = encode_wav(&[source], 48_000, BitDepth::Pcm16).unwrap();
        assert_eq!(report.clipped_samples, 4);
        assert_eq!(report.peak, 3.0);
        let decoded = decode_wav(&bytes).unwrap();
        assert!((decoded.data[0][0] - 1.0).abs() < 1e-4);
        assert!((decoded.data[0][1] + 1.0).abs() < 1e-4);
        assert!((decoded.data[0][2] - 0.5).abs() < 1e-4);
        assert_eq!(decoded.data[0][3], 0.0);
        assert!((decoded.data[0][4] - 1.0).abs() < 1e-4);
    }

    #[test]
    fn float32_export_also_clamps() {
        let (bytes, report) = encode_wav(&[vec![4.0f32]], 48_000, BitDepth::Float32).unwrap();
        assert_eq!(report.clipped_samples, 1);
        assert_eq!(decode_wav(&bytes).unwrap().data[0][0], 1.0);
    }

    #[test]
    fn decodes_unsigned_eight_bit() {
        let fmt = pcm_fmt(FORMAT_PCM, 1, 8_000, 8);
        let file = build(&fmt, &[128, 255, 0, 192]);
        let decoded = decode_wav(&file).unwrap();
        assert_eq!(decoded.data[0][0], 0.0);
        assert!((decoded.data[0][1] - 0.9921875).abs() < 1e-6);
        assert_eq!(decoded.data[0][2], -1.0);
        assert!((decoded.data[0][3] - 0.5).abs() < 1e-6);
    }

    #[test]
    fn decodes_thirty_two_bit_pcm_and_double_float() {
        let fmt = pcm_fmt(FORMAT_PCM, 1, 48_000, 32);
        let mut data = Vec::new();
        data.extend_from_slice(&i32::MIN.to_le_bytes());
        data.extend_from_slice(&0i32.to_le_bytes());
        let decoded = decode_wav(&build(&fmt, &data)).unwrap();
        assert_eq!(decoded.data[0], vec![-1.0, 0.0]);

        let fmt = pcm_fmt(FORMAT_FLOAT, 1, 48_000, 64);
        let mut data = Vec::new();
        data.extend_from_slice(&0.25f64.to_le_bytes());
        data.extend_from_slice(&f64::NAN.to_le_bytes());
        let decoded = decode_wav(&build(&fmt, &data)).unwrap();
        assert_eq!(decoded.data[0], vec![0.25, 0.0]);
    }

    #[test]
    fn parses_extensible_format() {
        let mut fmt = pcm_fmt(FORMAT_EXTENSIBLE, 2, 48_000, 16);
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        fmt.extend_from_slice(&3u32.to_le_bytes());
        fmt.extend_from_slice(&FORMAT_PCM.to_le_bytes());
        fmt.extend_from_slice(&SUBFORMAT_TAIL);
        let mut data = Vec::new();
        for v in [1000i16, -1000, 2000, -2000] {
            data.extend_from_slice(&v.to_le_bytes());
        }
        let decoded = decode_wav(&build(&fmt, &data)).unwrap();
        assert_eq!(decoded.channels, 2);
        assert_eq!(decoded.frames(), 2);
        assert!((decoded.data[0][0] - 1000.0 / 32768.0).abs() < 1e-6);
        assert!((decoded.data[1][1] + 2000.0 / 32768.0).abs() < 1e-6);
    }

    #[test]
    fn rejects_extensible_with_foreign_guid() {
        let mut fmt = pcm_fmt(FORMAT_EXTENSIBLE, 1, 48_000, 16);
        fmt.extend_from_slice(&22u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());
        fmt.extend_from_slice(&0u32.to_le_bytes());
        fmt.extend_from_slice(&FORMAT_PCM.to_le_bytes());
        fmt.extend_from_slice(&[0xFFu8; 14]);
        assert!(matches!(
            decode_wav(&build(&fmt, &[0, 0])),
            Err(AxysError::Unsupported(_))
        ));
    }

    #[test]
    fn skips_unknown_chunks_and_odd_padding() {
        let fmt = pcm_fmt(FORMAT_PCM, 1, 48_000, 8);
        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        let body_len = 4 + (8 + fmt.len()) + (8 + 3 + 1) + (8 + 2);
        file.extend_from_slice(&(body_len as u32).to_le_bytes());
        file.extend_from_slice(b"WAVE");
        file.extend_from_slice(b"fmt ");
        file.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        file.extend_from_slice(&fmt);
        file.extend_from_slice(b"LIST");
        file.extend_from_slice(&3u32.to_le_bytes());
        file.extend_from_slice(&[1, 2, 3, 0]);
        file.extend_from_slice(b"data");
        file.extend_from_slice(&2u32.to_le_bytes());
        file.extend_from_slice(&[128, 128]);
        let decoded = decode_wav(&file).unwrap();
        assert_eq!(decoded.frames(), 2);
    }

    #[test]
    fn rejects_truncated_header() {
        for len in 0..12 {
            assert!(decode_wav(&vec![0u8; len]).is_err());
        }
        assert!(decode_wav(b"RIFF\x00\x00\x00\x00AVI ").is_err());
        assert!(decode_wav(b"JUNKxxxxWAVE").is_err());
    }

    #[test]
    fn rejects_lying_chunk_size() {
        let fmt = pcm_fmt(FORMAT_PCM, 1, 48_000, 16);
        let mut file = build(&fmt, &[0, 0, 0, 0]);
        let data_size_at = file.len() - 8;
        file[data_size_at..data_size_at + 4].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert!(matches!(decode_wav(&file), Err(AxysError::Invalid(_))));

        let mut file = build(&fmt, &[0, 0, 0, 0]);
        file[4..8].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
        assert!(matches!(decode_wav(&file), Err(AxysError::Invalid(_))));
    }

    #[test]
    fn rejects_absurd_channel_count() {
        let fmt = pcm_fmt(FORMAT_PCM, 60_000, 48_000, 16);
        assert!(decode_wav(&build(&fmt, &[0; 16])).is_err());
        let fmt = pcm_fmt(FORMAT_PCM, 0, 48_000, 16);
        assert!(decode_wav(&build(&fmt, &[0; 16])).is_err());
        assert!(encode_wav(&vec![vec![0.0f32; 1]; 100], 48_000, BitDepth::Pcm16).is_err());
    }

    #[test]
    fn rejects_unsupported_codec_and_depth() {
        let fmt = pcm_fmt(17, 1, 48_000, 4);
        assert!(matches!(
            decode_wav(&build(&fmt, &[0; 16])),
            Err(AxysError::Unsupported(_))
        ));
        let fmt = pcm_fmt(FORMAT_PCM, 1, 48_000, 12);
        assert!(matches!(
            decode_wav(&build(&fmt, &[0; 16])),
            Err(AxysError::Unsupported(_))
        ));
        let fmt = pcm_fmt(FORMAT_FLOAT, 1, 48_000, 16);
        assert!(matches!(
            decode_wav(&build(&fmt, &[0; 16])),
            Err(AxysError::Unsupported(_))
        ));
        let mut rf64 = b"RF64".to_vec();
        rf64.extend_from_slice(&[0; 8]);
        rf64[8..12].copy_from_slice(b"WAVE");
        assert!(matches!(decode_wav(&rf64), Err(AxysError::Unsupported(_))));
    }

    #[test]
    fn rejects_out_of_range_sample_rate() {
        let fmt = pcm_fmt(FORMAT_PCM, 1, 1_000, 16);
        assert!(decode_wav(&build(&fmt, &[0; 4])).is_err());
        let fmt = pcm_fmt(FORMAT_PCM, 1, 1_000_000, 16);
        assert!(decode_wav(&build(&fmt, &[0; 4])).is_err());
        assert!(encode_wav(&[vec![0.0f32]], 100, BitDepth::Pcm16).is_err());
        assert!(encode_wav(&[vec![0.0f32]], 500_000, BitDepth::Pcm16).is_err());
    }

    #[test]
    fn rejects_missing_chunks_and_short_fmt() {
        let mut file = b"RIFF".to_vec();
        file.extend_from_slice(&4u32.to_le_bytes());
        file.extend_from_slice(b"WAVE");
        assert!(decode_wav(&file).is_err());

        let fmt = pcm_fmt(FORMAT_PCM, 1, 48_000, 16);
        let mut only_fmt = b"RIFF".to_vec();
        only_fmt.extend_from_slice(&((4 + 8 + fmt.len()) as u32).to_le_bytes());
        only_fmt.extend_from_slice(b"WAVE");
        only_fmt.extend_from_slice(b"fmt ");
        only_fmt.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        only_fmt.extend_from_slice(&fmt);
        assert!(decode_wav(&only_fmt).is_err());

        assert!(decode_wav(&build(&[0; 8], &[0; 4])).is_err());
    }

    #[test]
    fn partial_trailing_frame_is_dropped() {
        let fmt = pcm_fmt(FORMAT_PCM, 2, 48_000, 16);
        let decoded = decode_wav(&build(&fmt, &[0; 6])).unwrap();
        assert_eq!(decoded.frames(), 1);
    }

    #[test]
    fn empty_data_decodes_to_empty_channels() {
        let fmt = pcm_fmt(FORMAT_PCM, 2, 48_000, 16);
        let decoded = decode_wav(&build(&fmt, &[])).unwrap();
        assert_eq!(decoded.frames(), 0);
        assert_eq!(decoded.duration(), 0.0);
        assert!(decoded.to_mono().is_empty());
    }

    #[test]
    fn truncating_a_valid_file_never_panics() {
        let (bytes, _) = encode_wav(&[sine(97, 300.0, 48_000.0)], 48_000, BitDepth::Pcm24).unwrap();
        for len in 0..bytes.len() {
            let _ = decode_wav(&bytes[..len]);
        }
        for i in 0..bytes.len() {
            let mut corrupt = bytes.clone();
            corrupt[i] = corrupt[i].wrapping_add(0x7F);
            let _ = decode_wav(&corrupt);
        }
    }

    #[test]
    fn encode_rejects_ragged_and_empty_input() {
        assert!(encode_wav(&[], 48_000, BitDepth::Pcm16).is_err());
        assert!(encode_wav(&[vec![0.0; 4], vec![0.0; 3]], 48_000, BitDepth::Pcm16).is_err());
    }

    #[test]
    fn encoded_sizes_match_the_headers() {
        for depth in [BitDepth::Pcm16, BitDepth::Pcm24, BitDepth::Float32] {
            let (bytes, _) = encode_wav(&[vec![0.0f32; 3]], 48_000, depth).unwrap();
            let declared = read_u32(&bytes, 4).unwrap() as usize;
            assert_eq!(declared + 8, bytes.len());
            assert_eq!(bytes.len() % 2, 0);
        }
    }

    #[test]
    fn duration_and_frames_follow_the_shortest_channel() {
        let audio = DecodedAudio {
            sample_rate: 48_000,
            channels: 2,
            data: vec![vec![0.0; 96_000], vec![0.0; 48_000]],
        };
        assert_eq!(audio.frames(), 48_000);
        assert_eq!(audio.duration(), 1.0);
    }
}
