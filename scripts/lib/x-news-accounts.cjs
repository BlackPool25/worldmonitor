'use strict';

/**
 * Curated X news-account monitoring (Track A / #6654).
 *
 * Product-managed public news-account registry helpers used by ais-relay.
 * Official X API only. Post text is R4: first-party panels may show API-fresh
 * bodies; alerts/MCP/embed partners receive derived facts + permalink only.
 */

const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const X_ACCOUNT_ID = /^[1-9]\d{0,18}$/;
const X_API_ORIGIN = 'https://api.x.com';
const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_INTERVAL_MS = 15 * 60 * 1000;
const TOMBSTONE_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_FEED_ITEMS = 200;
const DEFAULT_MAX_TEXT_CHARS = 800;
const DEFAULT_MAX_MESSAGES = 10;
const DEFAULT_STAGGER_MS = 200;
const MAX_TWEET_LOOKUP_IDS = 100;
const USER_AGENT = 'WorldMonitor/1.0 (curated news-account monitoring; +https://worldmonitor.app)';

function toText(value) {
  return value == null ? '' : String(value);
}

function normalizeHandle(value) {
  const handle = toText(value).trim().replace(/^@/, '');
  if (!X_HANDLE.test(handle)) return '';
  return handle;
}

function normalizeAccountId(value) {
  const id = toText(value).trim();
  return X_ACCOUNT_ID.test(id) ? id : '';
}

function clampPollIntervalMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_POLL_INTERVAL_MS;
  return Math.min(MAX_POLL_INTERVAL_MS, Math.max(MIN_POLL_INTERVAL_MS, Math.floor(n)));
}

function loadXAccounts(raw, options = {}) {
  const set = String(options.set || 'full').toLowerCase();
  const bucket = raw?.channels?.[set];
  const rows = Array.isArray(bucket) ? bucket : [];
  return rows
    .filter((row) => row && typeof row.handle === 'string')
    .map((row) => {
      const handle = normalizeHandle(row.handle);
      const accountId = normalizeAccountId(row.accountId);
      return {
        handle,
        accountId,
        label: row.label ? String(row.label) : handle,
        sourceName: row.sourceName ? String(row.sourceName) : (row.label ? String(row.label) : handle),
        topic: row.topic ? String(row.topic) : 'other',
        region: row.region ? String(row.region) : undefined,
        tier: row.tier != null ? Number(row.tier) : undefined,
        enabled: row.enabled !== false,
        maxMessages: row.maxMessages != null ? Number(row.maxMessages) : DEFAULT_MAX_MESSAGES,
      };
    })
    .filter((row) => row.handle && row.enabled);
}

function countEnabledAccounts(raw) {
  const channels = raw?.channels || {};
  let count = 0;
  for (const bucket of Object.values(channels)) {
    if (!Array.isArray(bucket)) continue;
    for (const row of bucket) {
      if (row && row.enabled !== false && normalizeHandle(row.handle)) count += 1;
    }
  }
  return count;
}

function permalinkFor(handle, postId) {
  return `https://x.com/${handle}/status/${postId}`;
}

function normalizeXPost(tweet, account, options = {}) {
  const maxChars = Number.isFinite(options.maxTextChars) ? options.maxTextChars : DEFAULT_MAX_TEXT_CHARS;
  const postId = normalizeAccountId(tweet?.id);
  const handle = normalizeHandle(account?.handle);
  if (!postId || !handle) return null;
  const textRaw = toText(tweet?.text);
  const createdAt = tweet?.created_at ? new Date(tweet.created_at).toISOString() : new Date().toISOString();
  const metrics = tweet?.public_metrics && typeof tweet.public_metrics === 'object' ? tweet.public_metrics : {};
  const referenced = Array.isArray(tweet?.referenced_tweets) ? tweet.referenced_tweets : [];
  const isReply = referenced.some((ref) => ref && ref.type === 'replied_to');
  const isQuote = referenced.some((ref) => ref && ref.type === 'quoted');
  const mediaKeys = Array.isArray(tweet?.attachments?.media_keys) ? tweet.attachments.media_keys : [];
  return {
    id: `${handle}:${postId}`,
    postId,
    source: 'x',
    account: handle,
    accountId: normalizeAccountId(account?.accountId) || '',
    accountTitle: account?.label || handle,
    sourceName: account?.sourceName || account?.label || handle,
    url: permalinkFor(handle, postId),
    ts: createdAt,
    text: textRaw.slice(0, maxChars),
    topic: account?.topic || 'other',
    tags: [account?.region].filter(Boolean),
    lang: tweet?.lang ? String(tweet.lang) : '',
    hasMedia: mediaKeys.length > 0,
    isReply,
    isQuote,
    likeCount: Number.isFinite(metrics.like_count) ? metrics.like_count : 0,
    replyCount: Number.isFinite(metrics.reply_count) ? metrics.reply_count : 0,
    repostCount: Number.isFinite(metrics.retweet_count) ? metrics.retweet_count : 0,
    earlySignal: true,
    storageState: 'metadata_only',
    contentState: 'active',
  };
}

function derivedAlertFacts(item) {
  const accountTitle = item?.accountTitle || item?.account || 'X';
  const topic = item?.topic || 'update';
  const facts = [
    `${accountTitle} posted a ${topic} update`,
    item?.hasMedia ? 'includes media' : null,
    item?.isReply ? 'is a reply' : null,
    item?.lang ? `lang=${item.lang}` : null,
  ].filter(Boolean);
  const postId = item?.postId || item?.id || '';
  const title = postId
    ? `${accountTitle} posted a ${topic} update (${postId})`
    : facts[0];
  return {
    title,
    source: item?.sourceName || accountTitle,
    link: item?.url || '',
    publishedAt: item?.ts ? Date.parse(item.ts) : Date.now(),
    facts,
    permalink: item?.url || '',
  };
}

function collectXAlertCandidates(items, sourceTiers, now = Date.now(), recencyMs = 6 * 60 * 60 * 1000) {
  const candidates = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || item.contentState === 'deleted') continue;
    const facts = derivedAlertFacts(item);
    if (!facts.title || !facts.source) continue;
    if (facts.publishedAt && recencyMs > 0 && (now - facts.publishedAt) > recencyMs) continue;
    if (!alertSourcePassesTierGate(facts.source, sourceTiers)) continue;
    candidates.push({
      title: facts.title,
      source: facts.source,
      publishedAt: facts.publishedAt,
      corroborationCount: 1,
      link: facts.permalink,
    });
  }
  return candidates;
}

function toMcpItem(item) {
  const facts = derivedAlertFacts(item);
  return {
    id: item?.id || '',
    accountId: item?.accountId || '',
    accountName: item?.accountTitle || item?.account || '',
    handle: item?.account || '',
    topic: item?.topic || '',
    timestampMs: item?.ts ? Date.parse(item.ts) || 0 : 0,
    permalink: facts.permalink,
    facts: facts.facts,
    hasMedia: Boolean(item?.hasMedia),
    lang: item?.lang || '',
    contentState: item?.contentState || 'active',
  };
}

function mergeAndDedup(existing, incoming, maxItems = DEFAULT_MAX_FEED_ITEMS) {
  const seen = new Set();
  return [...incoming, ...existing]
    .filter((item) => {
      if (!item?.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')))
    .slice(0, maxItems);
}

function tombstonePosts(items, missingIds, now = Date.now()) {
  const missing = new Set([...missingIds].map((id) => String(id)));
  return items.map((item) => {
    if (!missing.has(String(item.postId)) && !missing.has(String(item.id))) return item;
    if (item.contentState === 'deleted') return item;
    return {
      ...item,
      text: '',
      storageState: 'tombstone',
      contentState: 'deleted',
      deletedAt: new Date(now).toISOString(),
    };
  });
}

function purgeExpiredTombstones(items, now = Date.now(), ttlMs = TOMBSTONE_TTL_MS) {
  return items.filter((item) => {
    if (item.contentState !== 'deleted') return true;
    const deletedAt = Date.parse(item.deletedAt || '');
    if (!Number.isFinite(deletedAt)) return false;
    return (now - deletedAt) < ttlMs;
  });
}

function alertSourcePassesTierGate(sourceName, sourceTiers) {
  const tier = Object.prototype.hasOwnProperty.call(sourceTiers, sourceName)
    ? Number(sourceTiers[sourceName])
    : 4;
  return Number.isFinite(tier) && tier !== 4;
}

function parseRetryAfterMs(headers) {
  const raw = headers?.get?.('retry-after') ?? headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (raw == null || raw === '') return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return 0;
}

function compute429BackoffMs(headers, attempt = 0) {
  const retryAfter = parseRetryAfterMs(headers);
  if (retryAfter > 0) return retryAfter;
  const exp = Math.min(6, Math.max(0, Number(attempt) || 0));
  return Math.min(15 * 60 * 1000, 1000 * (2 ** exp));
}

function buildUserByUsernameUrl(handle) {
  const normalized = normalizeHandle(handle);
  const url = new URL(`/2/users/by/username/${encodeURIComponent(normalized)}`, X_API_ORIGIN);
  url.searchParams.set('user.fields', 'id,name,username,protected');
  return url;
}

function buildUserTimelineUrl({ accountId, sinceId, maxResults }) {
  const id = normalizeAccountId(accountId);
  const url = new URL(`/2/users/${encodeURIComponent(id)}/tweets`, X_API_ORIGIN);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(100, maxResults || DEFAULT_MAX_MESSAGES))));
  url.searchParams.set('tweet.fields', 'created_at,lang,public_metrics,referenced_tweets,attachments,edit_history_tweet_ids');
  url.searchParams.set('exclude', 'retweets,replies');
  if (sinceId) url.searchParams.set('since_id', String(sinceId));
  return url;
}

function buildTweetsLookupUrl(ids) {
  const unique = [...new Set(ids.map((id) => normalizeAccountId(id)).filter(Boolean))].slice(0, MAX_TWEET_LOOKUP_IDS);
  const url = new URL('/2/tweets', X_API_ORIGIN);
  url.searchParams.set('ids', unique.join(','));
  url.searchParams.set('tweet.fields', 'id');
  return { url, ids: unique };
}

async function xFetchJson(fetchImpl, url, bearerToken, { timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { response, body };
}

function sleep(ms, wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))) {
  return wait(ms);
}

/**
 * One poll cycle: resolve missing account IDs, fetch since_id timelines,
 * merge/dedup, then optionally tombstone IDs missing from a lookup.
 */
async function pollXFeed({
  accounts,
  state,
  bearerToken,
  fetchImpl,
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxFeedItems = DEFAULT_MAX_FEED_ITEMS,
  maxTextChars = DEFAULT_MAX_TEXT_CHARS,
  staggerMs = DEFAULT_STAGGER_MS,
  lookupDeletions = true,
} = {}) {
  const nextState = {
    cursorByAccountId: { ...(state?.cursorByAccountId || {}) },
    accountIdByHandle: { ...(state?.accountIdByHandle || {}) },
    items: Array.isArray(state?.items) ? [...state.items] : [],
    lookupOffset: Number(state?.lookupOffset) || 0,
    lastError: null,
    rateLimitedUntil: 0,
    accountsPolled: 0,
    accountsFailed: 0,
    newCount: 0,
  };
  if (!bearerToken) {
    nextState.lastError = 'X_BEARER_TOKEN is not configured';
    return nextState;
  }

  const newItems = [];
  for (const account of accounts) {
    if (nextState.rateLimitedUntil) break;
    let accountId = normalizeAccountId(account.accountId) || nextState.accountIdByHandle[account.handle];
    try {
      if (!accountId) {
        const { response, body } = await xFetchJson(fetchImpl, buildUserByUsernameUrl(account.handle), bearerToken);
        if (response.status === 429) {
          nextState.rateLimitedUntil = now() + compute429BackoffMs(response.headers, 0);
          nextState.lastError = `rate limited resolving @${account.handle}`;
          break;
        }
        if (!response.ok || !body?.data?.id) {
          nextState.accountsFailed += 1;
          nextState.lastError = `user lookup @${account.handle} failed: HTTP ${response.status}`;
          await sleep(staggerMs, wait);
          continue;
        }
        accountId = normalizeAccountId(body.data.id);
        nextState.accountIdByHandle[account.handle] = accountId;
      }

      const sinceId = nextState.cursorByAccountId[accountId];
      const url = buildUserTimelineUrl({
        accountId,
        sinceId,
        maxResults: account.maxMessages || DEFAULT_MAX_MESSAGES,
      });
      const { response, body } = await xFetchJson(fetchImpl, url, bearerToken);
      if (response.status === 429) {
        nextState.rateLimitedUntil = now() + compute429BackoffMs(response.headers, 0);
        nextState.lastError = `rate limited polling @${account.handle}`;
        break;
      }
      if (!response.ok) {
        nextState.accountsFailed += 1;
        nextState.lastError = `timeline @${account.handle} failed: HTTP ${response.status}`;
        await sleep(staggerMs, wait);
        continue;
      }

      const tweets = Array.isArray(body?.data) ? body.data : [];
      const boundAccount = { ...account, accountId };
      for (const tweet of tweets) {
        const item = normalizeXPost(tweet, boundAccount, { maxTextChars });
        if (!item) continue;
        newItems.push(item);
        if (!nextState.cursorByAccountId[accountId] ||
            BigInt(item.postId) > BigInt(nextState.cursorByAccountId[accountId])) {
          nextState.cursorByAccountId[accountId] = item.postId;
        }
      }
      nextState.accountsPolled += 1;
      await sleep(staggerMs, wait);
    } catch (error) {
      nextState.accountsFailed += 1;
      nextState.lastError = `poll @${account.handle} failed: ${error?.message || String(error)}`;
    }
  }

  nextState.items = mergeAndDedup(nextState.items, newItems, maxFeedItems);
  nextState.newCount = newItems.length;

  if (lookupDeletions && nextState.items.length && !nextState.rateLimitedUntil) {
    const activeIds = nextState.items
      .filter((item) => item.contentState !== 'deleted')
      .map((item) => item.postId)
      .filter(Boolean);
    const offset = Number(state?.lookupOffset) || 0;
    const rotated = activeIds.length
      ? [...activeIds.slice(offset % activeIds.length), ...activeIds.slice(0, offset % activeIds.length)]
      : [];
    nextState.lookupOffset = activeIds.length ? (offset + MAX_TWEET_LOOKUP_IDS) % activeIds.length : 0;
    if (rotated.length) {
      const { url, ids } = buildTweetsLookupUrl(rotated);
      try {
        const { response, body } = await xFetchJson(fetchImpl, url, bearerToken);
        if (response.status === 429) {
          nextState.rateLimitedUntil = now() + compute429BackoffMs(response.headers, 0);
          nextState.lastError = 'rate limited during deletion lookup';
        } else if (response.ok) {
          const found = new Set((Array.isArray(body?.data) ? body.data : []).map((row) => String(row.id)));
          const missing = ids.filter((id) => !found.has(String(id)));
          if (missing.length) nextState.items = tombstonePosts(nextState.items, missing, now());
        }
      } catch (error) {
        nextState.lastError = `deletion lookup failed: ${error?.message || String(error)}`;
      }
    }
  }

  nextState.items = purgeExpiredTombstones(nextState.items, now(), TOMBSTONE_TTL_MS);
  return nextState;
}

module.exports = {
  X_API_ORIGIN,
  USER_AGENT,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MAX_POLL_INTERVAL_MS,
  TOMBSTONE_TTL_MS,
  DEFAULT_MAX_FEED_ITEMS,
  loadXAccounts,
  countEnabledAccounts,
  normalizeHandle,
  normalizeAccountId,
  clampPollIntervalMs,
  normalizeXPost,
  derivedAlertFacts,
  collectXAlertCandidates,
  toMcpItem,
  mergeAndDedup,
  tombstonePosts,
  purgeExpiredTombstones,
  alertSourcePassesTierGate,
  parseRetryAfterMs,
  compute429BackoffMs,
  buildUserByUsernameUrl,
  buildUserTimelineUrl,
  buildTweetsLookupUrl,
  pollXFeed,
};
