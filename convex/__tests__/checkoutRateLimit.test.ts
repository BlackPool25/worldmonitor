import { describe, expect, test } from "vitest";

import {
  CHECKOUT_RATE_LIMITED,
  CHECKOUT_RETRY_AFTER_SECONDS,
  checkoutRateLimitedOutcomeFromError,
  isCheckoutRateLimitedOutcome,
} from "../payments/checkoutRateLimit";

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
});
