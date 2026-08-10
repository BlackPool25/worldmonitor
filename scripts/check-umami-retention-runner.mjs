#!/usr/bin/env node

/**
 * Runtime health of the Railway `umami-retention` cron service.
 *
 * The capacity monitor next to this file measures the volume, which is a
 * lagging signal: when the retention runner died, the volume took days to
 * drift into the warning band, and the warning is deliberately non-fatal
 * (#6384), so nothing ever failed. #6375 was that gap — the runner exited
 * non-zero on every 15-minute tick for days while every dashboard stayed
 * green, because `scripts/railway-deployments.mjs` counts CRASHED as "the
 * image ran" (true, and the right answer for a source-drift audit) and this
 * cron service had no runtime health check of its own.
 *
 * This check reads deployment records only. It never connects to Postgres,
 * never mutates Railway, and prints no Railway variables.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs as parseNodeArgs } from 'node:util';

import { isMainModule } from './lib/main-module.mjs';
import {
  REJECTED_STATUS,
  isKnownStatus,
  newestRunning,
  orderByRecency,
} from './railway-deployments.mjs';

export const RETENTION_RUNNER_SERVICE = 'umami-retention';

// Deep enough that ordinary push traffic cannot bury the newest tick record.
// Every push to main writes a SKIPPED refusal for this service ("No changes to
// watched files"), and those arrive far faster than the 4 ticks/hour, so a
// shallow window can contain nothing but refusals.
export const RETENTION_HISTORY_WINDOW = 20;

export function normalizeDeploymentRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return null;
  if (Array.isArray(payload.deployments)) return payload.deployments;
  return null;
}

/**
 * Decide whether the retention runner is healthy from its deployment history.
 *
 * Fails closed: anything this cannot read, recognise, or prove is alarming.
 * A silent pass here re-creates the exact failure it exists to catch.
 */
export function evaluateRetentionRunner(payload) {
  const rows = normalizeDeploymentRows(payload);
  if (rows === null) {
    return {
      verdict: 'UNREADABLE',
      alarming: true,
      detail: 'Railway returned no deployment array for the retention runner',
    };
  }
  if (rows.length === 0) {
    return {
      verdict: 'NO_DEPLOYMENTS',
      alarming: true,
      detail: 'Railway returned an empty deployment history for the retention runner',
    };
  }

  const unknown = rows.find((row) => !isKnownStatus(row?.status));
  if (unknown) {
    // A status this repo does not model makes "which record ran" a guess, and
    // newestRunning would silently skip past it to an older, healthier record.
    return {
      verdict: 'UNKNOWN_STATUS',
      alarming: true,
      detail: `Railway reported an unmodelled deployment status ${JSON.stringify(unknown?.status ?? null)}`,
    };
  }

  const ordered = orderByRecency(rows);
  const running = newestRunning(ordered);
  if (!running) {
    const refusals = ordered.filter((row) => row?.status === REJECTED_STATUS).length;
    return {
      verdict: 'NO_RUNNING_DEPLOYMENT',
      alarming: true,
      detail: `none of the newest ${ordered.length} records reached a running state `
        + `(${refusals} were ${REJECTED_STATUS} refusals)`,
    };
  }

  const crashed = running.status === 'CRASHED';
  return {
    verdict: crashed ? 'CRASHED' : 'HEALTHY',
    alarming: crashed,
    deploymentId: running.id ?? null,
    status: running.status,
    createdAt: running.createdAt ?? null,
    detail: crashed
      ? 'the retention tick exited non-zero, so its transaction rolled back and no rows were retired'
      : 'the newest retention deployment that ran did not crash',
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseArguments(argv) {
  const { values } = parseNodeArgs({
    args: argv,
    options: { input: { type: 'string' } },
    allowPositionals: false,
    strict: true,
  });
  return values;
}

function describe(result) {
  const where = result.deploymentId
    ? ` (deployment ${result.deploymentId}, status ${result.status}, created ${result.createdAt})`
    : '';
  return `Umami retention runner ${result.verdict}: ${result.detail}${where}.`;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const inputPath = args.input || process.env.UMAMI_RETENTION_INPUT;
  if (!inputPath) {
    throw new Error('Provide Railway deployment JSON with --input <path> or UMAMI_RETENTION_INPUT');
  }
  if (!existsSync(inputPath)) throw new Error(`Retention deployment input not found: ${inputPath}`);

  const result = evaluateRetentionRunner(readJson(inputPath));
  console.log(describe(result));
  if (result.alarming) {
    console.error(
      `::error::The ${RETENTION_RUNNER_SERVICE} cron service is not retiring rows; `
        + 'Umami Postgres will fill until it is fixed.',
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url, process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(
      `Umami retention runner check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
