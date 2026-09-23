// SPDX-License-Identifier: AGPL-3.0-or-later

export function normaliseRepository(url: unknown): string | null;
export function buildingRepository(
  env: Record<string, string | undefined>,
  gitRemote?: () => string | null,
): string | null;
export function sourceProblem(configured: string, building: string | null): string | null;
export function signedMessage(repository: string, revision: string, version: string): string;
export function publicKeyOf(privateKey: string): string;
export function signBuild(privateKey: string, message: string): string;
export function generateSigningKey(): { privateKey: string; publicKey: string };
