/**
 * Deterministic bootstrap payload-budget fixtures for #7046.
 *
 * U1 of #7045 is supposed to land the production-shaped ledger first. This
 * issue still has to ratchet the ceilings, so the fixtures are built from
 * repository-owned samples (energy seed JSON) plus field-complete
 * representative records for the demoted fast keys. Shrinking those records
 * fails the self-check below; removing the energy keys or the demoted fast
 * keys is the only way the post-change totals drop.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const ENERGY_ON_DEMAND_KEYS = Object.freeze([
  'pipelinesGas',
  'pipelinesOil',
  'storageFacilities',
]);

export const DEMOTED_FAST_KEYS = Object.freeze([
  'marketQuotes',
  'commodityQuotes',
  'forecasts',
  'correlationCards',
  'socialVelocity',
  'flightDelays',
  'wsbTickers',
]);

export const FAST_FIRST_PAINT_JUSTIFICATION = Object.freeze({
  earthquakes: 'Default-on natural map layer; consumed by loadNatural after the slow checkpoint but needed for the first map fill.',
  outages: 'Default-on outages map layer and internet-disruptions status.',
  serviceStatuses: 'Paired with the outages first-wave status strip.',
  ddosAttacks: 'Loaded with the default-on outages wave.',
  trafficAnomalies: 'Loaded with the default-on outages wave.',
  macroSignals: 'Immediate macro tiles on finance/full first paint.',
  chokepoints: 'Chokepoint strip and default supply-chain map markers.',
  positiveGeoEvents: 'Happy/full positive-events first wave.',
  riskScores: 'CII / strategic-risk first-wave scores.',
  insights: 'Insights / threat-timeline first-wave cards.',
  predictions: 'Polymarket first-wave when the panel is in view.',
  iranEvents: 'Iran-attacks layer when the sunset gate is on.',
  temporalAnomalies: 'Consumed into the signal aggregator at startup.',
  weatherAlerts: 'Default-on weather map layer on full desktop and mobile.',
  spending: 'Economic panel first-wave when the layer/panel is in view.',
  theaterPosture: 'Strategic-posture first-wave.',
  gdeltIntel: 'GDELT intel first-wave.',
  canadaAlerts: 'Default-on Canada alerts layer on full desktop.',
  shippingRates: 'Supply-chain first-wave rates.',
  shippingStress: 'Supply-chain first-wave stress.',
});

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

export function utf8Bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function publicPayloadBytes(data, missing = []) {
  return utf8Bytes({ data, missing });
}

export function loadEnergyRegistryPayloads() {
  return {
    pipelinesGas: readJson('scripts/data/pipelines-gas.json'),
    pipelinesOil: readJson('scripts/data/pipelines-oil.json'),
    storageFacilities: readJson('scripts/data/storage-facilities.json'),
  };
}

function quoteRecord(symbol, index) {
  return {
    symbol,
    name: `Index ${index}`,
    price: 100 + index,
    change: 0.25,
    changePercent: 0.4,
    volume: 1_000_000 + index,
    marketCap: 50_000_000_000 + index,
    currency: 'USD',
    exchange: 'NYSE',
    updatedAt: '2026-08-21T08:00:00Z',
  };
}

function delayRecord(index) {
  return {
    id: `delay-${index}`,
    iata: `A${String(index).padStart(2, '0')}`,
    severity: 'moderate',
    type: 'departure_delay',
    summary: `Airport ${index} departure delays from weather and volume.`,
    updatedAt: '2026-08-21T08:00:00Z',
  };
}

export function representativeDemotedFastPayloads() {
  const marketQuotes = {
    quotes: Array.from({ length: 80 }, (_, i) => quoteRecord(`EQ${i}`, i)),
  };
  const commodityQuotes = {
    quotes: Array.from({ length: 40 }, (_, i) => quoteRecord(`CM${i}`, i)),
  };
  const forecasts = {
    predictions: Array.from({ length: 24 }, (_, i) => ({
      id: `fc-${i}`,
      title: `Forecast ${i}`,
      probability: 0.4,
      generatedAt: 1_724_000_000 + i,
    })),
    generatedAt: 1_724_000_000,
  };
  const correlationCards = {
    geopolitics: Array.from({ length: 12 }, (_, i) => ({
      id: `cc-${i}`,
      score: 70 + i,
      title: `Convergence ${i}`,
      summary: 'Cross-domain convergence card used by the correlation panel.',
    })),
  };
  const socialVelocity = {
    items: Array.from({ length: 30 }, (_, i) => ({
      id: `sv-${i}`,
      subreddit: 'worldnews',
      score: 100 + i,
      title: `Velocity item ${i}`,
    })),
  };
  const flightDelays = {
    alerts: Array.from({ length: 40 }, (_, i) => delayRecord(i)),
  };
  const wsbTickers = {
    tickers: Array.from({ length: 25 }, (_, i) => ({
      symbol: `T${i}`,
      mentionCount: 10 + i,
      uniquePosts: 4 + i,
      totalScore: 200 + i,
      avgUpvoteRatio: 0.8,
      subreddits: ['wallstreetbets'],
      velocityScore: 1.2,
    })),
  };
  return {
    marketQuotes,
    commodityQuotes,
    forecasts,
    correlationCards,
    socialVelocity,
    flightDelays,
    wsbTickers,
  };
}

export function remainingFastStubPayloads() {
  return Object.fromEntries(
    Object.keys(FAST_FIRST_PAINT_JUSTIFICATION).map((key) => [
      key,
      { key, records: [{ id: `${key}-1`, title: `${key} first-paint record` }] },
    ]),
  );
}

export function otherSlowStubPayloads() {
  return {
    wildfires: { fires: Array.from({ length: 20 }, (_, i) => ({ id: `wf-${i}` })) },
    naturalEvents: { events: Array.from({ length: 20 }, (_, i) => ({ id: `ne-${i}` })) },
    sectors: { valuations: { XLE: { name: 'Energy', changePercent: 0.2 } } },
  };
}

export function buildSlowPayload({ includeEnergy }) {
  const data = { ...otherSlowStubPayloads() };
  if (includeEnergy) Object.assign(data, loadEnergyRegistryPayloads());
  return { data, missing: [] };
}

export function buildFastPayload({ includeDemoted }) {
  const data = { ...remainingFastStubPayloads() };
  if (includeDemoted) Object.assign(data, representativeDemotedFastPayloads());
  return { data, missing: [] };
}

export function energyRegistrySelfCheck(payloads = loadEnergyRegistryPayloads()) {
  const gasCount = Object.keys(payloads.pipelinesGas.pipelines ?? {}).length;
  const oilCount = Object.keys(payloads.pipelinesOil.pipelines ?? {}).length;
  const storageCount = Object.keys(payloads.storageFacilities.facilities ?? {}).length;
  return { gasCount, oilCount, storageCount };
}

export function demotedFastSelfCheck(payloads = representativeDemotedFastPayloads()) {
  return {
    marketQuotes: payloads.marketQuotes.quotes.length,
    commodityQuotes: payloads.commodityQuotes.quotes.length,
    forecasts: payloads.forecasts.predictions.length,
    correlationCards: payloads.correlationCards.geopolitics.length,
    socialVelocity: payloads.socialVelocity.items.length,
    flightDelays: payloads.flightDelays.alerts.length,
    wsbTickers: payloads.wsbTickers.tickers.length,
  };
}

export const FIXTURE_MINIMUMS = Object.freeze({
  gasCount: 20,
  oilCount: 20,
  storageCount: 15,
  marketQuotes: 80,
  commodityQuotes: 40,
  forecasts: 24,
  correlationCards: 12,
  socialVelocity: 30,
  flightDelays: 40,
  wsbTickers: 25,
});
