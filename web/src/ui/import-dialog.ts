// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Import Audio, as one floating panel in two steps.
 *
 * The first step asks whether the audio is a vocal or a reference. Choosing Vocal imports it and
 * turns the panel into the analysis step, where the pitch method and its settings are changed and
 * the vocal is analysed again as they move, so the blobs and playback follow the settings while
 * the panel is open. Back takes the import back and asks again; Apply keeps the result and
 * remembers the settings for the next import; Cancel takes the import back.
 */

import { Dialog } from './dialog.js';
import type { DialogAction } from './dialog.js';
import {
  checkboxInput,
  field,
  guidedLabel,
  numberInput,
  rangeInput,
  selectInput,
} from './controls/index.js';
import { isF0Params } from '../core/json.js';
import type { F0Method, F0Params } from '../core/types.js';
import { DEFAULT_F0 } from '../core/types.js';

/** Local storage key holding the analysis settings last applied. */
const SETTINGS_KEY = 'axys.analysis';

/** Milliseconds a setting rests before the vocal is analysed again. */
const SETTLE_MS = 250;

/** How each method is named in the list. */
const METHODS: readonly { value: F0Method; label: string }[] = [
  { value: 'yin', label: 'YIN' },
  { value: 'pyin', label: 'pYIN' },
  { value: 'swipe', label: 'SWIPE' },
];

/** The analysis settings last applied on this device, or the defaults. */
export function storedAnalysis(): F0Params {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return isF0Params(parsed) ? { ...DEFAULT_F0, ...parsed } : { ...DEFAULT_F0 };
  } catch {
    return { ...DEFAULT_F0 };
  }
}

function storeAnalysis(params: F0Params): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(params));
  } catch {
    // Settings that cannot be kept start from the defaults next time.
  }
}

/** What an analysis of the imported vocals came to. */
export interface AnalysisOutcome {
  /** Blobs the vocals now hold. */
  blobs: number;
  /** The voicing threshold decoding used, which Auto Threshold may have raised. */
  threshold: number;
}

/** What the panel asks of the workspace. */
export interface ImportPanelHooks {
  /** Names what is being imported: a file's title, or a count of files. */
  what: string;
  /** Whether to ask vocal or reference first. Without it the import starts at once. */
  askRole: boolean;
  /** Imports the audio as vocals, analysed with `params`. `null` when nothing came in. */
  importVocals(params: F0Params): Promise<AnalysisOutcome | null>;
  /** Imports the audio as references. */
  importReferences(): Promise<void>;
  /** Analyses the imported vocals again. */
  analyse(params: F0Params): Promise<AnalysisOutcome>;
  /** Takes the import back, leaving nothing imported. */
  cancel(): void;
}

/** One step of the panel: what it runs when the panel closes on it. */
type StepLeave = (leave: () => void) => void;

/** Starts Import Audio: the vocal or reference question, or the vocal import itself. */
export function openImportPanel(hooks: ImportPanelHooks): void {
  // One panel for both steps, so it keeps its place and its focus when the step changes.
  let leave: () => void = () => {};
  const onLeave: StepLeave = (next) => {
    leave = next;
  };
  const dialog = Dialog.open({
    title: 'Import Audio',
    icon: 'import',
    content: document.createElement('div'),
    blocking: false,
    onClose: () => {
      leave();
    },
  });
  if (hooks.askRole) askRole(dialog, hooks, onLeave);
  else analysisStep(dialog, hooks, false, onLeave);
}

/** The first step: whether the audio is a vocal or a reference. */
function askRole(dialog: Dialog, hooks: ImportPanelHooks, onLeave: StepLeave): void {
  onLeave(() => {});
  const question = document.createElement('p');
  question.className = 'axys-hint';
  question.textContent = `Import ${hooks.what} as a vocal or a reference?`;
  dialog.body.replaceChildren(question);
  dialog.setActions([
    {
      label: 'Cancel',
      onSelect: () => {
        dialog.close();
      },
    },
    {
      label: 'Reference',
      onSelect: () => {
        dialog.close();
        void hooks.importReferences();
      },
    },
    {
      label: 'Vocal',
      kind: 'primary',
      onSelect: () => {
        analysisStep(dialog, hooks, true, onLeave);
      },
    },
  ]);
}

/**
 * The second step: imports the vocals, then analyses them again as the settings move.
 *
 * @remarks The settings wait until the audio has loaded, since nothing they change exists before
 * then. With `back`, Back takes the import back and returns to the first step.
 */
function analysisStep(
  dialog: Dialog,
  hooks: ImportPanelHooks,
  back: boolean,
  onLeave: StepLeave,
): void {
  const initial = storedAnalysis();
  // Each method reads its setting its own way, so each keeps its own value.
  let chosen: F0Method = initial.method ?? 'yin';
  let yinThreshold = chosen === 'pyin' ? DEFAULT_F0.threshold : initial.threshold;
  let pyinMean = chosen === 'pyin' ? initial.threshold : DEFAULT_F0.threshold;
  let strengthValue = initial.strength ?? 0.25;
  let minHz = initial.minHz;
  let maxHz = initial.maxHz;
  /** Whether the vocals are in, which is when there is something to analyse or take back. */
  let loaded = false;
  /** Whether this step is over: applied, cancelled, gone back from or closed. */
  let settled = false;
  /** Whether the import is to be taken back as soon as it arrives. */
  let takeBack = false;

  const auto = checkboxInput();
  auto.checked = initial.autoThreshold ?? false;
  const current = (): F0Params => ({
    ...initial,
    method: chosen,
    // With Auto Threshold the slider shows what the clip chose, and the default is the floor.
    threshold: chosen === 'pyin' ? pyinMean : auto.checked ? DEFAULT_F0.threshold : yinThreshold,
    strength: strengthValue,
    autoThreshold: auto.checked,
    minHz,
    maxHz,
  });

  const slider = (
    label: string,
    guide: string,
    min: number,
    max: number,
    value: number,
    set: (value: number) => void,
  ): { row: HTMLElement; input: HTMLInputElement; show(value: number): void } => {
    const input = rangeInput(min, max, 0.01);
    const readout = document.createElement('span');
    readout.className = 'axys-readout';
    const show = (next: number): void => {
      input.value = String(next);
      readout.textContent = next.toFixed(2);
    };
    show(value);
    input.addEventListener('input', () => {
      const next = Number.parseFloat(input.value);
      readout.textContent = next.toFixed(2);
      set(next);
      schedule();
    });
    const row = document.createElement('div');
    row.className = 'axys-field';
    const caption = guidedLabel(label, guide);
    caption.htmlFor = input.id;
    const pair = document.createElement('div');
    pair.className = 'axys-control-pair';
    pair.append(input, readout);
    row.append(caption, pair);
    return { row, input, show };
  };

  const threshold = slider(
    'Threshold',
    'Pitch clarity a frame needs to count as sung',
    0.05,
    0.5,
    yinThreshold,
    (value) => {
      yinThreshold = value;
    },
  );
  const autoRow = field('Auto Threshold', auto, 'Set the threshold to suit the recording');
  const showAuto = (chose: number): void => {
    threshold.input.disabled = auto.checked;
    if (auto.checked) threshold.show(chose);
  };
  auto.addEventListener('change', () => {
    // Turning Auto off keeps the value it chose, as the starting point to fine-tune from.
    if (!auto.checked) yinThreshold = Number.parseFloat(threshold.input.value);
    threshold.input.disabled = auto.checked;
    schedule();
  });
  const mean = slider(
    'Threshold Mean',
    'Centre of the thresholds pYIN weighs',
    0.05,
    0.6,
    pyinMean,
    (value) => {
      pyinMean = value;
    },
  );
  const strength = slider(
    'Strength',
    'Harmonic strength a frame needs to count as sung',
    0,
    0.6,
    strengthValue,
    (value) => {
      strengthValue = value;
    },
  );

  const low = numberInput({ min: 30, max: 400, step: 1 });
  low.value = String(minHz);
  const high = numberInput({ min: 200, max: 2000, step: 1 });
  high.value = String(maxHz);
  const range = (): void => {
    const lowest = Number.parseFloat(low.value);
    const highest = Number.parseFloat(high.value);
    if (Number.isFinite(lowest) && Number.isFinite(highest) && highest > lowest * 2) {
      minHz = lowest;
      maxHz = highest;
      schedule();
    }
  };
  low.addEventListener('change', range);
  high.addEventListener('change', range);

  const method = selectInput(METHODS.map((entry) => ({ value: entry.value, label: entry.label })));
  method.value = chosen;
  const status = document.createElement('p');
  status.className = 'axys-hint';
  const content = document.createElement('div');
  content.className = 'axys-panel';
  const methodRows = (): HTMLElement[] => {
    switch (chosen) {
      case 'pyin':
        return [mean.row];
      case 'swipe':
        return [strength.row];
      default:
        return [threshold.row, autoRow];
    }
  };
  const layout = (): void => {
    content.replaceChildren(
      field('Method', method, 'How pitch is detected. Try another when notes are missing'),
      ...methodRows(),
      field('Lowest Pitch', low, 'Lowest pitch the vocal reaches', 'Hz'),
      field('Highest Pitch', high, 'Highest pitch the vocal reaches', 'Hz'),
      status,
    );
  };
  method.addEventListener('change', () => {
    chosen = METHODS.find((entry) => entry.value === method.value)?.value ?? 'yin';
    layout();
    schedule();
  });

  const controls = [method, auto, low, high, threshold.input, mean.input, strength.input];
  const enable = (on: boolean): void => {
    for (const control of controls) control.disabled = !on;
    if (on && chosen === 'yin') threshold.input.disabled = auto.checked;
  };

  const report = (outcome: AnalysisOutcome): void => {
    status.textContent = `${String(outcome.blobs)} ${outcome.blobs === 1 ? 'blob' : 'blobs'}`;
    if (chosen === 'yin') showAuto(outcome.threshold);
  };

  let timer = 0;
  let running = false;
  let queued = false;
  const run = async (): Promise<void> => {
    if (settled) return;
    if (running) {
      queued = true;
      return;
    }
    running = true;
    status.textContent = 'Analysing';
    try {
      const outcome = await hooks.analyse(current());
      if (!settled) report(outcome);
    } catch {
      if (!settled) status.textContent = 'Analysis failed';
    } finally {
      running = false;
      if (queued) {
        queued = false;
        void run();
      }
    }
  };
  function schedule(): void {
    if (!loaded || settled) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void run();
    }, SETTLE_MS);
  }
  /** Ends this step, taking the import back now or as soon as it arrives when `undo` says so. */
  const settle = (undo: boolean): void => {
    settled = true;
    window.clearTimeout(timer);
    if (!undo) return;
    if (loaded) hooks.cancel();
    else takeBack = true;
  };

  layout();
  enable(false);
  status.textContent = 'Importing';
  dialog.body.replaceChildren(content);
  // Closing keeps what was imported and its settings; only Cancel and Back take it back.
  onLeave(() => {
    if (settled) return;
    if (loaded) storeAnalysis(current());
    settle(false);
  });

  const actions: DialogAction[] = [
    {
      label: 'Cancel',
      onSelect: () => {
        settle(true);
        dialog.close();
      },
    },
    {
      label: 'Apply',
      kind: 'primary',
      onSelect: () => {
        // Kept as it came in, with the settings it came in with, when it has not loaded yet.
        if (loaded) storeAnalysis(current());
        settle(false);
        dialog.close();
      },
    },
  ];
  if (back) {
    actions.unshift({
      label: 'Back',
      onSelect: () => {
        // Going back while the audio loads would start a second import racing the first.
        if (!loaded) return;
        settle(true);
        askRole(dialog, hooks, onLeave);
      },
    });
  }
  dialog.setActions(actions);

  void hooks.importVocals(initial).then((outcome) => {
    loaded = outcome !== null;
    if (outcome === null) {
      if (!settled) dialog.close();
      return;
    }
    if (takeBack) {
      hooks.cancel();
      return;
    }
    if (settled) return;
    enable(true);
    report(outcome);
    showAuto(outcome.threshold);
  });
}
