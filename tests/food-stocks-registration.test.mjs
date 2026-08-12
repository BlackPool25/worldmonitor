import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { __testing__ } from '../api/health.js';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('food stocks production registration (#6440)', () => {
  it('pairs the Redis data key with seed-meta and a 60-day fetch window', () => {
    assert.equal(__testing__.STANDALONE_KEYS.foodStocks, 'resilience:food-stocks:v1');
    assert.equal(__testing__.SEED_META.foodStocks.key, 'seed-meta:resilience:food-stocks');
    assert.equal(__testing__.SEED_META.foodStocks.maxStaleMin, 86400);
    assert.equal(__testing__.SEED_META.foodStocks.cutover?.mode, 'expiring-ack');
    assert.equal(__testing__.SEED_META.foodStocks.cutover?.issue, 6440);
    assert.match(read('api/seed-health.js'), /'resilience:food-stocks':\s*\{ key: 'seed-meta:resilience:food-stocks',\s*intervalMin: 43200/);
  });

  it('schedules the seeder in the resilience bundle and watches its files', () => {
    assert.match(
      read('scripts/seed-bundle-resilience.mjs'),
      /label: 'Food-Stocks'[\s\S]*script: 'seed-food-stocks\.mjs'[\s\S]*seedMetaKey: 'resilience:food-stocks'[\s\S]*intervalMs: 30 \* DAY/,
    );
    const railway = JSON.parse(read('scripts/railway-services.json'));
    const bundle = railway.find((entry) => entry.service === 'seed-bundle-resilience');
    assert.ok(bundle?.watchPatterns.includes('scripts/seed-food-stocks.mjs'));
    assert.ok(bundle?.watchPatterns.includes('scripts/_food-stocks-helpers.mjs'));
  });

  it('gates the RPC as premium + entitlement before generate', () => {
    assert.ok(PREMIUM_RPC_PATHS.has('/api/resilience/v1/get-food-stocks'));
    assert.match(read('server/_shared/entitlement-check.ts'), /'\/api\/resilience\/v1\/get-food-stocks': 1/);
    assert.match(read('server/gateway.ts'), /'\/api\/resilience\/v1\/get-food-stocks': 'slow'/);
  });
});
