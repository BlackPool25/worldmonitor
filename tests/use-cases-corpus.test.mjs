// Content and publishing contract for the /use-cases/ family (issues #6849, #6850).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  USE_CASE_PAGES,
  USE_CASES_CONTENT_VERSION,
} from '../scripts/build-use-cases.mjs';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

function jsonLdObjects(html) {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
    .map(([, raw]) => JSON.parse(raw));
}

describe('use-cases corpus (#6849, #6850)', () => {
  let outDir;
  let hubHtml;
  let countryRiskHtml;
  let breakingNewsHtml;
  let manifest;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-use-cases-corpus-'));
    manifest = await buildCorpus({
      rootDir: repoRoot,
      outDir,
      baseUrl: 'https://www.worldmonitor.app',
    });
    hubHtml = readFileSync(join(outDir, 'use-cases', 'index.html'), 'utf8');
    countryRiskHtml = readFileSync(
      join(outDir, 'use-cases', 'monitor-country-risk', 'index.html'),
      'utf8',
    );
    breakingNewsHtml = readFileSync(
      join(outDir, 'use-cases', 'verify-breaking-news', 'index.html'),
      'utf8',
    );
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('publishes the hub and child pages with crawlable discovery', () => {
    assert.equal(USE_CASE_PAGES.length, 2);
    assert.deepEqual(
      USE_CASE_PAGES.map((page) => page.path),
      ['/use-cases/monitor-country-risk/', '/use-cases/verify-breaking-news/'],
    );
    assert.match(hubHtml, /<h1>Evergreen monitoring workflows<\/h1>/);
    assert.match(hubHtml, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(hubHtml, /href="\/use-cases\/verify-breaking-news\/"/);
    assert.match(hubHtml, /How use cases differ from editorial posts/);
    assert.match(countryRiskHtml, /<h1>Monitor country risk<\/h1>/);
    assert.match(breakingNewsHtml, /<h1>Verify breaking news<\/h1>/);
    assert.match(breakingNewsHtml, /Direct answer:/);
    assert.match(breakingNewsHtml, /End-to-end workflow/);
    assert.match(breakingNewsHtml, /Worked example/);
    assert.match(breakingNewsHtml, /Provenance, freshness, and limits/);
    assert.match(breakingNewsHtml, /repeated headlines are independent confirmations|equating repetition to proof|repetition as corroboration|Treat wire pickup as reach/i);
    assert.match(breakingNewsHtml, /Absence of AIS here is weak evidence|quiet sensor|proof the event did not occur/i);
    assert.match(hubHtml, /href="\/use-cases\/"/);
    assert.match(countryRiskHtml, /href="\/use-cases\/"/);
    assert.match(breakingNewsHtml, /href="\/use-cases\/"/);
  });

  it('keeps metadata and structured data inside the corpus SEO contract', () => {
    for (const [label, html, canonical] of [
      ['hub', hubHtml, '/use-cases/'],
      ['country-risk', countryRiskHtml, '/use-cases/monitor-country-risk/'],
      ['breaking-news', breakingNewsHtml, '/use-cases/verify-breaking-news/'],
    ]) {
      const desc = html.match(/<meta name="description" content="([^"]+)">/)?.[1];
      assert.ok(desc, `${label} missing description`);
      assert.ok(desc.length >= 155 && desc.length <= 160, `${label} description length ${desc.length}`);
      assert.match(
        html,
        new RegExp(`rel="canonical" href="https://www\\.worldmonitor\\.app${canonical.replaceAll('/', '\\/')}"`),
      );
      assert.match(html, /name="robots" content="index, follow"/);
      const [ld] = jsonLdObjects(html);
      assert.notEqual(ld['@type'], 'BlogPosting');
      assert.match(html, new RegExp(`<meta name="lastmod" content="${USE_CASES_CONTENT_VERSION}">`));
    }

    const [hubLd] = jsonLdObjects(hubHtml);
    const [pageLd] = jsonLdObjects(breakingNewsHtml);
    assert.equal(hubLd['@type'], 'CollectionPage');
    assert.equal(pageLd['@type'], 'WebPage');
  });

  it('emits bounded use-case attribution on product handoffs without ref=', () => {
    for (const [label, html, campaign] of [
      ['country-risk', countryRiskHtml, 'monitor-country-risk'],
      ['breaking-news', breakingNewsHtml, 'verify-breaking-news'],
    ]) {
      assert.match(html, /utm_source=seo-use-case/, label);
      assert.match(html, /wm_content_source=worldmonitor-use-cases/, label);
      assert.match(html, new RegExp(`wm_content_campaign=${campaign}`), label);
      assert.match(html, /wm_content_destination=dashboard/, label);
      assert.match(html, /wm_content_placement=use-case-cta-dashboard/, label);
      assert.match(html, /wm_content_destination=pro/, label);
      assert.match(html, /wm_content_destination=api/, label);
      assert.match(html, /wm_content_destination=mcp/, label);
      assert.doesNotMatch(html, /[?&]ref=/);
      assert.match(html, /data-use-case-handoff/);
    }
    assert.match(
      breakingNewsHtml,
      /layers=ais,flights,fires,outages,hotspots,natural,military|layers=ais%2Cflights%2Cfires%2Coutages%2Chotspots%2Cnatural%2Cmilitary/,
    );
  });

  it('records the family in the crawlable corpus manifest and countries hub', () => {
    assert.equal(manifest.sections.useCases.index, '/use-cases/');
    assert.equal(manifest.sections.useCases.count, 2);
    assert.deepEqual(manifest.sections.useCases.routes, [
      '/use-cases/monitor-country-risk/',
      '/use-cases/verify-breaking-news/',
    ]);
    const countriesHub = readFileSync(join(outDir, 'countries', 'index.html'), 'utf8');
    assert.match(countriesHub, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(countriesHub, /href="\/use-cases\/"/);
  });

  it('rejects indexable placeholder copy', () => {
    for (const html of [hubHtml, countryRiskHtml, breakingNewsHtml]) {
      assert.doesNotMatch(html, /TODO|lorem ipsum|coming soon|placeholder/i);
    }
  });
});
