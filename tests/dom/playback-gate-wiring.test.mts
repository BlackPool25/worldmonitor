/**
 * #5632 — the playback control's premium gate.
 *
 * `setupPlaybackControl` used to hide the control behind
 * `getAuthState().user?.role === 'pro'`. Nothing in this codebase writes Clerk
 * `publicMetadata.plan`/`role` (zero `clerkClient`/`updateUser` writers; the
 * gap is documented at src/services/panel-gating.ts, api/widget-agent.ts and
 * server/gateway.ts), so that field is `'free'` for EVERY account including
 * paying subscribers — the control rendered for nobody.
 *
 * A source grep for `evaluatePlaybackGate` would go green with the bug
 * restored verbatim, so this file drives the real `setupPlaybackControl`
 * against a minimal AppContext and asserts what the header actually contains.
 *
 * Only the reactive EDGES are stubbed — the Clerk session and the Convex
 * entitlement snapshot. `hasPremiumAccess`, `isProUser`, `readPlaybackGateInputs`
 * and `resolvePlaybackGate` all run for real, so the mapping from live state to
 * verdict is under test and not just the closure that reads it.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { initTestI18n } from './helpers/i18n.mts';

type Session = {
  user: { id: string; name: string; email: string; role: 'free' | 'pro' } | null;
  isPending: boolean;
};

type Entitlement = {
  planKey: string;
  features: { tier: number };
  validUntil: number;
} | null;

/** Live Clerk session, mutated per case. Boot default mirrors auth-state.ts. */
let session: Session = { user: null, isPending: true };
/** Live Convex entitlement snapshot; `null` means "no snapshot has arrived". */
let entitlement: Entitlement = null;
// Kept apart, and each replayed with the argument its real emitter passes, so
// the test cannot accidentally certify a listener that only works when called
// with the other source's payload (or with none at all).
const authListeners: Array<(state: Session) => void> = [];
const entitlementListeners: Array<(state: Entitlement) => void> = [];

// Partial mocks throughout: a full replacement would turn every other export
// these modules provide into `undefined` somewhere in the event-handlers import
// graph, failing later with an unrelated-looking error.
vi.mock('@/services/auth-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/auth-state')>()),
  getAuthState: () => session,
  subscribeAuthState: (fn: (state: Session) => void) => {
    authListeners.push(fn);
    return () => {};
  },
}));

// `isEntitled` is re-implemented rather than passed through because the real
// one reads a module-private `currentState` this test cannot write. The three
// conditions are entitlements.ts:192-198 verbatim; `isProUser()` (widget-store)
// consumes it for real, which is the path a paying subscriber actually takes.
vi.mock('@/services/entitlements', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/entitlements')>()),
  getEntitlementState: () => entitlement,
  isEntitled: () =>
    entitlement !== null && entitlement.planKey !== 'free' && entitlement.validUntil >= Date.now(),
  onEntitlementChange: (fn: (state: Entitlement) => void) => {
    entitlementListeners.push(fn);
    return () => {};
  },
}));

const trackGateHit = vi.fn<(feature: string) => void>();
vi.mock('@/services/analytics', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/analytics')>()),
  trackGateHit: (feature: string) => trackGateHit(feature),
}));

const { EventHandlerManager } = await import('@/app/event-handlers');

let container: HTMLElement;
let manager: InstanceType<typeof EventHandlerManager>;
let loadAllData: Mock<() => void>;

const control = () => container.querySelector<HTMLElement>('.playback-control');
const isVisible = () => control()!.style.display !== 'none';

/** A signed-in Clerk session. `role` is ALWAYS 'free' — nothing writes 'pro'. */
function signedIn(): Session {
  return {
    user: { id: 'user_1', name: 'A', email: 'a@example.com', role: 'free' },
    isPending: false,
  };
}

const PRO_SNAPSHOT: Entitlement = {
  planKey: 'pro',
  features: { tier: 1 },
  validUntil: Date.now() + 86_400_000,
};

const FREE_SNAPSHOT: Entitlement = {
  planKey: 'free',
  features: { tier: 0 },
  validUntil: Date.now() + 86_400_000,
};

/** Replay a Clerk session change through the auth subscription. */
function emitAuth(): void {
  for (const fn of [...authListeners]) fn(session);
}

/** Replay a Convex entitlement push through the entitlement subscription. */
function emitEntitlement(): void {
  for (const fn of [...entitlementListeners]) fn(entitlement);
}

beforeAll(async () => {
  await initTestI18n();
});

beforeEach(() => {
  document.body.replaceChildren();
  authListeners.length = 0;
  entitlementListeners.length = 0;
  trackGateHit.mockClear();
  session = { user: null, isPending: true };
  entitlement = null;
  loadAllData = vi.fn<() => void>();

  container = document.createElement('div');
  const headerRight = document.createElement('div');
  headerRight.className = 'header-right';
  container.appendChild(headerRight);
  document.body.appendChild(container);

  const ctx = {
    container,
    isDestroyed: false,
    isPlaybackMode: false,
    panels: {},
    newsPanels: {},
  } as unknown as ConstructorParameters<typeof EventHandlerManager>[0];

  manager = new EventHandlerManager(ctx, {
    loadAllData,
  } as unknown as ConstructorParameters<typeof EventHandlerManager>[1]);
});

afterEach(() => {
  document.body.replaceChildren();
});

describe('setupPlaybackControl — entitlement gate (#5632)', () => {
  it('shows the control to a paying subscriber whose Clerk role is still "free"', () => {
    // The whole bug: Clerk `role` is never written to 'pro', so the old gate
    // hid the control from the exact users who paid for it.
    session = signedIn();
    entitlement = PRO_SNAPSHOT;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('keeps the control visible for a signed-in user with NO entitlement snapshot', () => {
    // Never over-gate. A late, failed or skipped Convex subscription is an
    // UNKNOWN, not a denial — `initEntitlementSubscription` gives up entirely
    // when Convex auth misses its 10s window or VITE_CONVEX_URL is unset, so a
    // fail-closed branch here would be a permanent lockout, not a boot blip
    // (post-mortem: src/app/panel-layout.ts:710-735).
    session = signedIn();
    entitlement = null;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('hides the control from a signed-in free user once the snapshot proves it', () => {
    session = signedIn();
    entitlement = FREE_SNAPSHOT;

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).toHaveBeenCalledWith('playback');
  });

  it('hides the control from an anonymous visitor once auth settles', () => {
    session = { user: null, isPending: false };

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).toHaveBeenCalledWith('playback');
  });

  it('hides the control while auth is still pending WITHOUT recording a gate hit', () => {
    // `isPending` is the boot default and resolves within Clerk's bounded ~4s
    // idle window, so hiding costs a signed-in Pro user a brief delay instead
    // of flashing a Pro control at every anonymous visitor. It is an unknown,
    // though — counting it as a denial would drown the funnel metric in boot
    // noise from users who were never gated.
    session = { user: null, isPending: true };

    manager.setupPlaybackControl();

    expect(isVisible()).toBe(false);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('reveals the control when the entitlement snapshot lands after boot', () => {
    // The post-checkout unlock path. Auth state does not re-emit when Convex
    // pushes a new entitlement row, so an auth-only subscription leaves a
    // freshly-upgraded subscriber staring at a hidden control until reload.
    session = signedIn();
    entitlement = FREE_SNAPSHOT;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(false);

    entitlement = PRO_SNAPSHOT;
    emitEntitlement();

    expect(isVisible()).toBe(true);
  });

  it('reveals the control when a pending session resolves to a subscriber', () => {
    session = { user: null, isPending: true };
    entitlement = null;

    manager.setupPlaybackControl();
    expect(isVisible()).toBe(false);

    session = signedIn();
    entitlement = PRO_SNAPSHOT;
    emitAuth();

    expect(isVisible()).toBe(true);
    expect(trackGateHit).not.toHaveBeenCalled();
  });

  it('records the playback gate hit at most once per session', () => {
    session = { user: null, isPending: false };

    manager.setupPlaybackControl();
    emitAuth();
    emitEntitlement();

    expect(trackGateHit).toHaveBeenCalledTimes(1);
  });
});
