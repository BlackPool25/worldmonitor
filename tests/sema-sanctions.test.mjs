import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  SEMA_CACHE_KEY,
  SEMA_HOST,
  SEMA_MAX_BYTES,
  SEMA_SOURCE,
  SEMA_XML_URL,
  SANCTIONS_MAX_CONTENT_AGE_MIN,
  SANCTIONS_SOURCE_VERSION,
  fetchSemaXml,
  mergeSanctionEntries,
  parseSemaXml,
  sameSanctionIdentity,
  sanctionsListContentMeta,
} from '../scripts/_sema-sanctions.mjs';

const fixtureXml = readFileSync(
  new URL('./fixtures/sema-lmes-slice.xml', import.meta.url),
  'utf8',
);
const parseSrc = readFileSync(
  new URL('../scripts/_sema-sanctions.mjs', import.meta.url),
  'utf8',
);
const seedSrc = readFileSync(
  new URL('../scripts/seed-sanctions-pressure.mjs', import.meta.url),
  'utf8',
);
const testSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const railwaySrc = readFileSync(
  new URL('../scripts/railway-services.json', import.meta.url),
  'utf8',
);
const healthSrc = readFileSync(new URL('../api/health.js', import.meta.url), 'utf8');
const seedHealthSrc = readFileSync(new URL('../api/seed-health.js', import.meta.url), 'utf8');

describe('SEMA fixture parse', () => {
  it('maps individuals, entities, ships, aliases, IMO, and publication dates', () => {
    const { records, publishedAtMs } = parseSemaXml(fixtureXml);
    assert.equal(records.length, 5);
    assert.ok(records.every((row) => row.sourceLists.includes(SEMA_SOURCE)));

    const person = records.find((row) => row.name === 'Aleksey Oleksin');
    assert.ok(person);
    assert.equal(person.entityType, 'SANCTIONS_ENTITY_TYPE_INDIVIDUAL');
    assert.deepEqual(person._aliases, ['Aliaksei Aleksin']);
    assert.equal(person.countryCodes[0], 'BY');
    assert.equal(person.programs[0], 'SEMA');

    const entity = records.find((row) => /Belaeronavigatsia/.test(row.name));
    assert.ok(entity);
    assert.equal(entity.entityType, 'SANCTIONS_ENTITY_TYPE_ENTITY');

    const ship = records.find((row) => row.name === 'Balitiyskiy III');
    assert.ok(ship);
    assert.equal(ship.entityType, 'SANCTIONS_ENTITY_TYPE_VESSEL');
    assert.ok(ship._identifiers.includes('imo:7612448'));

    const newest = records.find((row) => row.name === 'STREIT Group');
    assert.ok(newest);
    assert.equal(newest._publishedAt, '2026-08-06');
    assert.equal(publishedAtMs, Date.UTC(2026, 7, 6));
    assert.equal(String(newest.effectiveAt), String(Date.UTC(2026, 7, 6)));
  });
});

describe('dedup identity is not unique-name', () => {
  it('does not merge the same unique name when identifiers conflict', () => {
    const ofac = {
      id: 'SDN:1',
      name: 'Alpha Corp',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: [],
      _identifiers: ['imo:1111111'],
    };
    const sema = {
      id: 'sema-ca:alpha:1',
      name: 'Alpha Corp',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: ['imo:2222222'],
    };
    assert.equal(sameSanctionIdentity(ofac, sema), false);
    const merged = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.equal(merged.length, 2);
  });

  it('merges different unique names that share an alias', () => {
    const ofac = {
      id: 'SDN:2',
      name: 'Acme Shipping',
      sourceLists: ['SDN'],
      programs: ['SDN'],
      _aliases: ['Acme Ltd'],
      _identifiers: [],
    };
    const sema = {
      id: 'sema-ca:acme:1',
      name: 'ACME LTD',
      sourceLists: [SEMA_SOURCE],
      programs: ['SEMA'],
      _aliases: [],
      _identifiers: [],
    };
    assert.equal(sameSanctionIdentity(ofac, sema), true);
    const [row] = mergeSanctionEntries({ ofac: [ofac], sema: [sema] });
    assert.ok(row.sourceLists.includes('SDN'));
    assert.ok(row.sourceLists.includes(SEMA_SOURCE));
    assert.equal(row.id, 'SDN:2');
  });

  it('merges different unique names that share an IMO identifier', () => {
    const ofac = {
      id: 'SDN:3',
      name: 'Vessel Foo',
      sourceLists: ['CONSOLIDATED'],
      programs: ['CONSOLIDATED'],
      entityType: 'SANCTIONS_ENTITY_TYPE_VESSEL',
      _aliases: [],
      _identifiers: ['imo:7612448'],
    };
    const { records } = parseSemaXml(fixtureXml);
    const ship = records.find((row) => row._identifiers.includes('imo:7612448'));
    assert.ok(ship);
    assert.notEqual(normalizeForAssert(ofac.name), normalizeForAssert(ship.name));
    assert.equal(sameSanctionIdentity(ofac, ship), true);
    const merged = mergeSanctionEntries({ ofac: [ofac], eu: [], uk: [], sema: [ship] });
    assert.equal(merged.length, 1);
    assert.ok(merged[0].sourceLists.includes(SEMA_SOURCE));
  });
});

function normalizeForAssert(name) {
  return String(name).toLowerCase();
}

describe('one list failing does not empty the panel', () => {
  it('still publishes OFAC when SEMA is missing', () => {
    const ofac = [{ id: 'SDN:9', name: 'Kept', sourceLists: ['SDN'], programs: ['SDN'], _aliases: [], _identifiers: [] }];
    const merged = mergeSanctionEntries({ ofac, sema: null, eu: undefined, uk: [] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'Kept');
  });

  it('still publishes SEMA when OFAC/EU/UK are missing', () => {
    const { records } = parseSemaXml(fixtureXml);
    const merged = mergeSanctionEntries({ ofac: null, eu: [], uk: undefined, sema: records });
    assert.equal(merged.length, records.length);
    assert.ok(merged.every((row) => row.sourceLists.includes(SEMA_SOURCE)));
  });

  it('seeder catches each list independently and only throws when every list failed', () => {
    assert.match(seedSrc, /SEMA fetch failed/);
    assert.match(seedSrc, /all sanctions lists failed/);
    assert.match(seedSrc, /mergeSanctionEntries/);
    const fnStart = seedSrc.indexOf('async function fetchSanctionsPressure()');
    const fnEnd = seedSrc.indexOf('\nfunction validate(');
    const body = seedSrc.slice(fnStart, fnEnd);
    assert.match(body, /try \{/);
    assert.match(body, /semaEntries/);
  });
});

describe('byte cap, allowlist, cache key, UA, redirect', () => {
  it('raises the byte cap above the live 1.7 MB list', () => {
    assert.ok(SEMA_MAX_BYTES >= 1.7 * 1024 * 1024, 'cap must cover the ~1.7MB XML');
    assert.ok(SEMA_MAX_BYTES >= 4 * 1024 * 1024);
    assert.ok(SEMA_MAX_BYTES <= 8 * 1024 * 1024);
    assert.match(parseSrc, /SEMA_MAX_BYTES = 8 \* 1024 \* 1024/);
  });

  it('allowlists www.international.gc.ca and uses the XML URL as the cache key', () => {
    assert.equal(SEMA_HOST, 'www.international.gc.ca');
    assert.equal(SEMA_XML_URL, 'https://www.international.gc.ca/world-monde/assets/office_docs/international_relations-relations_internationales/sanctions/sema-lmes.xml');
    assert.equal(SEMA_CACHE_KEY, SEMA_XML_URL);
    assert.match(seedSrc, /SEMA_CACHE_KEY|SEMA_XML_URL|fetchSemaEntries/);
  });

  it('rejects untrusted hosts and asks fetch to error on redirects', async () => {
    await assert.rejects(
      () => fetchSemaXml('https://evil.example/sema.xml'),
      /UNTRUSTED_SOURCE_HOST/,
    );
    await assert.rejects(
      () => fetchSemaXml('http://www.international.gc.ca/sema.xml'),
      /UNTRUSTED_SOURCE_HOST/,
    );

    let seen;
    const fetchFn = async (url, opts) => {
      seen = { url, opts };
      return {
        ok: true,
        headers: { get: () => null },
        text: async () => fixtureXml,
      };
    };
    await fetchSemaXml(SEMA_XML_URL, { fetchFn });
    assert.equal(seen.opts.redirect, 'error');
    assert.ok(seen.opts.signal);
    assert.match(seen.opts.headers['User-Agent'], /Mozilla/);
    assert.doesNotMatch(parseSrc, /fetch\.bind\(/);
    assert.doesNotMatch(seedSrc, /fetch\.bind\(/);
  });

  it('enforces the byte ceiling', async () => {
    const fetchFn = async () => ({
      ok: true,
      headers: { get: (name) => (name === 'content-length' ? String(SEMA_MAX_BYTES + 1) : null) },
      body: { cancel: async () => {} },
      text: async () => '<data-set/>',
    });
    await assert.rejects(
      () => fetchSemaXml(SEMA_XML_URL, { fetchFn, maxBytes: SEMA_MAX_BYTES }),
      /RESPONSE_TOO_LARGE/,
    );
  });
});

describe('content-age comes from publication date, not Date.now()/fetchedAt', () => {
  it('uses the XML listing/publication date', () => {
    const { publishedAtMs } = parseSemaXml(fixtureXml);
    const meta = sanctionsListContentMeta({ datasetDate: String(publishedAtMs) }, Date.UTC(2026, 7, 14));
    assert.equal(meta.newestItemAt, Date.UTC(2026, 7, 6));
    assert.equal(meta.oldestItemAt, Date.UTC(2026, 7, 6));
  });

  it('does not read Date.now or fetchedAt as the list age', () => {
    assert.doesNotMatch(parseSrc, /datasetDate:\s*String\(Date\.now\(\)\)/);
    assert.doesNotMatch(parseSrc, /publishedAtMs\s*=\s*Date\.now\(\)/);
    assert.match(seedSrc, /sanctionsListContentMeta/);
    assert.match(seedSrc, /SANCTIONS_MAX_CONTENT_AGE_MIN/);
    assert.equal(SANCTIONS_MAX_CONTENT_AGE_MIN, 30 * 24 * 60);
    const meta = sanctionsListContentMeta({ fetchedAt: String(Date.UTC(2026, 7, 14)), datasetDate: '0' }, Date.UTC(2026, 7, 14));
    assert.equal(meta, null);
  });
});

describe('seeder merge, health, railway, no new surface', () => {
  it('does not import the seeder entrypoint from this test file', () => {
    assert.doesNotMatch(testSrc, /from ['\"]\.\.\/scripts\/seed-sanctions-pressure\.mjs['\"]/);
  });

  it('does not add an ais-relay Canada loop or a new panel/proto', () => {
    assert.doesNotMatch(parseSrc, /ais-relay/);
    assert.doesNotMatch(seedSrc, /ais-relay/);
    assert.doesNotMatch(seedSrc, /SanctionsPressurePanel/);
    assert.doesNotMatch(parseSrc, /proto\/worldmonitor/);
    assert.equal(SANCTIONS_SOURCE_VERSION, 'ofac-sls-advanced-xml+sema-ca-v1');
    assert.match(seedSrc, /sourceVersion:\s*SANCTIONS_SOURCE_VERSION/);
  });

  it('reuses the existing sanctions health probe', () => {
    assert.match(healthSrc, /sanctionsPressure:\s*'sanctions:pressure:v1'/);
    assert.doesNotMatch(healthSrc, /sema-ca:pressure/);
    assert.match(seedHealthSrc, /'sanctions:pressure'/);
  });

  it('extends the sanctions Railway service watchPatterns', () => {
    const registry = JSON.parse(railwaySrc);
    const service = registry.find((entry) => entry.service === 'seed-sanctions-pressure');
    assert.ok(service, 'seed-sanctions-pressure must be registry-managed');
    assert.ok(service.watchPatterns.includes('scripts/seed-sanctions-pressure.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/_sema-sanctions.mjs'));
    assert.ok(service.watchPatterns.includes('scripts/_sanctions-source.mjs'));
  });
});
