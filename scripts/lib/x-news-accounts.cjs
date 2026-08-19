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
const DEFAULT_MAX_TIMELINE_PAGES = 10;
const X_FEED_SNAPSHOT_VERSION = 1;
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
  // The normal serving set is the union, not one registry bucket. Buckets are
  // editorial views and overlap as the registry evolves; `set` remains an
  // explicit operator override for constrained runs.
  const requestedSet = Object.prototype.hasOwnProperty.call(options, 'set') && options.set != null
    ? String(options.set).trim().toLowerCase()
    : '';
  const hasExplicitSet = requestedSet !== '' && requestedSet !== 'all' && requestedSet !== '*';
  const set = hasExplicitSet ? requestedSet : '';
  const channels = raw?.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const rows = hasExplicitSet
    ? (Array.isArray(channels[set]) ? channels[set] : [])
    : Object.values(channels).flatMap((bucket) => Array.isArray(bucket) ? bucket : []);
  const seen = new Set();
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
    .filter((row) => {
      if (!row.handle || !row.enabled) return false;
      const key = row.accountId ? `id:${row.accountId}` : `handle:${row.handle.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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

function copyCursorMap(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [accountId, cursor] of Object.entries(value)) {
    const normalizedAccountId = normalizeAccountId(accountId);
    const normalizedCursor = normalizeAccountId(cursor);
    if (normalizedAccountId && normalizedCursor) result[normalizedAccountId] = normalizedCursor;
  }
  return result;
}

function copyAccountIdMap(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [handle, accountId] of Object.entries(value)) {
    const normalizedHandle = normalizeHandle(handle);
    const normalizedAccountId = normalizeAccountId(accountId);
    if (normalizedHandle && normalizedAccountId) result[normalizedHandle] = normalizedAccountId;
  }
  return result;
}

function copyCatchupMap(value) {
  const result = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [rawAccountId, rawCatchup] of Object.entries(value)) {
    const accountId = normalizeAccountId(rawAccountId);
    if (!accountId || !rawCatchup || typeof rawCatchup !== 'object' || Array.isArray(rawCatchup)) continue;
    const sinceId = normalizeAccountId(rawCatchup.sinceId);
    const paginationToken = String(rawCatchup.paginationToken || '').trim();
    const newestPostId = normalizeAccountId(rawCatchup.newestPostId) || sinceId;
    if (sinceId && paginationToken) {
      result[accountId] = { sinceId, paginationToken, newestPostId };
    }
  }
  return result;
}

function normalizeCoverage(value, expectedAccounts = 0) {
  const expected = Math.max(0, Math.floor(Number(value?.expected ?? expectedAccounts) || 0));
  const polled = Math.max(0, Math.floor(Number(value?.polled) || 0));
  const failed = Math.max(0, Math.floor(Number(value?.failed) || 0));
  const attempted = Math.max(0, Math.floor(Number(value?.attempted) || 0));
  return {
    expected,
    polled,
    failed,
    attempted,
    complete: Boolean(value?.complete) && expected > 0 && polled === expected && failed === 0,
  };
}

function buildXPollState(state, { expectedAccounts = 0 } = {}) {
  const lastPollAt = Number(state?.lastPollAt) || 0;
  const coverage = normalizeCoverage(state?.lastCoverage, expectedAccounts);
  return {
    generation: Math.max(0, Math.floor(Number(state?.generation) || 0)),
    cursorByAccountId: copyCursorMap(state?.cursorByAccountId),
    accountIdByHandle: copyAccountIdMap(state?.accountIdByHandle),
    catchupByAccountId: copyCatchupMap(state?.catchupByAccountId),
    lookupOffset: Math.max(0, Math.floor(Number(state?.lookupOffset) || 0)),
    accountOffset: Math.max(0, Math.floor(Number(state?.accountOffset) || 0)),
    lastPollAt,
    lastHealthyAt: Math.max(0, Number(state?.lastHealthyAt) || 0),
    rateLimitedUntil: Math.max(0, Number(state?.rateLimitedUntil) || 0),
    rateLimitAttempt: Math.max(0, Math.floor(Number(state?.rateLimitAttempt) || 0)),
    coverage,
  };
}

function buildXFeedSnapshot(state, { enabled = false, expectedAccounts = 0 } = {}) {
  const items = Array.isArray(state?.items) ? state.items.slice(0, DEFAULT_MAX_FEED_ITEMS) : [];
  const lastPollAt = Number(state?.lastPollAt) || 0;
  const coverage = normalizeCoverage(state?.lastCoverage, expectedAccounts);
  return {
    version: X_FEED_SNAPSHOT_VERSION,
    generation: Math.max(0, Math.floor(Number(state?.generation) || 0)),
    source: 'x',
    earlySignal: true,
    enabled: Boolean(enabled),
    count: items.length,
    updatedAt: lastPollAt > 0 ? new Date(lastPollAt).toISOString() : null,
    lastHealthyAt: Number(state?.lastHealthyAt) > 0 ? new Date(Number(state.lastHealthyAt)).toISOString() : null,
    coverage,
    items,
  };
}

function hydrateXFeedSnapshot(snapshot, { maxItems = DEFAULT_MAX_FEED_ITEMS, pollState: pollStateOverride } = {}) {
  const validSnapshot = Boolean(snapshot && snapshot.version === X_FEED_SNAPSHOT_VERSION && Array.isArray(snapshot.items));
  const validOverride = Boolean(pollStateOverride && typeof pollStateOverride === 'object' && !Array.isArray(pollStateOverride));
  if (!validSnapshot && !validOverride) return null;
  const inherited = validSnapshot ? snapshot.pollState : null;
  const pollState = pollStateOverride && typeof pollStateOverride === 'object' && !Array.isArray(pollStateOverride)
    ? pollStateOverride
    : (inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? inherited : {});
  const itemLimit = Math.max(1, Math.floor(Number(maxItems) || DEFAULT_MAX_FEED_ITEMS));
  return {
    generation: Math.max(0, Math.floor(Number(validSnapshot ? snapshot.generation : pollState.generation) || 0)),
    cursorByAccountId: copyCursorMap(pollState.cursorByAccountId),
    accountIdByHandle: copyAccountIdMap(pollState.accountIdByHandle),
    catchupByAccountId: copyCatchupMap(pollState.catchupByAccountId),
    items: validSnapshot ? snapshot.items.filter((item) => item && typeof item === 'object').slice(0, itemLimit) : [],
    lookupOffset: Math.max(0, Math.floor(Number(pollState.lookupOffset) || 0)),
    accountOffset: Math.max(0, Math.floor(Number(pollState.accountOffset) || 0)),
    lastPollAt: Math.max(0, Number(pollState.lastPollAt) || 0),
    lastHealthyAt: Math.max(0, Number(pollState.lastHealthyAt) || 0),
    rateLimitedUntil: Math.max(0, Number(pollState.rateLimitedUntil) || 0),
    rateLimitAttempt: Math.max(0, Math.floor(Number(pollState.rateLimitAttempt) || 0)),
    lastCoverage: normalizeCoverage(pollState.coverage ?? (validSnapshot ? snapshot.coverage : null)),
  };
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

function buildUserTimelineUrl({ accountId, sinceId, maxResults, paginationToken, startTime }) {
  const id = normalizeAccountId(accountId);
  const url = new URL(`/2/users/${encodeURIComponent(id)}/tweets`, X_API_ORIGIN);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(100, maxResults || DEFAULT_MAX_MESSAGES))));
  url.searchParams.set('tweet.fields', 'created_at,lang,public_metrics,referenced_tweets,attachments,edit_history_tweet_ids');
  url.searchParams.set('exclude', 'retweets,replies');
  if (sinceId) url.searchParams.set('since_id', String(sinceId));
  else if (startTime) url.searchParams.set('start_time', String(startTime));
  if (paginationToken) url.searchParams.set('pagination_token', String(paginationToken));
  return url;
}

function lookupErrorResourceId(error) {
  return normalizeAccountId(error?.resource_id || error?.value);
}

function isTweetNotFoundLookupError(error) {
  if (!error || typeof error !== 'object') return false;
  const type = String(error.type || '').trim();
  return /\/2\/problems\/resource-not-found\/?$/i.test(type);
}

function recordRateLimit(nextState, headers, now) {
  const attempt = Math.max(0, Math.floor(Number(nextState.rateLimitAttempt) || 0));
  nextState.rateLimitedUntil = now() + compute429BackoffMs(headers, attempt);
  nextState.rateLimitAttempt = Math.min(7, attempt + 1);
}

function collectDeletedTweetIds(body, requestedIds) {
  const found = new Set((Array.isArray(body?.data) ? body.data : []).map((row) => String(row.id)));
  const errorsById = new Map();
  for (const error of Array.isArray(body?.errors) ? body.errors : []) {
    const id = lookupErrorResourceId(error);
    if (id) errorsById.set(id, error);
  }
  const deleted = [];
  for (const id of requestedIds) {
    const key = String(id);
    if (found.has(key)) continue;
    if (isTweetNotFoundLookupError(errorsById.get(key))) deleted.push(key);
  }
  return deleted;
}

function buildTweetsLookupUrl(ids) {
  const unique = [...new Set(ids.map((id) => normalizeAccountId(id)).filter(Boolean))].slice(0, MAX_TWEET_LOOKUP_IDS);
  const url = new URL('/2/tweets', X_API_ORIGIN);
  url.searchParams.set('ids', unique.join(','));
  url.searchParams.set('tweet.fields', 'id');
  return { url, ids: unique };
}

async function xFetchJson(fetchImpl, url, bearerToken, { timeoutMs = 15_000, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${bearerToken}`,
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    },
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
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
  maxTimelinePages = DEFAULT_MAX_TIMELINE_PAGES,
  signal,
} = {}) {
  const nextState = {
    cursorByAccountId: { ...(state?.cursorByAccountId || {}) },
    accountIdByHandle: { ...(state?.accountIdByHandle || {}) },
    catchupByAccountId: copyCatchupMap(state?.catchupByAccountId),
    items: Array.isArray(state?.items) ? [...state.items] : [],
    lookupOffset: Number(state?.lookupOffset) || 0,
    accountOffset: Number(state?.accountOffset) || 0,
    lastError: null,
    rateLimitedUntil: Number(state?.rateLimitedUntil) > now() ? Number(state.rateLimitedUntil) : 0,
    rateLimitAttempt: Math.max(0, Math.floor(Number(state?.rateLimitAttempt) || 0)),
    accountsPolled: 0,
    accountsFailed: 0,
    newCount: 0,
    accountsAttempted: 0,
    cycleComplete: false,
  };
  if (!bearerToken) {
    nextState.lastError = 'X_BEARER_TOKEN is not configured';
    return nextState;
  }

  const configuredAccounts = Array.isArray(accounts) ? accounts : [];
  const startingOffset = configuredAccounts.length
    ? ((nextState.accountOffset % configuredAccounts.length) + configuredAccounts.length) % configuredAccounts.length
    : 0;
  const orderedAccounts = configuredAccounts.length
    ? [...configuredAccounts.slice(startingOffset), ...configuredAccounts.slice(0, startingOffset)]
    : [];
  const pageLimit = Math.max(1, Math.floor(Number(maxTimelinePages) || DEFAULT_MAX_TIMELINE_PAGES));
  const newItems = [];
  for (const account of orderedAccounts) {
    if (nextState.rateLimitedUntil) break;
    nextState.accountsAttempted += 1;
    let accountId = normalizeAccountId(account.accountId) || nextState.accountIdByHandle[account.handle];
    try {
      if (!accountId) {
        const { response, body } = await xFetchJson(
          fetchImpl,
          buildUserByUsernameUrl(account.handle),
          bearerToken,
          { signal },
        );
        if (response.status === 429) {
          recordRateLimit(nextState, response.headers, now);
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

      // Keep the original cursor fixed throughout pagination. Advancing it
      // mid-window would skip older pages if the later request fails.
      const catchup = nextState.catchupByAccountId[accountId];
      const sinceId = catchup?.sinceId || nextState.cursorByAccountId[accountId];
      let paginationToken = catchup?.paginationToken || '';
      let pageCount = 0;
      let completeWindow = false;
      let pageFailed = false;
      const accountItems = [];
      let newestPostId = catchup?.newestPostId || sinceId || '';
      const boundAccount = { ...account, accountId };
      while (pageCount < pageLimit) {
        const url = buildUserTimelineUrl({
          accountId,
          sinceId,
          maxResults: account.maxMessages || DEFAULT_MAX_MESSAGES,
          paginationToken,
          startTime: sinceId ? '' : new Date(now() - 24 * 60 * 60 * 1000).toISOString(),
        });
        const { response, body } = await xFetchJson(fetchImpl, url, bearerToken, { signal });
        if (response.status === 429) {
          recordRateLimit(nextState, response.headers, now);
          nextState.lastError = `rate limited polling @${account.handle}`;
          break;
        }
        if (!response.ok) {
          nextState.accountsFailed += 1;
          nextState.lastError = `timeline @${account.handle} failed: HTTP ${response.status}`;
          pageFailed = true;
          break;
        }
        const tweets = Array.isArray(body?.data) ? body.data : [];
        for (const tweet of tweets) {
          const item = normalizeXPost(tweet, boundAccount, { maxTextChars });
          if (!item) continue;
          accountItems.push(item);
          if (!newestPostId || BigInt(item.postId) > BigInt(newestPostId)) newestPostId = item.postId;
        }
        paginationToken = typeof body?.meta?.next_token === 'string' ? body.meta.next_token : '';
        pageCount += 1;
        if (!paginationToken) {
          completeWindow = true;
          break;
        }
      }
      if (nextState.rateLimitedUntil) {
        if (sinceId && paginationToken) {
          nextState.catchupByAccountId[accountId] = { sinceId, paginationToken, newestPostId };
          newItems.push(...accountItems);
        }
        break;
      }
      if (pageFailed) {
        if (sinceId && paginationToken) {
          nextState.catchupByAccountId[accountId] = { sinceId, paginationToken, newestPostId };
          newItems.push(...accountItems);
        }
        await sleep(staggerMs, wait);
        continue;
      }
      if (!completeWindow && sinceId) {
        nextState.catchupByAccountId[accountId] = { sinceId, paginationToken, newestPostId };
        newItems.push(...accountItems);
        nextState.accountsFailed += 1;
        nextState.lastError = `timeline @${account.handle} exceeded ${pageLimit} page limit`;
        await sleep(staggerMs, wait);
        continue;
      }
      delete nextState.catchupByAccountId[accountId];
      newItems.push(...accountItems);
      if (newestPostId) nextState.cursorByAccountId[accountId] = newestPostId;
      nextState.accountsPolled += 1;
      await sleep(staggerMs, wait);
    } catch (error) {
      nextState.accountsFailed += 1;
      nextState.lastError = `poll @${account.handle} failed: ${error?.message || String(error)}`;
    }
  }

  // Move the starting point even after a 429 or a partial cycle. This makes
  // the next admitted request start beyond the account that consumed quota.
  if (configuredAccounts.length) {
    nextState.accountOffset = (startingOffset + nextState.accountsAttempted) % configuredAccounts.length;
  }

  nextState.items = mergeAndDedup(nextState.items, newItems, maxFeedItems);
  nextState.newCount = newItems.length;

  nextState.cycleComplete = configuredAccounts.length > 0
    && nextState.accountsPolled === configuredAccounts.length
    && nextState.accountsFailed === 0
    && !nextState.rateLimitedUntil;

  if (lookupDeletions && nextState.items.length && !nextState.rateLimitedUntil) {
    const activeIds = nextState.items
      .filter((item) => item.contentState !== 'deleted')
      .map((item) => item.postId)
      .filter(Boolean);
    const offset = Number(state?.lookupOffset) || 0;
    const rotated = activeIds.length
      ? [...activeIds.slice(offset % activeIds.length), ...activeIds.slice(0, offset % activeIds.length)]
      : [];
    if (rotated.length) {
      const { url, ids } = buildTweetsLookupUrl(rotated);
      try {
        const { response, body } = await xFetchJson(fetchImpl, url, bearerToken, { signal });
        if (response.status === 429) {
          recordRateLimit(nextState, response.headers, now);
          nextState.lastError = 'rate limited during deletion lookup';
          nextState.cycleComplete = false;
        } else if (response.status === 200) {
          const missing = collectDeletedTweetIds(body, ids);
          if (missing.length) nextState.items = tombstonePosts(nextState.items, missing, now());
          nextState.lookupOffset = activeIds.length ? (offset + MAX_TWEET_LOOKUP_IDS) % activeIds.length : 0;
        } else {
          nextState.cycleComplete = false;
          nextState.lastError = `deletion lookup failed: HTTP ${response.status}`;
        }
      } catch (error) {
        nextState.cycleComplete = false;
        nextState.lastError = `deletion lookup failed: ${error?.message || String(error)}`;
      }
    }
  }

  if (nextState.cycleComplete) nextState.rateLimitAttempt = 0;
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
  DEFAULT_MAX_TIMELINE_PAGES,
  X_FEED_SNAPSHOT_VERSION,
  loadXAccounts,
  countEnabledAccounts,
  normalizeHandle,
  normalizeAccountId,
  clampPollIntervalMs,
  normalizeXPost,
  derivedAlertFacts,
  collectXAlertCandidates,
  mergeAndDedup,
  tombstonePosts,
  purgeExpiredTombstones,
  buildXPollState,
  buildXFeedSnapshot,
  hydrateXFeedSnapshot,
  alertSourcePassesTierGate,
  parseRetryAfterMs,
  compute429BackoffMs,
  buildUserByUsernameUrl,
  buildUserTimelineUrl,
  buildTweetsLookupUrl,
  pollXFeed,
};
