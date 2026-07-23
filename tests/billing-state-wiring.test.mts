/**
 * Wiring lock for the #4771 billing-aware UX surfaces.
 *
 * The banner and panel-layout are DOM modules that can't be imported under
 * `tsx --test` (no jsdom), so — per the repo's established pattern — this
 * locks the integration with source-text assertions. The pure state logic
 * itself is behavior-tested in tests/billing-state.test.mts.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

describe('payment-failure-banner billing-state wiring (#4771)', () => {
  it('derives the banner from the shared billing UX state, not raw on_hold checks', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /deriveBillingUxState\(getSubscription\(\), getEntitlementState\(\), Date\.now\(\)\)/);
    assert.match(src, /getBillingBannerVariant\(/);
    assert.doesNotMatch(
      src,
      /sub\.status !== 'on_hold'/,
      'banner must not hand-roll on_hold detection anymore — billing-state.ts owns state derivation',
    );
  });

  it('re-renders on BOTH subscription and entitlement changes', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /onSubscriptionChange\(/);
    assert.match(src, /onEntitlementChange\(/);
  });

  it('scopes dismissal to the variant dismiss key and clears all keys on recovery', async () => {
    const src = await read('src/components/payment-failure-banner.ts');
    assert.match(src, /sessionStorage\.getItem\(variant\.dismissKey\)/);
    assert.match(src, /sessionStorage\.setItem\(variant\.dismissKey, '1'\)/);
    assert.match(src, /for \(const key of BILLING_BANNER_DISMISS_KEYS\) sessionStorage\.removeItem\(key\)/);
  });
});

describe('panel-layout billing-state wiring (#4771)', () => {
  it('refines the gate reason through resolveBillingAwareGateReason before rendering CTAs', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(src, /reason = resolveBillingAwareGateReason\(reason\);/);
  });

  it('re-runs panel gating when the subscription row changes (verification verdicts arrive there)', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(
      src,
      /unsubscribeSubscriptionChange = onSubscriptionChange\(\(\) => \{\s*\n\s*this\.updatePanelGating\(getAuthState\(\)\);/,
    );
  });

  it('routes billing-portal gate actions through the popup-blocker-safe pre-reserve pattern', async () => {
    const src = await read('src/app/panel-layout.ts');
    assert.match(src, /case PanelGateReason\.PAYMENT_ON_HOLD:\s*\n\s*case PanelGateReason\.RENEWAL_FAILED:/);
    assert.match(src, /prereserveBillingPortalTab\(\)/);
  });
});

describe('Panel CTA copy coverage (#4771)', () => {
  it('has a showGatedCta config entry for every billing gate reason', async () => {
    const src = await read('src/components/Panel.ts');
    for (const reason of ['PAYMENT_ON_HOLD', 'RENEWAL_PENDING', 'RENEWAL_FAILED', 'LAPSED']) {
      assert.match(
        src,
        new RegExp(`\\[PanelGateReason\\.${reason}\\]: \\{`),
        `showGatedCta config must cover PanelGateReason.${reason} — a missing entry silently skips the lock`,
      );
    }
  });

  it('billing CTA keys stay OUT of the first-paint shell namespaces', async () => {
    const src = await read('src/components/Panel.ts');
    const billingKeys = src.match(/t\('components\.billingState\.[a-zA-Z]+'\)/g) ?? [];
    assert.equal(billingKeys.length, 8, 'expected the 8 billing-state CTA strings');
    assert.doesNotMatch(
      src,
      /t\('premium\.billing/,
      'premium.* is shell-inlined at first paint; billing CTA copy must live under components.billingState',
    );
  });
});
