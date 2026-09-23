// SPDX-License-Identifier: AGPL-3.0-or-later

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { defineConfig, transformWithOxc } from 'vite';
import type { Plugin } from 'vite';

import {
  buildingRepository,
  normaliseRepository,
  publicKeyOf,
  signBuild,
  signedMessage,
  sourceProblem,
} from './scripts/source-check.mjs';
import { exitWithParent } from './scripts/exit-with-parent.mjs';

// A dev server started by `scripts/dev.mjs` goes when the launcher does, however it was stopped.
exitWithParent();

/** What `source.json` records. */
interface SourceConfig {
  /** Public repository holding this build's corresponding source. */
  repository: string;
  /** The upstream repository and the Ed25519 public key its release builds are signed with. */
  official: { repository: string; publicKey: string };
}

const source = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'source.json'), 'utf8'),
) as SourceConfig;

/** The one version string every other copy is stamped from. */
const version = (
  JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

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

const revision = sourceRevision();

/**
 * Signs this build for the in-app Verified Source badge, or returns an empty signature.
 *
 * @throws When `AXYS_SIGNING_KEY` does not match the official public key, or when an
 * `AXYS_RELEASE` build of the official repository has no key.
 */
function buildSignature(): string {
  const key = process.env.AXYS_SIGNING_KEY?.trim();
  if (!key) {
    const official =
      buildingRepository(process.env) === normaliseRepository(source.official.repository);
    if (process.env.AXYS_RELEASE === 'true' && official) {
      throw new Error(
        'Release builds of the official repository must be signed. Set the AXYS_SIGNING_KEY Actions secret; see docs/deployment.md.',
      );
    }
    return '';
  }
  if (publicKeyOf(key) !== source.official.publicKey) {
    throw new Error(
      'AXYS_SIGNING_KEY does not match official.publicKey in source.json. Run node scripts/signing-key.mjs to generate a matching pair.',
    );
  }
  return signBuild(key, signedMessage(source.repository, revision, version));
}

/**
 * Fails a release build when `source.json` does not name the repository being built, so every
 * deployed copy links to its own public source. A development server only warns.
 */
function sourceCheck(): Plugin {
  return {
    name: 'axys-source-check',
    configResolved(config) {
      const problem = sourceProblem(source.repository, buildingRepository(process.env));
      if (problem === null) return;
      if (config.command === 'build') throw new Error(problem);
      config.logger.warn(problem);
    },
  };
}

/** Cross-origin isolation, matching what `web/public/_headers` sends in production. */
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

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
      const compiled = await transformWithOxc(readFileSync(source, 'utf8'), source, {
        lang: 'ts',
        target: 'es2022',
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
    __AXYS_VERSION__: JSON.stringify(version),
    __AXYS_REVISION__: JSON.stringify(revision),
    __AXYS_REPOSITORY__: JSON.stringify(source.repository),
    __AXYS_SIGNATURE__: JSON.stringify(buildSignature()),
    __AXYS_OFFICIAL_REPOSITORY__: JSON.stringify(source.official.repository),
    __AXYS_OFFICIAL_KEY__: JSON.stringify(source.official.publicKey),
  },
  plugins: [sourceCheck(), serviceWorker(version, revision)],
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
    headers: ISOLATION_HEADERS,
  },
  preview: {
    port: 4173,
    strictPort: false,
    headers: ISOLATION_HEADERS,
  },
}));
