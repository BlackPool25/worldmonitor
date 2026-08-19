import { describe, expect, it, vi } from 'vitest';
import type { AppContext } from '@/app/app-context';
import type { XFeedResponse } from '@/services/x-intel';

const mocks = vi.hoisted(() => ({
  fetchXFeed: vi.fn(),
  getHydratedData: vi.fn(),
}));

vi.mock('@/services/x-intel', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/x-intel')>(),
  fetchXFeed: mocks.fetchXFeed,
}));

vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/bootstrap')>(),
  getHydratedData: mocks.getHydratedData,
}));

vi.mock('@/services/panel-gating', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/panel-gating')>(),
  hasPremiumAccess: () => true,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

const feed = (count: number): XFeedResponse => ({
  source: 'x', earlySignal: true, enabled: true, count, updatedAt: null, items: [],
});

describe('X feed DataLoader lifecycle', () => {
  it('hydrates immediately and ignores a late live result after teardown', async () => {
    const panel = { setData: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    const live = deferred<XFeedResponse>();
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue(feed(1));
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockImplementationOnce((_limit, signal: AbortSignal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      live.promise.then(resolve, reject);
    }));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    const load = loader.loadXIntel();
    expect(panel.setData).toHaveBeenCalledTimes(1);
    expect(panel.setData).toHaveBeenCalledWith(expect.objectContaining({ count: 1 }));
    ctx.isDestroyed = true;
    loader.destroy();
    live.resolve(feed(2));
    await load;

    expect(panel.setData).toHaveBeenCalledTimes(1);
  });

  it('keeps hydrated X panel data when the live fetch fails', async () => {
    const panel = { setData: vi.fn() };
    const ctx = { panels: { 'x-intel': panel }, isDestroyed: false } as unknown as AppContext;
    mocks.getHydratedData.mockReset();
    mocks.getHydratedData.mockReturnValue(feed(3));
    mocks.fetchXFeed.mockReset();
    mocks.fetchXFeed.mockRejectedValueOnce(new Error('network down'));
    const { DataLoaderManager } = await import('@/app/data-loader');
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => undefined,
      refreshOpenCountryBrief: () => undefined,
    });

    await loader.loadXIntel();

    expect(panel.setData).toHaveBeenCalledTimes(1);
    expect(panel.setData).toHaveBeenCalledWith(expect.objectContaining({ count: 3, enabled: true }));
  });
});
