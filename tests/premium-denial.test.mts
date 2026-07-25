/**
 * Unit tests for the pure premium-denial classifier (#5608).
 *
 * The module under test is a zero-import leaf, so it stays importable under
 * `tsx --test` (no jsdom, no Vite globals) — same pattern as
 * tests/billing-state.test.mts and tests/pro-activation-state.test.mts.
 *
 * The bug: a 403 from a premium endpoint was rendered as "Pro required —
 * upgrade" unconditionally, so a user who had paid minutes earlier saw an
 * upsell during the #5600 entitlement-cache poison window. A 403 the client's
 * own entitlement state disagrees with is a server-side desync, not a missing
 * plan, and `/api/latest-brief` additionally returns 403 for a rejected origin
 * — which is not an entitlement verdict at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyPremiumDenial,
  clientBelievesPro,
  isTransientDenial,
  readDenialErrorCode,
  PRO_TIER,
  type ClientEntitlementBelief,
} from '@/services/premium-denial';

/** No entitlement snapshot has arrived and the session carries no Pro role. */
const UNKNOWN: ClientEntitlementBelief = { entitlementTier: null, authRole: null };
/** Convex snapshot arrived and says free. */
const FREE: ClientEntitlementBelief = { entitlementTier: 0, authRole: null };
/** Convex snapshot arrived and says Pro — the #5608 case. */
const PRO: ClientEntitlementBelief = { entitlementTier: PRO_TIER, authRole: null };
/** No snapshot, but the Clerk session claims the Pro role. */
const CLERK_PRO: ClientEntitlementBelief = { entitlementTier: null, authRole: 'pro' };

describe('clientBelievesPro', () => {
  it('no snapshot and no role claim → no affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(UNKNOWN), false);
  });

  it('snapshot says free → no affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(FREE), false);
  });

  it('snapshot at or above the Pro tier → affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(PRO), true);
    assert.equal(clientBelievesPro({ entitlementTier: PRO_TIER + 5, authRole: null }), true);
  });

  it('Clerk role claim alone is an affirmative Pro belief', () => {
    assert.equal(clientBelievesPro(CLERK_PRO), true);
  });

  it('a free snapshot does not veto a Pro role claim (either signal suffices)', () => {
    assert.equal(clientBelievesPro({ entitlementTier: 0, authRole: 'pro' }), true);
  });

  it('non-pro role strings are not a Pro belief', () => {
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'free' }), false);
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'admin' }), false);
    assert.equal(clientBelievesPro({ entitlementTier: null, authRole: 'PRO' }), false);
  });

  it('a negative or fractional tier below PRO_TIER is not a Pro belief', () => {
    assert.equal(clientBelievesPro({ entitlementTier: -1, authRole: null }), false);
    assert.equal(clientBelievesPro({ entitlementTier: 0.5, authRole: null }), false);
  });
});

describe('classifyPremiumDenial — non-denial statuses', () => {
  it('returns null for success and for server errors the caller retries anyway', () => {
    for (const status of [200, 204, 400, 404, 429, 500, 502, 503]) {
      assert.equal(
        classifyPremiumDenial({ status, errorCode: null, belief: PRO }),
        null,
        `status ${status} is not a denial the classifier owns`,
      );
    }
  });
});

describe('classifyPremiumDenial — 401', () => {
  it('is always sign_in_required, whatever the client believes', () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 401, errorCode: 'UNAUTHENTICATED', belief }),
        'sign_in_required',
      );
    }
  });

  it('does not need an error code', () => {
    assert.equal(
      classifyPremiumDenial({ status: 401, errorCode: null, belief: PRO }),
      'sign_in_required',
    );
  });
});

describe('classifyPremiumDenial — 403 entitlement denials', () => {
  it('client agrees it is free → upgrade_required (the honest upsell)', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: FREE }),
      'upgrade_required',
    );
  });

  it('client has no opinion yet → upgrade_required (server is authoritative)', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: UNKNOWN }),
      'upgrade_required',
    );
  });

  it('#5608: client entitlement snapshot says Pro → entitlement_desync, never an upsell', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: PRO }),
      'entitlement_desync',
    );
  });

  it('#5608: Clerk Pro role claim also blocks the upsell', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'pro_required', belief: CLERK_PRO }),
      'entitlement_desync',
    );
  });

  it('a bare 403 with no error code is still treated as an entitlement verdict', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: null, belief: FREE }),
      'upgrade_required',
    );
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: null, belief: PRO }),
      'entitlement_desync',
    );
  });

  /**
   * Every string a 403 actually carries today. Drift here silently turns an
   * upsell into a retry loop (or back again), so they are pinned explicitly:
   *   api/latest-brief.ts:201                  → 'pro_required'
   *   api/chat-analyst.ts:126                  → 'Pro subscription required'
   *   server/_shared/entitlement-check.ts:556  → 'Upgrade required'
   *   server/_shared/entitlement-check.ts:446  → 'Subscription lapsed'
   *   api/internal/mcp-grant-*.ts              → 'INSUFFICIENT_TIER'
   */
  it('recognises every entitlement code the REST, RPC and MCP surfaces emit', () => {
    for (const code of [
      'pro_required',
      'Pro subscription required',
      'upgrade_required',
      'Upgrade required',
      'plan_required',
      'Subscription lapsed',
      'INSUFFICIENT_TIER',
      'PRO_REQUIRED',
    ]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }),
        'upgrade_required',
        `${code} is an entitlement denial`,
      );
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: PRO }),
        'entitlement_desync',
        `${code} must not upsell a client that believes it is Pro`,
      );
    }
  });

  it('normalises separators and case so pro_required and "Pro required" agree', () => {
    for (const code of ['pro_required', 'PRO-REQUIRED', 'Pro required', '  pro_required  ']) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }),
        'upgrade_required',
      );
    }
  });
});

describe('classifyPremiumDenial — 403 that means "authenticate", not "upgrade"', () => {
  /**
   * The shared gateway 403s (not 401s) an unauthenticated caller —
   * server/_shared/entitlement-check.ts:508. Rendering that as an upsell
   * tells a signed-out user to buy a plan they may already own.
   */
  it("gateway 'Authentication required' is sign_in_required", () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Authentication required', belief }),
        'sign_in_required',
      );
    }
  });

  it("'UNAUTHENTICATED' on a 403 is also sign_in_required", () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'UNAUTHENTICATED', belief: FREE }),
      'sign_in_required',
    );
  });
});

describe('classifyPremiumDenial — 403 that is not about entitlement', () => {
  it("api/latest-brief's 'Origin not allowed' is access_denied, not an upsell", () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Origin not allowed', belief }),
        'access_denied',
        'a rejected origin must never be rendered as a missing plan',
      );
    }
  });

  it('an unrecognised 403 code is access_denied even for a free client', () => {
    assert.equal(
      classifyPremiumDenial({ status: 403, errorCode: 'forbidden_by_waf', belief: FREE }),
      'access_denied',
    );
  });

  /**
   * server/_shared/entitlement-check.ts:527 fails CLOSED when Redis and Convex
   * are both unreachable. That 403 states nothing about the plan, so it must
   * never upsell — not even a client with no entitlement snapshot.
   */
  it("'Unable to verify entitlements' is access_denied for every belief", () => {
    for (const belief of [UNKNOWN, FREE, PRO, CLERK_PRO]) {
      assert.equal(
        classifyPremiumDenial({ status: 403, errorCode: 'Unable to verify entitlements', belief }),
        'access_denied',
        'a failed entitlement lookup is not a verdict about the plan',
      );
    }
  });
});

describe('readDenialErrorCode', () => {
  const json = (body: unknown, status = 403) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  it("extracts the real api/latest-brief 403 body's error field", async () => {
    const res = json({
      error: 'pro_required',
      message: 'The Brief is available on the Pro plan.',
      upgradeUrl: 'https://worldmonitor.app/pro',
    });
    assert.equal(await readDenialErrorCode(res), 'pro_required');
  });

  it("extracts the gateway's 'Upgrade required' body", async () => {
    const res = json({ error: 'Upgrade required', requiredTier: 1, currentTier: 0, planKey: 'free' });
    assert.equal(await readDenialErrorCode(res), 'Upgrade required');
  });

  it('a non-JSON body yields null rather than throwing', async () => {
    const res = new Response('<html>403 Forbidden</html>', { status: 403 });
    assert.equal(await readDenialErrorCode(res), null);
  });

  it('an empty body yields null', async () => {
    assert.equal(await readDenialErrorCode(new Response(null, { status: 403 })), null);
  });

  it('a JSON body with no error field yields null', async () => {
    assert.equal(await readDenialErrorCode(json({ message: 'nope' })), null);
  });

  it('a non-string error field yields null (no [object Object] codes)', async () => {
    assert.equal(await readDenialErrorCode(json({ error: { code: 'pro_required' } })), null);
    assert.equal(await readDenialErrorCode(json({ error: 403 })), null);
  });

  it('an already-consumed body yields null rather than throwing', async () => {
    const res = json({ error: 'pro_required' });
    await res.text();
    assert.equal(await readDenialErrorCode(res), null);
  });

  it('null → an unlabelled 403 still classifies, so the two compose', async () => {
    const code = await readDenialErrorCode(new Response('not json', { status: 403 }));
    assert.equal(classifyPremiumDenial({ status: 403, errorCode: code, belief: PRO }), 'entitlement_desync');
    assert.equal(classifyPremiumDenial({ status: 403, errorCode: code, belief: FREE }), 'upgrade_required');
  });
});

describe('isTransientDenial', () => {
  it('desync and access_denied are worth retrying', () => {
    assert.equal(isTransientDenial('entitlement_desync'), true);
    assert.equal(isTransientDenial('access_denied'), true);
  });

  it('sign-in and upgrade are terminal — retrying cannot flip them', () => {
    assert.equal(isTransientDenial('sign_in_required'), false);
    assert.equal(isTransientDenial('upgrade_required'), false);
  });

  it('null (no denial) is not transient', () => {
    assert.equal(isTransientDenial(null), false);
  });
});

// ---------------------------------------------------------------------------
// Wiring guard
// ---------------------------------------------------------------------------

/**
 * The classifier is only worth anything if the panels actually call it. These
 * panels build their DOM with `replaceChildren`, so there is no jsdom in this
 * repo to drive them end-to-end (see tests/panel-attached-fetch-guard.test.mts
 * for the same constraint). Pin the wiring at the source level instead, so a
 * future edit cannot quietly restore the blanket `403 → upsell` branch.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (rel: string): string => readFileSync(resolve(root, rel), 'utf8');

const WIRED_PANELS = [
  'src/components/LatestBriefPanel.ts',
  'src/components/ChatAnalystPanel.ts',
];

describe('premium panels route their denials through the classifier', () => {
  for (const rel of WIRED_PANELS) {
    it(`${rel} calls classifyPremiumDenial`, () => {
      assert.match(readSource(rel), /classifyPremiumDenial\(/);
    });

    /**
     * The only legitimate reason these panels still mention 403 is deciding
     * whether to read the body for the classifier — and that check always
     * pairs 403 with 401. A line that inspects 403 alone is a verdict reached
     * without consulting the client's entitlement state, which is the bug.
     */
    it(`${rel} never inspects a 403 on its own`, () => {
      const offenders = readSource(rel)
        .split('\n')
        .map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
        // Prose about the old behaviour is not the old behaviour.
        .filter(({ line }) => !/^(\/\/|\/\*|\*)/.test(line))
        .filter(({ line }) => /\bstatus\s*[!=]==?\s*403\b/.test(line))
        .filter(({ line }) => !/\bstatus\s*[!=]==?\s*401\b/.test(line));
      assert.deepEqual(
        offenders,
        [],
        `${rel} branches on a bare 403 instead of classifying it`,
      );
    });
  }

  it('LatestBriefPanel renders the upgrade CTA only for the upgrade_required verdict', () => {
    const source = readSource('src/components/LatestBriefPanel.ts');
    for (const call of [...source.matchAll(/this\.renderUpgradeRequired\(\)/g)]) {
      const preceding = source.slice(Math.max(0, call.index - 400), call.index);
      assert.ok(
        /upgrade_required|clientBelievesPro/.test(preceding),
        'every renderUpgradeRequired() call must be guarded by an explicit '
        + 'upgrade_required verdict or a client-belief check, never a raw 403',
      );
    }
  });

  it("ChatAnalystPanel no longer hardcodes the upsell as its only 403 copy", () => {
    const source = readSource('src/components/ChatAnalystPanel.ts');
    const upsells = [...source.matchAll(/'Pro subscription required\.'/g)];
    assert.equal(upsells.length, 1, 'exactly one upsell string, in the verdict switch');
    const preceding = source.slice(Math.max(0, upsells[0].index - 200), upsells[0].index);
    assert.match(
      preceding,
      /case 'upgrade_required':/,
      'the upsell string must sit under the upgrade_required case',
    );
  });
});
