import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const xNews = require('../scripts/lib/x-news-accounts.cjs');
const registry = JSON.parse(readFileSync(join(__dirname, '../data/x-accounts.json'), 'utf8'));

describe('data/x-accounts.json registry (#6654)', () => {
  it('has the Telegram-shaped product-managed envelope', () => {
    assert.equal(registry.version, 1);
    assert.ok(registry.updatedAt);
    assert.match(String(registry.note), /Product-managed/);
    assert.ok(registry.channels.full);
    assert.ok(registry.channels.tech);
    assert.ok(Array.isArray(registry.channels.finance));
  });

  it('starts with about 64 enabled accounts, matching the Telegram analogue', () => {
    const enabled = xNews.countEnabledAccounts(registry);
    assert.equal(enabled, 64, `expected 64 enabled accounts, got ${enabled}`);
    const all = xNews.loadXAccounts(registry);
    const full = xNews.loadXAccounts(registry, { set: 'full' });
    const tech = xNews.loadXAccounts(registry, { set: 'tech' });
    assert.equal(all.length, 64);
    assert.equal(new Set(all.map((account) => account.handle.toLowerCase())).size, 64);
    assert.equal(full.length, 56);
    assert.equal(tech.length, 8);
  });

  it('stores numeric accountId when known and always has handle/label/topic/tier', () => {
    const accounts = [
      ...xNews.loadXAccounts(registry, { set: 'full' }),
      ...xNews.loadXAccounts(registry, { set: 'tech' }),
    ];
    for (const account of accounts) {
      assert.ok(account.handle, 'handle required');
      assert.ok(account.label, 'label required');
      assert.ok(account.sourceName, 'sourceName required');
      assert.ok(account.topic, 'topic required');
      assert.ok(Number.isFinite(account.tier) && account.tier >= 1 && account.tier <= 3, `${account.handle} tier`);
      assert.equal(account.enabled, true);
      if (account.accountId) {
        assert.match(account.accountId, /^[1-9]\d{0,18}$/);
      }
    }
    assert.equal(accounts.find((a) => a.handle === 'Reuters')?.accountId, '1652541');
  });
});

describe('normalizeXPost / dedup (#6654)', () => {
  const account = {
    handle: 'Reuters',
    accountId: '1652541',
    label: 'Reuters',
    sourceName: 'Reuters',
    topic: 'breaking',
    region: 'global',
  };

  it('normalises a user-timeline tweet onto the Telegram-like feed item', () => {
    const item = xNews.normalizeXPost({
      id: '1234567890123456789',
      text: 'Breaking: a port disruption was reported in the strait.',
      created_at: '2026-08-18T12:00:00.000Z',
      lang: 'en',
      public_metrics: { like_count: 4, reply_count: 1, retweet_count: 2 },
      attachments: { media_keys: ['3_1'] },
    }, account);
    assert.equal(item.id, 'Reuters:1234567890123456789');
    assert.equal(item.source, 'x');
    assert.equal(item.account, 'Reuters');
    assert.equal(item.url, 'https://x.com/Reuters/status/1234567890123456789');
    assert.equal(item.ts, '2026-08-18T12:00:00.000Z');
    assert.equal(item.topic, 'breaking');
    assert.equal(item.hasMedia, true);
    assert.equal(item.storageState, 'metadata_only');
    assert.equal(item.contentState, 'active');
    assert.deepEqual(item.tags, ['global']);
  });

  it('dedups by account:postId and keeps the newest first', () => {
    const older = xNews.normalizeXPost({ id: '10', text: 'a', created_at: '2026-08-18T11:00:00.000Z' }, account);
    const newer = xNews.normalizeXPost({ id: '11', text: 'b', created_at: '2026-08-18T12:00:00.000Z' }, account);
    const duplicate = xNews.normalizeXPost({ id: '11', text: 'b-dup', created_at: '2026-08-18T12:00:00.000Z' }, account);
    const merged = xNews.mergeAndDedup([older], [newer, duplicate], 50);
    assert.equal(merged.length, 2);
    assert.equal(merged[0].id, 'Reuters:11');
    assert.equal(merged[1].id, 'Reuters:10');
  });

  it('alert facts omit R4 tweet bodies', () => {
    const item = xNews.normalizeXPost({
      id: '99',
      text: 'SECRET BODY that must not leak to embed partners',
      created_at: '2026-08-18T12:00:00.000Z',
    }, account);
    const facts = xNews.derivedAlertFacts(item);
    assert.equal(facts.link, item.url);
    assert.equal(facts.source, 'Reuters');
    assert.doesNotMatch(JSON.stringify(facts), /SECRET BODY/);
  });

  it('collectXAlertCandidates skips deleted posts, omits tweet bodies, and drops unlisted/tier-4 sources', () => {
    const live = xNews.normalizeXPost({
      id: '101',
      text: 'SECRET BODY must not enter the alert path',
      created_at: '2026-08-18T12:00:00.000Z',
    }, account);
    const deleted = xNews.tombstonePosts([
      xNews.normalizeXPost({
        id: '102',
        text: 'deleted body',
        created_at: '2026-08-18T12:00:00.000Z',
      }, account),
    ], ['102'], Date.parse('2026-08-18T12:01:00.000Z'))[0];
    const unlisted = xNews.normalizeXPost({
      id: '103',
      text: 'unlisted source',
      created_at: '2026-08-18T12:00:00.000Z',
    }, { ...account, sourceName: 'Unknown Outlet' });
    const candidates = xNews.collectXAlertCandidates(
      [live, deleted, unlisted],
      { Reuters: 1, 'Unknown Outlet': 4 },
      Date.parse('2026-08-18T12:05:00.000Z'),
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].source, 'Reuters');
    assert.equal(candidates[0].link, live.url);
    assert.doesNotMatch(JSON.stringify(candidates), /SECRET BODY|deleted body|unlisted source/);
  });
});

describe('24h tombstone path (#6654)', () => {
  const account = { handle: 'AP', accountId: '51241574', label: 'AP News', sourceName: 'AP News', topic: 'breaking' };

  it('strips text and marks deleted posts as tombstones', () => {
    const item = xNews.normalizeXPost({
      id: '42',
      text: 'this body must disappear',
      created_at: '2026-08-18T10:00:00.000Z',
    }, account);
    const now = Date.parse('2026-08-18T12:00:00.000Z');
    const tombstoned = xNews.tombstonePosts([item], ['42'], now);
    assert.equal(tombstoned[0].text, '');
    assert.equal(tombstoned[0].storageState, 'tombstone');
    assert.equal(tombstoned[0].contentState, 'deleted');
    assert.equal(tombstoned[0].deletedAt, '2026-08-18T12:00:00.000Z');
    assert.equal(tombstoned[0].url, item.url);
  });

  it('purges tombstones older than 24h and keeps fresh ones', () => {
    const item = xNews.normalizeXPost({ id: '7', text: 'gone', created_at: '2026-08-17T00:00:00.000Z' }, account);
    const deletedAt = Date.parse('2026-08-17T00:00:00.000Z');
    const tombstoned = xNews.tombstonePosts([item], ['7'], deletedAt);
    const stillFresh = xNews.purgeExpiredTombstones(tombstoned, deletedAt + 23 * 60 * 60 * 1000);
    const expired = xNews.purgeExpiredTombstones(tombstoned, deletedAt + 25 * 60 * 60 * 1000);
    assert.equal(stillFresh.length, 1);
    assert.equal(expired.length, 0);
  });
});

describe('since_id poll loop + 429 backoff (#6654)', () => {
  it('builds user-timeline URLs with since_id and clamps cadence to 5–15 minutes', () => {
    const url = xNews.buildUserTimelineUrl({ accountId: '1652541', sinceId: '99', maxResults: 10 });
    assert.equal(url.pathname, '/2/users/1652541/tweets');
    assert.equal(url.searchParams.get('since_id'), '99');
    assert.equal(xNews.clampPollIntervalMs(60_000), xNews.MIN_POLL_INTERVAL_MS);
    assert.equal(xNews.clampPollIntervalMs(20 * 60 * 1000), xNews.MAX_POLL_INTERVAL_MS);
    assert.equal(xNews.clampPollIntervalMs(10 * 60 * 1000), 10 * 60 * 1000);
  });

  it('honors Retry-After on 429', () => {
    const headers = new Headers({ 'retry-after': '12' });
    assert.equal(xNews.compute429BackoffMs(headers, 0), 12_000);
    assert.ok(xNews.compute429BackoffMs(new Headers(), 3) >= 8000);
  });

  it('polls with since_id, dedups, and tombstones missing IDs', async () => {
    const account = {
      handle: 'Reuters',
      accountId: '1652541',
      label: 'Reuters',
      sourceName: 'Reuters',
      topic: 'breaking',
      maxMessages: 10,
    };
    const calls = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      calls.push(parsed.pathname + parsed.search);
      if (parsed.pathname === '/2/users/1652541/tweets') {
        assert.equal(parsed.searchParams.get('since_id'), '100');
        return new Response(JSON.stringify({
          data: [
            { id: '101', text: 'new post', created_at: '2026-08-18T12:00:00.000Z' },
          ],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (parsed.pathname === '/2/tweets') {
        return new Response(JSON.stringify({
          data: [{ id: '101' }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected ${parsed.pathname}`);
    };

    const prior = xNews.normalizeXPost({
      id: '50',
      text: 'old post that was deleted',
      created_at: '2026-08-18T09:00:00.000Z',
    }, account);
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: {
        cursorByAccountId: { '1652541': '100' },
        accountIdByHandle: {},
        items: [prior],
      },
      bearerToken: 'test-token',
      fetchImpl,
      now: () => Date.parse('2026-08-18T12:05:00.000Z'),
      wait: async () => {},
    });

    assert.equal(state.accountsPolled, 1);
    assert.equal(state.newCount, 1);
    assert.equal(state.cursorByAccountId['1652541'], '101');
    const live = state.items.find((item) => item.postId === '101');
    const gone = state.items.find((item) => item.postId === '50');
    assert.ok(live);
    assert.equal(gone.contentState, 'deleted');
    assert.equal(gone.text, '');
    assert.ok(calls.some((c) => c.includes('since_id=100')));
  });

  it('stops the cycle and records backoff on HTTP 429', async () => {
    const fetchImpl = async () => new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '30' },
    });
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      now: () => 1_000,
      wait: async () => {},
    });
    assert.equal(state.accountsPolled, 0);
    assert.equal(state.accountOffset, 0);
    assert.ok(state.rateLimitedUntil > 1000);
    assert.match(state.lastError, /rate limited/);
  });

  it('pages one fixed since_id window before advancing its cursor', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      calls.push(parsed);
      if (parsed.pathname === '/2/tweets') {
        return new Response(JSON.stringify({ data: [{ id: '101' }, { id: '102' }] }), { status: 200 });
      }
      const token = parsed.searchParams.get('pagination_token');
      return new Response(JSON.stringify(token ? {
        data: [{ id: '101', text: 'older', created_at: '2026-08-18T11:59:00.000Z' }],
        meta: {},
      } : {
        data: [{ id: '102', text: 'newest', created_at: '2026-08-18T12:00:00.000Z' }],
        meta: { next_token: 'page-2' },
      }), { status: 200 });
    };
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      fetchImpl,
      wait: async () => {},
    });
    const timelineCalls = calls.filter((url) => url.pathname.endsWith('/tweets') && url.pathname !== '/2/tweets');
    assert.equal(timelineCalls.length, 2);
    assert.equal(timelineCalls[0].searchParams.get('since_id'), '100');
    assert.equal(timelineCalls[1].searchParams.get('since_id'), '100');
    assert.equal(timelineCalls[1].searchParams.get('pagination_token'), 'page-2');
    assert.equal(state.cursorByAccountId['1652541'], '102');
    assert.equal(state.cycleComplete, true);
  });

  it('does not advance the cursor when the timeline page limit truncates a window', async () => {
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ id: '102', text: 'newest' }],
        meta: { next_token: 'more' },
      }), { status: 200 }),
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(state.cursorByAccountId['1652541'], '100');
    assert.equal(state.accountsFailed, 1);
    assert.equal(state.cycleComplete, false);
    assert.equal(state.items.length, 0);
  });

  it('rotates the next account after a partial 429 cycle', async () => {
    const accounts = [
      { handle: 'Reuters', accountId: '1652541' },
      { handle: 'AP', accountId: '51241574' },
      { handle: 'BBCWorld', accountId: '742143' },
    ];
    const first = await xNews.pollXFeed({
      accounts,
      state: { items: [], accountOffset: 0 },
      bearerToken: 'test-token',
      fetchImpl: async () => new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
      now: () => 1000,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(first.accountsAttempted, 1);
    assert.equal(first.accountOffset, 1);

    let firstPath = '';
    await xNews.pollXFeed({
      accounts,
      state: { ...first, rateLimitedUntil: 0 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        firstPath ||= new URL(url).pathname;
        return new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } });
      },
      now: () => 1000,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.match(firstPath, /\/2\/users\/51241574\/tweets$/);
  });

  it('marks partial account coverage incomplete', async () => {
    const state = await xNews.pollXFeed({
      accounts: [
        { handle: 'Reuters', accountId: '1652541' },
        { handle: 'AP', accountId: '51241574' },
      ],
      state: { items: [] },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.includes('/1652541/')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response('failure', { status: 503 });
      },
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.accountsFailed, 1);
    assert.equal(state.accountsAttempted, 2);
    assert.equal(state.cycleComplete, false);
  });
});

describe('versioned X feed snapshot', () => {
  it('round-trips bounded serving state and poll cursors across a restart', () => {
    const item = xNews.normalizeXPost({ id: '101', text: 'body' }, {
      handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters',
    });
    const snapshot = xNews.buildXFeedSnapshot({
      generation: 7,
      cursorByAccountId: { '1652541': '101' },
      accountIdByHandle: { Reuters: '1652541' },
      items: [item],
      lookupOffset: 4,
      accountOffset: 9,
      lastPollAt: 1_755_521_200_000,
      lastHealthyAt: 1_755_521_200_000,
      lastCoverage: { expected: 64, polled: 64, failed: 0, attempted: 64, complete: true },
    }, { enabled: true, expectedAccounts: 64 });
    const hydrated = xNews.hydrateXFeedSnapshot(snapshot);
    assert.equal(snapshot.version, xNews.X_FEED_SNAPSHOT_VERSION);
    assert.equal(snapshot.count, 1);
    assert.equal(hydrated.generation, 7);
    assert.equal(hydrated.cursorByAccountId['1652541'], '101');
    assert.equal(hydrated.accountOffset, 9);
    assert.equal(hydrated.items[0].text, 'body');
    assert.equal(hydrated.lastCoverage.complete, true);
  });

  it('rejects an unversioned or malformed snapshot', () => {
    assert.equal(xNews.hydrateXFeedSnapshot({ items: [] }), null);
    assert.equal(xNews.hydrateXFeedSnapshot({ version: 1, items: [] }), null);
  });
});
