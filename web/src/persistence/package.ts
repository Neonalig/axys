// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Projects saved with their audio, as one file.
 *
 * A package is a zip archive: the project document, a manifest, and each source's decoded audio
 * as a 32-bit float WAV at the project rate. The audio is the exact PCM the project fingerprinted,
 * so a package opens anywhere with nothing to relink, and any zip tool can take the audio out.
 */

import { PersistenceError } from './db.js';

/** File extension every packaged project carries. */
export const PACKAGE_EXTENSION = '.axys';

/** Where the project document sits inside a package. */
const DOCUMENT_PATH = 'project.axys.json';

/** Where the manifest sits inside a package. */
const MANIFEST_PATH = 'manifest.json';

/** Package layout version this build writes. */
const PACKAGE_VERSION = 1;

/** One source's audio, keyed the way the media store keys it. */
export interface PackagedMedia {
  /** The media store key: a fingerprint, with `-reference` for a reference's channels. */
  key: string;
  /** File name inside the package, without the folder. */
  name: string;
  sampleRate: number;
  /** Each channel's samples, every channel the same length. */
  channels: readonly Float32Array[];
}

/** A package read back: its document and its audio. */
export interface UnpackedProject {
  json: string;
  media: PackagedMedia[];
}

interface Manifest {
  version: number;
  media: { key: string; path: string }[];
}

/** Builds a package from a project document and its sources' audio. */
export function packProject(json: string, media: readonly PackagedMedia[]): Blob {
  const encoder = new TextEncoder();
  const used = new Set<string>();
  const entries: { path: string; data: Uint8Array<ArrayBuffer> }[] = [];
  const manifest: Manifest = { version: PACKAGE_VERSION, media: [] };
  for (const item of media) {
    const path = uniquePath(`audio/${safeName(item.name)}.wav`, used);
    entries.push({ path, data: encodeFloatWav(item.channels, item.sampleRate) });
    manifest.media.push({ key: item.key, path });
  }
  entries.unshift(
    { path: DOCUMENT_PATH, data: encoder.encode(json) },
    { path: MANIFEST_PATH, data: encoder.encode(JSON.stringify(manifest, null, 2)) },
  );
  return writeZip(entries);
}

/**
 * Reads a package back.
 *
 * @throws PersistenceError with kind `corrupt` when the file is not a package this build reads.
 */
export async function unpackProject(file: File): Promise<UnpackedProject> {
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
    for (const entry of manifest.media) {
      const data = entries.get(entry.path);
      if (data === undefined) throw new Error(`${entry.path} is missing`);
      const { sampleRate, channels } = decodeFloatWav(data);
      media.push({ key: entry.key, name: entry.path, sampleRate, channels });
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
    candidate = path.replace(/\.wav$/, ` ${String(n)}.wav`);
  }
  used.add(candidate);
  return candidate;
}

/** A 32-bit float WAV of `channels`, interleaved. */
export function encodeFloatWav(
  channels: readonly Float32Array[],
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const count = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * count * 4;
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
  view.setUint16(20, 3, true);
  view.setUint16(22, count, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * count * 4, true);
  view.setUint16(32, count * 4, true);
  view.setUint16(34, 32, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      view.setFloat32(offset, channels[channel]?.[frame] ?? 0, true);
      offset += 4;
    }
  }
  return bytes;
}

/** Reads a 32-bit float WAV back to its channels, bit for bit. */
export function decodeFloatWav(bytes: Uint8Array): {
  sampleRate: number;
  channels: Float32Array[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let format: { count: number; rate: number } | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (view.getUint16(body, true) !== 3 || view.getUint16(body + 14, true) !== 32) {
        throw new Error('packaged audio is not 32-bit float');
      }
      format = { count: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true) };
    } else if (id === 'data') {
      if (format === null || format.count === 0) throw new Error('WAV data before its format');
      const frames = Math.floor(Math.min(size, bytes.length - body) / (4 * format.count));
      const channels = Array.from({ length: format.count }, () => new Float32Array(frames));
      let at = body;
      for (let frame = 0; frame < frames; frame += 1) {
        for (const channel of channels) {
          channel[frame] = view.getFloat32(at, true);
          at += 4;
        }
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

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A zip archive of `entries`, stored without compression. */
function writeZip(entries: readonly { path: string; data: Uint8Array<ArrayBuffer> }[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [];
  const central: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const crc = crc32(entry.data);
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
