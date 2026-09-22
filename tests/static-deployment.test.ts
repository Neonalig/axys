// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Serves the production build the way a static host would and checks that it loads
 * at a domain root and at a repository subpath, with correct WASM MIME handling.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

/**
 * A minimal static file server rooted at `dist`, optionally mounted under a prefix.
 *
 * It deliberately has no SPA rewrite, so a genuine 404 stays a 404 and a broken
 * asset path fails the test instead of silently serving the page.
 */
function serve(prefix: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (prefix !== '' && !path.startsWith(prefix)) {
      res.writeHead(404).end('outside mount');
      return;
    }
    path = path.slice(prefix.length);
    if (path === '' || path.endsWith('/')) path += 'index.html';
    const target = normalize(join(dist, path));
    if (!target.startsWith(dist + sep) && target !== dist) {
      res.writeHead(403).end('traversal');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'content-length': statSync(target).size,
    });
    createReadStream(target).pipe(res);
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      done({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

/** Collects every relative asset the built HTML and its entry script reference. */
function assetsReferencedBy(html: string): string[] {
  const refs = new Set<string>();
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const value = m[1];
    if (value && !value.startsWith('http') && !value.startsWith('data:')) refs.add(value);
  }
  return [...refs];
}

describe('static deployment', () => {
  let built = false;

  beforeAll(() => {
    if (!existsSync(join(dist, 'index.html'))) {
      execFileSync('npm', ['run', 'build'], {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
    }
    built = existsSync(join(dist, 'index.html'));
  }, 600_000);

  it('produces a static build with no server requirement', () => {
    expect(built).toBe(true);
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(html).toContain('<div id="app">');
  });

  it('references every asset relatively, so no origin or path is baked in', () => {
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    const refs = assetsReferencedBy(html);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('/'), `${ref} is absolute and would break at a subpath`).toBe(false);
    }
  });

  it('ships a WebAssembly module', () => {
    const wasm = readFileSync(join(dist, 'index.html'), 'utf8');
    expect(wasm).toBeTruthy();
    const assets = execFileSync(
      process.platform === 'win32' ? 'cmd' : 'ls',
      process.platform === 'win32'
        ? ['/c', 'dir', '/b', join(dist, 'assets')]
        : [join(dist, 'assets')],
      { encoding: 'utf8' },
    );
    expect(assets).toMatch(/\.wasm/);
  });

  for (const [name, prefix] of [
    ['domain root', ''],
    ['repository subpath', '/axys'],
  ] as const) {
    describe(name, () => {
      let server: Server;
      let origin: string;

      beforeAll(async () => {
        ({ server, origin } = await serve(prefix));
      });

      afterAll(() => {
        server?.close();
      });

      it('serves the page', async () => {
        const res = await fetch(`${origin}${prefix}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        expect(await res.text()).toContain('id="app"');
      });

      it('serves every asset the page references', async () => {
        const html = await (await fetch(`${origin}${prefix}/`)).text();
        const refs = assetsReferencedBy(html);
        for (const ref of refs) {
          const url = new URL(ref, `${origin}${prefix}/`);
          const res = await fetch(url);
          expect(res.status, `${ref} did not load at ${name}`).toBe(200);
        }
      });

      it('serves WebAssembly with the right media type and magic bytes', async () => {
        const listing = readFileSync(join(dist, 'index.html'), 'utf8');
        expect(listing).toBeTruthy();
        const jsRef = assetsReferencedBy(listing).find((r) => r.endsWith('.js'));
        expect(jsRef).toBeTruthy();
        const js = await (await fetch(new URL(jsRef as string, `${origin}${prefix}/`))).text();
        const wasmRef = js.match(/["'`]([^"'`]*\.wasm)["'`]/)?.[1];
        expect(wasmRef, 'the entry script should reference the WASM module').toBeTruthy();
        const res = await fetch(new URL(wasmRef as string, `${origin}${prefix}/assets/`));
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/wasm');
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect([...bytes.slice(0, 4)]).toEqual([0x00, 0x61, 0x73, 0x6d]);
      });

      it('returns 404 for a missing file rather than the page', async () => {
        const res = await fetch(`${origin}${prefix}/does-not-exist.js`);
        expect(res.status).toBe(404);
      });
    });
  }

  it('ships the optional host headers without mandating cross-origin isolation', () => {
    const headers = readFileSync(join(dist, '_headers'), 'utf8');
    expect(headers).toContain('Content-Security-Policy');
    const active = headers
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).not.toContain('Cross-Origin-Embedder-Policy');
  });
});
