/**
 * ListStablecoinMarkets `coins` filter contract (#6308).
 *
 * Before this, `listStablecoinMarkets(_ctx, _req)` returned the whole
 * `market:stablecoins:v1` snapshot for every request: filtering did not work,
 * custom CoinGecko IDs could not work, and the summary could only ever
 * describe the seeded default set.
 *
 * The two costs these tests hold apart:
 *   - the default (empty `coins`) request must NEVER reach a provider — that
 *     is the posture #1684 established for the dashboard panel's hot path;
 *   - a named ID absent from the snapshot may reach CoinGecko exactly once,
 *     batched, and a repeat must come back out of Redis.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  listStablecoinMarkets,
  UNRESOLVED_REASONS,
  DATA_STATUSES,
} from '../server/worldmonitor/market/v1/list-stablecoin-markets.ts';
import { __clearLocalUnavailableBackoffForTests } from '../server/_shared/redis.ts';

const REDIS_URL = 'https://redis.example.test';
const SEED_KEY = 'market:stablecoins:v1';
const GAP_KEY_PREFIX = 'market:stablecoins:rpc:v1:';
const COINGECKO_MARKETS = 'https://api.coingecko.com/api/v3/coins/markets';

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = {
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
};

function restoreEnvironment() {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV.url == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = ORIGINAL_ENV.url;
  if (ORIGINAL_ENV.token == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = ORIGINAL_ENV.token;
  __clearLocalUnavailableBackoffForTests();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A seeded row, shaped exactly as scripts/seed-stablecoin-markets.mjs writes it. */
function seedCoin(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    symbol: id.slice(0, 4).toUpperCase(),
    name: id,
    price: 1.0,
    deviation: 0,
    pegStatus: 'ON PEG',
    marketCap: 1_000,
    volume24h: 100,
    change24h: 0.1,
    change7d: 0.2,
    image: '',
    ...overrides,
  };
}

/** A raw CoinGecko `/coins/markets` row. */
function geckoRow(id: string, price: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    symbol: id.slice(0, 4),
    name: id,
    current_price: price,
    price_change_percentage_24h: 0.5,
    price_change_percentage_7d_in_currency: 1.25,
    market_cap: 5_000,
    total_volume: 500,
    image: 'https://img.example.test/x.png',
    ...overrides,
  };
}

const SEED_SNAPSHOT = {
  timestamp: '2026-08-07T00:00:00.000Z',
  summary: {
    totalMarketCap: 3_000,
    totalVolume24h: 300,
    coinCount: 3,
    depeggedCount: 0,
    healthStatus: 'HEALTHY',
  },
  stablecoins: [seedCoin('tether'), seedCoin('usd-coin'), seedCoin('dai')],
};

// ---------------------------------------------------------------------------
// Harness: a minimal fake Upstash + CoinGecko, so cache reuse is real reuse
// ---------------------------------------------------------------------------

interface Harness {
  store: Map<string, string>;
  geckoCalls: string[];
  redisWrites: string[];
}

function installHarness(opts: {
  seed?: unknown;
  gecko?: (ids: string[]) => Response | Promise<Response>;
} = {}): Harness {
  const store = new Map<string, string>();
  const geckoCalls: string[] = [];
  const redisWrites: string[] = [];

  if (opts.seed !== undefined) store.set(SEED_KEY, JSON.stringify(opts.seed));

  process.env.UPSTASH_REDIS_REST_URL = REDIS_URL;
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    if (url.startsWith(`${REDIS_URL}/get/`)) {
      const key = decodeURIComponent(url.slice(`${REDIS_URL}/get/`.length));
      return new Response(JSON.stringify({ result: store.get(key) ?? null }), { status: 200 });
    }

    if (url === `${REDIS_URL}/` && init?.method === 'POST') {
      const [cmd, key, value] = JSON.parse(String(init.body)) as string[];
      assert.equal(cmd, 'SET', 'only SET is expected on the write path');
      store.set(key!, value!);
      redisWrites.push(key!);
      return new Response(JSON.stringify({ result: 'OK' }), { status: 200 });
    }

    if (url.startsWith(COINGECKO_MARKETS)) {
      geckoCalls.push(url);
      const ids = (new URL(url).searchParams.get('ids') ?? '').split(',').filter(Boolean);
      if (opts.gecko) return opts.gecko(ids);
      return new Response(JSON.stringify([]), { status: 200 });
    }

    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;

  return { store, geckoCalls, redisWrites };
}

function call(coins: string[]) {
  return listStablecoinMarkets({} as never, { coins } as never);
}

// ---------------------------------------------------------------------------
// Defaults — the hot path that must stay free
// ---------------------------------------------------------------------------

test('empty coins returns the configured default set and never calls a provider', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({ seed: SEED_SNAPSHOT });

  const res = await call([]);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['tether', 'usd-coin', 'dai']);
  assert.equal(res.dataStatus, 'OK');
  assert.deepEqual(res.unresolved, []);
  assert.equal(res.timestamp, SEED_SNAPSHOT.timestamp, 'default request reports the snapshot time');
  assert.deepEqual(h.geckoCalls, [], 'the default request must not reach CoinGecko');
});

test('empty coins with no snapshot reports UNAVAILABLE without reaching a provider', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({});

  const res = await call([]);

  assert.deepEqual(res.stablecoins, []);
  assert.equal(res.dataStatus, 'UNAVAILABLE');
  assert.equal(res.summary?.healthStatus, 'UNAVAILABLE');
  assert.deepEqual(h.geckoCalls, [], 'a seed miss must not become a provider fan-out');
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('a subset request returns only that subset, in request order', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({ seed: SEED_SNAPSHOT });

  const res = await call(['dai', 'tether']);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['dai', 'tether']);
  assert.equal(res.dataStatus, 'OK');
  assert.deepEqual(h.geckoCalls, [], 'seed-only requests perform no upstream calls');
});

test('the comma-joined query form filters identically to the repeated form', async (t) => {
  t.after(restoreEnvironment);
  installHarness({ seed: SEED_SNAPSHOT });

  // `?coins=dai,tether` reaches the handler as ONE array element.
  const joined = await call(['dai,tether']);
  const repeated = await call(['dai', 'tether']);

  assert.deepEqual(joined.stablecoins.map(c => c.id), ['dai', 'tether']);
  assert.deepEqual(joined.stablecoins.map(c => c.id), repeated.stablecoins.map(c => c.id));
});

test('duplicate IDs collapse instead of duplicating a coin in the response', async (t) => {
  t.after(restoreEnvironment);
  installHarness({ seed: SEED_SNAPSHOT });

  const res = await call(['tether', 'TETHER', ' tether ', 'tether']);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['tether']);
  assert.deepEqual(res.unresolved, [], 'a repeat is not a failure');
  assert.equal(res.dataStatus, 'OK');
});

// ---------------------------------------------------------------------------
// Summary recomputation
// ---------------------------------------------------------------------------

test('the summary is recomputed over the returned subset, not the seeded set', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: {
      ...SEED_SNAPSHOT,
      stablecoins: [
        seedCoin('tether', { marketCap: 1_000, volume24h: 100 }),
        seedCoin('usd-coin', { marketCap: 2_000, volume24h: 200 }),
        seedCoin('dai', { marketCap: 4_000, volume24h: 400 }),
      ],
    },
  });

  const res = await call(['tether', 'dai']);

  assert.equal(res.summary?.coinCount, 2);
  assert.equal(res.summary?.totalMarketCap, 5_000, 'usd-coin must not be counted');
  assert.equal(res.summary?.totalVolume24h, 500);
  assert.equal(res.summary?.depeggedCount, 0);
  assert.equal(res.summary?.healthStatus, 'HEALTHY');
});

test('depegged_count and health_status follow the returned subset', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: {
      ...SEED_SNAPSHOT,
      stablecoins: [
        seedCoin('tether'),
        seedCoin('usd-coin', { pegStatus: 'DEPEGGED', price: 0.94 }),
        seedCoin('dai', { pegStatus: 'DEPEGGED', price: 0.91 }),
      ],
    },
  });

  const healthy = await call(['tether']);
  assert.equal(healthy.summary?.depeggedCount, 0);
  assert.equal(healthy.summary?.healthStatus, 'HEALTHY');

  const caution = await call(['tether', 'usd-coin']);
  assert.equal(caution.summary?.depeggedCount, 1);
  assert.equal(caution.summary?.healthStatus, 'CAUTION');

  const warning = await call(['usd-coin', 'dai']);
  assert.equal(warning.summary?.depeggedCount, 2);
  assert.equal(warning.summary?.healthStatus, 'WARNING');
});

// ---------------------------------------------------------------------------
// Gap resolution through the provider
// ---------------------------------------------------------------------------

test('a valid non-default provider ID is fetched and returned', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({
    seed: SEED_SNAPSHOT,
    gecko: ids => new Response(JSON.stringify(ids.map(id => geckoRow(id, 0.997))), { status: 200 }),
  });

  const res = await call(['paxos-standard']);

  assert.equal(res.stablecoins.length, 1);
  assert.equal(res.stablecoins[0]?.id, 'paxos-standard');
  assert.equal(res.stablecoins[0]?.pegStatus, 'ON PEG', '0.3% off peg is inside the shared ON PEG band');
  assert.equal(res.stablecoins[0]?.deviation, 0.3);
  assert.equal(res.stablecoins[0]?.change7d, 1.25, '7d change must survive the provider projection');
  assert.equal(res.dataStatus, 'OK');
  assert.equal(h.geckoCalls.length, 1);
  assert.match(h.geckoCalls[0]!, /price_change_percentage=24h%2C7d/, 'the 7d window must be requested');
});

test('seed hits and provider gaps merge in request order', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({
    seed: SEED_SNAPSHOT,
    gecko: ids => new Response(JSON.stringify(ids.map(id => geckoRow(id, 1.0))), { status: 200 }),
  });

  const res = await call(['paxos-standard', 'tether', 'frax', 'dai']);

  assert.deepEqual(
    res.stablecoins.map(c => c.id),
    ['paxos-standard', 'tether', 'frax', 'dai'],
    'request order wins over seed order',
  );
  assert.equal(h.geckoCalls.length, 1, 'one batched call covers every gap');
  const requestedIds = new URL(h.geckoCalls[0]!).searchParams.get('ids');
  assert.equal(requestedIds, 'paxos-standard,frax', 'only the gaps are sent upstream');
});

test('a repeated gap request is served from Redis without a second provider call', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({
    seed: SEED_SNAPSHOT,
    gecko: ids => new Response(JSON.stringify(ids.map(id => geckoRow(id, 1.0))), { status: 200 }),
  });

  const first = await call(['frax']);
  const second = await call(['frax']);

  assert.equal(first.stablecoins[0]?.id, 'frax');
  assert.deepEqual(second.stablecoins.map(c => c.id), first.stablecoins.map(c => c.id));
  assert.equal(h.geckoCalls.length, 1, 'the second request must reuse the cached gap result');
  assert.ok(
    h.redisWrites.some(k => k.startsWith(GAP_KEY_PREFIX)),
    'the gap result is cached under its own key space',
  );
  assert.ok(
    !h.redisWrites.includes(SEED_KEY),
    'a request-driven write must never land on the seed-owned key',
  );
});

// ---------------------------------------------------------------------------
// Explicit failure attribution
// ---------------------------------------------------------------------------

test('an ID the provider does not know is reported NOT_FOUND, not dropped', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: SEED_SNAPSHOT,
    // CoinGecko answers 200 with the IDs it has — an unknown ID is simply absent.
    gecko: () => new Response(JSON.stringify([geckoRow('frax', 1.0)]), { status: 200 }),
  });

  const res = await call(['frax', 'not-a-real-coin']);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['frax']);
  assert.deepEqual(res.unresolved, [{ id: 'not-a-real-coin', reason: 'NOT_FOUND' }]);
  assert.equal(res.dataStatus, 'PARTIAL');
});

test('a provider outage is reported PROVIDER_ERROR, never as a missing coin', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: SEED_SNAPSHOT,
    gecko: () => new Response('upstream exploded', { status: 503 }),
  });

  const res = await call(['tether', 'frax']);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['tether'], 'the seeded coin still answers');
  assert.deepEqual(res.unresolved, [{ id: 'frax', reason: 'PROVIDER_ERROR' }]);
  assert.equal(res.dataStatus, 'PARTIAL');
  assert.equal(
    res.summary?.coinCount,
    1,
    'the summary describes what was returned, not what was asked for',
  );
});

test('a gap-only request that the provider cannot serve reports UNAVAILABLE', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: SEED_SNAPSHOT,
    gecko: () => new Response('nope', { status: 500 }),
  });

  const res = await call(['frax']);

  assert.deepEqual(res.stablecoins, []);
  assert.equal(res.dataStatus, 'UNAVAILABLE');
  assert.deepEqual(res.unresolved, [{ id: 'frax', reason: 'PROVIDER_ERROR' }]);
});

test('a provider outage is not cached as a missing coin on the next request', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: SEED_SNAPSHOT,
    gecko: () => new Response('still down', { status: 503 }),
  });

  const first = await call(['frax']);
  const second = await call(['frax']);

  // The distinction this pins: cachedFetchJson caches fetcher errors by
  // DEFAULT, which would write a negative sentinel on the outage and answer
  // the next caller "NOT_FOUND — no such coin" for the whole negative TTL.
  // The gap lookup opts out precisely so a dead provider keeps saying so.
  assert.deepEqual(first.unresolved, [{ id: 'frax', reason: 'PROVIDER_ERROR' }]);
  assert.deepEqual(
    second.unresolved,
    [{ id: 'frax', reason: 'PROVIDER_ERROR' }],
    'an outage must not decay into NOT_FOUND on the next request',
  );
});

test('a gap-only response is not stamped with the stale snapshot timestamp', async (t) => {
  t.after(restoreEnvironment);
  installHarness({
    seed: SEED_SNAPSHOT,
    gecko: ids => new Response(JSON.stringify(ids.map(id => geckoRow(id, 1.0))), { status: 200 }),
  });

  const gapOnly = await call(['frax']);
  const withSeed = await call(['tether', 'frax']);

  assert.notEqual(
    gapOnly.timestamp,
    SEED_SNAPSHOT.timestamp,
    'just-fetched data must not be reported as old as the snapshot',
  );
  assert.equal(
    withSeed.timestamp,
    SEED_SNAPSHOT.timestamp,
    'once a seeded row is present, the timestamp describes the oldest row',
  );
});

test('a malformed ID is rejected before any provider work', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({ seed: SEED_SNAPSHOT });

  const res = await call(['tether', 'Not A Coin!', '../../etc/passwd']);

  assert.deepEqual(res.stablecoins.map(c => c.id), ['tether']);
  assert.deepEqual(
    res.unresolved.map(u => u.reason),
    ['INVALID_ID', 'INVALID_ID'],
  );
  assert.equal(res.dataStatus, 'PARTIAL');
  assert.deepEqual(h.geckoCalls, [], 'a malformed ID must never reach the provider');
});

test('IDs past the cap are reported OVER_CAP and excluded from the provider call', async (t) => {
  t.after(restoreEnvironment);
  const h = installHarness({
    seed: SEED_SNAPSHOT,
    gecko: ids => new Response(JSON.stringify(ids.map(id => geckoRow(id, 1.0))), { status: 200 }),
  });

  const requested = Array.from({ length: 30 }, (_, i) => `coin-${i}`);
  const res = await call(requested);

  const overCap = res.unresolved.filter(u => u.reason === 'OVER_CAP');
  assert.equal(overCap.length, 5, '30 requested, 25 looked up');
  assert.deepEqual(overCap.map(u => u.id), requested.slice(25));
  assert.equal(res.stablecoins.length, 25);
  assert.equal(res.dataStatus, 'PARTIAL');

  const sentIds = (new URL(h.geckoCalls[0]!).searchParams.get('ids') ?? '').split(',');
  assert.equal(sentIds.length, 25, 'the cap bounds the provider call, not just the response');
  assert.ok(!sentIds.includes('coin-25'), 'an over-cap ID is never looked up');
});

// ---------------------------------------------------------------------------
// Published vocabulary
// ---------------------------------------------------------------------------

test('the handler emits every published value, and nothing outside them', async (t) => {
  t.after(restoreEnvironment);

  const responses: Awaited<ReturnType<typeof call>>[] = [];

  installHarness({
    seed: SEED_SNAPSHOT,
    gecko: () => new Response(JSON.stringify([]), { status: 200 }),
  });
  responses.push(await call([])); // OK
  responses.push(await call(['tether', 'Not A Coin!'])); // PARTIAL + INVALID_ID
  responses.push(await call(['tether', 'unknown-coin'])); // NOT_FOUND
  responses.push(await call(Array.from({ length: 30 }, (_, i) => `capcoin-${i}`))); // OVER_CAP

  restoreEnvironment();
  installHarness({ gecko: () => new Response('down', { status: 502 }) });
  responses.push(await call(['frax'])); // UNAVAILABLE + PROVIDER_ERROR

  const seenStatuses = new Set(responses.map(r => r.dataStatus));
  const seenReasons = new Set(responses.flatMap(r => r.unresolved.map(u => u.reason)));

  // Coverage first: without this the "nothing outside" half below passes
  // vacuously on any handler that simply never populates these fields — which
  // is exactly what the pre-#6308 handler did.
  for (const status of DATA_STATUSES) {
    assert.ok(seenStatuses.has(status), `no sampled request produced dataStatus ${status}`);
  }
  for (const reason of UNRESOLVED_REASONS) {
    assert.ok(seenReasons.has(reason), `no sampled request produced reason ${reason}`);
  }

  for (const status of seenStatuses) {
    assert.ok(
      (DATA_STATUSES as readonly string[]).includes(status),
      `dataStatus "${status}" is outside the published vocabulary`,
    );
  }
  for (const reason of seenReasons) {
    assert.ok(
      (UNRESOLVED_REASONS as readonly string[]).includes(reason),
      `reason "${reason}" is outside the published vocabulary`,
    );
  }
});

test('the proto publishes exactly the vocabulary the handler emits', async () => {
  const { readFileSync } = await import('node:fs');
  const proto = readFileSync(
    new URL('../proto/worldmonitor/market/v1/list_stablecoin_markets.proto', import.meta.url),
    'utf8',
  );

  for (const reason of UNRESOLVED_REASONS) {
    assert.ok(proto.includes(`"${reason}"`), `proto must document the ${reason} reason`);
  }
  for (const status of DATA_STATUSES) {
    assert.ok(proto.includes(`"${status}"`), `proto must document the ${status} data_status`);
  }
});
