import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import {
  CAPTURED_BASE_TIER_KEYS,
  CAPTURED_KEY_DECODED_BYTES,
  DEMOTED_FAST_KEYS,
  ENERGY_ON_DEMAND_KEYS,
  FAST_FIRST_PAINT_JUSTIFICATION,
  FINAL_TIER_DECODED_BYTE_CEILINGS,
  PRODUCTION_CAPTURE,
  tierPayloadBytesFromLedger,
} from './fixtures/bootstrap-payload-budget.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_REDUCTION = Object.freeze({ fast: 0.20, slow: 0.25 });

test('frozen production ledger is complete and cannot shrink silently', () => {
  assert.equal(PRODUCTION_CAPTURE.capturedAt, '2026-08-21T14:51:50Z');
  assert.equal(PRODUCTION_CAPTURE.origin, 'https://worldmonitor.app');
  assert.match(PRODUCTION_CAPTURE.completeness, /missing: \[\]/);
  assert.match(PRODUCTION_CAPTURE.limitation, /not the full daily #7047 U1\/RUM baseline/);

  const capturedKeys = [...CAPTURED_BASE_TIER_KEYS.fast, ...CAPTURED_BASE_TIER_KEYS.slow];
  assert.equal(new Set(capturedKeys).size, capturedKeys.length, 'captured tiers must not overlap');
  assert.deepEqual(
    Object.keys(CAPTURED_KEY_DECODED_BYTES).sort(),
    [...capturedKeys].sort(),
    'every captured key needs evidence and unowned byte rows are forbidden',
  );
  for (const [key, bytes] of Object.entries(CAPTURED_KEY_DECODED_BYTES)) {
    assert.ok(Number.isInteger(bytes) && bytes > 0, `${key} has invalid byte evidence: ${bytes}`);
  }

  assert.equal(
    tierPayloadBytesFromLedger(CAPTURED_BASE_TIER_KEYS.fast),
    PRODUCTION_CAPTURE.tiers.fast.decodedBytes,
    `FAST ledger no longer reconstructs captured body ${PRODUCTION_CAPTURE.tiers.fast.sha256}`,
  );
  assert.equal(
    tierPayloadBytesFromLedger(CAPTURED_BASE_TIER_KEYS.slow),
    PRODUCTION_CAPTURE.tiers.slow.decodedBytes,
    `SLOW ledger no longer reconstructs captured body ${PRODUCTION_CAPTURE.tiers.slow.sha256}`,
  );
});

test('all demotions are represented in their actual destination tier', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));

  for (const key of [...ENERGY_ON_DEMAND_KEYS, ...DEMOTED_FAST_KEYS]) {
    assert.equal(fast.has(key), false, `${key} must not ride FAST`);
    assert.equal(slow.has(key), false, `${key} must not ride SLOW`);
    assert.equal(onDemand.has(key), true, `${key} must be represented in ON_DEMAND`);
    assert.ok(CAPTURED_KEY_DECODED_BYTES[key] > 0, `${key} needs production byte evidence`);
  }
});

test('actual head memberships meet net reductions and absolute decoded ceilings', () => {
  // Iran was disabled in the captured production response. Excluding it from
  // the head comparison avoids fabricating bytes for an absent key.
  const headKeys = {
    fast: bootstrapTierKeyNames('fast', { iranEventsEnabled: false }),
    slow: bootstrapTierKeyNames('slow', { iranEventsEnabled: false }),
  };

  for (const tier of ['fast', 'slow']) {
    const baseBytes = PRODUCTION_CAPTURE.tiers[tier].decodedBytes;
    const headBytes = tierPayloadBytesFromLedger(headKeys[tier]);
    const reduction = 1 - (headBytes / baseBytes);
    assert.ok(
      reduction >= REQUIRED_REDUCTION[tier],
      `${tier.toUpperCase()} head ${headBytes} B reduces captured ${baseBytes} B by `
      + `${(reduction * 100).toFixed(2)}%, below required ${REQUIRED_REDUCTION[tier] * 100}%`,
    );
    assert.ok(
      headBytes <= FINAL_TIER_DECODED_BYTE_CEILINGS[tier],
      `${tier.toUpperCase()} head ${headBytes} B exceeds absolute ceiling `
      + `${FINAL_TIER_DECODED_BYTE_CEILINGS[tier]} B`,
    );
  }
});

test('every remaining fast key has a first-paint justification', () => {
  const fast = bootstrapTierKeyNames('fast');
  for (const key of fast) {
    assert.ok(
      FAST_FIRST_PAINT_JUSTIFICATION[key],
      `${key} is still in FAST without a first-paint justification`,
    );
  }
  assert.deepEqual([...fast].sort(), Object.keys(FAST_FIRST_PAINT_JUSTIFICATION).sort());
});

test('web and desktop bootstrap deadlines stay unchanged', () => {
  const src = readFileSync(join(root, 'src/services/bootstrap.ts'), 'utf8');
  assert.match(src, /web:\s*\{\s*fast:\s*1_200,\s*slow:\s*3_000\s*\}/);
  assert.match(src, /desktop:\s*\{\s*fast:\s*5_000,\s*slow:\s*8_000\s*\}/);
});
