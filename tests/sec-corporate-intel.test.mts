// Corporate-intelligence data product (#5695): SEC EDGAR helpers, seeder pure
// functions, and the four intelligence/v1 handler behaviors. Replaces
// tests/disabled-company-rpcs.test.mts, which locked the pre-#5695 disabled
// state (empty envelopes + source-level forbid list) — the handlers now do real
// work behind verified CIK attribution, so the lock is retired with it.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MATERIAL_8K_ITEMS,
  __resetCikMapMemoForTests,
  __testing__ as secEdgarTesting,
  filingDocumentUrl,
  filingIndexUrl,
  materialItemCodes,
  padCik,
  parseItemCodes,
  sanitizeTicker,
} from '../server/_shared/sec-edgar';
import {
  MATERIAL_ITEM_CODES,
  filterMaterialEvents,
  isSecGovUrl,
  mergeEventWindow,
  parse8kAtomFeed,
} from '../scripts/seed-sec-8k-stream.mjs';
import { MIN_CIK_ENTRIES, slimCikMap } from '../scripts/seed-sec-cik-map.mjs';
import { getCompanyEnrichment } from '../server/worldmonitor/intelligence/v1/get-company-enrichment';
import { listCompanySignals } from '../server/worldmonitor/intelligence/v1/list-company-signals';
import { searchSecFilings } from '../server/worldmonitor/intelligence/v1/search-sec-filings';
import { listMaterialEvents } from '../server/worldmonitor/intelligence/v1/list-material-events';
import { ValidationError } from '../src/generated/server/worldmonitor/intelligence/v1/service_server';

const ctx = { request: new Request('http://localhost/'), pathParams: {}, headers: {} } as never;

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  VERCEL_ENV: process.env.VERCEL_ENV,
  VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
  EXA_API_KEYS: process.env.EXA_API_KEYS,
  BRAVE_API_KEYS: process.env.BRAVE_API_KEYS,
  SERPAPI_API_KEYS: process.env.SERPAPI_API_KEYS,
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetCikMapMemoForTests();
});

beforeEach(() => {
  __resetCikMapMemoForTests();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('sec-edgar pure helpers', () => {
  it('pads CIKs to 10 digits and strips non-digits', () => {
    assert.equal(padCik(320193), '0000320193');
    assert.equal(padCik('320193'), '0000320193');
    assert.equal(padCik('CIK 320193'), '0000320193');
  });

  it('sanitizes tickers to the exchange grammar', () => {
    assert.equal(sanitizeTicker(' aapl '), 'AAPL');
    assert.equal(sanitizeTicker('BRK.B'), 'BRK.B');
    assert.equal(sanitizeTicker('bad ticker'), '');
    assert.equal(sanitizeTicker('<script>'), '');
    assert.equal(sanitizeTicker(''), '');
  });

  it('builds sec.gov archive URLs from CIK + accession', () => {
    assert.equal(
      filingIndexUrl('0000320193', '0000320193-26-000012'),
      'https://www.sec.gov/Archives/edgar/data/320193/000032019326000012/0000320193-26-000012-index.htm',
    );
    assert.equal(
      filingDocumentUrl('0001889450', '0001493152-26-032525', 'form8-k.htm'),
      'https://www.sec.gov/Archives/edgar/data/1889450/000149315226032525/form8-k.htm',
    );
    // EDGAR filenames legitimately carry one XSL subdirectory.
    assert.equal(
      filingDocumentUrl('320193', '0001140361-26-025622', 'xslF345X06/form4.xml'),
      'https://www.sec.gov/Archives/edgar/data/320193/000114036126025622/xslF345X06/form4.xml',
    );
  });

  it('never lets a filing document URL escape its filing directory', () => {
    const escaped = filingDocumentUrl('320193', '0001-26-000001', '../../../../secret.htm');
    assert.equal(escaped, 'https://www.sec.gov/Archives/edgar/data/320193/000126000001/secret.htm');
    assert.doesNotMatch(escaped, /\.\./);
    assert.equal(filingDocumentUrl('320193', '0001-26-000001', '../..'), '');
    assert.equal(filingDocumentUrl('320193', '', 'form8-k.htm'), '');
  });

  it('parses submissions item-code strings', () => {
    assert.deepEqual(parseItemCodes('2.02,9.01'), ['2.02', '9.01']);
    assert.deepEqual(parseItemCodes(' 5.02 '), ['5.02']);
    assert.deepEqual(parseItemCodes('garbage'), []);
    assert.deepEqual(parseItemCodes(undefined), []);
  });

  it('matches names exactly and by unique prefix, refusing ambiguous ones', () => {
    const map = {
      AAPL: { cik: 320193, name: 'Apple Inc.' },
      FMNB: { cik: 709337, name: 'Farmers National Banc Corp' },
      FARM: { cik: 34563, name: 'Farmer Bros Co' },
    };
    const exact = secEdgarTesting.matchByName(map, 'apple inc.', { requireUnique: false, matchedBy: 'name' });
    assert.equal(exact?.cik, '0000320193');
    assert.equal(exact?.matchedBy, 'name');
    // Unique prefix resolves.
    const prefix = secEdgarTesting.matchByName(map, 'apple', { requireUnique: true, matchedBy: 'name' });
    assert.equal(prefix?.ticker, 'AAPL');
    assert.equal(prefix?.matchedBy, 'name');
    // Ambiguous prefix across two distinct filers must NOT resolve — for names
    // Picking the shortest title would be a coin flip between two
    // real companies.
    assert.equal(secEdgarTesting.matchByName(map, 'farm', { requireUnique: true, matchedBy: 'name' }), null);
    // Share classes of one filer are still a single company, so they resolve.
    const shareClasses = {
      GOOGL: { cik: 1652044, name: 'Alphabet Inc.' },
      GOOG: { cik: 1652044, name: 'Alphabet Inc. Class C' },
    };
    assert.equal(
      secEdgarTesting.matchByName(shareClasses, 'alphabet', { requireUnique: true, matchedBy: 'name' })?.cik,
      '0001652044',
    );
  });

});

// ---------------------------------------------------------------------------
// Seeder pure functions
// ---------------------------------------------------------------------------

const ATOM_FIXTURE = `<?xml version="1.0" encoding="ISO-8859-1" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Latest Filings</title>
<entry>
<title>8-K - Huron Consulting Group Inc. (0001289848) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1289848/000162828026049857/0001628280-26-049857-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001628280-26-049857 &lt;b&gt;Size:&lt;/b&gt; 172 KB
&lt;br&gt;Item 5.02: Departure of Directors or Certain Officers; Election of Directors; Appointment of Certain Officers: Compensatory Arrangements of Certain Officers
</summary>
<updated>2026-07-27T17:29:58-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K"/>
</entry>
<entry>
<title>8-K/A - RTB Digital, Inc. (0001419275) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1419275/000118518526003142/0001185185-26-003142-index.htm"/>
<summary type="html">
 &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0001185185-26-003142 &lt;b&gt;Size:&lt;/b&gt; 5 MB
&lt;br&gt;Item 9.01: Financial Statements and Exhibits
</summary>
<updated>2026-07-27T17:30:53-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="8-K/A"/>
</entry>
<entry>
<title>10-Q - Someone Else Corp (0000123456) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/example"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; 2026-07-27 &lt;b&gt;AccNo:&lt;/b&gt; 0000000000-26-000001</summary>
<updated>2026-07-27T17:00:00-04:00</updated>
</entry>
</feed>`;

describe('seed-sec-8k-stream pure functions', () => {
  it('keeps the material set aligned with the server taxonomy', () => {
    assert.deepEqual([...MATERIAL_ITEM_CODES].sort(), materialItemCodes().sort());
  });

  it('parses the getcurrent Atom feed into typed events (8-K forms only)', () => {
    const events = parse8kAtomFeed(ATOM_FIXTURE);
    assert.equal(events.length, 2);
    const [huron, rtb] = events;
    assert.equal(huron.company, 'Huron Consulting Group Inc.');
    assert.equal(huron.cik, '0001289848');
    assert.equal(huron.form, '8-K');
    assert.equal(huron.accession, '0001628280-26-049857');
    assert.equal(huron.items.length, 1);
    assert.equal(huron.items[0].code, '5.02');
    assert.match(huron.items[0].description, /^Departure of Directors/);
    assert.equal(huron.filedAtMs, Date.parse('2026-07-27T17:29:58-04:00'));
    assert.match(huron.url, /^https:\/\/www\.sec\.gov\/Archives/);
    assert.equal(rtb.form, '8-K/A');
  });

  it('stores only sec.gov filing links', () => {
    assert.equal(isSecGovUrl('https://www.sec.gov/Archives/edgar/data/1/2/3-index.htm'), true);
    assert.equal(isSecGovUrl('https://sec.gov/x'), true);
    assert.equal(isSecGovUrl('https://evil.example/x'), false);
    assert.equal(isSecGovUrl('javascript:alert(1)'), false);
    assert.equal(isSecGovUrl('http://www.sec.gov/x'), false);
    assert.equal(isSecGovUrl(''), false);
    // A feed entry carrying a foreign host yields an empty url, never the host.
    const poisoned = ATOM_FIXTURE.replace('https://www.sec.gov/Archives/edgar/data/1289848/000162828026049857/0001628280-26-049857-index.htm', 'https://evil.example/pwn');
    const events = parse8kAtomFeed(poisoned);
    assert.equal(events[0].url, '');
  });

  it('filters routine-only filings out of the material stream', () => {
    const material = filterMaterialEvents(parse8kAtomFeed(ATOM_FIXTURE));
    assert.equal(material.length, 1);
    assert.equal(material[0].items[0].code, '5.02');
  });

  it('merges the rolling window: dedupe by accession, cutoff, newest first', () => {
    const now = Date.parse('2026-07-27T22:00:00Z');
    const day = 24 * 3600 * 1000;
    const old = { company: 'Old', cik: '1', form: '8-K', accession: 'A-old', filedAtMs: now - 8 * day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const kept = { company: 'Kept', cik: '2', form: '8-K', accession: 'A-kept', filedAtMs: now - 2 * day, items: [{ code: '2.01', description: 'x' }], url: '' };
    const updated = { company: 'Updated v1', cik: '3', form: '8-K', accession: 'A-dup', filedAtMs: now - 3 * day, items: [{ code: '4.02', description: 'x' }], url: '' };
    const fresh = { company: 'Updated v2', cik: '3', form: '8-K/A', accession: 'A-dup', filedAtMs: now - day, items: [{ code: '4.02', description: 'x' }], url: '' };
    const merged = mergeEventWindow([old, kept, updated], [fresh], now);
    assert.deepEqual(merged.map((e: { accession: string }) => e.accession), ['A-dup', 'A-kept']);
    assert.equal(merged[0].company, 'Updated v2');
  });

  it('drops far-future events so clock skew cannot pin the top of the stream', () => {
    const now = Date.parse('2026-07-27T22:00:00Z');
    const day = 24 * 3600 * 1000;
    const real = { company: 'Real', cik: '1', form: '8-K', accession: 'A-real', filedAtMs: now - day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const future = { company: 'Skewed', cik: '2', form: '8-K', accession: 'A-future', filedAtMs: now + 5 * day, items: [{ code: '5.02', description: 'x' }], url: '' };
    const merged = mergeEventWindow([future], [real], now);
    assert.deepEqual(merged.map((e: { accession: string }) => e.accession), ['A-real']);
  });
});

describe('seed-sec-cik-map pure functions', () => {
  it('slims the index-keyed registry into a ticker map, first occurrence wins', () => {
    const slim = slimCikMap({
      0: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
      1: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
      2: { cik_str: 999, ticker: 'AAPL', title: 'Impostor Corp' },
      3: { cik_str: 0, ticker: 'BAD', title: 'Zero CIK' },
      4: { cik_str: 5, ticker: '', title: 'No ticker' },
    });
    assert.deepEqual(Object.keys(slim).sort(), ['AAPL', 'NVDA']);
    assert.deepEqual(slim.AAPL, { cik: 320193, name: 'Apple Inc.' });
  });

  it('publishes a sane coverage floor', () => {
    assert.ok(MIN_CIK_ENTRIES >= 5000);
  });
});

// ---------------------------------------------------------------------------
// Handler behaviors (mocked Redis + upstreams)
// ---------------------------------------------------------------------------

function configureRedis() {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  process.env.VERCEL_ENV = 'production';
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  // Force the news-mentions leg down the (mockable) RSS fallback.
  delete process.env.EXA_API_KEYS;
  delete process.env.BRAVE_API_KEYS;
  delete process.env.SERPAPI_API_KEYS;
}

function envelope(data: unknown) {
  // _seed.fetchedAt must be a NUMBER (epoch ms) or unwrapEnvelope treats the
  // value as a legacy non-envelope shape and passes it through wholesale.
  return {
    _seed: { fetchedAt: Date.now(), recordCount: 1, sourceVersion: 't', schemaVersion: 1, state: 'OK' },
    data,
  };
}

function upstashGet(value: unknown) {
  return new Response(JSON.stringify({ result: value === null ? null : JSON.stringify(value) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CIK_MAP_VALUE = envelope({
  tickers: {
    TSTA: { cik: 111222, name: 'Testable Alpha Inc.' },
    TSTB: { cik: 333444, name: 'Testable Beta Corp' },
    TSTC: { cik: 555666, name: 'Zebrafields Corp' },
  },
});

interface MockRoutes {
  submissions?: unknown | 'fail';
  profile?: unknown | 'fail';
  earnings?: unknown | 'fail';
  stream?: unknown;
  efts?: unknown | 'fail';
  // Set null to simulate the ticker registry being unreadable.
  cikMap?: unknown | null;
}

function installFetchMock(routes: MockRoutes) {
  globalThis.fetch = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://redis.example.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.example.test/get/'.length));
      if (key === 'intelligence:sec-cik-map:v1') {
        return upstashGet('cikMap' in routes ? routes.cikMap : CIK_MAP_VALUE);
      }
      if (key === 'intelligence:sec-8k-stream:v1') return upstashGet(routes.stream ?? null);
      return upstashGet(null); // every cachedFetchJson read misses → fetcher runs
    }
    if (url.startsWith('https://redis.example.test/')) {
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }
    if (url.startsWith('https://data.sec.gov/submissions/')) {
      if (routes.submissions === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.submissions ?? null), { status: 200 });
    }
    if (url.startsWith('https://finnhub.io/api/v1/stock/profile2')) {
      if (routes.profile === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.profile ?? {}), { status: 200 });
    }
    if (url.startsWith('https://finnhub.io/api/v1/stock/earnings')) {
      if (routes.earnings === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.earnings ?? []), { status: 200 });
    }
    if (url.startsWith('https://efts.sec.gov/')) {
      if (routes.efts === 'fail') return new Response('nope', { status: 503 });
      return new Response(JSON.stringify(routes.efts ?? {}), { status: 200 });
    }
    // Google News RSS fallback for the news-mentions leg: empty feed.
    if (url.includes('news.google.com')) {
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    }
    return new Response('unexpected fetch: ' + url, { status: 599 });
  }) as typeof fetch;
}

const SUBMISSIONS_FIXTURE = {
  name: 'Testable Alpha Inc.',
  sicDescription: 'Prepackaged Software',
  // SEC publishes this field but leaves it EMPTY in practice — 0 of 15 sampled
  // filers populate it, Apple and NVIDIA included. The fixture mirrors that, so
  // nothing here can depend on a value the real upstream never sends.
  website: '',
  tickers: ['TSTA'],
  exchanges: ['NASDAQ'],
  stateOfIncorporationDescription: 'DE',
  addresses: { business: { city: 'AUSTIN', stateOrCountryDescription: 'TX' } },
  filings: {
    recent: {
      form: ['8-K', '10-Q', '4', '8-K'],
      filingDate: ['2026-07-20', '2026-07-01', '2026-06-20', '2026-06-15'],
      accessionNumber: ['0001-26-000004', '0001-26-000003', '0001-26-000002', '0001-26-000001'],
      primaryDocument: ['a.htm', 'b.htm', 'c.xml', 'd.htm'],
      items: ['2.01,9.01', '', '', '7.01'],
      acceptanceDateTime: ['2026-07-20T12:00:00.000Z', '2026-07-01T12:00:00.000Z', '2026-06-20T12:00:00.000Z', '2026-06-15T12:00:00.000Z'],
    },
  },
};

describe('getCompanyEnrichment', () => {
  it('rejects a request with no company reference', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => getCompanyEnrichment(ctx, { ticker: '', name: '' }),
      ValidationError,
    );
  });

  it('aggregates SEC + Finnhub + earnings into the composite envelope', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: SUBMISSIONS_FIXTURE,
      profile: { name: 'Testable Alpha Inc.', exchange: 'NASDAQ NMS', finnhubIndustry: 'Technology', marketCapitalization: 1234.5, ipo: '2015-05-05', logo: 'https://logo.example/t.png', country: 'US', currency: 'USD', weburl: 'https://www.testable-alpha.example' },
      earnings: [
        { period: '2026-03-31', actual: 2.0, estimate: 1.5, surprise: 0.5, surprisePercent: 33.3, year: 2026, quarter: 1 },
        { period: '2026-06-30', actual: 1.0, estimate: 1.2, surprise: -0.2, surprisePercent: -16.7, year: 2026, quarter: 2 },
      ],
    });

    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.deepEqual(resp.sources, ['sec_edgar', 'finnhub']);
    assert.equal(resp.company?.cik, '0000111222');
    assert.equal(resp.company?.ticker, 'TSTA');
    assert.equal(resp.company?.name, 'Testable Alpha Inc.');
    assert.equal(resp.company?.description, 'Prepackaged Software');
    assert.equal(resp.company?.location, 'AUSTIN, TX');
    // SEC leaves `website` empty, so the reported domain comes from the market
    // profile — the fallback is the normal path, not an edge case.
    assert.equal(resp.company?.website, 'https://www.testable-alpha.example');
    assert.equal(resp.company?.domain, 'testable-alpha.example');
    assert.equal(resp.market?.industry, 'Technology');
    assert.equal(resp.market?.marketCapMusd, 1234.5);
    // Newest earnings first.
    assert.equal(resp.earningsSurprises[0]?.period, '2026-06-30');
    // Ownership form 4 is filtered; the two 8-Ks and the 10-Q survive.
    assert.equal(resp.secFilings?.totalFilings, 4);
    assert.deepEqual(resp.secFilings?.recentFilings.map(f => f.form), ['8-K', '10-Q', '8-K']);
    const materialFiling = resp.secFilings?.recentFilings[0];
    assert.deepEqual(materialFiling?.items, ['2.01', '9.01']);
    assert.match(materialFiling?.description ?? '', /Completion of Acquisition/);
    assert.match(materialFiling?.url ?? '', /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/111222\//);
  });

  it('degrades truthfully when SEC is down: no fabricated filings, no sec_edgar source', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: 'fail',
      profile: { name: 'Testable Beta Corp', exchange: 'NYSE', finnhubIndustry: 'Banking' },
      earnings: [],
    });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTB', name: '' });
    assert.equal(resp.sources.includes('sec_edgar'), false);
    assert.equal(resp.sources.includes('finnhub'), true);
    assert.equal(resp.secFilings, undefined);
    assert.equal(resp.company?.cik, '0000333444');
  });

  it('returns an empty envelope for a company absent from the SEC registry', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await getCompanyEnrichment(ctx, { ticker: 'ZZZZ', name: '' });
    assert.deepEqual(resp.sources, []);
    assert.equal(resp.company?.cik, '');
    assert.equal(resp.secFilings, undefined);
    assert.deepEqual(resp.earningsSurprises, []);
  });

  it('reports a registry outage as unavailable, not as "no such company"', async () => {
    configureRedis();
    installFetchMock({ cikMap: null });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.equal(resp.unavailable, true, 'an unreadable registry must not read as an authoritative miss');
    assert.deepEqual(resp.sources, []);

    __resetCikMapMemoForTests();
    const signals = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(signals.unavailable, true);
  });

  it('shares one registry read across concurrent cold requests', async () => {
    configureRedis();
    let registryReads = 0;
    installFetchMock({});
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('sec-cik-map')) registryReads += 1;
      return inner(input, init);
    }) as typeof fetch;

    await Promise.all([
      getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' }),
      getCompanyEnrichment(ctx, { ticker: 'TSTB', name: '' }),
      getCompanyEnrichment(ctx, { ticker: 'TSTC', name: '' }),
    ]);
    assert.equal(registryReads, 1, 'three concurrent cold requests must not each pull the ~650KB registry');
  });

  it('marks a genuine miss as available so it stays cacheable', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await getCompanyEnrichment(ctx, { ticker: 'ZZZZ', name: '' });
    assert.equal(resp.unavailable, false, 'a real "not in the registry" answer is cacheable');
  });

  it('keeps relevant filings for a filer whose recent window is mostly ownership forms', async () => {
    configureRedis();
    // 250 Form 4s ahead of the only 10-K: a chronological cap would drop it.
    const noise = Array.from({ length: 250 }, (_, i) => i);
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: [...noise.map(() => '4'), '10-K'],
            filingDate: [...noise.map(() => '2026-07-01'), '2026-06-01'],
            accessionNumber: [...noise.map((i) => `0001-26-0000${i}`), '0001-26-999999'],
            primaryDocument: [...noise.map(() => 'f4.xml'), 'tenk.htm'],
            items: [...noise.map(() => ''), ''],
            acceptanceDateTime: [...noise.map(() => '2026-07-01T12:00:00.000Z'), '2026-06-01T12:00:00.000Z'],
          },
        },
      },
    });
    const resp = await getCompanyEnrichment(ctx, { ticker: 'TSTA', name: '' });
    assert.deepEqual(resp.secFilings?.recentFilings.map(f => f.form), ['10-K']);
    assert.equal(resp.secFilings?.totalFilings, 251, 'the reported total still counts every filing');
  });

  it('refuses an ambiguous company name instead of picking one (#3754/#3755)', async () => {
    configureRedis();
    installFetchMock({ submissions: SUBMISSIONS_FIXTURE });
    // "Testable" prefix-matches two distinct filers — neither may be returned.
    const resp = await getCompanyEnrichment(ctx, { ticker: '', name: 'Testable' });
    assert.deepEqual(resp.sources, []);
    assert.equal(resp.company?.cik, '');
  });





});

describe('listCompanySignals', () => {
  it('rejects a request with no company reference', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => listCompanySignals(ctx, { ticker: '', company: '' }),
      ValidationError,
    );
  });

  it('classifies 8-K material events and earnings surprises with summary math', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    const recentIso = new Date(Date.now() - 5 * 24 * 3600 * 1000).toISOString();
    const recentDate = recentIso.slice(0, 10);
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K', '8-K'],
            filingDate: [recentDate, recentDate],
            accessionNumber: ['0001-26-000010', '0001-26-000011'],
            primaryDocument: ['a.htm', 'b.htm'],
            // One high-materiality restatement; one routine-only Reg FD (must not signal).
            items: ['4.02,9.01', '7.01'],
            acceptanceDateTime: [recentIso, recentIso],
          },
        },
      },
      earnings: [
        { period: recentDate, actual: 2.0, estimate: 1.5, surprise: 0.5, surprisePercent: 33.3, year: 2026, quarter: 2 },
      ],
    });

    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(resp.company, 'Testable Alpha Inc.');
    const types = resp.signals.map(signal => signal.type).sort();
    assert.deepEqual(types, ['Earnings Beat', 'Restatement']);

    const restatement = resp.signals.find(signal => signal.type === 'Restatement');
    assert.equal(restatement?.source, 'sec_edgar');
    assert.equal(restatement?.sourceTier, 1);
    assert.equal(restatement?.strength, 'Strong');
    assert.match(restatement?.title ?? '', /Non-Reliance/);
    assert.match(restatement?.url ?? '', /^https:\/\/www\.sec\.gov\//);

    const beat = resp.signals.find(signal => signal.type === 'Earnings Beat');
    assert.equal(beat?.sourceTier, 2);
    assert.equal(beat?.strength, 'Strong');

    assert.equal(resp.summary?.totalSignals, 2);
    assert.deepEqual(resp.summary?.byType, { 'Earnings Beat': 1, Restatement: 1 });
    assert.equal(resp.summary?.strongestSignal?.type, 'Restatement', 'tier 1 wins the strength tie');
    assert.equal(resp.summary?.signalDiversity, 2);
  });

  it('headlines a multi-item 8-K by its most material item, not the lowest code', async () => {
    configureRedis();
    const recentIso = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K'],
            filingDate: [recentIso.slice(0, 10)],
            accessionNumber: ['0001-26-000020'],
            primaryDocument: ['a.htm'],
            // 2.02 (medium, earnings exhibit) sorts first; 5.02 is the news.
            items: ['2.02,5.02'],
            acceptanceDateTime: [recentIso],
          },
        },
      },
      earnings: [],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.equal(resp.signals[0]?.type, 'Executive Change');
    assert.equal(resp.signals[0]?.strength, 'Strong');
  });

  it('drops unreported earnings periods instead of rendering them as a beat', async () => {
    configureRedis();
    process.env.FINNHUB_API_KEY = 'test-finnhub';
    installFetchMock({
      submissions: { ...SUBMISSIONS_FIXTURE, filings: { recent: { form: [], filingDate: [], accessionNumber: [], primaryDocument: [], items: [], acceptanceDateTime: [] } } },
      earnings: [
        // Not yet reported: Finnhub sends nulls. Coercing to 0 would publish a
        // "0.00 vs 1.50 est" Earnings Beat for a quarter nobody has reported.
        { period: '2026-12-31', actual: null, estimate: 1.5, surprise: null, surprisePercent: null, year: 2026, quarter: 4 },
      ],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.deepEqual(resp.signals.filter(s => s.type.startsWith('Earnings')), []);
  });

  it('returns a zeroed summary for a company absent from the SEC registry', async () => {
    configureRedis();
    installFetchMock({});
    const resp = await listCompanySignals(ctx, { ticker: '', company: 'No Such Company Anywhere' });
    assert.deepEqual(resp.signals, []);
    assert.equal(resp.summary?.totalSignals, 0);
    assert.equal(resp.summary?.signalDiversity, 0);
    assert.equal(resp.cik, '', 'an empty CIK marks an unresolved company');
  });

  it('distinguishes a resolved-but-quiet company from an unresolved one via cik', async () => {
    configureRedis();
    // Resolves, but every filing is older than the 90-day signal window and
    // there are no earnings or news — zero signals with a real CIK.
    installFetchMock({
      submissions: {
        ...SUBMISSIONS_FIXTURE,
        filings: {
          recent: {
            form: ['8-K'],
            filingDate: ['2020-01-02'],
            accessionNumber: ['0001-20-000001'],
            primaryDocument: ['a.htm'],
            items: ['4.02'],
            acceptanceDateTime: ['2020-01-02T12:00:00.000Z'],
          },
        },
      },
      earnings: [],
    });
    const resp = await listCompanySignals(ctx, { ticker: 'TSTA', company: '' });
    assert.deepEqual(resp.signals, []);
    assert.equal(resp.summary?.totalSignals, 0);
    assert.equal(resp.cik, '0000111222', 'a resolved company keeps its CIK even with zero signals');
  });
});

describe('searchSecFilings', () => {
  it('rejects an empty query', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => searchSecFilings(ctx, { query: ' ', forms: '', startDate: '', endDate: '', limit: 0 }),
      ValidationError,
    );
  });

  it('maps EDGAR full-text hits and honors the limit', async () => {
    configureRedis();
    installFetchMock({
      efts: {
        hits: {
          total: { value: 42 },
          hits: [
            {
              _id: '0001493152-26-032525:form8-k.htm',
              _source: {
                ciks: ['0001889450'],
                display_names: ['FutureTech II Acquisition Corp.  (CIK 0001889450)'],
                form: '8-K',
                file_date: '2026-07-08',
                items: ['4.02'],
                adsh: '0001493152-26-032525',
              },
            },
            { _id: 'x:y.htm', _source: { ciks: ['1'], display_names: ['B'], form: '10-K', file_date: '2026-07-01', adsh: 'x' } },
          ],
        },
      },
    });
    const resp = await searchSecFilings(ctx, { query: 'material weakness', forms: '8-K', startDate: '2026-07-01', endDate: '2026-07-28', limit: 1 });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.total, 42);
    assert.equal(resp.results.length, 1);
    const [first] = resp.results;
    assert.equal(first.cik, '0001889450');
    assert.deepEqual(first.items, ['4.02']);
    assert.equal(first.url, 'https://www.sec.gov/Archives/edgar/data/1889450/000149315226032525/form8-k.htm');
  });

  it('rejects malformed filters instead of silently widening the search', async () => {
    configureRedis();
    installFetchMock({});
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '', startDate: 'last-tuesday', endDate: '', limit: 0 }),
      ValidationError,
    );
    await assert.rejects(
      () => searchSecFilings(ctx, { query: 'merger', forms: '8-K"; DROP', startDate: '', endDate: '', limit: 0 }),
      ValidationError,
    );
  });

  it('reports unavailable when EDGAR search is down', async () => {
    configureRedis();
    installFetchMock({ efts: 'fail' });
    const resp = await searchSecFilings(ctx, { query: 'no-cache-here-' + Math.random(), forms: '', startDate: '', endDate: '', limit: 0 });
    assert.equal(resp.unavailable, true);
    assert.deepEqual(resp.results, []);
  });
});

describe('get_company_intelligence MCP tool view dispatch', () => {
  const toolContext = { kind: 'env_key', apiKey: 'wm-test-key' } as never;

  async function getTool() {
    const { TOOL_REGISTRY } = await import('../api/mcp/registry/index');
    const tool = TOOL_REGISTRY.find(entry => entry.name === 'get_company_intelligence');
    assert.ok(tool && '_execute' in tool && tool._execute, 'tool must exist with _execute');
    return tool as { _execute: (params: Record<string, unknown>, base: string, context: unknown) => Promise<Record<string, unknown>> };
  }

  function captureFetch(payload: unknown) {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return urls;
  }

  it('requires ticker or name for enrichment and signals views', async () => {
    const tool = await getTool();
    captureFetch({});
    assert.deepEqual(await tool._execute({}, 'https://x.test', toolContext), { view: 'enrichment', error: 'ticker_or_name_required' });
    assert.deepEqual(await tool._execute({ view: 'signals' }, 'https://x.test', toolContext), { view: 'signals', error: 'ticker_or_name_required' });
  });

  it('requires query for filings-search', async () => {
    const tool = await getTool();
    captureFetch({});
    assert.deepEqual(
      await tool._execute({ view: 'filings-search', query: '  ' }, 'https://x.test', toolContext),
      { view: 'filings-search', error: 'query_required' },
    );
  });

  it('falls back to the enrichment view for unknown view values', async () => {
    const tool = await getTool();
    const urls = captureFetch({ company: {} });
    const result = await tool._execute({ view: 'bogus', ticker: 'AAPL' }, 'https://x.test', toolContext);
    assert.equal(result.view, 'enrichment');
    assert.match(urls[0] ?? '', /\/api\/intelligence\/v1\/get-company-enrichment\?ticker=AAPL/);
  });

  it('routes each view to its REST path and honors in-range limits', async () => {
    const tool = await getTool();
    const urls = captureFetch({ results: [], events: [], signals: [] });
    await tool._execute({ view: 'signals', ticker: 'AAPL' }, 'https://x.test', toolContext);
    await tool._execute({ view: 'filings-search', query: 'merger', limit: 25 }, 'https://x.test', toolContext);
    await tool._execute({ view: 'material-events', item_code: '5.02', limit: 100 }, 'https://x.test', toolContext);
    assert.match(urls[0] ?? '', /\/api\/intelligence\/v1\/list-company-signals\?ticker=AAPL/);
    assert.match(urls[1] ?? '', /\/api\/intelligence\/v1\/search-sec-filings\?.*limit=25/);
    assert.match(urls[2] ?? '', /\/api\/intelligence\/v1\/list-material-events\?.*limit=100/);
    assert.match(urls[2] ?? '', /item_code=5\.02/);
  });

  it('rejects a limit above the view maximum instead of silently clamping it', async () => {
    const tool = await getTool();
    const urls = captureFetch({ results: [] });
    // 100 is valid for material-events but not for filings-search; clamping to
    // 25 would read to the caller as "only 25 filings matched".
    assert.deepEqual(
      await tool._execute({ view: 'filings-search', query: 'merger', limit: 100 }, 'https://x.test', toolContext),
      { view: 'filings-search', error: 'limit_out_of_range' },
    );
    assert.deepEqual(
      await tool._execute({ view: 'material-events', limit: 101 }, 'https://x.test', toolContext),
      { view: 'material-events', error: 'limit_out_of_range' },
    );
    assert.deepEqual(urls, [], 'a rejected limit must not reach the REST route');
  });
});

describe('listMaterialEvents', () => {
  const STREAM_VALUE = envelope({
    events: [
      { company: 'A', cik: '1', form: '8-K', accession: 'acc-1', filedAtMs: 1785187798000, items: [{ code: '5.02', description: 'Officers' }], url: 'https://www.sec.gov/1' },
      { company: 'B', cik: '2', form: '8-K', accession: 'acc-2', filedAtMs: 1785187700000, items: [{ code: '2.01', description: 'Acquisition' }], url: 'https://www.sec.gov/2' },
    ],
    fetchedAt: '2026-07-27T22:43:29.498Z',
  });

  it('serves the seeded stream with freshness metadata', async () => {
    configureRedis();
    installFetchMock({ stream: STREAM_VALUE });
    const resp = await listMaterialEvents(ctx, { itemCode: '', limit: 0 });
    assert.equal(resp.unavailable, false);
    assert.equal(resp.events.length, 2);
    assert.equal(resp.fetchedAtMs, Date.parse('2026-07-27T22:43:29.498Z'));
  });

  it('filters by item code', async () => {
    configureRedis();
    installFetchMock({ stream: STREAM_VALUE });
    const resp = await listMaterialEvents(ctx, { itemCode: '2.01', limit: 0 });
    assert.deepEqual(resp.events.map(event => event.accession), ['acc-2']);
  });

  it('rejects a malformed item code instead of returning the whole stream', async () => {
    configureRedis();
    installFetchMock({ stream: STREAM_VALUE });
    await assert.rejects(
      () => listMaterialEvents(ctx, { itemCode: 'executive changes', limit: 0 }),
      ValidationError,
    );
  });

  it('reports unavailable when the seed is missing', async () => {
    configureRedis();
    installFetchMock({ stream: null });
    const resp = await listMaterialEvents(ctx, { itemCode: '', limit: 0 });
    assert.equal(resp.unavailable, true);
    assert.deepEqual(resp.events, []);
  });
});
