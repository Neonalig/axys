// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import { generateSigningKey, signBuild, signedMessage } from '../../../scripts/source-check.mjs';
import { checkProvenance } from './provenance';
import type { SignedBuild } from './provenance';

const REPOSITORY = 'https://github.com/Neonalig/axys';

/** A build signed the way the release pipeline signs one. */
function signed(overrides: Partial<SignedBuild> = {}): SignedBuild {
  const { privateKey, publicKey } = generateSigningKey();
  const build = { repository: REPOSITORY, revision: 'abc1234', version: '1.2.0' };
  return {
    ...build,
    signature: signBuild(
      privateKey,
      signedMessage(build.repository, build.revision, build.version),
    ),
    officialRepository: REPOSITORY,
    officialKey: publicKey,
    ...overrides,
  };
}

describe('build provenance', () => {
  it('verifies a build the release pipeline signed', async () => {
    expect(await checkProvenance(signed())).toBe('official');
  });

  it('rejects a signature that does not match the build', async () => {
    const build = signed();
    expect(await checkProvenance({ ...build, version: '1.2.1' })).toBe('invalid');
    expect(await checkProvenance({ ...build, officialKey: signed().officialKey })).toBe('invalid');
  });

  it('reports an unsigned build or a fork as unofficial', async () => {
    expect(await checkProvenance(signed({ signature: '' }))).toBe('unofficial');
    expect(await checkProvenance(signed({ repository: 'https://github.com/someone/axys' }))).toBe(
      'unofficial',
    );
  });
});
