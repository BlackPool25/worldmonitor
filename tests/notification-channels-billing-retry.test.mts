/**
 * #5622 — the client side of the billing-verification contract.
 *
 * The gap this closes: #5600 taught six Pro-gated endpoints to answer an
 * unverifiable entitlement with `503 + Retry-After + X-Billing-Verification`
 * instead of a terminal "upgrade to Pro". No client honored it. Every function
 * in `src/services/notification-channels.ts` threw
 * ``Error(`... ${res.status}`)`` on any non-2xx, so on the surface the day-0 Pro
 * activation wizard writes through, the new contract was inert — the wizard
 * failed the step exactly as it did before the server fix.
 *
 * Both halves are exercised here: the pure wire decision, and the real
 * `authFetch` retry (through an actual exported service function), because a
 * predicate nobody calls is the same bug in a different place.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  billingVerificationRetryDelayMs,
  setNotificationConfig,
  setEmailChannel,
  getChannelsData,
  __setNotificationChannelsClientDepsForTests,
} from '../src/services/notification-channels.ts';

const RETRYABLE_CODES = [
  'entitlement_verification_unavailable',
  'renewal_verification_pending',
  'renewal_verification_failed',
] as const;

function denial(
  code: string | null,
  retryAfter: string | null,
  status = 503,
  { omitHeader = false } = {},
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (code && !omitHeader) headers.set('X-Billing-Verification', code);
  if (retryAfter !== null) headers.set('Retry-After', retryAfter);
  return new Response(JSON.stringify(code ? { error: 'nope', code } : { error: 'nope' }), {
    status,
    headers,
  });
}

/** Install a fake transport; returns the recorded calls and the slept delays. */
function installTransport(responses: Response[]) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const slept: number[] = [];
  let i = 0;
  __setNotificationChannelsClientDepsForTests({
    getClerkToken: async () => 'token-abc',
    getCurrentClerkUser: () => ({ id: 'user_1' }) as never,
    fetch: (async (path: string, init?: RequestInit) => {
      calls.push({ path, init });
      const res = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return res;
    }) as never,
    sleep: async (ms: number) => { slept.push(ms); },
  });
  return { calls, slept };
}

afterEach(() => {
  __setNotificationChannelsClientDepsForTests(null);
});

describe('billingVerificationRetryDelayMs', () => {
  it('honors Retry-After exactly for every retryable code', () => {
    for (const code of RETRYABLE_CODES) {
      assert.equal(
        billingVerificationRetryDelayMs({ status: 503, code, retryAfterHeader: '5' }),
        5_000,
        `${code} must wait the advertised 5s`,
      );
      assert.equal(
        billingVerificationRetryDelayMs({ status: 503, code, retryAfterHeader: '2' }),
        2_000,
      );
    }
  });

  it('never retries a non-503 — a lapse is a 403 and terminal', () => {
    for (const status of [200, 400, 401, 403, 429, 500, 502]) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status,
          code: 'entitlement_verification_unavailable',
          retryAfterHeader: '5',
        }),
        null,
        `status ${status} must not be retried`,
      );
    }
  });

  it('never retries subscription_lapsed, whatever status carries it', () => {
    for (const status of [403, 503]) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status,
          code: 'subscription_lapsed',
          retryAfterHeader: '5',
        }),
        null,
      );
    }
  });

  it('does not retry a 503 the gate did not produce', () => {
    // This endpoint also 503s for a missing Convex/relay env, and for relay
    // failures that can happen AFTER a mutation partially landed. Retrying a
    // POST on those risks a duplicate write, so the decision is an allowlist of
    // the codes the gate emits BEFORE any write — not "any 503".
    assert.equal(
      billingVerificationRetryDelayMs({ status: 503, code: null, retryAfterHeader: '5' }),
      null,
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'Service unavailable',
        retryAfterHeader: null,
      }),
      null,
    );
  });

  it('falls back to the server default when Retry-After is missing or unusable', () => {
    for (const header of [null, '', 'soon', '0', '-3', 'NaN']) {
      assert.equal(
        billingVerificationRetryDelayMs({
          status: 503,
          code: 'entitlement_verification_unavailable',
          retryAfterHeader: header,
        }),
        5_000,
        `Retry-After ${JSON.stringify(header)} must fall back to 5s`,
      );
    }
  });

  it('declines to retry when the server asks for longer than a user will wait', () => {
    // The server clamps Retry-After to 1-60s. Waiting out 60s inline in the
    // activation wizard is worse than surfacing the failure — and retrying
    // EARLY is not the alternative: the server negative-caches a transient
    // answer, so an early retry is served the same cached failure.
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '60',
      }),
      null,
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '10',
      }),
      10_000,
      '10s is the boundary and is still retried',
    );
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'renewal_verification_pending',
        retryAfterHeader: '11',
      }),
      null,
    );
  });

  it('rounds a fractional delay up rather than retrying early', () => {
    assert.equal(
      billingVerificationRetryDelayMs({
        status: 503,
        code: 'entitlement_verification_unavailable',
        retryAfterHeader: '1.2',
      }),
      1_200,
    );
  });
});

describe('authFetch honors a retryable billing-verification 503', () => {
  it('retries once after the advertised delay and returns the recovered response', async () => {
    const { calls, slept } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      new Response(null, { status: 200 }),
    ]);

    // Resolving without throwing IS the assertion: before the retry existed this
    // rejected with `set notification config: 503`.
    await setNotificationConfig({ variant: 'global', enabled: true });

    assert.equal(calls.length, 2, 'exactly one retry');
    assert.deepEqual(slept, [5_000], 'waited the delay the server asked for');
  });

  it('re-sends the same method, path and body on the retry', async () => {
    const { calls } = installTransport([
      denial('renewal_verification_pending', '3'),
      new Response(null, { status: 200 }),
    ]);

    await setEmailChannel('buyer@example.com');

    assert.equal(calls.length, 2);
    assert.equal(calls[0].path, '/api/notification-channels');
    assert.equal(calls[1].path, calls[0].path);
    assert.equal(calls[1].init?.method, 'POST');
    assert.equal(calls[1].init?.body, calls[0].init?.body);
    assert.match(String(calls[1].init?.body), /buyer@example\.com/);
  });

  it('surfaces the failure when the retry is denied too — exactly one extra attempt', async () => {
    const { calls, slept } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      denial('entitlement_verification_unavailable', '5'),
    ]);

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }),
      /set notification config: 503/,
    );
    assert.equal(calls.length, 2, 'the retry budget is one attempt, not a loop');
    assert.equal(slept.length, 1);
  });

  it('reads the code from the body when the header is unreadable, without consuming the caller stream', async () => {
    // Cross-origin consumers (Tauri shell, widget embeds) and intermediaries can
    // leave the header unreadable; the body's `code` mirrors it. The caller must
    // still be able to read the final response.
    const { calls } = installTransport([
      denial('entitlement_verification_unavailable', '5', 503, { omitHeader: true }),
      new Response(JSON.stringify({ channels: [], alertRules: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    const data = await getChannelsData();

    assert.equal(calls.length, 2);
    assert.deepEqual(data, { channels: [], alertRules: [] });
  });

  it('does not retry a terminal 403 upsell', async () => {
    const { calls, slept } = installTransport([
      denial('subscription_lapsed', null, 403),
    ]);

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }),
      /set notification config: 403/,
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(slept, []);
  });

  it('does not retry the plain pro_required 403 the day-0 marker cohort receives', async () => {
    // That state is a 403 by design (api/notification-channels.ts): turning it
    // into a retry would hand every never-subscribed free user a spinner instead
    // of a clean upsell.
    const { calls } = installTransport([
      new Response(JSON.stringify({ error: 'pro_required' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await assert.rejects(setNotificationConfig({ variant: 'global', enabled: true }));
    assert.equal(calls.length, 1);
  });

  it('does not retry an unrelated 503 that may have already written', async () => {
    const { calls, slept } = installTransport([
      new Response(JSON.stringify({ error: 'Service unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await assert.rejects(setNotificationConfig({ variant: 'global', enabled: true }));
    assert.equal(calls.length, 1, 'a non-gate 503 must not be re-sent');
    assert.deepEqual(slept, []);
  });

  it('does not retry under a different account than the one the caller pinned', async () => {
    // The wait gives a second modal time to switch users. Re-asserting the
    // expected account on the retry keeps a write from landing on the wrong row.
    const { calls } = installTransport([
      denial('entitlement_verification_unavailable', '5'),
      new Response(null, { status: 200 }),
    ]);
    let current = 'user_1';
    __setNotificationChannelsClientDepsForTests({
      getClerkToken: async () => 'token-abc',
      getCurrentClerkUser: () => ({ id: current }) as never,
      fetch: (async (path: string, init?: RequestInit) => {
        calls.push({ path, init });
        // The account changes while we are waiting out the Retry-After.
        current = 'user_2';
        return denial('entitlement_verification_unavailable', '5');
      }) as never,
      sleep: async () => {},
    });

    await assert.rejects(
      setNotificationConfig({ variant: 'global', enabled: true }, 'user_1'),
      /Authenticated account changed/,
    );
  });

  it('leaves a 2xx alone — no clone, no delay, no second call', async () => {
    const { calls, slept } = installTransport([
      new Response(JSON.stringify({ channels: [], alertRules: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ]);

    await getChannelsData();

    assert.equal(calls.length, 1);
    assert.deepEqual(slept, []);
  });
});
