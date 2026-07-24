/**
 * RPC: getHumanitarianSummary -- reads the humanitarian summary cache that
 * scripts/seed-conflict-intel.mjs populates from HDX HAPI.
 *
 * Deliberately does NOT call HAPI directly on a cache miss. HDX's
 * `app_identifier` rate limiting is tracked per-identifier, not per-IP
 * (confirmed live: a fresh identifier from the same IP at the same instant
 * got 200s while the flagged one got 429s — see #5554), so every HAPI call
 * this app makes shares the same throttle bucket. A per-request fetch here
 * would stack uncoordinated bursts on top of the seeder's own paced loop
 * and blow HDX's ~1 req/s courtesy limit again within days. The seeder is
 * the ONLY source of HAPI traffic; this handler just reads what it wrote.
 */

import type {
  ServerContext,
  GetHumanitarianSummaryRequest,
  GetHumanitarianSummaryResponse,
} from '../../../../src/generated/server/worldmonitor/conflict/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';

const REDIS_CACHE_KEY = 'conflict:humanitarian:v1';

export async function getHumanitarianSummary(
  _ctx: ServerContext,
  req: GetHumanitarianSummaryRequest,
): Promise<GetHumanitarianSummaryResponse> {
  if (!req.countryCode) return { summary: undefined };
  try {
    const cached = (await getCachedJson(`${REDIS_CACHE_KEY}:${req.countryCode}`)) as
      | GetHumanitarianSummaryResponse
      | null;
    return cached ?? { summary: undefined };
  } catch {
    return { summary: undefined };
  }
}
