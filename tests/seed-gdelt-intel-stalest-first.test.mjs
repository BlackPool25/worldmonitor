// Regression test for issue #5848 (mitigation 1 of #5843).
//
// `seed-gdelt-intel` fetched its six topics in fixed INTEL_TOPICS order and
// opens a run-wide circuit on the first failure. Under GDELT's sustained
// supply-side load shedding (#5843) most runs fail on the very first request —
// but the rare run where one DOC request slips through ALWAYS awarded that
// success to `military`, because `military` is always attempted first. Topics
// 2..N only refresh when MULTIPLE CONSECUTIVE requests succeed, which
// essentially never happens during the brownout.
//
// Production evidence, 2026-07-30, per-topic `fetchedAt` inside
// `intelligence:gdelt-intel:v1`: military 5.1h old; cyber 18 days;
// nuclear/sanctions/intelligence/maritime ~29 days. One topic monopolized every
// lottery win while five starved indefinitely.
//
// The fix orders the article loop stalest-first from the previous snapshot's
// per-topic `fetchedAt`, so the scarce success always lands on the topic that
// needs it most and the ordering self-balances as topics refresh.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAllTopics } from '../scripts/seed-gdelt-intel.mjs';

const TOPIC_IDS = ['military', 'cyber', 'nuclear', 'sanctions', 'intelligence', 'maritime'];

// Per-topic `fetchedAt` as observed in production on 2026-07-30 (issue #5848).
const PRODUCTION_STALENESS = {
  military: '2026-07-30T03:00:00.000Z',
  cyber: '2026-07-12T00:00:00.000Z',
  nuclear: '2026-07-01T00:00:00.000Z',
  sanctions: '2026-07-01T00:00:00.000Z',
  intelligence: '2026-07-01T00:00:00.000Z',
  maritime: '2026-07-01T00:00:00.000Z',
};

function snapshotOf(fetchedAtById) {
  return {
    topics: Object.entries(fetchedAtById).map(([id, fetchedAt]) => ({
      id,
      articles: [{ title: `cached ${id}`, url: `https://example.test/cached/${id}` }],
      fetchedAt,
    })),
  };
}

// Mirror `publishTransform`: the snapshot a run leaves in Redis (and therefore
// the one the NEXT run reads) carries only the public per-topic fields.
function asPublishedSnapshot(topics) {
  return {
    topics: topics.map(({
      _tone: _t,
      _vol: _v,
      failureCode: _failureCode,
      budgetExceeded: _budgetExceeded,
      ...rest
    }) => rest),
  };
}

// One healthy 4h run: every article request succeeds, so the full attempt order
// is observable.
async function runHealthy(previous, overrides = {}) {
  const attempted = [];
  let snapshotReads = 0;
  const out = await fetchAllTopics({
    _now: () => 0,
    _softBudgetMs: 60_000,
    _sleep: async () => {},
    _loadPrevious: async () => { snapshotReads += 1; return previous; },
    _fetchArticles: async (topic) => {
      attempted.push(topic.id);
      return {
        id: topic.id,
        articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
        fetchedAt: 'NOW',
      };
    },
    _fetchTimeline: async () => ({ points: [{ date: '2026-07-29', value: 1 }], errorCode: null }),
    ...overrides,
  });
  return { attempted, snapshotReads, out };
}

// One 4h run under the brownout: exactly the FIRST attempted DOC request
// succeeds and every later one 429s (which opens the run circuit). Returns the
// snapshot this run would publish so successive runs can be chained the way
// production does.
async function runUnderBrownout(previous, runIso) {
  const attempted = [];
  let snapshotReads = 0;
  let successAwarded = false;
  const out = await fetchAllTopics({
    _now: () => 0,
    _softBudgetMs: 60_000,
    _sleep: async () => {},
    _loadPrevious: async () => { snapshotReads += 1; return previous; },
    _fetchArticles: async (topic) => {
      attempted.push(topic.id);
      if (successAwarded) {
        return {
          id: topic.id,
          articles: [],
          fetchedAt: runIso,
          failureCode: 'GDELT_SHARED_PROXY_HTTP_429',
        };
      }
      successAwarded = true;
      return {
        id: topic.id,
        articles: [{ title: `fresh ${topic.id}`, url: `https://example.test/live/${topic.id}` }],
        fetchedAt: runIso,
      };
    },
    _fetchTimeline: async () => ({ points: [], errorCode: null }),
  });
  return {
    attempted,
    snapshotReads,
    refreshed: attempted[0],
    published: asPublishedSnapshot(out.topics),
    out,
  };
}

describe('seed-gdelt-intel stalest-first article order (issue #5848)', () => {
  it('spreads the scarce DOC success across all six topics instead of always refreshing military', async () => {
    let previous = snapshotOf(PRODUCTION_STALENESS);
    const refreshedPerRun = [];

    // Six consecutive 4h ticks, each landing exactly one DOC success, each
    // reading the snapshot the previous tick published.
    for (let run = 0; run < TOPIC_IDS.length; run++) {
      const outcome = await runUnderBrownout(previous, `2026-08-0${run + 1}T00:00:00.000Z`);
      refreshedPerRun.push(outcome.refreshed);
      previous = outcome.published;
    }

    // With the pre-fix fixed order this is six copies of 'military': it is
    // always attempted first, so it monopolizes every lottery win.
    assert.deepEqual(
      refreshedPerRun,
      ['nuclear', 'sanctions', 'intelligence', 'maritime', 'cyber', 'military'],
      'each run must award its one success to whichever topic is stalest at that moment',
    );
    assert.equal(
      new Set(refreshedPerRun).size,
      TOPIC_IDS.length,
      'six single-success runs must refresh six DISTINCT topics',
    );
  });

  it('a starved topic keeps its old fetchedAt through the merge, so it stays queued for the next run', async () => {
    const outcome = await runUnderBrownout(snapshotOf(PRODUCTION_STALENESS), '2026-08-01T00:00:00.000Z');

    assert.deepEqual(
      outcome.attempted,
      ['nuclear', 'sanctions'],
      'the stalest topic is attempted first; the next 429 opens the run circuit',
    );
    const byId = new Map(outcome.published.topics.map((t) => [t.id, t]));
    assert.equal(byId.get('nuclear').fetchedAt, '2026-08-01T00:00:00.000Z', 'the winner is stamped fresh');
    for (const id of ['military', 'cyber', 'sanctions', 'intelligence', 'maritime']) {
      assert.equal(
        byId.get(id).fetchedAt,
        PRODUCTION_STALENESS[id],
        `${id} must coast on its previous fetchedAt so staleness ordering keeps advancing`,
      );
    }
  });

  it('attempts topics stalest-first, breaking equal-staleness ties on canonical order', async () => {
    const { attempted } = await runHealthy(snapshotOf(PRODUCTION_STALENESS));

    assert.deepEqual(attempted, ['nuclear', 'sanctions', 'intelligence', 'maritime', 'cyber', 'military']);
  });

  it('a topic missing from the previous snapshot sorts first', async () => {
    const { maritime: _dropped, ...withoutMaritime } = PRODUCTION_STALENESS;
    const { attempted } = await runHealthy(snapshotOf(withoutMaritime));

    assert.equal(attempted[0], 'maritime', 'a never-seeded topic is maximally stale');
  });

  it('a topic with an unparseable fetchedAt sorts first', async () => {
    const { attempted } = await runHealthy(snapshotOf({
      ...PRODUCTION_STALENESS,
      cyber: 'not-a-timestamp',
    }));

    assert.equal(attempted[0], 'cyber', 'an unreadable stamp must be treated as oldest, not newest');
  });

  it('a topic whose previous entry carries no articles sorts first', async () => {
    // The cache-merge only coasts `fetchedAt` for entries that HAVE articles, so
    // a topic that 429'd with nothing to back-fill from keeps the placeholder
    // stamp of the run that skipped it. Ranking that as "freshly fetched" is the
    // cold-start form of the #5848 monopoly: the one topic holding real articles
    // has the oldest honest stamp and wins every lottery forever.
    const snapshot = snapshotOf(PRODUCTION_STALENESS);
    for (const topic of snapshot.topics) {
      if (topic.id !== 'military') {
        topic.articles = [];
        topic.fetchedAt = '2026-07-30T04:00:00.000Z'; // stamped AFTER military's fetch
      }
    }

    const { attempted } = await runHealthy(snapshot);

    assert.equal(attempted[0], 'cyber', 'a topic with no data needs the scarce success most');
    assert.equal(
      attempted[attempted.length - 1],
      'military',
      'the only topic actually holding articles must not be attempted first',
    );
  });

  it('a cold start walks a different topic to the front on each successive run', async () => {
    // Start with no snapshot at all, then five brownout runs that each land one
    // success. Between runs, stamp every still-articleless topic with a
    // FAR-FUTURE `fetchedAt` — the adversarial form of the placeholder the merge
    // really leaves behind. Ordering that trusts those stamps would rank the one
    // topic holding real articles as the stalest and re-award it the slot every
    // run; ordering that requires evidence of articles keeps walking forward.
    const poisonArticlelessStamps = (snapshot) => ({
      topics: snapshot.topics.map((topic) => (
        topic.articles.length === 0
          ? { ...topic, fetchedAt: '2099-01-01T00:00:00.000Z' }
          : topic
      )),
    });

    let previous = null;
    const refreshedPerRun = [];
    for (let run = 0; run < 5; run++) {
      const outcome = await runUnderBrownout(previous, `2026-08-0${run + 1}T00:00:00.000Z`);
      refreshedPerRun.push(outcome.refreshed);
      previous = poisonArticlelessStamps(outcome.published);
    }

    assert.equal(
      new Set(refreshedPerRun).size,
      5,
      `a cold start must not re-award the slot to the same topic; got ${JSON.stringify(refreshedPerRun)}`,
    );
  });

  it('falls back to canonical order when there is no previous snapshot at all', async () => {
    const { attempted } = await runHealthy(null);

    assert.deepEqual(attempted, TOPIC_IDS, 'a cold start has no staleness signal to sort on');
  });

  it('publishes in canonical INTEL_TOPICS order regardless of fetch order', async () => {
    const { attempted, out } = await runHealthy(snapshotOf(PRODUCTION_STALENESS));

    assert.notDeepEqual(attempted, TOPIC_IDS, 'this run must genuinely fetch out of canonical order');
    assert.deepEqual(
      out.topics.map((t) => t.id),
      TOPIC_IDS,
      'consumers depend on canonical publish order, not fetch order',
    );
  });

  it('reads the previous snapshot exactly once per run on both the healthy and degraded paths', async () => {
    const healthy = await runHealthy(snapshotOf(PRODUCTION_STALENESS));
    assert.equal(healthy.snapshotReads, 1, 'ordering must not add a second Redis GET on a clean sweep');

    const degraded = await runUnderBrownout(snapshotOf(PRODUCTION_STALENESS), '2026-08-01T00:00:00.000Z');
    assert.equal(degraded.snapshotReads, 1, 'the ordering read must be reused by the cache-merge backfill');
  });

  it('still opens the run circuit on the first article failure, just on the stalest topic', async () => {
    const outcome = await runUnderBrownout(snapshotOf(PRODUCTION_STALENESS), '2026-08-01T00:00:00.000Z');

    assert.equal(outcome.out._gdeltFailureCode, 'GDELT_SHARED_PROXY_HTTP_429');
    assert.equal(outcome.out._freshTopicCount, 1);
    assert.equal(outcome.attempted.length, 2, 'no DOC request may be launched after the circuit opens');
  });

  it('keeps the timeline pair on the 4h UTC slot rotation, not on the article fetch order', async () => {
    const timelineCalls = [];
    const slotMs = 4 * 60 * 60_000;
    await runHealthy(snapshotOf(PRODUCTION_STALENESS), {
      // Slot 4 → canonical INTEL_TOPICS[4] === 'intelligence', while the stalest
      // topic this run is 'nuclear'.
      _now: () => 4 * slotMs,
      _fetchTimeline: async (topic, mode) => {
        timelineCalls.push(`${topic.id}/${mode}`);
        return { points: [{ date: '2026-07-29', value: 1 }], errorCode: null };
      },
    });

    assert.deepEqual(timelineCalls, ['intelligence/TimelineTone', 'intelligence/TimelineVol']);
  });
});
