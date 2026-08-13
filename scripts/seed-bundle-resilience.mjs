#!/usr/bin/env node
import { runBundle, HOUR, DAY } from './_bundle-runner.mjs';

// intervalMs note: the bundle runner skips sections whose seed-meta is newer
// than `intervalMs * 0.8`. The Resilience-Scores section must run more often
// than the ranking/score TTL (12h / 6h) so refreshRankingAggregate() can keep
// the ranking alive between Railway cron fires. A 2h interval → 96min skip
// window, so hourly Railway fires run this ~every 2h. The seeder is cheap on
// warm runs (~5-10s: intervals recompute + one /refresh=1 HTTP + 2 verify
// GETs); the expensive warm path only runs when scores are actually missing.
await runBundle('resilience', [
  { label: 'Resilience-Scores', script: 'seed-resilience-scores.mjs', seedMetaKey: 'resilience:scores', intervalMs: 2 * HOUR, timeoutMs: 600_000 },
  { label: 'Resilience-Static', script: 'seed-resilience-static.mjs', seedMetaKey: 'resilience:static', intervalMs: 90 * DAY, timeoutMs: 900_000 },
  { label: 'Food-Stocks', script: 'seed-food-stocks.mjs', seedMetaKey: 'resilience:food-stocks', intervalMs: 30 * DAY, timeoutMs: 600_000 },
], {
  // Railway kills the container at 10 minutes. The runner admits a section only
  // when `timeoutMs + KILL_GRACE_MS` still fits the remaining budget, so without
  // this a 600s section plus grace could start with no room to finish and be
  // SIGKILLed mid-publish instead of skipped cleanly.
  maxBundleMs: 570_000,
});
