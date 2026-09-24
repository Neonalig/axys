// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Vitest global setup that produces the production build once, before any test file runs.
 *
 * Suites that read `dist/` share this build, since a build per suite would race: each one
 * empties `dist/` while another reads it. An existing build is reused.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const root = resolve(import.meta.dirname, '..', '..');
const dist = join(root, 'dist');

export default async function setup(): Promise<void> {
  if (existsSync(join(dist, 'index.html')) && existsSync(join(dist, 'sw.js'))) return;
  // Node and Vite are run directly rather than through `npm run build`: every nested npm
  // prepends a node_modules/.bin per ancestor directory, and under `npm run check` in a deep
  // checkout the PATH passes cmd.exe's 8191 character limit, so `node` stops resolving.
  execFileSync(process.execPath, [join(root, 'scripts', 'build-wasm.mjs')], {
    cwd: root,
    stdio: 'inherit',
  });
  await build({ configFile: join(root, 'vite.config.ts'), logLevel: 'warn' });
}
