/**
 * RPC: ListStablecoinMarkets -- seed-first stablecoin peg data.
 *
 * Two request shapes, deliberately different in what they are allowed to cost:
 *
 *   Empty `coins` (the dashboard panel's hot path) is served from the Railway
 *   seed snapshot alone and NEVER reaches an upstream provider. That is the
 *   posture #1684 established when it converted this handler to a pure Redis
 *   read, and nothing here weakens it.
 *
 *   Naming coins explicitly opts into a bounded, Redis-cached provider lookup
 *   for exactly the IDs the snapshot does not carry. Seed hits cost nothing;
 *   only the residue reaches CoinGecko, in one batched call. (#6308)
 *
 * The summary is recomputed over exactly the coins returned, so a subset
 * request describes the subset rather than the seeded default set.
 */

import type {
  ServerContext,
  ListStablecoinMarketsRequest,
  ListStablecoinMarketsResponse,
  Stablecoin,
  StablecoinSummary,
  UnresolvedStablecoin,
} from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import stablecoinConfig from '../../../../shared/stablecoins.json';
import { cachedFetchJson, readCachedJson } from '../../../_shared/redis';
import { sha256Hex } from '../../../_shared/hash';
import {
  fetchCryptoMarketsWithSource,
  parseStringArray,
  type CoinGeckoMarketItem,
  type CryptoMarketsSource,
} from './_shared';

const SEED_CACHE_KEY = 'market:stablecoins:v1';

// Request-driven gap lookups get their own key space. The seed key stays
// seed-owned: a request that ends in a negative sentinel must never overwrite
// Railway's last-good snapshot (same rule as get-country-stock-index.ts).
const GAP_CACHE_KEY_PREFIX = 'market:stablecoins:rpc:v1:';
const GAP_CACHE_TTL = 600; // 10 min — matches the seeder's cron cadence
const GAP_NEGATIVE_TTL = 300; // 5 min — how long "CoinGecko has no such coin" sticks
// Above _shared's UPSTREAM_TIMEOUT_MS (10s) plus the CoinPaprika fallback leg,
// so the cache layer stays the last-resort bound rather than pre-empting the
// fetcher's own timeouts.
const GAP_FETCH_TIMEOUT_MS = 25_000;

// Bounds the provider lookup, not the request: IDs past the cap are reported
// as OVER_CAP rather than dropped, so a caller can tell a truncated request
// from a coin that does not exist.
const MAX_LOOKUP_COINS = 25;
// A rejected ID is echoed back so the caller can spot the typo. Truncated
// because the value is untrusted and arbitrarily long.
const MAX_ECHOED_ID_LENGTH = 64;

// CoinGecko IDs are lowercase alphanumerics and hyphens. Anchored, with no
// nested quantifier or alternation, so it is linear on any input.
const COINGECKO_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const { onPegMaxDeviation: ON_PEG_MAX, slightDepegMaxDeviation: SLIGHT_DEPEG_MAX } =
  stablecoinConfig.pegThresholds;

/**
 * Closed vocabularies, exported so tests can pin them against the proto
 * comment that publishes them. `reason` and `dataStatus` are plain strings on
 * the wire, so nothing but these types stops a fifth value appearing.
 */
export const UNRESOLVED_REASONS = Object.freeze([
  'INVALID_ID',
  'OVER_CAP',
  'NOT_FOUND',
  'PROVIDER_ERROR',
] as const);
export const DATA_STATUSES = Object.freeze(['OK', 'PARTIAL', 'UNAVAILABLE'] as const);

type UnresolvedReason = (typeof UNRESOLVED_REASONS)[number];
type DataStatus = (typeof DATA_STATUSES)[number];

function unresolvedEntry(id: string, reason: UnresolvedReason): UnresolvedStablecoin {
  return { id, reason };
}

interface SeedSnapshot {
  timestamp?: string;
  stablecoins?: unknown;
}

interface GapPayload {
  coins: Stablecoin[];
  source: CryptoMarketsSource;
}

/**
 * Redis payloads are untrusted input, not typed values — a cast is a promise
 * TypeScript cannot keep. One `null` row inside `stablecoins` would throw while
 * summarizing and turn the dashboard's own request into a 500, so rows are
 * filtered rather than asserted. `id` is the only field worth gating on: it is
 * the merge key, and a row without one cannot be matched to a request anyway.
 */
function isUsableStablecoin(value: unknown): value is Stablecoin {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as Stablecoin).id === 'string'
    && (value as Stablecoin).id.length > 0,
  );
}

function isGapPayload(value: unknown): value is GapPayload {
  return Boolean(
    value
    && typeof value === 'object'
    && Array.isArray((value as GapPayload).coins),
  );
}

/** Provider numerics arrive as JSON of unknown shape; a string price must not become NaN. */
function toFiniteNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function unavailableResponse(unresolved: UnresolvedStablecoin[]): ListStablecoinMarketsResponse {
  return {
    timestamp: new Date().toISOString(),
    summary: summarize([]),
    stablecoins: [],
    unresolved,
    dataStatus: 'UNAVAILABLE',
  };
}

/**
 * Aggregates over exactly the coins passed in.
 *
 * `healthStatus` is peg health and says nothing about coverage — a one-coin
 * request for a depegged coin is a truthful CAUTION, not a data problem. The
 * empty case keeps the 'UNAVAILABLE' string the pre-#6308 empty response used,
 * so existing clients see no new value there; `dataStatus` is where coverage
 * is actually reported.
 */
function healthStatusFor(coinCount: number, depeggedCount: number): string {
  if (coinCount === 0) return 'UNAVAILABLE';
  if (depeggedCount === 0) return 'HEALTHY';
  if (depeggedCount === 1) return 'CAUTION';
  return 'WARNING';
}

function summarize(coins: Stablecoin[]): StablecoinSummary {
  let totalMarketCap = 0;
  let totalVolume24h = 0;
  let depeggedCount = 0;

  for (const coin of coins) {
    if (Number.isFinite(coin.marketCap)) totalMarketCap += coin.marketCap;
    if (Number.isFinite(coin.volume24h)) totalVolume24h += coin.volume24h;
    if (coin.pegStatus === 'DEPEGGED') depeggedCount++;
  }

  return {
    totalMarketCap,
    totalVolume24h,
    coinCount: coins.length,
    depeggedCount,
    healthStatus: healthStatusFor(coins.length, depeggedCount),
  };
}

/**
 * Trims, lowercases, and de-duplicates the requested IDs, splitting them into
 * the ones worth looking up and the ones that are already answered.
 *
 * Both wire forms are accepted. `parseStringArray` only splits on commas when
 * it is handed a bare string, but the generated route reads this field with
 * `params.getAll("coins")`, so `?coins=tether,dai` arrives as a ONE-element
 * array holding "tether,dai" — the documented comma form would go unsplit
 * without the inner split here. Splitting is lossless: a CoinGecko ID cannot
 * contain a comma, so a comma-bearing token could only ever be rejected.
 *
 * A duplicate is not a failure — callers concatenating lists should not be
 * punished — so it collapses silently. A malformed or over-cap ID IS reported:
 * dropping it is what made the old handler's behavior undiagnosable.
 */
function normalizeRequestedCoins(raw: unknown): {
  lookupIds: string[];
  unresolved: UnresolvedStablecoin[];
} {
  const seen = new Set<string>();
  const lookupIds: string[] = [];
  const unresolved: UnresolvedStablecoin[] = [];

  for (const value of parseStringArray(raw)) {
    if (typeof value !== 'string') continue;
    for (const part of value.split(',')) {
      const id = part.trim().toLowerCase();
      if (!id || seen.has(id)) continue;
      seen.add(id);

      if (!COINGECKO_ID_PATTERN.test(id)) {
        unresolved.push(unresolvedEntry(id.slice(0, MAX_ECHOED_ID_LENGTH), 'INVALID_ID'));
      } else if (lookupIds.length >= MAX_LOOKUP_COINS) {
        unresolved.push(unresolvedEntry(id, 'OVER_CAP'));
      } else {
        lookupIds.push(id);
      }
    }
  }

  return { lookupIds, unresolved };
}

/**
 * Mirrors the classification scripts/seed-stablecoin-markets.mjs applies, off
 * the same shared thresholds — a gap coin and a seeded coin sitting in one
 * response must not be labelled on different rules.
 */
function toStablecoin(item: CoinGeckoMarketItem): Stablecoin {
  const price = toFiniteNumber(item.current_price);
  const deviation = Math.abs(price - 1.0);
  return {
    id: item.id,
    symbol: String(item.symbol || '').toUpperCase(),
    name: String(item.name || ''),
    price,
    deviation: +(deviation * 100).toFixed(3),
    pegStatus: deviation <= ON_PEG_MAX
      ? 'ON PEG'
      : deviation <= SLIGHT_DEPEG_MAX
        ? 'SLIGHT DEPEG'
        : 'DEPEGGED',
    marketCap: toFiniteNumber(item.market_cap),
    volume24h: toFiniteNumber(item.total_volume),
    change24h: toFiniteNumber(item.price_change_percentage_24h),
    change7d: toFiniteNumber(item.price_change_percentage_7d_in_currency),
    image: String(item.image || ''),
  };
}

/**
 * Resolves IDs the snapshot does not carry, in ONE batched provider call.
 *
 * Keyed on the exact ID SET, so reuse is per request shape, not per coin:
 * `[frax]` and `[frax, paxos-standard]` are different keys and each fetches
 * frax. Deliberate for now — nothing sends a non-empty `coins` yet (the panel
 * sends `[]`), so per-coin keys would optimise a traffic pattern that does not
 * exist, and the per-ID negative-caching they need has to keep the
 * PROVIDER_ERROR/NOT_FOUND split intact. Revisit when a real caller with
 * overlapping ID sets appears; the 25-ID cap and the endpoint rate policy are
 * what bound the cost until then.
 * `cacheFetcherErrors: false` is load-bearing: it keeps a provider outage
 * (rethrown, reported PROVIDER_ERROR, retried after a short backoff) distinct
 * from a definitive "no such coin" (cached negative, reported NOT_FOUND).
 * Caching the outage would answer the next caller with the wrong reason for
 * five minutes.
 *
 * `providerFailed` is the "we cannot claim absence" flag, and a successful
 * CoinPaprika answer sets it too: that leg only covers IDs in its mapping
 * table, so an ID missing from a fell-back result was never actually looked
 * up. It is cached alongside the coins so a cache hit keeps the distinction.
 */
async function resolveGapCoins(ids: string[]): Promise<{
  resolved: Map<string, Stablecoin>;
  providerFailed: boolean;
}> {
  const resolved = new Map<string, Stablecoin>();
  if (ids.length === 0) return { resolved, providerFailed: false };

  // sha256 rather than the raw ID list: the key is derived from caller-supplied
  // input, and the list is unbounded in length.
  const cacheKey = `${GAP_CACHE_KEY_PREFIX}${await sha256Hex([...ids].sort().join(','))}`;

  // Read the gap key ourselves before handing it to cachedFetchJson, which
  // treats a Redis READ ERROR as a miss and runs the fetcher anyway. Without
  // this, a Redis fault scoped to this key alone — the seed read having
  // succeeded — still reaches CoinGecko, which is the fan-out the seed-read
  // guard exists to prevent. Same rule, applied per key.
  const cachedRead = await readCachedJson(cacheKey);
  if (cachedRead.status === 'error') {
    return { resolved, providerFailed: true };
  }
  if (cachedRead.status === 'hit') {
    // A hit that is not a payload is cachedFetchJson's negative sentinel: the
    // provider answered previously and had nothing for this ID set.
    if (!isGapPayload(cachedRead.value)) return { resolved, providerFailed: false };
    for (const coin of cachedRead.value.coins) {
      if (isUsableStablecoin(coin)) resolved.set(coin.id, coin);
    }
    return { resolved, providerFailed: cachedRead.value.source === 'coinpaprika' };
  }

  try {
    const payload = await cachedFetchJson<GapPayload>(
      cacheKey,
      GAP_CACHE_TTL,
      async () => {
        const { items, source } = await fetchCryptoMarketsWithSource(ids, {
          sparkline: false,
          priceChangePercentage: '24h,7d',
        });
        const requested = new Set(ids);
        const usable = items.filter(
          item => isUsableStablecoin(item) && requested.has(item.id),
        );
        // Rows present but none usable is malformed provider output, not an
        // answer. Returning null here would negative-cache it and report the
        // requested coins as NOT_FOUND — asserting they do not exist on the
        // strength of a response we could not parse. Throwing routes it to
        // PROVIDER_ERROR, and cacheFetcherErrors:false keeps it out of Redis.
        if (usable.length === 0) {
          if (items.length > 0) throw new Error(`provider returned ${items.length} unusable row(s)`);
          return null;
        }
        return { coins: usable.map(toStablecoin), source };
      },
      GAP_NEGATIVE_TTL,
      { timeoutMs: GAP_FETCH_TIMEOUT_MS, cacheFetcherErrors: false },
    );

    for (const coin of payload?.coins ?? []) resolved.set(coin.id, coin);
    return { resolved, providerFailed: payload?.source === 'coinpaprika' };
  } catch (err) {
    // sentry-coverage-ok: this failure is reported IN BAND rather than silently
    // — every affected ID comes back to the caller as PROVIDER_ERROR and the
    // response as PARTIAL/UNAVAILABLE, which is the whole point of #6308's
    // attribution fields. Swallowing here is what converts the throw into that
    // contract; rethrowing would 500 a request the seed could still partly
    // answer.
    console.warn('[Stablecoin] gap lookup failed:', (err as Error).message);
    return { resolved, providerFailed: true };
  }
}

export async function listStablecoinMarkets(
  _ctx: ServerContext,
  req: ListStablecoinMarketsRequest,
): Promise<ListStablecoinMarketsResponse> {
  const { lookupIds, unresolved } = normalizeRequestedCoins(req?.coins);

  // readCachedJson, not getCachedJson: the latter collapses "the snapshot is
  // absent" and "Redis is unreachable" into one null, and those must diverge
  // here. A Redis outage makes every requested ID look like a gap, which would
  // turn one bad minute for Upstash into a full-rate, uncached CoinGecko
  // fan-out from the edge — with the gap cache and the rate limiter, which
  // both live in that same Redis, unable to stop it. So a read ERROR suppresses
  // provider work entirely; only a genuine miss lets a lookup proceed.
  const seedRead = await readCachedJson(SEED_CACHE_KEY, true);
  const seedUnreachable = seedRead.status === 'error';
  const seed = seedRead.status === 'hit' ? seedRead.value as SeedSnapshot : null;
  const rawSeedCoins = seed?.stablecoins;
  const seedCoins = Array.isArray(rawSeedCoins) ? rawSeedCoins.filter(isUsableStablecoin) : [];

  // Default request: the seeded snapshot verbatim, no upstream work, ever.
  if (lookupIds.length === 0 && unresolved.length === 0) {
    if (seedCoins.length === 0) return unavailableResponse([]);
    return {
      timestamp: seed?.timestamp || new Date().toISOString(),
      summary: summarize(seedCoins),
      stablecoins: seedCoins,
      unresolved: [],
      dataStatus: 'OK',
    };
  }

  const seedById = new Map(seedCoins.map(coin => [coin.id, coin]));
  const gapIds = seedUnreachable ? [] : lookupIds.filter(id => !seedById.has(id));
  const { resolved, providerFailed: lookupFailed } = await resolveGapCoins(gapIds);
  // An ID we declined to look up is unknown, not absent — same reason a failed
  // lookup reports. Reporting NOT_FOUND here would assert the coin does not
  // exist on the strength of a Redis outage.
  const providerFailed = lookupFailed || seedUnreachable;

  const stablecoins: Stablecoin[] = [];
  for (const id of lookupIds) {
    const coin = seedById.get(id) ?? resolved.get(id);
    if (coin) {
      stablecoins.push(coin);
    } else {
      unresolved.push(unresolvedEntry(id, providerFailed ? 'PROVIDER_ERROR' : 'NOT_FOUND'));
    }
  }

  if (stablecoins.length === 0) return unavailableResponse(unresolved);

  // The timestamp must describe the OLDEST row present, since that is what a
  // consumer checks for staleness. Stamping a gap-only response with the seed's
  // time would report data that was just fetched as hours old.
  const servedFromSeed = stablecoins.some(coin => seedById.has(coin.id));
  const dataStatus: DataStatus = unresolved.length === 0 ? 'OK' : 'PARTIAL';

  return {
    timestamp: (servedFromSeed && seed?.timestamp) || new Date().toISOString(),
    summary: summarize(stablecoins),
    stablecoins,
    unresolved,
    dataStatus,
  };
}
