// Content and publishing contract for the /use-cases/ family (issue #6849).

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

function metaContent(html, name) {
  const match = html.match(new RegExp(`<meta name="${name}" content="([^"]*)"`, 'i'));
  return match?.[1] ?? null;
}

describe('use-cases corpus (#6849)', () => {
  let outDir;
  let hubHtml;
  let pageHtml;
  let manifest;

  before(async () => {
    outDir = mkdtempSync(join(tmpdir(), 'wm-use-cases-corpus-'));
    manifest = await buildCorpus({
      rootDir: repoRoot,
      outDir,
      baseUrl: 'https://www.worldmonitor.app',
    });
    hubHtml = readFileSync(join(outDir, 'use-cases', 'index.html'), 'utf8');
    pageHtml = readFileSync(
      join(outDir, 'use-cases', 'monitor-country-risk', 'index.html'),
      'utf8',
    );
  });

  after(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it('publishes the hub and country-risk page with crawlable discovery', () => {
    assert.equal(USE_CASE_PAGES.length, 1);
    assert.match(hubHtml, /<h1>Evergreen monitoring workflows<\/h1>/);
    assert.match(hubHtml, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(hubHtml, /How use cases differ from editorial posts/);
    assert.match(pageHtml, /<h1>Monitor country risk<\/h1>/);
    assert.match(pageHtml, /Direct answer:/);
    assert.match(pageHtml, /End-to-end workflow/);
    assert.match(pageHtml, /Worked example/);
    assert.match(pageHtml, /Provenance, freshness, and limits/);
    assert.match(hubHtml, /href="\/use-cases\/"/);
    assert.match(pageHtml, /href="\/use-cases\/"/);
  });

  it('keeps metadata and structured data inside the corpus SEO contract', () => {
    const hubDesc = metaContent(hubHtml, 'description')
      ?? hubHtml.match(/<meta name="description" content="([^"]+)">/)?.[1];
    const pageDesc = pageHtml.match(/<meta name="description" content="([^"]+)">/)?.[1];
    assert.ok(hubDesc);
    assert.ok(pageDesc);
    assert.ok(hubDesc.length >= 155 && hubDesc.length <= 160, `hub description length ${hubDesc.length}`);
    assert.ok(pageDesc.length >= 155 && pageDesc.length <= 160, `page description length ${pageDesc.length}`);

    assert.match(hubHtml, /rel="canonical" href="https:\/\/www\.worldmonitor\.app\/use-cases\/"/);
    assert.match(
      pageHtml,
      /rel="canonical" href="https:\/\/www\.worldmonitor\.app\/use-cases\/monitor-country-risk\/"/,
    );
    assert.match(hubHtml, /name="robots" content="index, follow"/);
    assert.match(pageHtml, /name="robots" content="index, follow"/);

    const [hubLd, hubBreadcrumb] = jsonLdObjects(hubHtml);
    const [pageLd, pageBreadcrumb] = jsonLdObjects(pageHtml);
    assert.equal(hubLd['@type'], 'CollectionPage');
    assert.equal(pageLd['@type'], 'WebPage');
    assert.notEqual(hubLd['@type'], 'BlogPosting');
    assert.notEqual(pageLd['@type'], 'BlogPosting');
    assert.equal(hubBreadcrumb['@type'], 'BreadcrumbList');
    assert.equal(pageBreadcrumb['@type'], 'BreadcrumbList');
    assert.match(pageHtml, new RegExp(`<meta name="lastmod" content="${USE_CASES_CONTENT_VERSION}">`));
  });

  it('emits bounded use-case attribution on product handoffs without ref=', () => {
    assert.match(pageHtml, /utm_source=seo-use-case/);
    assert.match(pageHtml, /wm_content_source=worldmonitor-use-cases/);
    assert.match(pageHtml, /wm_content_campaign=monitor-country-risk/);
    assert.match(pageHtml, /wm_content_destination=dashboard/);
    assert.match(pageHtml, /wm_content_placement=use-case-cta-dashboard/);
    assert.match(pageHtml, /wm_content_destination=pro/);
    assert.match(pageHtml, /wm_content_destination=api/);
    assert.match(pageHtml, /wm_content_destination=mcp/);
    assert.doesNotMatch(pageHtml, /[?&]ref=/);
    assert.match(pageHtml, /data-use-case-handoff/);
    assert.match(pageHtml, /country=TW&amp;expanded=1|country=TW&expanded=1/);
  });

  it('records the family in the crawlable corpus manifest and countries hub', () => {
    assert.equal(manifest.sections.useCases.index, '/use-cases/');
    assert.deepEqual(manifest.sections.useCases.routes, ['/use-cases/monitor-country-risk/']);
    const countriesHub = readFileSync(join(outDir, 'countries', 'index.html'), 'utf8');
    assert.match(countriesHub, /href="\/use-cases\/monitor-country-risk\/"/);
    assert.match(countriesHub, /href="\/use-cases\/"/);
  });

  it('rejects indexable placeholder copy', () => {
    for (const html of [hubHtml, pageHtml]) {
      assert.doesNotMatch(html, /TODO|lorem ipsum|coming soon|placeholder/i);
    }
  });
});
