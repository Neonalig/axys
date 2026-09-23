// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checks that a build publishes its own source, and signs official release builds.
 *
 * `source.json` names the repository the in-app Source Code link points to, and the official
 * repository with the Ed25519 public key its release pipeline signs with. A release build fails
 * when the named repository is not the one being built, so a fork cannot ship a link to source
 * other than its own. The signature lets a running Axys tell an official build from any other.
 */

import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';

/** The AGPL reminder every source check failure ends with. */
const AGPL =
  'Axys is licensed under the AGPL-3.0, which requires the source of every deployed copy to be ' +
  'public, including modifications. Set "repository" in source.json to the public URL of this ' +
  'repository.';

/**
 * A repository URL in one comparable form, `https://host/owner/name`, or `null` for text that is
 * not a repository URL.
 */
export function normaliseRepository(url) {
  if (typeof url !== 'string') return null;
  let text = url.trim();
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(text);
  if (scp !== null) text = `https://${scp[1]}/${scp[2]}`;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\.git$/, '').replace(/\/+$/, '');
  if (path === '' || path === '/') return null;
  return `https://${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
}

/** The repository a build is running from, or `null` when nothing says. */
export function buildingRepository(env, gitRemote = readGitRemote) {
  if (env.AXYS_BUILD_REPOSITORY) return normaliseRepository(env.AXYS_BUILD_REPOSITORY);
  if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY) {
    return normaliseRepository(`${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}`);
  }
  if (env.CI_PROJECT_URL) return normaliseRepository(env.CI_PROJECT_URL);
  return normaliseRepository(gitRemote());
}

function readGitRemote() {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Compares the repository `source.json` names with the one being built.
 *
 * @returns `null` when they match, or the failure message.
 */
export function sourceProblem(configured, building) {
  const named = normaliseRepository(configured);
  if (named === null) {
    return `Source check failed: source.json names "${configured}", which is not a repository URL.\n${AGPL}`;
  }
  if (building === null) {
    return (
      `Source check failed: cannot tell which repository this build comes from. ` +
      `Build from a Git checkout with an "origin" remote, or set AXYS_BUILD_REPOSITORY to its public URL.\n${AGPL}`
    );
  }
  if (named !== building) {
    return `Source check failed: this build comes from ${building}, but source.json names ${named} as its source.\n${AGPL}`;
  }
  return null;
}

/**
 * The text an official build signs.
 *
 * @remarks `repository` is taken as `source.json` records it, so a running build can rebuild the
 * same text from what it was compiled with.
 */
export function signedMessage(repository, revision, version) {
  return `axys-build\n${repository}\n${revision}\n${version}`;
}

/** The base64url public key of a base64 PKCS#8 private key. */
export function publicKeyOf(privateKey) {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return createPublicKey(key).export({ format: 'jwk' }).x;
}

/** Signs `message` with a base64 PKCS#8 Ed25519 private key, as base64url. */
export function signBuild(privateKey, message) {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  return sign(null, Buffer.from(message, 'utf8'), key).toString('base64url');
}

/** A fresh signing key pair: a base64 PKCS#8 private key and its base64url public key. */
export function generateSigningKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: publicKey.export({ format: 'jwk' }).x,
  };
}
