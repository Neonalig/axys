// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

import {
  buildingRepository,
  generateSigningKey,
  normaliseRepository,
  publicKeyOf,
  sourceProblem,
} from './source-check.mjs';

const OFFICIAL = 'https://github.com/Neonalig/axys';

describe('source check', () => {
  it('reads every common form of a repository URL alike', () => {
    for (const url of [
      'https://github.com/Neonalig/axys',
      'https://github.com/Neonalig/axys.git',
      'https://github.com/neonalig/axys/',
      'git@github.com:Neonalig/axys.git',
      'ssh://git@github.com/Neonalig/axys.git',
    ]) {
      expect(normaliseRepository(url)).toBe('https://github.com/neonalig/axys');
    }
    expect(normaliseRepository('not a url')).toBeNull();
  });

  it('finds the building repository in CI before the Git remote', () => {
    const remote = (): string => 'git@github.com:someone/fork.git';
    expect(
      buildingRepository(
        { GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'Neonalig/axys' },
        remote,
      ),
    ).toBe('https://github.com/neonalig/axys');
    expect(buildingRepository({}, remote)).toBe('https://github.com/someone/fork');
    expect(buildingRepository({ AXYS_BUILD_REPOSITORY: OFFICIAL }, remote)).toBe(
      'https://github.com/neonalig/axys',
    );
    expect(buildingRepository({}, () => null)).toBeNull();
  });

  it('passes a build of the named repository and stops a fork naming upstream', () => {
    expect(sourceProblem(OFFICIAL, 'https://github.com/neonalig/axys')).toBeNull();
    expect(sourceProblem(OFFICIAL, 'https://github.com/someone/fork')).toMatch(
      /this build comes from https:\/\/github\.com\/someone\/fork[\s\S]*AGPL-3\.0/,
    );
    expect(sourceProblem(OFFICIAL, null)).toMatch(/AXYS_BUILD_REPOSITORY/);
    expect(sourceProblem('nowhere', 'https://github.com/neonalig/axys')).toMatch(
      /not a repository URL/,
    );
  });

  it('derives the public key a generated private key pairs with', () => {
    const { privateKey, publicKey } = generateSigningKey();
    expect(publicKeyOf(privateKey)).toBe(publicKey);
  });
});
