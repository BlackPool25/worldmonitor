/**
 * The /api/health `summary.total` doc gate (#6300).
 *
 * Four published example bodies (two English pages, two zh mirrors) quoted
 * `"total": 194` while production reported 256. Nothing pinned the figure, so
 * it was copied forward until three agreeing sources read as corroboration.
 *
 * `parseHealthProbedKeys` derives the number from api/health.js source text —
 * the docs-stats CI job runs on bare Node with no `npm install`, and the
 * runtime size depends on process.env.IRAN_EVENTS_ENABLED, so it must not be
 * imported. That makes the parser itself the thing that can silently drift, so
 * these tests do two jobs:
 *
 *   1. Pin the text parse against the REAL module's runtime registry. A text
 *      parser that agrees with itself proves nothing; one that agrees with the
 *      object health.js actually walks proves the published number.
 *   2. Drive every failure branch with synthetic fixtures, so "the gate would
 *      have caught it" is executed rather than asserted.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parseHealthProbedKeys } from '../scripts/docs-stats.mjs';
import { __testing__ as healthTesting } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

const REAL_SOURCE = read('api/health.js');

const DOC_PAGES = [
  'docs/health-endpoints.mdx',
  'docs/api-platform.mdx',
  'docs/zh/health-endpoints.mdx',
  'docs/zh/api-platform.mdx',
];

/**
 * Mutate the real api/health.js text. Throws when the anchor it targets is
 * gone: a fixture that silently stops mutating anything turns every "this
 * drift is caught" assertion below into a test of nothing.
 */
function mutate(from: string | RegExp, to: string): string {
  const occurrences = typeof from === 'string'
    ? REAL_SOURCE.split(from).length - 1
    : [...REAL_SOURCE.matchAll(new RegExp(from, 'g'))].length;
  assert.equal(occurrences, 1, `fixture drift: api/health.js must contain exactly one \`${from}\``);
  return REAL_SOURCE.replace(from, to);
}

describe('/api/health probed-key count doc gate (#6300)', () => {
  it('derives the same total the runtime registry actually walks', () => {
    // api/health.js counts one check per BOOTSTRAP_KEYS + STANDALONE_KEYS entry
    // (the `sources` loop that increments totalChecks). Importing it here is
    // safe — only the always-on docs-stats CI job runs without node_modules.
    const runtimeBootstrap = Object.keys(healthTesting.BOOTSTRAP_KEYS).length;
    const runtimeStandalone = Object.keys(healthTesting.STANDALONE_KEYS).length;

    const parsed = parseHealthProbedKeys(REAL_SOURCE);

    assert.equal(parsed.bootstrap, runtimeBootstrap);
    assert.equal(parsed.standalone, runtimeStandalone);
    assert.equal(parsed.total, runtimeBootstrap + runtimeStandalone);
  });

  it('publishes that total, and an internally consistent body, on every doc page', () => {
    const { total } = parseHealthProbedKeys(REAL_SOURCE);

    for (const page of DOC_PAGES) {
      const text = read(page);
      const blocks = [...text.matchAll(/"summary":\s*\{/g)];
      // The registered claims are anchored on this one block per page. A second
      // one would let a stale duplicate hide behind the live copy — the #5791
      // failure mode the bootstrap-cache gate was hardened against.
      assert.equal(blocks.length, 1, `${page}: expected exactly one "summary" example block`);

      const summary = /"summary":\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
      const field = (name: string) => Number(new RegExp(`"${name}":\\s*(\\d+)`).exec(summary)?.[1]);

      assert.equal(field('total'), total, `${page}: summary.total is stale`);
      // Every example declares an all-OK fleet, so ok must equal total and the
      // problem counters must be zero. An example that contradicts its own
      // declared status teaches the wrong contract.
      assert.equal(field('ok'), total, `${page}: summary.ok must equal total in an all-OK example`);
      for (const zero of ['warn', 'onDemandWarn', 'staleContent', 'rolloutPending', 'crit']) {
        assert.equal(field(zero), 0, `${page}: summary.${zero} must be 0 in an all-OK example`);
      }
    }
  });

  it('no longer hardcodes a drifting count in prose', () => {
    // The prose figure is the half that cannot be pinned to a stat, so it must
    // state the property instead. These pages carried "currently ~194" and
    // "~194 keys with record counts" for long enough to go 62 keys stale.
    assert.doesNotMatch(read('docs/health-endpoints.mdx'), /~\s*\d+\s*(?:and growing|keys with record counts)/);
    assert.doesNotMatch(read('docs/zh/health-endpoints.mdx'), /约\s*\d+\s*个(?:，并随面板|键及记录计数)/);
  });

  it('counts a newly registered key', () => {
    const before = parseHealthProbedKeys(REAL_SOURCE).total;
    const source = mutate(
      "const STANDALONE_KEYS = {\n",
      "const STANDALONE_KEYS = {\n  brandNewPanel:      'brand:new-panel:v1',\n",
    );
    assert.equal(parseHealthProbedKeys(source).total, before + 1);
  });

  it('counts every consumer-price market the loop registers', () => {
    const before = parseHealthProbedKeys(REAL_SOURCE).total;
    const source = mutate(
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us'",
      "'ae', 'au', 'br', 'gb', 'in', 'sa', 'sg', 'us', 'zz'",
    );
    // The loop skips 'ae', so a ninth market is one more probed key.
    assert.equal(parseHealthProbedKeys(source).total, before + 1);
  });

  it('subtracts the iran-events sunset exactly once', () => {
    // The delete is why bootstrap is one smaller than its literal. Re-enabling
    // the key by removing the delete must give the count back, not leave the
    // subtraction stranded against a literal that still declares it.
    const source = mutate('  delete BOOTSTRAP_KEYS.iranEvents;\n', '');
    assert.throws(
      () => parseHealthProbedKeys(source),
      /no longer contains the accounted-for mutation/,
      'dropping an accounted-for mutation must fail loudly, not silently keep subtracting',
    );
  });

  it('refuses to publish a total when health.js mutates its registries in an unaccounted way', () => {
    // The whole point: a third mutation must not silently shift the published
    // number. Hardcoded arithmetic would have kept reporting the old total.
    const source = mutate(
      '  delete BOOTSTRAP_KEYS.iranEvents;\n',
      "  delete BOOTSTRAP_KEYS.iranEvents;\n  STANDALONE_KEYS.someNewThing = 'some:new:thing:v1';\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), (err: Error) => {
      assert.match(err.message, /does not\s+account for/);
      assert.match(err.message, /someNewThing/);
      return true;
    });
  });

  it('does not mistake a registry READ for a mutation', () => {
    // `STANDALONE_KEYS[sibling] ?? BOOTSTRAP_KEYS[sibling]` in the cascade
    // lookup is a read. A mutation matcher that catches it would fail the gate
    // permanently, so the accounted-set check would get loosened to nothing.
    assert.match(REAL_SOURCE, /STANDALONE_KEYS\[sibling\] \?\? BOOTSTRAP_KEYS\[sibling\]/);
    assert.doesNotThrow(() => parseHealthProbedKeys(REAL_SOURCE));
  });

  it('fails when the iran-events default flips, changing the documented registry', () => {
    const source = mutate("(process.env.IRAN_EVENTS_ENABLED ?? 'false')", "(process.env.IRAN_EVENTS_ENABLED ?? 'true')");
    assert.throws(() => parseHealthProbedKeys(source), /no longer defaults to false/);
  });

  it("fails when the consumer-price loop stops skipping 'ae'", () => {
    const source = mutate("  if (market === 'ae') continue;\n", '');
    assert.throws(() => parseHealthProbedKeys(source), /no longer skips 'ae'/);
  });

  it('fails when a registry it counts disappears', () => {
    const source = mutate('const STANDALONE_KEYS = {', 'const STANDALONE_KEYS_RENAMED = {');
    assert.throws(() => parseHealthProbedKeys(source), /could not parse STANDALONE_KEYS/);
  });

  it('fails on a duplicate registry key rather than under-counting it', () => {
    const source = mutate(
      "const STANDALONE_KEYS = {\n",
      "const STANDALONE_KEYS = {\n  hkoWarnings:      'weather:hko-warnings:v1',\n",
    );
    assert.throws(() => parseHealthProbedKeys(source), /declares "hkoWarnings" twice/);
  });
});
