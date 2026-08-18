#!/usr/bin/env node
// Deterministic generator for the /use-cases/ family (issue #6849).
//
// Emits the hub and the country-risk workflow page as useful static HTML.
// Template helpers are injected by build-crawlable-corpus.mjs (the single
// owner of the corpus HTML shell). No network access; content is committed.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bump when hub or child copy changes so lastmod advances without touching every sibling. */
export const USE_CASES_CONTENT_VERSION = '2026-08-18';

export const USE_CASE_PAGES = [
  {
    slug: 'monitor-country-risk',
    title: 'Monitor Country Risk',
    path: '/use-cases/monitor-country-risk/',
    hubCard:
      'Establish a baseline, review live instability, corroborate with independent signals, record uncertainty, and continue into an exact dashboard state.',
  },
];

const UMAMI_SCRIPT_TAG =
  '<script async defer src="https://abacus.worldmonitor.app/script.js" '
  + 'data-website-id="e8800335-16bc-4241-a133-0eb28c07c832" '
  + 'data-domains="worldmonitor.app,www.worldmonitor.app,happy.worldmonitor.app" '
  + 'nonce="wm-static-bootstrap"></script>';

export const HANDOFF_PRESERVE_SCRIPT = `(() => {
  const PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
  const rewrite = (anchor) => {
    try {
      const url = new URL(anchor.getAttribute('href'), window.location.origin);
      const incoming = new URLSearchParams(window.location.search);
      for (const name of PARAMS) {
        if (url.searchParams.has(name)) continue;
        const value = incoming.get(name);
        if (value !== null) url.searchParams.set(name, value.slice(0, 100));
      }
      anchor.setAttribute('href', url.pathname + url.search + url.hash);
    } catch (_) { /* keep the build-time href */ }
  };
  document.querySelectorAll('[data-use-case-handoff]').forEach(rewrite);
})();`;

const HANDOFF_UMAMI_EVENT = 'use-case-product-cta-click';
const HANDOFF_SOURCE = 'worldmonitor-use-cases';
const HANDOFF_MEDIUM = 'owned-content';

function handoffAttributes({ campaign, destination, placement }, escapeHtml) {
  const dimensions = {
    source: HANDOFF_SOURCE,
    medium: HANDOFF_MEDIUM,
    campaign,
    destination,
    placement,
  };
  const analyticsAttributes = Object.entries(dimensions)
    .flatMap(([name, value]) => [
      `data-umami-event-${name}="${escapeHtml(value)}"`,
      `data-umami-event-content-${name}="${escapeHtml(value)}"`,
    ])
    .join(' ');

  return `data-use-case-handoff data-wm-content-link data-umami-event="${HANDOFF_UMAMI_EVENT}" ${analyticsAttributes}`;
}

function withContentAttribution(url, {
  source = 'worldmonitor-use-cases',
  medium = 'owned-content',
  campaign,
  destination,
  placement,
}) {
  const parsed = new URL(url, 'https://www.worldmonitor.app');
  parsed.searchParams.set('wm_content_source', source);
  parsed.searchParams.set('wm_content_medium', medium);
  parsed.searchParams.set('wm_content_campaign', campaign);
  parsed.searchParams.set('wm_content_destination', destination);
  parsed.searchParams.set('wm_content_placement', placement);
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function assertMetaDescription(description, label) {
  const length = [...description].length;
  if (length < 155 || length > 160) {
    throw new Error(`${label} meta description must be 155–160 chars (got ${length})`);
  }
}

function renderUseCasesIndex({ tpl, baseUrl, lastmod }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, pageDocument } = tpl;
  const path = '/use-cases/';
  const description =
    'Evergreen World Monitor use-case workflows that turn a monitoring question into an exact dashboard decision, with provenance, limits, and clear next steps.';
  assertMetaDescription(description, 'use-cases hub');

  const cards = USE_CASE_PAGES.map((page) => `        <a class="card" href="${escapeHtml(page.path)}"><strong>${escapeHtml(page.title)}</strong><br><span>${escapeHtml(page.hubCard)}</span></a>`).join('\n');

  const body = `      <p class="eyebrow">Use cases</p>
      <h1>Evergreen monitoring workflows</h1>
      <p class="lede">${escapeHtml(description)}</p>
      <h2>What this collection is</h2>
      <p>Use-case pages are durable task guides. Each one defines a user, a decision, a trigger, and an expected output, then walks a repeatable sequence that ends in an exact World Monitor product state.</p>
      <h2>Who it serves</h2>
      <p>Analysts, duty-of-care officers, newsroom researchers, and operators who need a monitoring procedure — not a dated news article and not a generic marketing landing page.</p>
      <h2>How use cases differ from editorial posts</h2>
      <p>Blog posts remain dated narrative and methodology explainers. Use-case pages stay evergreen, checklist-shaped, and product-handoff oriented. Supporting articles link here for the procedure; these pages link back for deeper editorial context.</p>
      <h2>Published workflows</h2>
      <div class="grid">
${cards}
      </div>
      <p class="source">Live country evidence stays on <a href="/countries/">/countries/</a>. Supporting editorial includes the <a href="/blog/posts/country-risk-monitoring-workflow-for-analysts/">country-risk monitoring workflow article</a>.</p>`;

  return pageDocument({
    baseUrl,
    path,
    title: 'Use Cases | World Monitor',
    description,
    lastmod,
    ogType: 'website',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: 'Evergreen monitoring workflows',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Use cases', path },
    ]),
    body,
    footerBody: `${UMAMI_SCRIPT_TAG}World Monitor use-case corpus. Evergreen workflows use committed product evidence; live API results belong on dashboard and country pages.`,
  });
}

function renderCountryRiskUseCase({ tpl, baseUrl, lastmod }) {
  const { escapeHtml, absoluteUrl, breadcrumbLd, withUtmSource, pageDocument } = tpl;
  const path = '/use-cases/monitor-country-risk/';
  const description =
    'A repeatable World Monitor country-risk workflow: establish a baseline, review live instability, check corroborating signals, record uncertainty, then act.';
  assertMetaDescription(description, 'monitor-country-risk');

  const handoffs = {
    dashboard: {
      campaign: 'monitor-country-risk',
      destination: 'dashboard',
      placement: 'use-case-cta-dashboard',
    },
    pro: {
      campaign: 'monitor-country-risk',
      destination: 'pro',
      placement: 'use-case-cta-pro',
    },
    api: {
      campaign: 'monitor-country-risk',
      destination: 'api',
      placement: 'use-case-cta-api',
    },
    mcp: {
      campaign: 'monitor-country-risk',
      destination: 'mcp',
      placement: 'use-case-cta-mcp',
    },
  };
  const dashboardHref = withUtmSource(
    withContentAttribution('/dashboard?country=TW&expanded=1', handoffs.dashboard),
    'seo-use-case',
  );
  const proHref = withUtmSource(
    withContentAttribution('/pro', handoffs.pro),
    'seo-use-case',
  );
  const apiHref = withUtmSource(
    withContentAttribution('/docs/api-reference', handoffs.api),
    'seo-use-case',
  );
  const mcpHref = withUtmSource(
    withContentAttribution('/docs/mcp-quickstart', handoffs.mcp),
    'seo-use-case',
  );

  const body = `      <p class="eyebrow">Use case</p>
      <h1>Monitor country risk</h1>
      <p class="lede"><strong>Direct answer:</strong> treat country risk as a continuous watch, not an annual PDF. Establish structural and live baselines, review movers and corroborating signals, record what you cannot prove, and continue into an exact World Monitor country brief.</p>

      <h2>Who this is for</h2>
      <p>Risk analysts, corporate security, procurement, investors, and NGO security officers who need a repeatable monitoring decision for a defined country set.</p>
      <p><strong>Not for:</strong> emergency dispatch, legal certification, military targeting, or any decision that requires primary field reporting. World Monitor aggregates public and licensed signals; it does not certify events.</p>

      <h2>Workflow inputs and output</h2>
      <ul>
        <li><strong>User:</strong> an analyst accountable for a named country exposure list.</li>
        <li><strong>Decision:</strong> whether to keep routine watch, deepen the dossier, escalate alerting, or brief stakeholders.</li>
        <li><strong>Trigger:</strong> a new exposure, a score move, a hotspot near an exposure, or a scheduled daily check.</li>
        <li><strong>Expected output:</strong> a dated monitoring note with baseline, live pressure, corroboration, uncertainty, and the next action.</li>
      </ul>

      <h2>End-to-end workflow</h2>
      <ol>
        <li><strong>Establish a baseline.</strong> Read the Country Instability Index (fast clock) beside the Country Resilience Index (slow clock) for each exposure. Record the score, band, and 24-hour delta. Live country pages publish the current snapshot at <a href="/countries/">/countries/</a>.</li>
        <li><strong>Review current instability and forecasts.</strong> Open the country brief, inspect component drivers (unrest, conflict, security, information), and note any prediction-market contracts tied to the country without treating them as proof.</li>
        <li><strong>Check corroborating economic and security signals.</strong> Look for independent families near the exposure — hotspot trends, keyword monitors, infrastructure adjacency, chokepoints, travel advisories, or sanctions context — and require more than repeated headlines.</li>
        <li><strong>Record uncertainty.</strong> Write what is observed, what is inferred, what is stale, and what coverage gaps can explain missing signals. Absence of a sensor is not proof of calm.</li>
        <li><strong>Set the follow-up or escalation.</strong> Choose routine watch, deepen dossier, enable Pro alerting, or automate via API/MCP. Continue into the exact product state below rather than the generic homepage.</li>
      </ol>

      <h2>Product proof used by this workflow</h2>
      <ul>
        <li>Country Instability Index and Country Resilience Index on crawlable country pages and in the live dashboard country brief.</li>
        <li>Country brief dossier with component breakdown and infrastructure context.</li>
        <li>Hotspot trends, keyword monitors, and convergence cues for daily watch.</li>
        <li>Optional Pro notification channels for automated watch.</li>
        <li>Optional API and MCP <code>get_country_risk</code> / country-brief tools for programmable checks.</li>
      </ul>

      <h2>Worked example: five-country supplier footprint</h2>
      <p>Suppose exposure is Taiwan (semiconductors), Mexico (assembly), Poland (logistics), Egypt (Suez and cable landings), and Vietnam (electronics).</p>
      <p>Baseline reading places Taiwan in a moderate-instability / high-resilience quadrant where a single chokepoint dominates, while Egypt sits in a more fragile calm. The monitoring decision changes when Taiwan Strait or Suez signals move, or when a supplier-city keyword monitor fires — not when a generic “regional tension” headline repeats. The analyst leaves the session with a dated note, threshold watchers, and an opened Taiwan country brief rather than a vague “keep an eye on Asia” reminder.</p>

      <h2>Provenance, freshness, and limits</h2>
      <ul>
        <li><strong>Provenance:</strong> CII/CRI methodology pages and country corpus pages disclose inputs; treat blog methodology posts as supporting editorial.</li>
        <li><strong>Freshness:</strong> live instability updates continuously in product; resilience snapshots refresh on a published cadence. Always record observation time in the monitoring note.</li>
        <li><strong>Blind spots:</strong> media-based event data can lag or miss closed societies; multipliers and baselines are model judgments; prediction markets are forecasts, not observations.</li>
        <li><strong>What World Monitor cannot prove:</strong> intent, classified activity, or that a quiet sensor means a quiet ground truth.</li>
      </ul>

      <h2>Exact next action</h2>
      <p>Open the Taiwan country brief in the live dashboard to continue the worked example, then swap the country code for your own exposure list.</p>
      <p><a class="cta" ${handoffAttributes(handoffs.dashboard, escapeHtml)} data-dashboard-link href="${escapeHtml(dashboardHref)}">Open Taiwan country brief →</a></p>
      <p>Secondary handoffs when they continue this workflow:</p>
      <ul class="related">
        <li><a ${handoffAttributes(handoffs.pro, escapeHtml)} href="${escapeHtml(proHref)}">Pro alerting</a></li>
        <li><a ${handoffAttributes(handoffs.api, escapeHtml)} href="${escapeHtml(apiHref)}">API reference</a></li>
        <li><a ${handoffAttributes(handoffs.mcp, escapeHtml)} href="${escapeHtml(mcpHref)}">MCP quickstart</a></li>
      </ul>

      <h2>Supporting material</h2>
      <ul class="related">
        <li><a href="/use-cases/">All use cases</a></li>
        <li><a href="/countries/">Country risk and resilience corpus</a></li>
        <li><a href="/blog/posts/country-risk-monitoring-workflow-for-analysts/">Editorial workflow article</a></li>
        <li><a href="/blog/posts/country-instability-index-methodology-explained/">CII methodology</a></li>
        <li><a href="/docs/methodology/country-resilience-index">CRI methodology</a></li>
      </ul>
      <p class="source">Canonical treatment (#6849): this page owns the evergreen task framing. <a href="/countries/">/countries/</a> remains the live evidence surface. The blog workflow article remains distinct supporting editorial — not a duplicate indexable procedure.</p>`;

  return pageDocument({
    baseUrl,
    path,
    title: 'Monitor Country Risk | World Monitor Use Cases',
    description,
    lastmod,
    ogType: 'article',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: 'Monitor country risk',
      description,
      url: absoluteUrl(baseUrl, path),
      inLanguage: 'en-US',
      dateModified: lastmod,
    },
    breadcrumbs: breadcrumbLd(baseUrl, [
      { name: 'Home', path: '/' },
      { name: 'Use cases', path: '/use-cases/' },
      { name: 'Monitor country risk', path },
    ]),
    body,
    inlineScript: HANDOFF_PRESERVE_SCRIPT,
    footerBody: `${UMAMI_SCRIPT_TAG}World Monitor use-case corpus. Evergreen workflows use committed product evidence; live API results belong on dashboard and country pages.`,
  });
}

export function writeUseCasesSection({ outDir, baseUrl, tpl, lastmod = USE_CASES_CONTENT_VERSION }) {
  mkdirSync(join(outDir, 'use-cases'), { recursive: true });
  writeFileSync(
    join(outDir, 'use-cases', 'index.html'),
    renderUseCasesIndex({ tpl, baseUrl, lastmod }),
  );
  mkdirSync(join(outDir, 'use-cases', 'monitor-country-risk'), { recursive: true });
  writeFileSync(
    join(outDir, 'use-cases', 'monitor-country-risk', 'index.html'),
    renderCountryRiskUseCase({ tpl, baseUrl, lastmod }),
  );
}

export const __test = {
  assertMetaDescription,
  withContentAttribution,
  renderUseCasesIndex,
  renderCountryRiskUseCase,
};
