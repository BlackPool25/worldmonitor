// Contract for the Canada ingest bundle.
//
// The bundle exists so six Canadian seeders consume ONE Railway slot instead of
// six. These tests pin the two things that silently rot: the per-member cadence
// (the reason the bundle is cheaper than six crons) and the seed-meta keys (the
// gate the runner uses to decide whether a member is due).
//
// The bundle script cannot be imported — it calls runBundle at module scope — so
// this reads it through the same static parser the repo-wide bundle gates use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractBundleSections, resolveExpr } from './helpers/bundle-section-parser.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'scripts/seed-bundle-canada.mjs'), 'utf8');
const sections = extractBundleSections(src);

const MIN = 60_000;
const HOUR = 3_600_000;

function section(label) {
  const found = sections.find((s) => s.label === label);
  assert.ok(found, `bundle must declare a ${label} section`);
  return found;
}

test('declares exactly the six Canada members', () => {
  assert.deepEqual(
    sections.map((s) => s.label).sort(),
    [
      'Alberta-Emergency-Alert',
      'BC-Open511',
      'Provincial-511',
      'TTC-Alerts',
      'Toronto-Roads',
      'VIA-Rail-Live',
    ],
    'a member added to the bundle without a decision here is a slot nobody agreed to',
  );
});

test('per-member cadence is the declared one, not TTC\'s cron inherited', () => {
  // The service cron is */5 because TTC needs it. Every other member is gated by
  // its own intervalMs — that is the whole reason one service can replace six.
  // Toronto at */15 cost 348 MB/day for a construction-permit feed; 2h is ~44.
  const expected = [
    ['Provincial-511', 15 * MIN],
    ['Toronto-Roads', 2 * HOUR],
    ['BC-Open511', 30 * MIN],
    ['Alberta-Emergency-Alert', 15 * MIN],
    ['VIA-Rail-Live', 15 * MIN],
    ['TTC-Alerts', 5 * MIN],
  ];
  for (const [label, intervalMs] of expected) {
    assert.equal(
      resolveExpr(src, section(label).intervalMsExpr),
      intervalMs,
      `${label} cadence changed — confirm the bandwidth math before accepting it`,
    );
  }
});

test('seed-meta keys follow runSeed(domain, resource), not the canonical key', () => {
  // runSeed derives `seed-meta:${domain}:${resource}`. It is NOT the canonical
  // key with :v1 stripped, and the two diverge wherever a resource contains a
  // hyphen where the canonical key has a colon. Getting this wrong points the
  // runner's due-check at a key the seeder never writes, so the member either
  // runs every tick or never runs — silently, either way.
  const expected = {
    'Provincial-511': ['seed-meta:infra:ontario-511', 'infra:ontario-511:v1'],
    'Toronto-Roads': ['seed-meta:infra:toronto-roads', 'infra:toronto-roads:v1'],
    'BC-Open511': ['seed-meta:infra:bc-open511', 'infra:bc-open511:v1'],
    'Alberta-Emergency-Alert': ['seed-meta:alerts:alberta-aea', 'alerts:alberta-aea:v1'],
    'VIA-Rail-Live': ['seed-meta:transit:viarail-live', 'transit:viarail:live'],
    // The canonical key is transit:ttc:alerts:v1 but the resource is
    // 'ttc-alerts', so the meta key takes a HYPHEN. api/health.js watched
    // seed-meta:transit:ttc:alerts and would never have seen a publish.
    'TTC-Alerts': ['seed-meta:transit:ttc-alerts', 'transit:ttc:alerts:v1'],
  };
  // The shared parser does not expose these fields, so read them off the section
  // literal — anchored on the label so a key can never be matched against the
  // wrong member.
  for (const [label, [seedMetaKey, canonicalKey]] of Object.entries(expected)) {
    const line = src.split('\n').find((l) => l.includes(`label: '${label}'`));
    assert.ok(line, `${label} section literal must be on one line`);
    assert.match(line, new RegExp(`seedMetaKey: '${seedMetaKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${label} seedMetaKey`);
    assert.match(line, new RegExp(`canonicalKey: '${canonicalKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`), `${label} canonicalKey`);
  }
});

test('every member declares a timeout, and none can exceed the wall budget', () => {
  // A section whose timeout cannot fit is deferred on EVERY tick and never runs.
  // runBundle throws on an unadmittable section, so this catches it in CI first.
  const maxBundleMs = 570_000;
  for (const s of sections) {
    const timeoutMs = resolveExpr(src, s.timeoutMsExpr);
    assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, `${s.label} must declare a timeoutMs`);
    assert.ok(timeoutMs < maxBundleMs, `${s.label} timeout ${timeoutMs} cannot fit the ${maxBundleMs}ms budget`);
  }
});

test('skips a member whose script is absent instead of failing the whole bundle', () => {
  // The bundle is registered before its members merge, so on an intermediate
  // tree some scripts do not exist. Reaching spawn() with a missing file settles
  // as a HARD failure and reds the service for a member that simply was not
  // deployed yet. The filter must be on existsSync, and it must log.
  assert.match(src, /existsSync\(join\(here, section\.script\)\)/);
  assert.match(src, /SKIPPING \$\{section\.label\}/);
});

test('is registered as planned, so it never enters the live audit unprovisioned', () => {
  const registry = JSON.parse(readFileSync(join(root, 'scripts/railway-services.json'), 'utf8'));
  const entry = registry.find((row) => row.service === 'seed-bundle-canada');
  assert.ok(entry, 'seed-bundle-canada must be in the Railway registry');
  assert.equal(entry.lifecycle, 'planned');
  // A planned row carries no watchPatterns and no cron by convention — both are
  // added in the deliberate activation change, once the service actually exists.
  assert.equal(Object.hasOwn(entry, 'watchPatterns'), false);
  assert.equal(Object.hasOwn(entry, 'cronSchedule'), false);
});
