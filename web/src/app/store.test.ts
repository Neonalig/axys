// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppStore, batchUpdate, initialState } from './store.js';
import type { AppState } from './store.js';
import type { RenderPlan } from '../core/types.js';

function plan(ratio: number): RenderPlan {
  return {
    sampleRate: 48000,
    timeMap: {
      points: [
        [0, 0],
        [1, 1],
      ],
    },
    pitchRatio: { start: 0, hop: 0.01, values: [ratio, ratio] },
    targetMidi: { start: 0, hop: 0.01, values: [0, 0] },
    gain: { start: 0, hop: 0.01, values: [1, 1] },
    formant: 'preserve',
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function store(): AppStore {
  return new AppStore(initialState());
}

describe('initialState', () => {
  it('starts empty, unedited and stopped', () => {
    const state = initialState();
    expect(state.phase).toBe('empty');
    expect(state.message).toBeNull();
    expect(state.source).toBeNull();
    expect(state.track).toBeNull();
    expect(state.blobs).toEqual([]);
    expect(state.conflicts).toEqual([]);
    expect(state.edits).toBeNull();
    expect(state.plan).toBeNull();
    expect(state.midi).toBeNull();
    expect(state.mappingReport).toBeNull();
    expect(state.drift).toBeNull();
    expect(state.selection).toEqual({ blobs: [], anchors: [], ranges: [] });
    expect(state.tool).toBe('select');
    expect(state.transport).toEqual({
      playing: false,
      position: 0,
      loop: null,
      returnToStart: true,
      metronome: false,
      countIn: false,
    });
    expect(state.analysis).toEqual({ running: false, progress: 0, stage: '' });
    expect(state.dirty).toBe(false);
  });

  it('opens on the default ten second, MIDI 36 to 84 view', () => {
    expect(initialState().view).toEqual({
      visibleStart: 0,
      visibleEnd: 10,
      lowMidi: 36,
      highMidi: 84,
      timeDisplay: 'seconds',
      snapDivision: 4,
      playhead: 0,
      loopStart: null,
      loopEnd: null,
    });
  });

  it('hands out a fresh object graph each call', () => {
    const a = initialState();
    const b = initialState();
    expect(a).not.toBe(b);
    expect(a.view).not.toBe(b.view);
    expect(a.selection).not.toBe(b.selection);
    expect(a.transport).not.toBe(b.transport);
    a.blobs.push(...[]);
    a.selection.blobs.push(3);
    expect(b.selection.blobs).toEqual([]);
  });
});

describe('AppStore.update', () => {
  it('replaces the state object rather than mutating it', () => {
    const s = store();
    const before = s.state;
    s.update({ phase: 'loading' });
    expect(s.state).not.toBe(before);
    expect(before.phase).toBe('empty');
    expect(s.state.phase).toBe('loading');
  });

  it('keeps untouched fields identical by reference', () => {
    const s = store();
    const view = s.state.view;
    const selection = s.state.selection;
    s.update({ dirty: true });
    expect(s.state.view).toBe(view);
    expect(s.state.selection).toBe(selection);
  });

  it('applies several keys at once', () => {
    const s = store();
    s.update({ phase: 'error', message: 'Decode failed', dirty: true });
    expect(s.state.phase).toBe('error');
    expect(s.state.message).toBe('Decode failed');
    expect(s.state.dirty).toBe(true);
  });

  it('carries a compiled plan and replaces it on recompile', () => {
    const s = store();
    const first = plan(1.5);
    s.update({ plan: first });
    expect(s.state.plan).toBe(first);
    const second = plan(2);
    s.update({ plan: second });
    expect(s.state.plan).toBe(second);
    s.update({ plan: null });
    expect(s.state.plan).toBeNull();
  });

  it('notifies every subscriber exactly once with the new state', () => {
    const s = store();
    const first = vi.fn();
    const second = vi.fn();
    s.subscribe(first);
    s.subscribe(second);
    s.update({ tool: 'split' });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0]).toBe(s.state);
    expect(second.mock.calls[0]?.[0]?.tool).toBe('split');
  });

  it('notifies once for an empty patch', () => {
    const s = store();
    const seen = vi.fn();
    s.subscribe(seen);
    s.update({});
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('notifies in subscription order', () => {
    const s = store();
    const order: string[] = [];
    s.subscribe(() => order.push('first'));
    s.subscribe(() => order.push('second'));
    s.subscribe(() => order.push('third'));
    s.update({ tool: 'pitch' });
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

describe('AppStore.subscribe', () => {
  it('stops delivering after unsubscribe', () => {
    const s = store();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    s.update({ dirty: true });
    off();
    s.update({ dirty: false });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('tolerates unsubscribing twice', () => {
    const s = store();
    const seen = vi.fn();
    const off = s.subscribe(seen);
    off();
    off();
    s.update({ dirty: true });
    expect(seen).not.toHaveBeenCalled();
  });

  it('does not call a subscriber removed during the same notification', () => {
    const s = store();
    const late = vi.fn();
    const off = s.subscribe(late);
    s.subscribe(() => off());
    // The remover is second, so `late` has already run once for this update.
    s.update({ dirty: true });
    expect(late).toHaveBeenCalledTimes(1);
    s.update({ dirty: false });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('does not call a subscriber added during the same notification', () => {
    const s = store();
    const added = vi.fn();
    s.subscribe(() => {
      s.subscribe(added);
    });
    s.update({ dirty: true });
    expect(added).not.toHaveBeenCalled();
    s.update({ dirty: false });
    expect(added).toHaveBeenCalledTimes(1);
  });

  it('delivers to a duplicate registration once', () => {
    const s = store();
    const seen = vi.fn();
    s.subscribe(seen);
    s.subscribe(seen);
    s.update({ dirty: true });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('subscriber failures', () => {
  it('keeps notifying the others when one throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store();
    const before = vi.fn();
    const after = vi.fn();
    s.subscribe(before);
    s.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    s.subscribe(after);
    expect(() => s.update({ tool: 'pen' })).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('reports the failure rather than swallowing it silently', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store();
    const failure = new Error('subscriber exploded');
    s.subscribe(() => {
      throw failure;
    });
    s.update({ dirty: true });
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]?.[1]).toBe(failure);
  });

  it('commits the state before notifying, so a throw cannot roll it back', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = store();
    s.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    s.update({ phase: 'ready' });
    expect(s.state.phase).toBe('ready');
  });
});

describe('nested updates', () => {
  it('lets a subscriber update the store and sees the latest state afterwards', () => {
    const s = store();
    let guard = true;
    s.subscribe((state) => {
      if (guard && state.phase === 'loading') {
        guard = false;
        s.update({ phase: 'ready', message: null });
      }
    });
    s.update({ phase: 'loading', message: 'Analysing' });
    expect(s.state.phase).toBe('ready');
    expect(s.state.message).toBeNull();
  });

  it('gives each subscriber the state of the update it is being notified for', () => {
    const s = store();
    const phases: string[] = [];
    let guard = true;
    s.subscribe((state) => {
      if (guard && state.tool === 'split') {
        guard = false;
        s.update({ tool: 'pitch' });
      }
    });
    s.subscribe((state) => phases.push(state.tool));
    s.update({ tool: 'split' });
    expect(phases).toEqual(['pitch', 'split']);
  });
});

describe('batchUpdate', () => {
  it('merges the patches into one notification', () => {
    const s = store();
    const seen = vi.fn();
    s.subscribe(seen);
    batchUpdate(s, [{ phase: 'ready' }, { dirty: true }, { tool: 'time' }]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(s.state.phase).toBe('ready');
    expect(s.state.dirty).toBe(true);
    expect(s.state.tool).toBe('time');
  });

  it('lets a later patch win over an earlier one', () => {
    const s = store();
    batchUpdate(s, [{ tool: 'pitch' }, { tool: 'time' }]);
    expect(s.state.tool).toBe('time');
  });

  it('does nothing for an empty list', () => {
    const s = store();
    const before = s.state;
    const seen = vi.fn();
    s.subscribe(seen);
    batchUpdate(s, []);
    expect(seen).not.toHaveBeenCalled();
    expect(s.state).toBe(before);
  });

  it('leaves the source patches untouched', () => {
    const s = store();
    const patch: Partial<AppState> = { phase: 'loading' };
    batchUpdate(s, [patch, { dirty: true }]);
    expect(patch).toEqual({ phase: 'loading' });
  });
});
