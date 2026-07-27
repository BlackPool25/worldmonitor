/**
 * RPC: searchSecFilings — full-text search over SEC EDGAR filings (issue #5695).
 * Thin fetch-on-miss proxy over efts.sec.gov with per-query Redis caching
 * (server/_shared/sec-edgar.searchEdgarFullText).
 */

import type {
  ServerContext,
  SearchSecFilingsRequest,
  SearchSecFilingsResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { searchEdgarFullText } from '../../../_shared/sec-edgar';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export async function searchSecFilings(
  _ctx: ServerContext,
  req: SearchSecFilingsRequest,
): Promise<SearchSecFilingsResponse> {
  const query = req.query?.trim();
  if (!query) {
    throw new ValidationError([{ field: 'query', description: 'query is required' }]);
  }

  const limit = req.limit > 0 ? Math.min(req.limit, MAX_LIMIT) : DEFAULT_LIMIT;

  const result = await searchEdgarFullText({
    query,
    forms: req.forms,
    startDate: req.startDate,
    endDate: req.endDate,
  });

  if (!result) {
    return { results: [], total: 0, unavailable: true, fetchedAtMs: Date.now() };
  }

  return {
    results: result.results.slice(0, limit),
    total: result.total,
    unavailable: false,
    fetchedAtMs: Date.now(),
  };
}
