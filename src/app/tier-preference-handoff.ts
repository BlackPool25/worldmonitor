import { AUTH_SETTLE_GRACE_MS } from '@/app/free-tier-gate';

interface TierPreferenceHandoffOptions {
  /** Upper bound on how long reconciliation may be deferred. */
  graceMs?: number;
  /** Injected so boundary behaviour is testable without a live clock. */
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Tracks the account whose cloud preferences are replacing anonymous/local
 * state. Tier reconciliation must not mutate that state until the handoff
 * signals a TERMINAL outcome for that same account.
 *
 * Two hazards this guards, both found reviewing #6345:
 *
 *  - A stale completion. Keying only on account id is not enough: on
 *    sign-in A -> sign-out -> sign-in A, the first attempt's late completion
 *    carries a matching id, and SerializedAsyncQueue guarantees it settles
 *    BEFORE the second attempt runs — so it deterministically released a
 *    handoff it did not own. Callers now present the token `begin` returned.
 *
 *  - An unbounded deferral. The deferral suspends the live entitlement
 *    boundary, so it must never outlive the free-tier gate's own grace
 *    window. `begin` arms an expiry that releases the latch and runs the
 *    pending reconciliation itself, so a sign-in that never reaches a
 *    terminal outcome (a 503 whose retry never lands, a stalled token) can
 *    delay enforcement but never cancel it.
 */
export class TierPreferenceHandoff {
  private activeUserId: string | null = null;
  private generation = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private onExpire: (() => void) | null = null;

  private readonly graceMs: number;
  private readonly schedule: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly cancel: (handle: ReturnType<typeof setTimeout>) => void;

  constructor(options: TierPreferenceHandoffOptions = {}) {
    this.graceMs = options.graceMs ?? AUTH_SETTLE_GRACE_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  }

  /**
   * Arm the deferral for `userId`. Returns the token that may later complete
   * it; `onExpire` runs if no terminal outcome arrives within the grace window.
   */
  begin(userId: string, onExpire?: () => void): number {
    this.disarmExpiry();
    this.activeUserId = userId;
    this.onExpire = onExpire ?? null;
    const generation = ++this.generation;
    this.expiryTimer = this.schedule(() => {
      this.expiryTimer = null;
      if (this.generation !== generation || this.activeUserId !== userId) return;
      this.activeUserId = null;
      const expired = this.onExpire;
      this.onExpire = null;
      expired?.();
    }, this.graceMs);
    return generation;
  }

  shouldDefer(currentUserId: string | null): boolean {
    return currentUserId !== null && this.activeUserId === currentUserId;
  }

  /**
   * Release the handoff. Returns true only when this completion still owns the
   * active handoff AND that account is still signed in — i.e. when the caller
   * should now reconcile.
   */
  complete(generation: number, userId: string, currentUserId: string | null): boolean {
    if (generation !== this.generation || this.activeUserId !== userId) return false;
    this.disarmExpiry();
    this.activeUserId = null;
    this.onExpire = null;
    return currentUserId === userId;
  }

  clear(): void {
    this.disarmExpiry();
    this.activeUserId = null;
    this.onExpire = null;
  }

  private disarmExpiry(): void {
    if (this.expiryTimer === null) return;
    this.cancel(this.expiryTimer);
    this.expiryTimer = null;
  }
}
