import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { __testing__ as healthTesting } from '../api/health.js';
import { extractBundleSections } from './helpers/bundle-section-parser.mjs';
import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';
import { GTA_FIRE_KEY, GTA_POLICE_KEY, GTA_UPDATE_WRITER_ENABLED } from '../scripts/lib/gta-update.mjs';
import { TPS_CALLS_KEY, TPS_MCI_KEY } from '../scripts/lib/tps-open-data.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

const SAFETY_KEYS = [
  GTA_POLICE_KEY,
  GTA_FIRE_KEY,
  TPS_MCI_KEY,
  TPS_CALLS_KEY,
];

const SAFETY_HINT = /gta-update|gtaupdate|tps-mci|tps-calls-attended|tps-open-data/i;

// Runtime contract lives in .mjs so node:test never imports TypeScript.
const TORONTO_SAFETY_SOURCES = Object.freeze([
  {
    id: 'gta-update-police',
    semantic: 'live_dispatch',
    canonicalKey: GTA_POLICE_KEY,
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'gta-update-fire',
    semantic: 'live_dispatch',
    canonicalKey: GTA_FIRE_KEY,
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'tps-mci',
    semantic: 'reported_occurrence',
    canonicalKey: TPS_MCI_KEY,
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'tps-calls-attended',
    semantic: 'annual_aggregate',
    canonicalKey: TPS_CALLS_KEY,
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  },
]);

describe('Toronto safety qualification wiring (#7012)', () => {
  it('keeps live_dispatch, reported_occurrence, and annual_aggregate distinct', () => {
    const bySemantic = Object.fromEntries(
      ['live_dispatch', 'reported_occurrence', 'annual_aggregate'].map((semantic) => [
        semantic,
        TORONTO_SAFETY_SOURCES.filter((source) => source.semantic === semantic).map((source) => source.id),
      ]),
    );
    assert.deepEqual(bySemantic.live_dispatch, ['gta-update-police', 'gta-update-fire']);
    assert.deepEqual(bySemantic.reported_occurrence, ['tps-mci']);
    assert.deepEqual(bySemantic.annual_aggregate, ['tps-calls-attended']);
    const keys = TORONTO_SAFETY_SOURCES.map((source) => source.canonicalKey);
    assert.equal(new Set(keys).size, 4);
    assert.equal(TORONTO_SAFETY_SOURCES.every((source) => source.bootstrap === 'none'), true);
    assert.equal(TORONTO_SAFETY_SOURCES.every((source) => source.geocode === false), true);
    assert.equal(
      TORONTO_SAFETY_SOURCES.filter((source) => source.id.startsWith('gta-')).every((source) => source.productionWriter === 'disabled'),
      true,
    );
    assert.equal(
      TORONTO_SAFETY_SOURCES.filter((source) => source.id.startsWith('tps-')).every((source) => source.productionWriter === 'on-demand'),
      true,
    );

    const coreSrc = read('src/services/toronto-safety-core.ts');
    assert.match(coreSrc, /live_dispatch/);
    assert.match(coreSrc, /reported_occurrence/);
    assert.match(coreSrc, /annual_aggregate/);
    assert.match(coreSrc, /safety:toronto:gta-update:police:v1/);
    assert.match(coreSrc, /safety:toronto:gta-update:fire:v1/);
    assert.match(coreSrc, /safety:toronto:tps-mci:v1/);
    assert.match(coreSrc, /safety:toronto:tps-calls-attended:v1/);
    assert.match(coreSrc, /productionWriter: 'disabled'/);
    assert.match(coreSrc, /productionWriter: 'on-demand'/);
    assert.equal(/safety:toronto-tfs:v1|safety:toronto-tps:v1/.test(coreSrc), false);
  });

  it('does not add GTA or TPS to seed-bundle-canada', () => {
    const bundle = read('scripts/seed-bundle-canada.mjs');
    const sections = extractBundleSections(bundle);
    assert.equal(sections.length, 8);
    assert.equal(sections.some((section) => SAFETY_HINT.test(section.label) || SAFETY_HINT.test(section.script)), false);
    assert.equal(SAFETY_HINT.test(bundle), false);
  });

  it('does not register a Railway cron or watch path for either source', () => {
    const railway = JSON.parse(read('scripts/railway-services.json'));
    assert.equal(railway.some((row) => SAFETY_HINT.test(row.service || '')), false);
    const canada = railway.find((row) => row.service === 'seed-bundle-canada');
    assert.ok(canada);
    assert.equal((canada.watchPatterns || []).some((pattern) => SAFETY_HINT.test(pattern)), false);
  });

  it('keeps startup FAST/SLOW bootstrap keys unchanged and free of GTA/TPS', () => {
    const fast = bootstrapTierKeyNames('fast');
    const slow = bootstrapTierKeyNames('slow');
    const onDemand = bootstrapTierKeyNames('on-demand');
    const { BOOTSTRAP_KEYS } = healthTesting;
    for (const key of SAFETY_KEYS) {
      assert.equal(Object.values(BOOTSTRAP_KEYS).includes(key), false, `${key} must not be a bootstrap payload key`);
    }
    for (const name of ['gtaUpdate', 'gtaUpdatePolice', 'gtaUpdateFire', 'tpsMci', 'tpsCallsAttended', 'torontoSafety']) {
      assert.equal(fast.includes(name), false);
      assert.equal(slow.includes(name), false);
      assert.equal(onDemand.includes(name), false);
      assert.equal(Object.hasOwn(BOOTSTRAP_KEYS, name), false);
    }
    const bootstrapSrc = read('shared/bootstrap-tier-keys.js');
    assert.equal(SAFETY_HINT.test(bootstrapSrc), false);
  });

  it('keeps GTA out of production writers, health probes, and MCP', () => {
    assert.equal(GTA_UPDATE_WRITER_ENABLED, false);
    const seeder = read('scripts/seed-gta-update.mjs');
    assert.match(seeder, /LOCKED DISABLED|writer disabled/i);
    assert.equal(/runSeed\(/.test(seeder), false);
    const { STANDALONE_KEYS, BOOTSTRAP_KEYS, SEED_META, ON_DEMAND_KEYS } = healthTesting;
    assert.equal(Object.values(STANDALONE_KEYS).includes(GTA_POLICE_KEY), false);
    assert.equal(Object.values(STANDALONE_KEYS).includes(GTA_FIRE_KEY), false);
    assert.equal(Object.values(BOOTSTRAP_KEYS).includes(GTA_POLICE_KEY), false);
    assert.equal(Object.hasOwn(SEED_META, 'gtaUpdatePolice'), false);
    assert.equal(ON_DEMAND_KEYS.has('gtaUpdatePolice'), false);
    const healthSrc = read('api/health.js');
    assert.equal(/gtaupdate\.com|gta-update-police|safety:toronto:gta-update/.test(healthSrc), false);
    const seedHealth = read('api/seed-health.js');
    assert.equal(SAFETY_HINT.test(seedHealth) && /gta-update/.test(seedHealth), false);
    const mcpGrant = read('src/mcp-grant-main.ts');
    assert.equal(/gtaupdate|gta-update/.test(mcpGrant), false);
    const mcpApi = read('api/mcp.ts');
    assert.equal(/gtaupdate|gta-update|safety:toronto:gta-update/.test(mcpApi), false);
  });

  it('registers TPS as on-demand health only, not default bootstrap', () => {
    const { STANDALONE_KEYS, BOOTSTRAP_KEYS, SEED_META, ON_DEMAND_KEYS } = healthTesting;
    assert.equal(BOOTSTRAP_KEYS.tpsMci, undefined);
    assert.equal(BOOTSTRAP_KEYS.tpsCallsAttended, undefined);
    assert.equal(STANDALONE_KEYS.tpsMci, TPS_MCI_KEY);
    assert.equal(STANDALONE_KEYS.tpsCallsAttended, TPS_CALLS_KEY);
    assert.equal(SEED_META.tpsMci.key, 'seed-meta:safety:tps-mci');
    assert.equal(SEED_META.tpsCallsAttended.key, 'seed-meta:safety:tps-calls-attended');
    assert.equal(ON_DEMAND_KEYS.has('tpsMci'), true);
    assert.equal(ON_DEMAND_KEYS.has('tpsCallsAttended'), true);
    const tpsSeeder = read('scripts/seed-tps-open-data.mjs');
    assert.match(tpsSeeder, /NOT a seed-bundle-canada member/);
    assert.match(tpsSeeder, /Capacity decision/);
  });

  it('does not fold Toronto safety into canadaAlerts, canadaRoads, weather, or news', () => {
    const alerts = read('scripts/lib/canada-alerts-union.mjs');
    const roads = read('src/services/canada-roads-core.ts');
    assert.equal(SAFETY_HINT.test(alerts), false);
    assert.equal(SAFETY_HINT.test(roads), false);
    assert.equal(TORONTO_SAFETY_SOURCES.every((source) => !source.canonicalKey.startsWith('alerts:canada')), true);
    assert.equal(TORONTO_SAFETY_SOURCES.every((source) => !source.canonicalKey.startsWith('infra:')), true);
  });
});
