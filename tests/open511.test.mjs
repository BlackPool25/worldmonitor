import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { __testing__ as limiterTesting } from '../scripts/_511-rate-limit.mjs';
import {
  BC_OPEN511,
  MAX_RECORDS,
  OPEN511_HOSTS,
  centroidOfPath,
  fetchEvents,
  geometryFromOpen511,
  isOpen511Host,
  normalizeOpen511Event,
  normalizeOpen511List,
  open511Adapter,
  selectOpen511Records,
} from '../scripts/lib/open511.mjs';

const PAGE = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-active-page.json', import.meta.url), 'utf8'));
const PAGE1 = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-page-1.json', import.meta.url), 'utf8'));
const PAGE2 = JSON.parse(readFileSync(new URL('./fixtures/open511-bc-page-2.json', import.meta.url), 'utf8'));
const ADAPTER_SOURCE = readFileSync(new URL('../scripts/lib/open511.mjs', import.meta.url), 'utf8');
const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-open511.mjs', import.meta.url), 'utf8');
const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
const TEST_SOURCE = readFileSync(new URL(import.meta.url), 'utf8');

test.afterEach(() => {
  limiterTesting.reset();
});

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('seeder module is not imported by this test file', () => {
  assert.equal(/from ['"][^'"]*seed-open511/.test(TEST_SOURCE), false);
  assert.equal(TEST_SOURCE.includes('seed-open511.mjs'), true, 'fixture: this file must still mention the seeder as text');
});

test('adapter is Open511 /events?status=ACTIVE, not vendor /api/v2/get', () => {
  assert.match(ADAPTER_SOURCE, /events\?status=ACTIVE|searchParams\.set\('status'/);
  assert.doesNotMatch(ADAPTER_SOURCE, /\/api\/v2\/get/);
  assert.doesNotMatch(ADAPTER_SOURCE, /from ['"].*provincial-511/);
  assert.equal(isOpen511Host('api.open511.gov.bc.ca'), true);
  assert.equal(isOpen511Host('511on.ca'), false);
  assert.equal(OPEN511_HOSTS['api.open511.gov.bc.ca'].jurisdiction, 'BC');
  assert.equal(BC_OPEN511.source, 'bc-open511');
});

test('captured page fixture preserves coordinates as [lon, lat]', () => {
  const records = normalizeOpen511List(PAGE, { jurisdiction: 'BC', source: 'bc-open511' });
  assert.equal(records.length, 2);
  const point = records.find((r) => r.id === 'drivebc.ca/DBC-47311');
  const line = records.find((r) => r.id === 'drivebc.ca/RIDE-100556');
  assert.ok(point);
  assert.equal(point.lat, 52.972914);
  assert.equal(point.lon, -122.489194);
  assert.deepEqual(point.centroid, [-122.489194, 52.972914]);
  assert.equal(point.jurisdiction, 'BC');
  assert.equal(point.source, 'bc-open511');
  assert.ok(line);
  assert.ok(line.path && line.path.length > 1);
  assert.ok(line.centroid);
  assert.equal(line.centroid[0].toFixed(3), centroidOfPath(line.path)[0].toFixed(3));
  assert.ok(line.lat > 48 && line.lat < 50);
  assert.ok(line.lon < -123 && line.lon > -124);
});

test('LineString geography downsamples to a path; Point has no path', () => {
  const point = geometryFromOpen511({ type: 'Point', coordinates: [-123.1, 49.2] });
  assert.deepEqual(point.centroid, [-123.1, 49.2]);
  assert.equal(point.path, null);
  const line = geometryFromOpen511({
    type: 'LineString',
    coordinates: [[-123.4, 48.4], [-123.5, 48.5], [-123.6, 48.6]],
  });
  assert.equal(line.path.length, 3);
  assert.ok(line.centroid);
});

test('closed road state maps to Extreme full-closure', () => {
  const record = normalizeOpen511Event({
    id: 'drivebc.ca/DBC-1',
    headline: 'INCIDENT',
    severity: 'MAJOR',
    event_type: 'INCIDENT',
    geography: { type: 'Point', coordinates: [-123, 49] },
    roads: [{ name: 'Highway 1', state: 'CLOSED' }],
  }, { jurisdiction: 'BC', source: 'bc-open511' });
  assert.equal(record.isFullClosure, true);
  assert.equal(record.severity, 'Extreme');
  assert.equal(record.roadwayName, 'Highway 1');
});

test('fetchEvents hits Open511 events?status=ACTIVE&limit=500 and acquires the BC host slot', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse(PAGE);
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn });
  assert.equal(result.records.length, 2);
  assert.match(urls[0].url, /^https:\/\/api\.open511\.gov\.bc\.ca\/events\?status=ACTIVE&limit=500$/);
  assert.doesNotMatch(urls[0].url, /\/api\/v2\/get/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.equal(urls[0].init.headers.Accept, 'application/json');
  assert.equal(typeof urls[0].init.fetch, 'undefined');
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 1);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('two-page pagination follows next_url and rate-limits each page', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('offset=500')) return jsonResponse(PAGE2);
    return jsonResponse(PAGE1);
  };
  const adapter = open511Adapter('https://api.open511.gov.bc.ca', { fetchFn });
  const result = await adapter.fetchEvents({ status: 'ACTIVE', limit: 500 });
  assert.equal(result.records.length, 2);
  assert.equal(result.pages, 2);
  assert.match(urls[0], /\/events\?status=ACTIVE&limit=500$/);
  assert.match(urls[1], /offset=500/);
  assert.equal(limiterTesting.pendingTokens('api.open511.gov.bc.ca'), 2);
  assert.equal(result.records[0].source, 'bc-open511');
  assert.equal(result.records[1].jurisdiction, 'BC');
});

test('offset pagination continues until an empty page when next_url is absent', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    const parsed = new URL(url);
    if (parsed.searchParams.get('offset') === '1') {
      return jsonResponse({ events: [], pagination: { offset: '1' } });
    }
    return jsonResponse({
      events: [{
        id: 'drivebc.ca/DBC-page1',
        headline: 'CONSTRUCTION',
        severity: 'MINOR',
        event_type: 'CONSTRUCTION',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: { offset: '0' },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1 });
  assert.equal(result.records.length, 1);
  assert.equal(result.pages, 2);
  assert.match(urls[1], /offset=1/);
});

test('vendor 511 host is rejected and does not use this Open511 client', async () => {
  let called = false;
  const fetchFn = async () => {
    called = true;
    return jsonResponse({ events: [] });
  };
  await assert.rejects(
    () => fetchEvents('https://511on.ca', { fetchFn }),
    /not on the Open511 allowlist/,
  );
  assert.equal(called, false);
  assert.equal(limiterTesting.pendingTokens('511on.ca'), 0);
});

test('responses larger than 5MB are rejected', async () => {
  const fetchFn = async () => jsonResponse({ events: [] }, {
    headers: { 'content-length': String(5 * 1024 * 1024 + 1) },
  });
  await assert.rejects(
    () => fetchEvents('https://api.open511.gov.bc.ca', { fetchFn }),
    /exceeds 5242880 bytes/,
  );
});

test('empty event lists are valid', () => {
  assert.deepEqual(normalizeOpen511List({ events: [] }, { jurisdiction: 'BC' }), []);
});

test('seeder is a standalone nixpacks job and does not loop ais-relay', () => {
  assert.match(SEEDER_SOURCE, /open511Adapter\(BC_OPEN511\.baseUrl/);
  assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
  assert.match(SEEDER_SOURCE, /infra:bc-open511:v1/);
  assert.match(SEEDER_SOURCE, /status: 'ACTIVE'/);
  assert.doesNotMatch(SEEDER_SOURCE, /\/api\/v2\/get/);
  assert.doesNotMatch(SEEDER_SOURCE, /provincial-511/);
  assert.doesNotMatch(RELAY_SOURCE, /open511\.gov\.bc/);
  assert.doesNotMatch(RELAY_SOURCE, /bc-open511/);
  assert.doesNotMatch(RELAY_SOURCE, /canadaRoads/);
});

test('CHROME_UA, timeout, redirect error, and no fetch.bind', async () => {
  const urls = [];
  const fetchFn = async (url, init) => {
    urls.push({ url: String(url), init });
    return jsonResponse({ events: [] });
  };
  await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn });
  assert.match(urls[0].init.headers['User-Agent'], /Chrome\/134/);
  assert.equal(urls[0].init.redirect, 'error');
  assert.ok(urls[0].init.signal, 'AbortSignal.timeout must be set');
  assert.doesNotMatch(ADAPTER_SOURCE, /fetch\.bind/);
  assert.doesNotMatch(SEEDER_SOURCE, /fetch\.bind/);
  assert.match(ADAPTER_SOURCE, /AbortSignal\.timeout/);
  assert.match(ADAPTER_SOURCE, /redirect: 'error'/);
});

test('pagination stops at max pages (20)', async () => {
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    const offset = Number(new URL(url).searchParams.get('offset') || 0);
    return jsonResponse({
      events: [{
        id: `drivebc.ca/DBC-${offset}`,
        headline: 'CONSTRUCTION',
        severity: 'MINOR',
        event_type: 'CONSTRUCTION',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: {
        offset,
        next_url: `https://api.open511.gov.bc.ca/events?status=ACTIVE&limit=1&offset=${offset + 1}`,
      },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1, maxPages: 20, acquireSlot: async () => {} });
  assert.equal(result.pages, 20);
  assert.equal(calls, 20);
  assert.equal(result.records.length, 20);
});

test('BC Open511 shares canadaRoads and does not invent a second MapLayers key', () => {
  const types = readFileSync(new URL('../src/types/index.ts', import.meta.url), 'utf8');
  const layers = readFileSync(new URL('../src/config/map-layer-definitions.ts', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/services/canada-roads.ts', import.meta.url), 'utf8');
  assert.match(types, /canadaRoads: boolean/);
  assert.doesNotMatch(types, /bcOpen511\?: boolean/);
  assert.match(layers, /canadaRoads:\s+def\('canadaRoads'/);
  assert.doesNotMatch(layers, /bcOpen511:\s+def\(/);
  assert.match(client, /getHydratedData\('canadaRoads'\)/);
  assert.match(client, /getHydratedData\('bcOpen511'\)/);
  assert.match(client, /unionCanadaRoadRecords/);
  assert.match(client, /ontario-511/);
  assert.match(client, /bc-open511/);
  assert.match(client, /stampSource\(bc \|\| \[\], 'bc-open511'\)/);
});

test('railway registers seed-open511 as an active */15 nixpacks job', () => {
  const registry = JSON.parse(readFileSync(new URL('../scripts/railway-services.json', import.meta.url), 'utf8'));
  const entry = registry.find((s) => s.service === 'seed-open511');
  assert.ok(entry);
  assert.equal(entry.entry, 'scripts/seed-open511.mjs');
  assert.equal(entry.deployMode, 'nixpacks-root-scripts');
  assert.equal(entry.lifecycle, 'active');
  assert.equal(entry.cronSchedule, '*/15 * * * *');
  assert.ok(entry.watchPatterns.includes('scripts/lib/open511.mjs'));
  assert.ok(entry.watchPatterns.includes('scripts/seed-open511.mjs'));
  assert.ok(entry.watchPatterns.includes('scripts/_511-rate-limit.mjs'));
  assert.equal(entry.watchPatterns.some((p) => p.includes('provincial-511')), false);
});

test('bootstrap keeps canadaRoads on the fast tier; bcOpen511 is on-demand (~797 KB)', () => {
  const src = readFileSync(new URL('../shared/bootstrap-tier-keys.js', import.meta.url), 'utf8');
  assert.match(src, /canadaRoads: 'infra:ontario-511:v1'/);
  assert.match(src, /bcOpen511: 'infra:bc-open511:v1'/);
  const fast = src.slice(src.indexOf('const FAST_KEY_NAMES'), src.indexOf('const ON_DEMAND_KEY_NAMES'));
  const onDemand = src.slice(src.indexOf('const ON_DEMAND_KEY_NAMES'));
  assert.match(fast, /'canadaRoads'/);
  assert.doesNotMatch(fast, /'bcOpen511'/);
  assert.match(onDemand, /'bcOpen511'/);
});

test('seed-freshness-baseline acknowledges the BC Open511 cutover', () => {
  const baseline = JSON.parse(readFileSync(new URL('../scripts/seed-freshness-baseline.json', import.meta.url), 'utf8'));
  const row = baseline.acknowledged.find((a) => a.issue === 6611 || a.name === 'bcOpen511');
  assert.ok(row);
  assert.equal(row.status, 'EMPTY');
  assert.equal(row.cutover.probeKey, 'seed-meta:infra:bc-open511');
  assert.equal(row.expiresAt, '2026-08-16T20:45:00.000Z');
  assert.equal(row.cutover.firstScheduledRunAt, '2026-08-16T20:45:00.000Z');
  assert.equal(row.cutover.activatedAt, '2026-08-15T21:00:00.000Z');
});

test('following next_url without status=ACTIVE still requests ACTIVE pages', async () => {
  const urls = [];
  const fetchFn = async (url) => {
    urls.push(String(url));
    if (String(url).includes('offset=1')) {
      return jsonResponse({ events: [], pagination: { offset: '1' } });
    }
    return jsonResponse({
      events: [{
        id: 'drivebc.ca/DBC-page1',
        headline: 'INCIDENT',
        severity: 'MAJOR',
        event_type: 'INCIDENT',
        geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      }],
      pagination: {
        offset: '0',
        next_url: 'https://api.open511.gov.bc.ca/events?limit=1&offset=1',
      },
    });
  };
  const result = await fetchEvents('https://api.open511.gov.bc.ca', { fetchFn, limit: 1 });
  assert.equal(result.pages, 2);
  assert.match(urls[0], /status=ACTIVE/);
  assert.match(urls[1], /status=ACTIVE/);
  assert.match(urls[1], /offset=1/);
});

test('hitting maxPages warns that remaining pages were dropped', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const fetchFn = async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset') || 0);
      return jsonResponse({
        events: [{
          id: `drivebc.ca/DBC-${offset}`,
          headline: 'CONSTRUCTION',
          severity: 'MINOR',
          event_type: 'CONSTRUCTION',
          geography: { type: 'Point', coordinates: [-123.1, 49.2] },
        }],
        pagination: {
          offset,
          next_url: `https://api.open511.gov.bc.ca/events?limit=1&offset=${offset + 1}`,
        },
      });
    };
    const result = await fetchEvents('https://api.open511.gov.bc.ca', {
      fetchFn, limit: 1, maxPages: 3, acquireSlot: async () => {},
    });
    assert.equal(result.pages, 3);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /maxPages=3/);
    assert.match(warnings[0], /remaining pages dropped/);
    assert.match(String(result.records.length), /3/);
  } finally {
    console.warn = origWarn;
  }
});

test('400-record cap keeps closures and accidents above construction filler', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(normalizeOpen511Event({
      id: `zzz-closure-${String(i).padStart(4, '0')}`,
      headline: 'INCIDENT',
      severity: 'MAJOR',
      event_type: 'INCIDENT',
      geography: { type: 'Point', coordinates: [-123.1, 49.2] },
      roads: [{ name: 'Highway 1', state: 'CLOSED' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  for (let i = 0; i < 15; i++) {
    records.push(normalizeOpen511Event({
      id: `zzz-accident-${String(i).padStart(4, '0')}`,
      headline: 'Accident',
      description: 'Two-vehicle collision blocking the left lane',
      severity: 'MODERATE',
      event_type: 'INCIDENT',
      geography: { type: 'Point', coordinates: [-122.8, 49.1] },
      roads: [{ name: 'Highway 99', state: 'ALL_LANES_OPEN' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  for (let i = 0; i < 400; i++) {
    records.push(normalizeOpen511Event({
      id: `aaa-construction-${String(i).padStart(4, '0')}`,
      headline: 'CONSTRUCTION',
      severity: 'MINOR',
      event_type: 'CONSTRUCTION',
      geography: { type: 'Point', coordinates: [-123.0, 49.0] },
      roads: [{ name: 'Highway 5', state: 'ALL_LANES_OPEN' }],
    }, { jurisdiction: 'BC', source: 'bc-open511' }));
  }
  assert.equal(records.length, 435);
  const selected = selectOpen511Records(records);
  assert.equal(selected.length, MAX_RECORDS);
  assert.equal(selected.filter((r) => r.isFullClosure).length, 20);
  assert.equal(selected.filter((r) => /accident|collision/i.test(`${r.headline} ${r.description}`)).length, 15);
  assert.equal(selected.filter((r) => r.eventType === 'CONSTRUCTION').length, 365);
});

