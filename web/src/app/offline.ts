// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Offline install and the update prompt.
 *
 * Registers the service worker that precaches the build, then asks the host whether it is still
 * serving the build this page came from. A newer one is offered rather than taken: the panel
 * carries a reload button and is dismissed like any other.
 */

import { Dialog } from '../ui/dialog.js';

declare const __AXYS_REVISION__: string;

/** Where the build records what it is, for comparing the page against what is served now. */
const VERSION_FILE = 'version.json';

/** Shortest gap between update checks, so returning to the tab does not poll the host. */
const CHECK_INTERVAL_MS = 60_000;

/** What the build writes beside the page so a running Axys can tell it is out of date. */
interface BuildInfo {
  version: string;
  revision: string;
}

/**
 * Registers the worker and watches for a newer build.
 *
 * @remarks Returns a disposer. Does nothing where the browser has no service worker, which
 * leaves Axys working exactly as it did, online only.
 */
export function startOffline(): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};

  const container = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration | null = null;
  let prompted = false;
  let checkedAt = 0;
  let released = false;

  const offer = (worker: ServiceWorker): void => {
    if (prompted || released) return;
    prompted = true;
    showUpdate(worker, container);
  };

  const watch = (found: ServiceWorkerRegistration): void => {
    registration = found;
    // A worker already waiting is an update this page has not been offered yet, which is what a
    // second tab opened after the download looks like.
    if (found.waiting && container.controller) offer(found.waiting);
    found.addEventListener('updatefound', () => {
      const installing = found.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // No controller means this is the first install, which is the page already running.
        if (installing.state === 'installed' && container.controller) offer(installing);
      });
    });
  };

  const check = (): void => {
    const now = Date.now();
    if (released || registration === null || now - checkedAt < CHECK_INTERVAL_MS) return;
    checkedAt = now;
    void (async () => {
      if (await isStale()) await registration?.update();
    })();
  };

  void container.register(new URL('sw.js', location.href)).then(watch, () => {
    // A host that will not serve the worker leaves Axys online-only, which is not a failure the
    // user can act on and not one worth a toast.
  });

  const onOnline = (): void => {
    check();
  };
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') check();
  };
  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    released = true;
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * Whether the host is serving a different build from the one this page is running.
 *
 * @remarks Read past every cache, because a cached answer would be the page's own build saying
 * it is current. Offline, or served by a host without the file, the answer is no.
 */
async function isStale(): Promise<boolean> {
  if (navigator.onLine === false) return false;
  try {
    const response = await fetch(new URL(VERSION_FILE, location.href), { cache: 'no-store' });
    if (!response.ok) return false;
    const build = (await response.json()) as Partial<BuildInfo>;
    if (typeof build.revision !== 'string') return false;
    return build.revision !== __AXYS_REVISION__;
  } catch {
    return false;
  }
}

/**
 * Offers the downloaded build, and swaps to it when the user asks.
 *
 * @remarks The panel does not block, because nothing about the editor stops working while it is
 * open. Reloading loses no work: projects are in IndexedDB and their audio in the origin private
 * file system, and neither is touched by a reload.
 */
function showUpdate(worker: ServiceWorker, container: ServiceWorkerContainer): void {
  const body = document.createElement('p');
  body.className = 'axys-hint';
  body.textContent = 'A new version of Axys is ready. Reload to update.';

  Dialog.open({
    title: 'Update Ready',
    icon: 'info',
    content: body,
    blocking: false,
    actions: [
      {
        label: 'Reload',
        kind: 'primary',
        onSelect: (dialog) => {
          dialog.close();
          container.addEventListener(
            'controllerchange',
            () => {
              location.reload();
            },
            { once: true },
          );
          worker.postMessage({ type: 'skipWaiting' });
        },
      },
    ],
  });
}
