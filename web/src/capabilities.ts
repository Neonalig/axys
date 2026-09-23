// SPDX-License-Identifier: AGPL-3.0-or-later

import { browserLabel } from './browser.js';

/** One probed browser capability. */
export interface Capability {
  id: string;
  label: string;
  available: boolean;
  required: boolean;
  /** What having or lacking the capability means for Axys. */
  detail: string;
  /** Why the probe found it available or not in this browser. */
  reason: string;
}

interface GpuAdapterRequest {
  requestAdapter(): Promise<unknown>;
}

interface FormatProbe {
  id: string;
  label: string;
  mimes: string[];
  /** The format as named in a sentence, such as "FLAC" or "AAC and M4A". */
  format: string;
}

/** Most span workers parallel analysis starts, matching the analysis worker's pool. */
const MAX_ANALYSIS_THREADS = 8;

/** Milliseconds any single asynchronous probe may take before it is treated as unavailable. */
const PROBE_TIMEOUT_MS = 1500;

const FORMAT_PROBES: readonly FormatProbe[] = [
  {
    id: 'decode-wav',
    label: 'WAV Decoding',
    mimes: ['audio/wav', 'audio/wave', 'audio/x-wav', 'audio/vnd.wave'],
    format: 'WAV',
  },
  {
    id: 'decode-flac',
    label: 'FLAC Decoding',
    mimes: ['audio/flac', 'audio/x-flac'],
    format: 'FLAC',
  },
  {
    id: 'decode-mp3',
    label: 'MP3 Decoding',
    mimes: ['audio/mpeg', 'audio/mp3'],
    format: 'MP3',
  },
  {
    id: 'decode-aac',
    label: 'AAC Decoding',
    mimes: ['audio/aac', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4'],
    format: 'AAC and M4A',
  },
  {
    id: 'decode-ogg',
    label: 'Ogg Decoding',
    mimes: ['audio/ogg; codecs=vorbis', 'audio/ogg; codecs=opus', 'audio/ogg'],
    format: 'Ogg Vorbis and Opus',
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

/** Text for a capability that is available, then for one that is not. */
type Either = readonly [whenAvailable: string, whenMissing: string];

function capability(
  id: string,
  label: string,
  required: boolean,
  available: boolean,
  detail: Either,
  reason: Either,
): Capability {
  const pick = available ? 0 : 1;
  return { id, label, available, required, detail: detail[pick], reason: reason[pick] };
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

function probeCrossOriginIsolated(): boolean {
  return safe(() => globalThis.crossOriginIsolated === true);
}

/** Logical cores the device reports, or 1 when it does not say. */
function logicalCores(): number {
  try {
    const cores = globalThis.navigator?.hardwareConcurrency;
    return typeof cores === 'number' && cores > 0 ? cores : 1;
  } catch {
    return 1;
  }
}

function probeWebCodecs(): boolean {
  return hasGlobal('AudioDecoder') && hasGlobal('AudioData');
}

/** The first of `mimes` the browser reports it can decode, or `null` for none. */
function probeFormat(mimes: readonly string[]): string | null {
  const mediaSource = globalRecord()['MediaSource'];
  if (typeof mediaSource === 'function') {
    const isTypeSupported = (mediaSource as { isTypeSupported?: (mime: string) => boolean })
      .isTypeSupported;
    if (typeof isTypeSupported === 'function') {
      for (const mime of mimes) {
        if (safe(() => isTypeSupported.call(mediaSource, mime))) {
          return mime;
        }
      }
    }
  }
  if (typeof document === 'undefined') {
    return null;
  }
  const element = safeCreateAudioElement();
  if (element === null) {
    return null;
  }
  for (const mime of mimes) {
    const verdict = safe(() => element.canPlayType(mime) !== '');
    if (verdict) {
      return mime;
    }
  }
  return null;
}

function safeCreateAudioElement(): HTMLAudioElement | null {
  try {
    return document.createElement('audio');
  } catch {
    return null;
  }
}

/** A tooltip section listing browsers, one per line. */
function browserList(heading: string, browsers: readonly string[]): string {
  return `${heading}:\n${browsers.map((browser) => `- ${browser}`).join('\n')}`;
}

/** Reasons for a browser feature: supported, or not supported with the browsers that are. */
function support(
  feature: string,
  browser: string,
  browsers: readonly string[],
  note?: string,
): Either {
  const missing = [
    `${feature} is not supported by ${browser}.`,
    browserList('Supported Browsers', browsers),
  ];
  if (note !== undefined) missing.push(note);
  return [`${feature} is supported by ${browser}.`, missing.join('\n\n')];
}

/** Reasons for a feature a supporting browser can still switch off. */
function availability(
  feature: string,
  browser: string,
  browsers: readonly string[],
  cause: string,
): Either {
  return [
    `${feature} is available in ${browser}.`,
    [
      `${feature} is not available in ${browser}.`,
      cause,
      browserList('Supported Browsers', browsers),
    ].join('\n\n'),
  ];
}

/** Probes every capability Axys cares about. Never throws. */
export async function probeCapabilities(): Promise<Capability[]> {
  const [opfs, webgpu] = await Promise.all([probeOpfs(), probeWebGpu()]);
  const browser = browserLabel();
  const secure = probeSecureContext();
  const insecure = 'Requires a secure context. Serve Axys over HTTPS or from localhost.';
  const workers = hasGlobal('Worker');
  const cores = logicalCores();
  const threads = Math.min(MAX_ANALYSIS_THREADS, cores);

  const caps: Capability[] = [
    capability(
      'wasm',
      'WebAssembly',
      true,
      probeWasm(),
      ['Runs the audio engine', 'Required to analyse, edit and render audio'],
      support(
        'WebAssembly',
        browser,
        ['Chrome 57+', 'Edge 16+', 'Firefox 52+', 'Safari 11+'],
        'Lockdown and enhanced security modes can disable WebAssembly.',
      ),
    ),
    capability(
      'audio-context',
      'Web Audio',
      true,
      probeAudioContext(),
      ['Decodes and plays audio', 'Required to decode and play audio'],
      support('Web Audio API', browser, ['Chrome 35+', 'Edge 12+', 'Firefox 25+', 'Safari 14.1+']),
    ),
    capability(
      'audio-worklet',
      'Audio Worklet',
      true,
      probeAudioWorklet(),
      ['Plays processed audio in real time', 'Required for processed playback'],
      support(
        'AudioWorklet',
        browser,
        ['Chrome 66+', 'Edge 79+', 'Firefox 76+', 'Safari 14.1+'],
        secure ? undefined : insecure,
      ),
    ),
    capability(
      'secure-context',
      'Secure Context',
      true,
      secure,
      [
        'Enables Audio Worklet, storage and offline install',
        'Required for Audio Worklet and storage',
      ],
      [
        safe(() => globalThis.location.protocol === 'https:')
          ? 'Page is served over HTTPS.'
          : 'Page is served from localhost.',
        'Page is served over insecure HTTP.\n\nServe Axys over HTTPS or from localhost.',
      ],
    ),
    capability(
      'indexed-db',
      'Project Storage',
      true,
      probeIndexedDb(),
      ['Saves projects on this device', 'Projects cannot be saved. Export before closing.'],
      availability(
        'IndexedDB',
        browser,
        ['Chrome 24+', 'Edge 12+', 'Firefox 16+', 'Safari 10+'],
        'Private browsing or blocked site data can disable IndexedDB.',
      ),
    ),
    capability(
      'opfs',
      'Media Storage',
      false,
      opfs,
      ['Caches decoded audio between visits', 'Audio is decoded again on every open'],
      availability(
        'Origin Private File System',
        browser,
        ['Chrome 86+', 'Edge 86+', 'Firefox 111+', 'Safari 15.2+'],
        'Private browsing or blocked site data can disable OPFS.',
      ),
    ),
    capability(
      'service-worker',
      'Offline Install',
      false,
      probeServiceWorker(),
      ['Runs offline and installs as an app', 'Requires a connection on every visit'],
      availability(
        'Service Workers',
        browser,
        ['Chrome 40+', 'Edge 17+', 'Firefox 44+', 'Safari 11.1+'],
        secure ? 'Private browsing can disable service workers.' : insecure,
      ),
    ),
    capability(
      'file-pickers',
      'File Pickers',
      false,
      probeFilePickers(),
      ['Save and Save As write to a chosen file', 'Saves go to the Downloads folder'],
      support('File System Access API', browser, [
        'Chrome 86+',
        'Edge 86+',
        'Opera 72+',
        'Brave (requires flag: brave://flags/#file-system-access-api)',
      ]),
    ),
    capability(
      'parallel-analysis',
      'Parallel Analysis',
      false,
      workers && cores > 1,
      [`Analyses long takes on ${threads} threads`, 'Analyses on one thread'],
      workers
        ? [
            `${browser} reports ${cores} logical processors.`,
            `${browser} reports 1 logical processor.\n\nParallel analysis requires 2 or more.`,
          ]
        : support('Web Workers', browser, ['Chrome 4+', 'Edge 12+', 'Firefox 3.5+', 'Safari 4+']),
    ),
    capability(
      'cross-origin-isolated',
      'Cross-Origin Isolation',
      false,
      probeCrossOriginIsolated(),
      ['Isolated from other sites', 'Not isolated from other sites'],
      [
        'Cross-origin isolation is enabled.',
        secure
          ? `Cross-origin isolation is not enabled.\n\n${browserList('Required Headers', [
              'Cross-Origin-Opener-Policy: same-origin',
              'Cross-Origin-Embedder-Policy: require-corp',
            ])}`
          : `Cross-origin isolation is not enabled.\n\n${insecure}`,
      ],
    ),
    capability(
      'webgpu',
      'WebGPU',
      false,
      webgpu,
      ['Available for renderer measurements', 'Not used by the current renderer'],
      support(
        'WebGPU',
        browser,
        ['Chrome 113+', 'Edge 113+', 'Firefox 141+ (Windows)', 'Safari 26+'],
        'An unsupported GPU or driver can also block WebGPU.',
      ),
    ),
    capability(
      'web-codecs',
      'WebCodecs',
      false,
      probeWebCodecs(),
      ['Extra decoding path', 'Decoding uses Web Audio'],
      support('WebCodecs AudioDecoder', browser, [
        'Chrome 94+',
        'Edge 94+',
        'Firefox 130+',
        'Safari 26+',
      ]),
    ),
  ];

  for (const probe of FORMAT_PROBES) {
    const mime = probeFormat(probe.mimes);
    caps.push(
      capability(
        probe.id,
        probe.label,
        false,
        mime !== null,
        [`${probe.format} files can be imported`, 'Convert to WAV before import'],
        [
          `${probe.format} decoding is supported by ${browser} (${mime ?? ''}).`,
          `${probe.format} decoding is not supported by ${browser}.\n\nConvert files to WAV before import.`,
        ],
      ),
    );
  }

  return caps;
}

/** True when every required capability is available. */
export function isSupported(caps: Capability[]): boolean {
  return caps.every((cap) => !cap.required || cap.available);
}
