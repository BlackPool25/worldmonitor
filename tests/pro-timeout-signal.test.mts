/**
 * WORLDMONITOR-109: marketing /pro called AbortSignal.timeout in the
 * pricing catalog fetch. Chrome Mobile 101 (pre-Chrome 103) throws
 * TypeError before fetch runs. Pin the fallback helper and the call
 * site that produced the production stack.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { createTimeoutSignal } from '../pro-test/src/services/timeout-signal.ts';

const pricingSource = readFileSync(
  new URL('../pro-test/src/components/PricingSection.tsx', import.meta.url),
  'utf8',
);

describe('createTimeoutSignal', () => {
  it('returns a signal that aborts after the budget when AbortSignal.timeout is missing', async () => {
    const original = AbortSignal.timeout;
    // @ts-expect-error intentional removal for old-engine coverage
    delete AbortSignal.timeout;
    try {
      assert.equal(typeof AbortSignal.timeout, 'undefined');
      const signal = createTimeoutSignal(20);
      assert.equal(signal.aborted, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(signal.aborted, true);
    } finally {
      AbortSignal.timeout = original;
    }
  });

  it('prefers native AbortSignal.timeout when present', () => {
    assert.equal(typeof AbortSignal.timeout, 'function');
    const signal = createTimeoutSignal(60_000);
    assert.equal(signal.aborted, false);
    // Native timeout signals expose the TimeoutError reason shape on abort;
    // the important contract here is that we do not throw synchronously.
  });
});

describe('PricingSection catalog fetch (WORLDMONITOR-109)', () => {
  it('uses createTimeoutSignal instead of bare AbortSignal.timeout', () => {
    assert.match(pricingSource, /createTimeoutSignal\s*\(\s*5000\s*\)/);
    assert.doesNotMatch(
      pricingSource,
      /signal:\s*AbortSignal\.timeout\s*\(/,
    );
  });
});
