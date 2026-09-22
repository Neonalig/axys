// SPDX-License-Identifier: AGPL-3.0-or-later

/** One probed browser capability. */
export interface Capability {
  id: string;
  label: string;
  available: boolean;
  required: boolean;
  detail: string;
}

interface GpuAdapterRequest {
  requestAdapter(): Promise<unknown>;
}

interface FormatProbe {
  id: string;
  label: string;
  mimes: string[];
  affected: string;
}

/** Milliseconds any single asynchronous probe may take before it is treated as unavailable. */
const PROBE_TIMEOUT_MS = 1500;

/**
 * Minimal WebAssembly module using shared memory and an atomic instruction.
 * Validates only where the threads proposal is implemented.
 */
const THREADS_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60, 0x00, 0x00, 0x03, 0x02,
  0x01, 0x00, 0x05, 0x04, 0x01, 0x03, 0x01, 0x01, 0x0a, 0x0b, 0x01, 0x09, 0x00, 0x41, 0x00, 0xfe,
  0x10, 0x02, 0x00, 0x1a, 0x0b,
]);

const FORMAT_PROBES: readonly FormatProbe[] = [
  {
    id: 'decode-wav',
    label: 'WAV Decoding',
    mimes: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
    affected: 'WAV',
  },
  {
    id: 'decode-flac',
    label: 'FLAC Decoding',
    mimes: ['audio/flac', 'audio/x-flac'],
    affected: 'FLAC',
  },
  {
    id: 'decode-mp3',
    label: 'MP3 Decoding',
    mimes: ['audio/mpeg', 'audio/mp3'],
    affected: 'MP3',
  },
  {
    id: 'decode-aac',
    label: 'AAC Decoding',
    mimes: ['audio/aac', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'],
    affected: 'AAC and M4A',
  },
  {
    id: 'decode-ogg',
    label: 'Ogg Decoding',
    mimes: ['audio/ogg; codecs=vorbis', 'audio/ogg; codecs=opus', 'audio/ogg'],
    affected: 'Ogg Vorbis and Opus',
  },
];

function globalRecord(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function hasGlobal(name: string): boolean {
  try {
    return globalRecord()[name] !== undefined;
  } catch {
    return false;
  }
}

function hasPrototypeMember(constructorName: string, member: string): boolean {
  try {
    const ctor = globalRecord()[constructorName];
    if (typeof ctor !== 'function') {
      return false;
    }
    const proto: unknown = (ctor as { prototype?: unknown }).prototype;
    return typeof proto === 'object' && proto !== null && member in proto;
  } catch {
    return false;
  }
}

function safe(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

async function safeAsync(probe: () => Promise<boolean>): Promise<boolean> {
  let started: Promise<boolean>;
  try {
    started = probe();
  } catch {
    return false;
  }
  const timeout = new Promise<boolean>((resolve) => {
    globalThis.setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([started.catch(() => false), timeout]);
  } catch {
    return false;
  }
}

function capability(
  id: string,
  label: string,
  required: boolean,
  available: boolean,
  whenAvailable: string,
  whenMissing: string,
): Capability {
  return { id, label, available, required, detail: available ? whenAvailable : whenMissing };
}

function probeWasm(): boolean {
  return safe(
    () => typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function',
  );
}

function probeAudioContext(): boolean {
  return hasGlobal('AudioContext') || hasGlobal('webkitAudioContext');
}

function probeAudioWorklet(): boolean {
  if (!hasGlobal('AudioWorkletNode')) {
    return false;
  }
  return (
    hasPrototypeMember('BaseAudioContext', 'audioWorklet') ||
    hasPrototypeMember('AudioContext', 'audioWorklet')
  );
}

function probeIndexedDb(): boolean {
  return safe(() => {
    const idb = globalRecord()['indexedDB'];
    return idb !== undefined && idb !== null && typeof idb === 'object';
  });
}

async function probeOpfs(): Promise<boolean> {
  return safeAsync(async () => {
    const storage: StorageManager | undefined = globalThis.navigator?.storage;
    if (typeof storage?.getDirectory !== 'function') {
      return false;
    }
    const root = await storage.getDirectory();
    return typeof root.getFileHandle === 'function';
  });
}

function probeOpfsSync(): boolean {
  return hasPrototypeMember('FileSystemFileHandle', 'createSyncAccessHandle');
}

function probeFilePickers(): boolean {
  return (
    typeof globalRecord()['showOpenFilePicker'] === 'function' &&
    typeof globalRecord()['showSaveFilePicker'] === 'function'
  );
}

function probeServiceWorker(): boolean {
  return safe(() => typeof globalThis.navigator?.serviceWorker === 'object');
}

function probeSecureContext(): boolean {
  return safe(() => globalThis.isSecureContext === true);
}

async function probeWebGpu(): Promise<boolean> {
  return safeAsync(async () => {
    const gpu = (globalThis.navigator as unknown as { gpu?: GpuAdapterRequest } | undefined)?.gpu;
    if (!gpu || typeof gpu.requestAdapter !== 'function') {
      return false;
    }
    const adapter = await gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  });
}

function probeSharedArrayBuffer(): boolean {
  return hasGlobal('SharedArrayBuffer');
}

function probeCrossOriginIsolated(): boolean {
  return safe(() => globalThis.crossOriginIsolated === true);
}

function probeWasmThreads(): boolean {
  return (
    probeSharedArrayBuffer() &&
    safe(() => typeof WebAssembly.validate === 'function' && WebAssembly.validate(THREADS_PROBE))
  );
}

function probeWebCodecs(): boolean {
  return hasGlobal('AudioDecoder') && hasGlobal('AudioData');
}

function probeFormat(mimes: readonly string[]): boolean {
  const mediaSource = globalRecord()['MediaSource'];
  if (typeof mediaSource === 'function') {
    const isTypeSupported = (mediaSource as { isTypeSupported?: (mime: string) => boolean })
      .isTypeSupported;
    if (typeof isTypeSupported === 'function') {
      for (const mime of mimes) {
        if (safe(() => isTypeSupported.call(mediaSource, mime))) {
          return true;
        }
      }
    }
  }
  if (typeof document === 'undefined') {
    return false;
  }
  const element = safeCreateAudioElement();
  if (element === null) {
    return false;
  }
  for (const mime of mimes) {
    const verdict = safe(() => element.canPlayType(mime) !== '');
    if (verdict) {
      return true;
    }
  }
  return false;
}

function safeCreateAudioElement(): HTMLAudioElement | null {
  try {
    return document.createElement('audio');
  } catch {
    return null;
  }
}

/** Probes every capability Axys cares about. Never throws. */
export async function probeCapabilities(): Promise<Capability[]> {
  const [opfs, webgpu] = await Promise.all([probeOpfs(), probeWebGpu()]);

  const caps: Capability[] = [
    capability(
      'wasm',
      'WebAssembly',
      true,
      probeWasm(),
      'The analysis, edit and render core runs here',
      'Axys cannot analyse, edit or render audio in this browser',
    ),
    capability(
      'audio-context',
      'Web Audio',
      true,
      probeAudioContext(),
      'Audio decoding and playback are available',
      'Audio cannot be decoded or played in this browser',
    ),
    capability(
      'audio-worklet',
      'Audio Worklet',
      true,
      probeAudioWorklet(),
      'Processed playback runs on the realtime audio thread',
      'Processed playback is unavailable without AudioWorklet',
    ),
    capability(
      'secure-context',
      'Secure Context',
      true,
      probeSecureContext(),
      'The page is served over HTTPS or localhost',
      'Serve Axys over HTTPS or localhost; audio worklets and local storage need a secure context',
    ),
    capability(
      'indexed-db',
      'Project Storage',
      true,
      probeIndexedDb(),
      'Projects are saved on this device',
      'Projects cannot be saved; export a project file before closing the tab',
    ),
    capability(
      'opfs',
      'Media Storage',
      false,
      opfs,
      'Decoded audio is cached between sessions',
      'Decoded audio is not cached, so reopening a project decodes the source file again',
    ),
    capability(
      'service-worker',
      'Offline Install',
      false,
      probeServiceWorker(),
      'Axys runs with no network after one visit, and can be installed as an app',
      'Axys needs the network on every visit and cannot be installed as an app',
    ),
    capability(
      'file-pickers',
      'File Pickers',
      false,
      probeFilePickers(),
      'Saving asks where the file goes and writes there again without asking',
      'Every save downloads to the browser download folder; Save As cannot offer a picker',
    ),
    capability(
      'opfs-sync',
      'Sync File Access',
      false,
      probeOpfsSync(),
      'Cached audio is written with fast sync access handles',
      'Cached audio is written through the slower streaming path',
    ),
    capability(
      'webgpu',
      'WebGPU',
      false,
      webgpu,
      'A GPU adapter is available for renderer measurements',
      'The editor draws with Canvas 2D, which is the default renderer either way',
    ),
    capability(
      'shared-array-buffer',
      'Shared Memory',
      false,
      probeSharedArrayBuffer(),
      'Shared memory is available to the analysis core',
      'Analysis runs single-threaded, which is slower on long takes',
    ),
    capability(
      'cross-origin-isolated',
      'Cross-Origin Isolation',
      false,
      probeCrossOriginIsolated(),
      'The page is cross-origin isolated, so threading can be used',
      'Without the isolation headers threading stays off and analysis is slower',
    ),
    capability(
      'wasm-threads',
      'WASM Threads',
      false,
      probeWasmThreads(),
      'The core can analyse audio on several threads',
      'The core analyses audio on one thread, which is slower on long takes',
    ),
    capability(
      'web-codecs',
      'WebCodecs',
      false,
      probeWebCodecs(),
      'WebCodecs is available as an extra decoding path',
      'Decoding uses Web Audio only, which covers the formats listed below',
    ),
  ];

  for (const format of FORMAT_PROBES) {
    caps.push(
      capability(
        format.id,
        format.label,
        false,
        probeFormat(format.mimes),
        `${format.affected} files can be imported.`,
        `${format.affected} files must be converted to WAV before import.`,
      ),
    );
  }

  return caps;
}

/** True when every required capability is available. */
export function isSupported(caps: Capability[]): boolean {
  return caps.every((cap) => !cap.required || cap.available);
}
