// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The service worker: one cache per build, so Axys runs after a single visit with no network.
 *
 * The build injects the file list and the cache name, and install fills one cache with the whole
 * list in a single `addAll`. That is what keeps the WebAssembly core and the JavaScript that
 * binds to it together: a cache holding new bindings and an old core is a broken editor, and an
 * `addAll` that fails leaves the previous build serving as it was.
 *
 * Nothing here contacts a network service. Every request is answered from the cache, and only a
 * request the build did not cover reaches the network at all.
 */

/** Every file the build produced, relative to the worker's own scope. */
declare const __AXYS_PRECACHE__: readonly string[];

/** Cache name for this build, carrying its version and revision. */
declare const __AXYS_CACHE__: string;

const scope = self as unknown as ServiceWorkerGlobalScope;

/** What the page asks the worker to do. */
interface WorkerCommand {
  type: 'skipWaiting';
}

scope.addEventListener('install', (event) => {
  const install = event as ExtendableEvent;
  install.waitUntil(
    caches.open(__AXYS_CACHE__).then((cache) => cache.addAll([...__AXYS_PRECACHE__])),
  );
});

scope.addEventListener('activate', (event) => {
  const activate = event as ExtendableEvent;
  activate.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name !== __AXYS_CACHE__ && name.startsWith('axys-')) await caches.delete(name);
      }
      await scope.clients.claim();
    })(),
  );
});

scope.addEventListener('message', (event) => {
  const command = event.data as WorkerCommand | null;
  // The page asks for the swap rather than the worker taking it: an update that replaced the
  // running build under an open project would reload the editor out from under an edit.
  if (command?.type === 'skipWaiting') void scope.skipWaiting();
});

scope.addEventListener('fetch', (event) => {
  const request = (event as FetchEvent).request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.location.origin) return;
  (event as FetchEvent).respondWith(answer(request));
});

/**
 * Answers one request from the build's cache, falling back to the network.
 *
 * @remarks A navigation is answered with the cached page whatever path it names, because the
 * editor is one page and a deep link to it is still that page.
 */
async function answer(request: Request): Promise<Response> {
  const cache = await caches.open(__AXYS_CACHE__);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  try {
    return await fetch(request);
  } catch {
    return new Response('Axys is offline and this file is not in its cache.', {
      status: 504,
      statusText: 'Offline',
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
}
