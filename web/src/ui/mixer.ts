// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The mixer: a track per vocal clip, a strip per reference, one for the metronome and the master,
 * in a panel across the bottom of the editor.
 *
 * A clip's track groups its two strips, the take as edited and as sung, under the clip's name,
 * so each clip reads as one source with two faders. A strip is laid out the way a desk lays one
 * out: the name, the pan above the fader, the fader itself, and mute and solo under it. Each
 * fader's fill darkens as far as the strip is sounding, so what each source adds to the mix reads
 * at a glance. The desk is monitoring rather than an edit to the take, so an export takes from it
 * only the levels of the references it includes.
 */

import { displayTitle, MAX_GAIN_DB, MIN_GAIN_DB, sourceTitle } from '../core/types.js';
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
  MASTER_NAME,
  referenceStrip,
  soloed,
  VOCAL_NAMES,
  withClipStrip,
  withReferenceStrip,
} from '../audio/mixer.js';
import type { VocalStrip } from '../audio/mixer.js';
import type { MeterReport } from '../audio/engine.js';
import { rangeInput, swapGlyph, textInput } from './controls/index.js';
import { ICONS, stateIcon } from './icons.js';
import { showContextMenu } from './menu.js';
import { setTooltip } from './tooltip.js';
import { referenceColour, resolveTheme, sourceTheme } from './theme.js';
import type { AppState } from '../app/store.js';

/** What the mixer needs in order to be heard and to be kept. */
export interface MixerHooks {
  /** Applies one edit to the session, which is one undo step. */
  applyEdit(op: EditOp): void;
  /** Hands the engine a desk that has not been committed yet, so a dragged fader is audible. */
  previewMixer(mixer: MixerSettings): void;
  /** Each strip's recent peak, or `null` while nothing is playing. */
  meters(): MeterReport | null;
  /** Brings a clip forward in the editor. */
  focus(clip: ClipId): void;
  /** Asks for a file and relinks a clip's or a reference's audio to it. */
  relinkAudio(target: { clip: ClipId } | { reference: ReferenceId }): void;
}

/** Which strip on the desk a control belongs to. */
type StripKey =
  | { kind: 'clip'; clip: ClipId; which: VocalStrip }
  | { kind: 'reference'; reference: ReferenceId }
  | { kind: 'click' }
  | { kind: 'master' };

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
  /** `null` on the master, which is never soloed. */
  solo: HTMLButtonElement | null;
  /** How far the meter inside the fader's fill reaches, from 0 to 1 of the fader's travel. */
  meter: number;
}

/**
 * How near the middle a pan has to be dragged before it lands there.
 *
 * @remarks A continuous slider cannot be put back on centre by hand, and a strip a few percent
 * off centre is a fault nobody can see. The detent applies to a drag only, so the arrow keys
 * still reach every value inside it.
 */
const PAN_DETENT = 0.06;

/**
 * How fast a meter falls back once its source quietens, in fader travel per second.
 *
 * @remarks Rises instantly and falls at this rate, as a desk's peak meter does, so a transient is
 * seen rather than lost between two reports.
 */
const METER_FALL = 1.5;

/** How fast a source name too long for its header scrolls, in pixels per second. */
const MARQUEE_SPEED = 30;

/** Longest a clip or reference name may be, matching the limit the core enforces. */
const MAX_SOURCE_NAME = 120;

/** Where a level in decibels sits along a fader, from 0 at the floor to 1 at the top. */
function travel(decibels: number): number {
  return Math.min(Math.max((decibels - MIN_GAIN_DB) / (MAX_GAIN_DB - MIN_GAIN_DB), 0), 1);
}

/** Where a peak amplitude sits along a fader. */
function peakTravel(peak: number): number {
  return peak > 0 ? travel(20 * Math.log10(peak)) : 0;
}

/** A strip's peak in a meter report, or 0 for a strip the report does not carry. */
function peakOf(meters: MeterReport, key: StripKey): number {
  switch (key.kind) {
    case 'clip': {
      const entry = meters.clips.find((candidate) => candidate.clip === key.clip);
      return entry === undefined ? 0 : entry[key.which];
    }
    case 'reference':
      return meters.references.find((entry) => entry.reference === key.reference)?.peak ?? 0;
    case 'click':
      return meters.click;
    case 'master':
      return meters.master;
  }
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

/** The strip a key addresses, read from a desk. */
function stripOf(mixer: MixerSettings, key: StripKey): MixerStrip {
  switch (key.kind) {
    case 'clip':
      return clipStrips(mixer, key.clip)[key.which];
    case 'reference':
      return referenceStrip(mixer, key.reference);
    case 'click':
      return mixer.click;
    case 'master':
      return mixer.master;
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
    case 'master':
      return { ...mixer, master: { ...strip, pan: 0, solo: false } };
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
    .map((clip) => `c${String(clip.id)}:${displayTitle(clip)}`);
  const references = edits.references.map(
    (reference) => `r${String(reference.id)}:${displayTitle(reference)}`,
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
  /** Each clip's track, which says whether it is the source in front. */
  #tracks = new Map<ClipId, HTMLElement>();
  /** Each reference's strip, by the fingerprint its colour comes from. */
  #references = new Map<HTMLElement, string>();
  #lineup: string | null = null;

  #mixer: MixerSettings = DEFAULT_MIXER;
  #collapsed = true;
  #lastFrame = 0;

  constructor(hooks: MixerHooks) {
    this.#hooks = hooks;
    const element = document.createElement('section');
    element.className = 'axys-mixer';
    element.setAttribute('aria-label', 'Mixer');
    this.#element = element;
    this.#rebuild(null);
    requestAnimationFrame(this.#meterFrame);
  }

  /**
   * Moves every meter towards its strip's latest peak, once a frame.
   *
   * @remarks Touches the page only for a meter that moved, so an idle desk costs a comparison
   * per strip. A folded or detached panel is skipped.
   */
  #meterFrame = (time: number): void => {
    const elapsed = this.#lastFrame === 0 ? 0 : (time - this.#lastFrame) / 1000;
    this.#lastFrame = time;
    requestAnimationFrame(this.#meterFrame);
    if (this.#collapsed || !this.#element.isConnected) return;
    const meters = this.#hooks.meters();
    for (const controls of this.#strips) {
      const target = meters === null ? 0 : peakTravel(peakOf(meters, controls.key));
      const next = Math.max(target, controls.meter - METER_FALL * Math.min(elapsed, 0.1));
      if (next === controls.meter) continue;
      controls.meter = next;
      controls.gain.style.setProperty('--axys-meter-level', next.toFixed(3));
    }
  };

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
    this.#collapsed = state.mixerCollapsed;
    if (state.mixerCollapsed) return;
    const wanted = lineup(state.edits);
    // Only a slider held under the pointer defers the rebuild. One that merely kept focus after
    // it was let go must not, or a source imported afterwards never reached the desk.
    const dragging = this.#element.querySelector('input:active') !== null;
    if (wanted !== this.#lineup && !dragging) {
      this.#rebuild(state.edits);
    }
    this.#mixer = state.edits?.mixer ?? DEFAULT_MIXER;
    const theme = resolveTheme();
    for (const [clip, track] of this.#tracks) {
      track.classList.toggle('is-active', state.layer[0] === clip && this.#tracks.size > 1);
      track.style.setProperty('--axys-source', sourceTheme(theme, clip).blobBounds);
    }
    for (const [strip, fingerprint] of this.#references) {
      strip.style.setProperty('--axys-source', referenceColour(fingerprint));
    }
    const ready = state.edits !== null;
    // While anything is soloed, the solos decide what is heard and the mutes wait, so the mutes
    // are drawn as out of play. They still take a press, which is what they come back to.
    const masked = soloed(this.#mixer);
    for (const controls of this.#strips) {
      controls.mute.classList.toggle('is-masked', masked && controls.key.kind !== 'master');
      const strip = stripOf(this.#mixer, controls.key);
      // A mute in effect takes the strip out of play, so its level and pan are too; its switches
      // stay live, since they are how it comes back. A solo elsewhere overrides the mute, except
      // on the master, which no solo reaches.
      const silenced = strip.mute && (!masked || controls.key.kind === 'master');
      for (const control of [controls.mute, controls.solo]) {
        if (control) control.disabled = !ready;
      }
      controls.gain.disabled = !ready || silenced;
      controls.pan.disabled = !ready || silenced;
      controls.gainReadout.classList.toggle('is-disabled', silenced);
      controls.panReadout.classList.toggle('is-disabled', silenced);
      // The whole strip, readouts included, is left alone while it is being dragged: the store
      // updates on every animation frame the transport runs, and rewriting the control under
      // the hand from the committed value is what makes a fader fight the hand holding it.
      if (document.activeElement !== controls.gain) {
        setValue(controls.gain, String(strip.gainDb));
        setFill(controls.gain, strip.gainDb);
        controls.gainReadout.textContent = levelText(strip.gainDb);
      }
      if (document.activeElement !== controls.pan) {
        setValue(controls.pan, String(strip.pan));
        controls.panReadout.textContent = panText(strip.pan);
      }
      // A toggle's tooltip names what pressing it will do, and follows the state icon.
      swapGlyph(controls.mute, stateIcon('mute', !strip.mute));
      controls.mute.setAttribute('aria-pressed', String(strip.mute));
      setTooltip(controls.mute, switchTip('mute', strip.mute ? 'Unmute' : 'Mute', controls.label));
      if (controls.solo) {
        controls.solo.setAttribute('aria-pressed', String(strip.solo));
        setTooltip(
          controls.solo,
          switchTip('solo', strip.solo ? 'Unsolo' : 'Solo', controls.label),
        );
      }
    }
  }

  /**
   * Builds a track per clip in lane order, a strip per reference, the metronome, and the master.
   *
   * @remarks Three groups: the sources the lane edits pinned left, the references centred, and
   * the metronome and the master pinned right.
   */
  #rebuild(edits: EditState | null): void {
    this.#lineup = lineup(edits);
    this.#strips = [];
    this.#tracks = new Map();
    this.#references = new Map();
    const sources = group('is-sources');
    const references = group('is-references');
    const outputs = group('is-outputs');
    const clips = edits === null ? [] : [...edits.clips].sort((a, b) => a.position - b.position);
    for (const clip of clips) {
      const title = displayTitle(clip);
      const track = document.createElement('div');
      track.className = 'axys-mixer-track';
      track.setAttribute('role', 'group');
      track.setAttribute('aria-label', `${title} Track`);
      const head = document.createElement('div');
      head.className = 'axys-mixer-track-name';
      this.#bindSourceName(track, head, title, clip.source.name, (name) => ({
        type: 'renameClip',
        clip: clip.id,
        name,
      }));
      setTooltip(head, `${clip.source.name}\nClick to edit, double-click to rename`);
      head.addEventListener('click', () => {
        this.#hooks.focus(clip.id);
      });
      this.#bindRelink(track, { clip: clip.id });
      this.#tracks.set(clip.id, track);
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
      sources.append(track);
    }
    for (const reference of edits?.references ?? []) {
      const title = displayTitle(reference);
      const strip = this.#buildStrip(
        { kind: 'reference', reference: reference.id },
        title,
        title,
        true,
      );
      strip.classList.add('is-reference');
      this.#bindRelink(strip, { reference: reference.id });
      this.#references.set(strip, reference.source.fingerprint);
      const head = strip.querySelector<HTMLElement>('.axys-mixer-name');
      if (head !== null) {
        this.#bindSourceName(strip, head, title, reference.source.name, (name) => ({
          type: 'renameReference',
          reference: reference.id,
          name,
        }));
      }
      references.append(strip);
    }
    outputs.append(
      this.#buildStrip({ kind: 'click' }, CLICK_NAME, CLICK_NAME, true),
      this.#buildStrip({ kind: 'master' }, MASTER_NAME, MASTER_NAME, true),
    );
    this.#element.replaceChildren(sources, references, outputs);
  }

  /** Opens Relink Audio from a right-click anywhere on a source's track or strip. */
  #bindRelink(element: HTMLElement, target: { clip: ClipId } | { reference: ReferenceId }): void {
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(
        [
          {
            label: 'Relink Audio...',
            icon: 'join',
            run: () => {
              this.#hooks.relinkAudio(target);
            },
          },
        ],
        { x: event.clientX, y: event.clientY },
      );
    });
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

    // The master has no pan and no solo, so its fader takes the height the pan would have had.
    const master = key.kind === 'master';
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
    const solo = master ? null : this.#buildSwitch(key, 'solo', label);
    const switches = document.createElement('div');
    switches.className = 'axys-mixer-switches';
    switches.append(mute);
    if (solo) switches.append(solo);

    const faderRow = document.createElement('div');
    faderRow.className = 'axys-mixer-fader-row';
    faderRow.append(gain);

    // Each control gets the width of the strip and its value gets its own line under it. A
    // readout beside a slider takes the room the slider needs to be worth dragging.
    heading.htmlFor = gain.id;
    if (master) strip.append(heading, faderRow, gainReadout, switches);
    else strip.append(heading, pan, panReadout, faderRow, gainReadout, switches);
    this.#strips.push({ key, label, gain, gainReadout, pan, panReadout, mute, solo, meter: 0 });

    const current = (): MixerStrip => stripOf(this.#mixer, key);
    // Heard as it moves, kept when it is let go: one drag is one undo step rather than one per
    // frame, and the sound follows the hand either way.
    gain.addEventListener('input', () => {
      const gainDb = readNumber(gain, current().gainDb);
      gainReadout.textContent = levelText(gainDb);
      setFill(gain, gainDb);
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
   * Heads a source's track or strip with its name, scrolled into view while the pointer is over
   * the track when it does not fit, and renamed by a double-click.
   *
   * @remarks `file` is the source's file name. A name typed back to the file's own, or cleared,
   * goes back to following the file.
   */
  #bindSourceName(
    container: HTMLElement,
    head: HTMLElement,
    title: string,
    file: string,
    rename: (name: string | null) => EditOp,
  ): void {
    const text = document.createElement('span');
    text.className = 'axys-marquee';
    text.textContent = title;
    head.replaceChildren(text);
    setTooltip(head, `${file}\nDouble-click to rename`);

    container.addEventListener('pointerenter', () => {
      const overflow = head.scrollWidth - head.clientWidth;
      head.classList.toggle('is-marquee', overflow > 0);
      head.style.setProperty('--axys-marquee-shift', `${String(-Math.max(0, overflow))}px`);
      head.style.setProperty('--axys-marquee-time', `${String(1 + overflow / MARQUEE_SPEED)}s`);
    });
    container.addEventListener('pointerleave', () => {
      head.classList.remove('is-marquee');
    });

    head.addEventListener('dblclick', (event: MouseEvent) => {
      event.preventDefault();
      if (head.querySelector('input') !== null) return;
      const input = textInput(MAX_SOURCE_NAME);
      input.className = 'axys-mixer-rename';
      input.value = title;
      input.setAttribute('aria-label', `Rename ${title}`);
      head.classList.remove('is-marquee');
      head.replaceChildren(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (keep: boolean): void => {
        if (done) return;
        done = true;
        const typed = input.value.trim();
        head.replaceChildren(text);
        if (!keep || typed === title) return;
        this.#hooks.applyEdit(rename(typed === '' || typed === sourceTitle(file) ? null : typed));
      };
      input.addEventListener('keydown', (key: KeyboardEvent) => {
        // The editor's own shortcuts are not for a name being typed.
        key.stopPropagation();
        if (key.key === 'Enter') finish(true);
        else if (key.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => {
        finish(true);
      });
    });
  }

  /**
   * One mute or solo button.
   *
   * @remarks A mute is its own strip's and touches no other. A solo settles the desk on that strip
   * alone; Ctrl or Cmd adds it to whatever is already soloed, which is how more than one strip is
   * soloed at a time.
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
    setTooltip(button, switchTip(field, action, strip));
    button.addEventListener('click', (event: MouseEvent) => {
      this.#toggle(key, field, event.ctrlKey || event.metaKey);
    });
    return button;
  }

  #toggle(key: StripKey, field: 'mute' | 'solo', additive: boolean): void {
    const wanted = !stripOf(this.#mixer, key)[field];
    // A mute is the strip's own, and the master is not one of the sources a solo settles the desk
    // on, so both are toggled alone and leave every other strip as it is.
    if (field === 'mute' || key.kind === 'master') {
      this.#commit(key, { [field]: wanted });
      return;
    }
    let mixer = this.#mixer;
    for (const controls of this.#strips) {
      if (controls.key.kind === 'master') continue;
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
 * A mute or solo tooltip: what pressing it will do, and for a solo how to solo more than one.
 *
 * @remarks Said the same way in both states, because a gesture written differently in each place
 * is a gesture nobody learns.
 */
function switchTip(field: 'mute' | 'solo', action: string, strip: string): string {
  if (field === 'mute') return `${action} ${strip}`;
  return `${action} ${strip}\nCtrl-click for multiple strips`;
}

/** One of the desk's three groups of strips. */
function group(className: string): HTMLElement {
  const element = document.createElement('div');
  element.className = `axys-mixer-group ${className}`;
  return element;
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

/** Sets how far a fader's fill reaches, which its meter never passes. */
function setFill(gain: HTMLInputElement, decibels: number): void {
  gain.style.setProperty('--axys-fader-fill', travel(decibels).toFixed(4));
}

function setValue(input: HTMLInputElement, value: string): void {
  if (input.value !== value) input.value = value;
}
