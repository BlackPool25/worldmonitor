/**
 * RPC: listCompanySignals — classified company signals from authoritative
 * sources (issue #5695): SEC 8-K material events (tier 1), earnings surprises
 * (tier 2), and recent news mentions (tier 3).
 *
 * Identity resolves exclusively through the SEC ticker/name registry
 * (server/_shared/sec-edgar) — no keyword or domain-slug guessing (the unsound
 * heuristics removed in issues #3754/#3755, PR #3777). Engagement metrics are
 * intentionally omitted: none of these sources provide real engagement data.
 */

import type {
  ServerContext,
  CompanySignal,
  ListCompanySignalsRequest,
  ListCompanySignalsResponse,
  SignalSummary,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import { ValidationError } from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import {
  MATERIAL_8K_ITEMS,
  fetchSecSubmissions,
  filingIndexUrl,
  resolveCompany,
} from '../../../_shared/sec-edgar';
import { fetchCompanyNewsMentions, fetchEarningsSurprises } from './_company-shared';

const FILING_SIGNAL_WINDOW_MS = 90 * 24 * 3600 * 1000;
const MAX_SIGNALS = 30;

// 8-K item code → signal classification for the highest-value disclosures.
// Anything else material falls back to "Material Event".
const SIGNAL_TYPE_BY_ITEM: Record<string, string> = {
  '1.01': 'M&A / Agreement',
  '1.02': 'M&A / Agreement',
  '1.03': 'Bankruptcy',
  '1.05': 'Cybersecurity Incident',
  '2.01': 'M&A / Agreement',
  '2.02': 'Financial Results',
  '2.04': 'Debt Acceleration',
  '2.06': 'Impairment',
  '3.01': 'Delisting Risk',
  '4.01': 'Accountant Change',
  '4.02': 'Restatement',
  '5.01': 'Control Change',
  '5.02': 'Executive Change',
};

export async function listCompanySignals(
  _ctx: ServerContext,
  req: ListCompanySignalsRequest,
): Promise<ListCompanySignalsResponse> {
  const company = req.company?.trim();
  const domain = req.domain?.trim().toLowerCase();
  const ticker = req.ticker?.trim();

  if (!company && !domain && !ticker) {
    throw new ValidationError([{ field: 'company', description: 'Provide ticker, company, or domain' }]);
  }

  const resolved = await resolveCompany({ ticker, name: company, domain });
  if (!resolved) {
    return emptyResponse(company || ticker?.toUpperCase() || '', domain || '');
  }

  const [submissions, earnings, mentions] = await Promise.all([
    fetchSecSubmissions(resolved.cik),
    fetchEarningsSurprises(resolved.ticker),
    fetchCompanyNewsMentions(resolved.ticker, resolved.name),
  ]);

  const now = Date.now();
  const signals: CompanySignal[] = [];

  for (const filing of submissions?.filings ?? []) {
    if (!filing.form.startsWith('8-K')) continue;
    const materialItems = filing.items.filter(code => {
      const item = MATERIAL_8K_ITEMS[code];
      return item && item.materiality !== 'routine';
    });
    if (materialItems.length === 0) continue;
    const timestampMs = Date.parse(filing.acceptanceDateTime || filing.filingDate) || 0;
    if (timestampMs === 0 || now - timestampMs > FILING_SIGNAL_WINDOW_MS) continue;
    const primaryItem = materialItems[0] as string;
    signals.push({
      type: SIGNAL_TYPE_BY_ITEM[primaryItem] ?? 'Material Event',
      title: `${filing.form}: ${materialItems.map(code => MATERIAL_8K_ITEMS[code]?.description ?? `Item ${code}`).join('; ')}`,
      url: filing.accessionNumber ? filingIndexUrl(resolved.cik, filing.accessionNumber) : '',
      source: 'sec_edgar',
      sourceTier: 1,
      timestampMs,
      strength: MATERIAL_8K_ITEMS[primaryItem]?.materiality === 'high' ? 'Strong' : 'Moderate',
      engagement: undefined,
    });
  }

  for (const surprise of earnings ?? []) {
    if (!surprise.period || (surprise.actualEps === 0 && surprise.estimateEps === 0)) continue;
    const timestampMs = Date.parse(surprise.period) || 0;
    if (timestampMs === 0) continue;
    const beat = surprise.surprise >= 0;
    const magnitude = Math.abs(surprise.surprisePercent);
    signals.push({
      type: beat ? 'Earnings Beat' : 'Earnings Miss',
      title: `Q${surprise.quarter} ${surprise.year}: EPS ${surprise.actualEps} vs ${surprise.estimateEps} est (${surprise.surprisePercent >= 0 ? '+' : ''}${surprise.surprisePercent.toFixed(2)}%)`,
      url: '',
      source: 'finnhub',
      sourceTier: 2,
      timestampMs,
      strength: magnitude >= 5 ? 'Strong' : magnitude >= 1 ? 'Moderate' : 'Marginal',
      engagement: undefined,
    });
  }

  for (const mention of mentions ?? []) {
    signals.push({
      type: 'News Mention',
      title: mention.title,
      url: mention.url,
      source: mention.source || 'news',
      sourceTier: 3,
      timestampMs: mention.publishedAtMs,
      strength: 'Emerging',
      engagement: undefined,
    });
  }

  signals.sort((a, b) => b.timestampMs - a.timestampMs);
  const bounded = signals.slice(0, MAX_SIGNALS);

  return {
    company: resolved.name,
    domain: domain || '',
    signals: bounded,
    summary: summarize(bounded),
    discoveredAtMs: now,
  };
}

function summarize(signals: CompanySignal[]): SignalSummary {
  const byType: Record<string, number> = {};
  for (const signal of signals) {
    byType[signal.type] = (byType[signal.type] ?? 0) + 1;
  }
  const strengthRank: Record<string, number> = { Strong: 3, Moderate: 2, Emerging: 1, Marginal: 1 };
  const strongest = [...signals].sort((a, b) => {
    const rank = (strengthRank[b.strength] ?? 0) - (strengthRank[a.strength] ?? 0);
    if (rank !== 0) return rank;
    const tier = a.sourceTier - b.sourceTier;
    if (tier !== 0) return tier;
    return b.timestampMs - a.timestampMs;
  })[0];
  return {
    totalSignals: signals.length,
    byType,
    strongestSignal: strongest,
    signalDiversity: new Set(signals.map(signal => signal.source)).size,
  };
}

function emptyResponse(company: string, domain: string): ListCompanySignalsResponse {
  return {
    company,
    domain,
    signals: [],
    summary: {
      totalSignals: 0,
      byType: {},
      strongestSignal: undefined,
      signalDiversity: 0,
    },
    discoveredAtMs: Date.now(),
  };
}
