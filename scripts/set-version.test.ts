// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseVersion,
  recordedVersions,
  stampCargoLock,
  stampCargoManifest,
  stampPackage,
  // @ts-expect-error the script is plain JavaScript and has no declarations of its own.
} from './set-version.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (file: string): string => readFileSync(join(root, file), 'utf8');

describe('release version stamping', () => {
  it('reads a version from a tag', () => {
    expect(parseVersion('v1.2.0')).toBe('1.2.0');
    expect(parseVersion('1.2.0-rc.1')).toBe('1.2.0-rc.1');
    expect(parseVersion('v1.2')).toBeNull();
    expect(parseVersion('release')).toBeNull();
  });

  it('stamps every manifest the repository has', () => {
    const version = '9.8.7';
    expect(JSON.parse(stampPackage(read('package.json'), version)).version).toBe(version);
    const lock = JSON.parse(stampPackage(read('package-lock.json'), version));
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);

    const manifest = stampCargoManifest(read('Cargo.toml'), version);
    expect(manifest).toMatch(/\[workspace\.package\]\s*\nversion = "9\.8\.7"/);
    expect(manifest.split('\n').length).toBe(read('Cargo.toml').split('\n').length);

    const cargoLock = stampCargoLock(read('Cargo.lock'), version);
    expect(cargoLock).toContain('name = "axys-core"\nversion = "9.8.7"');
    expect(cargoLock).toContain('name = "axys-wasm"\nversion = "9.8.7"');
  });

  it('finds the manifests in agreement', () => {
    expect(new Set(Object.values(recordedVersions(read))).size).toBe(1);
  });
});
