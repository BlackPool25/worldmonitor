// #6806 — `seed-bundle-static-ref`'s budget could not satisfy its own section
// list, and `Military-Bases` was the section that made the starvation
// structural: it reserved 550s of worst case (540s timeout + 10s kill grace)
// against a 570s bundle budget, so with the runner's 15s admission headroom it
// needed 565s of 570s and was admissible only while `elapsed <= 5s`. The five
// freshness reads ahead of it routinely burn more than that.
//
// The reservation was not the seeder's real work. `main()` published via
// `atomicSwitch` and then slept a hardcoded GRACE_PERIOD_MS before deleting the
// superseded version's keys — 300s of the 540s reservation spent idle, after
// the data was already live.
//
// Two properties are pinned here:
//   1. the post-publish wait cannot grow back into a whole-budget reservation;
//   2. a missing `seed-meta:military:bases` self-heals cheaply. That key is the
//      section's ONLY freshness signal (it declares no `canonicalKey`), so when
//      it is absent the runner treats the section as never-seeded and marks it
//      due on every daily tick instead of every 30 days — a permanently-due
//      whole-budget section is what actually starves the bundle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  GRACE_PERIOD_MS,
  atomicSwitch,
  backfillSeedMetaFromActiveVersion,
  parseArgs,
} from '../scripts/seed-military-bases.mjs';

const URL_BASE = 'https://redis.test';
const TOKEN = 'test-token-0000';
const VERSION = '1786244633231';
const RECORDS = 125_380;

/**
 * Stub Upstash REST. `handler(path, body)` returns the parsed JSON body the
 * seeder should see; every call is recorded so a test can assert on call COUNT,
 * which is what separates a cheap repair from a full 251-window revalidation.
 */
function stubRedis(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const path = String(url).slice(URL_BASE.length);
    const body = JSON.parse(options.body);
    calls.push({ path, body });
    return {
      ok: true,
      json: async () => handler(path, body, calls.length),
      text: async () => '',
    };
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

test('the post-publish grace cannot grow back into a whole-budget reservation', () => {
  // The bundle slot must be dominated by real work, not by an idle wait that
  // runs AFTER `atomicSwitch` has already made the data live. At 300_000 this
  // was 55% of the section's 540s reservation and the direct cause of #6806.
  assert.ok(
    GRACE_PERIOD_MS <= 60_000,
    `GRACE_PERIOD_MS is ${GRACE_PERIOD_MS}ms — a post-publish sleep this long is charged to the `
    + 'bundle slot even though the data is already published, which is what made Military-Bases '
    + 'a whole-budget section in #6806.',
  );
  assert.ok(GRACE_PERIOD_MS > 0, 'some grace must remain so in-flight readers are not cut off');
});

test('--force bypasses the repair short-circuit so a manual reseed is still reachable', () => {
  // The repair path returns early when seed-meta is absent, which is right for
  // the cron but wrong for an operator who ran the seeder BECAUSE the marker is
  // missing and wants the data rewritten.
  const argv = process.argv;
  try {
    process.argv = ['node', 'seed-military-bases.mjs'];
    assert.equal(parseArgs().force, false, 'reseed must not be forced by default');

    process.argv = ['node', 'seed-military-bases.mjs', '--force'];
    assert.equal(parseArgs().force, true);

    process.argv = ['node', 'seed-military-bases.mjs', '--env', 'preview', '--force'];
    const parsed = parseArgs();
    assert.equal(parsed.force, true, '--force must survive alongside other flags');
    assert.equal(parsed.env, 'preview');

    // `--env=`/`--sha=` accept the `=` form, so an operator who reaches for
    // `--force=1` out of habit must not silently get the repair path instead.
    for (const arg of ['--force=true', '--force=1', '--force=yes']) {
      process.argv = ['node', 'seed-military-bases.mjs', arg];
      assert.equal(parseArgs().force, true, `${arg} must force a reseed`);
    }
    for (const arg of ['--force=false', '--force=0', '--force=no']) {
      process.argv = ['node', 'seed-military-bases.mjs', arg];
      assert.equal(parseArgs().force, false, `${arg} must not force a reseed`);
    }
  } finally {
    process.argv = argv;
  }
});

test('atomicSwitch records the seeding duration so the next tick can be sized from a measurement', async () => {
  const stub = stubRedis(() => ({ result: VERSION }));
  try {
    await atomicSwitch(URL_BASE, TOKEN, '', VERSION, RECORDS, Number(VERSION), 214_000);
  } finally {
    stub.restore();
  }

  const evalCall = stub.calls.find((c) => c.body[0] === 'EVAL');
  assert.ok(evalCall, 'atomicSwitch must publish through the EVAL script');
  const payload = JSON.parse(evalCall.body.at(-1));
  assert.equal(payload.recordCount, RECORDS);
  assert.equal(
    payload.durationMs,
    214_000,
    'seed-meta must carry the measured seeding duration — Railway cron logs are not readable '
    + 'after the fact, so the published record is the only way to right-size this section\'s timeout',
  );
});

test('a missing seed-meta is repaired without a full revalidation of every record', async () => {
  // The repair path exists because the section is permanently due while
  // seed-meta is absent. If repairing costs a 251-window scan it cannot run
  // inside the shrunken slot, and the permanently-due loop survives its own fix.
  const stub = stubRedis((path, body) => {
    if (path === '/pipeline') {
      return body.map(([cmd]) => {
        if (cmd === 'GET') return { result: VERSION };
        if (cmd === 'ZCARD' || cmd === 'HLEN') return { result: RECORDS };
        if (cmd === 'ZRANGE') return { result: [] };
        return { result: null };
      });
    }
    return { result: [1, VERSION] };
  });

  let repaired;
  try {
    repaired = await backfillSeedMetaFromActiveVersion(URL_BASE, TOKEN, '', { deep: false });
  } finally {
    stub.restore();
  }

  assert.equal(repaired.version, VERSION);
  assert.equal(repaired.recordCount, RECORDS);

  const zrangeCalls = stub.calls.filter(
    (c) => c.path === '/pipeline' && c.body.some(([cmd]) => cmd === 'ZRANGE'),
  );
  assert.equal(
    zrangeCalls.length,
    0,
    'a shallow repair must confirm ZCARD/HLEN agreement only — walking all '
    + `${RECORDS} members costs ~250 round trips and would not fit the section's slot`,
  );
  assert.ok(
    stub.calls.length <= 4,
    `shallow repair issued ${stub.calls.length} Redis calls; it must stay a handful`,
  );
});
