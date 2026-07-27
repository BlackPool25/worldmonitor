/**
 * Seeder-side helper for the historical intelligence memory (#5694).
 *
 * Seeders call `appendSeedHistory` from their `afterPublish` hook to
 * embed a run's noteworthy records and append them to the Convex
 * intel-history store via the authenticated `/relay/intel-history`
 * HTTP action.
 *
 * FAIL-OPEN BY DESIGN. History is a secondary artefact of a seed run —
 * a history failure must never fail the run. Two layers enforce that:
 *
 *   1. Missing configuration is NOT an error. Any of CONVEX_SITE_URL
 *      (or CONVEX_URL), RELAY_SHARED_SECRET, OPENROUTER_API_KEY absent
 *      → one warn, `{ skipped: 'unconfigured' }`, zero network calls.
 *      Local runs and un-provisioned Railway services stay silent-ish.
 *   2. Hard runtime failures (embedder outage, relay 5xx after retries)
 *      throw a SeedHistoryError. Callers MUST wrap the call in
 *      try/catch — this module deliberately does not swallow real
 *      failures, so the seeder decides whether to log or ignore.
 *
 * Boundary rules: `scripts/**` ships to Railway via nixpacks with
 * `root_dir=scripts`, so this file may only import from within
 * `scripts/`, `node:*`, and bare packages in scripts/package.json.
 * See tests/scripts-railway-nixpacks-no-escape-import.test.mts.
 */

import { isRetryableHttpStatus, withRetry } from './_seed-utils.mjs';
import { embedBatch, normalizeForEmbedding } from './lib/brief-embedding.mjs';

// Per-run cap. A seed tick that suddenly emits thousands of "historic"
// rows is a bug upstream, not a reason to spend the embedding budget —
// keep the newest slice and drop the tail.
export const HISTORY_MAX_RECORDS_PER_RUN = 150;

// Records per POST. Matches the batch sizes used by the other relay
// importers (import-bounced-emails.mjs uses 100 for a much smaller
// row); 50 × (512 floats + text) keeps a chunk body around 500KB.
export const HISTORY_CHUNK_SIZE = 50;

const TITLE_MAX_CHARS = 500;
const SUMMARY_MAX_CHARS = 2000;

// Embedding input budget. Long summaries add noise, not signal, to a
// 512-dim vector — and the cache key is the text itself, so an
// unbounded input means an unbounded cache cell.
const EMBED_TEXT_MAX_CHARS = 300;
const EMBED_TEXT_SEPARATOR = ' — ';

const RELAY_PATH = '/relay/intel-history';
const RELAY_TIMEOUT_MS = 10_000;
const RELAY_MAX_RETRIES = 2;
const RELAY_RETRY_DELAY_MS = 1000;
const ERROR_SNIPPET_MAX_CHARS = 200;

/** Typed error so callers can distinguish history failures from seed failures. */
export class SeedHistoryError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'SeedHistoryError';
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function trimmedString(value, maxChars) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/**
 * Sanitize + clamp a run's candidate records. Pure — no env, no clock.
 *
 * Drops anything missing the three required fields (`dedupeKey`,
 * `title`, a finite `occurredAt`), truncates the two free-text fields,
 * whitelists the wire shape, and keeps only the newest
 * HISTORY_MAX_RECORDS_PER_RUN by `occurredAt`. Output is sorted
 * newest-first with a `dedupeKey` tiebreak so a run that re-emits the
 * same records chunks them identically.
 *
 * `dedupeKey` is the caller's responsibility — the convention is
 * `${domain}:${resource}:${stableId}`. This helper never fabricates an
 * id, because a fabricated one would defeat the store's dedupe and
 * re-insert the same event on every tick.
 *
 * @param {unknown} records
 * @returns {Array<{dedupeKey: string, title: string, occurredAt: number,
 *   country?: string, category?: string, summary?: string, sourceUrl?: string}>}
 */
export function normalizeHistoryRecords(records) {
  if (!Array.isArray(records)) return [];

  const sanitized = [];
  for (const raw of records) {
    if (!raw || typeof raw !== 'object') continue;

    const dedupeKey = trimmedString(raw.dedupeKey, 512);
    const title = trimmedString(raw.title, TITLE_MAX_CHARS);
    const occurredAt = typeof raw.occurredAt === 'number' ? raw.occurredAt : Number.NaN;
    if (!dedupeKey || !title || !Number.isFinite(occurredAt)) continue;

    const record = { dedupeKey, title, occurredAt };
    const summary = trimmedString(raw.summary, SUMMARY_MAX_CHARS);
    if (summary) record.summary = summary;
    const country = trimmedString(raw.country, 8);
    if (country) record.country = country;
    const category = trimmedString(raw.category, 64);
    if (category) record.category = category;
    const sourceUrl = trimmedString(raw.sourceUrl, 2048);
    if (sourceUrl) record.sourceUrl = sourceUrl;

    sanitized.push(record);
  }

  sanitized.sort(
    (a, b) =>
      b.occurredAt - a.occurredAt ||
      (a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0),
  );
  return sanitized.slice(0, HISTORY_MAX_RECORDS_PER_RUN);
}

/**
 * Compose the string that gets embedded for one record.
 *
 * Title carries the event; the summary disambiguates near-identical
 * titles ("Airstrike in Gaza" ×40/day). Both go through
 * normalizeForEmbedding — the single normalisation function shared with
 * brief-dedup, so the same text always maps to the same cache cell.
 *
 * Exported because query-time search embeds a user query and compares
 * it against these vectors: any drift between the two compositions
 * degrades recall silently, with no failing request to point at. A
 * parity test needs both sides callable.
 *
 * Caveat inherited from that contract: normalizeForEmbedding strips
 * wire-service suffixes, so a summary ending in an outlet name or a
 * bare domain loses that tail. Harmless for similarity, worth knowing
 * if you ever diff the embedded text against the stored summary.
 */
export function buildHistoryEmbeddingText(record) {
  let text = record.title;
  if (record.summary) {
    const remaining = EMBED_TEXT_MAX_CHARS - text.length - EMBED_TEXT_SEPARATOR.length;
    if (remaining > 0) text += EMBED_TEXT_SEPARATOR + record.summary.slice(0, remaining);
  }
  return normalizeForEmbedding(text.slice(0, EMBED_TEXT_MAX_CHARS));
}

/** Best-effort body snippet for an error message; never throws. */
async function readErrorSnippet(response) {
  try {
    const body = await response.text();
    return typeof body === 'string' ? body.slice(0, ERROR_SNIPPET_MAX_CHARS) : '';
  } catch {
    return '';
  }
}

/**
 * Resolve the relay config from an env bag. Returns `null` plus the
 * list of missing names so the caller can emit exactly one warn.
 */
function resolveRelayConfig(env) {
  const siteUrl =
    env.CONVEX_SITE_URL || (env.CONVEX_URL ?? '').replace('.convex.cloud', '.convex.site');
  const secret = env.RELAY_SHARED_SECRET ?? '';
  const openrouterKey = env.OPENROUTER_API_KEY ?? '';

  const missing = [];
  if (!siteUrl) missing.push('CONVEX_SITE_URL (or CONVEX_URL)');
  if (!secret) missing.push('RELAY_SHARED_SECRET');
  if (!openrouterKey) missing.push('OPENROUTER_API_KEY');
  if (missing.length > 0) return { missing };

  return { siteUrl: siteUrl.replace(/\/+$/, ''), secret, openrouterKey, missing };
}

/**
 * POST one chunk, with retry. Permanent statuses (4xx that aren't 408 /
 * 429) are tagged `nonRetryable` so withRetry fails in ~10ms instead of
 * burning 3s of the seeder's budget on a misconfigured secret.
 */
async function postHistoryChunk({ fetchImpl, url, secret, payload }) {
  return withRetry(
    async () => {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });

      if (!response.ok) {
        const snippet = await readErrorSnippet(response);
        const error = new SeedHistoryError(
          `intel-history relay returned HTTP ${response.status}: ${snippet}`,
          { status: response.status },
        );
        if (!isRetryableHttpStatus(response.status)) error.nonRetryable = true;
        throw error;
      }

      return await response.json();
    },
    RELAY_MAX_RETRIES,
    RELAY_RETRY_DELAY_MS,
  );
}

/**
 * Embed and append one seed run's history records.
 *
 * @param {object} args
 * @param {string} args.domain     top-level domain key, e.g. 'conflict'
 * @param {string} args.resource   seeder resource key, e.g. 'acled'
 * @param {string} [args.runId]    seed run identifier, echoed to the store
 * @param {unknown[]} args.records candidate records (see normalizeHistoryRecords)
 * @param {object} [deps]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(texts: string[]) => Promise<number[][]>} [deps.embed]
 * @param {Record<string, string | undefined>} [deps.env]
 * @returns {Promise<{inserted: number, skipped: number, chunks: number} | {skipped: 'unconfigured'}>}
 *
 * Throws SeedHistoryError on a hard runtime failure; propagates the
 * embedder's own EmbeddingProviderError / EmbeddingTimeoutError. Never
 * throws for missing configuration.
 */
export async function appendSeedHistory({ domain, resource, runId, records }, deps = {}) {
  const env = deps.env ?? process.env;

  const config = resolveRelayConfig(env);
  if (config.missing.length > 0) {
    console.warn(
      `[seed-history] not configured — skipping history append (missing: ${config.missing.join(', ')})`,
    );
    return { skipped: 'unconfigured' };
  }

  if (typeof domain !== 'string' || !domain.trim()) {
    throw new SeedHistoryError('appendSeedHistory: domain is required');
  }
  if (typeof resource !== 'string' || !resource.trim()) {
    throw new SeedHistoryError('appendSeedHistory: resource is required');
  }

  const sanitized = normalizeHistoryRecords(records);
  if (sanitized.length === 0) return { inserted: 0, skipped: 0, chunks: 0 };

  // Wrap rather than capture: a bare `fetch` default would bind the
  // global at module load and miss later instrumentation shims.
  const fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
  const embed =
    deps.embed ?? ((texts) => embedBatch(texts, { _apiKey: config.openrouterKey }));

  const vectors = await embed(sanitized.map(buildHistoryEmbeddingText));
  if (!Array.isArray(vectors) || vectors.length !== sanitized.length) {
    throw new SeedHistoryError(
      `appendSeedHistory: expected ${sanitized.length} embeddings, got ${
        Array.isArray(vectors) ? vectors.length : 'none'
      }`,
    );
  }

  const url = `${config.siteUrl}${RELAY_PATH}`;
  let inserted = 0;
  let skipped = 0;
  let chunks = 0;

  for (let start = 0; start < sanitized.length; start += HISTORY_CHUNK_SIZE) {
    const chunk = sanitized
      .slice(start, start + HISTORY_CHUNK_SIZE)
      .map((record, i) => ({ ...record, embedding: vectors[start + i] }));

    const body = await postHistoryChunk({
      fetchImpl,
      url,
      secret: config.secret,
      payload: { domain, resource, runId, records: chunk },
    });

    inserted += Number(body?.inserted) || 0;
    skipped += Number(body?.skipped) || 0;
    chunks += 1;
  }

  return { inserted, skipped, chunks };
}
