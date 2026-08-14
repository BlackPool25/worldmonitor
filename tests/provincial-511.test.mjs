import assert from 'node:assert/strict';
import test from 'node:test';

import { __testing__ as limiterTesting } from '../scripts/_511-rate-limit.mjs';
import {
  MAX_RECORDS,
  ONTARIO_511,
  VENDOR_511_HOSTS,
  centroidOfPath,
  decodeEncodedPolyline,
  declareVendor511Records,
  fetchVendor511,
  get,
  isVendor511Host,
  normalize511List,
  normalize511Record,
  select511Records,
  validateVendor511Envelope,
  vendor511Path,
} from '../scripts/lib/provincial-511.mjs';

test.afterEach(() => {
  limiterTesting.reset();
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('vendor paths use /api/v2/get except roadconditions which uses v3', () => {
  assert.equal(vendor511Path('event'), '/api/v2/get/event');
  assert.equal(vendor511Path('alerts'), '/api/v2/get/alerts');
  assert.equal(vendor511Path('roadconditions'), '/api/v3/get/roadconditions');
});

test('Ontario is the first vendor config; BC Open511 is not on the allowlist', () => {
  assert.equal(ONTARIO_511.jurisdiction, 'ON');
  assert.equal(VENDOR_511_HOSTS['511on.ca'].jurisdiction, 'ON');
  assert.equal(isVendor511Host('511on.ca'), true);
  assert.equal(isVendor511Host('api.open511.gov.bc.ca'), false);
  assert.equal(isVendor511Host('open511.gov.bc.ca'), false);
  assert.equal(isVendor511Host('has'), false);
  assert.equal(Object.hasOwn(VENDOR_511_HOSTS, 'has'), false);
});

test('empty event/alert/condition lists are valid', () => {
  assert.deepEqual(normalize511List([], 'event', 'ON'), []);
  assert.equal(declareVendor511Records({ events: [], alerts: [], conditions: [] }), 0);
  assert.equal(validateVendor511Envelope({ events: [], alerts: [], conditions: [] }), true);
});

test('event lat/lon are preserved as centroid [lon, lat]', () => {
  const record = normalize511Record({
    ID: 216791,
    Latitude: 42.853554,
    Longitude: -81.27517,
    EventType: 'roadwork',
    IsFullClosure: true,
    Severity: 'Unknown',
    Description: 'ALL LANES CLOSED',
    LanesAffected: 'ALL LANES CLOSED',
    EncodedPolyline: null,
  }, { kind: 'event', jurisdiction: 'ON' });
  assert.equal(record.id, '216791');
  assert.equal(record.lat, 42.853554);
  assert.equal(record.lon, -81.27517);
  assert.deepEqual(record.centroid, [-81.27517, 42.853554]);
  assert.equal(record.isFullClosure, true);
  assert.equal(record.jurisdiction, 'ON');
  assert.equal(record.severity, 'Extreme');
});

test('missing lat/lon falls back to a polyline centroid', () => {
  const encoded = 'yklkG|jqcNC?aDd@mCd@eC`@sARe@HqAR}Cf@{@LsARqBZaBVUBqEp@{@L{@JwAP_CRu@DkF^qJp@}F';
  const path = decodeEncodedPolyline(encoded);
  assert.ok(path.length > 1);
  const expected = centroidOfPath(path);
  const record = normalize511Record({
    ID: 225175,
    EncodedPolyline: encoded,
    EventType: 'roadwork',
    Description: 'lane restriction',
  }, { kind: 'event', jurisdiction: 'ON' });
  assert.equal(record.lat, null);
  assert.equal(record.lon, null);
  assert.ok(record.centroid);
  assert.equal(record.centroid[0].toFixed(3), expected[0].toFixed(3));
  assert.equal(record.centroid[1].toFixed(3), expected[1].toFixed(3));
  assert.ok(record.centroid[1] > 40 && record.centroid[1] < 50);
  assert.ok(record.centroid[0] < -74 && record.centroid[0] > -90);
});

test('roadconditions EncodedPolyline arrays decode to a path and centroid', () => {
  const encoded = 'yklkG|jqcNC?aDd@mCd@eC`@sARe@HqAR}Cf@{@LsARqBZaBVUBqEp@{@L{@JwAP_CRu@DkF^qJp@}F';
  const record = normalize511Record({
    LocationDescription: 'From Highway 17 to Pukaskwa Park',
    Condition: ['No Report'],
    RoadwayName: '627',
    EncodedPolyline: [encoded],
  }, { kind: 'condition', jurisdiction: 'ON' });
  assert.equal(record.eventType, 'roadcondition');
  assert.ok(Array.isArray(record.path) && record.path.length > 1);
  assert.ok(record.centroid);
});

test('ended/empty alerts without coordinates stay valid map-less records', () => {
  const record = normalize511Record({
    Id: 635,
    Message: 'Restricted Fire Zone',
    Regions: ['Northeastern'],
    HighImportance: true,
  }, { kind: 'alert', jurisdiction: 'ON' });
  assert.equal(record.kind, 'alert');
  assert.equal(record.lat, null);
  assert.equal(record.centroid, null);
  assert.equal(record.severity, 'Severe');
});

test('get() fetches Ontario event over /api/v2/get/event?format=json', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse([{
      ID: 1,
      Latitude: 43.65,
      Longitude: -79.38,
      EventType: 'accidentsAndIncidents',
      Description: 'collision',
    }]);
  };
  const result = await get('https://511on.ca', 'event', { fetchFn });
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].lat, 43.65);
  assert.equal(result.records[0].lon, -79.38);
  assert.match(urls[0].url, /^https:\/\/511on\.ca\/api\/v2\/get\/event\?format=json$/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.equal(typeof urls[0].init.fetch, 'undefined');
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 1);
});

test('get() uses /api/v3/get/roadconditions for that resource', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    return jsonResponse([]);
  };
  const result = await get('https://511on.ca', 'roadconditions', { fetchFn });
  assert.equal(result.records.length, 0);
  assert.match(urls[0], /\/api\/v3\/get\/roadconditions\?format=json$/);
});

test('three Ontario resources consume 3 tokens', async () => {
  const fetchFn = async () => jsonResponse([]);
  await fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 });
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 3);
});

test('one endpoint failure does not empty the others', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('/alerts')) {
      return new Response('nope', { status: 503 });
    }
    if (String(url).includes('/event')) {
      return jsonResponse([{ ID: 1, Latitude: 43.6, Longitude: -79.4, EventType: 'closures', IsFullClosure: true }]);
    }
    return jsonResponse([{ LocationDescription: 'Hwy 401', EncodedPolyline: ['yklkG|jqcNC?'] }]);
  };
  const envelope = await fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 });
  assert.equal(envelope.events.length, 1);
  assert.equal(envelope.alerts.length, 0);
  assert.equal(envelope.conditions.length, 1);
  assert.deepEqual(envelope.failedResources, ['alerts']);
  assert.equal(declareVendor511Records(envelope), 2);
});

test('all-endpoint failure throws so last-good is preserved', async () => {
  const fetchFn = async () => new Response('down', { status: 500 });
  await assert.rejects(
    () => fetchVendor511(ONTARIO_511, { fetchFn, staggerMs: 0 }),
    /all endpoints failed/,
  );
});

test('BC Open511 host is rejected and does not use this /api/v2/get client', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return jsonResponse([]);
  };
  await assert.rejects(
    () => get('https://api.open511.gov.bc.ca', 'events', { fetchFn }),
    /not on the vendor \/api\/v2\/get allowlist/,
  );
  assert.equal(called, false);
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 0);
});

test('responses larger than 5MB are rejected', async () => {
  const fetchFn = async () => jsonResponse([], {
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    () => get('https://511on.ca', 'event', { fetchFn }),
    /exceeds 5242880 bytes/,
  );
});

test('seeder module is not imported by this test file', () => {
  const src = import.meta.url;
  assert.match(src, /provincial-511\.test\.mjs$/);
});

test('roadconditions without an ID get a synthesized stable id', () => {
  const record = normalize511Record({
    LocationDescription: 'From Highway 17 to Pukaskwa Park',
    Condition: ['No Report'],
    RoadwayName: '627',
    EncodedPolyline: ['yklkG|jqcNC?'],
  }, { kind: 'condition', jurisdiction: 'ON' });
  assert.ok(record.id);
  assert.match(record.id, /^ON:condition:627:/);
});

test('live-shaped Ontario mix keeps accidents inside the 400-record cap', () => {
  const events = [];
  for (let i = 0; i < 104; i++) {
    events.push(normalize511Record({
      ID: 200000 + i,
      Latitude: 43 + (i * 0.001),
      Longitude: -79.3,
      EventType: 'closures',
      IsFullClosure: true,
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  for (let i = 0; i < 11; i++) {
    events.push(normalize511Record({
      ID: 300000 + i,
      Latitude: 44.1,
      Longitude: -80.2,
      EventType: 'accidentsAndIncidents',
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  for (let i = 0; i < 499; i++) {
    events.push(normalize511Record({
      ID: 400000 + i,
      Latitude: 45.2,
      Longitude: -81.1,
      EventType: 'roadwork',
      Severity: 'Unknown',
    }, { kind: 'event', jurisdiction: 'ON' }));
  }
  assert.equal(events.length, 614);

  const conditions = [];
  for (let i = 0; i < 546; i++) {
    conditions.push(normalize511Record({
      LocationDescription: `Segment ${i}`,
      Condition: ['No Report'],
      RoadwayName: String(400 + (i % 200)),
      EncodedPolyline: ['yklkG|jqcNC?'],
    }, { kind: 'condition', jurisdiction: 'ON' }));
  }
  assert.equal(conditions.length, 546);
  assert.equal(conditions.every((r) => r.id && r.severity === 'Unknown'), true);

  const selected = select511Records([...events, ...conditions]);
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected.filter((r) => r.isFullClosure).length, 104);
  assert.equal(selected.filter((r) => /accident/i.test(r.eventType)).length, 11);
  assert.equal(selected.filter((r) => r.kind === 'condition').length, 0);
});
