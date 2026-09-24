// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Decoding of imported audio files into the PCM the analysis, editor and worklet read.
 *
 * The core decodes WAV, FLAC, MP3, AAC and Ogg Vorbis in a worker, so the same file becomes the
 * same samples in every browser. Anything else goes through `BaseAudioContext.decodeAudioData`,
 * so every format the host supports is still accepted.
 */

import { DecodeClient } from '../workers/client.js';
import { WorkerCancelled, WorkerStalled } from '../workers/protocol.js';
import type { DecodedAudio } from '../workers/protocol.js';

/** Why a file could not be decoded. */
export type DecodeFailure = 'empty' | 'tooLarge' | 'tooLong' | 'unreadable' | 'unsupported';

/** A file Axys could not turn into PCM, carrying a message fit for a toast. */
export class AudioDecodeError extends Error {
  /** Which decoding rule the file broke. */
  readonly failure: DecodeFailure;

  constructor(failure: DecodeFailure, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'AudioDecodeError';
    this.failure = failure;
  }
}

/** Decoded source audio and the immutable facts recorded about it. */
export interface DecodedSource {
  /** File name, as imported. */
  name: string;
  /** Media type the host reported, or `null` when the host reported none. */
  mime: string | null;
  /** Sample rate of {@link DecodedSource.mono} and {@link DecodedSource.channelData}. */
  sampleRate: number;
  /** Rate declared by the file header, which differs from `sampleRate` after a resample. */
  declaredSampleRate: number | null;
  /** True when the browser decoded at a rate other than the file's own. */
  resampled: boolean;
  /** Channel count of the decoded audio. */
  channels: number;
  /** Frames per channel. */
  frames: number;
  /** Duration in seconds. */
  duration: number;
  /** FNV-1a 64-bit digest of {@link DecodedSource.mono}, the key a relink is checked against. */
  fingerprint: string;
  /** Mono mix, the buffer analysis and rendering read. */
  mono: Float32Array;
  /** Decoded audio channel by channel. */
  channelData: readonly Float32Array[];
}

const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_SECONDS = 30 * 60;
const HEADER_BYTES = 8192;
const MIN_CONTEXT_RATE = 8000;
const MAX_CONTEXT_RATE = 96000;
const FALLBACK_CONTEXT_RATE = 48000;

/** Decodes in the core, off the main thread, for every file the core can read. */
const decoder = new DecodeClient();

/** Receives the completed fraction of a decode, 0 to 1. */
export type DecodeProgress = (progress: number) => void;

/** Starts the decode worker and has it load its core now rather than on the first import. */
export function warmDecoder(): void {
  decoder.warm();
}

/** Abandons every decode in flight. Each rejects with a cancellation. */
export function cancelDecoding(): void {
  decoder.cancel();
}

/**
 * Decodes one imported file, keeping the source rate and channel count.
 *
 * @remarks Rejects with an {@link AudioDecodeError} naming the reason, never with a bare decoder
 * error. The core decodes every format it reads, identically in every browser, so a fingerprint
 * taken in one browser matches in another. Only a format the core does not read goes to the
 * browser's own decoder. `sampleRate` decodes at that rate instead of the file's own, which is
 * how a second source joins a project whose every source is held at one rate. A cancelled decode
 * rejects with the worker's cancellation, not an {@link AudioDecodeError}.
 */
export async function decodeAudioFile(
  file: File,
  sampleRate?: number,
  onProgress?: DecodeProgress,
): Promise<DecodedSource> {
  if (file.size === 0) {
    throw new AudioDecodeError('empty', `"${file.name}" holds no audio.`);
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AudioDecodeError(
      'tooLarge',
      `"${file.name}" is ${describeBytes(file.size)}, over the ${describeBytes(MAX_FILE_BYTES)} import limit.`,
    );
  }

  const declared = await sniffSampleRate(file);
  const own =
    declared === null || (declared >= MIN_CONTEXT_RATE && declared <= MAX_CONTEXT_RATE)
      ? null
      : FALLBACK_CONTEXT_RATE;
  const target = sampleRate ?? own;
  let decoded: DecodedAudio;
  try {
    decoded = await decoder.decode(
      await readBytes(file),
      extensionOf(file.name),
      target,
      (_, done) => onProgress?.(done),
    );
  } catch (thrown) {
    if (thrown instanceof WorkerCancelled) throw thrown;
    if (thrown instanceof WorkerStalled) {
      throw new AudioDecodeError(
        'unreadable',
        `Decoding "${file.name}" stopped responding.`,
        thrown,
      );
    }
    decoded = await decodeInBrowser(file, target ?? declared);
  }
  return checked(file, decoded, declared, sampleRate === undefined);
}

/** Rejects decoded audio that breaks an import rule, and describes the rest. */
function checked(
  file: File,
  decoded: DecodedAudio,
  declared: number | null,
  ownRate: boolean,
): DecodedSource {
  if (decoded.frames === 0 || decoded.channels.length === 0) {
    throw new AudioDecodeError('empty', `"${file.name}" decoded to no audio.`);
  }
  const duration = decoded.frames / decoded.sampleRate;
  if (duration > MAX_SECONDS) {
    throw new AudioDecodeError(
      'tooLong',
      `"${file.name}" runs ${duration.toFixed(0)} seconds, over the ${String(MAX_SECONDS / 60)} minute import limit.`,
    );
  }
  const rate = declared ?? decoded.declaredRate;
  return {
    name: file.name,
    mime: file.type === '' ? null : file.type,
    sampleRate: decoded.sampleRate,
    declaredSampleRate: rate,
    resampled: rate !== decoded.sampleRate && ownRate,
    channels: decoded.channels.length,
    frames: decoded.frames,
    duration,
    fingerprint: decoded.fingerprint,
    mono: decoded.mono,
    channelData: decoded.channels,
  };
}

/**
 * Decodes through the browser, for a format the core does not read.
 *
 * @remarks Runs on an `OfflineAudioContext`, so it needs no user gesture. The result is not
 * bit-exact across browsers.
 */
async function decodeInBrowser(file: File, rate: number | null): Promise<DecodedAudio> {
  const context = openDecodeContext(rate);
  let buffer: AudioBuffer;
  try {
    buffer = await context.decodeAudioData(await readBytes(file));
  } catch (thrown) {
    throw new AudioDecodeError(
      'unsupported',
      `This browser cannot decode "${file.name}". Try WAV, FLAC or MP3.`,
      thrown,
    );
  }
  const channels: Float32Array[] = [];
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    channels.push(buffer.getChannelData(channel));
  }
  const mono = mixToMono(channels, buffer.length);
  return {
    sampleRate: buffer.sampleRate,
    declaredRate: buffer.sampleRate,
    frames: buffer.length,
    channels,
    mono,
    fingerprint: fingerprintOf(mono),
  };
}

/** A file name's last extension, lower case and without the dot, or empty. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * Averages the channels into one buffer.
 *
 * @remarks Always a fresh buffer, so the caller may transfer it to the worklet.
 */
export function mixToMono(channels: readonly Float32Array[], frames: number): Float32Array {
  const mono = new Float32Array(frames);
  const count = channels.length;
  if (count === 0) return mono;

  const first = channels[0];
  if (count === 1 && first) {
    mono.set(first.subarray(0, frames));
    return mono;
  }

  for (const channel of channels) {
    const shared = Math.min(frames, channel.length);
    for (let i = 0; i < shared; i += 1) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0);
    }
  }
  const scale = 1 / count;
  for (let i = 0; i < frames; i += 1) {
    mono[i] = (mono[i] ?? 0) * scale;
  }
  return mono;
}

/**
 * FNV-1a 64-bit digest of PCM as 16 lowercase hex characters.
 *
 * @remarks Mirrors `axys_core::project::fingerprint`, including its normalisation of negative
 * zero and its trailing length word, so a digest taken here matches the one a project records.
 */
export function fingerprintOf(samples: Float32Array): string {
  const bits = new Uint32Array(1);
  const asFloat = new Float32Array(bits.buffer);

  // The 64-bit state as four 16-bit limbs, least significant first.
  let l0 = 0x2325;
  let l1 = 0x8422;
  let l2 = 0x9ce4;
  let l3 = 0xcbf2;

  const mixByte = (byte: number): void => {
    l0 ^= byte;
    // Multiply by the FNV prime 0x00000100000001b3 limb by limb, discarding the overflow.
    const c0 = l0 * 0x01b3;
    const c1 = l1 * 0x01b3 + Math.floor(c0 / 0x10000);
    const c2 = l2 * 0x01b3 + l0 * 0x0100 + Math.floor(c1 / 0x10000);
    const c3 = l3 * 0x01b3 + l1 * 0x0100 + Math.floor(c2 / 0x10000);
    l0 = c0 & 0xffff;
    l1 = c1 & 0xffff;
    l2 = c2 & 0xffff;
    l3 = c3 & 0xffff;
  };

  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    if (sample === 0) {
      bits[0] = 0;
    } else {
      asFloat[0] = sample;
    }
    const word = bits[0] ?? 0;
    mixByte(word & 0xff);
    mixByte((word >>> 8) & 0xff);
    mixByte((word >>> 16) & 0xff);
    mixByte((word >>> 24) & 0xff);
  }

  let length = samples.length;
  for (let i = 0; i < 8; i += 1) {
    mixByte(length & 0xff);
    length = Math.floor(length / 256);
  }

  return hex16(l3) + hex16(l2) + hex16(l1) + hex16(l0);
}

/**
 * Sample rate declared by the file header, or `null` when the container is not one Axys reads.
 *
 * @remarks Reads at most the first 8 KiB and never trusts a value outside 1 Hz to 768 kHz.
 */
export async function sniffSampleRate(file: File): Promise<number | null> {
  let header: Uint8Array;
  try {
    header = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer());
  } catch {
    return null;
  }
  const rate =
    wavRate(header) ?? flacRate(header) ?? oggRate(header) ?? mp4Rate(header) ?? mpegRate(header);
  if (rate === null || !Number.isFinite(rate) || rate < 1 || rate > 768000) return null;
  return rate;
}

function openDecodeContext(declared: number | null): OfflineAudioContext {
  if (declared !== null && declared >= MIN_CONTEXT_RATE && declared <= MAX_CONTEXT_RATE) {
    try {
      return new OfflineAudioContext(1, 1, declared);
    } catch {
      // A host that refuses the file's rate decodes at its own and reports the resample.
    }
  }
  return new OfflineAudioContext(1, 1, FALLBACK_CONTEXT_RATE);
}

async function readBytes(file: File): Promise<ArrayBuffer> {
  try {
    return await file.arrayBuffer();
  } catch (thrown) {
    throw new AudioDecodeError('unreadable', `"${file.name}" could not be read.`, thrown);
  }
}

function wavRate(header: Uint8Array): number | null {
  if (!matches(header, 0, 'RIFF') || !matches(header, 8, 'WAVE')) return null;
  const view = viewOf(header);
  let offset = 12;
  while (offset + 8 <= header.length) {
    const size = view.getUint32(offset + 4, true);
    if (matches(header, offset, 'fmt ') && offset + 12 <= header.length) {
      return view.getUint32(offset + 12, true);
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

function flacRate(header: Uint8Array): number | null {
  if (!matches(header, 0, 'fLaC') || header.length < 30) return null;
  // STREAMINFO follows the 4-byte block header; its sample rate is 20 bits at byte 10.
  const a = header[18] ?? 0;
  const b = header[19] ?? 0;
  const c = header[20] ?? 0;
  const rate = (a << 12) | (b << 4) | (c >> 4);
  return rate === 0 ? null : rate;
}

function oggRate(header: Uint8Array): number | null {
  if (!matches(header, 0, 'OggS')) return null;
  const view = viewOf(header);
  for (let offset = 0; offset + 16 <= header.length; offset += 1) {
    if (matches(header, offset, 'OpusHead')) {
      // Opus always decodes at 48 kHz whatever the original rate was.
      return 48000;
    }
    if (
      matches(header, offset + 1, 'vorbis') &&
      header[offset] === 1 &&
      offset + 16 <= header.length
    ) {
      return view.getUint32(offset + 11, true);
    }
  }
  return null;
}

function mp4Rate(header: Uint8Array): number | null {
  if (!matches(header, 4, 'ftyp')) return null;
  const view = viewOf(header);
  for (let offset = 0; offset + 32 <= header.length; offset += 1) {
    if (!matches(header, offset, 'mp4a')) continue;
    // The sample-entry sample rate is a 16.16 fixed-point field 22 bytes into the entry.
    const rate = view.getUint16(offset + 26, false);
    if (rate > 0) return rate;
  }
  return null;
}

const MPEG_RATES: readonly (readonly number[])[] = [
  [11025, 12000, 8000],
  [44100, 48000, 32000],
  [22050, 24000, 16000],
];

function mpegRate(header: Uint8Array): number | null {
  let offset = 0;
  if (matches(header, 0, 'ID3')) {
    const size =
      ((header[6] ?? 0) << 21) |
      ((header[7] ?? 0) << 14) |
      ((header[8] ?? 0) << 7) |
      (header[9] ?? 0);
    offset = 10 + size;
  }
  for (; offset + 4 <= header.length; offset += 1) {
    if ((header[offset] ?? 0) !== 0xff) continue;
    const second = header[offset + 1] ?? 0;
    if ((second & 0xe0) !== 0xe0) continue;
    const version = (second >> 3) & 0x03;
    if (version === 1) continue;
    const index = ((header[offset + 2] ?? 0) >> 2) & 0x03;
    if (index === 3) continue;
    const row = version === 0 ? MPEG_RATES[0] : version === 2 ? MPEG_RATES[2] : MPEG_RATES[1];
    return row?.[index] ?? null;
  }
  return null;
}

function matches(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset < 0 || offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if ((bytes[offset + i] ?? 0) !== text.charCodeAt(i)) return false;
  }
  return true;
}

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function hex16(limb: number): string {
  return limb.toString(16).padStart(4, '0');
}

function describeBytes(count: number): string {
  return `${(count / (1024 * 1024)).toFixed(0)} MB`;
}
