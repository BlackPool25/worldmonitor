#!/usr/bin/env node
/**
 * Seed USDA FAS PSD food stocks (plus FAOSTAT production gap-fill) into Redis.
 *
 * Canonical key: resilience:food-stocks:v1
 * Stages: PSD (authoritative stocks) → FAOSTAT production fill → stocks-to-use.
 * Marketing years stay on the record as "YYYY/YY"; never calendar-bucketed.
 *
 * Usage:
 *   node scripts/seed-food-stocks.mjs
 */

import { resolveIso2 } from './_country-resolver.mjs';
import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
  FOOD_STOCKS_MAX_STALE_MIN,
  FOOD_STOCKS_SOURCE_VERSION,
  FOOD_STOCKS_TTL_SECONDS,
  PSD_COMMODITIES,
  applyFaostatProductionFill,
  assembleFoodStocksSnapshot,
  foodStocksContentMeta,
  parsePsdForecastRows,
} from './_food-stocks-helpers.mjs';
import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url, { only: ['USDA_FAS_API_KEY'] });

const PSD_BASE = 'https://apps.fas.usda.gov/OpenData/api/psd';
const FAOSTAT_DATA = 'https://fenixservices.fao.org/faostat/api/v1/en/data/QCL';
const FAOSTAT_AREAS = 'https://fenixservices.fao.org/faostat/api/v1/en/codes/area/QCL';
const RICE_PADDY_TO_MILLED = 0.67;
const FETCH_GAP_MS = 150;

export const CANONICAL_KEY = FOOD_STOCKS_CANONICAL_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultFetch(url, init) {
  return globalThis.fetch(url, init);
}

async function fetchJson(fetchImpl, url, headers, label) {
  const resp = await fetchImpl(url, {
    headers: {
      'User-Agent': CHROME_UA,
      Accept: 'application/json',
      ...headers,
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`${label} HTTP ${resp.status}${text ? ` — ${text.slice(0, 180)}` : ''}`);
  }
  return resp.json();
}

function asRowArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

export async function fetchPsdCommodityYear(commodity, year, { fetchImpl = defaultFetch, apiKey } = {}) {
  if (!apiKey) throw new Error('USDA_FAS_API_KEY is required for PSD ingestion');
  const headers = { API_KEY: apiKey };
  const code = commodity.code;
  const countryUrl = `${PSD_BASE}/commodity/${code}/country/all/year/${year}`;
  const worldUrl = `${PSD_BASE}/commodity/${code}/world/year/${year}`;
  const [countryRows, worldRows] = await Promise.all([
    fetchJson(fetchImpl, countryUrl, headers, `PSD ${commodity.slug} countries ${year}`),
    fetchJson(fetchImpl, worldUrl, headers, `PSD ${commodity.slug} world ${year}`).catch((err) => {
      console.warn(`  PSD world ${commodity.slug} ${year} failed: ${err.message}`);
      return [];
    }),
  ]);
  return [...asRowArray(countryRows), ...asRowArray(worldRows)];
}

export async function selectLatestPsdYear(commodity, { fetchImpl, apiKey, now = new Date(), gapMs = FETCH_GAP_MS } = {}) {
  const current = now.getUTCFullYear();
  const candidates = [current, current - 1, current - 2];
  for (const year of candidates) {
    const rows = await fetchPsdCommodityYear(commodity, year, { fetchImpl, apiKey });
    const parsed = parsePsdForecastRows(rows, { commodity: commodity.slug });
    if (parsed.length > 0) return { year, rows, parsed };
    if (gapMs) await sleep(gapMs);
  }
  return { year: null, rows: [], parsed: [] };
}

function pickField(row, names) {
  for (const name of names) {
    if (row?.[name] != null && row[name] !== '') return row[name];
  }
  return null;
}

export function parseFaostatAreaMap(payload) {
  const rows = asRowArray(payload);
  const map = new Map();
  for (const row of rows) {
    const code = String(pickField(row, ['code', 'Code', 'areaCode', 'Area Code']) ?? '').trim();
    if (!code) continue;
    const iso2 = resolveIso2({
      iso3: pickField(row, ['iso3', 'ISO3', 'Area Code (ISO3)', 'iso3Code']),
      name: pickField(row, ['label', 'Label', 'Area', 'area', 'name']),
    });
    if (iso2) map.set(code, iso2);
  }
  return map;
}

export function parseFaostatProductionRows(payload, { commodity, areaMap, millFactor = 1 }) {
  const rows = asRowArray(payload);
  const byCountry = new Map();
  for (const row of rows) {
    const areaCode = String(pickField(row, ['Area Code', 'areaCode', 'area']) ?? '').trim();
    const iso2 = areaMap.get(areaCode) || resolveIso2({
      iso3: pickField(row, ['Area Code (ISO3)', 'iso3']),
      name: pickField(row, ['Area', 'area']),
    });
    if (!iso2) continue;
    const year = Number(pickField(row, ['Year', 'year']));
    const raw = Number(pickField(row, ['Value', 'value']));
    if (!Number.isInteger(year) || !Number.isFinite(raw)) continue;
    const production = (raw * millFactor) / 1000;
    const prev = byCountry.get(iso2);
    if (!prev || year > prev.calendarYear) {
      byCountry.set(iso2, {
        countryCode: iso2,
        commodity,
        production,
        calendarYear: year,
      });
    }
  }
  return [...byCountry.values()];
}

async function fetchFaostatProduction(commodity, year, { fetchImpl, areaMap }) {
  const url = `${FAOSTAT_DATA}?item=${commodity.faostatItem}&element=5510&year=${year}&show_codes=true`;
  const payload = await fetchJson(fetchImpl, url, {}, `FAOSTAT ${commodity.slug} ${year}`);
  const millFactor = commodity.slug === 'rice' ? RICE_PADDY_TO_MILLED : 1;
  return parseFaostatProductionRows(payload, { commodity: commodity.slug, areaMap, millFactor });
}

/**
 * Three-stage fetch used by runSeed. FAOSTAT failures are swallowed so PSD
 * data remains the published snapshot.
 */
export async function fetchFoodStocks({
  fetchImpl = defaultFetch,
  apiKey = process.env.USDA_FAS_API_KEY,
  now = new Date(),
  gapMs = FETCH_GAP_MS,
} = {}) {
  if (!apiKey) throw new Error('USDA_FAS_API_KEY is required');

  const allRecords = [];
  const stageNotes = { psd: {}, faostat: {} };

  let areaMap = new Map();
  try {
    const areaPayload = await fetchJson(fetchImpl, FAOSTAT_AREAS, {}, 'FAOSTAT area codes');
    areaMap = parseFaostatAreaMap(areaPayload);
  } catch (err) {
    console.warn(`  FAOSTAT area map failed: ${err.message}`);
    stageNotes.faostat.areaMap = 'failed';
  }

  for (const commodity of Object.values(PSD_COMMODITIES)) {
    console.log(`  PSD ${commodity.slug}…`);
    const { year, parsed } = await selectLatestPsdYear(commodity, { fetchImpl, apiKey, now, gapMs });
    stageNotes.psd[commodity.slug] = { year, countries: parsed.length };
    let merged = parsed;
    if (year) {
      const faostatYears = [year - 1, year - 2, year - 3];
      let fill = null;
      for (const faoYear of faostatYears) {
        try {
          fill = await fetchFaostatProduction(commodity, faoYear, { fetchImpl, areaMap });
          if (fill.length) {
            stageNotes.faostat[commodity.slug] = { year: faoYear, rows: fill.length };
            break;
          }
        } catch (err) {
          console.warn(`  FAOSTAT ${commodity.slug} ${faoYear} failed: ${err.message}`);
          fill = err;
        }
        if (gapMs) await sleep(gapMs);
      }
      merged = applyFaostatProductionFill(parsed, fill, { commodity: commodity.slug });
    }
    allRecords.push(...merged);
    if (gapMs) await sleep(gapMs);
  }

  const snapshot = assembleFoodStocksSnapshot(allRecords);
  snapshot.stageNotes = stageNotes;
  snapshot.fetchedAt = now.toISOString();
  return snapshot;
}

export function declareRecords(data) {
  return Object.keys(data || {}).filter((key) => key !== 'stageNotes' && key !== 'fetchedAt').length;
}

export function validateFoodStocks(data) {
  if (!data || typeof data !== 'object') return false;
  const countries = Object.keys(data).filter((key) => key !== 'stageNotes' && key !== 'fetchedAt');
  if (countries.length < 10) return false;
  if (!data._world?.commodities) return false;
  return Object.values(data._world.commodities).some((rec) => Number.isFinite(rec?.stocksToUseRatio));
}

const isMain = process.argv[1]?.endsWith('seed-food-stocks.mjs');

if (isMain) {
  runSeed('resilience', 'food-stocks', CANONICAL_KEY, fetchFoodStocks, {
    validateFn: validateFoodStocks,
    ttlSeconds: FOOD_STOCKS_TTL_SECONDS,
    sourceVersion: FOOD_STOCKS_SOURCE_VERSION,
    recordCount: declareRecords,
    declareRecords,
    schemaVersion: 1,
    maxStaleMin: FOOD_STOCKS_MAX_STALE_MIN,
    contentMeta: foodStocksContentMeta,
    maxContentAgeMin: FOOD_STOCKS_MAX_CONTENT_AGE_MIN,
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
