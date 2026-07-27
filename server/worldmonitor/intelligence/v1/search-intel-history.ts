import type {
  IntelligenceServiceHandler,
  ServerContext,
  SearchIntelHistoryRequest,
  SearchIntelHistoryResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  embedQueryText,
  intelHistorySearch,
  resolveLimit,
} from '../../../_shared/intel-history-client';

/** Server-side default when the request omits `limit`. */
const DEFAULT_LIMIT = 20;

/** Hard cap — SEARCH_MAX_LIMIT in convex/intelHistory.ts. */
const MAX_LIMIT = 64;

/**
 * SearchIntelHistory handler.
 *
 * Embeds the caller's query, then ranks the durable history store
 * (convex/intelHistory.ts) against that vector. Pure read: nothing is written
 * back to Redis, which keeps the route's MCP parity classification clean.
 *
 * Either upstream failing — the embeddings provider or the history store —
 * returns an empty result with `upstreamUnavailable: true` rather than a 5xx,
 * so the gateway serves the response with Cache-Control: no-store instead of
 * caching an empty history for the slow tier's TTL. The embedding failure is
 * checked first and short-circuits: searching with a substitute vector would
 * return arbitrary rows presented as genuine matches.
 *
 * Premium-gated at the gateway via PREMIUM_RPC_PATHS + ENDPOINT_ENTITLEMENTS,
 * and rate-limited fail-closed (server/_shared/rate-limit.ts) because every
 * cache miss spends one embeddings call.
 */
export const searchIntelHistory: IntelligenceServiceHandler['searchIntelHistory'] = async (
  _ctx: ServerContext,
  req: SearchIntelHistoryRequest,
): Promise<SearchIntelHistoryResponse> => {
  const query = typeof req.query === 'string' ? req.query : '';
  const limit = resolveLimit(req.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const embedding = await embedQueryText(query);
  if (!embedding) {
    return { records: [], query, upstreamUnavailable: true };
  }

  const result = await intelHistorySearch({
    embedding,
    domain: req.domain,
    country: req.country,
    from: req.from,
    to: req.to,
    limit,
  });
  if (!result) {
    return { records: [], query, upstreamUnavailable: true };
  }

  return { records: result.records, query, upstreamUnavailable: false };
};
