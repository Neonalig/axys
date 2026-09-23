// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The main-thread half of playback: the AudioContext, the renderer worklet and the transport.
 *
 * Nothing here renders audio. The engine compiles the core module, hands the worklet its source
 * PCM and plans, translates transport intent into messages, and reports what the worklet says
 * back to the store and to the UI.
 */

import workletUrl from './worklet/renderer-worklet.ts?worker&url';
import type { AppStore } from '../app/store.js';
import type { ClipPlan } from '../core/json.js';
import type { ClipId, MixerSettings, ReferenceId, RenderPlan, TimelineMap } from '../core/types.js';
import { meterAt, ppqOf, tickToSeconds } from '../core/timeline.js';
import { wasmModuleUrl } from '../core/wasm-url.js';
import type {
  ClipPlacement,
  EngineMessage,
  MeterReport,
  OutputRange,
  RendererMessage,
} from './worklet/renderer-worklet.js';

export type { MeterReport } from './worklet/renderer-worklet.js';

/** A playhead this far from the reported position, in seconds, jumps to it rather than easing. */
const POSITION_SNAP = 0.05;

/** Share of the gap to the reported position closed on each read while playing. */
const POSITION_EASE = 0.08;

/** Whether the engine can play, and why not when it cannot. */
export type EngineStatus = 'idle' | 'blocked' | 'running' | 'failed';

/** What the UI shows about playback. */
export interface EngineReport {
  status: EngineStatus;
  /** The failure or the reason playback is blocked, or `null` when there is nothing to say. */
  message: string | null;
  /** Blocks the renderer could not fill since load. */
  underruns: number;
  /** Rate the output device runs at, or `null` before a context exists. */
  contextRate: number | null;
  /** Rate the source and the plan are in, or `null` before a source is loaded. */
  sourceRate: number | null;
}

const PROCESSOR_NAME = 'axys-renderer';
const MAX_CLICKS = 20000;
const MAX_BEATS_PER_BAR = 64;
const PLAN_HOP = 0.005;

/** How long the renderer has to confirm it is ready before that counts as a failure. */
const READY_TIMEOUT_MS = 5000;

/**
 * Owns the AudioContext, the worklet and the transport.
 *
 * @remarks An AudioContext cannot start before a user gesture, so an engine whose context is
 * suspended reports `blocked` rather than failing silently; the next {@link AudioEngine.play}
 * from a gesture resumes it.
 */
export class AudioEngine {
  readonly #store: AppStore;
  #coreBytes: ArrayBuffer | null = null;
  #ready = false;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #context: AudioContext | null = null;
  #node: AudioWorkletNode | null = null;
  #desiredRate: number | null = null;

  #status: EngineStatus = 'idle';
  #message: string | null = null;
  #underruns = 0;
  #meters: MeterReport | null = null;
  #listeners = new Set<(report: EngineReport) => void>();

  #encoder = new TextEncoder();
  /** The lane-wide plan the editor draws from, which places the clicks in output time. */
  #plan: RenderPlan | null = null;
  #timeline: TimelineMap | null = null;
  #metronome = false;

  #sourceRate: number | null = null;
  #duration = 0;
  #playing = false;
  #reported = 0;
  #reportedAt = 0;
  /** The position last handed out while playing, and when, so it moves at a steady rate. */
  #shown = 0;
  #shownAt = 0;

  /**
   * Transport commands issued so far, and the stamp the renderer echoes back.
   *
   * @remarks The renderer reports its position on a timer, so a report posted just before a
   * pause arrives just after it. Without this the report would restore the transport the pause
   * had already stopped, and the pause would read as ignored.
   */
  #issued = 0;

  private constructor(store: AppStore) {
    this.#store = store;
  }

  /** Compiles the core module and returns an engine ready to take a source. */
  static async create(store: AppStore): Promise<AudioEngine> {
    const engine = new AudioEngine(store);
    await engine.#compile();
    return engine;
  }

  /**
   * Starts a project over at a sample rate, dropping whatever the worklet held.
   *
   * @remarks The context is opened at the project rate where the host allows it, so no
   * resampling is needed.
   */
  async loadProject(sampleRate: number): Promise<void> {
    this.#sourceRate = sampleRate;
    this.#duration = 0;
    this.#reported = 0;
    this.#reportedAt = now();
    this.#playing = false;
    this.#underruns = 0;
    const node = await this.#ensureNode(sampleRate);
    if (!node) return;
    this.#send({ type: 'project', sampleRate });
  }

  /**
   * Hands the worklet one clip's audio. Transfers the buffer.
   *
   * @remarks `samples` is mono at the project rate and belongs to the worklet afterwards.
   * Loading a clip the worklet already holds replaces it.
   */
  loadClip(clip: ClipId, samples: Float32Array, trackJson: string, placed: ClipPlan | null): void {
    const buffer = samples.buffer;
    if (!(buffer instanceof ArrayBuffer)) {
      throw new TypeError('source audio must be backed by a transferable ArrayBuffer');
    }
    const rate = this.#sourceRate ?? 48_000;
    const plan = placed?.plan ?? passthroughPlan(rate, samples.length / rate);
    this.#send(
      {
        type: 'clip',
        id: clip,
        samples: buffer,
        track: this.#encoder.encode(trackJson),
        plan: this.#encoder.encode(JSON.stringify(plan)),
        position: placed?.position ?? 0,
      },
      [buffer],
    );
    this.#watchForReady();
  }

  /**
   * Hands the worklet one reference's channels. Transfers the buffers.
   *
   * @remarks Each channel is at the project rate. A reference is heard as it is, never through a
   * plan.
   */
  loadReference(reference: ReferenceId, channels: readonly Float32Array[], position: number): void {
    const [left, right] = channels;
    if (!left) return;
    const buffers = [left.buffer, right?.buffer].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
    );
    this.#send(
      {
        type: 'reference',
        id: reference,
        left: left.buffer as ArrayBuffer,
        right: right ? (right.buffer as ArrayBuffer) : null,
        position,
      },
      [...new Set(buffers)],
    );
  }

  /** Places every reference in the project; one left out is silent. */
  placeReferences(references: readonly { id: ReferenceId; position: number }[]): void {
    this.#send({
      type: 'placements',
      references: references.map(({ id, position }) => ({ id, position })),
    });
  }

  /**
   * Reports a renderer that never confirms it is ready.
   *
   * @remarks Without this a worklet that silently fails to build leaves the transport
   * looking healthy while every block is silence, which is exactly the failure a
   * dropped init message produces. Playing nothing must be visible, not quiet.
   */
  #watchForReady(): void {
    if (this.#readyTimer !== null) clearTimeout(this.#readyTimer);
    this.#ready = false;
    this.#readyTimer = setTimeout(() => {
      this.#readyTimer = null;
      if (this.#ready) return;
      this.#publish(
        'failed',
        'The renderer did not start, so playback would be silent. Reload the page',
      );
    }, READY_TIMEOUT_MS);
  }

  /**
   * Pushes every clip's compiled plan and position to the worklet. Cheap, safe to call on every
   * edit.
   *
   * @remarks `lane` is the lane-wide plan the editor draws from, which carries the clicks through
   * the timing edits. A loaded clip missing from `plans` is off the lane and silent.
   */
  setPlans(plans: readonly ClipPlan[], lane: RenderPlan): void {
    this.#plan = lane;
    const placements: ClipPlacement[] = plans.map((placed) => ({
      clip: placed.clip,
      position: placed.position,
      plan: this.#encoder.encode(JSON.stringify(placed.plan)),
    }));
    this.#send({ type: 'plans', plans: placements });
    if (this.#metronome) this.#sendClicks();
  }

  /**
   * Lets go of the source, so an empty editor has nothing to play.
   *
   * @remarks The context and the worklet stay up: the next project loads into them without
   * paying for a second audio graph, and a transport with nothing loaded outputs silence.
   */
  unloadSource(): void {
    if (this.#readyTimer !== null) {
      clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
    }
    this.#ready = false;
    this.#plan = null;
    this.#timeline = null;
    this.#metronome = false;
    this.#sourceRate = null;
    this.#duration = 0;
    this.#playing = false;
    this.#reported = 0;
    this.#reportedAt = now();
    this.#send({ type: 'unload' });
    this.#syncTransport();
    this.#notify();
  }

  /** Hands the worklet the monitor desk: level, pan, mute and solo for every strip. */
  setMixer(mixer: MixerSettings): void {
    this.#send({ type: 'mixer', mixer });
  }

  /**
   * Starts playback, resuming the context first.
   *
   * @remarks Resolves whatever happens. When the browser refuses to start the context outside a
   * gesture the engine reports `blocked` instead of throwing, so a caller never has to catch.
   */
  async play(from?: number): Promise<void> {
    const node = this.#node;
    if (!node) {
      this.#publish('idle', 'Open an audio file to play');
      return;
    }
    await this.#resume();
    if (this.#status !== 'running') return;

    this.#playing = true;
    this.#reported = from ?? this.position;
    this.#reportedAt = now();
    this.#issued += 1;
    this.#send({
      type: 'play',
      from: from ?? null,
      countIn: this.#store.state.transport.countIn,
      seq: this.#issued,
    });
    this.#syncTransport();
  }

  /** Stops at the current position. */
  pause(): void {
    this.#playing = false;
    this.#reported = this.position;
    this.#reportedAt = now();
    this.#issued += 1;
    this.#send({ type: 'pause', seq: this.#issued });
    this.#syncTransport();
  }

  /**
   * Stops and returns the playhead to the beginning.
   *
   * @remarks A loop range is its own beginning, so stopping inside one returns to where that
   * loop plays from rather than to zero.
   */
  stop(): void {
    this.pause();
    if (this.#store.state.transport.returnToStart) this.seek(this.#beginning);
  }

  /** Where Stop and the end of the take return the playhead to. */
  get #beginning(): number {
    return this.#store.state.transport.loop?.start ?? 0;
  }

  /** Moves the playhead, playing or not. */
  seek(seconds: number): void {
    const position = Math.min(Math.max(seconds, 0), this.#duration);
    this.#reported = position;
    this.#reportedAt = now();
    this.#issued += 1;
    this.#send({ type: 'seek', seconds: position, seq: this.#issued });
    this.#syncTransport();
  }

  /** Sets or clears the loop range, in output seconds. */
  setLoop(range: OutputRange | null): void {
    this.#send({ type: 'loop', range });
    this.#store.update({
      transport: { ...this.#store.state.transport, loop: range },
    });
  }

  /** Turns the metronome on or off and clicks it from the project's tempo and meter maps. */
  setMetronome(on: boolean, timeline: TimelineMap): void {
    this.#metronome = on;
    this.#timeline = timeline;
    this.#sendClicks();
    this.#store.update({
      transport: { ...this.#store.state.transport, metronome: on },
    });
  }

  /** Turns the count-in before playback on or off. */
  setCountIn(on: boolean): void {
    this.#store.update({
      transport: { ...this.#store.state.transport, countIn: on },
    });
  }

  /** Plays a short region once, for scrubbing and audition. */
  audition(start: number, end: number): void {
    if (!(end > start)) return;
    void this.#resume();
    this.#issued += 1;
    this.#send({ type: 'audition', start, end, seq: this.#issued });
  }

  /**
   * Playhead position in output seconds, interpolated between the worklet's reports.
   *
   * @remarks While playing it advances with the clock and eases towards each report rather than
   * jumping to it, because the audio clock and the page clock drift apart a little between
   * reports and a playhead corrected in steps shakes under Keep Centred. A gap larger than
   * {@link POSITION_SNAP} seconds, from a seek or a loop, is taken at once.
   */
  get position(): number {
    if (!this.#playing) return this.#reported;
    const at = now();
    const target = Math.min(this.#reported + (at - this.#reportedAt) / 1000, this.#duration);
    const predicted = this.#shown + (at - this.#shownAt) / 1000;
    const error = target - predicted;
    const shown =
      this.#shownAt === 0 || Math.abs(error) > POSITION_SNAP
        ? target
        : Math.min(predicted + error * POSITION_EASE, this.#duration);
    this.#shown = shown;
    this.#shownAt = at;
    return shown;
  }

  /** True while the transport is running, including during a count-in. */
  get playing(): boolean {
    return this.#playing;
  }

  /**
   * Each strip's loudest recent sample after its fader, or `null` before the renderer reports.
   *
   * @remarks Refreshed about twenty times a second while the transport runs.
   */
  get meters(): MeterReport | null {
    return this.#meters;
  }

  /** Output length of the current plan, in seconds. */
  get duration(): number {
    return this.#duration;
  }

  /** Playback state for the UI. */
  get report(): EngineReport {
    return {
      status: this.#status,
      message: this.#message,
      underruns: this.#underruns,
      contextRate: this.#context?.sampleRate ?? null,
      sourceRate: this.#sourceRate,
    };
  }

  /** Subscribes to status changes; returns an unsubscribe function. */
  subscribe(listener: (report: EngineReport) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Releases the worklet and closes the context. */
  dispose(): void {
    this.#send({ type: 'dispose' });
    this.#teardown();
    this.#listeners.clear();
    this.#publish('idle', null);
  }

  /**
   * Fetches the core module as bytes for the worklet to compile.
   *
   * @remarks The bytes, not a compiled `WebAssembly.Module`, are what cross to the
   * worklet. A worklet is a separate agent cluster, and a module posted across one is
   * dropped with no error on either side, which silences playback without a diagnostic.
   */
  async #compile(): Promise<void> {
    const url = wasmModuleUrl();
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`);
      this.#coreBytes = await response.arrayBuffer();
    } catch (thrown) {
      this.#publish('failed', `Playback is unavailable: ${messageOf(thrown)}`);
    }
  }

  async #ensureNode(rate: number): Promise<AudioWorkletNode | null> {
    if (this.#node && this.#desiredRate === rate) return this.#node;
    this.#teardown();

    const bytes = this.#coreBytes;
    if (!bytes) {
      this.#publish('failed', 'Playback is unavailable: the core did not load');
      return null;
    }

    const context = openContext(rate);
    if (!context) {
      this.#publish('failed', 'This browser has no Web Audio support');
      return null;
    }

    try {
      await context.audioWorklet.addModule(workletUrl);
    } catch (thrown) {
      void context.close();
      this.#publish('failed', `The audio renderer did not load: ${messageOf(thrown)}`);
      return null;
    }

    const node = new AudioWorkletNode(context, PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (event: MessageEvent): void => {
      this.#receive(event.data);
    };
    node.onprocessorerror = (): void => {
      this.#publish('failed', 'The audio renderer stopped and playback was silenced');
    };
    node.connect(context.destination);
    context.onstatechange = (): void => {
      this.#publishContextState();
    };

    this.#context = context;
    this.#node = node;
    this.#desiredRate = rate;
    // A fresh copy per node: the worklet takes ownership of what it is sent.
    node.port.postMessage({ type: 'init', bytes: bytes.slice(0) } satisfies EngineMessage);
    this.#publishContextState();
    return node;
  }

  async #resume(): Promise<void> {
    const context = this.#context;
    if (!context) return;
    if (context.state === 'running') {
      this.#publish('running', null);
      return;
    }
    try {
      await context.resume();
    } catch {
      // A context that will not resume is reported below, not thrown at the caller.
    }
    this.#publishContextState();
  }

  #publishContextState(): void {
    const context = this.#context;
    if (!context) return;
    if (context.state === 'running') {
      this.#publish('running', null);
    } else if (context.state === 'closed') {
      this.#publish('idle', null);
    } else {
      // No message: that audio waits for a gesture is what pressing Play is for, and saying
      // so in the status bar is a line the user reads once and never needs again.
      this.#publish('blocked', null);
    }
  }

  #receive(data: unknown): void {
    const message = asRendererMessage(data);
    if (!message) return;
    switch (message.type) {
      case 'ready':
        this.#ready = true;
        if (this.#readyTimer !== null) {
          clearTimeout(this.#readyTimer);
          this.#readyTimer = null;
        }
        this.#sourceRate = message.sourceRate;
        this.#notify();
        break;
      case 'length':
        this.#duration = message.outputSeconds;
        if (this.#metronome) this.#sendClicks();
        break;
      case 'status':
        this.#underruns = message.underruns;
        this.#meters = message.meters;
        if (message.failure !== null && message.failure !== this.#message) {
          this.#publish(this.#status, `Playback fell back to silence: ${message.failure}`);
        }
        if (message.seq < this.#issued) break;
        this.#playing = message.playing;
        this.#reported = message.position;
        this.#reportedAt = now();
        this.#syncTransport();
        break;
      case 'ended':
        if (message.seq < this.#issued) break;
        this.#playing = false;
        this.#reported = message.position;
        this.#reportedAt = now();
        // A snippet has already put the position back where it interrupted, so only reaching
        // the end of the take returns the playhead to the beginning.
        if (message.reason === 'end' && this.#store.state.transport.returnToStart) {
          this.seek(this.#beginning);
        } else {
          this.#syncTransport();
        }
        break;
    }
  }

  #sendClicks(): void {
    const timeline = this.#timeline;
    if (!timeline) return;
    const grid =
      this.#metronome && this.#duration > 0
        ? clickTimes(timeline, this.#plan, this.#duration)
        : { times: new Float64Array(0), accents: new Uint8Array(0) };
    this.#send({
      type: 'metronome',
      on: this.#metronome,
      clicks: grid.times,
      accents: grid.accents,
    });
  }

  #send(message: EngineMessage, transfer?: Transferable[]): void {
    const node = this.#node;
    if (!node) return;
    if (transfer) node.port.postMessage(message, transfer);
    else node.port.postMessage(message);
  }

  #syncTransport(): void {
    const transport = this.#store.state.transport;
    if (!this.#playing) this.#shownAt = 0;
    // While playing, the playhead loop writes the interpolated position every frame. Writing
    // the raw report here as well would pull the playhead back to it between two frames.
    if (this.#playing && transport.playing) return;
    if (transport.playing === this.#playing && transport.position === this.#reported) return;
    this.#store.update({
      transport: { ...transport, playing: this.#playing, position: this.#reported },
    });
  }

  #publish(status: EngineStatus, message: string | null): void {
    if (this.#status === status && this.#message === message) return;
    this.#status = status;
    this.#message = message;
    this.#notify();
  }

  #notify(): void {
    const report = this.report;
    for (const listener of [...this.#listeners]) {
      try {
        listener(report);
      } catch (error) {
        console.error('An audio engine listener threw while handling a report.', error);
      }
    }
  }

  #teardown(): void {
    const node = this.#node;
    if (node) {
      node.port.onmessage = null;
      node.disconnect();
    }
    const context = this.#context;
    if (context && context.state !== 'closed') void context.close();
    this.#node = null;
    this.#context = null;
    this.#desiredRate = null;
    this.#playing = false;
  }
}

/** A plan that plays the source untouched, used until the core has compiled a real one. */
export function passthroughPlan(sampleRate: number, duration: number): RenderPlan {
  const end = Math.max(duration, PLAN_HOP);
  return {
    sampleRate,
    timeMap: {
      points: [
        [0, 0],
        [end, end],
      ],
    },
    pitchRatio: { start: 0, hop: PLAN_HOP, values: [1, 1] },
    targetMidi: { start: 0, hop: PLAN_HOP, values: [0, 0] },
    gain: { start: 0, hop: PLAN_HOP, values: [1, 1] },
    formant: 'follow',
  };
}

/**
 * Click times and accents for the metronome, in output seconds.
 *
 * @remarks Beats come from the tempo and meter maps, so the clicks follow tempo and
 * time-signature changes, and each beat is carried through the plan's time map so a timing edit
 * moves the click with the audio. The grid is bounded, so a pathological tempo map cannot make
 * an unbounded list.
 */
function clickTimes(
  timeline: TimelineMap,
  plan: RenderPlan | null,
  untilSeconds: number,
): { times: Float64Array; accents: Uint8Array } {
  const ppq = ppqOf(timeline);
  const times: number[] = [];
  const accents: number[] = [];

  let tick = 0;
  let beatInBar = 0;
  let meter = meterAt(timeline, 0);
  while (times.length < MAX_CLICKS) {
    if (beatInBar === 0) meter = meterAt(timeline, tick);
    const seconds = tickToSeconds(timeline, tick);
    if (seconds > untilSeconds) break;
    if (seconds >= 0) {
      times.push(toOutputSeconds(plan, seconds));
      accents.push(beatInBar === 0 ? 1 : 0);
    }
    const beatTicks = (ppq * 4) / Math.min(Math.max(meter.denominator, 1), 64);
    if (!(beatTicks > 0)) break;
    tick += beatTicks;
    const beatsInBar = Math.min(Math.max(meter.numerator, 1), MAX_BEATS_PER_BAR);
    beatInBar = (beatInBar + 1) % beatsInBar;
  }

  return { times: Float64Array.from(times), accents: Uint8Array.from(accents) };
}

function toOutputSeconds(plan: RenderPlan | null, source: number): number {
  const points = plan?.timeMap.points;
  if (!points || points.length < 2) return source;

  let low = 0;
  let high = points.length - 1;
  while (low < high - 1) {
    const middle = (low + high) >> 1;
    const point = points[middle];
    if (!point) break;
    if (point[1] <= source) low = middle;
    else high = middle;
  }
  const first = points[low];
  const second = points[high];
  if (!first || !second) return source;
  const span = second[1] - first[1];
  if (!(span > 0)) return first[0];
  return first[0] + ((source - first[1]) / span) * (second[0] - first[0]);
}

function openContext(rate: number): AudioContext | null {
  if (typeof AudioContext !== 'function') return null;
  try {
    return new AudioContext({ sampleRate: rate, latencyHint: 'interactive' });
  } catch {
    // A host that refuses the source rate runs at its own; the worklet resamples.
  }
  try {
    return new AudioContext({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
}

function asRendererMessage(value: unknown): RendererMessage | null {
  if (typeof value !== 'object' || value === null) return null;
  const type: unknown = (value as { type?: unknown }).type;
  if (type === 'ready' || type === 'length' || type === 'status' || type === 'ended') {
    return value as RendererMessage;
  }
  return null;
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  if (typeof thrown === 'string') return thrown;
  return 'the reason was not reported';
}

function now(): number {
  return typeof performance === 'object' ? performance.now() : Date.now();
}
