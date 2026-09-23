// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stamps one version into every manifest that records it.
 *
 * `package.json` and the workspace `Cargo.toml` are the two sources every other version string
 * reads from; their lockfiles are updated to match. Usage: `node scripts/set-version.mjs 1.2.0`,
 * where a leading `v`, as in a release tag, is accepted and dropped. `--check` instead exits
 * non-zero when the manifests disagree.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace crates whose entries in `Cargo.lock` carry the workspace version. */
const CRATES = ['axys-core', 'axys-wasm'];

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** The version a tag or argument names, or `null` when it is not semantic versioning. */
export function parseVersion(text) {
  const version = text.trim().replace(/^v/, '');
  return SEMVER.test(version) ? version : null;
}

/** `package.json` or `package-lock.json` text with the project's own version replaced. */
export function stampPackage(text, version) {
  const manifest = JSON.parse(text);
  manifest.version = version;
  if (manifest.packages?.[''] !== undefined) manifest.packages[''].version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** `Cargo.toml` text with the `[workspace.package]` version replaced. */
export function stampCargoManifest(text, version) {
  const section = /^\[workspace\.package\]\s*$/m.exec(text);
  if (section === null) throw new Error('Cargo.toml has no [workspace.package] section');
  const after = text.slice(section.index);
  const line = /^version\s*=\s*"[^"]*"/m.exec(after);
  if (line === null) throw new Error('[workspace.package] has no version');
  const at = section.index + line.index;
  return `${text.slice(0, at)}version = "${version}"${text.slice(at + line[0].length)}`;
}

/** `Cargo.lock` text with each workspace crate's version replaced. */
export function stampCargoLock(text, version) {
  let out = text;
  for (const name of CRATES) {
    const entry = new RegExp(`(name = "${name}"\\r?\\nversion = )"[^"]*"`);
    if (!entry.test(out)) throw new Error(`Cargo.lock has no entry for ${name}`);
    out = out.replace(entry, `$1"${version}"`);
  }
  return out;
}

/** The version each manifest records, keyed by file. */
export function recordedVersions(read) {
  const cargo = /^\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]*)"/m.exec(read('Cargo.toml'));
  return {
    'package.json': JSON.parse(read('package.json')).version,
    'package-lock.json': JSON.parse(read('package-lock.json')).version,
    'Cargo.toml': cargo?.[1],
  };
}

function main() {
  const read = (file) => readFileSync(join(root, file), 'utf8');
  const write = (file, text) => writeFileSync(join(root, file), text);

  if (argv[2] === '--check') {
    const versions = recordedVersions(read);
    const distinct = new Set(Object.values(versions));
    if (distinct.size !== 1) {
      console.error('Version mismatch between manifests:');
      for (const [file, version] of Object.entries(versions))
        console.error(`  ${file}: ${version}`);
      console.error('Run: node scripts/set-version.mjs <version>');
      exit(1);
    }
    console.info(`Version ${[...distinct][0]} in every manifest.`);
    return;
  }

  const version = parseVersion(argv[2] ?? '');
  if (version === null) {
    console.error(`Not a semantic version: ${argv[2] ?? '(none)'}. Expected e.g. 1.2.0 or v1.2.0.`);
    exit(1);
  }
  write('package.json', stampPackage(read('package.json'), version));
  write('package-lock.json', stampPackage(read('package-lock.json'), version));
  write('Cargo.toml', stampCargoManifest(read('Cargo.toml'), version));
  write('Cargo.lock', stampCargoLock(read('Cargo.lock'), version));
  console.info(`Stamped version ${version}.`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main();
}
