// Shared per-company upstream fetchers for the corporate-intelligence handlers
// (issue #5695): Finnhub market profile + earnings surprises, and news mentions
// via the existing per-ticker headline search. All identity resolution happens
// upstream of these helpers through the SEC CIK registry (server/_shared/sec-edgar).

import type {
  CompanyMarketProfile,
  CompanyNewsMention,
  EarningsSurprise,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { cachedFetchJson } from '../../../_shared/redis';
import { finnhubGate } from '../../../_shared/constants';
import { searchRecentStockHeadlines } from '../../market/v1/stock-news-search';

const PROFILE_TTL = 86_400;
const EARNINGS_TTL = 43_200;
const NEGATIVE_TTL = 300;
const UPSTREAM_TIMEOUT = 10_000;
export const MAX_NEWS_MENTIONS = 5;

export function sanitizeCompanySymbol(raw: string): string {
  const t = (raw ?? '').trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) ? t : '';
}

interface FinnhubProfile {
  name?: string;
  exchange?: string;
  finnhubIndustry?: string;
  marketCapitalization?: number;
  ipo?: string;
  logo?: string;
  country?: string;
  currency?: string;
  weburl?: string;
}

export interface CompanyProfileResult {
  market: CompanyMarketProfile;
  website: string;
  name: string;
}

export async function fetchFinnhubCompanyProfile(symbol: string): Promise<CompanyProfileResult | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey || !symbol) return null;
  try {
    return await cachedFetchJson<CompanyProfileResult>(
      `intel:company:finnhub-profile:${symbol}`,
      PROFILE_TTL,
      async () => {
        try {
          await finnhubGate();
          const resp = await fetch(
            `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(symbol)}`,
            {
              headers: { 'X-Finnhub-Token': apiKey },
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
            },
          );
          if (!resp.ok) return null;
          const raw = (await resp.json()) as FinnhubProfile;
          if (!raw.name && !raw.exchange) return null;
          return {
            name: raw.name ?? '',
            website: raw.weburl ?? '',
            market: {
              exchange: raw.exchange ?? '',
              industry: raw.finnhubIndustry ?? '',
              marketCapMusd: Number.isFinite(raw.marketCapitalization) ? (raw.marketCapitalization as number) : 0,
              ipoDate: raw.ipo ?? '',
              logoUrl: raw.logo ?? '',
              country: raw.country ?? '',
              currency: raw.currency ?? '',
            },
          };
        } catch {
          return null;
        }
      },
      NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}

interface FinnhubEarningsRow {
  period?: string;
  actual?: number | null;
  estimate?: number | null;
  surprise?: number | null;
  surprisePercent?: number | null;
  year?: number;
  quarter?: number;
}

export async function fetchEarningsSurprises(symbol: string): Promise<EarningsSurprise[] | null> {
  const apiKey = process.env.FINNHUB_API_KEY;
  if (!apiKey || !symbol) return null;
  try {
    return await cachedFetchJson<EarningsSurprise[]>(
      `intel:company:earnings-surprises:${symbol}`,
      EARNINGS_TTL,
      async () => {
        try {
          await finnhubGate();
          const resp = await fetch(
            `https://finnhub.io/api/v1/stock/earnings?symbol=${encodeURIComponent(symbol)}&limit=8`,
            {
              headers: { 'X-Finnhub-Token': apiKey },
              signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
            },
          );
          if (!resp.ok) return null;
          const raw = (await resp.json()) as FinnhubEarningsRow[];
          if (!Array.isArray(raw)) return null;
          return raw
            .filter(row => typeof row?.period === 'string')
            .map(row => ({
              period: row.period ?? '',
              actualEps: Number.isFinite(row.actual) ? (row.actual as number) : 0,
              estimateEps: Number.isFinite(row.estimate) ? (row.estimate as number) : 0,
              surprise: Number.isFinite(row.surprise) ? (row.surprise as number) : 0,
              surprisePercent: Number.isFinite(row.surprisePercent) ? (row.surprisePercent as number) : 0,
              year: row.year ?? 0,
              quarter: row.quarter ?? 0,
            }))
            .sort((a, b) => (a.period < b.period ? 1 : -1));
        } catch {
          return null;
        }
      },
      NEGATIVE_TTL,
    );
  } catch {
    return null;
  }
}

export async function fetchCompanyNewsMentions(symbol: string, name: string): Promise<CompanyNewsMention[] | null> {
  if (!symbol) return null;
  try {
    const result = await searchRecentStockHeadlines(symbol, name, MAX_NEWS_MENTIONS);
    if (!result || !Array.isArray(result.headlines) || result.headlines.length === 0) return null;
    return result.headlines.slice(0, MAX_NEWS_MENTIONS).map(headline => ({
      title: headline.title,
      url: headline.link,
      source: headline.source,
      publishedAtMs: Number.isFinite(headline.publishedAt) ? headline.publishedAt : 0,
    }));
  } catch {
    return null;
  }
}
