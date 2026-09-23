// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Builds crates/axys-wasm to web/src/wasm with wasm-pack.
 *
 * Flags: --watch rebuilds on Rust source changes, --dev builds an unoptimised
 * module, --force rebuilds even when the output is already current. Watch mode
 * implies --dev unless --release is given.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exitWithParent } from './exit-with-parent.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = join(root, 'crates', 'axys-wasm');
const outDir = join(root, 'web', 'src', 'wasm');
const watchRoots = [join(root, 'crates')];

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const force = args.includes('--force');
const release = args.includes('--release') || (!watch && !args.includes('--dev'));

/** Records which profile produced the output, so a dev build is never mistaken for a release one. */
const stampFile = join(outDir, '.build-profile');

/** Files outside `crates/` that still change what wasm-pack produces. */
const manifests = [join(root, 'Cargo.toml'), join(root, 'Cargo.lock')];

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

/**
 * Whether the output is present, built from this profile, and newer than every input.
 *
 * The profile is part of the question rather than the mtimes alone: a dev build is newer than the
 * sources too, and shipping one as a release would be silent. An input with no mtime, which is a
 * source tree that does not exist, is treated as not current rather than as unchanged.
 */
function isCurrent() {
  const wasm = join(outDir, 'axys_wasm_bg.wasm');
  if (!existsSync(wasm) || !existsSync(stampFile)) return false;
  if (readFileSync(stampFile, 'utf8').trim() !== (release ? 'release' : 'dev')) return false;
  const built = statSync(wasm).mtimeMs;
  const newest = Math.max(
    watchRoots.reduce((acc, dir) => Math.max(acc, latestMtime(dir)), 0),
    ...manifests.map((file) => (existsSync(file) ? statSync(file).mtimeMs : 0)),
  );
  return newest > 0 && built >= newest;
}

function stamp() {
  writeFileSync(stampFile, release ? 'release' : 'dev');
}

if (!force && isCurrent()) {
  console.log(`[wasm] ${release ? 'release' : 'dev'} build is current, skipping`);
  if (!watch) process.exit(0);
} else {
  const first = await runBuild();
  if (first === 0) stamp();
  if (!watch) process.exit(first);
  if (first !== 0) process.exit(first);
}

exitWithParent();
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
  if ((await runBuild()) === 0) stamp();
  building = false;
}, 700);
