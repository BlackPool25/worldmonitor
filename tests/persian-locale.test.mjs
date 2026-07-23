import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const ROOT = process.cwd();
const english = JSON.parse(readFileSync(join(ROOT, 'src/locales/en.json'), 'utf8'));
const persian = JSON.parse(readFileSync(join(ROOT, 'src/locales/fa.json'), 'utf8'));

const UNTRANSLATED_TECHNICAL_KEYS = new Set([
  'widgets.proBadge',
  'panels.internetDisruptionsTabs.ddos',
  'modals.story.twitter',
  'components.pizzint.defcon',
  'components.strategicPosture.openSkyAdsb',
  'components.telegramIntel.filterOsint',
  'components.serviceStatus.categories.saas',
  'components.diseaseOutbreaks.attribution',
  'components.earningsCalendar.epsActual',
  'components.fsi.metrics.vix',
  'components.proBanner.badge',
  'components.panelFreshness.labelWithAge',
  'popups.protest.gdelt',
  'popups.flight.sources.faa',
  'popups.flight.sources.notam',
  'popups.hotspot.components.cii',
  'popups.militaryVessel.mmsi',
  'popups.hotspotSubtexts.gchq_mi6',
  'premium.pro',
]);

function flatten(value, prefix = '', target = new Map()) {
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      flatten(child, path, target);
    } else {
      target.set(path, child);
    }
  }
  return target;
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\{\s*([^},\s]+)[^}]*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

function htmlTags(value) {
  return [...String(value).matchAll(/<\/?([a-z][a-z0-9]*)\b[^>]*>/gi)]
    .map((match) => `${match[0].startsWith('</') ? '/' : ''}${match[1].toLowerCase()}`);
}

describe('Persian locale', () => {
  const englishFlat = flatten(english);
  const persianFlat = flatten(persian);

  it('translates every user-facing string except language-neutral technical labels', () => {
    const unchanged = [...englishFlat]
      .filter(([key, value]) => persianFlat.get(key) === value)
      .map(([key]) => key);

    assert.deepEqual(unchanged, [...UNTRANSLATED_TECHNICAL_KEYS]);
  });

  it('preserves interpolation variables and rich-text markup', () => {
    const interpolationMismatches = [];
    const markupMismatches = [];

    for (const [key, value] of englishFlat) {
      if (!persianFlat.has(key)) continue;
      if (placeholders(value).join(',') !== placeholders(persianFlat.get(key)).join(',')) {
        interpolationMismatches.push(key);
      }
      if (htmlTags(value).join(',') !== htmlTags(persianFlat.get(key)).join(',')) {
        markupMismatches.push(key);
      }
    }

    assert.deepEqual(interpolationMismatches, [], 'Persian interpolation variables must match English');
    assert.deepEqual(markupMismatches, [], 'Persian rich-text tag structure must match English');
  });
});
