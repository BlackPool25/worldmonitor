import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
  FOOD_STOCKS_WORLD_KEY,
  PSD_ATTRIBUTES,
  PSD_COMMODITIES,
  applyFaostatProductionFill,
  bucketKey,
  buildCountryRecord,
  computeCalorieWeightedStocksToUse,
  computeStocksToUseRatio,
  foodStocksContentMeta,
  formatMarketingYear,
  latestMarketingYearPresent,
  normalizePsdCountryCode,
  parsePsdForecastRows,
} from '../scripts/_food-stocks-helpers.mjs';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'food-stocks');

function loadFixture(name) {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8'));
}

describe('PSD commodity registry', () => {
  test('staple set includes wheat, corn, rice, soybeans plus barley and palm oil', () => {
    assert.deepEqual(Object.keys(PSD_COMMODITIES).sort(), [
      'barley',
      'corn',
      'palmOil',
      'rice',
      'soybeans',
      'wheat',
    ]);
    assert.equal(PSD_COMMODITIES.wheat.code, '0410000');
    assert.equal(PSD_COMMODITIES.corn.code, '0440000');
    assert.equal(PSD_COMMODITIES.rice.code, '0422110');
    assert.equal(PSD_COMMODITIES.soybeans.code, '2222000');
    assert.equal(PSD_COMMODITIES.barley.code, '0430000');
    assert.equal(PSD_COMMODITIES.palmOil.code, '4243000');
  });

  test('storage key and world sentinel match the issue contract', () => {
    assert.equal(FOOD_STOCKS_CANONICAL_KEY, 'resilience:food-stocks:v1');
    assert.equal(FOOD_STOCKS_WORLD_KEY, '_world');
  });
});

describe('formatMarketingYear', () => {
  test('stores the PSD market year as a slash-year label, not a calendar year', () => {
    assert.equal(formatMarketingYear(2024), '2024/25');
    assert.equal(formatMarketingYear('2024'), '2024/25');
    assert.equal(formatMarketingYear('2024/25'), '2024/25');
  });

  test('rejects unusable values', () => {
    assert.equal(formatMarketingYear(null), null);
    assert.equal(formatMarketingYear(''), null);
    assert.equal(formatMarketingYear('FY24'), null);
  });
});

describe('parsePsdForecastRows — Brazil corn 2021 fixture (PSD Online)', () => {
  test('maps attribute rows onto one country-commodity record and keeps the raw unit', () => {
    const rows = loadFixture('psd-brazil-corn-2021.json');
    const parsed = parsePsdForecastRows(rows, { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    const rec = parsed[0];
    assert.equal(rec.countryCode, 'BR');
    assert.equal(rec.commodity, 'corn');
    assert.equal(rec.marketingYear, '2021/22');
    assert.equal(rec.production, 116000);
    assert.equal(rec.consumption, 73000);
    assert.equal(rec.imports, 2000);
    assert.equal(rec.exports, 44500);
    assert.equal(rec.endingStocks, 4653);
    assert.equal(rec.unit, '1000 MT');
    assert.equal(rec.source, 'psd');
    assert.equal(rec.stocksToUseRatio, computeStocksToUseRatio(4653, 73000, 44500));
    // Spot-check vs the published PSD Online Brazil corn 2021/22 balance:
    // ending stocks 4.653 MMT / total use 117.5 MMT ≈ 3.96%.
    assert.ok(Math.abs(rec.stocksToUseRatio - 4653 / 117500) < 1e-12);
  });

  test('keeps the latest WASDE vintage when the same country-MY appears twice', () => {
    const rows = loadFixture('psd-brazil-corn-2021.json');
    const older = rows.map((row) => ({ ...row, calendarYear: 2021, month: 12, value: row.value * 2 }));
    const parsed = parsePsdForecastRows([...older, ...rows], { commodity: 'corn' });
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].production, 116000);
    assert.equal(parsed[0].forecastYear, 2022);
    assert.equal(parsed[0].forecastMonth, 6);
  });
});

describe('marketing years are never calendar-bucketed', () => {
  test('US 2024/25 and EG 2023/24 wheat stay in distinct buckets even when forecast calendar year matches', () => {
    const rows = loadFixture('psd-wheat-split-marketing-years.json');
    const parsed = parsePsdForecastRows(rows, { commodity: 'wheat' });
    assert.equal(parsed.length, 2);

    const keys = new Set(parsed.map((rec) => bucketKey(rec)));
    assert.equal(keys.size, 2);
    assert.ok(keys.has('US:wheat:2024/25'));
    assert.ok(keys.has('EG:wheat:2023/24'));
    assert.ok(![...keys].some((key) => key.endsWith(':2024')), 'calendar year must not be the bucket');

    const us = parsed.find((rec) => rec.countryCode === 'US');
    const eg = parsed.find((rec) => rec.countryCode === 'EG');
    assert.equal(us.marketingYear, '2024/25');
    assert.equal(eg.marketingYear, '2023/24');
    assert.notEqual(us.marketingYear, eg.marketingYear);
  });
});

describe('computeStocksToUseRatio', () => {
  test('uses ending stocks / (consumption + exports)', () => {
    assert.equal(computeStocksToUseRatio(20, 80, 20), 0.2);
  });

  test('returns null when total use is zero or inputs are unusable', () => {
    assert.equal(computeStocksToUseRatio(10, 0, 0), null);
    assert.equal(computeStocksToUseRatio(null, 80, 20), null);
    assert.equal(computeStocksToUseRatio(10, Number.NaN, 20), null);
  });
});

describe('FAOSTAT production fill', () => {
  test('fills production-only rows for countries PSD does not cover', () => {
    const psd = [
      {
        countryCode: 'US',
        commodity: 'wheat',
        marketingYear: '2024/25',
        production: 50,
        consumption: 30,
        imports: 0,
        exports: 20,
        endingStocks: 10,
        stocksToUseRatio: 0.2,
        unit: '1000 MT',
        source: 'psd',
      },
    ];
    const filled = applyFaostatProductionFill(psd, [
      { countryCode: 'US', commodity: 'wheat', production: 999, calendarYear: 2024 },
      { countryCode: 'TZ', commodity: 'wheat', production: 120, calendarYear: 2024 },
    ], { commodity: 'wheat' });

    const us = filled.find((rec) => rec.countryCode === 'US');
    const tz = filled.find((rec) => rec.countryCode === 'TZ');
    assert.equal(us.production, 50, 'FAOSTAT must not overwrite a PSD production value');
    assert.equal(us.source, 'psd');
    assert.equal(tz.source, 'faostat');
    assert.equal(tz.production, 120);
    assert.equal(tz.endingStocks, null);
    assert.equal(tz.stocksToUseRatio, null);
    assert.equal(tz.marketingYear, '2024/25');
  });

  test('FAOSTAT calendar year becomes its own marketing year, not the latest PSD MY', () => {
    const filled = applyFaostatProductionFill([
      {
        countryCode: 'US',
        commodity: 'wheat',
        marketingYear: '2025/26',
        production: 50,
        consumption: 30,
        imports: 0,
        exports: 20,
        endingStocks: 10,
        stocksToUseRatio: 0.2,
        unit: '1000 MT',
        source: 'psd',
      },
    ], [
      { countryCode: 'TZ', commodity: 'wheat', production: 120, calendarYear: 2023 },
    ], { commodity: 'wheat' });

    const tz = filled.find((rec) => rec.countryCode === 'TZ');
    assert.equal(tz.marketingYear, '2023/24');
    assert.notEqual(tz.marketingYear, '2025/26');
  });

  test('a failed FAOSTAT stage leaves the PSD rows untouched', () => {
    const psd = [
      {
        countryCode: 'AR',
        commodity: 'corn',
        marketingYear: '2024/25',
        production: 50,
        consumption: 20,
        imports: 0,
        exports: 25,
        endingStocks: 5,
        stocksToUseRatio: 5 / 45,
        unit: '1000 MT',
        source: 'psd',
      },
    ];
    const frozen = structuredClone(psd);
    const out = applyFaostatProductionFill(psd, null, { commodity: 'corn' });
    assert.deepEqual(out, frozen);
    const outErr = applyFaostatProductionFill(psd, new Error('FAOSTAT 502'), { commodity: 'corn' });
    assert.deepEqual(outErr, frozen);
  });
});

describe('country record + calorie-weighted aggregate', () => {
  test('weights stocks-to-use by consumption calories and skips fill-only commodities', () => {
    const commodities = {
      wheat: {
        marketingYear: '2024/25',
        production: 100,
        consumption: 80,
        imports: 0,
        exports: 10,
        endingStocks: 18,
        stocksToUseRatio: 18 / 90,
        unit: '1000 MT',
        source: 'psd',
      },
      rice: {
        marketingYear: '2024/25',
        production: 40,
        consumption: null,
        imports: null,
        exports: null,
        endingStocks: null,
        stocksToUseRatio: null,
        unit: '1000 MT',
        source: 'faostat',
      },
    };
    const record = buildCountryRecord('IN', commodities);
    assert.equal(record.aggregate.calorieWeightedStocksToUse, 18 / 90);
    assert.equal(computeCalorieWeightedStocksToUse({ rice: commodities.rice }), null);
  });
});

describe('world + country code normalization', () => {
  test('maps PSD world sentinels onto _world and leaves ISO-2 alone', () => {
    assert.equal(normalizePsdCountryCode('0'), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode(0), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode('WORLD'), FOOD_STOCKS_WORLD_KEY);
    assert.equal(normalizePsdCountryCode('us'), 'US');
    assert.equal(normalizePsdCountryCode(''), null);
  });
});

describe('content clock is marketing-year presence, not fetch time', () => {
  test('latestMarketingYearPresent reads the MY label, not fetchedAt', () => {
    const snapshot = {
      fetchedAt: Date.parse('2026-08-01T00:00:00Z'),
      US: {
        commodities: {
          wheat: { marketingYear: '2025/26', stocksToUseRatio: 0.2 },
          corn: { marketingYear: '2024/25', stocksToUseRatio: 0.1 },
        },
      },
    };
    assert.equal(latestMarketingYearPresent(snapshot), '2025/26');
  });

  test('contentMeta uses the latest marketing year, so a fresh fetch of an old MY is still stale', () => {
    const snapshot = {
      US: { commodities: { wheat: { marketingYear: '2022/23', stocksToUseRatio: 0.3 } } },
    };
    const now = Date.UTC(2026, 7, 12);
    const meta = foodStocksContentMeta(snapshot, now);
    assert.ok(meta);
    const ageMin = (now - meta.newestItemAt) / 60000;
    assert.ok(
      ageMin > FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
      `stale MY 2022/23 in Aug 2026 must exceed the ${FOOD_STOCKS_MAX_CONTENT_AGE_MIN / (24 * 60)}d content window (age ${Math.round(ageMin / (24 * 60))}d)`,
    );
  });

  test('a current marketing year stays inside the two-cycle window', () => {
    const snapshot = {
      US: { commodities: { wheat: { marketingYear: '2025/26', stocksToUseRatio: 0.2 } } },
    };
    const now = Date.UTC(2026, 7, 12);
    const meta = foodStocksContentMeta(snapshot, now);
    const ageMin = (now - meta.newestItemAt) / 60000;
    assert.ok(
      ageMin < FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
      `MY 2025/26 in Aug 2026 must stay inside the content window (age ${Math.round(ageMin / (24 * 60))}d)`,
    );
  });
});
