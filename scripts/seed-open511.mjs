#!/usr/bin/env node
// - Service name: seed-open511
// Standalone nixpacks seeder for BC Open511 active road events.
// Do not add Canada loops to ais-relay.cjs. This is Open511 pagination, not
// the vendor 511 client. Each page goes through
// acquire511Slot('api.open511.gov.bc.ca') inside the adapter.

import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import {
  BC_OPEN511,
  open511Adapter,
} from './lib/open511.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'infra:bc-open511:v1';
const CACHE_TTL = 5400; // 90 min ≥ 3× the */15 cron (900s)
const MAX_RECORDS = 400;

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

async function fetchBcOpen511() {
  const adapter = open511Adapter(BC_OPEN511.baseUrl, {
    userAgent: CHROME_UA,
    jurisdiction: BC_OPEN511.jurisdiction,
    source: BC_OPEN511.source,
  });
  const envelope = await adapter.fetchEvents({ status: 'ACTIVE', limit: 500 });
  return { records: selectRecords(envelope.records) };
}

export function declareRecords(data) {
  return Array.isArray(data?.records) ? data.records.length : 0;
}

function validateOpen511(data) {
  return data != null && typeof data === 'object' && Array.isArray(data.records);
}

runSeed('infra', 'bc-open511', CANONICAL_KEY, fetchBcOpen511, {
  validateFn: validateOpen511,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'bc-open511-v1',
  declareRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: 45,
}).catch((err) => {
  const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + _cause);
  process.exit(1);
});
