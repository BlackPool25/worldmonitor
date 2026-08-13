/**
 * Vendor `/api/v2/get` (and v3 roadconditions) adapter for Ontario 511,
 * structured so Alberta and Manitoba can share the same client later.
 *
 * BC Open511 is a different API — do not pass an Open511 baseUrl here.
 * Host allowlist is derived from the configured baseUrl hostname.
 */

import { acquire511Slot } from '../_511-rate-limit.mjs';

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_PATH_POINTS = 32;

/** Hosts that speak the vendor `/api/v2/get/:resource` contract. */
const _vendor511Hosts = {
  '511on.ca': Object.freeze({ jurisdiction: 'ON' }),
  has(host) {
    return Object.prototype.hasOwnProperty.call(this, String(host || '').toLowerCase());
  },
};
export const VENDOR_511_HOSTS = Object.freeze(_vendor511Hosts);

export const ONTARIO_511 = Object.freeze({
  baseUrl: 'https://511on.ca',
  jurisdiction: 'ON',
  resources: Object.freeze([
    Object.freeze({ resource: 'event', kind: 'event' }),
    Object.freeze({ resource: 'alerts', kind: 'alert' }),
    Object.freeze({ resource: 'roadconditions', kind: 'condition' }),
  ]),
});

export function isVendor511Host(host) {
  return Object.prototype.hasOwnProperty.call(VENDOR_511_HOSTS, String(host || '').toLowerCase());
}

export function vendor511Path(resource) {
  if (resource === 'roadconditions') return '/api/v3/get/roadconditions';
  return `/api/v2/get/${resource}`;
}

function hostnameOf(baseUrl) {
  let hostname;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new TypeError(`provincial-511: invalid baseUrl ${baseUrl}`);
  }
  if (!isVendor511Host(hostname)) {
    throw new Error(
      `provincial-511: host ${hostname} is not on the vendor /api/v2/get allowlist `
      + `(BC Open511 is a different API)`,
    );
  }
  return hostname;
}

/**
 * Decode a Google-encoded polyline into [lon, lat] pairs.
 * @param {string} encoded
 * @returns {Array<[number, number]>}
 */
export function decodeEncodedPolyline(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  const coordinates = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lon += dlng;
    coordinates.push([lon / 1e5, lat / 1e5]);
  }
  return coordinates;
}

function polylinesFrom(value) {
  if (typeof value === 'string' && value) return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v);
  return [];
}

function downsamplePath(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  if (path.length <= MAX_PATH_POINTS) return path;
  const out = [];
  const last = path.length - 1;
  for (let i = 0; i < MAX_PATH_POINTS; i++) {
    const idx = Math.round((i / (MAX_PATH_POINTS - 1)) * last);
    out.push(path[idx]);
  }
  return out;
}

export function centroidOfPath(path) {
  if (!Array.isArray(path) || path.length === 0) return null;
  let lon = 0;
  let lat = 0;
  for (const point of path) {
    lon += point[0];
    lat += point[1];
  }
  return [lon / path.length, lat / path.length];
}

function finiteCoord(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function textOf(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function eventTypeFor(kind, item) {
  if (kind === 'condition') return 'roadcondition';
  if (kind === 'alert') return 'alert';
  return textOf(item?.EventType, item?.eventType, 'event') || 'event';
}

function severityOf(item, { isFullClosure, highImportance, kind } = {}) {
  if (isFullClosure) return 'Extreme';
  const raw = String(item?.Severity || item?.severity || '').trim();
  if (raw && raw !== 'Unknown') return raw;
  if (highImportance || kind === 'alert' && item?.HighImportance) return 'Severe';
  const conditions = Array.isArray(item?.Condition) ? item.Condition.join(' ') : String(item?.Condition || '');
  if (/snow|ice|closed|impassable|poor|drift/i.test(conditions)) return 'Moderate';
  return raw || 'Unknown';
}

/**
 * @param {object} item
 * @param {{ kind: 'event'|'alert'|'condition', jurisdiction?: string }} ctx
 */
export function normalize511Record(item, ctx) {
  const kind = ctx.kind;
  const jurisdiction = ctx.jurisdiction || 'ON';
  const lat = finiteCoord(item?.Latitude ?? item?.latitude ?? item?.lat);
  const lon = finiteCoord(item?.Longitude ?? item?.longitude ?? item?.lon ?? item?.lng);
  const encoded = polylinesFrom(item?.EncodedPolyline ?? item?.encodedPolyline);
  const decoded = encoded.flatMap(decodeEncodedPolyline);
  const path = downsamplePath(decoded);
  const centroid = (lat != null && lon != null) ? [lon, lat] : centroidOfPath(decoded);
  const isFullClosure = Boolean(item?.IsFullClosure ?? item?.isFullClosure);
  const highImportance = Boolean(item?.HighImportance);
  const id = String(item?.ID ?? item?.Id ?? item?.id ?? '');
  return {
    id,
    kind,
    lat,
    lon,
    centroid,
    severity: severityOf(item, { isFullClosure, highImportance, kind }),
    eventType: eventTypeFor(kind, item),
    isFullClosure,
    lanesAffected: item?.LanesAffected ?? item?.lanesAffected ?? null,
    roadwayName: textOf(item?.RoadwayName, item?.roadwayName),
    headline: textOf(
      item?.RoadwayName,
      item?.LocationDescription,
      item?.Message,
      item?.headline,
    ),
    description: textOf(
      item?.Description,
      item?.Message,
      item?.LocationDescription,
      item?.Comment,
      item?.description,
    ),
    path: path && path.length > 1 ? path : null,
    jurisdiction,
    resource: kind === 'condition' ? 'roadconditions' : kind === 'alert' ? 'alerts' : 'event',
  };
}

export function normalize511List(body, kind, jurisdiction = 'ON') {
  const items = Array.isArray(body)
    ? body
    : Array.isArray(body?.events) ? body.events
    : Array.isArray(body?.alerts) ? body.alerts
    : Array.isArray(body?.roadconditions) ? body.roadconditions
    : Array.isArray(body?.data) ? body.data
    : [];
  const records = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    records.push(normalize511Record(item, { kind, jurisdiction }));
  }
  return records;
}

export function normalize511Records(body, ctx) {
  const kind = ctx?.kind
    || (ctx?.resource === 'alerts' ? 'alert'
      : ctx?.resource === 'roadconditions' ? 'condition'
      : 'event');
  return normalize511List(body, kind, ctx?.jurisdiction || 'ON');
}

export function declareVendor511Records(envelope) {
  if (!envelope || typeof envelope !== 'object') return 0;
  const events = Array.isArray(envelope.events) ? envelope.events.length : 0;
  const alerts = Array.isArray(envelope.alerts) ? envelope.alerts.length : 0;
  const conditions = Array.isArray(envelope.conditions) ? envelope.conditions.length : 0;
  const records = Array.isArray(envelope.records) ? envelope.records.length : 0;
  return records || (events + alerts + conditions);
}

export function validateVendor511Envelope(envelope) {
  if (envelope == null || typeof envelope !== 'object') return false;
  if (Array.isArray(envelope.records)) return true;
  return Array.isArray(envelope.events)
    && Array.isArray(envelope.alerts)
    && Array.isArray(envelope.conditions);
}

async function readLimitedJson(resp, maxBytes) {
  const contentLength = resp.headers?.get?.('content-length');
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new Error(`provincial-511: payload exceeds ${maxBytes} bytes`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`provincial-511: payload exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(buffer.toString('utf8'));
}

function kindForResource(resource) {
  if (resource === 'alerts') return 'alert';
  if (resource === 'roadconditions') return 'condition';
  return 'event';
}

/**
 * Fetch one vendor resource. Calls acquire511Slot(hostname) before the request.
 *
 * @param {string} baseUrl
 * @param {string} resource
 * @param {{
 *   format?: string,
 *   key?: string,
 *   fetchFn?: typeof fetch,
 *   userAgent?: string,
 *   timeoutMs?: number,
 *   maxBytes?: number,
 *   acquireSlot?: (host: string) => Promise<void>,
 *   jurisdiction?: string,
 * }} [opts]
 */
export async function get(baseUrl, resource, opts = {}) {
  const hostname = hostnameOf(baseUrl);
  const format = opts.format || 'json';
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_PAYLOAD_BYTES;
  const userAgent = opts.userAgent || CHROME_UA;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const acquireSlot = opts.acquireSlot ?? acquire511Slot;
  const jurisdiction = opts.jurisdiction || VENDOR_511_HOSTS[hostname]?.jurisdiction || 'ON';

  const url = new URL(vendor511Path(resource), baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.searchParams.set('format', format);
  if (opts.key) url.searchParams.set('key', opts.key);

  await acquireSlot(hostname);

  const resp = await fetchFn(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
  });
  if (!resp.ok) {
    throw new Error(`provincial-511 ${resource}: HTTP ${resp.status}`);
  }
  const body = await readLimitedJson(resp, maxBytes);
  return {
    records: normalize511List(body, kindForResource(resource), jurisdiction),
    raw: body,
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch every configured resource, staggering calls so one Ontario tick uses
 * 3 of the host's 10/60 tokens without bursting. One endpoint failure does
 * not empty the others. Total failure throws so runSeed keeps last-good.
 *
 * @param {typeof ONTARIO_511} config
 * @param {{
 *   fetchFn?: typeof fetch,
 *   userAgent?: string,
 *   key?: string,
 *   staggerMs?: number,
 *   sleep?: (ms: number) => Promise<void>,
 *   getFn?: typeof get,
 * }} [opts]
 */
export async function fetchVendor511(config, opts = {}) {
  const staggerMs = opts.staggerMs ?? 7000;
  const sleep = opts.sleep ?? defaultSleep;
  const getFn = opts.getFn ?? get;
  const resources = config.resources || [];
  const events = [];
  const alerts = [];
  const conditions = [];
  const failedResources = [];

  for (let i = 0; i < resources.length; i++) {
    if (i > 0 && staggerMs > 0) await sleep(staggerMs);
    const { resource, kind } = resources[i];
    try {
      const result = await getFn(config.baseUrl, resource, {
        format: 'json',
        key: opts.key ?? config.key,
        fetchFn: opts.fetchFn,
        userAgent: opts.userAgent,
        jurisdiction: config.jurisdiction,
      });
      const records = result?.records || [];
      if (kind === 'alert') alerts.push(...records);
      else if (kind === 'condition') conditions.push(...records);
      else events.push(...records);
    } catch (err) {
      failedResources.push(resource);
      console.warn(`  provincial-511 ${config.jurisdiction} ${resource}: ${err.message || err}`);
    }
  }

  if (
    events.length === 0
    && alerts.length === 0
    && conditions.length === 0
    && failedResources.length === resources.length
    && resources.length > 0
  ) {
    throw new Error(`provincial-511 ${config.jurisdiction}: all endpoints failed`);
  }

  const records = [...events, ...alerts, ...conditions];
  return {
    events,
    alerts,
    conditions,
    records,
    failedResources,
    failedResourceCount: failedResources.length,
  };
}

export const fetchProvincial511 = fetchVendor511;

export { CHROME_UA, MAX_PAYLOAD_BYTES };
