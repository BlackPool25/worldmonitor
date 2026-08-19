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

  it('honors x-rate-limit-reset, the header X API v2 actually sends on 429', () => {
    const now = () => Date.parse('2026-08-18T12:00:00.000Z');
    // Absolute epoch SECONDS, not a delta — 90s in the future.
    const resetAt = Math.floor(now() / 1000) + 90;
    const headers = new Headers({ 'x-rate-limit-reset': String(resetAt) });
    assert.equal(xNews.compute429BackoffMs(headers, 0, now), 90_000);
    // retry-after still wins when both are present.
    const both = new Headers({ 'retry-after': '5', 'x-rate-limit-reset': String(resetAt) });
    assert.equal(xNews.compute429BackoffMs(both, 0, now), 5_000);
    // An already-elapsed reset must not produce a negative or zero-forever wait.
    const past = new Headers({ 'x-rate-limit-reset': String(Math.floor(now() / 1000) - 60) });
    assert.equal(xNews.parseRateLimitResetMs(past, now), 0);
  });

  it('escalates the blind backoff to the 15-minute ceiling it advertises', () => {
    // Regression: the exponent was clamped to 6, topping out at 64s — below
    // MIN_POLL_INTERVAL_MS, so rateLimitedUntil had always elapsed by the next
    // tick and the backoff could never defer a poll.
    assert.ok(
      xNews.compute429BackoffMs(new Headers(), 6) < xNews.MIN_POLL_INTERVAL_MS,
      'attempt 6 is the old ceiling and must still be under one poll interval',
    );
    const deep = xNews.compute429BackoffMs(new Headers(), xNews.MAX_429_BACKOFF_EXPONENT);
    assert.equal(deep, xNews.MAX_429_BACKOFF_MS);
    assert.ok(
      deep >= xNews.MIN_POLL_INTERVAL_MS,
      'a sustained 429 must be able to defer at least one full poll interval',
    );
    // Never exceeds the advertised ceiling, however many attempts accrue.
    assert.equal(xNews.compute429BackoffMs(new Headers(), 99), xNews.MAX_429_BACKOFF_MS);
  });

  it('lets the attempt counter climb far enough to reach that ceiling', async () => {
    // The counter was capped at 7 (128s), which held the exponential below the
    // ceiling no matter how long the rate limiting lasted.
    const account = { handle: 'Reuters', accountId: '1652541' };
    let state = { items: [], accountOffset: 0 };
    const fetchImpl = async () => new Response('rate limited', { status: 429 });
    for (let i = 0; i < 12; i += 1) {
      state = await xNews.pollXFeed({
        accounts: [account],
        state: { ...state, rateLimitedUntil: 0 },
        bearerToken: 'test-token',
        fetchImpl,
        now: () => 1000,
        wait: async () => {},
        lookupDeletions: false,
      });
    }
    assert.equal(state.rateLimitAttempt, xNews.MAX_429_BACKOFF_EXPONENT);
    assert.equal(state.rateLimitedUntil - 1000, xNews.MAX_429_BACKOFF_MS);
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
          errors: [{
            resource_id: '50',
            value: '50',
            type: 'https://api.twitter.com/2/problems/resource-not-found',
            title: 'Not Found Error',
            detail: 'Could not find tweet with ids: [50].',
          }],
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

  it('resolves a missing account ID by username and persists the mapping', async () => {
    const calls = [];
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'ExampleNews', label: 'Example News', sourceName: 'Example News', topic: 'breaking' }],
      state: { cursorByAccountId: {}, accountIdByHandle: {}, items: [] },
      bearerToken: 'test-token',
      lookupDeletions: false,
      wait: async () => {},
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed.pathname);
        if (parsed.pathname === '/2/users/by/username/ExampleNews') {
          return new Response(JSON.stringify({ data: { id: '987654321', username: 'ExampleNews' } }), { status: 200 });
        }
        if (parsed.pathname === '/2/users/987654321/tweets') {
          return new Response(JSON.stringify({ data: [{ id: '101', text: 'resolved account post' }] }), { status: 200 });
        }
        throw new Error(`unexpected ${parsed.pathname}`);
      },
    });

    assert.deepEqual(calls, ['/2/users/by/username/ExampleNews', '/2/users/987654321/tweets']);
    assert.equal(state.accountIdByHandle.ExampleNews, '987654321');
    assert.equal(state.cursorByAccountId['987654321'], '101');
    assert.equal(state.items[0].accountId, '987654321');
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
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].postId, '102');
  });

  it('resumes a capped later window on the next poll before advancing since_id', async () => {
    const timelineTokens = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/2/tweets') {
        const ids = parsed.searchParams.get('ids')?.split(',') || [];
        return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
      }
      const token = parsed.searchParams.get('pagination_token') || '';
      timelineTokens.push(token);
      if (!token) {
        return new Response(JSON.stringify({
          data: [{ id: '105', text: 'newest' }],
          meta: { next_token: 'page-2' },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: '104', text: 'older' }], meta: {} }), { status: 200 });
    };
    const account = { handle: 'Reuters', accountId: '1652541', maxMessages: 10 };
    const first = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.equal(first.cursorByAccountId['1652541'], '100');
    assert.equal(first.catchupByAccountId['1652541'].paginationToken, 'page-2');
    assert.equal(first.items[0].postId, '105');

    const second = await xNews.pollXFeed({
      accounts: [account],
      state: first,
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      fetchImpl,
      wait: async () => {},
      lookupDeletions: false,
    });
    assert.deepEqual(timelineTokens, ['', 'page-2']);
    assert.equal(second.cursorByAccountId['1652541'], '105');
    assert.equal(second.catchupByAccountId['1652541'], undefined);
    assert.deepEqual(second.items.map((item) => item.postId).sort(), ['104', '105']);
    assert.equal(second.cycleComplete, true);
  });

  it('establishes since_id from newest pages when the first poll hits the page cap', async () => {
    const calls = [];
    const state = await xNews.pollXFeed({
      accounts: [{ handle: 'Reuters', accountId: '1652541', maxMessages: 10 }],
      state: { cursorByAccountId: {}, items: [] },
      bearerToken: 'test-token',
      maxTimelinePages: 1,
      lookupDeletions: false,
      now: () => Date.parse('2026-08-18T12:00:00.000Z'),
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        calls.push(parsed);
        return new Response(JSON.stringify({
          data: [{ id: '200', text: 'newest', created_at: '2026-08-18T11:50:00.000Z' }],
          meta: { next_token: 'more' },
        }), { status: 200 });
      },
      wait: async () => {},
    });
    const timeline = calls.find((url) => url.pathname.endsWith('/tweets') && url.pathname !== '/2/tweets');
    assert.equal(timeline.searchParams.get('since_id'), null);
    assert.ok(timeline.searchParams.get('start_time'));
    assert.equal(state.cursorByAccountId['1652541'], '200');
    assert.equal(state.accountsPolled, 1);
    assert.equal(state.accountsFailed, 0);
    assert.equal(state.items.length, 1);
    assert.equal(state.items[0].postId, '200');
    assert.equal(state.cycleComplete, true);
  });

  it('tombstones only resource-not-found lookup errors', async () => {
    const account = {
      handle: 'Reuters',
      accountId: '1652541',
      label: 'Reuters',
      sourceName: 'Reuters',
      topic: 'breaking',
    };
    const priorDeleted = xNews.normalizeXPost({
      id: '50', text: 'deleted post', created_at: '2026-08-18T09:00:00.000Z',
    }, account);
    const priorOmitted = xNews.normalizeXPost({
      id: '60', text: 'silently omitted', created_at: '2026-08-18T09:01:00.000Z',
    }, account);
    const priorProtected = xNews.normalizeXPost({
      id: '70', text: 'protected post', created_at: '2026-08-18T09:02:00.000Z',
    }, account);
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: {
        cursorByAccountId: { '1652541': '100' },
        items: [priorDeleted, priorOmitted, priorProtected],
        lookupOffset: 0,
      },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/tweets') && parsed.pathname !== '/2/tweets') {
          return new Response(JSON.stringify({
            data: [{ id: '101', text: 'new post', created_at: '2026-08-18T12:00:00.000Z' }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: [{ id: '101' }],
          errors: [
            {
              resource_id: '50',
              type: 'https://api.twitter.com/2/problems/resource-not-found',
              title: 'Not Found Error',
              detail: 'Could not find tweet with ids: [50].',
            },
            {
              resource_id: '70',
              type: 'https://api.twitter.com/2/problems/not-authorized-for-resource',
              title: 'Authorization Error',
              detail: 'Not authorized to view this Tweet.',
            },
            {
              resource_id: '60',
              type: 'https://api.twitter.com/2/problems/invalid-request',
              title: 'Not Found Error',
              detail: 'This deleted-looking text must not be treated as a resource tombstone.',
            },
          ],
        }), { status: 200 });
      },
      wait: async () => {},
    });
    assert.equal(state.items.find((item) => item.postId === '50').contentState, 'deleted');
    assert.notEqual(state.items.find((item) => item.postId === '60').contentState, 'deleted');
    assert.notEqual(state.items.find((item) => item.postId === '70').contentState, 'deleted');
    assert.equal(state.items.find((item) => item.postId === '60').contentState, 'active');
  });

  it('does not advance lookupOffset when deletion lookup fails', async () => {
    const account = { handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' };
    const items = ['10', '20', '30'].map((id) => xNews.normalizeXPost({
      id, text: `post ${id}`, created_at: '2026-08-18T09:00:00.000Z',
    }, account));
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items, lookupOffset: 0 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => {
        const parsed = new URL(url);
        if (parsed.pathname === '/2/tweets') {
          return new Response('lookup failed', { status: 500 });
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
      wait: async () => {},
    });
    assert.equal(state.lookupOffset, 0);
    assert.equal(state.items.filter((item) => item.contentState === 'deleted').length, 0);
  });

  it('does not advance lookupOffset after a non-200 success response', async () => {
    const account = { handle: 'Reuters', accountId: '1652541', label: 'Reuters', sourceName: 'Reuters', topic: 'breaking' };
    const items = ['10', '20'].map((id) => xNews.normalizeXPost({ id, text: `post ${id}` }, account));
    const state = await xNews.pollXFeed({
      accounts: [account],
      state: { cursorByAccountId: { '1652541': '100' }, items, lookupOffset: 1 },
      bearerToken: 'test-token',
      fetchImpl: async (url) => new URL(url).pathname === '/2/tweets'
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
      wait: async () => {},
    });
    assert.equal(state.lookupOffset, 1);
    assert.match(state.lastError, /HTTP 204/);
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
    const second = await xNews.pollXFeed({
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
    assert.equal(first.rateLimitAttempt, 1);
    assert.equal(second.rateLimitAttempt, 2);
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
    const state = {
      generation: 7,
      cursorByAccountId: { '1652541': '101' },
      accountIdByHandle: { Reuters: '1652541' },
      items: [item],
      lookupOffset: 4,
      accountOffset: 9,
      catchupByAccountId: { '1652541': { sinceId: '100', paginationToken: 'page-3', newestPostId: '101' } },
      rateLimitedUntil: 1_755_521_260_000,
      rateLimitAttempt: 3,
      lastPollAt: 1_755_521_200_000,
      lastHealthyAt: 1_755_521_200_000,
      lastCoverage: { expected: 64, polled: 64, failed: 0, attempted: 64, complete: true },
    };
    const snapshot = xNews.buildXFeedSnapshot(state, { enabled: true, expectedAccounts: 64 });
    const pollState = xNews.buildXPollState(state, { expectedAccounts: 64 });
    assert.equal(snapshot.pollState, undefined);
    const hydrated = xNews.hydrateXFeedSnapshot(snapshot, { pollState });
    assert.equal(snapshot.version, xNews.X_FEED_SNAPSHOT_VERSION);
    assert.equal(snapshot.count, 1);
    assert.equal(hydrated.generation, 7);
    assert.equal(hydrated.cursorByAccountId['1652541'], '101');
    assert.equal(hydrated.accountOffset, 9);
    assert.equal(hydrated.catchupByAccountId['1652541'].paginationToken, 'page-3');
    assert.equal(hydrated.rateLimitedUntil, 1_755_521_260_000);
    assert.equal(hydrated.rateLimitAttempt, 3);
    assert.equal(hydrated.items[0].text, 'body');
    assert.equal(hydrated.lastCoverage.complete, true);
    const legacy = xNews.hydrateXFeedSnapshot({ ...snapshot, pollState });
    assert.equal(legacy.cursorByAccountId['1652541'], '101');
    const servingOnly = xNews.hydrateXFeedSnapshot(snapshot);
    assert.ok(servingOnly);
    assert.equal(servingOnly.cursorByAccountId['1652541'], undefined);
    assert.equal(servingOnly.items[0].text, 'body');
    const pollStateOnly = xNews.hydrateXFeedSnapshot(null, { pollState });
    assert.equal(pollStateOnly.cursorByAccountId['1652541'], '101');
    assert.equal(pollStateOnly.items.length, 0);
  });

  it('rejects an unversioned or malformed snapshot', () => {
    assert.equal(xNews.hydrateXFeedSnapshot({ items: [] }), null);
    assert.equal(xNews.hydrateXFeedSnapshot({ version: 2, items: [] }), null);
    const empty = xNews.hydrateXFeedSnapshot({ version: xNews.X_FEED_SNAPSHOT_VERSION, items: [] });
    assert.ok(empty);
    assert.equal(empty.items.length, 0);
  });
});
