import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  flattenSnapshot,
  normalizeFoodStocksCommodity,
  normalizeFoodStocksCountry,
} from '../server/worldmonitor/resilience/v1/_food-stocks-query.ts';

const HANDLER_SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'worldmonitor', 'resilience', 'v1', 'get-food-stocks.ts'),
  'utf8',
);

describe('GetFoodStocks request normalization', () => {
  test('accepts ISO-2 and WORLD sentinels', () => {
    assert.equal(normalizeFoodStocksCountry('eg'), 'EG');
    assert.equal(normalizeFoodStocksCountry('WORLD'), '_world');
    assert.equal(normalizeFoodStocksCountry(''), '');
    assert.equal(normalizeFoodStocksCountry('Egypt'), null);
  });

  test('accepts commodity aliases and rejects unknown slugs', () => {
    assert.equal(normalizeFoodStocksCommodity('maize'), 'corn');
    assert.equal(normalizeFoodStocksCommodity('palm oil'), 'palmOil');
    assert.equal(normalizeFoodStocksCommodity(''), '');
    assert.equal(normalizeFoodStocksCommodity('oats'), null);
  });

  test('rejects the shapes an agent is most likely to send wrong', () => {
    assert.equal(normalizeFoodStocksCountry('   '), '', 'whitespace-only is unfiltered, not invalid');
    assert.equal(normalizeFoodStocksCountry('USA'), null, '3-letter ISO must be rejected');
    assert.equal(normalizeFoodStocksCountry('12'), null, 'digits are not a country');
    assert.equal(normalizeFoodStocksCountry('WLD'), '_world');
    assert.equal(normalizeFoodStocksCountry('_WORLD'), '_world');
    assert.equal(normalizeFoodStocksCommodity('PALMOIL'), 'palmOil', 'case-insensitive slug');
    assert.equal(normalizeFoodStocksCommodity('palm-oil'), 'palmOil');
    assert.equal(normalizeFoodStocksCommodity('__proto__'), null, 'prototype keys must not resolve');
    assert.equal(normalizeFoodStocksCommodity('constructor'), null);
  });
});

describe('flattenSnapshot', () => {
  const snapshot = {
    fetchedAt: '2026-08-13T00:00:00Z',
    stageNotes: { psd: { corn: { year: 2026 } }, degraded: false },
    BR: {
      commodities: {
        corn: {
          marketingYear: '2021/22',
          production: 116000,
          consumption: 73000,
          imports: 2000,
          exports: 44500,
          endingStocks: 4653,
          stocksToUseRatio: 4653 / 117500,
          totalUse: 117500,
          unit: '1000 MT',
          source: 'psd',
        },
      },
      aggregate: { calorieWeightedStocksToUse: 0.04 },
    },
    NG: {
      commodities: {
        corn: {
          marketingYear: '2023/24',
          production: 12000,
          consumption: null,
          imports: null,
          exports: null,
          endingStocks: null,
          stocksToUseRatio: null,
          totalUse: 0,
          unit: '1000 MT',
          source: 'faostat',
        },
      },
    },
    _world: {
      commodities: {
        corn: {
          marketingYear: '2026/27',
          production: 1_200_000,
          consumption: 1_000_000,
          imports: 0,
          exports: 180_000,
          endingStocks: 80_000,
          stocksToUseRatio: 0.08,
          totalUse: 1_000_000,
          unit: '1000 MT',
          source: 'psd',
        },
      },
    },
  };

  test('skips BOTH pseudo-keys, not just fetchedAt', () => {
    const rows = flattenSnapshot(snapshot as never);
    const codes = rows.map((r) => r.countryCode).sort();
    assert.deepEqual(codes, ['BR', 'NG', '_world']);
    assert.ok(!codes.includes('fetchedAt'));
    assert.ok(!codes.includes('stageNotes'));
  });

  test('filters by country and by commodity independently', () => {
    assert.equal(flattenSnapshot(snapshot as never, 'BR').length, 1);
    assert.equal(flattenSnapshot(snapshot as never, '_world').length, 1);
    assert.equal(flattenSnapshot(snapshot as never, undefined, 'corn').length, 3);
    assert.equal(flattenSnapshot(snapshot as never, undefined, 'wheat').length, 0);
    assert.equal(flattenSnapshot(snapshot as never, 'ZZ').length, 0);
  });

  test('world totalUse excludes exports and agrees with its own ratio', () => {
    const [world] = flattenSnapshot(snapshot as never, '_world');
    assert.equal(world.totalUseTmt, 1_000_000, 'world exports are internal transfers');
    assert.equal(world.endingStocksTmt / world.totalUseTmt, world.stocksToUse);
  });

  test('country totalUse includes exports and agrees with its own ratio', () => {
    const [br] = flattenSnapshot(snapshot as never, 'BR');
    assert.equal(br.totalUseTmt, 117_500);
    assert.ok(Math.abs(br.endingStocksTmt / br.totalUseTmt - br.stocksToUse) < 1e-12);
  });

  test('a FAOSTAT production-only row is distinguishable from a genuine zero', () => {
    const [ng] = flattenSnapshot(snapshot as never, 'NG');
    assert.equal(ng.source, 'faostat');
    assert.equal(ng.stocksToUse, 0);
    assert.equal(ng.totalUseTmt, 0, 'source=faostat AND totalUse=0 is the documented "unknown" signal');
    assert.equal(ng.productionTmt, 12000, 'production is real even though stocks are not');
  });

  test('a malformed entry is skipped rather than throwing', () => {
    const rows = flattenSnapshot({ XX: null, YY: { commodities: 'nope' }, ...snapshot } as never);
    assert.ok(rows.length >= 3);
  });
});

describe('get-food-stocks handler contract', () => {
  test('an empty result never reports unavailable when the snapshot loaded', () => {
    // `unavailable` means the seed is missing or unreadable, per the proto. Both
    // empty branches previously diverged: a filtered miss returned false, an
    // unfiltered miss returned true.
    const emptyBranch = HANDLER_SRC.slice(HANDLER_SRC.indexOf('if (records.length === 0)'));
    assert.match(emptyBranch.slice(0, 400), /unavailable:\s*false/);
    assert.doesNotMatch(
      emptyBranch.slice(0, 400),
      /markNoStoreFallbackResponse/,
      'a loaded-but-empty snapshot must not fall back to the unavailable EMPTY response',
    );
  });

  test('unavailable:true is reserved for a missing or unreadable snapshot', () => {
    assert.match(HANDLER_SRC, /if \(!snapshot \|\| typeof snapshot !== 'object'\) \{\s*\n\s*return markNoStoreFallbackResponse/);
    assert.match(HANDLER_SRC, /\} catch \{\s*\n\s*return markNoStoreFallbackResponse/);
  });

  test('the _world sentinel is rewritten to WORLD on the wire', () => {
    assert.match(HANDLER_SRC, /row\.countryCode === FOOD_STOCKS_WORLD_KEY \? 'WORLD' : row\.countryCode/);
  });

  test('flattening is imported, not reimplemented in the handler', () => {
    assert.match(HANDLER_SRC, /flattenSnapshot,\s*\n?\s*normalizeFoodStocksCommodity/);
    assert.doesNotMatch(HANDLER_SRC, /function flattenSnapshot\(/, 'exactly one implementation must exist');
  });
});
