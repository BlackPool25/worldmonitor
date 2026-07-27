/**
 * Query-side client for the durable historical intelligence store (#5694).
 *
 * Shared by the three Pro-gated RPCs in
 * server/worldmonitor/intelligence/v1/{search-intel-history,get-intel-timeline,
 * get-similar-events}.ts. Two responsibilities:
 *
 *   1. Turn free text into a query vector comparable with the vectors the seed
 *      writer stored (scripts/_seed-history.mjs).
 *   2. Read convex/intelHistory.ts through its two secret-guarded internal HTTP
 *      routes.
 *
 * Every function returns `null` rather than throwing, so a provider or store
 * outage surfaces as `upstream_unavailable: true` on a 200 — the gateway reads
 * that flag out of the body and drops the response to Cache-Control: no-store
 * (server/_shared/cache-contract.ts) instead of pinning a false-empty result
 * for the cache tier's full TTL.
 *
 * EDGE-RUNTIME CONSTRAINT — the embedding call is reimplemented here rather
 * than reusing `embedBatch` from scripts/lib/brief-embedding.mjs. That module
 * imports `node:crypto` for its cache keys, and the intelligence gateway
 * (api/intelligence/v1/[rpc].ts) runs on the Vercel Edge runtime, which rejects
 * node: built-ins at runtime. Only the pure, dependency-free modules are
 * imported: the tunables that must not drift from the seed writer's, and the
 * outlet-suffix stripper that is half the normalization contract. The other
 * half of that contract (`normalizeQueryText` below) is re-derived, and
 * tests/intel-history-endpoints.test.mts asserts it against the real
 * `normalizeForEmbedding` so the copy cannot drift silently.
 */

import {
  EMBED_DIMS,
  EMBED_MODEL,
  OPENROUTER_EMBEDDINGS_URL,
} from '../../scripts/lib/brief-dedup-consts.mjs';
import { stripSourceSuffix } from '../../scripts/lib/brief-dedup-jaccard.mjs';

const CONVEX_INTERNAL_SEARCH_PATH = '/api/internal-intel-search';
const CONVEX_INTERNAL_TIMELINE_PATH = '/api/internal-intel-timeline';

/**
 * One embeddings call on a user-facing read path. Shorter than the seed
 * writer's 45s batch budget: this is a single input on an interactive
 * request, and a slow provider should degrade to `upstream_unavailable`
 * well inside the edge function's own limit.
 */
const EMBED_TIMEOUT_MS = 4_000;

/** Convex read budget, matching the entitlement gate's posture. */
const CONVEX_TIMEOUT_MS = 5_000;

let _didWarnMissingOpenRouterKey = false;
let _didWarnMissingConvexSiteUrl = false;
let _didWarnMissingConvexSharedSecret = false;

/**
 * Warn once per missing variable rather than per request. Mirrors
 * server/_shared/entitlement-check.ts: a deploy missing only one of the pair
 * would otherwise disable these routes with no signal in the logs.
 */
function getConvexSiteUrl(): string {
  const siteUrl = process.env.CONVEX_SITE_URL ?? '';
  if (!siteUrl && !_didWarnMissingConvexSiteUrl) {
    _didWarnMissingConvexSiteUrl = true;
    console.warn('[intel-history] CONVEX_SITE_URL not set; history reads disabled');
  }
  return siteUrl;
}

function getConvexSharedSecret(): string {
  const secret = process.env.CONVEX_SERVER_SHARED_SECRET ?? '';
  if (!secret && !_didWarnMissingConvexSharedSecret) {
    _didWarnMissingConvexSharedSecret = true;
    console.warn('[intel-history] CONVEX_SERVER_SHARED_SECRET not set; history reads disabled');
  }
  return secret;
}

/**
 * The query-side half of the normalization contract shared with
 * scripts/lib/brief-embedding.mjs:normalizeForEmbedding. The seed writer
 * embeds normalized text; a query normalized any differently ranks against a
 * subtly different vector space and degrades recall with nothing to point at.
 *
 * Kept byte-equivalent to that function — outlet-suffix strip (imported, so
 * the outlet list stays single-sourced), trim, whitespace collapse, lowercase.
 */
export function normalizeQueryText(text: string): string {
  if (typeof text !== 'string') return '';
  return stripSourceSuffix(text).trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Embed one free-text query with the model and dimensions the stored vectors
 * were produced under. Returns null on any failure — missing key, provider
 * error, timeout, or a vector the store would reject anyway.
 *
 * A wrong-dimension or non-finite vector is treated as failure rather than
 * passed through: convex/intelHistory.ts would reject it, and a silently
 * substituted vector would return arbitrary rows presented as real matches.
 */
export async function embedQueryText(text: string): Promise<number[] | null> {
  const apiKey = process.env.OPENROUTER_API_KEY ?? '';
  if (!apiKey) {
    if (!_didWarnMissingOpenRouterKey) {
      _didWarnMissingOpenRouterKey = true;
      console.warn('[intel-history] OPENROUTER_API_KEY not set; semantic history search disabled');
    }
    return null;
  }

  const input = normalizeQueryText(text);
  if (!input) return null;

  try {
    const resp = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://worldmonitor.app',
        'X-Title': 'World Monitor',
        'User-Agent': 'worldmonitor-gateway/1.0',
      },
      body: JSON.stringify({ model: EMBED_MODEL, input: [input], dimensions: EMBED_DIMS }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[intel-history] embeddings provider returned HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as { data?: Array<{ embedding?: unknown }> };
    const vector = body?.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== EMBED_DIMS) {
      console.warn(
        `[intel-history] embeddings provider returned ${
          Array.isArray(vector) ? `${vector.length} dims` : 'no vector'
        }, expected ${EMBED_DIMS}`,
      );
      return null;
    }
    if (!vector.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      console.warn('[intel-history] embeddings provider returned a non-finite component');
      return null;
    }
    return vector as number[];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[intel-history] embeddings call failed: ${msg}`);
    return null;
  }
}

/**
 * Scope accepted by both read routes. Absent fields are omitted from the
 * request body entirely: convex/http.ts distinguishes "field absent" from
 * "field present but empty", and the timeline route rejects an unscoped read.
 */
export interface IntelHistoryScope {
  domain?: string;
  country?: string;
  from?: number;
  to?: number;
  limit: number;
}

/** One record as convex/intelHistory.ts:projectRecord emits it. */
interface WireRecord {
  id?: unknown;
  domain?: unknown;
  resource?: unknown;
  country?: unknown;
  category?: unknown;
  title?: unknown;
  summary?: unknown;
  sourceUrl?: unknown;
  occurredAt?: unknown;
  ingestedAt?: unknown;
  _score?: unknown;
}

/**
 * Structural mirror of the generated `IntelHistoryRecord` (proto
 * intel_history_record.proto). Declared here rather than imported so this
 * module stays independent of src/generated; the handlers assign these into
 * the generated response types, so any proto field change fails typecheck at
 * the call sites.
 */
export interface IntelHistoryRecordView {
  id: string;
  domain: string;
  resource: string;
  country: string;
  category: string;
  title: string;
  summary: string;
  sourceUrl: string;
  occurredAt: number;
  ingestedAt: number;
  score: number;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Adapt one stored record to the wire shape. `_score` is present only on the
 * vector path; a chronological read leaves it 0, which the proto documents as
 * "no similarity applies" rather than "no similarity".
 */
export function toIntelHistoryRecord(raw: WireRecord): IntelHistoryRecordView {
  return {
    id: str(raw.id),
    domain: str(raw.domain),
    resource: str(raw.resource),
    country: str(raw.country),
    category: str(raw.category),
    title: str(raw.title),
    summary: str(raw.summary),
    sourceUrl: str(raw.sourceUrl),
    occurredAt: num(raw.occurredAt),
    ingestedAt: num(raw.ingestedAt),
    score: num(raw._score),
  };
}

/**
 * Resolve a request limit: the server-side default when omitted or <= 0,
 * otherwise the requested value capped at the route's ceiling. The ceilings
 * mirror the clamps in convex/intelHistory.ts, so a caller never receives
 * fewer rows than the API documents without an explanation.
 */
export function resolveLimit(requested: unknown, fallback: number, max: number): number {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/** Drop empty scope fields so convex/http.ts sees them as absent. */
function scopeBody(scope: IntelHistoryScope): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (scope.domain) body.domain = scope.domain;
  if (scope.country) body.country = scope.country;
  if (scope.from && scope.from > 0) body.from = scope.from;
  if (scope.to && scope.to > 0) body.to = scope.to;
  body.limit = scope.limit;
  return body;
}

/**
 * POST one of the two secret-guarded internal read routes. Returns null on a
 * missing configuration, a non-2xx, a malformed body, or a timeout — the
 * caller turns that into `upstream_unavailable`.
 */
async function readIntelHistory(
  path: string,
  payload: Record<string, unknown>,
): Promise<{ records: IntelHistoryRecordView[] } | null> {
  const siteUrl = getConvexSiteUrl();
  const sharedSecret = getConvexSharedSecret();
  if (!siteUrl || !sharedSecret) return null;

  try {
    const resp = await fetch(`${siteUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'worldmonitor-gateway/1.0',
        'x-convex-shared-secret': sharedSecret,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONVEX_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`[intel-history] ${path} returned HTTP ${resp.status}`);
      return null;
    }
    const body = (await resp.json()) as { records?: unknown };
    if (!Array.isArray(body?.records)) {
      console.warn(`[intel-history] ${path} returned no records array`);
      return null;
    }
    return {
      records: (body.records as WireRecord[])
        .filter((rec): rec is WireRecord => rec !== null && typeof rec === 'object')
        .map(toIntelHistoryRecord),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[intel-history] ${path} failed: ${msg}`);
    return null;
  }
}

/** Semantic read: rank stored history against a query vector. */
export function intelHistorySearch(
  params: IntelHistoryScope & { embedding: number[] },
): Promise<{ records: IntelHistoryRecordView[] } | null> {
  const { embedding, ...scope } = params;
  return readIntelHistory(CONVEX_INTERNAL_SEARCH_PATH, { embedding, ...scopeBody(scope) });
}

/**
 * Chronological read. At least one of domain/country must be set — the caller
 * enforces that and returns 400, because Convex answers an unscoped read with
 * a 500 that this layer could only report as an outage.
 */
export function intelHistoryTimeline(
  scope: IntelHistoryScope,
): Promise<{ records: IntelHistoryRecordView[] } | null> {
  return readIntelHistory(CONVEX_INTERNAL_TIMELINE_PATH, scopeBody(scope));
}
