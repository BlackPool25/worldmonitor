import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  CHROME_UA,
  MAX_RECORDS,
  TORONTO_ROADS_HOST,
  TORONTO_ROADS_JURISDICTION,
  TORONTO_ROADS_SOURCE,
  TORONTO_ROADS_URL,
  centroidOfPath,
  declareTorontoRoadRecords,
  extractRestrictionsList,
  fetchTorontoRoadRestrictions,
  isAllowedTorontoHost,
  normalizeTorontoRoadList,
  normalizeTorontoRoadRecord,
  parseGeoPolyline,
  parseRestrictionsJson,
  selectTorontoRoadRecords,
  validateTorontoRoadEnvelope,
} from '../scripts/lib/toronto-road-restrictions.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = join(root, 'tests/fixtures/toronto-road-restrictions.json');
// Captured 2026-08-13 from TORONTO_ROADS_URL with CHROME_UA (Chrome/134).
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
const SEEDER_SOURCE = readFileSync(join(root, 'scripts/seed-toronto-road-restrictions.mjs'), 'utf8');
const RELAY_SOURCE = readFileSync(join(root, 'scripts/ais-relay.cjs'), 'utf8');
const LIB_SOURCE = readFileSync(join(root, 'scripts/lib/toronto-road-restrictions.mjs'), 'utf8');

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(payload, {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('fixture envelope is a Closure list with district and coordinates', () => {
  const items = extractRestrictionsList(FIXTURE);
  assert.ok(Array.isArray(items) && items.length >= 3);
  for (const item of items) {
    assert.equal(typeof item.district, 'string');
    assert.ok(item.district.length > 0, 'captured records must include district');
    assert.ok(Number.isFinite(Number(item.latitude)), 'captured records must include latitude');
    assert.ok(Number.isFinite(Number(item.longitude)), 'captured records must include longitude');
  }
  const types = new Set(items.map((item) => item.type));
  assert.ok(types.has('CONSTRUCTION'));
  assert.ok(types.has('ROAD_CLOSED'));
  assert.ok(types.has('HAZARD'));
});

test('normalise preserves district, lat/lon centroid, type, and currImpact', () => {
  const records = normalizeTorontoRoadList(FIXTURE);
  assert.equal(records.length, 3);
  const construction = records.find((r) => r.id === 'Tor-RD52026-4842');
  assert.equal(construction.district, 'NORTH YORK');
  assert.equal(construction.type, 'CONSTRUCTION');
  assert.equal(construction.eventType, 'CONSTRUCTION');
  assert.equal(construction.currImpact, 'Low');
  assert.equal(construction.lat, 43.731550);
  assert.equal(construction.lon, -79.424030);
  assert.deepEqual(construction.centroid, [-79.424030, 43.731550]);
  assert.ok(Array.isArray(construction.path) && construction.path.length > 1);
  assert.equal(construction.source, TORONTO_ROADS_SOURCE);
  assert.equal(construction.jurisdiction, TORONTO_ROADS_JURISDICTION);
  assert.equal(construction.createdTime, 1786652617000);
});

test('ROAD_CLOSED records are full closures; HAZARD keeps High currImpact', () => {
  const records = normalizeTorontoRoadList(FIXTURE);
  const closed = records.find((r) => r.type === 'ROAD_CLOSED');
  assert.equal(closed.district, 'SCARBOROUGH');
  assert.equal(closed.isFullClosure, true);
  assert.equal(closed.severity, 'Extreme');
  assert.ok(closed.centroid);
  const hazard = records.find((r) => r.type === 'HAZARD');
  assert.equal(hazard.district, 'NORTH YORK');
  assert.equal(hazard.currImpact, 'High');
  assert.equal(hazard.severity, 'Extreme');
  assert.equal(hazard.isFullClosure, false);
  assert.equal(hazard.path, null, 'single-point geoPolyline is a dot, not a path');
});

test('missing lat/lon falls back to a geoPolyline centroid', () => {
  const item = { ...FIXTURE.Closure[0] };
  delete item.latitude;
  delete item.longitude;
  const decoded = parseGeoPolyline(item.geoPolyline);
  assert.ok(decoded.length > 1);
  const expected = centroidOfPath(decoded);
  const record = normalizeTorontoRoadRecord(item);
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
  assert.ok(record.centroid);
  assert.equal(record.centroid[0].toFixed(5), expected[0].toFixed(5));
  assert.equal(record.centroid[1].toFixed(5), expected[1].toFixed(5));
  assert.ok(record.centroid[1] > 43 && record.centroid[1] < 44);
  assert.ok(record.centroid[0] < -79 && record.centroid[0] > -80);
});

test('empty Closure list is valid zero-record success', () => {
  const records = normalizeTorontoRoadList({ Closure: [] });
  assert.deepEqual(records, []);
  assert.equal(declareTorontoRoadRecords({ records: [] }), 0);
  assert.equal(validateTorontoRoadEnvelope({ records: [] }), true);
});

test('non-list 200 bodies are rejected as degraded', () => {
  assert.throws(() => parseRestrictionsJson('<html>not json</html>'), /parseable restrictions list/);
  assert.throws(() => normalizeTorontoRoadList({ ok: true }), /parseable restrictions list/);
  assert.throws(() => normalizeTorontoRoadList(null), /parseable restrictions list/);
  assert.throws(() => parseRestrictionsJson(''), /parseable restrictions list/);
});

test('invalid JSON escapes in CART descriptions still parse', () => {
  const body = '{"Closure":[{"id":"x","district":"TORONTO","latitude":"43.65","longitude":"-79.38","type":"CONSTRUCTION","currImpact":"Low","description":"Water \\ Serwer"}]}';
  const parsed = parseRestrictionsJson(body);
  const records = normalizeTorontoRoadList(parsed);
  assert.equal(records.length, 1);
  assert.equal(records[0].district, 'TORONTO');
  assert.equal(records[0].lat, 43.65);
});

test('host allowlist is secure.toronto.ca only', () => {
  assert.equal(isAllowedTorontoHost(TORONTO_ROADS_URL), true);
  assert.equal(isAllowedTorontoHost('https://511on.ca/api/v2/get/event'), false);
  assert.equal(isAllowedTorontoHost('https://open.toronto.ca/dataset/road-restrictions/'), false);
});

test('selectTorontoRoadRecords prefers closures and caps at MAX_RECORDS', () => {
  const records = [];
  for (let i = 0; i < MAX_RECORDS + 20; i++) {
    records.push(normalizeTorontoRoadRecord({
      id: `n-${i}`,
      district: 'TORONTO',
      latitude: '43.65',
      longitude: '-79.38',
      type: 'CONSTRUCTION',
      currImpact: 'None',
    }));
  }
  records.push(normalizeTorontoRoadRecord({
    id: 'closed-1',
    district: 'TORONTO',
    latitude: '43.65',
    longitude: '-79.38',
    type: 'ROAD_CLOSED',
    currImpact: 'High',
  }));
  const selected = selectTorontoRoadRecords(records);
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected[0].id, 'closed-1');
});

test('fetchTorontoRoadRestrictions uses CHROME_UA and the CART v3 URL', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(FIXTURE);
  };
  const result = await fetchTorontoRoadRestrictions({ fetchFn, userAgent: CHROME_UA });
  assert.equal(result.records.length, 3);
  assert.equal(result.records[0].district, 'NORTH YORK');
  assert.ok(result.records[0].centroid);
  assert.equal(urls[0].url, TORONTO_ROADS_URL);
  assert.equal(urls[0].init.redirect, 'error');
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  assert.equal(typeof urls[0].init.fetch, 'undefined');
});

test('fetchTorontoRoadRestrictions rejects a foreign host and a non-list 200', async () => {
  await assert.rejects(
    () => fetchTorontoRoadRestrictions({
      url: 'https://example.com/restrictions',
      fetchFn: async () => jsonResponse(FIXTURE),
    }),
    /allowlist/,
  );
  await assert.rejects(
    () => fetchTorontoRoadRestrictions({
      fetchFn: async () => jsonResponse({ status: 'ok' }),
    }),
    /parseable restrictions list/,
  );
});

test('seeder is a standalone nixpacks job and does not loop ais-relay or reuse 511', () => {
  assert.match(SEEDER_SOURCE, /fetchTorontoRoadRestrictions/);
  assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  assert.match(SEEDER_SOURCE, /infra:toronto-roads:v1/);
  assert.match(SEEDER_SOURCE, /toronto-roads-v1/);
  assert.doesNotMatch(SEEDER_SOURCE, /from ['"].*provincial-511/);
  assert.doesNotMatch(SEEDER_SOURCE, /acquire511Slot/);
  assert.doesNotMatch(SEEDER_SOURCE, /fetch\.bind/);
  assert.doesNotMatch(LIB_SOURCE, /_511-rate-limit/);
  assert.doesNotMatch(LIB_SOURCE, /from ['"].*provincial-511/);
  assert.doesNotMatch(LIB_SOURCE, /511on\.ca/);
  assert.match(LIB_SOURCE, new RegExp(TORONTO_ROADS_HOST.replace(/\./g, '\\.')));
  assert.doesNotMatch(RELAY_SOURCE, /toronto\.ca/);
  assert.doesNotMatch(RELAY_SOURCE, /toronto-roads/);
  assert.doesNotMatch(RELAY_SOURCE, /secure\.toronto\.ca/);
});
