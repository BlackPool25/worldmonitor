/**
 * RPC: getCompanyEnrichment — per-company intelligence composite (issue #5695).
 *
 * Identity resolves exclusively through the SEC's own ticker/name registry to a
 * CIK (server/_shared/sec-edgar). Legs, each independently cached and degradable:
 *   - SEC EDGAR submissions: filer profile + recent filings (source "sec_edgar")
 *   - Finnhub: market profile + earnings surprises (source "finnhub")
 *   - Per-ticker headline search: recent news mentions (source "news")
 *
 * Predecessor history: the original handler guessed a code-host org from the
 * domain label and attributed unrelated footprints (issues #3754/#3755); it was
 * disabled in PR #3777. This implementation performs no domain-slug guessing —
 * an unresolvable company returns an empty envelope with sources: [].
 */

import type {
  ServerContext,
  GetCompanyEnrichmentRequest,
  GetCompanyEnrichmentResponse,
  SecFiling,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  describeItemCodes,
  fetchSecSubmissions,
  filingIndexUrl,
  isRelevantForm,
  resolveCompany,
} from '../../../_shared/sec-edgar';
import {
  fetchCompanyNewsMentions,
  fetchFinnhubCompanyAndEarnings,
} from './_company-shared';

const MAX_RECENT_FILINGS = 15;

export async function getCompanyEnrichment(
  _ctx: ServerContext,
  req: GetCompanyEnrichmentRequest,
): Promise<GetCompanyEnrichmentResponse> {
  const name = req.name?.trim();
  const ticker = req.ticker?.trim();

  if (!name && !ticker) {
    throw new ValidationError([{ field: 'ticker', description: 'Provide ticker or name' }]);
  }

  const resolution = await resolveCompany({ ticker, name });
  if (resolution.status !== 'ok') {
    // "not_found" is a real, cacheable answer; "registry_unavailable" is a
    // lookup failure and must not be cached as one.
    return unresolved(ticker, name, resolution.status === 'registry_unavailable');
  }
  const resolved = resolution.company;

  // Finnhub profile + earnings share one gate on cold miss (30/min budget).
  const [submissions, finnhub, mentions] = await Promise.all([
    fetchSecSubmissions(resolved.cik),
    fetchFinnhubCompanyAndEarnings(resolved.ticker),
    fetchCompanyNewsMentions(resolved.ticker, resolved.name),
  ]);
  const profile = finnhub.profile;
  const earnings = finnhub.earnings;

  const sources: string[] = [];
  if (submissions) sources.push('sec_edgar');
  if (profile || earnings) sources.push('finnhub');
  if (mentions) sources.push('news');

  // submissions.filings is already isRelevantForm-filtered; keep that single
  // predicate (includes 40-F and slash-amendments) rather than a second Set.
  const recentFilings: SecFiling[] = (submissions?.filings ?? [])
    .filter(filing => isRelevantForm(filing.form))
    .slice(0, MAX_RECENT_FILINGS)
    .map(filing => ({
      form: filing.form,
      fileDate: filing.filingDate,
      description: filing.form.startsWith('8-K') && filing.items.length > 0
        ? describeItemCodes(filing.items)
        : '',
      url: filing.accessionNumber ? filingIndexUrl(resolved.cik, filing.accessionNumber) : '',
      items: filing.items,
    }));

  const city = submissions?.city ?? '';
  const region = submissions?.stateOrCountry ?? '';
  // SEC submissions carry a `website` field but leave it empty in practice, so
  // the reported domain comes from the market profile in almost every case.
  const website = submissions?.website || profile?.website || '';

  return {
    company: {
      name: submissions?.name || resolved.name,
      // Always the resolved filer's own domain — never an echo of caller input.
      domain: safeDomainFromWebsite(website),
      description: submissions?.sicDescription ?? '',
      location: city && region ? `${city}, ${region}` : city || region,
      website,
      cik: resolved.cik,
      ticker: resolved.ticker,
    },
    secFilings: submissions
      ? { totalFilings: submissions.totalRecentFilings, recentFilings }
      : undefined,
    enrichedAtMs: Date.now(),
    sources,
    market: profile?.market,
    earningsSurprises: earnings ?? [],
    newsMentions: mentions ?? [],
    unavailable: false,
  };
}

function unresolved(ticker?: string, name?: string, unavailable = false): GetCompanyEnrichmentResponse {
  return {
    company: {
      name: name || '',
      domain: '',
      description: '',
      location: '',
      website: '',
      cik: '',
      ticker: ticker?.toUpperCase() || '',
    },
    secFilings: undefined,
    enrichedAtMs: Date.now(),
    sources: [],
    market: undefined,
    earningsSurprises: [],
    newsMentions: [],
    unavailable,
  };
}

function safeDomainFromWebsite(website: string): string {
  if (!website) return '';
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
