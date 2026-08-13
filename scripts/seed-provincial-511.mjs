#!/usr/bin/env node
// - Service name: seed-provincial-511
// Standalone nixpacks seeder for Ontario 511 events, alerts, and road conditions.
// Do not add Canada loops to ais-relay.cjs. AB/MB share the vendor adapter later.
// Each Ontario fetch goes through acquire511Slot('511on.ca') inside the adapter.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  fetchVendor511,
  ONTARIO_511,
} from './lib/provincial-511.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'infra:ontario-511:v1';
const CACHE_TTL = 5400; // 90 min ≥ 3× the */15 cron (900s)
const MAX_RECORDS = 400;
const STAGGER_MS = 7000;

function rankRecord(record) {
  if (record.isFullClosure) return 0;
  if (record.severity === 'Extreme') return 1;
  if (record.severity === 'Severe') return 2;
  if (record.severity === 'Moderate') return 3;
  if (record.centroid) return 4;
  return 5;
}

function selectRecords(records) {
  if (records.length <= MAX_RECORDS) return records;
  return [...records]
    .sort((a, b) => rankRecord(a) - rankRecord(b) || String(a.id).localeCompare(String(b.id)))
    .slice(0, MAX_RECORDS);
}

async function fetchOntario511() {
  const envelope = await fetchVendor511(ONTARIO_511, {
    userAgent: CHROME_UA,
    staggerMs: STAGGER_MS,
  });
  const combined = [...envelope.events, ...envelope.alerts, ...envelope.conditions];
  const records = selectRecords(combined);
  if (envelope.failedResources.length) {
    console.warn(
      `  Ontario 511: ${envelope.failedResources.join(', ')} failed; `
      + `publishing ${records.length} surviving record(s)`,
    );
  }
  // Publish the capped map payload only (NWS weather pattern). Kind is on
  // each record; do not also persist the uncapped event/alert/condition arrays.
  return { records };
}

export function declareRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

function validateOntario511(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.records);
}

runSeed('infra', 'ontario-511', CANONICAL_KEY, fetchOntario511, {
  validateFn: validateOntario511,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'ontario-511-v1',
  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
