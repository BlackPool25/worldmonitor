// @ts-check
import { getRelayBaseUrl, getRelayHeaders, fetchWithTimeout, buildRelayResponse } from './_relay.js';
import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { jsonResponse } from './_json-response.js';
import { captureSilentError } from './_sentry-edge.js';

export const config = { runtime: 'edge' };

const EPOCH_ISO = new Date(0).toISOString();

/**
 * @typedef {{
 *   id?: string | number;
 *   postId?: string | number;
 *   accountId?: string | number;
 *   account?: string;
 *   accountTitle?: string;
 *   accountName?: string;
 *   handle?: string;
 *   sourceUrl?: string;
 *   url?: string;
 *   permalink?: string;
 *   timestamp?: string | number;
 *   timestampMs?: string | number;
 *   ts?: string | number;
 *   text?: string;
 *   topic?: string;
 *   tags?: unknown[];
 *   earlySignal?: boolean;
 *   hasMedia?: boolean;
 *   lang?: string;
 *   contentState?: string;
 * }} RawXPost
 */

/**
 * @typedef {{
 *   enabled?: boolean;
 *   source?: string;
 *   earlySignal?: boolean;
 *   updatedAt?: string | null;
 *   lastHealthyAt?: string | null;
 *   coverage?: { expected?: number; polled?: number; failed?: number; attempted?: number; complete?: boolean };
 *   count?: number;
 *   posts?: RawXPost[];
 *   items?: RawXPost[];
 * }} RawXFeedResponse
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return value == null ? '' : String(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toHttpUrl(value) {
  const raw = toText(value).trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toIsoTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return EPOCH_ISO;
    return new Date(value >= 1e12 ? value : value * 1000).toISOString();
  }
  const raw = toText(value).trim();
  if (!raw) return EPOCH_ISO;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    return new Date(numeric >= 1e12 ? numeric : numeric * 1000).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) && parsed > 0 ? new Date(parsed).toISOString() : EPOCH_ISO;
}

/**
 * @param {unknown[] | undefined} values
 * @returns {string[]}
 */
function toTextArray(values) {
  if (!Array.isArray(values)) return [];
  return values.map(toText).filter(Boolean);
}

/**
 * First-party panel contract. API-fresh post text is allowed here.
 * MCP/embed partners must use list-x-feed (facts + permalink only).
 * @param {RawXPost} post
 */
function normalizeXPost(post) {
  const handle = toText(post.handle ?? post.account).trim();
  const accountTitle = toText(post.accountTitle ?? post.accountName ?? post.account ?? handle).trim();
  const ts = toIsoTimestamp(post.timestampMs ?? post.timestamp ?? post.ts);
  const text = toText(post.text).trim();
  const postId = toText(post.postId ?? post.id).trim();
  const id = toText(post.id).trim() || `${handle || 'x'}:${postId || ts}`;

  return {
    id,
    postId,
    source: 'x',
    account: handle,
    accountId: toText(post.accountId).trim(),
    accountTitle: accountTitle || handle,
    url: toHttpUrl(post.permalink ?? post.sourceUrl ?? post.url),
    ts,
    text,
    topic: toText(post.topic).trim(),
    tags: toTextArray(post.tags),
    earlySignal: Boolean(post.earlySignal),
    hasMedia: Boolean(post.hasMedia),
    lang: toText(post.lang).trim(),
    contentState: toText(post.contentState).trim() || 'active',
  };
}

/**
 * @param {RawXFeedResponse} parsed
 */
function normalizeXFeed(parsed) {
  const rawPosts = Array.isArray(parsed.posts)
    ? parsed.posts
    : Array.isArray(parsed.items)
      ? parsed.items
      : [];
  const items = rawPosts
    .map(normalizeXPost)
    .filter((item) => item.contentState !== 'deleted');
  const coverage = {
    expected: Math.max(0, Math.floor(Number(parsed.coverage?.expected) || 0)),
    polled: Math.max(0, Math.floor(Number(parsed.coverage?.polled) || 0)),
    failed: Math.max(0, Math.floor(Number(parsed.coverage?.failed) || 0)),
    attempted: Math.max(0, Math.floor(Number(parsed.coverage?.attempted) || 0)),
    complete: parsed.coverage?.complete === true,
  };
  return {
    source: toText(parsed.source).trim() || 'x',
    earlySignal: Boolean(parsed.earlySignal),
    enabled: parsed.enabled !== false,
    count: items.length,
    updatedAt: parsed.updatedAt ?? null,
    lastHealthyAt: parsed.lastHealthyAt ?? null,
    degraded: coverage.expected > 0 && !coverage.complete,
    coverage,
    items,
  };
}

export default async function handler(req) {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return jsonResponse({ error: 'Origin not allowed' }, 403, corsHeaders);
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  }

  const relayBaseUrl = getRelayBaseUrl();
  if (!relayBaseUrl) {
    return jsonResponse({ error: 'WS_RELAY_URL is not configured' }, 503, corsHeaders);
  }

  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
    const topic = (url.searchParams.get('topic') || '').trim();
    const account = (url.searchParams.get('account') || url.searchParams.get('channel') || '').trim();
    const params = new URLSearchParams();
    params.set('limit', String(limit));
    if (topic) params.set('topic', topic);
    if (account) params.set('account', account);

    const relayUrl = `${relayBaseUrl}/x/feed?${params}`;
    const response = await fetchWithTimeout(relayUrl, {
      headers: getRelayHeaders({ Accept: 'application/json', 'User-Agent': 'WorldMonitor-X-Feed/1.0' }),
    }, 15000);

    const body = await response.text();

    let cacheControl = 'public, max-age=30, s-maxage=120, stale-while-revalidate=60, stale-if-error=120';
    if (!response.ok) {
      return buildRelayResponse(response, body, {
        'Cache-Control': 'no-store',
        ...corsHeaders,
      });
    }

    try {
      const parsed = /** @type {RawXFeedResponse} */ (JSON.parse(body));
      const normalized = normalizeXFeed(parsed);
      if (normalized.count === 0) {
        cacheControl = 'public, max-age=0, s-maxage=15, stale-while-revalidate=10';
      }
      return buildRelayResponse(response, JSON.stringify(normalized), {
        'Cache-Control': cacheControl,
        ...corsHeaders,
      });
    } catch (normalizeError) {
      console.warn('[x-feed] normalization failed:', normalizeError?.message || String(normalizeError));
      void captureSilentError(normalizeError, { tags: { route: 'api/x-feed', step: 'normalize' } });
    }

    return buildRelayResponse(response, body, {
      'Cache-Control': cacheControl,
      ...corsHeaders,
    });
  } catch (error) {
    const isTimeout = error?.name === 'AbortError';
    return jsonResponse({
      error: isTimeout ? 'Relay timeout' : 'Relay request failed',
      details: error?.message || String(error),
    }, isTimeout ? 504 : 502, { 'Cache-Control': 'no-store', ...corsHeaders });
  }
}
