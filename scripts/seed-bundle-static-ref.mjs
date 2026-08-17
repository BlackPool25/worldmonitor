#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

await runBundle('static-ref', [
  // Keep the two upstreams as separate processes. A World Bank failure cannot
  // prevent a healthy SIPRI publication, and the daily tick lets the wall-time
  // budget defer lower-priority members without missing their real cadence.
  { label: 'Arms-Suppliers', script: 'seed-defense-industrial-suppliers.mjs', seedMetaKey: 'military:arms-suppliers-complete', canonicalKey: 'military:arms-suppliers:complete:v1', intervalMs: 10 * DAY, timeoutMs: 450_000 },
  { label: 'Defense-Industrial', script: 'seed-defense-industrial.mjs', seedMetaKey: 'military:defense-industrial', canonicalKey: 'military:industrial-base:v1', intervalMs: 10 * DAY, timeoutMs: 100_000 },
  // 90s, not 300s. The runner admits on the DECLARED worst case
  // (timeoutMs + KILL_GRACE_MS) because it decides before running, so a timeout
  // is a reservation rather than a ceiling drawn down on use — and 300s asked
  // for a 310s slot to do work that measures ~22s. With 293s left after
  // Arms-Suppliers it was refused by 17 seconds on every tick, which is why
  // infrastructure:submarine-cables:v1 has never existed (#6799).
  //
  // Measured 2026-08-17 against submarinecablemap.com: the seeder fetches the
  // CURATED list (CABLE_REGIONS, 86 cables) rather than the 702 in all.json —
  // 18 batches of 5 at ~0.97s, plus ~5s for cable-geo.json (739KB) and
  // landing-point-geo.json (360KB). 90s is ~4x that, which keeps room for a
  // slower link from Railway while reserving 100s instead of 310s.
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', canonicalKey: 'infrastructure:submarine-cables:v1', intervalMs: WEEK, timeoutMs: 90_000 },
  { label: 'Defense-Patents', script: 'seed-defense-patents.mjs', seedMetaKey: 'military:defense-patents', canonicalKey: 'patents:defense:latest', intervalMs: WEEK, timeoutMs: 180_000, requiredEnv: ['USPTO_API_KEY'] },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', canonicalKey: 'energy:chokepoint-baselines:v1', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  // 300s, not 540s (#6806).
  //
  // The runtime admission test is `elapsedBundle + worstCase <= maxBundleMs`
  // (_bundle-runner.mjs:543) — note it does NOT include ADMISSION_HEADROOM_MS,
  // which guards only the static never-admittable check at line 218. So the
  // bound this section has to clear is on ELAPSED time:
  //   540s timeout -> 550s worst case -> admissible only while elapsed <=  20s
  //   400s timeout -> 410s worst case -> admissible        while elapsed <= 160s
  // At 20s admission was knife-edge: the bundle heartbeat write plus the
  // freshness reads for the five sections ahead of this one (each bounded by
  // REDIS_READ_TIMEOUT_MS) can exceed it on a slow tick, so the section was
  // deferred for reasons that had nothing to do with the work it does.
  //
  // Most of the old reservation was not work. `seed-military-bases.mjs`
  // published via `atomicSwitch` and THEN slept GRACE_PERIOD_MS before deleting
  // the superseded version's keys — 300s of the 540s spent idle with the new
  // data already live. That grace is now 30s, so the 540s reservation implied a
  // real work budget of ~240s of seeding and validation.
  //
  // 400s, not 300s, because the slot has to cover more than that write loop:
  //   ~240s  seed + validate (~1000 Upstash round trips at 125k records)
  //   <=60s  R2 download when neither the volume nor the local file is present
  //     ~5s  JSON.parse of the ~125k-entry file
  //     30s  post-publish grace before the superseded keys are deleted
  // which is ~335s on an R2-cold tick. Sizing to 300s would put SIGTERM before
  // `atomicSwitch` on exactly that tick, and a run killed pre-publish leaks its
  // half-written `military:bases:{geo,meta}:<version>` keys permanently —
  // `cleanupOldVersion` only ever targets the version that is currently ACTIVE,
  // so a version that never published is swept by nothing.
  //
  // What this does NOT do: the bundle stays oversubscribed (worst cases sum to
  // ~1530s against 570s). On a tick where Arms-Suppliers runs, elapsed already
  // exceeds 160s and this section still defers. The gain is (a) admission no
  // longer turns on a 20s race it cannot influence, and (b) because
  // `elapsedBundle` accrues ACTUAL runtime, a ~240s seed plus the 30s grace
  // occupies ~270s and leaves ~300s for Mineral-Production (190s worst case) —
  // the only section after this one in array order, and the one #6799 found
  // with no key in Redis at all.
  //
  // Re-sizing input: the seeder publishes `durationMs` into
  // `seed-meta:military:bases`, measured from the start of the run but NOT
  // including the 30s grace — compare against `durationMs + GRACE_PERIOD_MS`.
  // The repair path does not publish one, so the first real number arrives on
  // the next full reseed, not on the next tick.
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 400_000 },
  { label: 'Mineral-Production', script: 'seed-mineral-production.mjs', seedMetaKey: 'supply-chain:mineral-production', canonicalKey: 'supply-chain:mineral-production:v1', intervalMs: 60 * DAY, timeoutMs: 180_000 },
], { maxBundleMs: 570_000 });
