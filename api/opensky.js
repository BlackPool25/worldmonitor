import { createRelayHandler } from './_relay.js';
import { isDesktopOrigin } from './_api-key.js';
import { getCorsHeaders } from './_cors.js';
import { jsonResponse } from './_json-response.js';

export const config = { runtime: 'edge' };

const relayHandler = createRelayHandler({
  relayPath: '/opensky',
  timeout: 20000,
  requireApiKey: true,
  cacheHeaders: () => ({
    'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60, stale-if-error=300',
  }),
  extraHeaders: (response) => {
    const xCache = response.headers.get('x-cache');
    return xCache ? { 'X-Cache': xCache } : {};
  },
});

export default function handler(req) {
  const origin = req.headers.get('Origin') || '';
  if (!isDesktopOrigin(origin)) {
    return jsonResponse({ error: 'Not found' }, 404, getCorsHeaders(req, 'GET, OPTIONS'));
  }
  return relayHandler(req);
}
