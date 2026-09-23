// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The mixer: a track per vocal clip, a strip per reference and one for the metronome, in a panel
 * across the bottom of the editor.
 *
 * A clip's track groups its two strips, the take as edited and as sung, under the clip's name,
 * so each clip reads as one source with two faders. A strip is laid out the way a desk lays one
 * out: the name, the pan above the fader, the fader itself, and mute and solo under it. The desk
 * is monitoring rather than an edit to the take, so nothing here changes what an export writes.
 */

import { MAX_GAIN_DB, MIN_GAIN_DB, sourceTitle } from '../core/types.js';
import type {
  ClipId,
  EditOp,
  EditState,
  MixerSettings,
  MixerStrip,
  ReferenceId,
} from '../core/types.js';
import {
  CLICK_NAME,
  clipStrips,
  DEFAULT_CLICK_DB,
  DEFAULT_MIXER,
  referenceStrip,
  VOCAL_NAMES,
  withClipStrip,
  withReferenceStrip,
} from '../audio/mixer.js';
import type { VocalStrip } from '../audio/mixer.js';
import { rangeInput, swapGlyph } from './controls/index.js';
import { ICONS, stateIcon } from './icons.js';
import { setTooltip } from './tooltip.js';
import type { AppState } from '../app/store.js';

/** What the mixer needs in order to be heard and to be kept. */
export interface MixerHooks {
  /** Applies one edit to the session, which is one undo step. */
  applyEdit(op: EditOp): void;
  /** Hands the engine a desk that has not been committed yet, so a dragged fader is audible. */
  previewMixer(mixer: MixerSettings): void;
}

/** Which strip on the desk a control belongs to. */
type StripKey =
  | { kind: 'clip'; clip: ClipId; which: VocalStrip }
  | { kind: 'reference'; reference: ReferenceId }
  | { kind: 'click' };

/** The controls one strip owns. */
interface StripControls {
  key: StripKey;
  /** What the strip is called in its tooltips and accessible names. */
  label: string;
  gain: HTMLInputElement;
  gainReadout: HTMLElement;
  pan: HTMLInputElement;
  panReadout: HTMLElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
}

/**
 * How near the middle a pan has to be dragged before it lands there.
 *
 * @remarks A continuous slider cannot be put back on centre by hand, and a strip a few percent
 * off centre is a fault nobody can see. The detent applies to a drag only, so the arrow keys
 * still reach every value inside it.
 */
const PAN_DETENT = 0.06;

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

/** The strip a key addresses, read from a desk. */
function stripOf(mixer: MixerSettings, key: StripKey): MixerStrip {
  switch (key.kind) {
    case 'clip':
      return clipStrips(mixer, key.clip)[key.which];
    case 'reference':
      return referenceStrip(mixer, key.reference);
    case 'click':
      return mixer.click;
  }
}

/** A desk with the strip a key addresses replaced. */
function withStrip(mixer: MixerSettings, key: StripKey, strip: MixerStrip): MixerSettings {
  switch (key.kind) {
    case 'clip':
      return withClipStrip(mixer, key.clip, key.which, strip);
    case 'reference':
      return withReferenceStrip(mixer, key.reference, strip);
    case 'click':
      return { ...mixer, click: strip };
  }
}

/** Where a strip's fader rests until it is moved, which a double-click returns it to. */
function restingGain(key: StripKey): number {
  return key.kind === 'click' ? DEFAULT_CLICK_DB : 0;
}

/** Which sources the desk shows, as a key that changes when that list does. */
function lineup(edits: EditState | null): string {
  if (edits === null) return '';
  const clips = [...edits.clips]
    .sort((a, b) => a.position - b.position)
    .map((clip) => `c${String(clip.id)}:${clip.source.name}`);
  const references = edits.references.map(
    (reference) => `r${String(reference.id)}:${reference.source.name}`,
  );
  return [...clips, ...references].join('|');
}

/**
 * The desk across the bottom of the editor.
 *
 * @remarks Holds no state of its own beyond what a control is showing. A fader is heard as it
 * moves and committed when it is let go, so dragging one leaves the history with one entry, and
 * a control under the hand is never rewritten from the state behind it. The strips are rebuilt
 * only when a source comes or goes, never while one is being dragged.
 */
export class MixerPanel {
  readonly #hooks: MixerHooks;
  readonly #element: HTMLElement;
  #strips: StripControls[] = [];
  #lineup: string | null = null;

  #mixer: MixerSettings = DEFAULT_MIXER;

  constructor(hooks: MixerHooks) {
    this.#hooks = hooks;
    const element = document.createElement('section');
    element.className = 'axys-mixer';
    element.setAttribute('aria-label', 'Mixer');
    this.#element = element;
    this.#rebuild(null);
  }

  /** The panel element, ready to append to the shell. */
  get element(): HTMLElement {
    return this.#element;
  }

  /**
   * Refreshes every control from application state.
   *
   * @remarks Folded away by height rather than by `hidden`, so the panel can be seen to open and
   * close. `inert` takes it out of the tab order and away from assistive technology while it is
   * folded, which is what `hidden` was doing.
   */
  update(state: AppState): void {
    this.#element.classList.toggle('is-collapsed', state.mixerCollapsed);
    this.#element.inert = state.mixerCollapsed;
    if (state.mixerCollapsed) return;
    const wanted = lineup(state.edits);
    const active = document.activeElement;
    const dragging = active instanceof HTMLInputElement && this.#element.contains(active);
    if (wanted !== this.#lineup && !dragging) {
      this.#rebuild(state.edits);
    }
    this.#mixer = state.edits?.mixer ?? DEFAULT_MIXER;
    const ready = state.edits !== null;
    for (const controls of this.#strips) {
      const strip = stripOf(this.#mixer, controls.key);
      for (const control of [controls.gain, controls.pan, controls.mute, controls.solo]) {
        control.disabled = !ready;
      }
      // The whole strip, readouts included, is left alone while it is being dragged: the store
      // updates on every animation frame the transport runs, and rewriting the control under
      // the hand from the committed value is what makes a fader fight the hand holding it.
      if (document.activeElement !== controls.gain) {
        setValue(controls.gain, String(strip.gainDb));
        controls.gainReadout.textContent = levelText(strip.gainDb);
      }
      if (document.activeElement !== controls.pan) {
        setValue(controls.pan, String(strip.pan));
        controls.panReadout.textContent = panText(strip.pan);
      }
      // A toggle's tooltip names what pressing it will do, and follows the state icon.
      swapGlyph(controls.mute, stateIcon('mute', !strip.mute));
      controls.mute.setAttribute('aria-pressed', String(strip.mute));
      setTooltip(controls.mute, switchTip(strip.mute ? 'Unmute' : 'Mute', controls.label));
      controls.solo.setAttribute('aria-pressed', String(strip.solo));
      setTooltip(controls.solo, switchTip(strip.solo ? 'Unsolo' : 'Solo', controls.label));
    }
  }

  /** Builds a track per clip in lane order, a strip per reference, and the metronome last. */
  #rebuild(edits: EditState | null): void {
    this.#lineup = lineup(edits);
    this.#strips = [];
    const parts: HTMLElement[] = [];
    const clips = edits === null ? [] : [...edits.clips].sort((a, b) => a.position - b.position);
    for (const clip of clips) {
      const title = sourceTitle(clip.source.name);
      const track = document.createElement('div');
      track.className = 'axys-mixer-track';
      track.setAttribute('role', 'group');
      track.setAttribute('aria-label', `${title} Track`);
      const head = document.createElement('div');
      head.className = 'axys-mixer-track-name';
      head.textContent = title;
      setTooltip(head, clip.source.name);
      const pair = document.createElement('div');
      pair.className = 'axys-mixer-track-strips';
      for (const which of ['processed', 'original'] as const) {
        pair.append(
          this.#buildStrip(
            { kind: 'clip', clip: clip.id, which },
            VOCAL_NAMES[which],
            `${title} ${VOCAL_NAMES[which]}`,
          ),
        );
      }
      track.append(head, pair);
      parts.push(track);
    }
    for (const reference of edits?.references ?? []) {
      const title = sourceTitle(reference.source.name);
      parts.push(
        this.#buildStrip({ kind: 'reference', reference: reference.id }, title, title, true),
      );
    }
    parts.push(this.#buildStrip({ kind: 'click' }, CLICK_NAME, CLICK_NAME, true));
    this.#element.replaceChildren(...parts);
  }

  /**
   * One strip.
   *
   * @remarks `name` is what the strip is headed with, and `label` what its controls are called:
   * inside a track the strip reads Processed under the clip's name, while its fader is still
   * called by the clip's name to a screen reader. A standalone strip draws the box a track
   * draws, so every source on the desk has one outline.
   */
  #buildStrip(key: StripKey, name: string, label: string, standalone = false): HTMLElement {
    const strip = document.createElement('div');
    strip.className = standalone ? 'axys-mixer-strip is-standalone' : 'axys-mixer-strip';
    strip.setAttribute('role', 'group');
    strip.setAttribute('aria-label', `${label} Strip`);

    const heading = document.createElement('label');
    heading.className = 'axys-mixer-name';
    heading.textContent = name;

    const pan = rangeInput(-1, 1, 0.01);
    pan.className = 'axys-mixer-pan';
    pan.setAttribute('aria-label', `${label} Pan`);
    const panReadout = readout('axys-mixer-pan-readout');

    const gain = rangeInput(MIN_GAIN_DB, MAX_GAIN_DB, 0.5);
    gain.className = 'axys-mixer-fader';
    gain.setAttribute('aria-label', `${label} Level`);
    gain.setAttribute('aria-orientation', 'vertical');
    const gainReadout = readout('axys-mixer-level');

    const mute = this.#buildSwitch(key, 'mute', label);
    const solo = this.#buildSwitch(key, 'solo', label);
    const switches = document.createElement('div');
    switches.className = 'axys-mixer-switches';
    switches.append(mute, solo);

    const faderRow = document.createElement('div');
    faderRow.className = 'axys-mixer-fader-row';
    faderRow.append(gain);

    // Each control gets the width of the strip and its value gets its own line under it. A
    // readout beside a slider takes the room the slider needs to be worth dragging.
    heading.htmlFor = gain.id;
    strip.append(heading, pan, panReadout, faderRow, gainReadout, switches);
    this.#strips.push({ key, label, gain, gainReadout, pan, panReadout, mute, solo });

    const current = (): MixerStrip => stripOf(this.#mixer, key);
    // Heard as it moves, kept when it is let go: one drag is one undo step rather than one per
    // frame, and the sound follows the hand either way.
    gain.addEventListener('input', () => {
      const gainDb = readNumber(gain, current().gainDb);
      gainReadout.textContent = levelText(gainDb);
      this.#hooks.previewMixer(this.#with(key, { gainDb }));
    });
    gain.addEventListener('change', () => {
      this.#commit(key, { gainDb: readNumber(gain, current().gainDb) });
    });
    // The detent belongs to the hand on the slider, not to the value: the arrow keys step
    // through the middle of the field one hundredth at a time and must not be dragged to zero.
    let keyboard = false;
    const panValue = (): number => {
      const value = readNumber(pan, current().pan);
      return !keyboard && Math.abs(value) < PAN_DETENT ? 0 : value;
    };
    pan.addEventListener('keydown', () => {
      keyboard = true;
    });
    pan.addEventListener('pointerdown', () => {
      keyboard = false;
    });
    pan.addEventListener('input', () => {
      // The slider's own value is left where the pointer put it. Writing the detented value
      // back mid-drag does not move the drag, so the browser restores the raw position on
      // release and the centre the readout promised turns back into a few percent off it.
      const value = panValue();
      panReadout.textContent = panText(value);
      this.#hooks.previewMixer(this.#with(key, { pan: value }));
    });
    pan.addEventListener('change', () => {
      const value = panValue();
      pan.value = String(value);
      panReadout.textContent = panText(value);
      this.#commit(key, { pan: value });
    });
    // A double-click puts a control back where it started, which is what every other one does.
    gain.addEventListener('dblclick', () => {
      this.#commit(key, { gainDb: restingGain(key) });
    });
    pan.addEventListener('dblclick', () => {
      this.#commit(key, { pan: 0 });
    });
    return strip;
  }

  /**
   * One mute or solo button.
   *
   * @remarks Pressing one settles the desk on that strip alone; Ctrl or Cmd adds it to whatever
   * is already switched on, which is how more than one strip is muted or soloed at a time.
   */
  #buildSwitch(key: StripKey, field: 'mute' | 'solo', strip: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `axys-icon axys-mixer-switch is-${field}`;
    // Mute swaps its glyph with its state; Lucide ships no off headphones, so solo carries its
    // state in its pressed styling alone.
    swapGlyph(button, field === 'mute' ? stateIcon('mute', true) : ICONS.solo);
    const action = field === 'mute' ? 'Mute' : 'Solo';
    button.setAttribute('aria-label', `${action} ${strip}`);
    button.setAttribute('aria-pressed', 'false');
    setTooltip(button, switchTip(action, strip));
    button.addEventListener('click', (event: MouseEvent) => {
      this.#toggle(key, field, event.ctrlKey || event.metaKey);
    });
    return button;
  }

  #toggle(key: StripKey, field: 'mute' | 'solo', additive: boolean): void {
    const wanted = !stripOf(this.#mixer, key)[field];
    let mixer = this.#mixer;
    for (const controls of this.#strips) {
      const strip = stripOf(mixer, controls.key);
      const on = controls.key === key ? wanted : additive ? strip[field] : false;
      mixer = withStrip(mixer, controls.key, { ...strip, [field]: on });
    }
    this.#hooks.applyEdit({ type: 'setMixer', mixer });
  }

  #with(key: StripKey, patch: Partial<MixerStrip>): MixerSettings {
    return withStrip(this.#mixer, key, { ...stripOf(this.#mixer, key), ...patch });
  }

  #commit(key: StripKey, patch: Partial<MixerStrip>): void {
    const mixer = this.#with(key, patch);
    this.#mixer = mixer;
    this.#hooks.applyEdit({ type: 'setMixer', mixer });
  }
}

/**
 * A mute or solo tooltip: what pressing it will do, and how to do it to more than one strip.
 *
 * @remarks Said the same way for both switches and in both states, because a gesture written
 * differently in each place is a gesture nobody learns.
 */
function switchTip(action: string, strip: string): string {
  return `${action} ${strip}. Ctrl-click for more than one`;
}

function readout(className: string): HTMLElement {
  const element = document.createElement('span');
  element.className = `axys-readout ${className}`;
  return element;
}

function readNumber(input: HTMLInputElement, fallback: number): number {
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function setValue(input: HTMLInputElement, value: string): void {
  if (input.value !== value) input.value = value;
}
