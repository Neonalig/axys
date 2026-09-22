// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builds crates/axys-wasm to web/src/wasm with wasm-pack.
 *
 * Flags: --watch rebuilds on Rust source changes, --dev builds an unoptimised
 * module. Watch mode implies --dev unless --release is given.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(root, 'crates', 'axys-wasm');
const outDir = join(root, 'web', 'src', 'wasm');
const watchRoots = [join(root, 'crates')];

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const release = args.includes('--release') || (!watch && !args.includes('--dev'));

const wasmPackBin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack',
);

function runBuild() {
  return new Promise((resolvePromise) => {
    const profile = release ? '--release' : '--dev';
    const child = spawn(
      wasmPackBin,
      [
        'build',
        crateDir,
        '--target',
        'web',
        '--out-dir',
        outDir,
        '--out-name',
        'axys_wasm',
        '--no-pack',
        '--no-typescript=false',
        profile,
      ].filter((a) => a !== '--no-typescript=false'),
      { stdio: 'inherit', shell: process.platform === 'win32' },
    );
    child.on('exit', (code) => resolvePromise(code ?? 1));
    child.on('error', (err) => {
      console.error(`[wasm] failed to start wasm-pack: ${err.message}`);
      resolvePromise(1);
    });
  });
}

function latestMtime(dir) {
  let newest = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'target' || entry.name === 'pkg' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name.endsWith('.rs') || entry.name.endsWith('.toml')) {
        newest = Math.max(newest, statSync(full).mtimeMs);
      }
    }
  }
  return newest;
}

const first = await runBuild();
if (!watch) {
  process.exit(first);
}

console.log('[wasm] watching crates for changes');
let lastSeen = watchRoots.reduce((acc, dir) => Math.max(acc, latestMtime(dir)), 0);
let building = false;

setInterval(async () => {
  if (building) return;
  const now = watchRoots.reduce((acc, dir) => Math.max(acc, latestMtime(dir)), 0);
  if (now <= lastSeen) return;
  lastSeen = now;
  building = true;
  console.log('[wasm] change detected, rebuilding');
  await runBuild();
  building = false;
}, 700);
