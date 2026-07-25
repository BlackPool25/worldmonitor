import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveTechEventsPaging } from '../server/worldmonitor/research/v1/_tech-events-paging.ts';
import { WIDEST_TECH_EVENTS_REQUEST } from '../server/worldmonitor/research/v1/list-tech-events.ts';

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
