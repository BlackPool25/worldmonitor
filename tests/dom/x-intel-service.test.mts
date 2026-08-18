import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/utils', () => ({ proxyUrl: (path: string) => path }));
vi.mock('@/services/runtime', () => ({
  isDesktopRuntime: () => false,
  toApiUrl: (path: string) => path,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => { resolve = onResolve; });
  return { promise, resolve };
}

describe('X feed request lifecycle', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('coalesces concurrent requests for the same limit', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { fetchXFeed } = await import('@/services/x-intel');

    const first = fetchXFeed(50);
    const second = fetchXFeed(50);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    response.resolve(new Response(JSON.stringify({
      source: 'x', earlySignal: true, enabled: true, count: 0, updatedAt: null, items: [],
    }), { status: 200 }));

    await expect(first).resolves.toMatchObject({ source: 'x' });
    await expect(second).resolves.toMatchObject({ source: 'x' });
  });

  it('lets one caller abort without canceling the shared request', async () => {
    const response = deferred<Response>();
    const fetchMock = vi.fn(() => response.promise);
    vi.stubGlobal('fetch', fetchMock);
    const { fetchXFeed } = await import('@/services/x-intel');
    const controller = new AbortController();

    const aborted = fetchXFeed(50, controller.signal);
    const survivor = fetchXFeed(50);
    controller.abort();
    await expect(aborted).rejects.toMatchObject({ name: 'AbortError' });
    response.resolve(new Response(JSON.stringify({
      source: 'x', earlySignal: true, enabled: true, count: 1, updatedAt: null, items: [],
    }), { status: 200 }));

    await expect(survivor).resolves.toMatchObject({ count: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
