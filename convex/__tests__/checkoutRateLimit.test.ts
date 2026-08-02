import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api } from "../_generated/api";
import { checkout } from "../lib/dodo";
import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS,
  CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS,
  CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS,
  CHECKOUT_RETRY_AFTER_SECONDS,
  checkoutRateLimitedOutcomeFromError,
  checkoutRetryClock,
  isCheckoutRateLimitedOutcome,
  runCheckoutWithRateLimitRetry,
} from "../payments/checkoutRateLimit";
import schema from "../schema";

vi.mock("../lib/dodo", () => ({
  checkout: vi.fn(),
}));

const modules = import.meta.glob("../**/*.ts");
const TEST_SIGNING_SECRET = "checkout-rate-limit-test-signing-secret";
const TEST_RELAY_SECRET = "checkout-rate-limit-test-relay-secret";
const TEST_USER = {
  subject: "user_checkout_rate_limit",
  tokenIdentifier: "clerk|user_checkout_rate_limit",
  email: "rate-limit@example.com",
};

// Persistent (not *Once) rejection: the action now retries 429s through the
// bounded ladder, so a sustained provider limit must fail EVERY attempt to
// exercise the exhaustion path.
function mockObservedProviderRateLimit() {
  vi.mocked(checkout).mockRejectedValue(
    new Error("Failed to create checkout session: 429 status code (no body)"),
  );
}

/** Compress the retry ladder to zero wall-clock; every other path stays real. */
function spyInstantRetrySleeps() {
  return vi.spyOn(checkoutRetryClock, "sleep").mockResolvedValue(undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
  // restoreAllMocks does not reset module-factory vi.fn()s — clear queued
  // once-values/implementations so no test inherits another's provider script.
  vi.mocked(checkout).mockReset();
  delete process.env.DODO_IDENTITY_SIGNING_SECRET;
  delete process.env.RELAY_SHARED_SECRET;
});

describe("checkout rate-limit outcome", () => {
  test("recognizes the observed Dodo 429 error and returns a bounded retry hint", () => {
    const result = checkoutRateLimitedOutcomeFromError(
      new Error("Failed to create checkout session: 429 status code (no body)"),
    );

    expect(result).toEqual({
      checkoutFailed: true,
      code: CHECKOUT_RATE_LIMITED,
      retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
    });
    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
  });

  test("does not reclassify other upstream failures as rate limiting", () => {
    expect(
      checkoutRateLimitedOutcomeFromError(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      ),
    ).toBeNull();
    expect(
      isCheckoutRateLimitedOutcome({
        checkoutFailed: true,
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: 999,
      }),
    ).toBe(false);
  });

  test("a transient provider 429 is absorbed by the bounded retry and checkout succeeds (#6027)", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    const sleeps = spyInstantRetrySleeps();
    // Local call counter instead of chained *Once mocks: an unconsumed once-
    // queue entry would leak into the next test (restoreAllMocks does not
    // clear module-factory vi.fn queues).
    let providerCalls = 0;
    vi.mocked(checkout).mockImplementation(async () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        throw new Error("Failed to create checkout session: 429 status code (no body)");
      }
      return {
        checkout_url: "https://test.checkout.dodopayments.com/session/cks_transient",
      };
    });
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      checkout_url: "https://test.checkout.dodopayments.com/session/cks_transient",
    });
    expect(providerCalls).toBe(2);
    expect(sleeps.mock.calls).toEqual([[CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS[0]]]);
  });

  test("the internal relay preserves the real action outcome as HTTP 429", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    process.env.RELAY_SHARED_SECRET = TEST_RELAY_SECRET;
    mockObservedProviderRateLimit();
    const sleeps = spyInstantRetrySleeps();
    const t = convexTest(schema, modules);

    const response = await t.fetch("/relay/create-checkout", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_RELAY_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        userId: TEST_USER.subject,
        productId: "prod_rate_limited",
      }),
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(
      String(CHECKOUT_RETRY_AFTER_SECONDS),
    );
    expect(await response.json()).toEqual({
      error: CHECKOUT_RATE_LIMITED,
      message: "Checkout is temporarily rate limited. Retry shortly.",
    });
    // The whole bounded ladder ran before the typed outcome surfaced.
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("the public action keeps provider rate limits on its error channel", async () => {
    process.env.DODO_IDENTITY_SIGNING_SECRET = TEST_SIGNING_SECRET;
    mockObservedProviderRateLimit();
    spyInstantRetrySleeps();
    const t = convexTest(schema, modules);

    const request = t.withIdentity(TEST_USER).action(
      api.payments.checkout.createCheckout,
      {
        productId: "prod_rate_limited",
      },
    );
    await expect(request).rejects.toBeInstanceOf(Error);
    await request.catch((error: unknown) => {
      const data = JSON.parse(String((error as { data?: unknown }).data));
      expect(data).toMatchObject({
        code: CHECKOUT_RATE_LIMITED,
        retryAfterSeconds: CHECKOUT_RETRY_AFTER_SECONDS,
      });
    });
  });
});

describe("runCheckoutWithRateLimitRetry", () => {
  const RATE_LIMIT_ERROR = new Error(
    "Failed to create checkout session: 429 status code (no body)",
  );

  test("returns the typed outcome only after exhausting every ladder step", async () => {
    const sleeps = spyInstantRetrySleeps();
    const attempt = vi.fn().mockRejectedValue(RATE_LIMIT_ERROR);
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, (ms) =>
      retries.push(ms),
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(CHECKOUT_RATE_LIMIT_MAX_ATTEMPTS);
    expect(retries).toEqual([...CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS]);
    expect(sleeps.mock.calls).toEqual(
      CHECKOUT_RATE_LIMIT_RETRY_DELAYS_MS.map((ms) => [ms]),
    );
  });

  test("stops retrying once the next sleep would cross the wall-clock budget", async () => {
    const sleeps = spyInstantRetrySleeps();
    // First now() call anchors the deadline; every later check sits at the
    // deadline, so even the first retry's sleep would cross it.
    vi.spyOn(checkoutRetryClock, "now")
      .mockReturnValueOnce(0)
      .mockReturnValue(CHECKOUT_RATE_LIMIT_RETRY_BUDGET_MS);
    const attempt = vi.fn().mockRejectedValue(RATE_LIMIT_ERROR);
    const retries: number[] = [];

    const result = await runCheckoutWithRateLimitRetry(attempt, (ms) =>
      retries.push(ms),
    );

    expect(isCheckoutRateLimitedOutcome(result)).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("rethrows a non-429 failure immediately without retrying", async () => {
    const sleeps = spyInstantRetrySleeps();
    const attempt = vi
      .fn()
      .mockRejectedValue(
        new Error("Failed to create checkout session: 503 no healthy upstream"),
      );

    await expect(runCheckoutWithRateLimitRetry(attempt)).rejects.toThrow(
      "503 no healthy upstream",
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).not.toHaveBeenCalled();
  });

  test("rethrows a non-429 failure that follows an absorbed 429", async () => {
    spyInstantRetrySleeps();
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(RATE_LIMIT_ERROR)
      .mockRejectedValueOnce(new Error("Failed to create checkout session: 500"));

    await expect(runCheckoutWithRateLimitRetry(attempt)).rejects.toThrow(
      "500",
    );
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});
