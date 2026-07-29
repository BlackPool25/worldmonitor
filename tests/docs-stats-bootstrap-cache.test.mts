/**
 * The /api/bootstrap cache-header contract gate (#5794).
 *
 * `api/bootstrap-auth.test.mjs` already pins what the handler emits per auth
 * kind. What nothing pinned was the four doc surfaces that PUBLISH those
 * values, so during #5386/#5791 all four went wrong at once — in two different
 * ways — with every test green. These tests drive the gate's failure branches
 * with synthetic fixtures, so "the gate would have caught it" is executed
 * rather than asserted.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseBootstrapCacheContract,
  parseBootstrapKeyTiers,
  validateBootstrapCacheDocs,
  BOOTSTRAP_CACHE_DOC_FILES,
} from '../scripts/docs-stats.mjs';

const ROOT = new URL('../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const REAL_CACHE = parseBootstrapCacheContract();
const REAL_TIERS = parseBootstrapKeyTiers();
const REAL_STATS = { bootstrapCache: REAL_CACHE };
const REAL_DOCS: Record<string, string> = Object.fromEntries(
  BOOTSTRAP_CACHE_DOC_FILES.map((f: string) => [f, read(f)]),
);

const EN_PAGE = 'docs/api-platform.mdx';
const ZH_PAGE = 'docs/zh/api-platform.mdx';

/**
 * Mutate one published claim in a real doc page. Throws when the prose it
 * targets is gone: a fixture that silently stops mutating anything turns every
 * "this drift is caught" assertion below into a test of nothing.
 */
function mutate(file: string, from: string, to: string): Record<string, string> {
  const text = REAL_DOCS[file];
  const occurrences = text.split(from).length - 1;
  assert.equal(occurrences, 1, `fixture drift: ${file} must contain exactly one \`${from}\``);
  return { [file]: text.replace(from, to) };
}

const hit = (failures: string[], substr: string) => failures.some((f) => f.includes(substr));

const SYNTHETIC_BOOTSTRAP = `
const TIER_CACHE = {
  slow: 'max-age=300, stale-while-revalidate=600, stale-if-error=3600',
  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
};
const TIER_CDN_CACHE = {
  slow: 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200',
  fast: 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
};
const ON_DEMAND_CACHE_PROFILES = {
  chinaDecisionSignals: {
    browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
  },
};
function successCacheHeaders(tier, authKind, cors, onDemandKey = null) {
  if (!isPublicBootstrapKind(authKind)) {
    return { ...cors, 'Cache-Control': 'no-store' };
  }
  const publicCors = getPublicCorsHeaders();
  if (!isSharedCacheableBootstrapKind(authKind)) {
    return { ...publicCors, 'Cache-Control': 'no-store' };
  }
  const onDemandProfile = authKind === 'public-on-demand' ? ON_DEMAND_CACHE_PROFILES[onDemandKey] : null;
  const cacheControl = onDemandProfile?.browser
    || (tier && TIER_CACHE[tier])
    || 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900';
  return {
    ...publicCors,
    'Cache-Control': cacheControl,
    'CDN-Cache-Control': onDemandProfile?.cdn
      || (tier && TIER_CDN_CACHE[tier])
      || TIER_CDN_CACHE.fast,
  };
}
const cacheTier = tier ?? (auth.kind === 'public-on-demand' ? 'slow' : null);
`;

describe('parseBootstrapCacheContract', () => {
  it('extracts every emitted value from a handler-shaped source', () => {
    const cache = parseBootstrapCacheContract(SYNTHETIC_BOOTSTRAP);
    assert.equal(cache.tierCache.fast, 'max-age=60, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.tierCache.slow, 'max-age=300, stale-while-revalidate=600, stale-if-error=3600');
    assert.equal(cache.tierCdnCache.fast, 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.tierCdnCache.slow, 'public, s-maxage=7200, stale-while-revalidate=1800, stale-if-error=7200');
    assert.equal(cache.onDemandDefaultTier, 'slow');
    assert.equal(cache.defaultCacheControl, 'public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900');
    assert.equal(cache.defaultCdnTier, 'fast');
    assert.equal(cache.nonCacheable, 'no-store');
    assert.deepEqual(cache.onDemandProfiles.chinaDecisionSignals, {
      browser: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',
      cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',
    });
  });

  it('parses the real api/bootstrap.js into a complete contract', () => {
    for (const tier of ['fast', 'slow']) {
      assert.match(REAL_CACHE.tierCache[tier], /^max-age=\d+,/);
      assert.match(REAL_CACHE.tierCdnCache[tier], /\bs-maxage=\d+\b/);
    }
    assert.ok(['fast', 'slow'].includes(REAL_CACHE.onDemandDefaultTier));
    assert.ok(['fast', 'slow'].includes(REAL_CACHE.defaultCdnTier));
    assert.equal(REAL_CACHE.nonCacheable, 'no-store');
    for (const [key, profile] of Object.entries(REAL_CACHE.onDemandProfiles)) {
      assert.match((profile as { browser: string }).browser, /\bmax-age=\d+\b/, key);
      assert.match((profile as { cdn: string }).cdn, /\bs-maxage=\d+\b/, key);
    }
  });

  // Fail-closed, the lesson LEADER_NAMES / PRIORITY_COUNTRIES already taught this
  // file: a parser that shrugs at a moved constant turns the gate into a no-op
  // that reports OK while checking nothing.
  it('throws when a cache constant is renamed or removed', () => {
    assert.throws(
      () => parseBootstrapCacheContract(SYNTHETIC_BOOTSTRAP.replace('const TIER_CDN_CACHE =', 'const CDN_CACHE =')),
      /could not parse TIER_CDN_CACHE/,
    );
  });

  it('throws when a tier loses its entry', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "  fast: 'max-age=60, stale-while-revalidate=120, stale-if-error=900',\n};",
      '};',
    );
    assert.throws(() => parseBootstrapCacheContract(source), /TIER_CACHE .* is missing the fast tier/);
  });

  it('throws when an on-demand profile declares only half of its headers', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "    cdn: 'public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900',\n",
      '',
    );
    assert.throws(() => parseBootstrapCacheContract(source), /must declare both browser and cdn/);
  });

  it('throws when the on-demand default tier moves', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "const cacheTier = tier ?? (auth.kind === 'public-on-demand' ? 'slow' : null);",
      'const cacheTier = tier ?? null;',
    );
    assert.throws(() => parseBootstrapCacheContract(source), /public-on-demand default cache tier/);
  });

  it('throws when successCacheHeaders grows an undocumented literal state', () => {
    const source = SYNTHETIC_BOOTSTRAP.replace(
      "return { ...cors, 'Cache-Control': 'no-store' };",
      "return { ...cors, 'Cache-Control': 'private, max-age=0' };",
    );
    assert.throws(() => parseBootstrapCacheContract(source), /expected exactly one non-cacheable value/);
  });
});

describe('parseBootstrapKeyTiers', () => {
  it('assigns each registered key to exactly one tier', () => {
    assert.equal(REAL_TIERS.chinaDecisionSignals, 'on-demand');
    assert.equal(REAL_TIERS.weatherAlerts, 'fast');
    assert.ok(Object.values(REAL_TIERS).every((t) => ['fast', 'slow', 'on-demand'].includes(t as string)));
  });

  it('throws when a tier set is renamed', () => {
    assert.throws(
      () => parseBootstrapKeyTiers("const OTHER = new Set([\n  'a',\n]);"),
      /could not parse FAST_KEY_NAMES/,
    );
  });
});

describe('validateBootstrapCacheDocs', () => {
  it('passes against the four real doc surfaces', () => {
    assert.deepEqual(validateBootstrapCacheDocs(REAL_STATS), []);
  });

  // #5791, failure 1: docs/usage-rate-limits.mdx and its zh mirror carry a
  // near-verbatim copy of the api-platform.mdx cache prose with no
  // cross-reference, so "I updated the cache docs" was true of one file and
  // false of another. The gate must fail per-surface, not once for the set.
  it('catches a sibling page left behind when only one copy is updated', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate('docs/usage-rate-limits.mdx', 'browser `max-age=60` / `max-age=300`', 'browser `max-age=30` / `max-age=300`'),
    );
    assert.ok(hit(failures, 'docs/usage-rate-limits.mdx'));
    assert.ok(hit(failures, '?tier=fast&public=1 browser Cache-Control documented as `max-age=30`'));
  });

  // #5791, failure 2: the replacement prose claimed single-key
  // `?keys=<name>&public=1` URLs use `public, s-maxage=600`. Wrong for on-demand
  // keys — cacheTier falls back to 'slow', so they get browser `max-age=300`
  // and CDN `s-maxage=7200`.
  it('catches the on-demand single-key profile being described as the weather default', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(
        EN_PAGE,
        'inherit the slow profile — browser `max-age=300`, CDN `s-maxage=7200`',
        'inherit the fast profile — browser `max-age=60`, CDN `s-maxage=600`',
      ),
    );
    assert.ok(hit(failures, 'tier inherited by ?keys=<onDemandName>&public=1 documented as `fast`'));
    assert.ok(hit(failures, '?keys=<onDemandName>&public=1 browser Cache-Control documented as `max-age=60`'));
    assert.ok(hit(failures, '?keys=<onDemandName>&public=1 CDN-Cache-Control documented as `s-maxage=600`'));
  });

  // The check must be POSITIONAL. `s-maxage=600` is both the fast tier's CDN
  // value and part of the weatherAlerts header, so a page-wide substring search
  // stays green with the tiers transposed — green while dead.
  it('catches the fast and slow CDN values being transposed', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'CDN `s-maxage=600` / `s-maxage=7200`', 'CDN `s-maxage=7200` / `s-maxage=600`'),
    );
    assert.ok(hit(failures, '?tier=fast&public=1 CDN-Cache-Control documented as `s-maxage=7200`'));
    assert.ok(hit(failures, '?tier=slow&public=1 CDN-Cache-Control documented as `s-maxage=600`'));
  });

  it('catches a stale weatherAlerts header string', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(
        EN_PAGE,
        '`Cache-Control: public, s-maxage=600, stale-while-revalidate=120, stale-if-error=900` with the fast-tier',
        '`Cache-Control: public, s-maxage=900, stale-while-revalidate=120, stale-if-error=900` with the fast-tier',
      ),
    );
    assert.ok(hit(failures, '?keys=weatherAlerts&public=1 Cache-Control documented as'));
    assert.ok(hit(failures, 's-maxage=900'));
  });

  it('catches the credentialed shapes being described as cacheable', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'path — uses `Cache-Control: no-store`', 'path — uses `Cache-Control: public, s-maxage=60`'),
    );
    assert.ok(hit(failures, 'Cache-Control for every non-shared-cacheable shape documented as `public, s-maxage=60`'));
  });

  it('catches a zh mirror that drifts from the handler', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(ZH_PAGE, '浏览器 `max-age=60` / `max-age=300`', '浏览器 `max-age=60` / `max-age=600`'),
    );
    assert.ok(hit(failures, 'docs/zh/api-platform.mdx'));
    assert.ok(hit(failures, '?tier=slow&public=1 browser Cache-Control documented as `max-age=600`'));
  });

  // Drift from the code side: the docs stand still while api/bootstrap.js moves.
  it('catches a handler-side tier change the docs never followed', () => {
    const drifted = parseBootstrapCacheContract(
      SYNTHETIC_BOOTSTRAP.replace("fast: 'max-age=60,", "fast: 'max-age=120,"),
    );
    const failures = validateBootstrapCacheDocs(
      { bootstrapCache: drifted },
      REAL_DOCS,
      REAL_TIERS,
    );
    assert.equal(failures.length, BOOTSTRAP_CACHE_DOC_FILES.length);
    for (const file of BOOTSTRAP_CACHE_DOC_FILES) {
      assert.ok(hit(failures, `${file}: ?tier=fast&public=1 browser Cache-Control documented as \`max-age=60\`, api/bootstrap.js emits \`max-age=120\``));
    }
  });

  // "unless the key declares its own" is only honest while every declaring key
  // is published. A new profile must not be able to land silently.
  it('catches a newly declared on-demand profile that no page publishes', () => {
    const cache = {
      ...REAL_CACHE,
      onDemandProfiles: {
        ...REAL_CACHE.onDemandProfiles,
        portwatchPortActivity: { browser: 'max-age=30', cdn: 'public, s-maxage=1200' },
      },
    };
    const failures = validateBootstrapCacheDocs({ bootstrapCache: cache }, REAL_DOCS, REAL_TIERS);
    assert.equal(failures.length, BOOTSTRAP_CACHE_DOC_FILES.length);
    assert.ok(hit(failures, '`portwatchPortActivity` declares its own cache profile'));
  });

  it('catches a declared on-demand profile whose published values are stale', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, '`chinaDecisionSignals` does (browser `max-age=60`, CDN `s-maxage=900`)', '`chinaDecisionSignals` does (browser `max-age=60`, CDN `s-maxage=7200`)'),
    );
    assert.ok(hit(failures, '`chinaDecisionSignals` CDN-Cache-Control documented as `s-maxage=7200`'));
  });

  // `?tier=slow` never returned chinaDecisionSignals — it is an on-demand key —
  // yet api-platform.mdx said it did.
  it('catches a key documented under a tier it is not registered in', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'The on-demand tier includes `chinaDecisionSignals`', 'The slow tier includes `chinaDecisionSignals`'),
    );
    assert.ok(hit(failures, '`chinaDecisionSignals` is documented as slow-tier'));
    assert.ok(hit(failures, 'registers it as on-demand'));
  });

  it('catches a tier sentence naming a key that is not a bootstrap key at all', () => {
    const failures = validateBootstrapCacheDocs(
      REAL_STATS,
      mutate(EN_PAGE, 'The on-demand tier includes `chinaDecisionSignals`', 'The on-demand tier includes `chinaDecisionSignalz`'),
    );
    assert.ok(hit(failures, 'is not a registered bootstrap cache key'));
  });

  it('fails closed when the cache bullet is deleted outright', () => {
    const text = REAL_DOCS[EN_PAGE];
    const line = text.split('\n').find((l) => l.includes('`?tier=fast&public=1` / `?tier=slow&public=1`'))!;
    const failures = validateBootstrapCacheDocs(REAL_STATS, { [EN_PAGE]: text.replace(line, '') });
    assert.ok(hit(failures, 'expected exactly one /api/bootstrap cache bullet'));
    assert.ok(hit(failures, 'found 0'));
  });

  it('fails closed when a second copy of the bullet appears', () => {
    const text = REAL_DOCS[EN_PAGE];
    const line = text.split('\n').find((l) => l.includes('`?tier=fast&public=1` / `?tier=slow&public=1`'))!;
    const failures = validateBootstrapCacheDocs(REAL_STATS, { [EN_PAGE]: `${text}\n${line}\n` });
    assert.ok(hit(failures, 'found 2'));
  });
});
