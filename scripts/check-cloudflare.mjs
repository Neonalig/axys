// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Reports whether the Cloudflare credentials can reach the Pages project, before a deploy tries.
 *
 * Wrangler reports a token it cannot use and an account it cannot reach the same way, so this
 * asks the questions separately and names which answer was wrong. Reads `CLOUDFLARE_API_TOKEN`,
 * `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_PAGES_PROJECT` from the environment and prints neither
 * secret. Exits non-zero on the first failure.
 */

import { argv, env, exit } from 'node:process';
import { pathToFileURL } from 'node:url';

const API = 'https://api.cloudflare.com/client/v4';
const WHERE = 'Settings, Secrets and variables, Actions';

/**
 * What stops a token working right now, or `null`.
 *
 * @remarks Allows for a TTL window that has not started. Such a token reports `active` while
 * every call it makes fails as an authentication error.
 */
export function tokenProblem(body, now = new Date()) {
  const status = body.result?.status;
  if (body.success !== true || status === undefined) return 'not valid';
  if (status !== 'active') return status;

  const notBefore = body.result.not_before;
  if (notBefore && new Date(notBefore) > now) {
    return `not usable until ${notBefore}, which is ${local(notBefore)} here`;
  }
  const expiresOn = body.result.expires_on;
  if (expiresOn && new Date(expiresOn) < now) return `expired on ${expiresOn}`;
  return null;
}

/** The same instant in this machine's own zone, so a UTC boundary is recognisable. */
function local(iso) {
  return new Date(iso).toLocaleString(undefined, { timeZoneName: 'short' });
}

/** The `[code] message` lines of a failed response, indented, or an empty string. */
export function reasons(body) {
  const errors = Array.isArray(body.errors) ? body.errors : [];
  return errors.map((error) => `\n  [${error.code}] ${error.message}`).join('');
}

/**
 * The accounts this token can reach, as lines to append to a failure.
 *
 * @remarks Names the mismatch rather than leaving the account id and the token's own scope to be
 * compared by hand. An id the token can reach is not the configured one, so it is not a secret
 * this run holds and is printed. A token too narrow to list accounts says so instead.
 */
async function reachable(token) {
  const accounts = await get('/accounts', token);
  if (accounts.success !== true) {
    return '\nThis token cannot list accounts either. Check its Permissions are Account, Cloudflare Pages, Edit.';
  }
  const found = (accounts.result ?? []).map((entry) => `${entry.name} (${entry.id})`);
  if (found.length === 0) {
    return '\nThis token reaches no account at all. Check Account Resources on the token.';
  }
  return (
    `\nThis token reaches: ${found.join(', ')}.` +
    '\nSet CLOUDFLARE_ACCOUNT_ID to one of those ids, or widen Account Resources on the token.'
  );
}

/** Prints a GitHub error annotation, or a plain line elsewhere, and stops. */
function fail(message) {
  console.error(env.GITHUB_ACTIONS ? `::error::${message}` : `error: ${message}`);
  exit(1);
}

/** Calls the API, returning the parsed body whatever the status, so errors can be read. */
async function get(path, token) {
  let response;
  try {
    response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  } catch (cause) {
    return fail(`Could not reach the Cloudflare API: ${cause.message}`);
  }
  try {
    return await response.json();
  } catch {
    return fail(`The Cloudflare API answered ${response.status} with something that is not JSON.`);
  }
}

async function main() {
  const token = env.CLOUDFLARE_API_TOKEN ?? '';
  const account = env.CLOUDFLARE_ACCOUNT_ID ?? '';
  const project = env.CLOUDFLARE_PAGES_PROJECT ?? 'axys';

  if (token === '') fail(`CLOUDFLARE_API_TOKEN is empty. Add it under ${WHERE}.`);
  if (account === '') fail(`CLOUDFLARE_ACCOUNT_ID is empty. Add it under ${WHERE}.`);

  const verified = await get('/user/tokens/verify', token);
  const problem = tokenProblem(verified);
  if (problem !== null) {
    fail(`The API token is ${problem}.${reasons(verified)}`);
  }
  console.info('  ok       API token is active and in date');

  const projects = await get(`/accounts/${account}/pages/projects`, token);
  if (projects.success !== true) {
    fail(
      `The token is in date but cannot reach this account's Pages.${reasons(projects)}` +
        `${await reachable(token)}`,
    );
  }

  const names = (projects.result ?? []).map((entry) => entry.name);
  if (!names.includes(project)) {
    fail(
      `This account has no Pages project named ${project}.` +
        `${names.length > 0 ? ` It has: ${names.join(', ')}.` : ' It has none.'}\n` +
        `Create it with: npx wrangler pages project create ${project} --production-branch main`,
    );
  }
  console.info(`  ok       Pages project ${project} is reachable`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  await main();
}
