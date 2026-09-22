// SPDX-License-Identifier: AGPL-3.0-or-later

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

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
