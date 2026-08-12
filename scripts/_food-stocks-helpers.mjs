// Pure PSD / FAOSTAT food-stocks parsers shared by seed-food-stocks.mjs and tests.
//
// Shape contract: one Redis payload at resilience:food-stocks:v1 keyed by ISO-2
// (plus `_world`). Each country holds per-commodity balances whose clock is the
// marketing-year label, never a calendar year. FAOSTAT may fill production for
// countries PSD does not cover; it never overwrites PSD and never invents stocks.

export const FOOD_STOCKS_CANONICAL_KEY = 'resilience:food-stocks:v1';
export const FOOD_STOCKS_WORLD_KEY = '_world';
export const FOOD_STOCKS_SOURCE_VERSION = 'food-stocks-v1';

// Monthly WASDE cycle. Health fetch-age uses 2× (60d); content-age uses 3× so a
// still-current marketing year is not paged while the next MY is not yet posted.
export const FOOD_STOCKS_MAX_STALE_MIN = 60 * 24 * 60;
export const FOOD_STOCKS_MAX_CONTENT_AGE_MIN = 90 * 24 * 60;
export const FOOD_STOCKS_TTL_SECONDS = 90 * 24 * 3600;

export const PSD_COMMODITIES = {
  wheat: { slug: 'wheat', code: '0410000', name: 'Wheat', unit: '1000 MT', faostatItem: 15 },
  corn: { slug: 'corn', code: '0440000', name: 'Corn', unit: '1000 MT', faostatItem: 56 },
  rice: { slug: 'rice', code: '0422110', name: 'Rice, Milled', unit: '1000 MT', faostatItem: 27 },
  soybeans: { slug: 'soybeans', code: '2222000', name: 'Oilseed, Soybean', unit: '1000 MT', faostatItem: 236 },
  barley: { slug: 'barley', code: '0430000', name: 'Barley', unit: '1000 MT', faostatItem: 44 },
  palmOil: { slug: 'palmOil', code: '4243000', name: 'Oil, Palm', unit: '1000 MT', faostatItem: 257 },
};

export const PSD_ATTRIBUTES = {
  BEGINNING_STOCKS: 20,
  PRODUCTION: 28,
  IMPORTS: 57,
  TOTAL_SUPPLY: 86,
  EXPORTS: 88,
  DOMESTIC_CONSUMPTION: 125,
  ENDING_STOCKS: 176,
  TOTAL_DISTRIBUTION: 178,
};

// FAO Food Balance / USDA handbook kcal per kg. Used only for the country
// aggregate; raw PSD units stay on each commodity row.
export const COMMODITY_KCAL_PER_KG = {
  wheat: 3340,
  corn: 3650,
  rice: 3600,
  soybeans: 1470,
  barley: 3320,
  palmOil: 8840,
};

export function normalizePsdCommodityCode(code) {
  const digits = String(code ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(7, '0');
}

export function commoditySlugFromCode(code) {
  const padded = normalizePsdCommodityCode(code);
  return Object.values(PSD_COMMODITIES).find((item) => item.code === padded)?.slug ?? null;
}

export function formatMarketingYear(marketYear) {
  if (typeof marketYear === 'string' && /^\d{4}\/\d{2}$/.test(marketYear)) return marketYear;
  const year = Number.parseInt(String(marketYear ?? ''), 10);
  if (!Number.isInteger(year) || year < 1960 || year > 2100) return null;
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
}

export function parseMarketingYearStart(label) {
  if (typeof label !== 'string' || !/^\d{4}\/\d{2}$/.test(label)) return null;
  const start = Number.parseInt(label.slice(0, 4), 10);
  return Number.isInteger(start) ? start : null;
}

export function normalizePsdCountryCode(code) {
  if (code === 0 || code === '0') return FOOD_STOCKS_WORLD_KEY;
  const raw = String(code ?? '').trim();
  if (!raw) return null;
  const upper = raw.toUpperCase();
  if (upper === 'WORLD' || upper === 'WLD') return FOOD_STOCKS_WORLD_KEY;
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}

export function computeStocksToUseRatio(endingStocks, consumption, exports) {
  if (!Number.isFinite(endingStocks)) return null;
  if (consumption != null && !Number.isFinite(consumption)) return null;
  if (exports != null && !Number.isFinite(exports)) return null;
  const use = (Number.isFinite(consumption) ? consumption : 0) + (Number.isFinite(exports) ? exports : 0);
  if (use <= 0) return null;
  return endingStocks / use;
}

export function bucketKey(record) {
  return `${record.countryCode}:${record.commodity}:${record.marketingYear}`;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function vintageRank(calendarYear, month) {
  const year = Number(calendarYear);
  const mo = Number(month);
  if (!Number.isInteger(year)) return -1;
  const safeMonth = Number.isInteger(mo) && mo >= 1 && mo <= 12 ? mo : 0;
  return year * 100 + safeMonth;
}

/**
 * Collapse a PSD attribute-row array into one record per country × marketing year.
 * Rows from an older WASDE vintage of the same country-MY are dropped.
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {{ commodity?: string }} [opts]
 */
export function parsePsdForecastRows(rows, opts = {}) {
  if (!Array.isArray(rows)) return [];
  /** @type {Map<string, { countryCode: string, commodity: string, marketingYear: string, marketYear: number, forecastYear: number, forecastMonth: number, values: Record<number, number>, unitId: number | null }>} */
  const groups = new Map();

  for (const row of rows) {
    const countryCode = normalizePsdCountryCode(row?.countryCode);
    const marketingYear = formatMarketingYear(row?.marketYear);
    const commodity = opts.commodity || commoditySlugFromCode(row?.commodityCode);
    if (!countryCode || !marketingYear || !commodity) continue;

    const key = `${countryCode}:${commodity}:${marketingYear}`;
    const rank = vintageRank(row?.calendarYear, row?.month);
    const existing = groups.get(key);
    if (!existing || rank > vintageRank(existing.forecastYear, existing.forecastMonth)) {
      groups.set(key, {
        countryCode,
        commodity,
        marketingYear,
        marketYear: Number.parseInt(String(row.marketYear), 10),
        forecastYear: Number(row?.calendarYear) || 0,
        forecastMonth: Number(row?.month) || 0,
        values: {},
        unitId: Number.isFinite(Number(row?.unitId)) ? Number(row.unitId) : null,
      });
    }
    const group = groups.get(key);
    if (vintageRank(row?.calendarYear, row?.month) < vintageRank(group.forecastYear, group.forecastMonth)) {
      continue;
    }
    const attr = Number(row?.attributeId);
    const value = Number(row?.value);
    if (Number.isInteger(attr) && Number.isFinite(value)) {
      group.values[attr] = value;
      if (attr === PSD_ATTRIBUTES.PRODUCTION || attr === PSD_ATTRIBUTES.ENDING_STOCKS) {
        group.unitId = Number.isFinite(Number(row?.unitId)) ? Number(row.unitId) : group.unitId;
      }
    }
  }

  const records = [];
  for (const group of groups.values()) {
    const production = finiteOrNull(group.values[PSD_ATTRIBUTES.PRODUCTION]);
    const consumption = finiteOrNull(group.values[PSD_ATTRIBUTES.DOMESTIC_CONSUMPTION]);
    const imports = finiteOrNull(group.values[PSD_ATTRIBUTES.IMPORTS]);
    const exports = finiteOrNull(group.values[PSD_ATTRIBUTES.EXPORTS]);
    const endingStocks = finiteOrNull(group.values[PSD_ATTRIBUTES.ENDING_STOCKS]);
    if (production == null && consumption == null && endingStocks == null) continue;
    records.push({
      countryCode: group.countryCode,
      commodity: group.commodity,
      marketingYear: group.marketingYear,
      marketYear: group.marketYear,
      forecastYear: group.forecastYear,
      forecastMonth: group.forecastMonth,
      production,
      consumption,
      imports,
      exports,
      endingStocks,
      stocksToUseRatio: computeStocksToUseRatio(endingStocks, consumption, exports),
      unit: PSD_COMMODITIES[group.commodity]?.unit ?? '1000 MT',
      source: 'psd',
    });
  }
  return records;
}

function faostatRows(input) {
  if (input == null || input instanceof Error) return null;
  if (!Array.isArray(input)) return null;
  return input;
}

/**
 * Add FAOSTAT production for countries PSD missed. A null/Error fill is a
 * no-op so a failed FAOSTAT stage cannot damage the PSD snapshot.
 *
 * @param {Array<Record<string, unknown>>} psdRecords
 * @param {Array<Record<string, unknown>> | Error | null} faostatRecords
 * @param {{ commodity: string }} opts
 */
export function applyFaostatProductionFill(psdRecords, faostatRecords, opts) {
  const base = Array.isArray(psdRecords) ? psdRecords.slice() : [];
  const fill = faostatRows(faostatRecords);
  if (!fill) return base;

  const commodity = opts?.commodity;
  const covered = new Set(
    base.filter((rec) => rec.commodity === commodity).map((rec) => rec.countryCode),
  );
  const fallbackYear = base
    .filter((rec) => rec.commodity === commodity)
    .map((rec) => rec.marketingYear)
    .sort()
    .at(-1) ?? formatMarketingYear(new Date().getUTCFullYear() - 1);

  for (const row of fill) {
    const countryCode = normalizePsdCountryCode(row?.countryCode);
    const rowCommodity = row?.commodity || commodity;
    if (!countryCode || rowCommodity !== commodity) continue;
    if (covered.has(countryCode)) continue;
    const production = finiteOrNull(Number(row?.production));
    if (production == null) continue;
    covered.add(countryCode);
    base.push({
      countryCode,
      commodity,
      marketingYear: formatMarketingYear(row?.marketingYear) || fallbackYear,
      production,
      consumption: null,
      imports: null,
      exports: null,
      endingStocks: null,
      stocksToUseRatio: null,
      unit: PSD_COMMODITIES[commodity]?.unit ?? '1000 MT',
      source: 'faostat',
    });
  }
  return base;
}

export function computeCalorieWeightedStocksToUse(commodities) {
  if (!commodities || typeof commodities !== 'object') return null;
  let weighted = 0;
  let weight = 0;
  for (const [slug, rec] of Object.entries(commodities)) {
    const kcal = COMMODITY_KCAL_PER_KG[slug];
    const consumption = rec?.consumption;
    const ratio = rec?.stocksToUseRatio;
    if (!Number.isFinite(kcal) || !Number.isFinite(consumption) || consumption <= 0 || !Number.isFinite(ratio)) {
      continue;
    }
    const w = consumption * kcal;
    weighted += ratio * w;
    weight += w;
  }
  return weight > 0 ? weighted / weight : null;
}

export function toCommodityPayload(record) {
  return {
    marketingYear: record.marketingYear,
    production: record.production,
    consumption: record.consumption,
    imports: record.imports,
    exports: record.exports,
    endingStocks: record.endingStocks,
    stocksToUseRatio: record.stocksToUseRatio,
    unit: record.unit,
    source: record.source,
  };
}

export function buildCountryRecord(countryCode, commodities) {
  return {
    countryCode,
    commodities,
    aggregate: {
      calorieWeightedStocksToUse: computeCalorieWeightedStocksToUse(commodities),
    },
  };
}

/**
 * Fold flat parser rows into the Redis snapshot: ISO-2 / `_world` →
 * `{ commodities, aggregate }`.
 *
 * @param {Array<Record<string, unknown>>} records
 */
export function assembleFoodStocksSnapshot(records) {
  /** @type {Map<string, Record<string, ReturnType<typeof toCommodityPayload>>>} */
  const byCountry = new Map();
  for (const rec of records) {
    const countryCode = normalizePsdCountryCode(rec.countryCode) || rec.countryCode;
    if (!countryCode || !rec.commodity || !rec.marketingYear) continue;
    if (!byCountry.has(countryCode)) byCountry.set(countryCode, {});
    const existing = byCountry.get(countryCode)[rec.commodity];
    if (!existing || String(rec.marketingYear) > String(existing.marketingYear)) {
      byCountry.get(countryCode)[rec.commodity] = toCommodityPayload(rec);
    }
  }

  /** @type {Record<string, ReturnType<typeof buildCountryRecord>>} */
  const snapshot = {};
  for (const [countryCode, commodities] of byCountry) {
    snapshot[countryCode] = buildCountryRecord(countryCode, commodities);
  }
  return snapshot;
}

export function latestMarketingYearPresent(snapshot) {
  let latest = null;
  const visit = (commodities) => {
    if (!commodities || typeof commodities !== 'object') return;
    for (const rec of Object.values(commodities)) {
      const label = rec?.marketingYear;
      if (typeof label === 'string' && (!latest || label > latest)) latest = label;
    }
  };
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (snapshot.commodities) visit(snapshot.commodities);
  for (const value of Object.values(snapshot)) {
    if (value && typeof value === 'object' && value.commodities) visit(value.commodities);
  }
  return latest;
}

export function marketingYearEndMs(label) {
  const start = parseMarketingYearStart(label);
  if (start == null) return null;
  // Conservative end: 31 Aug of the ending year (covers US corn MY).
  return Date.UTC(start + 1, 7, 31, 23, 59, 59, 999);
}

/**
 * Content-age signal for runSeed. Clock is the latest marketing year present,
 * not the seeder's fetchedAt. A still-running MY reports age 0; an abandoned
 * MY ends on 31 Aug of its closing year.
 *
 * @param {Record<string, unknown>} data
 * @param {number} [nowMs]
 */
export function foodStocksContentMeta(data, nowMs = Date.now()) {
  const latest = latestMarketingYearPresent(data);
  const end = marketingYearEndMs(latest);
  if (end == null) return null;
  const newestItemAt = Math.min(end, nowMs);
  if (newestItemAt > nowMs + 60 * 60 * 1000) return null;
  return { newestItemAt, oldestItemAt: newestItemAt };
}

export function flattenSnapshotRecords(snapshot, { countryCode, commodity } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const wantedCountry = countryCode ? normalizePsdCountryCode(countryCode) || String(countryCode).toUpperCase() : null;
  const wantedCommodity = commodity ? String(commodity) : null;
  const rows = [];
  for (const [iso2, entry] of Object.entries(snapshot)) {
    if (iso2 === 'fetchedAt') continue;
    if (wantedCountry && iso2 !== wantedCountry) continue;
    const commodities = entry?.commodities;
    if (!commodities || typeof commodities !== 'object') continue;
    for (const [slug, rec] of Object.entries(commodities)) {
      if (wantedCommodity && slug !== wantedCommodity) continue;
      rows.push({
        countryCode: iso2,
        commodity: slug,
        marketingYear: rec.marketingYear ?? '',
        stocksToUse: rec.stocksToUseRatio ?? 0,
        endingStocksTmt: rec.endingStocks ?? 0,
        totalUseTmt: (Number(rec.consumption) || 0) + (Number(rec.exports) || 0),
        productionTmt: rec.production ?? 0,
        consumptionTmt: rec.consumption ?? 0,
        importsTmt: rec.imports ?? 0,
        exportsTmt: rec.exports ?? 0,
        unit: rec.unit ?? '1000 MT',
        source: rec.source ?? '',
      });
    }
  }
  return rows;
}
