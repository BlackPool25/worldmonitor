import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { flattenKeys } from '../scripts/_locale-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'locales');

// Weather alerts merge NWS, ECCC, and WMO SWIC into one official-warning
// pipeline. Copy must name all three agencies so a label cannot quietly shrink
// back to US-only NWS. Each file is still asserted; a locale with no entry
// fails loudly rather than going unasserted.
describe('locale completeness', () => {
  const en = JSON.parse(readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8'));
  const enKeys = flattenKeys(en);
  const localeFiles = readdirSync(LOCALES_DIR)
    .filter((name) => name.endsWith('.json') && name !== 'en.json' && name !== 'en.shell.json')
    .sort();

  // Sanity tripwire: en is the source catalog (~2400 keys today). A drop below
  // 2000 means the catalog collapsed (bad parse / mass deletion), which would
  // make the per-locale completeness checks below pass vacuously.
  it('en.json defines at least 2000 translation keys', () => {
    // inventory-contract: locale-key-completeness; classification: floor; promise: the English UI catalog remains a full product surface; reason: a 2000-key floor detects mass deletion before locale parity can pass vacuously
    assert.ok(enKeys.length >= 2000, `expected a large en catalog, got ${enKeys.length}`);
  });

  for (const file of localeFiles) {
    it(`${file} contains every en.json key`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const localeKeySet = new Set(flattenKeys(locale));
      const missing = enKeys.filter((key) => !localeKeySet.has(key));

      // inventory-contract: locale-key-completeness; classification: parity; reason: missing-key parity is an exact completeness contract, not a catalog total
      assert.equal(
        missing.length,
        0,
        `${file} is missing ${missing.length} key(s): ${missing.slice(0, 10).join(', ')}${
          missing.length > 10 ? '…' : ''
        }`,
      );
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} discloses NWS, ECCC, and WMO SWIC coverage for every weather layer label`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.weatherAlerts,
        locale.components.deckgl.layerHelp.descriptions.weatherAlerts,
        locale.components.deckgl.layerHelp.descriptions.weatherAlertsMarket,
      ];

      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /NWS/i, `${file} weather coverage copy must identify NWS`);
        assert.match(value, /ECCC/i, `${file} weather coverage copy must identify ECCC`);
        assert.match(value, /WMO|SWIC/i, `${file} weather coverage copy must identify WMO SWIC`);
      }
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} describes the shared Canada roads layer without stale province-only copy`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.canadaRoads,
        locale.components.deckgl.layerHelp.descriptions.canadaRoads,
      ];
      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /Canada|Canadian/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /Ontario and Alberta/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the AB + BC + SK scope for the canadaAlerts layer`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.match(layer, /AB \+ BC \+ SK/, `${file} canadaAlerts layer label must name SK`);
      assert.match(help, /SaskAlert/i, `${file} canadaAlerts help must name SaskAlert`);
      assert.doesNotMatch(layer, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
      assert.doesNotMatch(help, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
    });
  }

  for (const file of ['en.json', ...localeFiles]) {
    it(`${file} describes the shared Canada roads layer without stale province-only copy`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const values = [
        locale.components.deckgl.layers.canadaRoads,
        locale.components.deckgl.layerHelp.descriptions.canadaRoads,
      ];
      for (const value of values) {
        assert.equal(typeof value, 'string');
        assert.match(value, /Canada|Canadian/i, `${file} canadaRoads copy must identify Canadian scope`);
        assert.doesNotMatch(value, /Ontario and Alberta/i, `${file} canadaRoads copy must not claim only two provinces`);
      }
    });

    it(`${file} discloses the AB + BC + SK scope for the canadaAlerts layer`, () => {
      const locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
      const layer = locale.components.deckgl.layers.canadaAlerts;
      const help = locale.components.deckgl.layerHelp.descriptions.canadaAlerts;
      assert.equal(typeof layer, 'string');
      assert.equal(typeof help, 'string');
      assert.match(layer, /AB \+ BC \+ SK/, `${file} canadaAlerts layer label must name SK`);
      assert.match(help, /SaskAlert/i, `${file} canadaAlerts help must name SaskAlert`);
      assert.doesNotMatch(layer, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
      assert.doesNotMatch(help, /Alberta Emergency Alert only/i, `${file} canadaAlerts copy must not claim Alberta-only coverage`);
    });
  }
});
