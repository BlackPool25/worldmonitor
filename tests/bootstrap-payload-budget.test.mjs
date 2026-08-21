import assert from 'node:assert/strict';
import test from 'node:test';

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import {
  DEMOTED_FAST_KEYS,
  ENERGY_ON_DEMAND_KEYS,
  FAST_FIRST_PAINT_JUSTIFICATION,
  FIXTURE_MINIMUMS,
  PRODUCTION_SLOW_DECODED_BYTES,
  buildFastPayload,
  buildSlowPayload,
  demotedFastSelfCheck,
  energyRegistrySelfCheck,
  loadEnergyRegistryPayloads,
  publicPayloadBytes,
  utf8Bytes,
} from './fixtures/bootstrap-payload-budget.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('energy registry fixtures cannot shrink below representative counts', () => {
  const counts = energyRegistrySelfCheck();
  assert.ok(counts.gasCount >= FIXTURE_MINIMUMS.gasCount, `gas ${counts.gasCount}`);
  assert.ok(counts.oilCount >= FIXTURE_MINIMUMS.oilCount, `oil ${counts.oilCount}`);
  assert.ok(counts.storageCount >= FIXTURE_MINIMUMS.storageCount, `storage ${counts.storageCount}`);
});

test('demoted fast fixtures cannot shrink below representative counts', () => {
  const counts = demotedFastSelfCheck();
  for (const [key, minimum] of Object.entries(FIXTURE_MINIMUMS)) {
    if (key.endsWith('Count')) continue;
    assert.ok(counts[key] >= minimum, `${key} ${counts[key]} < ${minimum}`);
  }
});

test('energy registries leave the universal slow tier', () => {
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));
  for (const key of ENERGY_ON_DEMAND_KEYS) {
    assert.equal(slow.has(key), false, `${key} must not ride the slow tier`);
    assert.ok(onDemand.has(key), `${key} must be on-demand`);
  }
});

test('slow fixture drops at least 25% after the energy registries leave', () => {
  const before = publicPayloadBytes(buildSlowPayload({ includeEnergy: true }).data);
  const after = publicPayloadBytes(buildSlowPayload({ includeEnergy: false }).data);
  assert.ok(after <= before * 0.75, `slow ${after} is not 25% below ${before}`);
  const energyBytes = utf8Bytes(loadEnergyRegistryPayloads());
  assert.ok(
    energyBytes >= PRODUCTION_SLOW_DECODED_BYTES * 0.25,
    `energy registries ${energyBytes} are not 25% of the measured slow payload ${PRODUCTION_SLOW_DECODED_BYTES}`,
  );
});

test('fast fixture drops at least 20% after the justified demotions', () => {
  const before = publicPayloadBytes(buildFastPayload({ includeDemoted: true }).data);
  const after = publicPayloadBytes(buildFastPayload({ includeDemoted: false }).data);
  assert.ok(after <= before * 0.80, `fast ${after} is not 20% below ${before}`);
});

test('demoted fast keys no longer ride the fast tier', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  for (const key of DEMOTED_FAST_KEYS) {
    assert.equal(fast.has(key), false, `${key} must leave FAST`);
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
  assert.deepEqual(
    [...fast].sort(),
    Object.keys(FAST_FIRST_PAINT_JUSTIFICATION).sort(),
  );
});

test('web and desktop bootstrap deadlines stay unchanged', () => {
  const src = readFileSync(join(root, 'src/services/bootstrap.ts'), 'utf8');
  assert.match(src, /web:\s*\{\s*fast:\s*1_200,\s*slow:\s*3_000\s*\}/);
  assert.match(src, /desktop:\s*\{\s*fast:\s*5_000,\s*slow:\s*8_000\s*\}/);
});
