import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { resolveTechEventsPaging } from '../server/worldmonitor/research/v1/_tech-events-paging.ts';
import {
  fetchWidestTechEvents,
  WIDEST_TECH_EVENTS_REQUEST,
} from '../server/worldmonitor/research/v1/list-tech-events.ts';

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
