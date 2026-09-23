// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Runs the WASM watcher and the Vite dev server together, and takes both down with it.
 *
 * Both children are started with this Node directly rather than through npm, so no `cmd` shim sits
 * between them and a stop. Ctrl+C, a terminal closing or either child exiting ends the other and
 * this process; on Windows each child's whole process tree is killed, because a child's own
 * children do not follow it there. Each child also watches for this process to vanish, through
 * `AXYS_DEV_PARENT`, for the stops that run no handler.
 *
 * Arguments after `--` go to Vite, such as `npm run dev -- --port 5174`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildWasm = join(root, 'scripts', 'build-wasm.mjs');
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const first = spawnSync(process.execPath, [buildWasm, '--dev'], { stdio: 'inherit', cwd: root });
if (first.status !== 0) process.exit(first.status ?? 1);

const env = { ...process.env, AXYS_DEV_PARENT: String(process.pid) };
const children = [
  spawn(process.execPath, [buildWasm, '--watch'], { stdio: 'inherit', cwd: root, env }),
  spawn(process.execPath, [vite, ...process.argv.slice(2)], { stdio: 'inherit', cwd: root, env }),
];

/** Ends a child and everything it started. */
function kill(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) kill(child);
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => {
    stop(code ?? 0);
  });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => {
    stop(0);
  });
}
process.on('exit', () => {
  for (const child of children) kill(child);
});
