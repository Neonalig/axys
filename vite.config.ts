// SPDX-License-Identifier: AGPL-3.0-or-later

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, transformWithEsbuild } from 'vite';
import type { Plugin } from 'vite';

/**
 * Reads the source revision for the in-app Source Code entry.
 *
 * Falls back to `unknown` outside a Git checkout so a tarball build still works.
 */
function sourceRevision(): string {
  if (process.env.AXYS_SOURCE_REVISION) return process.env.AXYS_SOURCE_REVISION;
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  if (process.env.CF_PAGES_COMMIT_SHA) return process.env.CF_PAGES_COMMIT_SHA;
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** Files a host serves that are not resources the page loads. */
const NOT_PRECACHED: ReadonlySet<string> = new Set(['_headers']);

/** Every file under `dir`, as paths relative to it with forward slashes. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = relative(dir, join(entry.parentPath, entry.name)).split('\\').join('/');
    if (!NOT_PRECACHED.has(path)) found.push(path);
  }
  return found;
}

/**
 * Emits the service worker and the build stamp beside the page.
 *
 * The worker is written in TypeScript like everything else and compiled here rather than through
 * the bundler, because it has to land at the scope root under a name a running Axys can ask for
 * again; a hashed name in `assets/` would scope it to `assets/` and could never be updated.
 * The precache list is the build's own output, so the WebAssembly core and the bindings that
 * call it are always cached as one unit.
 */
function serviceWorker(version: string, revision: string): Plugin {
  const source = resolve(import.meta.dirname, 'web/src/app/service-worker.ts');
  const publicDir = resolve(import.meta.dirname, 'web/public');
  return {
    name: 'axys-service-worker',
    apply: 'build',
    // After the rest of the build, so the page itself is in the bundle to be listed.
    enforce: 'post',
    async generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((name) => !name.endsWith('.map'));
      const precache = [...built, ...filesUnder(publicDir)].sort();
      const compiled = await transformWithEsbuild(readFileSync(source, 'utf8'), source, {
        loader: 'ts',
        target: 'es2022',
        format: 'esm',
        define: {
          __AXYS_PRECACHE__: JSON.stringify(precache),
          __AXYS_CACHE__: JSON.stringify(`axys-${version}-${revision}`),
        },
      });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: compiled.code });
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify({ version, revision }, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig(() => ({
  // A relative base keeps the build valid at a domain root and at a repository
  // subpath without baking in a hostname.
  base: process.env.AXYS_BASE ?? './',
  root: resolve(import.meta.dirname, 'web'),
  publicDir: resolve(import.meta.dirname, 'web/public'),
  resolve: {
    alias: { '@': resolve(import.meta.dirname, 'web/src') },
  },
  define: {
    __AXYS_VERSION__: JSON.stringify(process.env.npm_package_version ?? '0.0.0'),
    __AXYS_REVISION__: JSON.stringify(sourceRevision()),
    __AXYS_REPOSITORY__: JSON.stringify(
      process.env.AXYS_SOURCE_REPOSITORY ?? 'https://github.com/Neonalig/axys',
    ),
  },
  plugins: [serviceWorker(process.env.npm_package_version ?? '0.0.0', sourceRevision())],
  worker: {
    format: 'es' as const,
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
    assetsInlineLimit: 0,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
    strictPort: false,
  },
}));
