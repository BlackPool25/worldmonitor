// Content and publishing contract for the /use-cases/ family (issue #6849).

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

import { buildCorpus } from '../scripts/build-crawlable-corpus.mjs';
import {
  HANDOFF_PRESERVE_SCRIPT,
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

function htmlAttributes(source) {
  return Object.fromEntries(
    [...source.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)]
      .map(([, name, value = '']) => [name, value.replaceAll('&amp;', '&')]),
  );
}

function handoffForDestination(html, destination) {
  for (const [, source] of html.matchAll(/<a\b([^>]*)>/g)) {
    const attributes = htmlAttributes(source);
    if (attributes['data-umami-event-content-destination'] === destination) return attributes;
  }
  assert.fail(`missing ${destination} handoff`);
}

function executeHandoffPreserve(incomingSearch, initialHrefs) {
  const anchors = initialHrefs.map((initialHref) => {
    let href = initialHref;
    return {
      getAttribute(name) {
        return name === 'href' ? href : null;
      },
      setAttribute(name, value) {
        assert.equal(name, 'href');
        href = value;
      },
      currentHref() {
        return href;
      },
    };
  });

  runInNewContext(HANDOFF_PRESERVE_SCRIPT, {
    URL,
    URLSearchParams,
    window: {
      location: {
        origin: 'https://www.worldmonitor.app',
        search: incomingSearch,
      },
    },
    document: {
      querySelectorAll(selector) {
        assert.equal(selector, '[data-use-case-handoff]');
        return anchors;
      },
    },
  });

  return anchors.map((anchor) => anchor.currentHref());
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

  it('emits bounded URL and Umami attribution for every product handoff', () => {
    const expectedPaths = {
      dashboard: '/dashboard',
      pro: '/pro',
      api: '/docs/api-reference',
      mcp: '/docs/mcp-quickstart',
    };

    for (const destination of ['dashboard', 'pro', 'api', 'mcp']) {
      const attributes = handoffForDestination(pageHtml, destination);
      const placement = `use-case-cta-${destination}`;
      assert.equal(attributes['data-use-case-handoff'], '');
      assert.equal(attributes['data-wm-content-link'], '');
      assert.equal(attributes['data-umami-event'], 'use-case-product-cta-click');
      for (const [field, value] of Object.entries({
        source: 'worldmonitor-use-cases',
        medium: 'owned-content',
        campaign: 'monitor-country-risk',
        destination,
        placement,
      })) {
        assert.equal(attributes[`data-umami-event-${field}`], value);
        assert.equal(attributes[`data-umami-event-content-${field}`], value);
      }

      const url = new URL(attributes.href, 'https://www.worldmonitor.app');
      assert.equal(url.pathname, expectedPaths[destination]);
      assert.equal(url.searchParams.get('utm_source'), 'seo-use-case');
      assert.equal(url.searchParams.get('wm_content_source'), 'worldmonitor-use-cases');
      assert.equal(url.searchParams.get('wm_content_medium'), 'owned-content');
      assert.equal(url.searchParams.get('wm_content_campaign'), 'monitor-country-risk');
      assert.equal(url.searchParams.get('wm_content_destination'), destination);
      assert.equal(url.searchParams.get('wm_content_placement'), placement);
      assert.equal(url.searchParams.has('ref'), false);
      assert.equal(url.searchParams.has('wm_referral'), false);
    }

    const dashboardUrl = new URL(
      handoffForDestination(pageHtml, 'dashboard').href,
      'https://www.worldmonitor.app',
    );
    assert.equal(dashboardUrl.pathname, '/dashboard');
    assert.equal(dashboardUrl.searchParams.get('country'), 'TW');
    assert.equal(dashboardUrl.searchParams.get('expanded'), '1');
  });

  it('preserves bounded inbound UTM values without clobbering destination values', () => {
    const longCampaign = 'x'.repeat(120);
    const [dashboardHref, proHref, malformedHref] = executeHandoffPreserve(
      `?utm_source=inbound&utm_source=second&utm_medium=email&utm_campaign=${longCampaign}&utm_term=term&utm_content=button&ref=affiliate&wm_referral=partner`,
      [
        '/dashboard?utm_source=destination&utm_medium=existing',
        '/pro?utm_campaign=page',
        'http://[',
      ],
    );

    const dashboardUrl = new URL(dashboardHref, 'https://www.worldmonitor.app');
    assert.equal(dashboardUrl.searchParams.get('utm_source'), 'destination');
    assert.equal(dashboardUrl.searchParams.get('utm_medium'), 'existing');
    assert.equal(dashboardUrl.searchParams.get('utm_campaign'), 'x'.repeat(100));
    assert.equal(dashboardUrl.searchParams.get('utm_term'), 'term');
    assert.equal(dashboardUrl.searchParams.get('utm_content'), 'button');
    assert.equal(dashboardUrl.searchParams.has('ref'), false);
    assert.equal(dashboardUrl.searchParams.has('wm_referral'), false);

    const proUrl = new URL(proHref, 'https://www.worldmonitor.app');
    assert.equal(proUrl.searchParams.get('utm_source'), 'inbound');
    assert.equal(proUrl.searchParams.get('utm_campaign'), 'page');
    assert.equal(proUrl.searchParams.has('ref'), false);
    assert.equal(proUrl.searchParams.has('wm_referral'), false);
    assert.equal(malformedHref, 'http://[');
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
