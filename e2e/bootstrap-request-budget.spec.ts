import { expect, test, type Page } from '@playwright/test';

const ENERGY_KEYS = ['pipelinesGas', 'pipelinesOil', 'storageFacilities'] as const;
const DEMOTED_ON_DEMAND_KEYS = ['flightDelays', 'wsbTickers'] as const;

const PIPELINE_EVIDENCE = {
  physicalState: 'flowing',
  physicalStateSource: 'operator',
  commercialState: 'active',
  sanctionRefs: [],
  lastEvidenceUpdate: '2026-08-20T12:00:00Z',
  classifierVersion: 'v2',
  classifierConfidence: 0.98,
};

const ENERGY_BOOTSTRAP_DATA: Record<(typeof ENERGY_KEYS)[number], unknown> = {
  pipelinesGas: {
    pipelines: {
      'browser-gas': {
        id: 'browser-gas',
        name: 'Browser Gas Link',
        operator: 'Gas Operator',
        commodityType: 'gas',
        fromCountry: 'NO',
        toCountry: 'DE',
        capacityBcmYr: 55,
        startPoint: { lat: 58, lon: 6 },
        endPoint: { lat: 53, lon: 8 },
        evidence: PIPELINE_EVIDENCE,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
  pipelinesOil: {
    pipelines: {
      'browser-oil': {
        id: 'browser-oil',
        name: 'Browser Oil Link',
        operator: 'Oil Operator',
        commodityType: 'oil',
        fromCountry: 'PL',
        toCountry: 'DE',
        capacityMbd: 1.4,
        startPoint: { lat: 52, lon: 19 },
        endPoint: { lat: 52, lon: 13 },
        evidence: PIPELINE_EVIDENCE,
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
  storageFacilities: {
    facilities: {
      'browser-storage': {
        id: 'browser-storage',
        name: 'Browser Storage Hub',
        operator: 'Storage Operator',
        facilityType: 'ugs',
        country: 'DE',
        location: { lat: 52.6, lon: 8.4 },
        capacityTwh: 42.5,
        evidence: {
          physicalState: 'operational',
          physicalStateSource: 'operator',
          commercialState: 'active',
          sanctionRefs: [],
          fillDisclosed: true,
          fillSource: 'operator',
          lastEvidenceUpdate: '2026-08-20T12:00:00Z',
          classifierVersion: 'v2',
          classifierConfidence: 0.98,
        },
      },
    },
    classifierVersion: 'v2',
    updatedAt: '2026-08-20T12:00:00Z',
  },
};

type BootstrapRequestLog = {
  tier: string[];
  keys: string[];
  counts: Record<string, number>;
};

type EnergyMapHarnessWindow = Window & {
  __mapHarness?: {
    ready: boolean;
    variant: string;
    getLayerDataCount: (layerId: string) => number;
  };
};

function requestedKeys(url: string): string[] {
  const parsed = new URL(url);
  const keys = parsed.searchParams.get('keys');
  return keys ? keys.split(',').filter(Boolean) : [];
}

async function installBootstrapAccounting(page: Page): Promise<BootstrapRequestLog> {
  const log: BootstrapRequestLog = { tier: [], keys: [], counts: {} };

  await page.route('**/api/bootstrap*', async (route) => {
    const url = route.request().url();
    const parsed = new URL(url);
    const tier = parsed.searchParams.get('tier');
    if (tier === 'fast' || tier === 'slow') {
      log.tier.push(`${tier}:${url}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: {}, missing: [] }),
      });
      return;
    }
    const keys = requestedKeys(url);
    log.keys.push(...keys);
    for (const key of keys) log.counts[key] = (log.counts[key] ?? 0) + 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: Object.fromEntries(keys.map((key) => [
          key,
          ENERGY_BOOTSTRAP_DATA[key as (typeof ENERGY_KEYS)[number]] ?? { key, records: [] },
        ])),
        missing: [],
      }),
    });
  });

  return log;
}

async function seedAnonymousDashboard(
  page: Page,
  variant: 'full' | 'happy' | 'energy',
): Promise<void> {
  await page.addInitScript((selectedVariant) => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
    localStorage.setItem('worldmonitor-variant', selectedVariant);
  }, variant);
}

async function waitForStartup(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', {
    timeout: 45_000,
  });
  await expect(page.locator('html')).toHaveAttribute('data-wm-initial-data-ready', 'true', {
    timeout: 45_000,
  });
}

async function expectPopulatedEnergyMapLayers(page: Page): Promise<void> {
  await page.goto('/tests/map-harness.html');
  await expect(page.locator('.deckgl-map-wrapper')).toBeVisible();
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as EnergyMapHarnessWindow).__mapHarness;
    return harness?.ready && harness.variant === 'energy';
  }), { timeout: 45_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() => {
    const harness = (window as EnergyMapHarnessWindow).__mapHarness;
    return {
      pipelines: harness?.getLayerDataCount('pipelines-layer') ?? 0,
      storage: harness?.getLayerDataCount('storage-facilities-layer') ?? 0,
    };
  }), { timeout: 20_000 }).toEqual({ pipelines: 2, storage: 1 });
}

test.describe('bootstrap request budget (#7046)', () => {
  for (const variant of ['full', 'happy'] as const) {
    test(`${variant} startup makes no energy registry requests`, async ({ page }) => {
      const log = await installBootstrapAccounting(page);
      await seedAnonymousDashboard(page, variant);
      await waitForStartup(page);

      for (const key of ENERGY_KEYS) {
        expect(log.counts[key] ?? 0, `${key} must stay off ${variant} startup`).toBe(0);
      }
      expect(log.tier.some((entry) => entry.startsWith('fast:'))).toBeTruthy();
    });
  }

  test('full startup also keeps the other demoted keys off the request budget', async ({ page }) => {
    const log = await installBootstrapAccounting(page);
    await seedAnonymousDashboard(page, 'full');
    await waitForStartup(page);

    for (const key of DEMOTED_ON_DEMAND_KEYS) {
      expect(log.keys, `${key} must not be requested on default full startup`).not.toContain(key);
    }
  });

  test('energy startup requests every registry once and renders populated map and panels', async ({ page }) => {
    const log = await installBootstrapAccounting(page);
    await seedAnonymousDashboard(page, 'energy');
    await waitForStartup(page);

    for (const key of ENERGY_KEYS) {
      await expect.poll(() => log.counts[key] ?? 0, {
        message: `${key} should be requested exactly once`,
      }).toBe(1);
    }

    const pipelinePanel = page.locator('[data-panel="pipeline-status"]');
    const storagePanel = page.locator('[data-panel="storage-facility-map"]');
    await pipelinePanel.scrollIntoViewIfNeeded();
    await expect(pipelinePanel.locator('.pp-row')).toHaveCount(2);
    await expect(pipelinePanel).toContainText('Browser Gas Link');
    await expect(pipelinePanel).toContainText('Browser Oil Link');
    await storagePanel.scrollIntoViewIfNeeded();
    await expect(storagePanel.locator('.sf-row')).toHaveCount(1);
    await expect(storagePanel).toContainText('Browser Storage Hub');

    for (const key of ENERGY_KEYS) {
      expect(log.counts[key], `${key} must remain single-flight after panels mount`).toBe(1);
    }

    // The production map does not expose its deck.gl layer data. Reuse the
    // repository's real DeckGL harness to inspect the same store consumers and
    // assert record counts, which is stronger than a toggle-ready CSS class.
    await expectPopulatedEnergyMapLayers(page);
  });
});
