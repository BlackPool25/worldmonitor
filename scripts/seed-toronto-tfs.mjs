#!/usr/bin/env node
// Toronto Fire Services live CAD candidate (#6682). Production execution stays
// code-disabled until data-bound redistribution and display rights are recorded.
// Own key — do not append to canadaAlerts / canadaRoads / torontoRoads.

import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';
import {
  TFS_KEY,
  TFS_MAX_STALE_MIN,
  TFS_SOURCE_VERSION,
  TFS_TTL_SECONDS,
  declareTfsRecords,
  fetchTorontoTfs,
  torontoTfsContentMeta,
  validateTfsEnvelope,
} from './lib/toronto-official-cad.mjs';

loadEnvFile(import.meta.url);

export const TFS_RIGHTS_APPROVED = false;

if (!TFS_RIGHTS_APPROVED) {
  console.log('DISABLED: Toronto Fire live CAD data-bound redistribution/display rights are unresolved');
} else {
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
    contentMeta: torontoTfsContentMeta,
    maxContentAgeMin: TFS_MAX_STALE_MIN,
    fetchPhaseTimeoutMs: 45_000,
  }).catch((err) => {
    const cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + cause);
    process.exit(1);
  });
}
