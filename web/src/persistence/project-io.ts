// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Explicit project file exchange.
 *
 * A project leaves the browser as a `.axys.json` document the user owns, comes back validated,
 * and relinks only to media whose fingerprint matches the one the project recorded.
 */

import { isProject, parseJson } from '../core/json';
import type { Project, SourceInfo } from '../core/types';
import { PersistenceError } from './db';

/** File extension every exported project carries. */
export const PROJECT_EXTENSION = '.axys.json';

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

const scratch = new DataView(new ArrayBuffer(4));

/**
 * FNV-1a 64-bit digest of mono PCM, rendered as 16 lowercase hex characters.
 *
 * @remarks Mirrors `axys_core::project::fingerprint`, including its normalisation of negative
 * zero and its trailing length word.
 */
export function fingerprint(samples: Float32Array): string {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0;
    scratch.setFloat32(0, sample, true);
    const bits = sample === 0 ? 0 : scratch.getUint32(0, true);
    for (let shift = 0; shift < 32; shift += 8) {
      hash = ((hash ^ BigInt((bits >>> shift) & 0xff)) * FNV_PRIME) & MASK_64;
    }
  }
  let length = BigInt(samples.length) & MASK_64;
  for (let byte = 0; byte < 8; byte += 1) {
    hash = ((hash ^ (length & 0xffn)) * FNV_PRIME) & MASK_64;
    length >>= 8n;
  }
  return hash.toString(16).padStart(16, '0');
}

function sanitise(name: string): string {
  const trimmed = name.trim().replace(/\.axys\.json$/i, '');
  const safe = trimmed
    .replace(/[^\w \-.]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return safe.length > 0 ? safe : 'Untitled';
}

/**
 * Downloads a project document as a `.axys.json` file.
 *
 * @param json Project document, validated before the download starts.
 * @param name Base file name; the extension is added.
 * @returns The file name offered to the browser.
 * @throws PersistenceError when the document is not a project.
 */
export function exportProject(json: string, name: string): string {
  try {
    parseJson(json, isProject, 'project');
  } catch (cause) {
    throw new PersistenceError('corrupt', 'Document is not a valid project', {
      cause,
    });
  }
  const fileName = `${sanitise(name)}${PROJECT_EXTENSION}`;
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
  return fileName;
}

/** A project document read back from disk, with the document text the core reopens from. */
export interface ImportedProject {
  json: string;
  project: Project;
}

/**
 * Reads a `.axys.json` file back and validates it against the project contract.
 *
 * @param read Brings a document of any supported schema version up to the current one and
 * validates it, which is the core's to do because it owns the migration.
 * @throws PersistenceError with kind `corrupt` when the file is not a readable project.
 */
export async function importProject(
  file: File,
  read: (json: string) => ImportedProject,
): Promise<ImportedProject> {
  let text: string;
  try {
    text = await file.text();
  } catch (cause) {
    throw new PersistenceError('io', `Could not read ${file.name}.`, { cause });
  }
  try {
    return read(text);
  } catch (cause) {
    throw new PersistenceError(
      'corrupt',
      `${file.name} is not an Axys project or is from a newer version.`,
      { cause },
    );
  }
}

/** Mixes decoded channels down to mono the way the core does. */
function toMono(buffer: AudioBuffer): Float32Array {
  const frames = buffer.length;
  const channels = buffer.numberOfChannels;
  if (frames === 0 || channels === 0) return new Float32Array(0);
  if (channels === 1) return buffer.getChannelData(0).slice();
  const mono = new Float32Array(frames);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < frames; i += 1) {
      mono[i] = (mono[i] ?? 0) + (data[i] ?? 0);
    }
  }
  const scale = 1 / channels;
  for (let i = 0; i < frames; i += 1) {
    mono[i] = (mono[i] ?? 0) * scale;
  }
  return mono;
}

async function decodeAt(file: File, sampleRate: number): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const context = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate });
  return await context.decodeAudioData(bytes);
}

/** Source audio accepted for a relink, decoded at the project's own sample rate. */
export interface RelinkedSource {
  samples: Float32Array;
  source: SourceInfo;
}

/**
 * Decodes a replacement media file and accepts it only when it is the same audio.
 *
 * @param file Media the user picked.
 * @param expected Source the project recorded.
 * @throws PersistenceError with kind `corrupt` when the file decodes to different audio.
 */
export async function relink(file: File, expected: SourceInfo): Promise<RelinkedSource> {
  let buffer: AudioBuffer;
  try {
    buffer = await decodeAt(file, expected.sampleRate);
  } catch (cause) {
    throw new PersistenceError(
      'corrupt',
      `${file.name} could not be decoded. Try WAV, FLAC or MP3.`,
      { cause },
    );
  }
  const samples = toMono(buffer);
  const digest = fingerprint(samples);
  if (digest !== expected.fingerprint) {
    throw new PersistenceError(
      'corrupt',
      `${file.name} does not match ${expected.name}. Choose the original file.`,
    );
  }
  return {
    samples,
    source: {
      name: file.name,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      frames: samples.length,
      duration: samples.length / buffer.sampleRate,
      fingerprint: digest,
      mime: file.type.length > 0 ? file.type : null,
    },
  };
}
