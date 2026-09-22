// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest';

// @ts-expect-error the script is plain JavaScript and has no declarations of its own.
import { tokenProblem } from './check-cloudflare.mjs';

/** A verify response, with `result` merged over a token that is usable now. */
function verified(result: Record<string, unknown> = {}, success = true) {
  return {
    success,
    errors: [],
    messages: [],
    result: { id: 'abc', status: 'active', ...result },
  };
}

const NOW = new Date('2026-09-22T18:14:13Z');

describe('what stops a Cloudflare token working', () => {
  it('passes a token that is active and in date', () => {
    expect(tokenProblem(verified(), NOW)).toBeNull();
  });

  it('passes a token with a window that is open', () => {
    const body = verified({
      not_before: '2026-09-01T00:00:00Z',
      expires_on: '2027-09-23T23:59:59Z',
    });
    expect(tokenProblem(body, NOW)).toBeNull();
  });

  // A TTL window dated from UTC midnight, which reports `active` before it has started.
  it('catches a token that reports active before its start date', () => {
    const body = {
      result: {
        id: 'df4b2d0ae46b4d364aacc8f06efcb751',
        status: 'active',
        not_before: '2026-09-23T00:00:00Z',
        expires_on: '2027-09-23T23:59:59Z',
      },
      success: true,
      errors: [],
      messages: [
        { code: 10002, message: 'This API Token can not be used before 2026-09-23 00:00:00+00' },
      ],
    };
    expect(tokenProblem(body, NOW)).toMatch(/not usable until 2026-09-23T00:00:00Z/);
  });

  it('passes that same token once its start date has passed', () => {
    const body = verified({
      not_before: '2026-09-23T00:00:00Z',
      expires_on: '2027-09-23T23:59:59Z',
    });
    expect(tokenProblem(body, new Date('2026-09-23T00:00:01Z'))).toBeNull();
  });

  it('catches an expired token', () => {
    const body = verified({ expires_on: '2026-09-01T00:00:00Z' });
    expect(tokenProblem(body, NOW)).toMatch(/expired on 2026-09-01/);
  });

  it('catches a disabled token', () => {
    expect(tokenProblem(verified({ status: 'disabled' }), NOW)).toBe('disabled');
  });

  it('catches a rejected request', () => {
    const body = { success: false, errors: [{ code: 6003, message: 'Invalid request headers' }] };
    expect(tokenProblem(body, NOW)).toBe('not valid');
  });
});
