import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetSimilarEventsRequest,
  GetSimilarEventsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  embedQueryText,
  intelHistorySearch,
  resolveLimit,
} from '../../../_shared/intel-history-client';

/**
 * Server-side default when the request omits `limit`. Half of
 * SearchIntelHistory's default: a precedent list is read end to end by a human
 * or an LLM, not scrolled, and long tails of weak matches dilute it.
 */
const DEFAULT_LIMIT = 10;

/** Hard cap, well inside SEARCH_MAX_LIMIT in convex/intelHistory.ts. */
const MAX_LIMIT = 32;

/**
 * GetSimilarEvents handler.
 *
 * "Has anything like this happened before?" — the same vector search as
 * SearchIntelHistory, run over a description of a developing situation rather
 * than a search phrase, and returning a deliberately short precedent list.
 *
 * Shares SearchIntelHistory's failure posture: an embeddings-provider or
 * history-store outage returns an empty result flagged `upstreamUnavailable`
 * so the gateway does not cache it. Premium-gated and rate-limited fail-closed
 * for the same reason — every cache miss spends one embeddings call.
 */
export const getSimilarEvents: IntelligenceServiceHandler['getSimilarEvents'] = async (
  _ctx: ServerContext,
  req: GetSimilarEventsRequest,
): Promise<GetSimilarEventsResponse> => {
  const situation = typeof req.situation === 'string' ? req.situation : '';
  const limit = resolveLimit(req.limit, DEFAULT_LIMIT, MAX_LIMIT);

  const embedding = await embedQueryText(situation);
  if (!embedding) {
    return { records: [], situation, upstreamUnavailable: true };
  }

  const result = await intelHistorySearch({
    embedding,
    domain: req.domain,
    country: req.country,
    limit,
  });
  if (!result) {
    return { records: [], situation, upstreamUnavailable: true };
  }

  return { records: result.records, situation, upstreamUnavailable: false };
};
