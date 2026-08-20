#!/usr/bin/env node
// Official Toronto Police Service Calls for Service public map (#6682).
// Member of seed-bundle-canada, gated on intervalMs 15min (layer refresh
// 15–20 min). Own key — do not append to canadaAlerts / canadaRoads /
// torontoRoads. Privacy exclusions stay empty; do not fill from radio/news.
// Last-good is this seeder's runSeed path; a TFS failure cannot wipe it.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  TPS_KEY,
  TPS_MAX_STALE_MIN,
  TPS_SOURCE_VERSION,
  TPS_TTL_SECONDS,
  declareTpsRecords,
  fetchTorontoTps,
  validateTpsEnvelope,
} from './lib/toronto-official-cad.mjs';

loadEnvFile(import.meta.url);

runSeed('safety', 'toronto-tps', TPS_KEY, () => (
  fetchTorontoTps({ userAgent: CHROME_UA })
), {
  validateFn: validateTpsEnvelope,
  ttlSeconds: TPS_TTL_SECONDS,
  sourceVersion: TPS_SOURCE_VERSION,
  declareRecords: declareTpsRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: TPS_MAX_STALE_MIN,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
