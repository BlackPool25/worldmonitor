#!/usr/bin/env node
/**
 * On-demand TPS Open Data fetch (#7012).
 *
 * NOT a seed-bundle-canada member. NOT a Railway cron. NOT a bootstrap
 * FAST/SLOW key. Capacity decision: the 486k-row MCI FeatureServer cannot
 * fit the Canada bundle's 570s wall budget; keep this as a bounded
 * on-demand worker. Invoke explicitly.
 *
 * Usage:
 *   node scripts/seed-tps-open-data.mjs
 */
import { loadEnvFile, readSeedSnapshot, runSeed } from './_seed-utils.mjs';
import {
  TPS_CALLS_KEY,
  TPS_CALLS_META_KEY,
  TPS_MCI_KEY,
  TPS_MAX_STALE_MIN,
  TPS_SOURCE_VERSION,
  TPS_TTL_SECONDS,
  declareTpsRecords,
  fetchTpsCallsAttended,
  fetchTpsMci,
  resolveTpsPublish,
  validateTpsCallsSnapshot,
  validateTpsMciSnapshot,
} from './lib/tps-open-data.mjs';

loadEnvFile(import.meta.url);

export { TPS_CALLS_KEY, TPS_MCI_KEY, TPS_CALLS_META_KEY };

async function fetchMciOnDemand() {
  let lastGood = null;
  try { lastGood = await readSeedSnapshot(TPS_MCI_KEY); } catch { lastGood = null; }
  const fetchResult = await fetchTpsMci();
  const decision = resolveTpsPublish(fetchResult, lastGood, validateTpsMciSnapshot);
  if (decision.persist) return decision.snapshot;
  if (decision.keepLastGood && lastGood) return lastGood;
  return { sourceUnavailable: true, records: [], semantic: 'reported_occurrence' };
}

async function fetchCallsOnDemand() {
  let lastGood = null;
  try { lastGood = await readSeedSnapshot(TPS_CALLS_KEY); } catch { lastGood = null; }
  const fetchResult = await fetchTpsCallsAttended();
  const decision = resolveTpsPublish(fetchResult, lastGood, validateTpsCallsSnapshot);
  if (decision.persist) return decision.snapshot;
  if (decision.keepLastGood && lastGood) return lastGood;
  return { sourceUnavailable: true, records: [], semantic: 'annual_aggregate' };
}

if (process.argv[1]?.endsWith('seed-tps-open-data.mjs')) {
  await runSeed('safety', 'tps-mci', TPS_MCI_KEY, fetchMciOnDemand, {
    validateFn: (snapshot) => snapshot?.sourceUnavailable === true || validateTpsMciSnapshot(snapshot),
    ttlSeconds: TPS_TTL_SECONDS,
    sourceVersion: TPS_SOURCE_VERSION,
    declareRecords: declareTpsRecords,
    zeroIsValid: true,
    schemaVersion: 1,
    maxStaleMin: TPS_MAX_STALE_MIN,
  });
  await runSeed('safety', 'tps-calls-attended', TPS_CALLS_KEY, fetchCallsOnDemand, {
    validateFn: (snapshot) => snapshot?.sourceUnavailable === true || validateTpsCallsSnapshot(snapshot),
    ttlSeconds: TPS_TTL_SECONDS,
    sourceVersion: TPS_SOURCE_VERSION,
    declareRecords: declareTpsRecords,
    zeroIsValid: true,
    schemaVersion: 1,
    maxStaleMin: TPS_MAX_STALE_MIN,
  });
}
