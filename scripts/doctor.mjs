// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reports actionable diagnostics for an Axys development environment.
 *
 * Checks the toolchain here, then prints the browser capabilities Axys probes at
 * runtime so a contributor knows what to look for in the in-app diagnostics panel.
 * Exits non-zero when a required check fails.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_RUST = '1.82.0';

let failures = 0;
let warnings = 0;

function ok(name, detail) {
  console.info(`  ok       ${name}${detail ? ` - ${detail}` : ''}`);
}

function warn(name, detail, fix) {
  warnings += 1;
  console.info(`  warn     ${name}${detail ? ` - ${detail}` : ''}`);
  if (fix) console.info(`           fix: ${fix}`);
}

function fail(name, detail, fix) {
  failures += 1;
  console.info(`  FAIL     ${name}${detail ? ` - ${detail}` : ''}`);
  if (fix) console.info(`           fix: ${fix}`);
}

function info(name, detail) {
  console.info(`  note     ${name}${detail ? ` - ${detail}` : ''}`);
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return null;
  }
}

/** Compares dotted version strings, returning a negative number when `a` is older. */
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

console.info('\nAxys doctor\n');
console.info('Toolchain');

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (nodeMajor >= REQUIRED_NODE_MAJOR) {
  ok('Node', `v${process.versions.node}`);
} else {
  fail(
    'Node',
    `v${process.versions.node}, need v${REQUIRED_NODE_MAJOR} or newer`,
    `install Node ${REQUIRED_NODE_MAJOR} LTS or newer, see .nvmrc`,
  );
}

const rustcOut = run('rustc', ['--version']);
if (!rustcOut) {
  fail('Rust', 'rustc not found', 'install Rust from https://rustup.rs');
} else {
  const version = rustcOut.split(' ')[1] ?? '0.0.0';
  if (compareVersions(version, REQUIRED_RUST) >= 0) {
    ok('Rust', rustcOut);
  } else {
    fail('Rust', `${version}, need ${REQUIRED_RUST} or newer`, 'rustup update stable');
  }
}

if (run('cargo', ['--version'])) ok('Cargo', run('cargo', ['--version']));
else fail('Cargo', 'not found', 'install Rust from https://rustup.rs');

const targets = run('rustup', ['target', 'list', '--installed']) ?? '';
if (targets.includes('wasm32-unknown-unknown')) {
  ok('WASM target', 'wasm32-unknown-unknown');
} else {
  fail(
    'WASM target',
    'wasm32-unknown-unknown is missing',
    'rustup target add wasm32-unknown-unknown',
  );
}

for (const component of ['rustfmt', 'clippy']) {
  const installed = run('rustup', ['component', 'list', '--installed']) ?? '';
  if (installed.includes(component)) ok(`Rust component`, component);
  else fail('Rust component', `${component} is missing`, `rustup component add ${component}`);
}

if (!existsSync(join(root, 'node_modules'))) {
  fail('Node dependencies', 'node_modules is missing', 'npm install');
} else {
  ok('Node dependencies', 'node_modules present');
}

const wasmPackBin = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'wasm-pack.cmd' : 'wasm-pack',
);
if (existsSync(wasmPackBin)) {
  ok('wasm-pack', run(wasmPackBin, ['--version']) ?? 'installed');
} else {
  fail('wasm-pack', 'not installed', 'npm install');
}

const builtWasm = join(root, 'web', 'src', 'wasm', 'axys_wasm_bg.wasm');
if (existsSync(builtWasm)) {
  const bytes = readFileSync(builtWasm).length;
  ok('WASM build', `${(bytes / 1024).toFixed(0)} kB at web/src/wasm`);
} else {
  warn('WASM build', 'not built yet', 'npm run wasm:build');
}

if (run('git', ['rev-parse', '--is-inside-work-tree'])) {
  ok('Source revision', run('git', ['rev-parse', '--short', 'HEAD']) ?? 'unknown');
} else {
  warn('Source revision', 'not a Git checkout', 'set AXYS_SOURCE_REVISION for production builds');
}

console.info('\nBrowser capabilities Axys probes at runtime');
info('WebAssembly', 'required, no fallback');
info('AudioWorklet', 'required for processed playback');
info('IndexedDB', 'required for project persistence');
info('Origin Private File System', 'required to keep decoded audio between sessions');
info('Secure context', 'HTTPS or localhost, required by the above');
info('Autoplay policy', 'playback needs one user gesture before the AudioContext starts');
info('Microphone permission', 'not requested, Axys does not record');
info('WebGPU', 'optional, unused by the current renderer, reported for future measurement');
info('SharedArrayBuffer', 'optional, unused, needs cross-origin isolation if ever enabled');
info('WASM threads', 'optional, unused, single-threaded path is the supported one');
console.info('  Open the app and use Help then Diagnostics to see these for your own browser.');

console.info('');
if (failures > 0) {
  console.info(`${failures} check(s) failed, ${warnings} warning(s).\n`);
  process.exit(1);
}
console.info(`All required checks passed, ${warnings} warning(s).\n`);
