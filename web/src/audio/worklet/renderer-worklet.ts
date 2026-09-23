// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The realtime renderer, and the only place processed playback is produced.
 *
 * The processor instantiates the WebAssembly core itself, owns the source PCM and a
 * `PlaybackRenderer`, and answers each block from the renderer at the current output position.
 * It holds no import of its own at runtime, because an `AudioWorklet` module is loaded as one
 * file and the worklet scope offers neither `fetch` nor the text codecs the generated bindings
 * use, so the small wasm-bindgen calling convention the renderer needs is implemented here.
 */

import { clipLevels, DEFAULT_MIXER, mixLevels, referenceLevel } from '../mixer.js';
import type { MixLevels } from '../mixer.js';
import type { MixerSettings } from '../../core/types.js';

declare const sampleRate: number;

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

declare function registerProcessor(name: string, processor: AudioWorkletProcessorConstructor): void;

type AudioWorkletProcessorConstructor = new () => {
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
};

/** Name the main thread constructs the processor by. */
export const RENDERER_PROCESSOR = 'axys-renderer';

/** A loop or audition range in output seconds. */
export interface OutputRange {
  start: number;
  end: number;
}

/** One clip's plan, as UTF-8 JSON, and where the clip sits in project seconds. */
export interface ClipPlacement {
  clip: number;
  position: number;
  plan: Uint8Array;
}

/** What the main thread asks the renderer to do. */
export type EngineMessage =
  // The module crosses as bytes, not as a compiled WebAssembly.Module. An AudioWorklet
  // is a separate agent cluster, and a Module posted across one is dropped silently:
  // no exception on the sending side and no message on the receiving side.
  | { type: 'init'; bytes: ArrayBuffer }
  // Starts a project over: drops every source and sets the rate they are all held at.
  | { type: 'project'; sampleRate: number }
  | {
      type: 'clip';
      id: number;
      samples: ArrayBuffer;
      track: Uint8Array;
      plan: Uint8Array;
      position: number;
    }
  // Every clip on the lane; a loaded clip left out is off the lane and silent.
  | { type: 'plans'; plans: ClipPlacement[] }
  | {
      type: 'reference';
      id: number;
      left: ArrayBuffer;
      /** The second channel, or `null` for a mono reference. */
      right: ArrayBuffer | null;
      position: number;
    }
  // Every reference in the project; a loaded one left out is silent.
  | { type: 'placements'; references: { id: number; position: number }[] }
  | { type: 'unload' }
  | { type: 'mixer'; mixer: MixerSettings }
  | { type: 'play'; from: number | null; countIn: boolean; seq: number }
  | { type: 'pause'; seq: number }
  | { type: 'seek'; seconds: number; seq: number }
  | { type: 'loop'; range: OutputRange | null }
  // Seconds of silence the transport plays past the last source before it ends.
  | { type: 'tail'; seconds: number }
  | { type: 'metronome'; on: boolean; clicks: Float64Array; accents: Uint8Array }
  | { type: 'audition'; start: number; end: number; seq: number }
  | { type: 'dispose' };

/**
 * The loudest sample each strip sent to the output since the last report, after its fader.
 *
 * @remarks Linear amplitude, the larger of the two sides. A source that was not heard reads 0.
 */
export interface MeterReport {
  clips: { clip: number; processed: number; original: number }[];
  references: { reference: number; peak: number }[];
  click: number;
  master: number;
}

/**
 * What the renderer reports back.
 *
 * @remarks `seq` echoes the newest transport command the renderer has applied. A report is in
 * flight for up to one block, so the main thread uses it to tell a report that predates its
 * latest command from one that answers it.
 */
export type RendererMessage =
  | { type: 'ready'; clip: number; sourceRate: number }
  | { type: 'length'; outputSeconds: number }
  | {
      type: 'status';
      position: number;
      playing: boolean;
      underruns: number;
      failure: string | null;
      seq: number;
      meters: MeterReport;
    }
  | { type: 'ended'; position: number; seq: number; reason: EndReason };

/**
 * Why the transport stopped on its own.
 *
 * @remarks A snippet restores the position it interrupted, so it must not be treated as
 * reaching the end of the take, which is what returns the playhead to the beginning.
 */
export type EndReason = 'end' | 'audition';

const COUNT_IN_BEATS = 4;
const DEFAULT_BEAT_SECONDS = 0.5;
const CLICK_SECONDS = 0.035;
const ACCENT_HZ = 1760;
const BEAT_HZ = 880;
const TWO_PI = Math.PI * 2;
const MAX_SEGMENTS_PER_BLOCK = 8;

/**
 * How often the renderer reports its position, in frames.
 *
 * @remarks The playhead is drawn from these reports, so a slow report rate reads as a
 * stuttering playhead however smooth the audio is. About 20 Hz costs one small message
 * per 50 ms and is below the frame rate the editor redraws at.
 */
const REPORT_INTERVAL_FRAMES = 2048;

type WasmFunction = (...args: number[]) => unknown;

/**
 * The slice of the compiled core the realtime path uses.
 *
 * @remarks Implements the wasm-bindgen calling convention directly: multi-value returns, the
 * externref table for errors, and `__wbindgen_malloc` and `__wbindgen_free` for buffers.
 */
class Core {
  #exports: WebAssembly.Exports = {};
  #memory: WebAssembly.Memory | null = null;
  #bytes: Uint8Array = new Uint8Array(0);
  #floats: Float32Array = new Float32Array(0);
  #buffer: ArrayBufferLike | null = null;

  #malloc: WasmFunction = unbound;
  #free: WasmFunction = unbound;
  #rendererCreate: WasmFunction = unbound;
  #rendererSetPlan: WasmFunction = unbound;
  #rendererOutputFrames: WasmFunction = unbound;
  #rendererRender: WasmFunction = unbound;
  #rendererFree: WasmFunction = unbound;

  /** Instantiates a compiled core module for this thread. */
  static instantiate(module: WebAssembly.Module): Core {
    const core = new Core();
    const instance = new WebAssembly.Instance(module, core.#importsFor(module));
    core.#bind(instance.exports);
    return core;
  }

  /** Builds a renderer over the source PCM, its pitch track and a compiled plan. */
  createRenderer(samples: Float32Array, track: Uint8Array, plan: Uint8Array): number {
    const samplesPtr = this.#writeFloats(samples);
    const trackPtr = this.#writeBytes(track);
    const planPtr = this.#writeBytes(plan);
    const returned = this.#rendererCreate(
      samplesPtr,
      samples.length,
      trackPtr,
      track.length,
      planPtr,
      plan.length,
      0,
    );
    const values = this.#values(returned, 3);
    if (Number(values[2]) !== 0) throw this.#takeError(Number(values[1]));
    return Number(values[0]);
  }

  /** Replaces a renderer's plan in place. */
  setPlan(renderer: number, plan: Uint8Array): void {
    const planPtr = this.#writeBytes(plan);
    const values = this.#values(this.#rendererSetPlan(renderer, planPtr, plan.length), 2);
    if (Number(values[1]) !== 0) throw this.#takeError(Number(values[0]));
  }

  /** Total output length of the current plan, in samples. */
  outputFrames(renderer: number): number {
    return Number(this.#rendererOutputFrames(renderer)) >>> 0;
  }

  /**
   * Renders `count` samples from output sample `start` into `destination`.
   *
   * @remarks Copies out of core memory rather than returning a view, so nothing on the audio
   * thread holds a pointer across a heap growth.
   */
  render(renderer: number, start: number, count: number, destination: Float32Array): void {
    const returned = this.#rendererRender(renderer, start, count);
    if (!Array.isArray(returned)) throw new Error('the core returned no audio');
    const ptr = Number(returned[0]);
    const length = Number(returned[1]);
    const floats = this.#floatView();
    const offset = ptr / 4;
    const shared = Math.min(count, length);
    for (let i = 0; i < shared; i += 1) destination[i] = floats[offset + i] ?? 0;
    for (let i = shared; i < count; i += 1) destination[i] = 0;
    this.#free(ptr, length * 4, 4);
  }

  /** Releases a renderer. */
  freeRenderer(renderer: number): void {
    this.#rendererFree(renderer, 0);
  }

  #bind(exports: WebAssembly.Exports): void {
    this.#exports = exports;
    const memory = exports['memory'];
    if (!(memory instanceof WebAssembly.Memory)) throw new Error('the core exports no memory');
    this.#memory = memory;
    this.#malloc = this.#function('__wbindgen_malloc');
    this.#free = this.#function('__wbindgen_free');
    this.#rendererCreate = this.#function('playbackrenderer_create');
    this.#rendererSetPlan = this.#function('playbackrenderer_setPlan');
    this.#rendererOutputFrames = this.#function('playbackrenderer_outputFrames');
    this.#rendererRender = this.#function('playbackrenderer_render');
    this.#rendererFree = this.#function('__wbg_playbackrenderer_free');
    this.#function('__wbindgen_start')();
  }

  #function(name: string): WasmFunction {
    const value = this.#exports[name];
    if (typeof value !== 'function') throw new Error(`the core is missing ${name}`);
    return value as WasmFunction;
  }

  #importsFor(module: WebAssembly.Module): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {};
    for (const descriptor of WebAssembly.Module.imports(module)) {
      const group = (imports[descriptor.module] ??= {});
      group[descriptor.name] = this.#hostFunction(descriptor.name);
    }
    return imports;
  }

  /**
   * The host side of one core import, matched by the stable prefix of its mangled name.
   */
  #hostFunction(name: string): WebAssembly.ImportValue {
    if (name.startsWith('__wbindgen_init_externref_table')) {
      return (): void => {
        const table = this.#table();
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      };
    }
    if (name.includes('__wbindgen_throw')) {
      return (ptr: number, length: number): never => {
        throw new Error(this.#readString(ptr, length));
      };
    }
    if (name.startsWith('__wbindgen_generic_')) {
      return (ptr: number, length: number): string => this.#readString(ptr, length);
    }
    if (name.startsWith('__wbg_error_')) {
      return (ptr: number, length: number): void => {
        const message = this.#readString(ptr, length);
        this.#free(ptr, length, 1);
        console.error(message);
      };
    }
    if (name.startsWith('__wbg_new_')) {
      return (): Error => new Error();
    }
    if (name.startsWith('__wbg_stack_')) {
      return (result: number, error: unknown): void => {
        const stack = error instanceof Error ? (error.stack ?? '') : String(error);
        const bytes = asciiBytes(stack);
        const ptr = this.#writeBytes(bytes);
        const view = new DataView(this.#byteView().buffer);
        view.setInt32(result + 4, bytes.length, true);
        view.setInt32(result + 0, ptr, true);
      };
    }
    return (): never => {
      throw new Error(`the core wants an unsupported host function, ${name}`);
    };
  }

  #table(): WebAssembly.Table {
    const table = this.#exports['__wbindgen_externrefs'];
    if (!(table instanceof WebAssembly.Table))
      throw new Error('the core exports no reference table');
    return table;
  }

  #takeError(index: number): Error {
    const table = this.#table();
    const value: unknown = table.get(index);
    this.#function('__externref_table_dealloc')(index);
    if (value instanceof Error) return value;
    return new Error(typeof value === 'string' ? value : 'the core failed without a message');
  }

  #values(returned: unknown, length: number): unknown[] {
    if (!Array.isArray(returned) || returned.length < length) {
      throw new Error('the core returned an unexpected value');
    }
    return returned;
  }

  #refresh(): void {
    const memory = this.#memory;
    if (!memory) throw new Error('the core is not instantiated');
    if (this.#buffer === memory.buffer) return;
    this.#buffer = memory.buffer;
    this.#bytes = new Uint8Array(memory.buffer);
    this.#floats = new Float32Array(memory.buffer);
  }

  #floatView(): Float32Array {
    this.#refresh();
    return this.#floats;
  }

  #byteView(): Uint8Array {
    this.#refresh();
    return this.#bytes;
  }

  #writeBytes(bytes: Uint8Array): number {
    const ptr = Number(this.#malloc(Math.max(bytes.length, 1), 1));
    this.#byteView().set(bytes, ptr);
    return ptr;
  }

  #writeFloats(values: Float32Array): number {
    const ptr = Number(this.#malloc(Math.max(values.length * 4, 4), 4));
    this.#floatView().set(values, ptr / 4);
    return ptr;
  }

  #readString(ptr: number, length: number): string {
    return decodeUtf8(this.#byteView().subarray(ptr, ptr + length));
  }
}

function unbound(): never {
  throw new Error('the core is not instantiated');
}

/** Decodes UTF-8, because the worklet scope has no `TextDecoder`. */
function decodeUtf8(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length;) {
    const first = bytes[i] ?? 0;
    if (first < 0x80) {
      text += String.fromCharCode(first);
      i += 1;
    } else if (first < 0xe0) {
      text += String.fromCharCode(((first & 0x1f) << 6) | ((bytes[i + 1] ?? 0) & 0x3f));
      i += 2;
    } else if (first < 0xf0) {
      text += String.fromCharCode(
        ((first & 0x0f) << 12) | (((bytes[i + 1] ?? 0) & 0x3f) << 6) | ((bytes[i + 2] ?? 0) & 0x3f),
      );
      i += 3;
    } else {
      const point =
        ((first & 0x07) << 18) |
        (((bytes[i + 1] ?? 0) & 0x3f) << 12) |
        (((bytes[i + 2] ?? 0) & 0x3f) << 6) |
        ((bytes[i + 3] ?? 0) & 0x3f);
      text += String.fromCodePoint(point);
      i += 4;
    }
  }
  return text;
}

/** Encodes a diagnostic string, which only ever carries ASCII back into the core. */
function asciiBytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    bytes[i] = code < 0x80 ? code : 0x3f;
  }
  return bytes;
}

/** One vocal clip the processor can render: its source, its renderer and where it sits. */
interface ClipVoice {
  id: number;
  source: Float32Array;
  track: Uint8Array;
  plan: Uint8Array;
  renderer: number;
  /** Output frames the clip's plan produces. */
  outputFrames: number;
  /** Project output frame at which the clip's output frame 0 sits. */
  offset: number;
  /** Whether the clip is on the lane, which an undo of its import takes it off. */
  onLane: boolean;
  /** Loudest processed and original samples since the last report. */
  peakProcessed: number;
  peakOriginal: number;
}

/** One reference the processor plays unwarped: its channels and where it starts. */
interface ReferenceVoice {
  id: number;
  left: Float32Array;
  /** The second channel, or the first again for a mono reference. */
  right: Float32Array;
  offset: number;
  onLane: boolean;
  /** Balance gains, resolved from the desk when it arrives. */
  gainLeft: number;
  gainRight: number;
  /** Loudest sample since the last report. */
  peak: number;
}

/**
 * Mixes every clip's compiled plan, every clip's original, the references and the click into
 * the output.
 *
 * @remarks Every block is answered from preallocated buffers, and the desk is resolved to
 * amplitudes when it changes rather than per sample. A missing core, a rejected plan or a failed
 * render counts an underrun and outputs silence, and the count and the reason reach the main
 * thread with the position report.
 */
class RendererProcessor extends AudioWorkletProcessor {
  #core: Core | null = null;
  #clips: ClipVoice[] = [];
  #references: ReferenceVoice[] = [];
  #sourceRate = sampleRate;
  #ratio = 1;
  #outputFrames = 0;
  /** Seconds the transport runs past the last source, added to {@link #outputFrames}. */
  #tail = 0;

  #scratch: Float32Array = new Float32Array(512);
  #position = 0;
  #playing = false;
  #levels: MixLevels = mixLevels(DEFAULT_MIXER);
  #loop: { start: number; end: number } | null = null;
  #audition: { end: number; restore: number } | null = null;

  #metronome = false;
  #clicks: Float64Array = new Float64Array(0);
  #accents: Uint8Array = new Uint8Array(0);
  #clickIndex = 0;
  #clickPhase = 0;
  #clickStep = 0;
  #clickLeft = 0;
  #clickLength = Math.max(1, Math.round(CLICK_SECONDS * sampleRate));

  #preroll = 0;
  #prerollBeat = 0;
  #prerollNext = 0;

  #clickPeak = 0;
  #masterPeak = 0;

  #underruns = 0;
  #failure: string | null = null;
  #sinceReport = 0;
  #disposed = false;

  /** Newest transport command applied, echoed on every report. */
  #seq = 0;

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent): void => {
      const message = asEngineMessage(event.data);
      if (message) this.#handle(message);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    if (this.#disposed) return false;

    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0]?.length ?? 0;
    for (let c = 0; c < output.length; c += 1) output[c]?.fill(0);
    if (frames === 0) return true;

    if (this.#preroll > 0) {
      this.#advancePreroll(output, frames);
    } else if (this.#playing) {
      const startSeconds = this.#position / this.#sourceRate;
      this.#fill(output, frames);
      if (this.#metronome) this.#mixClicks(output, frames, startSeconds);
    } else if (this.#clickLeft > 0) {
      this.#mixClicks(output, frames, null);
    }
    this.#applyMaster(output, frames);

    this.#sinceReport += frames;
    if (this.#sinceReport >= REPORT_INTERVAL_FRAMES) {
      this.#sinceReport = 0;
      this.#report();
    }
    return true;
  }

  #handle(message: EngineMessage): void {
    switch (message.type) {
      case 'init':
        this.#initialise(message.bytes);
        break;
      case 'project':
        this.#unload();
        this.#sourceRate = message.sampleRate > 0 ? message.sampleRate : sampleRate;
        this.#ratio = this.#sourceRate / sampleRate;
        break;
      case 'clip':
        this.#loadClip(message);
        break;
      case 'plans':
        this.#setPlans(message.plans);
        break;
      case 'reference':
        this.#loadReference(message);
        break;
      case 'placements':
        this.#placeReferences(message.references);
        break;
      case 'unload':
        this.#unload();
        break;
      case 'mixer':
        this.#levels = mixLevels(message.mixer);
        this.#balanceReferences();
        break;
      case 'play':
        this.#seq = message.seq;
        this.#play(message.from, message.countIn);
        break;
      case 'pause':
        this.#seq = message.seq;
        this.#playing = false;
        this.#preroll = 0;
        this.#audition = null;
        this.#report();
        break;
      case 'seek':
        this.#seq = message.seq;
        this.#seek(message.seconds);
        break;
      case 'loop':
        this.#loop = message.range;
        break;
      case 'tail':
        this.#tail = Number.isFinite(message.seconds) ? Math.max(0, message.seconds) : 0;
        this.#measure();
        break;
      case 'metronome':
        this.#metronome = message.on;
        this.#clicks = message.clicks;
        this.#accents = message.accents;
        this.#syncClicks(this.#position / this.#sourceRate);
        break;
      case 'audition':
        this.#seq = message.seq;
        this.#startAudition(message.start, message.end);
        break;
      case 'dispose':
        this.#dispose();
        break;
    }
  }

  /**
   * Compiles and instantiates the core from the bytes the main thread sent.
   *
   * @remarks Compiling here rather than accepting a compiled module is not an
   * optimisation choice: a `WebAssembly.Module` cannot cross into a worklet's agent
   * cluster, and the attempt is dropped without an error on either side. Synchronous
   * compilation is permitted off the main thread.
   */
  #initialise(bytes: ArrayBuffer): void {
    try {
      this.#core = Core.instantiate(new WebAssembly.Module(bytes));
      this.#failure = null;
      for (const voice of this.#clips) this.#build(voice);
      this.#measure();
    } catch (thrown) {
      this.#core = null;
      this.#fail(thrown);
    }
  }

  #loadClip(message: Extract<EngineMessage, { type: 'clip' }>): void {
    const existing = this.#clips.find((voice) => voice.id === message.id);
    if (existing) this.#release(existing);
    const voice: ClipVoice = {
      id: message.id,
      source: new Float32Array(message.samples),
      track: message.track,
      plan: message.plan,
      renderer: 0,
      outputFrames: 0,
      offset: Math.round(message.position * this.#sourceRate),
      onLane: true,
      peakProcessed: 0,
      peakOriginal: 0,
    };
    this.#clips = [...this.#clips.filter((entry) => entry.id !== message.id), voice];
    this.#build(voice);
    this.#measure();
  }

  #build(voice: ClipVoice): void {
    const core = this.#core;
    this.#release(voice);
    if (!core || voice.source.length === 0) return;
    try {
      voice.renderer = core.createRenderer(voice.source, voice.track, voice.plan);
      voice.outputFrames = core.outputFrames(voice.renderer);
      this.#failure = null;
      this.#post({
        type: 'ready',
        clip: voice.id,
        sourceRate: this.#sourceRate,
      });
    } catch (thrown) {
      voice.renderer = 0;
      voice.outputFrames = 0;
      this.#fail(thrown);
    }
  }

  /**
   * Replaces every clip's plan and position.
   *
   * @remarks A clip missing from the list is off the lane and silent, but keeps its renderer so
   * a redo puts it back without rebuilding the epoch map.
   */
  #setPlans(plans: readonly ClipPlacement[]): void {
    const core = this.#core;
    for (const voice of this.#clips) voice.onLane = false;
    for (const placement of plans) {
      const voice = this.#clips.find((entry) => entry.id === placement.clip);
      if (!voice) continue;
      voice.onLane = true;
      voice.offset = Math.round(placement.position * this.#sourceRate);
      voice.plan = placement.plan;
      if (!core || voice.renderer === 0) {
        this.#build(voice);
        continue;
      }
      try {
        core.setPlan(voice.renderer, placement.plan);
        voice.outputFrames = core.outputFrames(voice.renderer);
        this.#failure = null;
      } catch (thrown) {
        this.#fail(thrown);
      }
    }
    this.#measure();
  }

  #loadReference(message: Extract<EngineMessage, { type: 'reference' }>): void {
    const left = new Float32Array(message.left);
    const right = message.right === null ? left : new Float32Array(message.right);
    const voice: ReferenceVoice = {
      id: message.id,
      left,
      right,
      offset: Math.round(message.position * this.#sourceRate),
      onLane: true,
      gainLeft: 0,
      gainRight: 0,
      peak: 0,
    };
    this.#references = [...this.#references.filter((entry) => entry.id !== message.id), voice];
    this.#balanceReferences();
    this.#measure();
  }

  /** Places every reference; one missing from the list is out of the project and silent. */
  #placeReferences(placements: readonly { id: number; position: number }[]): void {
    for (const voice of this.#references) voice.onLane = false;
    for (const placement of placements) {
      const voice = this.#references.find((entry) => entry.id === placement.id);
      if (!voice) continue;
      voice.onLane = true;
      voice.offset = Math.round(placement.position * this.#sourceRate);
    }
    this.#measure();
  }

  /**
   * Resolves each reference's strip to a gain per channel.
   *
   * @remarks A reference is stereo, so its pan is a balance rather than an equal-power pan of
   * one signal: centred, both channels pass at the strip's level, and panned, the far channel
   * fades while the near one holds.
   */
  #balanceReferences(): void {
    for (const voice of this.#references) {
      const level = referenceLevel(this.#levels, voice.id);
      const gain = Math.hypot(level.left, level.right);
      voice.gainLeft = Math.min(gain, Math.SQRT2 * level.left);
      voice.gainRight = Math.min(gain, Math.SQRT2 * level.right);
    }
  }

  /** Recomputes where the project ends: the latest clip output or reference on the lane. */
  #measure(): void {
    let end = 0;
    for (const voice of this.#clips) {
      if (voice.onLane && voice.renderer !== 0)
        end = Math.max(end, voice.offset + voice.outputFrames);
    }
    for (const voice of this.#references) {
      if (voice.onLane) end = Math.max(end, voice.offset + voice.left.length);
    }
    if (end > 0) end += this.#tail * this.#sourceRate;
    this.#outputFrames = end;
    this.#post({ type: 'length', outputSeconds: end / this.#sourceRate });
  }

  /** Drops every source and renderer, leaving the processor up and outputting silence. */
  #unload(): void {
    this.#playing = false;
    this.#preroll = 0;
    this.#audition = null;
    this.#position = 0;
    for (const voice of this.#clips) this.#release(voice);
    this.#clips = [];
    this.#references = [];
    this.#outputFrames = 0;
    this.#metronome = false;
    this.#failure = null;
    this.#report();
  }

  #play(from: number | null, countIn: boolean): void {
    if (this.#outputFrames === 0) {
      this.#report();
      return;
    }
    if (from !== null) this.#position = this.#clampFrames(from * this.#sourceRate);
    if (this.#position >= this.#outputFrames) this.#position = 0;
    this.#audition = null;
    this.#syncClicks(this.#position / this.#sourceRate);
    if (countIn) {
      this.#startPreroll();
    } else {
      this.#playing = true;
    }
    this.#report();
  }

  #seek(seconds: number): void {
    this.#position = this.#clampFrames(seconds * this.#sourceRate);
    this.#audition = null;
    this.#syncClicks(seconds);
    this.#report();
  }

  #startAudition(start: number, end: number): void {
    if (this.#outputFrames === 0 || end <= start) return;
    this.#audition = { end, restore: this.#position };
    this.#position = this.#clampFrames(start * this.#sourceRate);
    this.#preroll = 0;
    this.#playing = true;
    this.#syncClicks(start);
    this.#report();
  }

  #startPreroll(): void {
    const beat = this.#beatSeconds();
    this.#prerollBeat = Math.max(1, Math.round(beat * sampleRate));
    this.#preroll = this.#prerollBeat * COUNT_IN_BEATS;
    this.#prerollNext = 0;
  }

  /** Beat length around the play position, taken from the click grid the main thread supplied. */
  #beatSeconds(): number {
    const clicks = this.#clicks;
    if (clicks.length < 2) return DEFAULT_BEAT_SECONDS;
    const index = Math.min(Math.max(this.#clickIndex, 1), clicks.length - 1);
    const previous = clicks[index - 1] ?? 0;
    const next = clicks[index] ?? previous + DEFAULT_BEAT_SECONDS;
    const beat = next - previous;
    return beat > 0.01 && beat < 8 ? beat : DEFAULT_BEAT_SECONDS;
  }

  #advancePreroll(output: Float32Array[], frames: number): void {
    const used = Math.min(frames, this.#preroll);
    this.#mixClicks(output, used, null, true);
    this.#preroll -= used;
    if (this.#preroll <= 0) {
      this.#preroll = 0;
      this.#playing = true;
      this.#report();
    }
  }

  #fill(output: Float32Array[], frames: number): void {
    let done = 0;
    let segments = 0;
    while (done < frames && this.#playing && segments < MAX_SEGMENTS_PER_BLOCK) {
      segments += 1;
      const boundary = this.#nextBoundary();
      const untilBoundary = Math.max(1, Math.ceil((boundary - this.#position) / this.#ratio));
      const count = Math.min(frames - done, untilBoundary);
      this.#renderSegment(output, done, count);
      done += count;
      this.#position += count * this.#ratio;
      this.#atBoundary();
    }
  }

  /** Output sample the current segment must stop at: a loop end, an audition end or the tail. */
  #nextBoundary(): number {
    let boundary = this.#outputFrames;
    const loop = this.#loop;
    if (loop && loop.end > loop.start) {
      const end = loop.end * this.#sourceRate;
      if (end > this.#position) boundary = Math.min(boundary, end);
    }
    const audition = this.#audition;
    if (audition) boundary = Math.min(boundary, audition.end * this.#sourceRate);
    return boundary;
  }

  #atBoundary(): void {
    const loop = this.#loop;
    if (loop && loop.end > loop.start && this.#position >= loop.end * this.#sourceRate - 1e-6) {
      this.#position = Math.max(0, loop.start * this.#sourceRate);
      this.#syncClicks(loop.start);
      return;
    }
    const audition = this.#audition;
    if (audition && this.#position >= audition.end * this.#sourceRate - 1e-6) {
      this.#playing = false;
      this.#position = audition.restore;
      this.#audition = null;
      this.#post({
        type: 'ended',
        position: this.#position / this.#sourceRate,
        seq: this.#seq,
        reason: 'audition',
      });
      return;
    }
    if (this.#position >= this.#outputFrames - 1e-6) {
      this.#playing = false;
      this.#position = this.#outputFrames;
      this.#post({
        type: 'ended',
        position: this.#position / this.#sourceRate,
        seq: this.#seq,
        reason: 'end',
      });
    }
  }

  /** Mixes every source that sounds in one segment of the block. */
  #renderSegment(output: Float32Array[], offset: number, count: number): void {
    for (const voice of this.#clips) {
      if (voice.onLane) this.#mixClip(voice, output, offset, count);
    }
    for (const voice of this.#references) {
      if (voice.onLane) this.#mixReference(voice, output, offset, count);
    }
  }

  /**
   * Mixes one clip's two strips into a segment.
   *
   * @remarks A strip nothing can be heard from is not rendered at all, so a muted processed
   * strip costs no synthesis, and a clip the segment does not reach costs nothing either.
   */
  #mixClip(voice: ClipVoice, output: Float32Array[], offset: number, count: number): void {
    const ratio = this.#ratio;
    const local = this.#position - voice.offset;
    const last = local + (count - 1) * ratio;
    if (last < 0 || local >= Math.max(voice.outputFrames, voice.source.length)) return;
    const levels = clipLevels(this.#levels, voice.id);
    const processed = levels.processed;
    const original = levels.original;
    if (!processed.audible && !original.audible) return;

    const start = Math.max(0, Math.floor(local));
    const span = Math.floor(last) - start + 2;
    const processedOk =
      processed.audible && span > 0 && local < voice.outputFrames
        ? this.#renderProcessed(voice, start, span)
        : false;

    let peakProcessed = voice.peakProcessed;
    let peakOriginal = voice.peakOriginal;
    for (let i = 0; i < count; i += 1) {
      const position = local + i * ratio;
      const wet = processedOk ? sampleAt(this.#scratch, position - start) : 0;
      const dry = original.audible ? sampleAt(voice.source, position) : 0;
      const wetLeft = wet * processed.left;
      const wetRight = wet * processed.right;
      const dryLeft = dry * original.left;
      const dryRight = dry * original.right;
      peakProcessed = Math.max(peakProcessed, Math.abs(wetLeft), Math.abs(wetRight));
      peakOriginal = Math.max(peakOriginal, Math.abs(dryLeft), Math.abs(dryRight));
      this.#write(output, offset + i, wetLeft + dryLeft, wetRight + dryRight);
    }
    voice.peakProcessed = peakProcessed;
    voice.peakOriginal = peakOriginal;
  }

  /** Mixes one reference into a segment, straight from its channels and never warped. */
  #mixReference(
    voice: ReferenceVoice,
    output: Float32Array[],
    offset: number,
    count: number,
  ): void {
    if (voice.gainLeft === 0 && voice.gainRight === 0) return;
    const ratio = this.#ratio;
    const local = this.#position - voice.offset;
    if (local + (count - 1) * ratio < 0 || local >= voice.left.length) return;
    let peak = voice.peak;
    for (let i = 0; i < count; i += 1) {
      const position = local + i * ratio;
      const left = sampleAt(voice.left, position) * voice.gainLeft;
      const right = sampleAt(voice.right, position) * voice.gainRight;
      peak = Math.max(peak, Math.abs(left), Math.abs(right));
      this.#write(output, offset + i, left, right);
    }
    voice.peak = peak;
  }

  /** Scales the whole block by the master strip, and meters what leaves. */
  #applyMaster(output: Float32Array[], frames: number): void {
    const gain = this.#levels.master;
    let peak = this.#masterPeak;
    for (let c = 0; c < Math.min(output.length, 2); c += 1) {
      const channel = output[c];
      if (!channel) continue;
      for (let i = 0; i < frames; i += 1) {
        const value = (channel[i] ?? 0) * gain;
        channel[i] = value;
        peak = Math.max(peak, Math.abs(value));
      }
    }
    for (let c = 2; c < output.length; c += 1) {
      const channel = output[c];
      if (!channel) continue;
      for (let i = 0; i < frames; i += 1) channel[i] = (channel[i] ?? 0) * gain;
    }
    this.#masterPeak = peak;
  }

  /**
   * Adds one stereo frame to the output.
   *
   * @remarks Channel 0 is left and channel 1 is right. A device with more channels than that
   * takes the sum of the pair, so a panned strip is still heard on every one of them.
   */
  #write(output: Float32Array[], index: number, left: number, right: number): void {
    const first = output[0];
    if (first) first[index] = (first[index] ?? 0) + left;
    const second = output[1];
    if (second) second[index] = (second[index] ?? 0) + right;
    const summed = (left + right) * 0.5;
    for (let c = 2; c < output.length; c += 1) {
      const channel = output[c];
      if (channel) channel[index] = (channel[index] ?? 0) + summed;
    }
  }

  #renderProcessed(voice: ClipVoice, start: number, span: number): boolean {
    const core = this.#core;
    if (!core || voice.renderer === 0) {
      this.#underruns += 1;
      return false;
    }
    if (span > this.#scratch.length) {
      // Only the first block of a new quantum or rate reaches here.
      this.#scratch = new Float32Array(span * 2);
    }
    try {
      core.render(voice.renderer, start, span, this.#scratch);
      return true;
    } catch (thrown) {
      this.#underruns += 1;
      this.#fail(thrown);
      return false;
    }
  }

  /**
   * Adds the click voice over a block.
   *
   * @remarks `timelineStart` is the output time of the first sample when the transport is
   * running; during a count-in it is `null` and the beats come from the pre-roll counter.
   */
  #mixClicks(
    output: Float32Array[],
    frames: number,
    timelineStart: number | null,
    preroll = false,
  ): void {
    const clicks = this.#clicks;
    const level = this.#levels.click;
    const step = 1 / sampleRate;
    for (let i = 0; i < frames; i += 1) {
      if (timelineStart !== null) {
        const time = timelineStart + i * step;
        while (this.#clickIndex < clicks.length && (clicks[this.#clickIndex] ?? Infinity) <= time) {
          this.#trigger((this.#accents[this.#clickIndex] ?? 0) !== 0);
          this.#clickIndex += 1;
        }
      } else if (preroll) {
        if (this.#prerollNext <= 0) {
          const beatsLeft = Math.ceil(this.#preroll / Math.max(1, this.#prerollBeat));
          this.#trigger(beatsLeft === COUNT_IN_BEATS);
          this.#prerollNext = this.#prerollBeat;
        }
        this.#prerollNext -= 1;
      }

      if (this.#clickLeft <= 0) continue;
      const value = Math.sin(this.#clickPhase) * (this.#clickLeft / this.#clickLength);
      this.#clickPhase += this.#clickStep;
      if (this.#clickPhase > TWO_PI) this.#clickPhase -= TWO_PI;
      this.#clickLeft -= 1;
      this.#clickPeak = Math.max(
        this.#clickPeak,
        Math.abs(value * level.left),
        Math.abs(value * level.right),
      );
      this.#write(output, i, value * level.left, value * level.right);
    }
  }

  #trigger(accent: boolean): void {
    this.#clickPhase = 0;
    this.#clickStep = (TWO_PI * (accent ? ACCENT_HZ : BEAT_HZ)) / sampleRate;
    this.#clickLeft = this.#clickLength;
  }

  #syncClicks(seconds: number): void {
    const clicks = this.#clicks;
    let low = 0;
    let high = clicks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((clicks[middle] ?? Infinity) < seconds) low = middle + 1;
      else high = middle;
    }
    this.#clickIndex = low;
  }

  #clampFrames(frames: number): number {
    if (!Number.isFinite(frames) || frames < 0) return 0;
    return Math.min(frames, this.#outputFrames);
  }

  #fail(thrown: unknown): void {
    this.#failure = thrown instanceof Error ? thrown.message : String(thrown);
    this.#report();
  }

  #report(): void {
    this.#post({
      type: 'status',
      position: this.#position / this.#sourceRate,
      playing: this.#playing || this.#preroll > 0,
      underruns: this.#underruns,
      failure: this.#failure,
      seq: this.#seq,
      meters: this.#takeMeters(),
    });
  }

  /** The peaks since the last report, starting the next interval from silence. */
  #takeMeters(): MeterReport {
    const meters: MeterReport = {
      clips: this.#clips.map((voice) => ({
        clip: voice.id,
        processed: voice.peakProcessed,
        original: voice.peakOriginal,
      })),
      references: this.#references.map((voice) => ({ reference: voice.id, peak: voice.peak })),
      click: this.#clickPeak,
      master: this.#masterPeak,
    };
    for (const voice of this.#clips) {
      voice.peakProcessed = 0;
      voice.peakOriginal = 0;
    }
    for (const voice of this.#references) voice.peak = 0;
    this.#clickPeak = 0;
    this.#masterPeak = 0;
    return meters;
  }

  #post(message: RendererMessage): void {
    this.port.postMessage(message);
  }

  #release(voice: ClipVoice): void {
    const core = this.#core;
    if (core && voice.renderer !== 0) core.freeRenderer(voice.renderer);
    voice.renderer = 0;
  }

  #dispose(): void {
    this.#playing = false;
    for (const voice of this.#clips) this.#release(voice);
    this.#clips = [];
    this.#references = [];
    this.#core = null;
    this.#disposed = true;
  }
}

/** Reads a buffer at a fractional sample position, interpolating and clamping to silence. */
function sampleAt(buffer: Float32Array, position: number): number {
  if (position < 0 || position >= buffer.length) return 0;
  const index = Math.floor(position);
  const fraction = position - index;
  const first = buffer[index] ?? 0;
  const second = buffer[index + 1] ?? first;
  return first + (second - first) * fraction;
}

function asEngineMessage(value: unknown): EngineMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const type: unknown = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  switch (type) {
    case 'init':
    case 'project':
    case 'clip':
    case 'plans':
    case 'reference':
    case 'placements':
    case 'unload':
    case 'mixer':
    case 'play':
    case 'pause':
    case 'seek':
    case 'loop':
    case 'tail':
    case 'metronome':
    case 'audition':
    case 'dispose':
      return value as EngineMessage;
    default:
      return null;
  }
}

registerProcessor(RENDERER_PROCESSOR, RendererProcessor);
