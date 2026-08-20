import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { __testing__ } from '../api/health.js';
import {
  TFS_FEED_URL,
  TFS_HOST,
  TFS_KEY,
  TFS_MAX_STALE_MIN,
  TFS_SOURCE,
  TFS_TTL_SECONDS,
  TPS_HOST,
  TPS_KEY,
  TPS_LAYER_NAME,
  TPS_LAYER_URL,
  TPS_MAX_STALE_MIN,
  TPS_QUERY_URL,
  TPS_SOURCE,
  TPS_TTL_SECONDS,
  declareTfsRecords,
  declareTpsRecords,
  fetchTorontoOfficialCad,
  fetchTorontoTfs,
  fetchTorontoTps,
  isAllowedTfsHost,
  isAllowedTpsHost,
  isTpsPrivacyExcluded,
  mergeTorontoCadLastGood,
  parseTfsLivecadXml,
  parseTpsFeatureServer,
  parseTorontoLocalMs,
  validateTfsEnvelope,
  validateTpsEnvelope,
} from '../scripts/lib/toronto-official-cad.mjs';

const { classifyKey, SEED_META, STANDALONE_KEYS, EMPTY_DATA_OK_KEYS, MISSING_DATA_IS_FAILURE_KEYS } = __testing__;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TFS_FIXTURE = readFileSync(join(root, 'tests/fixtures/toronto-tfs-livecad.xml'), 'utf8');
const TPS_FIXTURE = JSON.parse(readFileSync(join(root, 'tests/fixtures/toronto-tps-c4s.json'), 'utf8'));
const LIB_SOURCE = readFileSync(join(root, 'scripts/lib/toronto-official-cad.mjs'), 'utf8');
const TFS_SEEDER = readFileSync(join(root, 'scripts/seed-toronto-tfs.mjs'), 'utf8');
const TPS_SEEDER = readFileSync(join(root, 'scripts/seed-toronto-tps.mjs'), 'utf8');
const ATTRIBUTION = readFileSync(join(root, 'scripts/source-attribution.mjs'), 'utf8');
const BUNDLE = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
const HEALTH = readFileSync(join(root, 'api/health.js'), 'utf8');
const RELAY = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');

const NOW = Date.parse('2026-08-20T22:00:00.000Z');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function xmlResponse(body, { status = 200 } = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/xml' },
  });
}

function classifyCad(name, { ageMin, length = 128 } = {}) {
  const redisKey = STANDALONE_KEYS[name];
  const seedCfg = SEED_META[name];
  return classifyKey(name, redisKey, { allowOnDemand: false }, {
    keyStrens: new Map([[redisKey, length]]),
    keyErrors: new Map(),
    keyMetaValues: new Map([[seedCfg.key, JSON.stringify({
      fetchedAt: NOW - ageMin * 60_000,
      recordCount: 3,
    })]]),
    keyMetaErrors: new Map(),
    now: NOW,
  });
}

test('TFS fixture is the official livecad XML discovered from the page XHR', () => {
  assert.match(TFS_FIXTURE, /<tfs_active_incidents>/);
  assert.match(LIB_SOURCE, /\/data\/fire\/livecad\.xml/);
  assert.equal(TFS_FEED_URL, 'https://www.toronto.ca/data/fire/livecad.xml');
  assert.doesNotMatch(TFS_SEEDER, /FeatureServer/);
  assert.match(LIB_SOURCE, /TFS machine endpoint was discovered/);
});

test('TFS parser keeps incident number, type, streets, dispatch time, alarm, area, units', () => {
  const snapshot = parseTfsLivecadXml(TFS_FIXTURE);
  assert.equal(validateTfsEnvelope(snapshot), true);
  assert.equal(declareTfsRecords(snapshot), 3);
  assert.equal(snapshot.source, TFS_SOURCE);
  assert.equal(snapshot.updatedFromDbTime, '2026-08-20 17:45:01');
  assert.equal(snapshot.updatedAt, parseTorontoLocalMs('2026-08-20 17:45:01'));

  const highrise = snapshot.records.find((r) => r.incidentNumber === 'F26129823');
  assert.ok(highrise);
  assert.equal(highrise.type, 'Fire - Highrise Residential');
  assert.equal(highrise.primeStreet, 'DUNDAS ST, TT');
  assert.equal(highrise.crossStreet, 'GEORGE ST / PEMBROKE ST');
  assert.equal(highrise.dispatchTime, '2026-08-20T16:33:40');
  assert.equal(highrise.dispatchMs, parseTorontoLocalMs('2026-08-20T16:33:40'));
  assert.equal(highrise.alarmLevel, '2');
  assert.equal(highrise.area, '325');
  assert.ok(highrise.units.includes('HR332'));
  assert.ok(highrise.units.includes('P312'));
  assert.equal(highrise.source, TFS_SOURCE);

  const intersectionOnly = snapshot.records.find((r) => r.incidentNumber === 'F26129847');
  assert.equal(intersectionOnly.primeStreet, '');
  assert.equal(intersectionOnly.crossStreet, 'DON MILLS RD / FINCH AVE E');
  assert.deepEqual(intersectionOnly.units, ['P113']);
});

test('TFS parser rejects non-CAD HTML and empty junk', () => {
  assert.throws(() => parseTfsLivecadXml('<html>no feed</html>'), /livecad XML/);
  assert.throws(() => parseTfsLivecadXml(''), /livecad XML/);
  const empty = parseTfsLivecadXml('<tfs_active_incidents><update_from_db_time>2026-08-20 17:45:01</update_from_db_time></tfs_active_incidents>');
  assert.deepEqual(empty.records, []);
  assert.equal(validateTfsEnvelope(empty), true);
});

test('TPS FeatureServer parser keeps coords, intersection, type, time, source', () => {
  const snapshot = parseTpsFeatureServer(TPS_FIXTURE);
  assert.equal(validateTpsEnvelope(snapshot), true);
  assert.equal(snapshot.source, TPS_SOURCE);
  assert.equal(snapshot.feedUrl, TPS_LAYER_URL);
  assert.match(TPS_LAYER_URL, /C4S_Public_NoGO\/FeatureServer\/0/);
  assert.equal(declareTpsRecords(snapshot), 2);

  const breakIn = snapshot.records.find((r) => r.id === 'tps-69');
  assert.ok(breakIn);
  assert.equal(breakIn.type, 'BREAK & ENTER');
  assert.equal(breakIn.crossStreets, 'KINGSBURY CRES - KINGSTON RD');
  assert.equal(breakIn.lat, 43.689442239975186);
  assert.equal(breakIn.lon, -79.26389087611648);
  assert.equal(breakIn.occurrenceMs, 1787261102000);
  assert.equal(breakIn.occurrenceTime, new Date(1787261102000).toISOString());
  assert.equal(breakIn.source, TPS_SOURCE);
  assert.equal(breakIn.division, 'D41');
});

test('TPS privacy-excluded categories remain absent and are not backfilled', () => {
  const snapshot = parseTpsFeatureServer(TPS_FIXTURE);
  const types = snapshot.records.map((r) => r.callType);
  assert.equal(types.includes('DOMESTIC'), false);
  assert.equal(types.includes('SEXUAL ASSAULT'), false);
  assert.equal(types.includes('MEDICAL'), false);
  assert.equal(types.includes('ACTIVE OPS'), false);
  assert.ok(isTpsPrivacyExcluded('DOMESTIC', 'DOMVI'));
  assert.ok(isTpsPrivacyExcluded('SEXUAL ASSAULT', 'SEXAS'));
  assert.ok(isTpsPrivacyExcluded('MEDICAL', 'MEDIC'));
  assert.ok(isTpsPrivacyExcluded('ACTIVE OPS', 'ACTOP'));
  assert.equal(isTpsPrivacyExcluded('BREAK & ENTER', 'BREEN'), false);
  assert.equal(isTpsPrivacyExcluded('SEE AMBULANCE', 'SEEAMB'), false);
  assert.match(LIB_SOURCE, /Do not backfill privacy/);
  assert.doesNotMatch(TFS_SEEDER, /tpscalls\.live|broadcastify|citizen\.com/i);
  assert.doesNotMatch(TPS_SEEDER, /tpscalls\.live|broadcastify|citizen\.com/i);
});

test('fetchTorontoTfs uses the discovered XML URL and Chrome UA', async () => {
  const urls = [];
  const result = await fetchTorontoTfs({
    userAgent: 'Mozilla/5.0 Chrome/134',
    fetchFn: async (url, init) => {
      urls.push({ url: String(url), init });
      return xmlResponse(TFS_FIXTURE);
    },
  });
  assert.equal(result.records.length, 3);
  assert.equal(urls[0].url, TFS_FEED_URL);
  assert.equal(urls[0].init.redirect, 'error');
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  await assert.rejects(
    () => fetchTorontoTfs({
      url: 'https://example.com/data/fire/livecad.xml',
      fetchFn: async () => xmlResponse(TFS_FIXTURE),
    }),
    /allowlist/,
  );
});

test('fetchTorontoTps queries only C4S_Public_NoGO and drops privacy rows', async () => {
  const urls = [];
  const result = await fetchTorontoTps({
    fetchFn: async (url, init) => {
      urls.push({ url: String(url), init });
      return jsonResponse({ ...TPS_FIXTURE, exceededTransferLimit: false });
    },
  });
  assert.equal(result.records.length, 2);
  assert.ok(urls[0].url.startsWith(TPS_QUERY_URL));
  assert.match(urls[0].url, /C4S_Public_NoGO/);
  assert.doesNotMatch(urls[0].url, /Major.?Crime|MCI|YTD/i);
  assert.equal(isAllowedTpsHost(urls[0].url), true);
  assert.equal(isAllowedTpsHost('https://services.arcgis.com/S9th0jAJ7bqgIRjw/arcgis/rest/services/Major_Crime_Indicators/FeatureServer/0/query'), false);
});

test('last-good: one source failing must not wipe the other', async () => {
  const incoming = await fetchTorontoOfficialCad({
    tfs: {
      fetchFn: async () => xmlResponse(TFS_FIXTURE),
    },
    tps: {
      fetchFn: async () => new Response('nope', { status: 503 }),
    },
  });
  assert.equal(incoming.tfs.ok, true);
  assert.equal(incoming.tps.ok, false);
  assert.equal(incoming.tfs.snapshot.records.length, 3);

  const previousTps = parseTpsFeatureServer({
    features: [TPS_FIXTURE.features[0]],
  });
  const merged = mergeTorontoCadLastGood(incoming, { tps: previousTps });
  assert.equal(merged.tfs.records.length, 3);
  assert.equal(merged.tps.records.length, 1);
  assert.equal(merged.tps.records[0].id, 'tps-69');

  const tpsOnly = await fetchTorontoOfficialCad({
    tfs: { fetchFn: async () => new Response('down', { status: 500 }) },
    tps: { fetchFn: async () => jsonResponse({ ...TPS_FIXTURE, exceededTransferLimit: false }) },
  });
  assert.equal(tpsOnly.tfs.ok, false);
  assert.equal(tpsOnly.tps.ok, true);
  const mergedTfs = mergeTorontoCadLastGood(tpsOnly, { tfs: incoming.tfs.snapshot });
  assert.equal(mergedTfs.tfs.records[0].incidentNumber, incoming.tfs.snapshot.records[0].incidentNumber);
  assert.equal(mergedTfs.tps.records.length, 2);

  await assert.rejects(
    () => fetchTorontoOfficialCad({
      tfs: { fetchFn: async () => new Response('down', { status: 500 }) },
      tps: { fetchFn: async () => new Response('down', { status: 500 }) },
    }),
    /both sources failed/,
  );
});

test('health: TFS stale after 15 min, TPS stale after 45 min', () => {
  assert.equal(SEED_META.torontoTfs.key, 'seed-meta:safety:toronto-tfs');
  assert.equal(SEED_META.torontoTps.key, 'seed-meta:safety:toronto-tps');
  assert.equal(SEED_META.torontoTfs.maxStaleMin, 15);
  assert.equal(SEED_META.torontoTps.maxStaleMin, 45);
  assert.equal(TFS_MAX_STALE_MIN, 15);
  assert.equal(TPS_MAX_STALE_MIN, 45);
  assert.equal(STANDALONE_KEYS.torontoTfs, TFS_KEY);
  assert.equal(STANDALONE_KEYS.torontoTps, TPS_KEY);

  assert.equal(classifyCad('torontoTfs', { ageMin: 14 }).status, 'OK');
  assert.equal(classifyCad('torontoTfs', { ageMin: 16 }).status, 'STALE_SEED');
  assert.equal(classifyCad('torontoTps', { ageMin: 44 }).status, 'OK');
  assert.equal(classifyCad('torontoTps', { ageMin: 46 }).status, 'STALE_SEED');
});

test('own canonical keys stay off canadaAlerts / canadaRoads / torontoRoads', () => {
  assert.equal(TFS_KEY, 'safety:toronto-tfs:v1');
  assert.equal(TPS_KEY, 'safety:toronto-tps:v1');
  assert.doesNotMatch(TFS_SEEDER, /alerts:canada|infra:toronto-roads|infra:ontario-511/);
  assert.doesNotMatch(TPS_SEEDER, /alerts:canada|infra:toronto-roads|infra:ontario-511/);
  assert.doesNotMatch(TFS_SEEDER, /TPS_KEY|safety:toronto-tps/);
  assert.doesNotMatch(TPS_SEEDER, /TFS_KEY|safety:toronto-tfs/);
  assert.match(BUNDLE, /seed-toronto-tfs\.mjs/);
  assert.match(BUNDLE, /seed-toronto-tps\.mjs/);
  assert.match(BUNDLE, /seed-meta:safety:toronto-tfs/);
  assert.match(BUNDLE, /seed-meta:safety:toronto-tps/);
  assert.ok(TFS_TTL_SECONDS * 1000 > 5 * 60_000);
  assert.ok(TPS_TTL_SECONDS * 1000 > 15 * 60_000);
  assert.ok(TFS_TTL_SECONDS > TFS_MAX_STALE_MIN * 60);
  assert.ok(TPS_TTL_SECONDS > TPS_MAX_STALE_MIN * 60);
});

test('attribution records TFS and TPS licences and credits the agencies', () => {
  assert.match(ATTRIBUTION, /'www\.toronto\.ca':/);
  assert.match(ATTRIBUTION, /Toronto Fire Services/);
  assert.match(ATTRIBUTION, /'services\.arcgis\.com':/);
  assert.match(ATTRIBUTION, /Toronto Police Service/);
  assert.match(ATTRIBUTION, /Open Government Licence/);
  assert.match(ATTRIBUTION, /C4S_Public_NoGO|Calls for Service/);
  assert.ok(EMPTY_DATA_OK_KEYS.has('torontoTfs'));
  assert.ok(EMPTY_DATA_OK_KEYS.has('torontoTps'));
  assert.ok(MISSING_DATA_IS_FAILURE_KEYS.has('torontoTfs'));
  assert.ok(MISSING_DATA_IS_FAILURE_KEYS.has('torontoTps'));
});

test('host allowlists and isolation from the relay', () => {
  assert.equal(isAllowedTfsHost(TFS_FEED_URL), true);
  assert.equal(isAllowedTfsHost('https://secure.toronto.ca/data/fire/livecad.xml'), false);
  assert.equal(isAllowedTpsHost(TPS_QUERY_URL + '?f=json'), true);
  assert.equal(isAllowedTpsHost('https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/Evacuation_Orders_and_Alerts/FeatureServer/0/query'), false);
  assert.doesNotMatch(RELAY, /livecad\.xml|C4S_Public_NoGO|toronto-tfs|toronto-tps/);
  assert.match(LIB_SOURCE, new RegExp(TFS_HOST.replace(/\./g, '\\.')));
  assert.match(LIB_SOURCE, new RegExp(TPS_HOST.replace(/\./g, '\\.')));
  assert.match(LIB_SOURCE, new RegExp(TPS_LAYER_NAME));
  assert.doesNotMatch(HEALTH, /canadaAlerts:.*toronto-tfs|torontoRoads:.*toronto-tfs/);
});

test('this test file does not import the seeder modules', () => {
  const self = readFileSync(new URL(import.meta.url), 'utf8');
  assert.equal(/from ['"][^'"]*seed-toronto-tf/.test(self), false);
});
