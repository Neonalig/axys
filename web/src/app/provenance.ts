// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Tells an official Axys build from any other by its release signature.
 *
 * The official release pipeline signs the repository, revision and version a build was made from
 * with an Ed25519 key; the matching public key is compiled in from `source.json`.
 */

declare const __AXYS_VERSION__: string;
declare const __AXYS_REVISION__: string;
declare const __AXYS_REPOSITORY__: string;
declare const __AXYS_SIGNATURE__: string;
declare const __AXYS_OFFICIAL_REPOSITORY__: string;
declare const __AXYS_OFFICIAL_KEY__: string;

/**
 * Where a build came from, as far as its signature shows.
 *
 * @remarks `unofficial` covers an unsigned build and one naming another repository; `invalid` is
 * a signature that does not match the build; `unchecked` is a browser without Ed25519 support.
 */
export type Provenance = 'official' | 'unofficial' | 'invalid' | 'unchecked';

/** A build's signed identity and the official key it is checked against. */
export interface SignedBuild {
  repository: string;
  revision: string;
  version: string;
  /** Base64url Ed25519 signature, empty for an unsigned build. */
  signature: string;
  officialRepository: string;
  /** Base64url Ed25519 public key, empty when none is configured. */
  officialKey: string;
}

/** This build, as it was compiled. */
export function thisBuild(): SignedBuild {
  return {
    repository: __AXYS_REPOSITORY__,
    revision: __AXYS_REVISION__,
    version: __AXYS_VERSION__,
    signature: __AXYS_SIGNATURE__,
    officialRepository: __AXYS_OFFICIAL_REPOSITORY__,
    officialKey: __AXYS_OFFICIAL_KEY__,
  };
}

/** The text the release pipeline signs, matching `signedMessage` in `scripts/source-check.mjs`. */
export function signedMessage(repository: string, revision: string, version: string): string {
  return `axys-build\n${repository}\n${revision}\n${version}`;
}

/** Checks a build's signature against the official public key. Never throws. */
export async function checkProvenance(build: SignedBuild = thisBuild()): Promise<Provenance> {
  if (build.signature === '' || build.officialKey === '') return 'unofficial';
  if (build.repository !== build.officialRepository) return 'unofficial';
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return 'unchecked';

  let key: CryptoKey;
  try {
    key = await subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: build.officialKey },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    return 'unchecked';
  }
  try {
    const verified = await subtle.verify(
      { name: 'Ed25519' },
      key,
      fromBase64Url(build.signature),
      new TextEncoder().encode(signedMessage(build.repository, build.revision, build.version)),
    );
    return verified ? 'official' : 'invalid';
  } catch {
    return 'invalid';
  }
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
