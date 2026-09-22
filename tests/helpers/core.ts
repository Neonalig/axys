// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared harness for the Node-side end-to-end suites.
 *
 * Loads the real compiled core, reads the generated fixtures and provides the few
 * measurements the suites assert on. Nothing here mocks or approximates the engine: the
 * wasm module is the same artefact the browser loads.
 */

import { readFile } from 'node:fs/promises';

import init, * as core from '../../web/src/wasm/axys_wasm.js';

/** The initialised wasm-bindgen module namespace. */
export type TestCore = typeof core;

/** Fixture audio decoded to mono float samples. */
export interface WavFixture {
  /** Interleaved-to-mono samples in [-1, 1]. */
  samples: Float32Array;
  /** Sample rate in Hz, as recorded in the `fmt ` chunk. */
  sampleRate: number;
}

/** A pitch track read back from an {@link core.Analysis}. */
export interface F0Measurement {
  /** Frame times in seconds. */
  times: Float32Array;
  /** Fractional MIDI per frame, `NaN` where the frame is unvoiced. */
  midi: Float32Array;
}

/** Fixture audio plus its analysis, memoised per fixture name. */
export interface AnalysedFixture extends WavFixture {
  /** The live {@link core.Analysis}; owned by the cache, so do not `free()` it. */
  analysis: core.Analysis;
}

const FIXTURES = new URL('../../fixtures/', import.meta.url);

let corePromise: Promise<TestCore> | null = null;
const analysisCache = new Map<string, Promise<AnalysedFixture>>();

/**
 * Loads and initialises the compiled core, caching it for the whole worker.
 *
 * The wasm-pack `web` target fetches its own binary by URL, which Node has no origin
 * for, so the bytes are read from disk and handed to `init` directly.
 *
 * @returns The initialised module namespace.
 */
export async function loadTestCore(): Promise<TestCore> {
  corePromise ??= (async () => {
    const bytes = await readFile(new URL('../../web/src/wasm/axys_wasm_bg.wasm', import.meta.url));
    await init({ module_or_path: bytes });
    core.start();
    return core;
  })();
  return corePromise;
}

/**
 * Decodes a fixture WAV from `fixtures/audio/`.
 *
 * Handles PCM WAV with 8, 16, 24 or 32-bit integer samples and 32-bit float, walking the
 * RIFF chunk list rather than assuming a canonical 44-byte header. Multi-channel files
 * are averaged to mono, which is what the core takes.
 *
 * @param name File name inside `fixtures/audio/`, for example `sustained-vowel.wav`.
 * @returns The decoded samples and their sample rate.
 */
export async function readWavFixture(name: string): Promise<WavFixture> {
  const bytes = await readFile(new URL(`audio/${name}`, FIXTURES));
  return decodeWav(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    `fixtures/audio/${name}`,
  );
}

/**
 * Decodes an in-memory RIFF/WAVE buffer, such as the bytes `Session.exportWav` returns.
 *
 * Shares the fixture decoder, so an export is read back by exactly the same code path the
 * fixtures go through.
 *
 * @param bytes Encoded RIFF/WAVE file.
 * @param label Name used in error messages.
 * @returns The decoded samples and their sample rate.
 */
export function decodeWavBytes(bytes: Uint8Array, label = 'exported WAV'): WavFixture {
  return decodeWav(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), label);
}

/**
 * Reads a Standard MIDI File from `fixtures/midi/` as raw bytes.
 *
 * @param name File name inside `fixtures/midi/`, for example `melody.mid`.
 * @returns The file contents.
 */
export async function readMidiFixture(name: string): Promise<Uint8Array> {
  const bytes = await readFile(new URL(`midi/${name}`, FIXTURES));
  return new Uint8Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/**
 * Measures the pitch track of arbitrary samples with the real detector.
 *
 * Used to check rendered output, so it runs a full analysis at default parameters and
 * frees it once the two tracks have been copied out of wasm memory.
 *
 * @param samples Mono samples in [-1, 1].
 * @param sampleRate Sample rate in Hz.
 * @returns Frame times and fractional MIDI, `NaN` where unvoiced.
 */
export async function measureF0(samples: Float32Array, sampleRate: number): Promise<F0Measurement> {
  const loaded = await loadTestCore();
  const analysis = loaded.analyse(samples, sampleRate, '');
  try {
    return { times: analysis.times().slice(), midi: analysis.midi().slice() };
  } finally {
    analysis.free();
  }
}

/**
 * Median of a MIDI track, ignoring unvoiced frames.
 *
 * The median rather than the mean because an octave error on a handful of frames should
 * not move the reading, which is the whole reason the suites use it.
 *
 * @param midi Fractional MIDI per frame, `NaN` where unvoiced.
 * @returns The median of the voiced frames, or `NaN` when there are none.
 */
export function medianMidi(midi: ArrayLike<number>): number {
  const voiced: number[] = [];
  for (let i = 0; i < midi.length; i += 1) {
    const value = midi[i];
    if (value !== undefined && Number.isFinite(value)) voiced.push(value);
  }
  if (voiced.length === 0) return Number.NaN;
  voiced.sort((a, b) => a - b);
  const middle = voiced.length >> 1;
  if (voiced.length % 2 === 1) return voiced[middle] ?? Number.NaN;
  const lower = voiced[middle - 1] ?? Number.NaN;
  const upper = voiced[middle] ?? Number.NaN;
  return (lower + upper) / 2;
}

/**
 * Root mean square of a sample buffer.
 *
 * @param samples Samples to measure.
 * @returns The RMS level, or 0 for an empty buffer.
 */
export function rms(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / samples.length);
}

/**
 * Largest absolute sample value.
 *
 * @param samples Samples to measure.
 * @returns The peak magnitude, or 0 for an empty buffer.
 */
export function peak(samples: ArrayLike<number>): number {
  let highest = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i] ?? 0);
    if (magnitude > highest) highest = magnitude;
  }
  return highest;
}

/**
 * Pearson correlation of two buffers over their common length.
 *
 * Buffers of different lengths are compared over the shorter one; a caller that cares
 * about length should assert it separately.
 *
 * @param a First buffer.
 * @param b Second buffer.
 * @returns The correlation in [-1, 1], or 0 when either buffer is constant or empty.
 */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < len; i += 1) {
    sumA += a[i] ?? 0;
    sumB += b[i] ?? 0;
  }
  const meanA = sumA / len;
  const meanB = sumB / len;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < len; i += 1) {
    const da = (a[i] ?? 0) - meanA;
    const db = (b[i] ?? 0) - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) return 0;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/**
 * Decodes and analyses a fixture, memoised per fixture name.
 *
 * Analysis is the expensive part of these suites, so the returned {@link core.Analysis}
 * is shared and must not be freed by callers.
 *
 * @param name File name inside `fixtures/audio/`.
 * @returns The samples, sample rate and live analysis.
 */
export async function analyseFixture(name: string): Promise<AnalysedFixture> {
  let entry = analysisCache.get(name);
  if (!entry) {
    entry = (async () => {
      const loaded = await loadTestCore();
      const { samples, sampleRate } = await readWavFixture(name);
      const analysis = loaded.analyse(samples, sampleRate, '');
      return { samples, sampleRate, analysis };
    })();
    analysisCache.set(name, entry);
  }
  return entry;
}

/** Reads a four-character RIFF identifier at `offset`. */
function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Decodes a RIFF/WAVE buffer to mono float samples. */
function decodeWav(view: DataView, label: string): WavFixture {
  if (view.byteLength < 12 || fourcc(view, 0) !== 'RIFF' || fourcc(view, 8) !== 'WAVE') {
    throw new Error(`${label} is not a RIFF/WAVE file`);
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;

  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = fourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format tag in its GUID's first two bytes.
      if (format === 0xfffe && size >= 26) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      dataStart = body;
      dataLength = Math.min(size, view.byteLength - body);
    }
    offset = body + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`${label} has no data chunk`);
  if (channels < 1) throw new Error(`${label} declares ${channels} channels`);
  if (format !== 1 && format !== 3) {
    throw new Error(`${label} uses unsupported WAVE format ${format}`);
  }

  const bytesPerSample = bits / 8;
  const frames = Math.floor(dataLength / (bytesPerSample * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + (frame * channels + channel) * bytesPerSample;
      sum += readSample(view, at, format, bits, label);
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}

/** Reads one sample and scales it to [-1, 1]. */
function readSample(
  view: DataView,
  at: number,
  format: number,
  bits: number,
  label: string,
): number {
  if (format === 3) {
    if (bits === 32) return view.getFloat32(at, true);
    if (bits === 64) return view.getFloat64(at, true);
    throw new Error(`${label} declares ${bits}-bit float samples`);
  }
  switch (bits) {
    case 8:
      // 8-bit PCM is unsigned with a 128 offset, unlike every wider depth.
      return (view.getUint8(at) - 128) / 128;
    case 16:
      return view.getInt16(at, true) / 32768;
    case 24: {
      const raw = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
      return raw / 8388608;
    }
    case 32:
      return view.getInt32(at, true) / 2147483648;
    default:
      throw new Error(`${label} declares ${bits}-bit integer samples`);
  }
}
