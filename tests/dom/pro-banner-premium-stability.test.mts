/**
 * Runtime DOM coverage for the confirmed-Pro banner anti-flap path.
 *
 * The pure policy suite proves the time/state reducer. This test drives the
 * real ProBanner subscriptions, timer, reservation class, and DOM mount/remove
 * behavior so a future wiring regression cannot pass on the reducer alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Session = import('@/services/auth-state').AuthSession;
type Entitlement = import('@/services/entitlements').EntitlementState;

let livePremium = true;
const session: Session = {
  user: {
    id: 'user_pro',
    name: 'Pro User',
    email: 'pro@example.com',
    role: 'free',
  },
  isPending: false,
};
const entitlementListeners: Array<() => void> = [];
const storageValues = new Map<string, string>();
const storage: Storage = {
  get length() { return storageValues.size; },
  clear: () => storageValues.clear(),
  getItem: (key) => storageValues.get(key) ?? null,
  key: (index) => [...storageValues.keys()][index] ?? null,
  removeItem: (key) => { storageValues.delete(key); },
  setItem: (key, value) => { storageValues.set(key, value); },
};

function entitlement(): Entitlement {
  return {
    planKey: livePremium ? 'pro' : 'free',
    features: {
      tier: livePremium ? 1 : 0,
      apiAccess: livePremium,
      apiRateLimit: livePremium ? 1_000 : 0,
      maxDashboards: livePremium ? 10 : 3,
      prioritySupport: false,
      exportFormats: [],
    },
    validUntil: Date.now() + 86_400_000,
  };
}

vi.mock('@/services/analytics', () => ({ trackGateHit: vi.fn() }));
vi.mock('@/services/panel-gating', () => ({
  hasPremiumAccess: () => livePremium,
}));
vi.mock('@/services/entitlements', () => ({
  getEntitlementState: () => entitlement(),
  isEntitled: () => livePremium,
  onEntitlementChange: (fn: () => void) => {
    entitlementListeners.push(fn);
    return () => {};
  },
}));
vi.mock('@/services/billing', () => ({
  getSubscription: () => null,
  onSubscriptionChange: () => () => {},
}));
vi.mock('@/services/billing-state', () => ({
  deriveBillingUxState: () => 'free',
  getReactivationHref: () => '/pro#pricing',
}));
vi.mock('@/services/auth-state', () => ({
  getAuthState: () => session,
  subscribeAuthState: (fn: (value: Session) => void) => {
    fn(session);
    return () => {};
  },
}));
vi.mock('@/services/clerk', () => ({
  getCurrentClerkUser: () => ({
    id: session.user!.id,
    name: session.user!.name,
    email: session.user!.email,
    image: null,
    plan: 'free' as const,
  }),
  isClerkAuthEnabled: () => true,
}));
vi.mock('@/services/runtime-config', () => ({
  getSecretState: () => ({ present: false }),
}));
vi.mock('@/services/widget-store', () => ({
  isProWidgetEnabled: () => false,
  isWidgetFeatureEnabled: () => false,
}));
vi.mock('@/services/i18n', () => ({ t: (key: string) => key }));

let showProBanner: typeof import('@/components/ProBanner').showProBanner;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  // Node exposes an undefined experimental `localStorage` unless a backing
  // file is configured. Supply the browser contract explicitly so ProBanner
  // exercises the same global a real page sees.
  vi.stubGlobal('localStorage', storage);
  ({ showProBanner } = await import('@/components/ProBanner'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

beforeEach(() => {
  livePremium = true;
  document.body.replaceChildren();
  document.documentElement.classList.remove('wm-pro-banner-reserved');
  storage.clear();
  vi.setSystemTime(0);
});

function emitEntitlement(premium: boolean, at: number): void {
  livePremium = premium;
  vi.setSystemTime(at);
  for (const listener of entitlementListeners) listener();
}

describe('ProBanner confirmed-Pro stability', () => {
  it('never mounts during 500 ms flaps, then mounts only after free is continuous', () => {
    const container = document.createElement('main');
    const slot = document.createElement('div');
    slot.id = 'proBannerSlot';
    container.appendChild(slot);
    document.body.appendChild(container);

    showProBanner(container);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(false);

    emitEntitlement(false, 500);
    expect(container.querySelector('.pro-banner')).toBeNull();

    emitEntitlement(true, 1_000);
    emitEntitlement(false, 1_500);
    expect(container.querySelector('.pro-banner')).toBeNull();

    vi.advanceTimersByTime(1_999);
    expect(container.querySelector('.pro-banner')).toBeNull();

    vi.advanceTimersByTime(1);
    expect(container.querySelector('.pro-banner')).not.toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(true);

    emitEntitlement(true, 4_000);
    vi.advanceTimersByTime(300);
    expect(container.querySelector('.pro-banner')).toBeNull();
    expect(document.documentElement.classList.contains('wm-pro-banner-reserved')).toBe(false);
  });
});
