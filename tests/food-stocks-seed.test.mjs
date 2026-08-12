import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePsdForecastRows } from '../scripts/_food-stocks-helpers.mjs';
import {
  fetchFoodStocks,
  parseFaostatAreaMap,
  parseFaostatProductionRows,
  validateFoodStocks,
} from '../scripts/seed-food-stocks.mjs';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'food-stocks');
const brazilCorn = JSON.parse(readFileSync(join(FIXTURE_DIR, 'psd-brazil-corn-2021.json'), 'utf8'));

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('FAOSTAT parsers', () => {
  test('map area codes through ISO3 and leave unmapped rows out', () => {
    const map = parseFaostatAreaMap([
      { code: '231', iso3: 'USA', label: 'United States of America' },
      { code: '834', iso3: 'TZA', label: 'United Republic of Tanzania' },
      { code: '999', label: 'Not A Real Country' },
    ]);
    assert.equal(map.get('231'), 'US');
    assert.equal(map.get('834'), 'TZ');
    assert.equal(map.has('999'), false);
  });

  test('keeps the latest year and converts tonnes to 1000 MT', () => {
    const rows = parseFaostatProductionRows({
      data: [
        { 'Area Code': '231', Year: 2022, Value: 50_000_000 },
        { 'Area Code': '231', Year: 2023, Value: 49_000_000 },
      ],
    }, { commodity: 'wheat', areaMap: new Map([['231', 'US']]) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].production, 49000);
    assert.equal(rows[0].calendarYear, 2023);
  });
});

describe('fetchFoodStocks stages', () => {
  test('a FAOSTAT 502 leaves the PSD snapshot intact', async () => {
    const fetchImpl = async (url) => {
      const href = String(url);
      if (href.includes('codes/area')) return jsonResponse([]);
      if (href.includes('faostat')) return jsonResponse({ error: 'down' }, 502);
      const yearMatch = href.match(/\/year\/(\d{4})/);
      const year = yearMatch ? Number(yearMatch[1]) : 0;
      if (year !== 2025 || !href.includes('0440000')) return jsonResponse([]);
      if (href.includes('/world/year/')) {
        return jsonResponse([
          { commodityCode: 440000, countryCode: 0, marketYear: 2025, calendarYear: 2026, month: 5, attributeId: 28, unitId: 8, value: 1_200_000 },
          { commodityCode: 440000, countryCode: 0, marketYear: 2025, calendarYear: 2026, month: 5, attributeId: 125, unitId: 8, value: 1_000_000 },
          { commodityCode: 440000, countryCode: 0, marketYear: 2025, calendarYear: 2026, month: 5, attributeId: 88, unitId: 8, value: 180_000 },
          { commodityCode: 440000, countryCode: 0, marketYear: 2025, calendarYear: 2026, month: 5, attributeId: 176, unitId: 8, value: 80_000 },
        ]);
      }
      if (href.includes('0440000') && href.includes('/country/all/')) {
        return jsonResponse(brazilCorn.map((row) => ({ ...row, marketYear: 2025, calendarYear: 2026, month: 5 })));
      }
      return jsonResponse([]);
    };

    const snapshot = await fetchFoodStocks({
      fetchImpl,
      apiKey: 'test-key',
      now: new Date(Date.UTC(2026, 7, 12)),
      gapMs: 0,
    });

    assert.ok(snapshot.BR, 'Brazil PSD row must survive a FAOSTAT failure');
    assert.equal(snapshot.BR.commodities.corn.source, 'psd');
    assert.equal(snapshot.BR.commodities.corn.production, 116000);
    assert.ok(snapshot._world.commodities.corn);
    assert.equal(snapshot._world.commodities.corn.source, 'psd');
    assert.ok(Number.isFinite(snapshot._world.commodities.corn.stocksToUseRatio));
  });

  test('validateFoodStocks requires a populated country set plus a world ratio', () => {
    assert.equal(validateFoodStocks({}), false);
    const countries = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `C${i}`,
        { commodities: { wheat: { stocksToUseRatio: 0.1 } } },
      ]),
    );
    assert.equal(validateFoodStocks({
      ...countries,
      _world: { commodities: { wheat: { stocksToUseRatio: 0.2 } } },
    }), true);
  });
});

describe('PSD fixture still parses after a live-shaped commodity code', () => {
  test('0440000 and 440000 are the same corn commodity', () => {
    const padded = brazilCorn.map((row) => ({ ...row, commodityCode: '0440000' }));
    const a = parsePsdForecastRows(brazilCorn, { commodity: 'corn' });
    const b = parsePsdForecastRows(padded, { commodity: 'corn' });
    assert.equal(a[0].production, b[0].production);
  });
});
