import { expect, test, type Page } from '@playwright/test';

const ENERGY_KEYS = ['pipelinesGas', 'pipelinesOil', 'storageFacilities'] as const;
const DEMOTED_ON_DEMAND_KEYS = ['flightDelays', 'wsbTickers'] as const;

type BootstrapRequestLog = {
  tier: string[];
  keys: string[];
};

function requestedKeys(url: string): string[] {
  const parsed = new URL(url);
  const keys = parsed.searchParams.get('keys');
  return keys ? keys.split(',').filter(Boolean) : [];
}

async function installBootstrapAccounting(page: Page): Promise<BootstrapRequestLog> {
  const log: BootstrapRequestLog = { tier: [], keys: [] };

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
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: Object.fromEntries(keys.map((key) => [key, { key, records: [] }])),
        missing: [],
      }),
    });
  });

  return log;
}

async function seedAnonymousDashboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem('wm-layer-warning-dismissed', 'true');
    localStorage.setItem('wm-pro-banner-launched-dismissed', String(Date.now()));
    localStorage.setItem('worldmonitor-mission-preset-dismissed-v1', '1');
  });
}

test.describe('bootstrap request budget (#7046)', () => {
  test('full variant with energy layers off does not fetch energy registries', async ({ page }) => {
    const log = await installBootstrapAccounting(page);
    await seedAnonymousDashboard(page);
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('data-wm-event-handlers-ready', 'true', {
      timeout: 45_000,
    });
    await page.waitForTimeout(2_000);

    for (const key of [...ENERGY_KEYS, ...DEMOTED_ON_DEMAND_KEYS]) {
      expect(log.keys, `${key} must not be requested on default full startup`).not.toContain(key);
    }
    expect(log.tier.some((entry) => entry.startsWith('fast:'))).toBeTruthy();
  });
});
