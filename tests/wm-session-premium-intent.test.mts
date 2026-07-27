// Truth table for the two decisions that keep an expected Pro denial out of
// wm-session recovery (#5674):
//
//   1. `hasPremiumIntent(init)` — does this request carry premiumFetch's
//      per-request premium marker?
//   2. `bypassesSessionRecovery(path, init)` — should the interceptor skip the
//      wms_ machinery for it entirely?
//
// Both are pure and exported specifically so this file can pin their shape
// without a DOM. That matters more than usual here: the previous guard for
// this bug class was a source-level wiring check, and a source check goes
// GREEN with the bug restored verbatim — every token it greps for is still
// present when the decision itself is wrong. Assert the decision, not its
// spelling.
//
// The regression these lock: `/api/news/v1/summarize-article` is premium per
// REQUEST, not per path. The gateway charges Pro auth for spend-bearing
// summarize calls (server/gateway.ts `shouldReserveGatewayDirectLlmQuota`)
// while `mode: 'translate'` stays free — and translate REQUIRES the anonymous
// wms_ cookie (verified against prod: no cookie ⇒ 401 "API key required").
// So the path can be in neither PREMIUM_RPC_PATHS (breaks translate) nor
// outside the bypass (each denial cost a mint, a replay, and a 15-minute
// blackout of every anonymous API call).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PREMIUM_INTENT_INIT_KEY,
  hasPremiumIntent,
  withPremiumIntent,
} from '../src/services/premium-intent.ts';
import { bypassesSessionRecovery } from '../src/services/wm-session.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

const SUMMARIZE = '/api/news/v1/summarize-article';
const PREMIUM_PATH = '/api/market/v1/analyze-stock';
const PLAIN_PATH = '/api/economic/v1/get-bls-series';

describe('premium-intent marker', () => {
  it('round-trips through withPremiumIntent', () => {
    assert.equal(hasPremiumIntent(withPremiumIntent()), true);
    assert.equal(hasPremiumIntent(withPremiumIntent({ method: 'POST' })), true);
  });

  it('preserves the caller init it wraps', () => {
    const marked = withPremiumIntent({ method: 'POST', body: '{"mode":"summarize"}' });
    assert.equal(marked.method, 'POST');
    assert.equal(marked.body, '{"mode":"summarize"}');
  });

  it('does not mutate the caller init', () => {
    // premiumFetch hands this object on to globalThis.fetch. Mutating in place
    // would stamp the marker onto an init the caller may reuse for a
    // non-premium request, silently opting THAT one out of session recovery.
    const original: RequestInit = { method: 'POST' };
    withPremiumIntent(original);
    assert.equal(hasPremiumIntent(original), false);
    assert.equal(Object.prototype.hasOwnProperty.call(original, PREMIUM_INTENT_INIT_KEY), false);
  });

  it('is false for every shape that did not opt in', () => {
    for (const init of [
      undefined,
      null,
      {},
      { method: 'POST' },
      { credentials: 'include' } as RequestInit,
    ]) {
      assert.equal(hasPremiumIntent(init as RequestInit | null | undefined), false);
    }
  });

  it('requires exactly true — a truthy value does not opt out of recovery', () => {
    // Strictness is the point: an unrelated spread or a deserialized init that
    // happens to carry a truthy key must not disable session recovery.
    for (const value of [1, 'true', {}, [], 'yes']) {
      const init = { [PREMIUM_INTENT_INIT_KEY]: value } as unknown as RequestInit;
      assert.equal(hasPremiumIntent(init), false, `truthy ${JSON.stringify(value)} must not count`);
    }
    assert.equal(hasPremiumIntent({ [PREMIUM_INTENT_INIT_KEY]: false } as unknown as RequestInit), false);
  });
});

describe('bypassesSessionRecovery truth table', () => {
  const cases: Array<{ name: string; path: string; init?: RequestInit; expected: boolean }> = [
    {
      name: 'path-listed premium route, unmarked — the pre-existing bypass',
      path: PREMIUM_PATH,
      init: undefined,
      expected: true,
    },
    {
      name: 'path-listed premium route, marked — still bypasses',
      path: PREMIUM_PATH,
      init: withPremiumIntent(),
      expected: true,
    },
    {
      name: 'ordinary anonymous route, unmarked — must keep full recovery',
      path: PLAIN_PATH,
      init: undefined,
      expected: false,
    },
    {
      name: 'summarize WITH premium intent — the #5674 fix',
      path: SUMMARIZE,
      init: withPremiumIntent({ method: 'POST' }),
      expected: true,
    },
    {
      name: 'summarize WITHOUT premium intent (free translate) — must keep recovery',
      path: SUMMARIZE,
      init: { method: 'POST' },
      expected: false,
    },
  ];

  for (const { name, path, init, expected } of cases) {
    it(name, () => {
      assert.equal(bypassesSessionRecovery(path, init), expected);
    });
  }

  it('summarize-article stays OUT of PREMIUM_RPC_PATHS', () => {
    // If someone "fixes" #5674 by listing the path instead, the marker becomes
    // dead code AND free translate loses its wms_ cookie for every anonymous
    // visitor — a silent downgrade this assertion catches.
    assert.equal(
      PREMIUM_RPC_PATHS.has(SUMMARIZE),
      false,
      `${SUMMARIZE} must stay out of PREMIUM_RPC_PATHS: its free translate mode `
      + 'requires the anonymous wms_ cookie, which the interceptor stops attaching '
      + 'once the path is listed. Premium-ness here is per-request — use the marker.',
    );
  });
});
