// Pure Earthquakes Canada (NRCan) Atom parser + USGS merge/dedup helpers.
// Tests import this module, not the seeder entrypoint.

import { CHROME_UA } from '../_seed-utils.mjs';
import { decodeHtmlEntities } from '../_html-entities.mjs';

export const NRCAN_ATOM_HOST = 'www.earthquakescanada.nrcan.gc.ca';
export const NRCAN_ATOM_URL = 'https://www.earthquakescanada.nrcan.gc.ca/cache/earthquakes/canada-en.atom';
export const NRCAN_OFFICIAL_PAGE = 'https://www.earthquakescanada.nrcan.gc.ca/index-en.php?tpl_region=canada';
// Live canada-en.atom was 343771 bytes on 2026-08-13; 342KB is below that, so raise.
export const MAX_NRCAN_ATOM_BYTES = 1024 * 1024;
export const EARTHQUAKES_MAX_CONTENT_AGE_MIN = 2 * 24 * 60; // 48h — min() of successful upstream newest

const TITLE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) UTC:\s*M(\d+(?:\.\d+)?)\s+(.*)$/i;
const EVENT_ID_RE = /[?&]eventid=([^&]+)/i;
const CLOCK_SKEW_MS = 60 * 60 * 1000;

export class NrcanAtomParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NrcanAtomParseError';
    this.code = 'SEED_ERROR';
  }
}

export function nrcanAtomCacheKey(url = NRCAN_ATOM_URL) {
  return `nrcan-atom:${url}`;
}

function tagValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? decodeHtmlEntities(match[1]).trim() : '';
}

function parseOccurredAt(title) {
  const match = TITLE_RE.exec(title);
  if (!match) return null;
  const ts = Date.parse(`${match[1].replace(' ', 'T')}Z`);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

function parseTitleMagPlace(title) {
  const match = TITLE_RE.exec(title);
  if (!match) return { magnitude: null, place: title };
  return { magnitude: Number(match[2]), place: match[3].trim() };
}

function parsePoint(block) {
  const match = block.match(/<(?:georss:)?point>([^<]+)<\/(?:georss:)?point>/i);
  if (!match) return null;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return null;
  const latitude = Number(parts[0]);
  const longitude = Number(parts[1]);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function parseDepthKm(block) {
  const match = block.match(/<(?:georss:)?elev>([^<]+)<\/(?:georss:)?elev>/i);
  if (!match) return 0;
  const elevM = Number(match[1]);
  if (!Number.isFinite(elevM)) return 0;
  return Math.round((Math.abs(elevM) / 1000) * 100) / 100;
}

function nrcanEventId(idText) {
  const raw = String(idText || '').trim();
  const fromQuery = raw.match(EVENT_ID_RE);
  return fromQuery ? fromQuery[1] : raw;
}

function parseFeedUpdatedAt(xml) {
  const headerEnd = xml.search(/<entry\b/i);
  const header = headerEnd === -1 ? xml : xml.slice(0, headerEnd);
  const match = header.match(/<updated>([^<]+)<\/updated>/i);
  if (!match) return null;
  const ts = Date.parse(match[1].trim());
  return Number.isFinite(ts) && ts > 0 ? ts : null;
}

/**
 * Parse an Earthquakes Canada Atom document.
 * Well-formed feed with zero entries → { earthquakes: [], feedUpdatedAt }.
 * Anything that is not a feed → NrcanAtomParseError (SEED_ERROR).
 * Missing entry dates are omitted (never Date.now()).
 */
export function parseNrcanAtom(xml) {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new NrcanAtomParseError('NRCan Atom is empty');
  }
  if (/<html[\s>]/i.test(xml) || !/<feed\b/i.test(xml)) {
    throw new NrcanAtomParseError('NRCan Atom is not a well-formed feed');
  }

  const feedUpdatedAt = parseFeedUpdatedAt(xml);
  const earthquakes = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const title = tagValue(block, 'title');
    const idText = tagValue(block, 'id');
    const location = parsePoint(block);
    if (!location) continue;
    const { magnitude, place } = parseTitleMagPlace(title);
    if (!Number.isFinite(magnitude)) continue;
    const occurredAt = parseOccurredAt(title);
    // Do not Date.now() a missing stamp — drop the entry from dated identity
    // but still publish it with occurredAt 0 so mag/depth/coords survive.
    const id = nrcanEventId(idText);
    if (!id) continue;
    earthquakes.push({
      id,
      place,
      magnitude,
      depthKm: parseDepthKm(block),
      location,
      occurredAt: occurredAt ?? 0,
      sourceUrl: idText || NRCAN_OFFICIAL_PAGE,
      source: 'nrcan',
    });
  }

  let newestAt = feedUpdatedAt;
  let oldestAt = null;
  for (const eq of earthquakes) {
    if (!Number.isFinite(eq.occurredAt) || eq.occurredAt <= 0) continue;
    if (oldestAt == null || eq.occurredAt < oldestAt) oldestAt = eq.occurredAt;
    if (newestAt == null || eq.occurredAt > newestAt) {
      // Feed <updated> is the freeze signal; event times only fill when the
      // feed stamp is missing — never invent a clock reading.
      if (feedUpdatedAt == null) newestAt = eq.occurredAt;
    }
  }
  if (oldestAt == null) oldestAt = newestAt;

  return { earthquakes, feedUpdatedAt, newestAt, oldestAt };
}

async function readBoundedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new Error('RESPONSE_TOO_LARGE');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('RESPONSE_TOO_LARGE');
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

export async function fetchApprovedAtom(url, {
  allowedHosts = [NRCAN_ATOM_HOST],
  maxBytes = MAX_NRCAN_ATOM_BYTES,
  fetchFn = globalThis.fetch,
  cache,
} = {}) {
  const parsed = new URL(url);
  const allowed = new Set((allowedHosts || []).map((host) => String(host).toLowerCase()));
  if (parsed.protocol !== 'https:' || !allowed.has(parsed.hostname.toLowerCase())) {
    throw new Error('UNTRUSTED_SOURCE_HOST');
  }
  const cacheKey = nrcanAtomCacheKey(parsed.toString());
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const response = await fetchFn(parsed.toString(), {
    headers: {
      Accept: 'application/atom+xml, application/xml, text/xml, */*',
      'User-Agent': CHROME_UA,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP_${response.status}`), { status: response.status });
  const xml = await readBoundedText(response, maxBytes);
  cache?.set(cacheKey, xml);
  return xml;
}

export async function fetchNrcanAtom({
  fetchFn = globalThis.fetch,
  cache,
  url = NRCAN_ATOM_URL,
} = {}) {
  const xml = await fetchApprovedAtom(url, {
    allowedHosts: [NRCAN_ATOM_HOST],
    maxBytes: MAX_NRCAN_ATOM_BYTES,
    fetchFn,
    cache,
  });
  const parsed = parseNrcanAtom(xml);
  return {
    earthquakes: parsed.earthquakes,
    newestAt: parsed.newestAt,
    oldestAt: parsed.oldestAt,
    feedUpdatedAt: parsed.feedUpdatedAt,
  };
}

export function parseUsgsGeojson(geojson) {
  if (!geojson || typeof geojson !== 'object' || !Array.isArray(geojson.features)) {
    throw new Error('SEED_ERROR');
  }
  const earthquakes = [];
  let newestAt = null;
  let oldestAt = null;
  for (const feature of geojson.features) {
    if (!feature?.properties || !feature?.geometry?.coordinates) continue;
    const occurredAt = feature.properties?.time;
    const eq = {
      id: String(feature.id || ''),
      place: String(feature.properties?.place || ''),
      magnitude: feature.properties?.mag ?? 0,
      depthKm: feature.geometry?.coordinates?.[2] ?? 0,
      location: {
        latitude: feature.geometry?.coordinates?.[1] ?? 0,
        longitude: feature.geometry?.coordinates?.[0] ?? 0,
      },
      occurredAt: Number.isFinite(occurredAt) && occurredAt > 0 ? occurredAt : 0,
      sourceUrl: String(feature.properties?.url || ''),
      source: 'usgs',
    };
    earthquakes.push(eq);
    if (Number.isFinite(eq.occurredAt) && eq.occurredAt > 0) {
      if (newestAt == null || eq.occurredAt > newestAt) newestAt = eq.occurredAt;
      if (oldestAt == null || eq.occurredAt < oldestAt) oldestAt = eq.occurredAt;
    }
  }
  const generated = geojson.metadata?.generated;
  if (Number.isFinite(generated) && generated > 0) newestAt = generated;
  return { earthquakes, newestAt, oldestAt };
}

function identityFromId(eq) {
  const id = String(eq?.id || '').trim();
  return id ? `id:${id}` : null;
}

function identityFromBucket(eq) {
  const occurredAt = eq?.occurredAt;
  const mag = eq?.magnitude;
  const lat = eq?.location?.latitude;
  const lon = eq?.location?.longitude;
  if (!Number.isFinite(occurredAt) || occurredAt <= 0) return null;
  if (!Number.isFinite(mag) || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const timeBucket = Math.round(occurredAt / 60_000);
  const magBucket = Math.round(mag * 10);
  const latBucket = Math.round(lat * 20);
  const lonBucket = Math.round(lon * 20);
  return `bucket:${timeBucket}:${magBucket}:${latBucket}:${lonBucket}`;
}

/** Identity is event id OR time+mag+lat/lon bucket. Place string is never identity. */
export function earthquakeIdentity(eq) {
  return identityFromId(eq) || identityFromBucket(eq);
}

export function mergeEarthquakeFeeds(usgsEvents = [], nrcanEvents = []) {
  const out = [];
  const seenIds = new Set();
  const seenBuckets = new Set();

  const consider = (eq) => {
    const idKey = identityFromId(eq);
    const bucketKey = identityFromBucket(eq);
    if (idKey && seenIds.has(idKey)) return;
    if (bucketKey && seenBuckets.has(bucketKey)) return;
    if (idKey) seenIds.add(idKey);
    if (bucketKey) seenBuckets.add(bucketKey);
    out.push(eq);
  };

  for (const eq of usgsEvents) consider(eq);
  for (const eq of nrcanEvents) consider(eq);
  return out;
}

export async function fetchMergedEarthquakes({ fetchUsgs, fetchNrcan }) {
  const [usgsResult, nrcanResult] = await Promise.allSettled([
    fetchUsgs(),
    fetchNrcan(),
  ]);
  const usgsOk = usgsResult.status === 'fulfilled';
  const nrcanOk = nrcanResult.status === 'fulfilled';
  if (!usgsOk && !nrcanOk) {
    const usgsErr = usgsResult.reason?.message || usgsResult.reason;
    const nrcanErr = nrcanResult.reason?.message || nrcanResult.reason;
    throw new Error(`All earthquake upstreams failed (usgs: ${usgsErr}; nrcan: ${nrcanErr})`);
  }
  if (!usgsOk) console.warn(`[earthquakes] USGS failed: ${usgsResult.reason?.message || usgsResult.reason}`);
  if (!nrcanOk) console.warn(`[earthquakes] NRCan failed: ${nrcanResult.reason?.message || nrcanResult.reason}`);

  const usgsEvents = usgsOk ? (usgsResult.value.earthquakes || []) : [];
  const nrcanEvents = nrcanOk ? (nrcanResult.value.earthquakes || []) : [];
  return {
    earthquakes: mergeEarthquakeFeeds(usgsEvents, nrcanEvents),
    _usgsNewestAt: usgsOk ? (usgsResult.value.newestAt ?? null) : null,
    _usgsOldestAt: usgsOk ? (usgsResult.value.oldestAt ?? null) : null,
    _nrcanNewestAt: nrcanOk ? (nrcanResult.value.newestAt ?? null) : null,
    _nrcanOldestAt: nrcanOk ? (nrcanResult.value.oldestAt ?? null) : null,
  };
}

/**
 * Content-age is min() of successful upstream newest timestamps so USGS
 * freshness cannot hide an NRCan freeze. Failed upstreams are omitted —
 * never substituted with Date.now().
 */
export function earthquakesContentMeta(data, nowMs = Date.now()) {
  const newestParts = [];
  const oldestParts = [];
  for (const newest of [data?._usgsNewestAt, data?._nrcanNewestAt]) {
    if (Number.isFinite(newest) && newest > 0 && newest <= nowMs + CLOCK_SKEW_MS) {
      newestParts.push(newest);
    }
  }
  for (const oldest of [data?._usgsOldestAt, data?._nrcanOldestAt]) {
    if (Number.isFinite(oldest) && oldest > 0) oldestParts.push(oldest);
  }
  if (newestParts.length === 0) return null;
  const newestItemAt = Math.min(...newestParts);
  const oldestItemAt = oldestParts.length ? Math.min(...oldestParts) : newestItemAt;
  return { newestItemAt, oldestItemAt };
}

export function earthquakesPublishTransform(data) {
  return { earthquakes: Array.isArray(data?.earthquakes) ? data.earthquakes : [] };
}
