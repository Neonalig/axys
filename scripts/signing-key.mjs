// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Generates the Ed25519 key pair official release builds are signed with.
 *
 * Writes the public key into `source.json` as the official key, next to the repository it
 * belongs to. With `--gh`, the private key goes straight into the `AXYS_SIGNING_KEY` Actions
 * secret through the GitHub CLI and is never printed or written to disk; without it, the private
 * key is printed once for pasting into the secret by hand. Replacing the key makes every build
 * signed with the old one report as unverified.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';

import { generateSigningKey } from './source-check.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceFile = join(root, 'source.json');

const { privateKey, publicKey } = generateSigningKey();

const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
source.official = { repository: source.repository, publicKey };
writeFileSync(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
console.info(`Wrote the public key for ${source.repository} to source.json. Commit it.`);

if (argv.includes('--gh')) {
  execFileSync('gh', ['secret', 'set', 'AXYS_SIGNING_KEY'], {
    input: privateKey,
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  console.info('Stored the private key in the AXYS_SIGNING_KEY Actions secret.');
} else {
  console.info('\nPrivate key, for the AXYS_SIGNING_KEY Actions secret. It is not shown again:\n');
  console.info(privateKey);
}
