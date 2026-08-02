export const CHECKOUT_RATE_LIMITED = "CHECKOUT_RATE_LIMITED";
export const CHECKOUT_RETRY_AFTER_SECONDS = 10;

export interface CheckoutRateLimitedOutcome {
  checkoutFailed: true;
  code: typeof CHECKOUT_RATE_LIMITED;
  retryAfterSeconds: number;
}

/**
 * Dodo's Convex component throws a plain Error for upstream HTTP failures.
 * Preserve only the observed, unambiguous 429 shape as a typed outcome so the
 * relay can return 429 instead of collapsing it into a retry-amplifying 502.
 */
export function checkoutRateLimitedOutcomeFromError(
  error: unknown,
): CheckoutRateLimitedOutcome | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/\b429\b.*(?:status code|too many requests|rate limit)/i.test(message)) {
    return null;
  }
  return {
    checkoutFailed: true,
    code: CHECKOUT_RATE_LIMITED,
    retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
  };
}

/**
 * Bounded retry ladder for provider 429s inside the checkout action (#6027).
 *
 * Dodo's limit is keyed to our API key (one DODO_API_KEY shared by every
 * user), so a client-side retry re-enters the same shared bucket with no new
 * information — the server-side action is the right place to absorb a
 * transient limit. The ladder is deliberately short: the edge gateway aborts
 * its Convex fetch at 15s (api/create-checkout.ts) and the client attempt
 * budget is 15s (checkout-transport.ts), so worst case here adds ~3.5s of
 * delay plus two extra provider round-trips. We never honor a provider
 * Retry-After verbatim (see billing.ts renewal reconciliation — it can be
 * minutes and would blow the action budget); exhaustion falls back to the
 * typed outcome the relay already renders as HTTP 429.
 */
export const CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_500];

/** Total provider attempts the ladder may make (1 initial + one per delay). */
export const CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS =
  1 + CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.length;

/**
 * Wall-clock budget for the whole ladder, measured from ladder entry. The
 * edge gateway's 15s abort covers the SAME envelope as auth, the guard
 * queries, and HMAC signing that run before the ladder — so a retry that
 * cannot land well inside it is pure waste: the edge has already 502'd, the
 * client transport has already fired its single retry, and the orphaned
 * ladder just hammers the shared rate-limited key with a concurrent
 * duplicate. Once the next sleep would cross this deadline, bail to the
 * typed outcome instead.
 */
export const CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS = 8_000;

/**
 * Object seam (not bare functions) so tests can vi.spyOn the properties —
 * compressing the ladder to zero wall-clock or scripting the deadline —
 * while every other code path stays real.
 */
export const checkoutRetryClock = {
  now: () => Date.now(),
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

type CheckoutAttemptResult<T> =
  | { value: T }
  | { rateLimited: CheckoutRateLimitedOutcome };

/** Single source for the absorb-vs-rethrow decision on a provider failure. */
async function attemptCheckoutOnce<T>(
  attempt: () => Promise<T>,
): Promise<CheckoutAttemptResult<T>> {
  try {
    return { value: await attempt() };
  } catch (err) {
    const outcome = checkoutRateLimitedOutcomeFromError(err);
    if (!outcome) throw err;
    return { rateLimited: outcome };
  }
}

/**
 * Run the provider checkout call, absorbing 429s with the bounded ladder.
 * Returns the successful provider result, or the typed rate-limited outcome
 * once the ladder — attempts or time budget — is exhausted. Any non-429
 * failure rethrows immediately: a retry there could duplicate work the
 * provider may have already accepted, and the existing error channel
 * (ConvexError) already covers it.
 */
export async function runCheckoutWithRateLimitRetry<T>(
  attempt: () => Promise<T>,
  onRetry?: (delayMs: number) => void,
): Promise<T | CheckoutRateLimitedOutcome> {
  const deadline = checkoutRetryClock.now() + CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS;
  let result = await attemptCheckoutOnce(attempt);
  for (const delayMs of CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS) {
    if ("value" in result) break;
    if (checkoutRetryClock.now() + delayMs >= deadline) break;
    onRetry?.(delayMs);
    await checkoutRetryClock.sleep(delayMs);
    result = await attemptCheckoutOnce(attempt);
  }
  return "value" in result ? result.value : result.rateLimited;
}

export function isCheckoutRateLimitedOutcome(
  value: unknown,
): value is CheckoutRateLimitedOutcome {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CheckoutRateLimitedOutcome>;
  return (
    candidate.checkoutFailed === true &&
    candidate.code === CHECKOUT_RATE_LIMITED &&
    candidate.retryAfterSeconds === CHECKOUT_RETRY_AFTER_SECONDS
  );
}
