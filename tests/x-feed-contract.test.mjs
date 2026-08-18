import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { listXFeed } from '../server/worldmonitor/intelligence/v1/list-x-feed.ts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
}

function makeRequest(path = '/api/x-feed?limit=50') {
  return new Request(`https://worldmonitor.app${path}`, {
    method: 'GET',
    headers: { origin: 'https://worldmonitor.app' },
  });
}

describe('api/x-feed contract normalization', () => {
  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('normalizes items[] into the first-party panel contract and ignores a stale count field', async () => {
    globalThis.fetch = async (url, options) => {
      assert.match(String(url), /\/x\/feed\?limit=50$/);
      assert.equal(options?.headers?.Authorization, 'Bearer test-secret');
      return new Response(JSON.stringify({
        enabled: true,
        source: 'relay',
        earlySignal: false,
        updatedAt: '2026-08-18T12:00:00Z',
        count: 0,
        items: [{
          id: 'Reuters:123',
          postId: '123',
          account: 'Reuters',
          accountTitle: 'Reuters',
          accountId: '1652541',
          timestampMs: 1_744_000_000_000,
          url: 'javascript:alert(1)',
          text: 'Port disruption reported',
          topic: 'breaking',
          tags: [42, 'urgent'],
          hasMedia: true,
          lang: 'en',
          contentState: 'active',
        }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    assert.equal(res.status, 200);
    assert.match(res.headers.get('cache-control') || '', /s-maxage=120/);

    const data = await res.json();
    assert.equal(data.source, 'relay');
    assert.equal(data.count, 1);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].source, 'x');
    assert.equal(data.items[0].account, 'Reuters');
    assert.equal(data.items[0].accountTitle, 'Reuters');
    assert.equal(data.items[0].url, '');
    assert.equal(data.items[0].text, 'Port disruption reported');
    assert.equal(data.items[0].ts, new Date(1_744_000_000_000).toISOString());
    assert.deepEqual(data.items[0].tags, ['42', 'urgent']);
  });

  it('drops tombstoned posts from the first-party panel payload', async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:1',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/1',
        text: '',
        contentState: 'deleted',
      }, {
        id: 'Reuters:2',
        account: 'Reuters',
        url: 'https://x.com/Reuters/status/2',
        text: 'live post',
        contentState: 'active',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const handler = (await import(`../api/x-feed.js?t=${Date.now()}`)).default;
    const res = await handler(makeRequest());
    const data = await res.json();
    assert.equal(data.count, 1);
    assert.equal(data.items[0].id, 'Reuters:2');
  });
});

describe('server listXFeed relay normalization', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    restoreEnv();
  });

  it('maps relay items into permalink + facts and never returns tweet bodies', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async (url) => {
      assert.equal(new URL(String(url)).searchParams.get('includeDeleted'), '1');
      return new Response(JSON.stringify({
      enabled: true,
      count: 0,
      items: [{
        id: 'Reuters:123',
        accountId: '1652541',
        accountTitle: 'Reuters',
        account: 'Reuters',
        ts: '2026-08-18T12:30:00Z',
        url: 'https://x.com/Reuters/status/123',
        text: 'SECRET BODY must not leave the intelligence RPC',
        topic: 'breaking',
        hasMedia: true,
        lang: 'en',
        contentState: 'active',
      }],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.enabled, true);
    assert.equal(response.count, 1);
    assert.equal(response.posts.length, 1);
    assert.equal(response.posts[0].accountName, 'Reuters');
    assert.equal(response.posts[0].permalink, 'https://x.com/Reuters/status/123');
    assert.equal(response.posts[0].timestampMs, Date.parse('2026-08-18T12:30:00Z'));
    assert.ok(response.posts[0].facts.length > 0);
    assert.equal('text' in response.posts[0], false);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('preserves relay tombstones for RPC consumers', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:deleted',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/deleted',
        text: '',
        contentState: 'deleted',
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].contentState, 'deleted');
    assert.equal('text' in response.posts[0], false);
  });

  it('derives RPC facts instead of trusting relay-provided facts', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:124',
        account: 'Reuters',
        topic: 'breaking',
        url: 'https://x.com/Reuters/status/124',
        facts: ['SECRET BODY injected through relay facts'],
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.deepEqual(response.posts[0].facts, [
      'Reuters posted a breaking update',
      'https://x.com/Reuters/status/124',
    ]);
    assert.doesNotMatch(JSON.stringify(response), /SECRET BODY/);
  });

  it('filters unsafe permalinks in the server RPC path', async () => {
    process.env.WS_RELAY_URL = 'https://relay.example.com';
    process.env.RELAY_SHARED_SECRET = 'test-secret';
    globalThis.fetch = async () => new Response(JSON.stringify({
      enabled: true,
      items: [{
        id: 'Reuters:unsafe',
        account: 'Reuters',
        timestampMs: 1_744_000_000_000,
        url: 'javascript:alert(1)',
        text: 'should not leak',
        topic: 'breaking',
      }],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await listXFeed(/** @type {any} */ ({}), { limit: 25, topic: '', account: '' });
    assert.equal(response.count, 1);
    assert.equal(response.posts[0].permalink, '');
    assert.doesNotMatch(JSON.stringify(response), /should not leak/);
  });
});
