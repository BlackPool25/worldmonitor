/**
 * #5619 — a signed-out caller is not a free-plan caller.
 *
 * `resolvePremiumCallerIdentity` answered every denial with the same
 * `{ isPremium: false, userId: null, kind: null }`, so `api/chat-analyst.ts`
 * told a signed-out visitor to buy a Pro subscription instead of to sign in.
 * The client classifier has carried a `sign_in_required` verdict since #5608,
 * but nothing on this route could ever produce it: the verdict is keyed on a
 * 401 (or an authentication code), and the route only ever emitted 403.
 *
 * The signal is additive in the same way `billingDenial` is (#5622):
 * `isPremium: false` keeps its exact meaning — grant nothing — so the ~25
 * `isCallerPremium()` consumers are untouched. Only the wording changes, and
 * only for callers that read the field.
 *
 * The two halves are pinned separately and then end to end:
 *   - which denials are credential denials (the identity resolver)
 *   - that the route turns exactly those into a 401 (the real handler)
 *   - that the 401 reaches the client as `sign_in_required` (the classifier)
 */
import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { resolvePremiumCallerIdentity } from '../server/_shared/premium-check.ts';
import { __resetEntitlementNegativeCacheForTests } from '../server/_shared/entitlement-check.ts';
import {
  INTERNAL_MCP_VERIFIED_HEADER,
  TRUSTED_USER_ID_HEADER,
  getInternalMcpVerifiedNonce,
} from '../server/_shared/mcp-internal-hmac.ts';
import { classifyDenialResponse } from '../src/services/premium-denial.ts';
import { analystDenialMessage } from '../src/services/analyst-denial.ts';

const VERIFIED_NONCE = getInternalMcpVerifiedNonce();
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = { ...process.env };

/** Client with no opinion at all — the signed-out case. */
const NO_BELIEF = { entitlementTier: null, authRole: null };

const FREE_ROW = {
  planKey: 'free',
  features: {
    tier: 0,
    apiAccess: false,
    apiRateLimit: 0,
    maxDashboards: 3,
    prioritySupport: false,
    exportFormats: ['csv'],
    mcpAccess: false,
  },
  validUntil: 0,
};

/**
 * Steer the entitlement lookup: Redis always misses so every call reaches the
 * Convex fallback, which answers with `row`. Any other fetch is a bug in the
 * test — an unauthenticated caller must not reach a backend at all.
 */
function installFetchStub(row: unknown) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : String((input as Request)?.url ?? input);
    if (url.includes('redis.test/get/')) {
      return new Response(JSON.stringify({ result: undefined }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('redis.test')) return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    if (url.includes('/api/internal-entitlements')) {
      return new Response(JSON.stringify(row), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

/** No credential of any kind — the signed-out browser. */
function anonymousRequest(): Request {
  return new Request('https://api.worldmonitor.app/api/chat-analyst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://worldmonitor.app' },
    body: JSON.stringify({ query: 'what is happening in the strait of hormuz' }),
  });
}

/** A credential that is present but does not validate. */
function badCredentialRequest(headers: Record<string, string>): Request {
  return new Request('https://api.worldmonitor.app/api/chat-analyst', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://worldmonitor.app', ...headers },
    body: JSON.stringify({ query: 'what is happening in the strait of hormuz' }),
  });
}

/**
 * A CONFIRMED free account. Driven through the internal-MCP verified-marker
 * branch, the one path whose only network dependency is `getEntitlements`, so a
 * fetch stub is enough to steer the verdict without standing up Clerk.
 */
function confirmedFreeRequest(userId: string): Request {
  return new Request('https://api.worldmonitor.app/api/chat-analyst', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://worldmonitor.app',
      [INTERNAL_MCP_VERIFIED_HEADER]: VERIFIED_NONCE,
      [TRUSTED_USER_ID_HEADER]: userId,
    },
    body: JSON.stringify({ query: 'what is happening in the strait of hormuz' }),
  });
}

beforeEach(() => {
  process.env.CONVEX_SITE_URL = 'https://fake.convex.site';
  process.env.CONVEX_SERVER_SHARED_SECRET = 'fake-secret';
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-test-token';
  // A validated enterprise key would short-circuit to premium; keep the set
  // empty so the credential branches below are the ones under test.
  delete process.env.WORLDMONITOR_VALID_KEYS;
  __resetEntitlementNegativeCacheForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  __resetEntitlementNegativeCacheForTests();
});

describe('resolvePremiumCallerIdentity separates a missing credential from a free plan (#5619)', () => {
  it('a caller with no credential at all is unauthenticated, not free', async () => {
    installFetchStub(FREE_ROW); // must never be consulted

    const identity = await resolvePremiumCallerIdentity(anonymousRequest());

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, true);
    assert.equal(identity.billingDenial, undefined, 'no lookup happened, so nothing to classify');
  });

  it('an invalid bearer token is a credential denial', async () => {
    installFetchStub(FREE_ROW);

    const identity = await resolvePremiumCallerIdentity(
      badCredentialRequest({ Authorization: 'Bearer not-a-real-jwt' }),
    );

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, true);
  });

  it('an unknown API key is a credential denial, not an upsell', async () => {
    installFetchStub(FREE_ROW);

    const identity = await resolvePremiumCallerIdentity(
      badCredentialRequest({ 'X-WorldMonitor-Key': 'nope' }),
    );

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, true);
  });

  it('a spoofed internal-MCP marker falls through to the credential denial', async () => {
    // The marker branch deliberately does not short-circuit on a nonce
    // mismatch: the attacker gets exactly the auth surface of a caller who
    // sent no marker at all — which is now a 401, not an upsell.
    globalThis.fetch = (async () => {
      throw new Error('getEntitlements must not run for a spoofed marker');
    }) as typeof fetch;

    const identity = await resolvePremiumCallerIdentity(
      badCredentialRequest({
        [INTERNAL_MCP_VERIFIED_HEADER]: '1',
        [TRUSTED_USER_ID_HEADER]: 'user_spoofed',
      }),
    );

    assert.equal(identity.isPremium, false);
    assert.equal(identity.unauthenticated, true);
  });

  it('a CONFIRMED free account is NOT flagged unauthenticated — that verdict is about the plan', async () => {
    installFetchStub(FREE_ROW);

    const identity = await resolvePremiumCallerIdentity(confirmedFreeRequest('user_free_identity'));

    assert.equal(identity.isPremium, false);
    assert.equal(
      identity.unauthenticated,
      undefined,
      'flagging a signed-in free user unauthenticated would replace a working upsell with a sign-in loop',
    );
  });
});

describe('api/chat-analyst answers a missing credential with 401 (#5619)', () => {
  it('a signed-out caller is told to sign in, not to subscribe', async () => {
    installFetchStub(FREE_ROW);
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(anonymousRequest());

    assert.equal(res.status, 401);
    assert.deepEqual(await res.clone().json(), { error: 'UNAUTHENTICATED' });
    // The panel is cross-origin: an opaque failure is indistinguishable from a
    // crash, so CORS must survive the denial.
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://worldmonitor.app');
  });

  it('an invalid bearer token gets the same 401', async () => {
    installFetchStub(FREE_ROW);
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(badCredentialRequest({ Authorization: 'Bearer not-a-real-jwt' }));

    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'UNAUTHENTICATED' });
  });

  it('a CONFIRMED free caller still gets the honest 403 upsell', async () => {
    installFetchStub(FREE_ROW);
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(confirmedFreeRequest('user_free_route'));

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'Pro subscription required' });
  });

  it("the client's sign_in_required verdict is reachable on this route at last", async () => {
    installFetchStub(FREE_ROW);
    const { default: handler } = await import('../api/chat-analyst.ts');

    const res = await handler(anonymousRequest());
    const verdict = await classifyDenialResponse(res, NO_BELIEF);

    assert.equal(verdict, 'sign_in_required');
    assert.equal(analystDenialMessage(res.status, verdict), 'Sign in to use the analyst.');
  });
});
