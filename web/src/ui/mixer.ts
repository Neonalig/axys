// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The mixer: one strip per audio source, at the bottom of the editor.
 *
 * Levels, pan, mute and solo are the controls a desk has, and they are what answers which take is
 * being listened to. The desk is monitoring rather than an edit to the take, so nothing here
 * changes what an export writes.
 */

import { MAX_GAIN_DB, MIN_GAIN_DB } from '../core/types.js';
import type { EditOp, MixerSettings, MixerStrip } from '../core/types.js';
import { DEFAULT_MIXER, STRIP_IDS, STRIP_LABELS } from '../audio/mixer.js';
import type { StripId } from '../audio/mixer.js';
import { ICONS } from './icons.js';
import { guidedLabel, rangeInput } from './inspector.js';
import { setTooltip } from './tooltip.js';
import type { AppState } from '../app/store.js';

/** What the mixer needs in order to be heard and to be kept. */
export interface MixerHooks {
  /** Applies one edit to the session, which is one undo step. */
  applyEdit(op: EditOp): void;
  /** Hands the engine a desk that has not been committed yet, so a dragged fader is audible. */
  previewMixer(mixer: MixerSettings): void;
  /** Runs the command with this id. */
  runCommand(id: string): void;
}

/** The controls one strip owns. */
interface StripControls {
  gain: HTMLInputElement;
  gainReadout: HTMLElement;
  pan: HTMLInputElement;
  panReadout: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
}

/** How a level reads, with the floor named rather than printed as a number. */
function levelText(decibels: number): string {
  if (decibels <= MIN_GAIN_DB) return 'Off';
  return `${decibels > 0 ? '+' : ''}${decibels.toFixed(1)} dB`;
}

/** How a pan position reads: centre, or how far to one side. */
function panText(pan: number): string {
  const percent = Math.round(Math.abs(pan) * 100);
  if (percent === 0) return 'C';
  return `${pan < 0 ? 'L' : 'R'}${String(percent)}`;
}

/**
 * The desk at the bottom of the editor.
 *
 * @remarks Holds no state of its own beyond what a control is showing. A fader is heard as it
 * moves and committed when it is let go, so dragging one leaves the history with one entry.
 */
export class MixerPanel {
  readonly #hooks: MixerHooks;
  readonly #element: HTMLElement;
  readonly #fold: HTMLButtonElement;
  readonly #strips = new Map<StripId, StripControls>();

  #mixer: MixerSettings = DEFAULT_MIXER;
  #collapsed = false;

  constructor(hooks: MixerHooks) {
    this.#hooks = hooks;

    const element = document.createElement('section');
    element.className = 'axys-mixer';
    element.setAttribute('aria-label', 'Mixer');

    const head = document.createElement('div');
    head.className = 'axys-mixer-head';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'axys-icon axys-mixer-fold';
    fold.innerHTML = ICONS.mixer;
    const name = document.createElement('span');
    name.className = 'axys-button-label';
    name.textContent = 'Mixer';
    fold.append(name);
    fold.addEventListener('click', () => {
      this.#hooks.runCommand('view.toggleMixer');
    });
    head.append(fold);
    this.#fold = fold;

    const strips = document.createElement('div');
    strips.className = 'axys-mixer-strips';
    for (const id of STRIP_IDS) strips.append(this.#buildStrip(id));

    element.append(head, strips);
    this.#element = element;
  }

  /** The panel element, ready to append to the shell. */
  get element(): HTMLElement {
    return this.#element;
  }

  /** Refreshes every control from application state. */
  update(state: AppState): void {
    this.#setCollapsed(state.mixerCollapsed);
    this.#mixer = state.edits?.mixer ?? DEFAULT_MIXER;
    const ready = state.edits !== null;
    for (const id of STRIP_IDS) {
      const controls = this.#strips.get(id);
      if (!controls) continue;
      const strip = this.#mixer[id];
      for (const control of [controls.gain, controls.pan, controls.mute, controls.solo]) {
        control.disabled = !ready;
      }
      setValue(controls.gain, String(strip.gainDb));
      setValue(controls.pan, String(strip.pan));
      controls.gainReadout.textContent = levelText(strip.gainDb);
      controls.panReadout.textContent = panText(strip.pan);
      controls.mute.setAttribute('aria-pressed', String(strip.mute));
      controls.solo.setAttribute('aria-pressed', String(strip.solo));
    }
  }

  #setCollapsed(on: boolean): void {
    if (this.#collapsed === on) return;
    this.#collapsed = on;
    this.#element.classList.toggle('is-collapsed', on);
    const label = on ? 'Show Mixer' : 'Hide Mixer';
    this.#fold.setAttribute('aria-label', label);
    this.#fold.setAttribute('aria-expanded', String(!on));
    setTooltip(this.#fold, `${label} (K)`);
  }

  #buildStrip(id: StripId): HTMLElement {
    const { label, tip } = STRIP_LABELS[id];
    const strip = document.createElement('div');
    strip.className = 'axys-mixer-strip';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', `${label} Strip`);

    const name = guidedLabel(label, tip);
    name.className = 'axys-label axys-mixer-name';

    const mute = this.#buildSwitch(id, 'mute', 'M', `Mute ${label}`);
    const solo = this.#buildSwitch(id, 'solo', 'S', `Solo ${label}`);

    const gain = rangeInput(MIN_GAIN_DB, MAX_GAIN_DB, 0.5);
    gain.className = 'axys-mixer-gain';
    gain.setAttribute('aria-label', `${label} Level`);
    const gainReadout = readout();

    const pan = rangeInput(-1, 1, 0.01);
    pan.className = 'axys-mixer-pan';
    pan.setAttribute('aria-label', `${label} Pan`);
    const panReadout = readout();

    name.htmlFor = gain.id;
    strip.append(name, mute, solo, gain, gainReadout, pan, panReadout);
    const controls: StripControls = { gain, gainReadout, pan, panReadout, mute, solo };
    this.#strips.set(id, controls);

    // Heard as it moves, kept when it is let go: one drag is one undo step rather than one per
    // frame, and the sound follows the hand either way.
    gain.addEventListener('input', () => {
      const gainDb = readNumber(gain, this.#mixer[id].gainDb);
      gainReadout.textContent = levelText(gainDb);
      this.#hooks.previewMixer(this.#with(id, { gainDb }));
    });
    gain.addEventListener('change', () => {
      this.#commit(id, { gainDb: readNumber(gain, this.#mixer[id].gainDb) });
    });
    pan.addEventListener('input', () => {
      const value = readNumber(pan, this.#mixer[id].pan);
      panReadout.textContent = panText(value);
      this.#hooks.previewMixer(this.#with(id, { pan: value }));
    });
    pan.addEventListener('change', () => {
      this.#commit(id, { pan: readNumber(pan, this.#mixer[id].pan) });
    });
    // A double-click puts a fader back where it started, which is what every other one does.
    gain.addEventListener('dblclick', () => {
      this.#commit(id, { gainDb: DEFAULT_MIXER[id].gainDb });
    });
    pan.addEventListener('dblclick', () => {
      this.#commit(id, { pan: 0 });
    });
    return strip;
  }

  /**
   * One mute or solo button.
   *
   * @remarks Pressing one settles the desk on that strip alone; Ctrl or Cmd adds it to whatever
   * is already switched on, which is how more than one strip is muted or soloed at a time.
   */
  #buildSwitch(
    id: StripId,
    field: 'mute' | 'solo',
    face: string,
    label: string,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `axys-icon axys-mixer-switch is-${field}`;
    button.textContent = face;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', 'false');
    setTooltip(button, `${label}. Ctrl-click for more than one`);
    button.addEventListener('click', (event: MouseEvent) => {
      this.#toggle(id, field, event.ctrlKey || event.metaKey);
    });
    return button;
  }

  #toggle(id: StripId, field: 'mute' | 'solo', additive: boolean): void {
    const wanted = !this.#mixer[id][field];
    const mixer = { ...this.#mixer };
    for (const other of STRIP_IDS) {
      const on = other === id ? wanted : additive ? mixer[other][field] : false;
      mixer[other] = { ...mixer[other], [field]: on };
    }
    this.#hooks.applyEdit({ type: 'setMixer', mixer });
  }

  #with(id: StripId, patch: Partial<MixerStrip>): MixerSettings {
    return { ...this.#mixer, [id]: { ...this.#mixer[id], ...patch } };
  }

  #commit(id: StripId, patch: Partial<MixerStrip>): void {
    const mixer = this.#with(id, patch);
    this.#mixer = mixer;
    this.#hooks.applyEdit({ type: 'setMixer', mixer });
  }
}

function readout(): HTMLElement {
  const element = document.createElement('span');
  element.className = 'axys-readout';
  return element;
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function setValue(input: HTMLInputElement, value: string): void {
  if (document.activeElement !== input && input.value !== value) input.value = value;
}
