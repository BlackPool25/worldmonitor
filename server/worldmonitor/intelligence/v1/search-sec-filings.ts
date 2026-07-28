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
import { EDGAR_FORMS_RE, EDGAR_ISO_DATE_RE, searchEdgarFullText } from '../../../_shared/sec-edgar';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const ISO_DATE_RE = EDGAR_ISO_DATE_RE;
const FORMS_RE = EDGAR_FORMS_RE;

export async function searchSecFilings(
  _ctx: ServerContext,
  req: SearchSecFilingsRequest,
): Promise<SearchSecFilingsResponse> {
  const query = req.query?.trim();
  if (!query) {
    throw new ValidationError([{ field: 'query', description: 'query is required' }]);
  }

  // Fail closed on malformed filters. Silently dropping one WIDENS the result
  // set, so a typo'd date range would return unrelated filings while the caller
  // believes the range was applied.
  const violations = [
    ...(req.forms && !FORMS_RE.test(req.forms)
      ? [{ field: 'forms', description: 'forms must be a comma-separated form list such as "8-K" or "10-K,10-Q"' }]
      : []),
    ...(req.startDate && !ISO_DATE_RE.test(req.startDate)
      ? [{ field: 'start_date', description: 'start_date must be YYYY-MM-DD' }]
      : []),
    ...(req.endDate && !ISO_DATE_RE.test(req.endDate)
      ? [{ field: 'end_date', description: 'end_date must be YYYY-MM-DD' }]
      : []),
  ];
  if (violations.length > 0) throw new ValidationError(violations);

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
    // The upstream query time carried in the cached value — not "now", which
    // would report a 15-minute-old cached result as freshly fetched.
    fetchedAtMs: result.fetchedAtMs ?? 0,
  };
}
