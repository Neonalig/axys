// SPDX-License-Identifier: AGPL-3.0-or-later

//! Decoding of imported media into PCM, identically on every host.
//!
//! A browser's own decoder is not bit-exact across browsers, so the same file fingerprinted in two
//! of them disagrees. Decoding here runs the same code everywhere, so a file digests the same
//! wherever it is opened. Decoding is incremental: [`StreamDecoder::step`] decodes a bounded
//! number of packets, so a caller can report progress and stop between steps.

use std::io::{Cursor, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder, DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as MediaError;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::dsp::resample::resample;
use crate::limits::{MAX_AUDIO_SECONDS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE};
use crate::{AxysError, Result};

/// Most channels a decoded file may carry.
const MAX_CHANNELS: usize = 32;

/// Kernel half-width, in source samples, of the resampler used on import.
const RESAMPLE_QUALITY: usize = 16;

/// Decoded audio, channel by channel.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedAudio {
    /// Rate the channels are held at, in Hz.
    pub sample_rate: u32,
    /// Rate the file declared, in Hz.
    pub declared_rate: u32,
    /// Samples per channel, every channel the same length.
    pub channels: Vec<Vec<f32>>,
}

impl DecodedAudio {
    /// Frames per channel.
    pub fn frames(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    /// The channels averaged into one.
    ///
    /// Sums the channels in order and then scales, the way the web client mixes a browser-decoded
    /// file, so both produce the same buffer from the same channels.
    pub fn mono(&self) -> Vec<f32> {
        let frames = self.frames();
        let count = self.channels.len();
        if count == 1 {
            return self.channels[0].clone();
        }
        let mut mono = vec![0.0f32; frames];
        for channel in &self.channels {
            for (out, sample) in mono.iter_mut().zip(channel) {
                *out += *sample;
            }
        }
        let scale = 1.0 / count as f32;
        for out in &mut mono {
            *out *= scale;
        }
        mono
    }

    /// The same audio at `rate`, unchanged when it is already there.
    pub fn resampled(self, rate: u32) -> Result<DecodedAudio> {
        if rate == self.sample_rate {
            return Ok(self);
        }
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&rate) {
            return Err(AxysError::Invalid(format!(
                "sample rate {rate} Hz is out of range"
            )));
        }
        let from = f64::from(self.sample_rate);
        let to = f64::from(rate);
        let channels = self
            .channels
            .iter()
            .map(|channel| resample(channel, from, to, RESAMPLE_QUALITY))
            .collect();
        Ok(DecodedAudio {
            sample_rate: rate,
            declared_rate: self.declared_rate,
            channels,
        })
    }
}

/// A byte buffer that reports how far into it the reader has got.
struct TrackedBytes {
    inner: Cursor<Vec<u8>>,
    position: Arc<AtomicU64>,
    len: u64,
}

impl Read for TrackedBytes {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buf)?;
        self.position
            .store(self.inner.position(), Ordering::Relaxed);
        Ok(read)
    }
}

impl Seek for TrackedBytes {
    fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
        let at = self.inner.seek(pos)?;
        self.position.store(at, Ordering::Relaxed);
        Ok(at)
    }
}

impl MediaSource for TrackedBytes {
    fn is_seekable(&self) -> bool {
        true
    }

    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
}

/// Decodes one file a step at a time.
pub struct StreamDecoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn Decoder>,
    track: u32,
    sample_rate: u32,
    channels: Vec<Vec<f32>>,
    position: Arc<AtomicU64>,
    len: u64,
    done: bool,
}

impl std::fmt::Debug for StreamDecoder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamDecoder")
            .field("sample_rate", &self.sample_rate)
            .field("frames", &self.channels.first().map_or(0, Vec::len))
            .field("done", &self.done)
            .finish()
    }
}

fn unsupported(error: MediaError) -> AxysError {
    AxysError::Unsupported(format!("audio could not be decoded: {error}"))
}

impl StreamDecoder {
    /// Reads a file's header and prepares to decode its first audio track.
    ///
    /// `extension` is the file's extension without the dot, a hint for formats that carry no
    /// signature. Errors with [`AxysError::Unsupported`] for a container or codec not read here.
    pub fn open(bytes: Vec<u8>, extension: Option<&str>) -> Result<StreamDecoder> {
        let len = bytes.len() as u64;
        if len == 0 {
            return Err(AxysError::Invalid("the file holds no audio".to_string()));
        }
        let position = Arc::new(AtomicU64::new(0));
        let source = TrackedBytes {
            inner: Cursor::new(bytes),
            position: Arc::clone(&position),
            len,
        };
        let stream = MediaSourceStream::new(Box::new(source), Default::default());
        let mut hint = Hint::new();
        if let Some(extension) = extension {
            hint.with_extension(extension);
        }
        let options = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let probed = symphonia::default::get_probe()
            .format(&hint, stream, &options, &MetadataOptions::default())
            .map_err(unsupported)?;
        let format = probed.format;
        let track = format
            .tracks()
            .iter()
            .find(|track| track.codec_params.codec != CODEC_TYPE_NULL)
            .ok_or_else(|| AxysError::Unsupported("the file holds no audio track".to_string()))?;
        let params = track.codec_params.clone();
        let track = track.id;
        let sample_rate = params.sample_rate.ok_or_else(|| {
            AxysError::Unsupported("the file declares no sample rate".to_string())
        })?;
        if !(MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(&sample_rate) {
            return Err(AxysError::Invalid(format!(
                "sample rate {sample_rate} Hz is out of range"
            )));
        }
        let decoder = symphonia::default::get_codecs()
            .make(&params, &DecoderOptions::default())
            .map_err(unsupported)?;
        Ok(StreamDecoder {
            format,
            decoder,
            track,
            sample_rate,
            channels: Vec::new(),
            position,
            len,
            done: false,
        })
    }

    /// Rate the file declared, in Hz.
    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// Fraction of the file read so far, 0 to 1.
    pub fn progress(&self) -> f64 {
        if self.done {
            return 1.0;
        }
        (self.position.load(Ordering::Relaxed) as f64 / self.len as f64).clamp(0.0, 1.0)
    }

    /// Decodes up to `packets` packets, returning true once the file is finished.
    ///
    /// A packet the codec rejects is skipped, the way a player skips a damaged frame.
    pub fn step(&mut self, packets: usize) -> Result<bool> {
        for _ in 0..packets {
            if self.done {
                break;
            }
            let packet = match self.format.next_packet() {
                Ok(packet) => packet,
                Err(MediaError::IoError(error))
                    if error.kind() == std::io::ErrorKind::UnexpectedEof =>
                {
                    self.done = true;
                    break;
                }
                Err(MediaError::ResetRequired) => {
                    self.done = true;
                    break;
                }
                Err(error) => return Err(unsupported(error)),
            };
            if packet.track_id() != self.track {
                continue;
            }
            let decoded = match self.decoder.decode(&packet) {
                Ok(decoded) => decoded,
                Err(MediaError::DecodeError(_)) => continue,
                Err(error) => return Err(unsupported(error)),
            };
            let spec = *decoded.spec();
            let count = spec.channels.count();
            if count == 0 || count > MAX_CHANNELS {
                return Err(AxysError::Unsupported(format!(
                    "{count} channels cannot be imported"
                )));
            }
            if self.channels.is_empty() {
                self.channels = vec![Vec::new(); count];
            } else if self.channels.len() != count {
                return Err(AxysError::Unsupported(
                    "the channel count changes partway through the file".to_string(),
                ));
            }
            let mut buffer = SampleBuffer::<f32>::new(decoded.capacity() as u64, spec);
            buffer.copy_planar_ref(decoded);
            let frames = buffer.samples().len() / count;
            for (index, channel) in self.channels.iter_mut().enumerate() {
                channel.extend_from_slice(&buffer.samples()[index * frames..(index + 1) * frames]);
            }
            let seconds = self.channels[0].len() as f64 / f64::from(self.sample_rate);
            if seconds > MAX_AUDIO_SECONDS {
                return Err(AxysError::Invalid(format!(
                    "audio runs past the {} minute limit",
                    MAX_AUDIO_SECONDS / 60.0
                )));
            }
        }
        Ok(self.done)
    }

    /// Decodes whatever is left and hands back the audio.
    pub fn finish(mut self) -> Result<DecodedAudio> {
        while !self.step(usize::MAX)? {}
        if self.channels.first().is_none_or(Vec::is_empty) {
            return Err(AxysError::Invalid(
                "the file decoded to no audio".to_string(),
            ));
        }
        Ok(DecodedAudio {
            sample_rate: self.sample_rate,
            declared_rate: self.sample_rate,
            channels: self.channels,
        })
    }
}

/// Decodes a whole file at once.
pub fn decode(bytes: Vec<u8>, extension: Option<&str>) -> Result<DecodedAudio> {
    StreamDecoder::open(bytes, extension)?.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio::wav::{encode_wav, BitDepth};

    fn tone(frames: usize, rate: f64) -> Vec<f32> {
        (0..frames)
            .map(|i| 0.5 * (2.0 * std::f64::consts::PI * 220.0 * i as f64 / rate).sin() as f32)
            .collect()
    }

    #[test]
    fn decodes_a_wav_it_wrote_to_the_same_samples() {
        let samples = tone(4_800, 48_000.0);
        let bytes = encode_wav(std::slice::from_ref(&samples), 48_000, BitDepth::Float32)
            .expect("wav")
            .0;
        let decoded = decode(bytes, Some("wav")).expect("decoded");
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels.len(), 1);
        assert_eq!(decoded.channels[0], samples);
    }

    #[test]
    fn steps_report_progress_and_end_with_the_whole_file() {
        let samples = tone(48_000, 48_000.0);
        let bytes = encode_wav(&[samples.clone(), samples], 48_000, BitDepth::Pcm16)
            .expect("wav")
            .0;
        let mut decoder = StreamDecoder::open(bytes, Some("wav")).expect("open");
        let mut last = decoder.progress();
        while !decoder.step(4).expect("step") {
            assert!(decoder.progress() >= last);
            last = decoder.progress();
        }
        assert_eq!(decoder.progress(), 1.0);
        let decoded = decoder.finish().expect("finish");
        assert_eq!(decoded.channels.len(), 2);
        assert_eq!(decoded.frames(), 48_000);
    }

    #[test]
    fn resamples_to_the_asked_rate() {
        let samples = tone(44_100, 44_100.0);
        let bytes = encode_wav(&[samples], 44_100, BitDepth::Pcm24)
            .expect("wav")
            .0;
        let decoded = decode(bytes, None)
            .expect("decoded")
            .resampled(48_000)
            .expect("resampled");
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.declared_rate, 44_100);
        assert!((decoded.frames() as i64 - 48_000).abs() <= 1);
    }

    #[test]
    fn refuses_what_is_not_audio() {
        assert!(decode(vec![1, 2, 3, 4, 5, 6, 7, 8], None).is_err());
        assert!(decode(Vec::new(), None).is_err());
    }

    #[test]
    fn mono_averages_the_channels() {
        let audio = DecodedAudio {
            sample_rate: 8_000,
            declared_rate: 8_000,
            channels: vec![vec![1.0, 0.0], vec![0.0, 1.0]],
        };
        assert_eq!(audio.mono(), vec![0.5, 0.5]);
    }
}
