import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  normalizeFoodStocksCommodity,
  normalizeFoodStocksCountry,
} from '../server/worldmonitor/resilience/v1/_food-stocks-query.ts';

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
});
