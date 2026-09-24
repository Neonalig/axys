// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Serves the production build the way a static host would and checks that it loads
 * at a domain root and at a repository subpath, with correct WASM MIME handling.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const dist = join(root, 'dist');

/** Every built file, as paths relative to `dist/` with forward slashes. */
function filesUnderDist(): string[] {
  return readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .slice(dist.length + 1)
        .split(sep)
        .join('/'),
    );
}

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
    built = existsSync(join(dist, 'index.html'));
  });

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

  it('precaches the whole build as one unit', () => {
    const worker = readFileSync(join(dist, 'sw.js'), 'utf8');
    // Read the strings the worker carries rather than the shape a compiler wrote them in. The
    // precache list is generated, so what matters is which names reach the worker, not whether
    // the bundler emitted them as one array literal or many lines.
    const listed = new Set(
      [...worker.matchAll(/'([^'\n]+)'|"([^"\n]+)"/g)].map((m) => m[1] ?? m[2] ?? ''),
    );

    // A cache holding new bindings and an old core is a broken editor, so the build goes in whole
    // or not at all. The bindings are a static import of the entry and of each worker, so they
    // ride in those chunks rather than in one of their own.
    const served = filesUnderDist().filter(
      (file) => !['_headers', 'sw.js', 'version.json'].includes(file) && !file.endsWith('.map'),
    );
    expect(served.length).toBeGreaterThan(8);
    for (const file of served) {
      expect(listed.has(file), `${file} was built but is not precached`).toBe(true);
    }

    expect(served.some((file) => file.endsWith('.wasm'))).toBe(true);
    expect(served.some((file) => /assets\/index-.*\.js$/.test(file))).toBe(true);
    expect(served.some((file) => /assets\/analysis\.worker-.*\.js$/.test(file))).toBe(true);
    expect(served.some((file) => /assets\/render\.worker-.*\.js$/.test(file))).toBe(true);
    expect(served).toContain('index.html');
    expect(served).toContain('manifest.webmanifest');

    // Response headers are the host's, and the two the update check reads must never be cached.
    expect(listed.has('_headers')).toBe(false);
    expect(listed.has('version.json')).toBe(false);
    for (const name of listed) {
      expect(name.endsWith('.map'), `${name} is a source map and need not be cached`).toBe(false);
    }
  });

  it('stamps the build so a running Axys can tell it is out of date', () => {
    const stamp = JSON.parse(readFileSync(join(dist, 'version.json'), 'utf8')) as {
      version: string;
      revision: string;
    };
    expect(stamp.version).toBeTruthy();
    expect(stamp.revision).toBeTruthy();
    const worker = readFileSync(join(dist, 'sw.js'), 'utf8');
    expect(worker).toContain(`axys-${stamp.version}-${stamp.revision}`);
  });

  it('declares an installable app with a maskable icon', () => {
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')) as {
      display: string;
      icons: { src: string; purpose: string }[];
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.some((icon) => icon.purpose.includes('maskable'))).toBe(true);
    for (const icon of manifest.icons) {
      expect(existsSync(join(dist, icon.src.replace('./', '')))).toBe(true);
    }
    expect(readFileSync(join(dist, 'index.html'), 'utf8')).toContain('manifest.webmanifest');
  });

  it('declares itself the handler for its project files', () => {
    const manifest = JSON.parse(readFileSync(join(dist, 'manifest.webmanifest'), 'utf8')) as {
      file_handlers?: { accept: Record<string, string[]> }[];
      launch_handler?: { client_mode: string };
    };
    const extensions = (manifest.file_handlers ?? []).flatMap((handler) =>
      Object.values(handler.accept).flat(),
    );
    expect(extensions).toContain('.axys');
    expect(manifest.launch_handler?.client_mode).toBe('focus-existing');
  });

  it('serves the worker and the build stamp uncached', () => {
    const headers = readFileSync(join(dist, '_headers'), 'utf8');
    expect(headers).toMatch(/\/sw\.js\s+Cache-Control: no-cache/);
    expect(headers).toMatch(/\/version\.json\s+Cache-Control: no-cache/);
  });

  it('ships the host headers with cross-origin isolation', () => {
    const headers = readFileSync(join(dist, '_headers'), 'utf8');
    expect(headers).toContain('Content-Security-Policy');
    const active = headers
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');
    expect(active).toContain('Cross-Origin-Opener-Policy: same-origin');
    expect(active).toContain('Cross-Origin-Embedder-Policy: require-corp');
  });
});
