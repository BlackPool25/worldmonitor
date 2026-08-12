import type {
  ResilienceServiceHandler,
  ServerContext,
  GetFoodStocksRequest,
  GetFoodStocksResponse,
} from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/resilience/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import {
  FOOD_STOCKS_CANONICAL_KEY,
  FOOD_STOCKS_WORLD_KEY,
  normalizeFoodStocksCommodity,
  normalizeFoodStocksCountry,
} from './_food-stocks-query';

const EMPTY: GetFoodStocksResponse = {
  records: [],
  fetchedAt: '',
  unavailable: true,
  calorieWeightedStocksToUse: 0,
};

export { normalizeFoodStocksCommodity, normalizeFoodStocksCountry };

function flattenSnapshot(
  snapshot: Record<string, unknown>,
  countryCode?: string,
  commodity?: string,
): Array<{
  countryCode: string;
  commodity: string;
  marketingYear: string;
  stocksToUse: number;
  endingStocksTmt: number;
  totalUseTmt: number;
  productionTmt: number;
  consumptionTmt: number;
  importsTmt: number;
  exportsTmt: number;
  unit: string;
  source: string;
}> {
  const rows = [];
  for (const [iso2, entry] of Object.entries(snapshot)) {
    if (iso2 === 'fetchedAt' || iso2 === 'stageNotes') continue;
    if (countryCode && iso2 !== countryCode) continue;
    const commodities = (entry as { commodities?: Record<string, Record<string, unknown>> })?.commodities;
    if (!commodities || typeof commodities !== 'object') continue;
    for (const [slug, rec] of Object.entries(commodities)) {
      if (commodity && slug !== commodity) continue;
      const consumption = Number(rec.consumption) || 0;
      const exports = Number(rec.exports) || 0;
      rows.push({
        countryCode: iso2,
        commodity: slug,
        marketingYear: String(rec.marketingYear ?? ''),
        stocksToUse: Number(rec.stocksToUseRatio) || 0,
        endingStocksTmt: Number(rec.endingStocks) || 0,
        totalUseTmt: consumption + exports,
        productionTmt: Number(rec.production) || 0,
        consumptionTmt: consumption,
        importsTmt: Number(rec.imports) || 0,
        exportsTmt: exports,
        unit: String(rec.unit ?? '1000 MT'),
        source: String(rec.source ?? ''),
      });
    }
  }
  return rows;
}

export const getFoodStocks: ResilienceServiceHandler['getFoodStocks'] = async (
  ctx: ServerContext,
  req: GetFoodStocksRequest,
): Promise<GetFoodStocksResponse> => {
  const countryCode = normalizeFoodStocksCountry(req.countryCode ?? '');
  if (countryCode === null) {
    throw new ValidationError([{
      field: 'countryCode',
      description: 'countryCode must be a 2-letter ISO 3166-1 alpha-2 code or WORLD',
    }]);
  }
  const commodity = normalizeFoodStocksCommodity(req.commodity ?? '');
  if (commodity === null) {
    throw new ValidationError([{
      field: 'commodity',
      description: 'commodity must be one of wheat, corn, rice, soybeans, barley, palmOil',
    }]);
  }

  try {
    const snapshot = await getCachedJson(FOOD_STOCKS_CANONICAL_KEY, true) as Record<string, unknown> | null;
    if (!snapshot || typeof snapshot !== 'object') {
      return markNoStoreFallbackResponse(ctx.request, EMPTY);
    }

    const records = flattenSnapshot(
      snapshot,
      countryCode || undefined,
      commodity || undefined,
    ).map((row) => ({
      countryCode: row.countryCode === FOOD_STOCKS_WORLD_KEY ? 'WORLD' : row.countryCode,
      commodity: row.commodity,
      marketingYear: row.marketingYear,
      stocksToUse: row.stocksToUse,
      endingStocksTmt: row.endingStocksTmt,
      totalUseTmt: row.totalUseTmt,
      productionTmt: row.productionTmt,
      consumptionTmt: row.consumptionTmt,
      importsTmt: row.importsTmt,
      exportsTmt: row.exportsTmt,
      unit: row.unit,
      source: row.source,
    }));

    if (records.length === 0 && (countryCode || commodity)) {
      return {
        records: [],
        fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '',
        unavailable: false,
        calorieWeightedStocksToUse: 0,
      };
    }
    if (records.length === 0) {
      return markNoStoreFallbackResponse(ctx.request, EMPTY);
    }

    const countryEntry = countryCode
      ? (snapshot[countryCode] as { aggregate?: { calorieWeightedStocksToUse?: number | null } } | undefined)
      : undefined;
    const calorie = countryEntry?.aggregate?.calorieWeightedStocksToUse;

    return {
      records,
      fetchedAt: typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '',
      unavailable: false,
      calorieWeightedStocksToUse: Number.isFinite(calorie) ? Number(calorie) : 0,
    };
  } catch {
    return markNoStoreFallbackResponse(ctx.request, EMPTY);
  }
};
