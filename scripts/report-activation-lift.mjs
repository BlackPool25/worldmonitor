#!/usr/bin/env node
/**
 * Reports whether subscribers who engaged with the Pro Activation wizard
 * (#5534/#5564) went on to create/verify more delivery-channel, alert-rule,
 * API-key, or MCP-token rows than subscribers who only saw it and confirmed
 * nothing. Not a randomized control -- both groups were equally shown the
 * wizard, so this isolates an engagement effect, not the effect of the
 * wizard existing at all. See issue #5582 for the full design rationale and
 * the read-me-first caveats: no cohort join existed before this, and the
 * historical record has a permanent gap from the #5565 Umami outage.
 *
 * Usage:
 *   1. Source prod env: `set -a; source <main-repo>/.env.local; set +a`
 *      Required: CONVEX_DEPLOY_KEY, CONVEX_DEPLOYMENT.
 *   2. `node scripts/report-activation-lift.mjs [--window-days=14] [--limit=20000]`
 *
 * Read-only: uses `npx convex data <table>`, never `convex run` with a
 * mutation. Safe to run anytime, as often as wanted.
 */

import { spawnSync } from "node:child_process";

const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY;
const CONVEX_DEPLOYMENT = process.env.CONVEX_DEPLOYMENT;
if (!CONVEX_DEPLOY_KEY || !CONVEX_DEPLOYMENT) {
  console.error(
    "[activation-lift] CONVEX_DEPLOY_KEY and CONVEX_DEPLOYMENT env vars required. " +
      "Source them from .env.local first (see file header for the exact command) -- " +
      "plain `source` can silently yield an empty CONVEX_DEPLOY_KEY; verify with " +
      "`node -e \"console.log(!!process.env.CONVEX_DEPLOY_KEY)\"` before running this.",
  );
  process.exit(2);
}

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const WINDOW_DAYS = Number(args.get("window-days") ?? 14);
const LIMIT = Number(args.get("limit") ?? 20000);
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

const FEATURE_TABLES = ["notificationChannels", "alertRules", "userApiKeys", "mcpProTokens"];
const MIN_GROUP_SIZE_FOR_A_CLAIM = 30;

function fetchTable(table) {
  const result = spawnSync(
    "npx",
    ["convex", "data", table, "--limit", String(LIMIT), "--order", "desc", "--format", "jsonl"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 256 },
  );
  if (result.status !== 0) {
    throw new Error(`npx convex data ${table} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function main() {
  console.log(`[activation-lift] window=${WINDOW_DAYS}d limit=${LIMIT} per table\n`);

  const presentations = fetchTable("proActivationPresentations");
  const featureRowsByTable = Object.fromEntries(FEATURE_TABLES.map((t) => [t, fetchTable(t)]));

  const shown = presentations.filter((p) => p.presentedAt !== undefined);
  const withOutcome = shown.filter((p) => p.exitedAt !== undefined);
  const engaged = withOutcome.filter((p) => (p.confirmedSteps?.length ?? 0) > 0);
  const presentedOnly = withOutcome.filter((p) => (p.confirmedSteps?.length ?? 0) === 0);

  console.log(`Presentations: ${presentations.length} total, ${shown.length} actually shown, ${withOutcome.length} with a recorded exit outcome.`);
  console.log(`  engaged (confirmed >=1 step): ${engaged.length}`);
  console.log(`  presented-only (confirmed 0 steps): ${presentedOnly.length}\n`);

  if (withOutcome.length === 0) {
    console.log("No outcome-recorded presentations yet -- nothing to compare. This is expected until subscribers start exiting the wizard after this instrumentation ships.");
    return;
  }

  function featureCreatedAfter(userId, sinceMs) {
    const hits = {};
    let any = false;
    for (const table of FEATURE_TABLES) {
      const rows = featureRowsByTable[table].filter(
        (r) => r.userId === userId && r._creationTime > sinceMs && r._creationTime <= sinceMs + WINDOW_MS,
      );
      hits[table] = rows.length;
      if (rows.length > 0) any = true;
    }
    return { any, hits };
  }

  function summarizeGroup(name, rows) {
    let anyCount = 0;
    const perTable = Object.fromEntries(FEATURE_TABLES.map((t) => [t, 0]));
    for (const row of rows) {
      const { any, hits } = featureCreatedAfter(row.userId, row.exitedAt);
      if (any) anyCount += 1;
      for (const t of FEATURE_TABLES) perTable[t] += hits[t];
    }
    const rate = rows.length > 0 ? anyCount / rows.length : 0;
    console.log(`${name}: n=${rows.length}, created >=1 feature within ${WINDOW_DAYS}d: ${anyCount} (${(rate * 100).toFixed(1)}%)`);
    for (const t of FEATURE_TABLES) console.log(`    ${t}: ${perTable[t]} rows created`);
    if (rows.length < MIN_GROUP_SIZE_FOR_A_CLAIM) {
      console.log(`    ⚠ n=${rows.length} is below the ${MIN_GROUP_SIZE_FOR_A_CLAIM}-sample floor this script enforces before treating a rate as meaningful -- do not draw a conclusion from this group alone yet.`);
    }
    return { n: rows.length, anyCount, rate };
  }

  console.log("--- Adoption within the window, by engagement ---");
  const engagedSummary = summarizeGroup("Engaged", engaged);
  const presentedOnlySummary = summarizeGroup("Presented-only", presentedOnly);

  console.log("\n--- Verdict ---");
  if (engagedSummary.n < MIN_GROUP_SIZE_FOR_A_CLAIM || presentedOnlySummary.n < MIN_GROUP_SIZE_FOR_A_CLAIM) {
    console.log("Not enough post-exit outcomes recorded yet in one or both groups to say anything. Re-run this report after more subscribers have gone through the wizard.");
  } else {
    const lift = engagedSummary.rate - presentedOnlySummary.rate;
    console.log(`Engaged-group adoption rate is ${(lift * 100).toFixed(1)} percentage points ${lift >= 0 ? "higher" : "lower"} than presented-only.`);
    console.log("This is an engagement comparison within one exposed population, not a randomized control -- selection effects (subscribers already inclined to explore config may also be the ones who confirm steps) are not ruled out.");
  }
}

main();
