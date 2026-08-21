#!/usr/bin/env node
/**
 * GTA Update seeder (#7012).
 *
 * LOCKED DISABLED. Parser + fixtures live in scripts/lib/gta-update.mjs.
 * This file exists so the rights-gate and writer-off contract are visible,
 * but it must not call runSeed, join seed-bundle-canada, register a Railway
 * cron, or serve rows through MCP.
 *
 * Usage (will refuse to publish):
 *   node scripts/seed-gta-update.mjs
 */
import {
  GTA_FIRE_KEY,
  GTA_POLICE_KEY,
  GTA_UPDATE_RIGHTS_BLOCKER,
  GTA_UPDATE_RIGHTS_GATE,
  GTA_UPDATE_WRITER_ENABLED,
  refuseGtaProductionWrite,
} from './lib/gta-update.mjs';

export { GTA_FIRE_KEY, GTA_POLICE_KEY, GTA_UPDATE_WRITER_ENABLED };

if (process.argv[1]?.endsWith('seed-gta-update.mjs')) {
  console.warn(
    `[GTA Update] writer disabled (${GTA_UPDATE_RIGHTS_GATE}). `
    + 'No Redis publish, no Railway cron, no seed-bundle-canada membership. '
    + GTA_UPDATE_RIGHTS_BLOCKER,
  );
  try {
    refuseGtaProductionWrite();
  } catch {
    // Rights-gate refuse is the success path for this locked entry point.
  }
  console.log('=== Done (0ms) ===');
}
