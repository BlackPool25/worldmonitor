import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { resolveTechEventsPaging } from '../server/worldmonitor/research/v1/_tech-events-paging.ts';
import {
  fetchWidestTechEvents,
  listTechEvents,
  WIDEST_TECH_EVENTS_REQUEST,
} from '../server/worldmonitor/research/v1/list-tech-events.ts';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis.ts';

// #5427: the cold-start fallback fetcher writes to the SHARED, request-
// independent `research:tech-events:v1` key (the same one the relay seeder
// fills with the full list). Whatever it caches is what every client sees for
// the 6h TTL, so the request it fetches with must be the widest the params
// allow — narrowing belongs exclusively to filterEvents() on the read path.
describe('cold-start fallback caches the widest tech-events payload (#5427)', () => {
  it('applies no type or mappable narrowing', () => {
    assert.equal(WIDEST_TECH_EVENTS_REQUEST.type, 'all');
    assert.equal(WIDEST_TECH_EVENTS_REQUEST.mappable, false);
  });

  it('resolves to the documented clamp maxima for limit and days', () => {
    assert.deepEqual(
      resolveTechEventsPaging(WIDEST_TECH_EVENTS_REQUEST, { hasLimit: true, hasDays: true }),
      { limit: 200, days: 365 },
    );
  });

  it('cannot resolve narrower than a maxed-out explicit request', () => {
    const maxedExplicit = resolveTechEventsPaging({ limit: 999, days: 999 });
    assert.deepEqual(
      resolveTechEventsPaging(WIDEST_TECH_EVENTS_REQUEST, { hasLimit: true, hasDays: true }),
      maxedExplicit,
    );
  });
});

// Greptile P2 on #5603: the assertions above validate the exported constant and
// the paging resolver, but nothing proved `listTechEvents` actually hands that
// request to the cache-miss fetcher — a wiring regression could restore
// caller-specific shared-cache population with this suite still green. That is
// the exact false-pass shape #5380 is about.
//
// Two things close it. Structurally, `fetchWidestTechEvents` takes NO
// parameters, so threading caller state back in is a type error rather than a
// silent behaviour change. Executably, the test below runs the very function
// the handler passes to `cachedFetchJson` and asserts the payload it produces
// is unnarrowed.
describe('fetchWidestTechEvents produces an unnarrowed payload (#5603 review)', () => {
  const ICS = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Regression Test Conference 2026',
    'LOCATION:Lisbon, Portugal',
    'DTSTART;VALUE=DATE:20260815',
    'DTEND;VALUE=DATE:20260816',
    'URL:https://example.invalid/conf',
    'UID:widest-test-conference',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'SUMMARY:Earnings: ExampleCorp Q3 2026',
    'DTSTART;VALUE=DATE:20260901',
    'DTEND;VALUE=DATE:20260901',
    'URL:https://example.invalid/earnings',
    'UID:widest-test-earnings',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');

  const originalFetch = globalThis.fetch;

  before(() => {
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes('techmeme.com')) return new Response(ICS, { status: 200 });
      // dev.events RSS (and any relay attempt) contributes nothing here.
      return new Response('', { status: 404 });
    }) as typeof globalThis.fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('keeps event types a caller-scoped fetch would have dropped', async () => {
    const result = await fetchWidestTechEvents();
    assert.ok(result, 'expected a payload from the cold-start fetcher');

    const types = new Set(result.events.map((e) => e.type));
    // A fallback that forwarded a `type: 'conference'` caller request would
    // have cached conferences only, so the earnings row is the discriminator.
    assert.ok(types.has('earnings'), `earnings event was filtered out: ${[...types].join(', ')}`);
    assert.ok(types.has('conference'), `conference event missing: ${[...types].join(', ')}`);
  });

  it('does not apply a caller limit — more than one event survives', async () => {
    const result = await fetchWidestTechEvents();
    assert.ok(result);
    // A forwarded `limit: 1` would leave exactly one event in the shared key.
    assert.ok(result.events.length > 1, `expected the unnarrowed set, got ${result.events.length}`);
  });

  it('takes no arguments, so caller state cannot be threaded back in', () => {
    assert.equal(fetchWidestTechEvents.length, 0);
  });
});

// The suite above tests `fetchWidestTechEvents` in isolation, which proves the
// extracted fetcher is unnarrowed but NOT that `listTechEvents` still uses it.
// Reintroducing #5427 does not require threading state into that function —
// it only requires ignoring it and inlining a `req`-scoped closure at the
// `cachedFetchJson` call site, which is neither a type error nor observable
// from any assertion above. Verified by execution: with the call site reverted
// that way, all six cases above stay green and `typecheck:api` stays clean.
//
// This suite closes that last gap by driving the handler end-to-end against a
// fake Upstash and asserting on the payload that actually reaches the shared
// `research:tech-events:v1` key — mirroring the captured-SET pattern in
// tests/aviation-cache-poison.test.mts.
describe('listTechEvents cold-start write is not narrowed by the warming request (#5427)', () => {
  const ENV_KEYS = [
    'LOCAL_API_MODE',
    'RELAY_SHARED_SECRET',
    'UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'VERCEL_ENV',
    'VERCEL_GIT_COMMIT_SHA',
    'WS_RELAY_URL',
  ] as const;

  const ICS_URL = 'https://www.techmeme.com/newsy_events.ics';
  const DEV_EVENTS_RSS = 'https://dev.events/rss.xml';
  const REDIS_CACHE_KEY = 'research:tech-events:v1';

  const savedEnv = new Map<string, string | undefined>();
  const realFetch = globalThis.fetch;

  type RedisSetCommand = ['SET', string, string, 'EX', string];

  /** `days` offset from today as an ICS `YYYYMMDD` stamp, so the fixture never time-bombs. */
  function icsDate(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  }

  function vevent(uid: string, summary: string, daysFromNow: number, location?: string): string {
    return [
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `SUMMARY:${summary}`,
      ...(location ? [`LOCATION:${location}`] : []),
      `DTSTART;VALUE=DATE:${icsDate(daysFromNow)}`,
      `DTEND;VALUE=DATE:${icsDate(daysFromNow + 1)}`,
      `URL:https://example.invalid/${uid}`,
      'END:VEVENT',
    ].join('\n');
  }

  // Four events chosen so each narrowing axis the warming request carries
  // (type, days, limit) would drop a DIFFERENT one of them from the cache.
  const FIXTURE_ICS = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//worldmonitor//tech-events-fixture//EN',
    vevent('wm-conf-day1', 'WM Fixture Conference Day One', 1, 'Paris, France'),
    vevent('wm-conf-day2', 'WM Fixture Conference Day Two', 2, 'Berlin, Germany'),
    vevent('wm-earnings-day3', 'Earnings: WM Fixture Corp', 3),
    vevent('wm-conf-day200', 'WM Fixture Conference Far Future', 200, 'Tokyo, Japan'),
    'END:VCALENDAR',
  ].join('\n');

  // Valid but item-free, and over the 100-char floor fetchTextWithRelay() uses
  // to reject a truncated body.
  const FIXTURE_RSS = `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>WM fixture feed</title>
<link>https://dev.events</link>
<description>No items; the ICS leg carries this fixture.</description>
</channel></rss>`;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv.set(key, process.env[key]);
      delete process.env[key];
    }
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
    __resetKeyPrefixCacheForTests();
  });

  afterEach(() => {
    mock.restoreAll();
    globalThis.fetch = realFetch;
    for (const key of ENV_KEYS) {
      const value = savedEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    __resetKeyPrefixCacheForTests();
  });

  /** Cold Redis (every GET misses) + both upstream feeds served from fixtures. */
  function installFetchMock() {
    const redisSets: RedisSetCommand[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://redis.test/get/')) {
        return new Response(JSON.stringify({ result: null }), { status: 200 });
      }
      if (url === 'https://redis.test/') {
        redisSets.push(JSON.parse(String(init?.body ?? '[]')) as RedisSetCommand);
        return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
      }
      if (url === ICS_URL) return new Response(FIXTURE_ICS, { status: 200 });
      if (url === DEV_EVENTS_RSS) return new Response(FIXTURE_RSS, { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    return redisSets;
  }

  function cachedPayload(redisSets: RedisSetCommand[]): { events: { id: string; type: string }[] } {
    const write = redisSets.find(([, key]) => key === REDIS_CACHE_KEY);
    assert.ok(write, `expected a Redis SET for ${REDIS_CACHE_KEY}, saw keys: ${JSON.stringify(redisSets.map(([, k]) => k))}`);
    return JSON.parse(write[2]) as { events: { id: string; type: string }[] };
  }

  function ctxFor(path: string) {
    return { request: new Request(`https://worldmonitor.app${path}`), pathParams: {}, headers: {} } as never;
  }

  // The warming caller narrows on all three axes at once.
  const NARROW_PATH = '/api/research/v1/list-tech-events?type=conference&limit=1&days=5';
  const NARROW_REQ = { type: 'conference', mappable: false, limit: 1, days: 5 };

  it('caches event types the warming request filtered out', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const ids = cachedPayload(redisSets).events.map(e => e.id);
    assert.ok(
      ids.includes('wm-earnings-day3'),
      `?type=conference must not narrow the shared cache, but the earnings event is absent: ${JSON.stringify(ids)}`,
    );
  });

  it('caches events beyond the warming request day window', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const ids = cachedPayload(redisSets).events.map(e => e.id);
    assert.ok(
      ids.includes('wm-conf-day200'),
      `?days=5 must not narrow the shared cache, but the far-future event is absent: ${JSON.stringify(ids)}`,
    );
  });

  it('caches more events than the warming request limit', async () => {
    const redisSets = installFetchMock();
    await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    const events = cachedPayload(redisSets).events;
    assert.ok(
      events.length >= 4,
      `?limit=1 must not truncate the shared cache, but only ${events.length} event(s) were written`,
    );
  });

  it('still narrows the warming request own response via filterEvents', async () => {
    const redisSets = installFetchMock();
    const response = await listTechEvents(ctxFor(NARROW_PATH), NARROW_REQ);

    // Widening what gets CACHED must not widen what the caller SEES.
    assert.equal(response.count, 1);
    assert.equal(response.events.length, 1);
    assert.equal(response.events[0]?.id, 'wm-conf-day1');
    assert.equal(response.conferenceCount, 1);
    // ...and the cache still holds the unnarrowed set behind that response.
    assert.ok(cachedPayload(redisSets).events.length >= 4);
  });
});
