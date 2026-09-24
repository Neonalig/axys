// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One source's audio as it is kept on the device and carried in a package.
 *
 * The audio is kept as whichever is smaller of two files that both give back the exact samples in
 * use: the file it was imported from, which the core decodes the same way every time, or a WAV of
 * the samples at the smallest depth that holds them. A file the core cannot decode exactly, and
 * audio a relink padded or trimmed, can only be kept as the WAV.
 */

import { decodeAudioFile } from '../audio/decode.js';
import { decodeWav, encodeWav, exactDepth, wavBytes } from './package.js';
import type { Tally } from './package.js';

/** How a stored file becomes the samples a source holds. */
export type StoredRole = 'mono' | 'channels';

/**
 * One source's audio, kept as a file.
 *
 * @remarks `role` says what to take from it: the decoded mono mix, which a clip holds, or its
 * first `channels` channels, which a reference holds. `fingerprint` is the decoder's digest of an
 * original, checked when it is decoded again; a WAV needs no check.
 */
export interface StoredAudio {
  kind: 'original' | 'wav';
  /** The file's extension, without the dot. */
  extension: string;
  role: StoredRole;
  channels: number;
  fingerprint: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Where a source's audio came from, when decoding that file again gives the same samples. */
export interface AudioOrigin {
  file: File;
  /** The decoder's digest of the file at the project rate. */
  fingerprint: string;
}

/** Marks the start of a stored-audio container. */
const MAGIC = 0x41594141;

/** Wraps a stored file with the facts needed to read it back, as bytes. */
export function serialiseStored(stored: StoredAudio): Uint8Array<ArrayBuffer> {
  const header = new TextEncoder().encode(
    JSON.stringify({
      kind: stored.kind,
      extension: stored.extension,
      role: stored.role,
      channels: stored.channels,
      fingerprint: stored.fingerprint,
    }),
  );
  const bytes = new Uint8Array(8 + header.length + stored.bytes.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.length, true);
  bytes.set(header, 8);
  bytes.set(stored.bytes, 8 + header.length);
  return bytes;
}

/** Reads bytes written by {@link serialiseStored}, or `null` when they are not one. */
export function parseStored(bytes: Uint8Array<ArrayBuffer>): StoredAudio | null {
  if (bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC) return null;
  const length = view.getUint32(4, true);
  if (8 + length > bytes.length) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + length))) as Omit<
      StoredAudio,
      'bytes'
    >;
    if (header.kind !== 'original' && header.kind !== 'wav') return null;
    return { ...header, bytes: bytes.slice(8 + length) };
  } catch {
    return null;
  }
}

/** A file name's last extension, lower case and without the dot, or empty. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/**
 * The smaller exact way to keep `channels`: the original file, or a WAV of the samples.
 *
 * @remarks `origin` is only given when decoding it again gives exactly `channels` back, so the
 * original is never chosen for audio it would not reproduce.
 */
export async function storeAudio(options: {
  channels: readonly Float32Array[];
  role: StoredRole;
  sampleRate: number;
  origin?: AudioOrigin | undefined;
  tally?: Tally;
}): Promise<StoredAudio> {
  const { channels, role, sampleRate, origin } = options;
  const depth = await exactDepth(channels, options.tally);
  const repacked = wavBytes(channels, depth);
  if (origin !== undefined && origin.file.size < repacked) {
    return {
      kind: 'original',
      extension: extensionOf(origin.file.name),
      role,
      channels: channels.length,
      fingerprint: origin.fingerprint,
      bytes: new Uint8Array(await origin.file.arrayBuffer()),
    };
  }
  const { data } = await encodeWav(channels, sampleRate, options.tally, depth);
  return {
    kind: 'wav',
    extension: 'wav',
    role,
    channels: channels.length,
    fingerprint: '',
    bytes: data,
  };
}

/**
 * The samples a stored file holds, at `sampleRate`, or `null` when an original no longer decodes
 * to the audio it was kept for.
 */
export async function restoreAudio(
  stored: StoredAudio,
  sampleRate: number,
): Promise<Float32Array[] | null> {
  if (stored.kind === 'wav') {
    const { channels } = await decodeWav(stored.bytes);
    return channels;
  }
  const file = new File([stored.bytes], `source.${stored.extension}`);
  let decoded;
  try {
    decoded = await decodeAudioFile(file, sampleRate);
  } catch {
    return null;
  }
  if (!decoded.exact || decoded.fingerprint !== stored.fingerprint) return null;
  if (stored.role === 'mono') return [decoded.mono];
  return decoded.channelData.slice(0, stored.channels).map((channel) => channel.slice());
}
