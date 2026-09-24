// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs the built service worker against a stand-in cache and checks what offline install
 * actually promises: one cache per build, filled as one unit, answering every request the
 * editor makes without a network.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

type Listener = (event: unknown) => void;

/** Where the worker is served from in these tests: a repository subpath, not a domain root. */
const SCOPE = 'https://example.invalid/axys/';

/** The few fields of a request the worker reads, so no DOM Request is needed. */
interface FakeRequest {
  url: string;
  method: string;
  mode: string;
}

function request(path: string, patch: Partial<FakeRequest> = {}): FakeRequest {
  return { url: new URL(path, SCOPE).href, method: 'GET', mode: 'cors', ...patch };
}

/**
 * A cache that records what was put in it and answers by URL.
 *
 * @remarks Keys resolve against the worker's own scope, which is what the browser does, so a
 * path cached under a repository subpath is asked for under that subpath too.
 */
class FakeCache {
  readonly entries = new Map<string, Response>();

  addAll(paths: string[]): Promise<void> {
    for (const path of paths) {
      if (!existsSync(join(dist, path))) return Promise.reject(new Error(`${path} was not built`));
      this.entries.set(new URL(path, SCOPE).href, new Response(`body of ${path}`));
    }
    return Promise.resolve();
  }

  match(target: FakeRequest | string): Promise<Response | undefined> {
    const url = typeof target === 'string' ? new URL(target, SCOPE).href : target.url;
    return Promise.resolve(this.entries.get(url));
  }
}

/** The subset of the cache storage API the worker uses. */
class FakeCaches {
  readonly opened = new Map<string, FakeCache>();
  readonly deleted: string[] = [];

  open(name: string): Promise<FakeCache> {
    let cache = this.opened.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.opened.set(name, cache);
    }
    return Promise.resolve(cache);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.opened.keys(), 'axys-0.0.0-older', 'other-app-cache']);
  }

  delete(name: string): Promise<boolean> {
    this.deleted.push(name);
    return Promise.resolve(this.opened.delete(name));
  }
}

/** The worker, loaded with every global it touches replaced by a stand-in. */
interface LoadedWorker {
  listeners: Map<string, Listener>;
  caches: FakeCaches;
  claimed: { count: number };
  skipped: { count: number };
  fetched: string[];
}

function loadWorker(networkFails = false): LoadedWorker {
  const code = readFileSync(join(dist, 'sw.js'), 'utf8');
  const listeners = new Map<string, Listener>();
  const claimed = { count: 0 };
  const skipped = { count: 0 };
  const fetched: string[] = [];
  const storage = new FakeCaches();
  const scope = {
    addEventListener(type: string, listener: Listener) {
      listeners.set(type, listener);
    },
    location: new URL('https://example.invalid/axys/sw.js'),
    clients: {
      claim: () => {
        claimed.count += 1;
        return Promise.resolve();
      },
    },
    skipWaiting: () => {
      skipped.count += 1;
      return Promise.resolve();
    },
  };
  const network = (target: FakeRequest | string): Promise<Response> => {
    fetched.push(typeof target === 'string' ? target : target.url);
    return networkFails
      ? Promise.reject(new Error('offline'))
      : Promise.resolve(new Response('from the network'));
  };
  const load = new Function('self', 'caches', 'fetch', code) as (
    self: unknown,
    caches: unknown,
    fetch: unknown,
  ) => void;
  load(scope, storage, network);
  return { listeners, caches: storage, claimed, skipped, fetched };
}

/** Runs one lifecycle handler and waits for the work it extended the event with. */
async function dispatch(worker: LoadedWorker, type: string, extra: object = {}): Promise<void> {
  const listener = worker.listeners.get(type);
  expect(listener, `the worker handles ${type}`).toBeTruthy();
  let work: Promise<unknown> = Promise.resolve();
  listener?.({
    waitUntil: (promise: Promise<unknown>) => {
      work = promise;
    },
    ...extra,
  });
  await work;
}

/** Runs the fetch handler and returns what it answered with, or null when it passed. */
async function answer(worker: LoadedWorker, asked: FakeRequest): Promise<Response | null> {
  const listener = worker.listeners.get('fetch');
  let answered: Promise<Response> | null = null;
  listener?.({
    request: asked,
    respondWith: (response: Promise<Response>) => {
      answered = response;
    },
  });
  return answered === null ? null : await answered;
}

describe('offline install', () => {
  it('caches the whole build in one cache under one name', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'install');
    expect(worker.caches.opened.size).toBe(1);
    const [name, cache] = [...worker.caches.opened.entries()][0] ?? ['', null];
    expect(name).toMatch(/^axys-/);
    expect(cache?.entries.size ?? 0).toBeGreaterThan(5);
  });

  it('drops the caches of older builds and keeps everyone else alone', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'install');
    await dispatch(worker, 'activate');
    expect(worker.caches.deleted).toContain('axys-0.0.0-older');
    expect(worker.caches.deleted).not.toContain('other-app-cache');
    expect(worker.claimed.count).toBe(1);
  });

  it('answers a precached asset without touching the network', async () => {
    const worker = loadWorker(true);
    await dispatch(worker, 'install');
    const wasm = [...(worker.caches.opened.values().next().value?.entries.keys() ?? [])].find(
      (file) => file.endsWith('.wasm'),
    );
    expect(wasm).toBeTruthy();
    const response = await answer(worker, request(wasm ?? ''));
    expect(await response?.text()).toContain('.wasm');
    expect(worker.fetched).toEqual([]);
  });

  it('answers a navigation with the cached page', async () => {
    const worker = loadWorker(true);
    await dispatch(worker, 'install');
    const response = await answer(worker, request('anything', { mode: 'navigate' }));
    expect(await response?.text()).toContain('index.html');
  });

  it('leaves another origin and a write alone', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'install');
    const elsewhere = { url: 'https://elsewhere.invalid/thing.js', method: 'GET', mode: 'cors' };
    expect(await answer(worker, elsewhere)).toBe(null);
    expect(await answer(worker, request('', { method: 'POST' }))).toBe(null);
  });

  it('swaps to the new build only when the page asks', async () => {
    const worker = loadWorker();
    await dispatch(worker, 'install');
    worker.listeners.get('message')?.({ data: { type: 'somethingElse' } });
    expect(worker.skipped.count).toBe(0);
    worker.listeners.get('message')?.({ data: { type: 'skipWaiting' } });
    expect(worker.skipped.count).toBe(1);
  });
});
