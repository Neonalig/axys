// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Projects saved with their audio, as one file.
 *
 * A package is a zip archive: the project document, a manifest, and each source's audio as it is
 * kept on the device (`stored-audio.ts`): the file it was imported from where that decodes back to
 * the exact samples and is the smaller, and otherwise a WAV of the samples at the smallest depth
 * that holds them exactly. A package opens anywhere with nothing to relink, and any zip tool can
 * take the audio out.
 *
 * Encoding a WAV and checksumming the archive work a slice at a time, yielding between slices, so
 * a large project reports progress instead of holding the page.
 */

import { PersistenceError } from './db.js';
import type { StoredAudio, StoredRole } from './stored-audio.js';

/** File extension every packaged project carries. */
export const PACKAGE_EXTENSION = '.axys';

/** Where the project document sits inside a package. */
const DOCUMENT_PATH = 'project.axys.json';

/** Where the manifest sits inside a package. */
const MANIFEST_PATH = 'manifest.json';

/**
 * Package layout version this build writes.
 *
 * @remarks Version 1 held a WAV per source and nothing else; version 2 says how each file is
 * read, since a source may be kept as its original file.
 */
const PACKAGE_VERSION = 2;

/** Frames worked through between yields to the page. */
const SLICE_FRAMES = 1 << 17;

/** Receives the fraction of the work done, 0 to 1. */
export type PackageProgress = (done: number) => void;

/** One source's audio, keyed the way the media store keys it. */
export interface PackagedMedia {
  /** The media store key: a fingerprint, with `-reference` for a reference's channels. */
  key: string;
  /** What the file inside the package is called, without the folder or the extension. */
  name: string;
  stored: StoredAudio;
}

/** A package read back: its document and its audio. */
export interface UnpackedProject {
  json: string;
  media: PackagedMedia[];
}

interface ManifestEntry {
  key: string;
  path: string;
  kind?: StoredAudio['kind'];
  extension?: string;
  role?: StoredRole;
  channels?: number;
  fingerprint?: string;
}

interface Manifest {
  version: number;
  media: ManifestEntry[];
}

/** One file in a zip archive, with its checksum. */
interface ZipEntry {
  path: string;
  data: Uint8Array<ArrayBuffer>;
  crc: number;
}

/** Lets the page run between slices of work. */
function yieldToPage(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Counts frames worked through across every source and reports them as a fraction. */
export class Tally {
  #done = 0;
  readonly #total: number;
  readonly #report: PackageProgress | undefined;

  constructor(total: number, report?: PackageProgress) {
    this.#total = Math.max(1, total);
    this.#report = report;
  }

  /** Counts `frames` more as done, reports, and yields to the page. */
  async add(frames: number): Promise<void> {
    this.#done += frames;
    this.#report?.(Math.min(1, this.#done / this.#total));
    await yieldToPage();
  }
}

/** Builds a package from a project document and its sources' audio. */
export async function packProject(
  json: string,
  media: readonly PackagedMedia[],
  onProgress?: PackageProgress,
): Promise<Blob> {
  const encoder = new TextEncoder();
  const used = new Set<string>();
  const entries: ZipEntry[] = [];
  const manifest: Manifest = { version: PACKAGE_VERSION, media: [] };
  const bytes = media.reduce((sum, item) => sum + item.stored.bytes.length, 0);
  const tally = new Tally(bytes, onProgress);
  for (const item of media) {
    const { stored } = item;
    const path = uniquePath(`audio/${safeName(item.name)}.${stored.extension || 'bin'}`, used);
    entries.push({ path, data: stored.bytes, crc: await crc32(stored.bytes, tally, 1) });
    manifest.media.push({
      key: item.key,
      path,
      kind: stored.kind,
      extension: stored.extension,
      role: stored.role,
      channels: stored.channels,
      fingerprint: stored.fingerprint,
    });
  }
  const text = (path: string, value: string): ZipEntry => {
    const data = encoder.encode(value);
    return { path, data, crc: finishCrc(crcOver(CRC_START, data, 0, data.length)) };
  };
  entries.unshift(
    text(DOCUMENT_PATH, json),
    text(MANIFEST_PATH, JSON.stringify(manifest, null, 2)),
  );
  return writeZip(entries);
}

/**
 * Reads a package back.
 *
 * @throws PersistenceError with kind `corrupt` when the file is not a package this build reads.
 */
export async function unpackProject(
  file: File,
  onProgress?: PackageProgress,
): Promise<UnpackedProject> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (cause) {
    throw new PersistenceError('io', `Could not read ${file.name}.`, { cause });
  }
  try {
    const entries = await readZip(bytes);
    const decoder = new TextDecoder();
    const document = entries.get(DOCUMENT_PATH);
    const manifestBytes = entries.get(MANIFEST_PATH);
    if (document === undefined || manifestBytes === undefined) {
      throw new Error('the package has no project');
    }
    const manifest = JSON.parse(decoder.decode(manifestBytes)) as Manifest;
    if (typeof manifest.version !== 'number' || manifest.version > PACKAGE_VERSION) {
      throw new Error('the package is from a newer version');
    }
    const media: PackagedMedia[] = [];
    for (const [index, entry] of manifest.media.entries()) {
      const data = entries.get(entry.path);
      if (data === undefined) throw new Error(`${entry.path} is missing`);
      // Version 1 held only WAVs, a reference's channels under a key ending in -reference.
      const role: StoredRole =
        entry.role ?? (entry.key.endsWith('-reference') ? 'channels' : 'mono');
      media.push({
        key: entry.key,
        name: entry.path,
        stored: {
          kind: entry.kind ?? 'wav',
          extension: entry.extension ?? 'wav',
          role,
          channels: entry.channels ?? 0,
          fingerprint: entry.fingerprint ?? '',
          bytes: data.slice(),
        },
      });
      onProgress?.((index + 1) / manifest.media.length);
      await yieldToPage();
    }
    return { json: decoder.decode(document), media };
  } catch (cause) {
    throw new PersistenceError(
      'corrupt',
      `${file.name} is not an Axys project or is from a newer version.`,
      { cause },
    );
  }
}

/** Whether a file is a package, by its name or by its first bytes. */
export async function isPackage(file: File): Promise<boolean> {
  if (file.name.toLowerCase().endsWith(PACKAGE_EXTENSION)) return true;
  try {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  } catch {
    return false;
  }
}

function safeName(name: string): string {
  const stem = name
    .replace(/\.[^.]*$/, '')
    .replace(/[^\w \-.]+/g, '-')
    .trim();
  return stem.length > 0 ? stem : 'audio';
}

function uniquePath(path: string, used: Set<string>): string {
  let candidate = path;
  for (let n = 2; used.has(candidate); n += 1) {
    candidate = path.replace(/(\.[^./]+)$/, ` ${String(n)}$1`);
  }
  used.add(candidate);
  return candidate;
}

/**
 * The smallest integer depth that holds every sample exactly, or 32 for float.
 *
 * @remarks A sample decoded from an n-bit file is a whole number of 2^-(n-1) steps, and one
 * averaged from two such channels is half a step finer, so 16-bit audio mixed to mono still fits
 * 24 bits.
 */
export async function exactDepth(
  channels: readonly Float32Array[],
  tally?: Tally,
): Promise<16 | 24 | 32> {
  let fits16 = true;
  let fits24 = true;
  const frames = channels[0]?.length ?? 0;
  let start = 0;
  for (; start < frames && fits24; start += SLICE_FRAMES) {
    const end = Math.min(frames, start + SLICE_FRAMES);
    for (const channel of channels) {
      for (let i = start; i < end && fits24; i += 1) {
        const sample = channel[i] ?? 0;
        const wide = sample * 8388608;
        if (!Number.isInteger(wide) || wide < -8388608 || wide > 8388607) {
          fits24 = false;
          fits16 = false;
        } else if (fits16) {
          const narrow = sample * 32768;
          if (!Number.isInteger(narrow) || narrow < -32768 || narrow > 32767) fits16 = false;
        }
      }
    }
    await tally?.add(end - start);
  }
  // Float is settled as soon as one sample needs it, so the rest counts as read.
  if (start < frames) await tally?.add(frames - start);
  return fits16 ? 16 : fits24 ? 24 : 32;
}

/** How many bytes a WAV of `channels` at `depth` takes. */
export function wavBytes(channels: readonly Float32Array[], depth: 16 | 24 | 32): number {
  return 44 + (channels[0]?.length ?? 0) * Math.max(1, channels.length) * (depth / 8);
}

/**
 * A WAV of `channels`, interleaved, at the smallest depth that holds them exactly.
 *
 * @remarks `stride` is the bytes one frame takes. `known` skips finding the depth when the caller
 * already has it.
 */
export async function encodeWav(
  channels: readonly Float32Array[],
  sampleRate: number,
  tally?: Tally,
  known?: 16 | 24 | 32,
): Promise<{ data: Uint8Array<ArrayBuffer>; stride: number }> {
  const depth = known ?? (await exactDepth(channels, tally));
  const count = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const width = depth / 8;
  const stride = count * width;
  const dataBytes = frames * stride;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, depth === 32 ? 3 : 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * stride, true);
  view.setUint16(32, stride, true);
  view.setUint16(34, depth, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let start = 0; start < frames; start += SLICE_FRAMES) {
    const end = Math.min(frames, start + SLICE_FRAMES);
    let at = 44 + start * stride;
    for (let frame = start; frame < end; frame += 1) {
      for (let channel = 0; channel < count; channel += 1) {
        const sample = channels[channel]?.[frame] ?? 0;
        if (depth === 16) {
          view.setInt16(at, Math.round(sample * 32768), true);
        } else if (depth === 24) {
          const value = Math.round(sample * 8388608);
          bytes[at] = value & 0xff;
          bytes[at + 1] = (value >> 8) & 0xff;
          bytes[at + 2] = (value >> 16) & 0xff;
        } else {
          view.setFloat32(at, sample, true);
        }
        at += width;
      }
    }
    await tally?.add(end - start);
  }
  return { data: bytes, stride };
}

/**
 * Reads a WAV written by {@link encodeWav} back to its channels, bit for bit.
 *
 * @remarks Reads 16-bit and 24-bit integer PCM and 32-bit float, which is every depth a package
 * holds. `tally` counts bytes read.
 */
export async function decodeWav(
  bytes: Uint8Array,
  tally?: Tally,
): Promise<{ sampleRate: number; channels: Float32Array[] }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format: { count: number; rate: number; depth: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      const code = view.getUint16(body, true);
      const depth = view.getUint16(body + 14, true);
      const known = (code === 3 && depth === 32) || (code === 1 && (depth === 16 || depth === 24));
      if (!known) throw new Error('packaged audio is at a depth this build does not read');
      format = {
        count: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        depth,
      };
    } else if (id === 'data') {
      if (format === null || format.count === 0) throw new Error('WAV data before its format');
      const width = format.depth / 8;
      const stride = width * format.count;
      const frames = Math.floor(Math.min(size, bytes.length - body) / stride);
      const channels = Array.from({ length: format.count }, () => new Float32Array(frames));
      for (let start = 0; start < frames; start += SLICE_FRAMES) {
        const end = Math.min(frames, start + SLICE_FRAMES);
        let at = body + start * stride;
        for (let frame = start; frame < end; frame += 1) {
          for (const channel of channels) {
            if (format.depth === 16) {
              channel[frame] = view.getInt16(at, true) / 32768;
            } else if (format.depth === 24) {
              const low = (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
              // Sign-extended from the third byte.
              const value = low | (((bytes[at + 2] ?? 0) << 24) >> 8);
              channel[frame] = value / 8388608;
            } else {
              channel[frame] = view.getFloat32(at, true);
            }
            at += width;
          }
        }
        await tally?.add((end - start) * stride);
      }
      return { sampleRate: format.rate, channels };
    }
    offset = body + size + (size & 1);
  }
  throw new Error('WAV has no audio');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const CRC_START = 0xffffffff;

function crcOver(crc: number, data: Uint8Array, start: number, end: number): number {
  let value = crc;
  for (let i = start; i < end; i += 1) {
    value = (CRC_TABLE[(value ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (value >>> 8);
  }
  return value;
}

function finishCrc(crc: number): number {
  return (crc ^ 0xffffffff) >>> 0;
}

/** The CRC-32 of a WAV, a slice at a time, counting its frames of `stride` bytes as it goes. */
async function crc32(data: Uint8Array, tally: Tally, stride: number): Promise<number> {
  const step = SLICE_FRAMES * stride;
  let crc = CRC_START;
  for (let start = 0; start < data.length; start += step) {
    const end = Math.min(data.length, start + step);
    crc = crcOver(crc, data, start, end);
    await tally.add((end - start) / stride);
  }
  return finishCrc(crc);
}

/** A zip archive of `entries`, stored without compression. */
function writeZip(entries: readonly ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = entry.crc;
    const size = entry.data.length;
    if (size > 0xffffffff || offset > 0xffffffff) throw new Error('the package is too large');
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.data);

    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.length + size;
  }
  const centralSize = central.reduce((sum, record) => sum + record.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  parts.push(...central, end);
  return new Blob(parts, { type: 'application/zip' });
}

/**
 * Every file in a zip archive, by path.
 *
 * @remarks Reads stored and deflated entries, so a package re-zipped by another tool still opens.
 */
async function readZip(bytes: Uint8Array<ArrayBuffer>): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip archive');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('damaged zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const path = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error('damaged zip entry');
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    if (method === 0) {
      files.set(path, data);
    } else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      files.set(path, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else {
      throw new Error(`${path} uses an unsupported compression`);
    }
  }
  return files;
}
