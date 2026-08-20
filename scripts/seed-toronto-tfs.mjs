#!/usr/bin/env node
// Official Toronto Fire Services live CAD (#6682). Member of seed-bundle-canada,
// gated on intervalMs 5min to match the CAD refresh. Own key — do not append
// to canadaAlerts / canadaRoads / torontoRoads. Last-good is this seeder's
// runSeed path; a TPS failure cannot wipe it.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  TFS_KEY,
  TFS_MAX_STALE_MIN,
  TFS_SOURCE_VERSION,
  TFS_TTL_SECONDS,
  declareTfsRecords,
  fetchTorontoTfs,
  validateTfsEnvelope,
} from './lib/toronto-official-cad.mjs';

loadEnvFile(import.meta.url);

runSeed('safety', 'toronto-tfs', TFS_KEY, () => (
  fetchTorontoTfs({ userAgent: CHROME_UA })
), {
  validateFn: validateTfsEnvelope,
  ttlSeconds: TFS_TTL_SECONDS,
  sourceVersion: TFS_SOURCE_VERSION,
  declareRecords: declareTfsRecords,
  zeroIsValid: true,
  schemaVersion: 1,
  maxStaleMin: TFS_MAX_STALE_MIN,
}).catch((err) => {
  const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
  console.error('FATAL:', (err.message || err) + cause);
  process.exit(1);
});
