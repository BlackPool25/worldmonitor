/**
 * #6182 round 3 — evidence-gated extraction, half-open cooldowns, and the
 * bounded discovery re-draw.
 *
 * The prompt now tells the extractor a printed price wins even next to an
 * "Out of Stock" notice, which is only safe because acceptance is gated on
 * PROOF: the digits must appear in the rendered content the same provider
 * call returned. These tests pin that gate and the two availability fixes
 * (a cooldown that probes instead of staying open forever, and a second
 * discovery draw when the first one yields nothing in-policy).
 */
import { describe, expect, it, vi } from 'vitest';
import { SearchAdapter, SearchTargetError } from './search.js';
import { COOLDOWN_PROBE_INTERVAL } from './provider-cooldown.js';
import type { ExaProvider } from '../acquisition/exa.js';
import type { FirecrawlProvider } from '../acquisition/firecrawl.js';
import type { AdapterContext } from './types.js';
import type { RetailerConfig } from '../config/types.js';

const PRODUCT_URL = 'https://coldstorage.com.sg/en/p/bread/i/1.html';

function makeConfig(overrides: Partial<RetailerConfig['searchConfig']> = {}): RetailerConfig {
  return {
    slug: 'coldstorage_sg',
    name: 'Cold Storage Singapore',
    marketCode: 'sg',
    currencyCode: 'SGD',
    adapter: 'search',
    baseUrl: 'https://coldstorage.com.sg',
    enabled: true,
    discovery: { mode: 'search', seeds: [], maxPages: 20 },
    searchConfig: {
      numResults: 3,
      extractionFallback: 'none',
      requireStrictValidator: true,
      ...overrides,
    },
  } as RetailerConfig;
}

function makeContext(config: RetailerConfig): AdapterContext {
  return {
    config,
    runId: 'run-1',
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

function makeTarget() {
  return {
    id: 'bread_white',
    url: 'https://coldstorage.com.sg',
    category: 'bread',
    metadata: {
      canonicalName: 'White Sandwich Bread 400g',
      domain: 'coldstorage.com.sg',
      currency: 'SGD',
      basketSlug: 'essentials-sg',
      itemConstraints: { baseUnit: 'g', minBaseQty: 350, maxBaseQty: 450 },
      direct: false,
    },
  };
}

const goodExtract = {
  productName: 'Meadows White Sandwich Bread',
  price: 4.6,
  currency: 'SGD',
  inStock: true,
  sizeText: '400g',
};

describe('price-evidence gate', () => {
  it('rejects a price whose digits are absent from the rendered page', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        // The #6270 fabrication shape: a confident extract from a page whose
        // rendered content has no such digits.
        pageContent: "We couldn't find the page you were looking for.",
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const err = await adapter
      .fetchTarget(makeContext(makeConfig()), makeTarget())
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(SearchTargetError);
    const failures = (err as SearchTargetError).failures;
    expect(failures.some((f) => f.reason === 'price-evidence-missing')).toBe(true);
    // Evidence rejection counts as a rejected observation for strict retailers.
    expect((err as SearchTargetError).rejectedCount).toBe(1);
  });

  it('accepts a price whose digits appear in the rendered page', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        pageContent: 'Meadows White Sandwich Bread 400g\n\n$4.60\n\nAdd to cart',
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig());
    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(products[0]?.price).toBe(4.6);
  });

  it('keeps the historical accept path when the provider returns no page content', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({ data: goodExtract }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig());
    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(products[0]?.price).toBe(4.6);
  });

  it('escalates to the Exa fallback when Firecrawl fails the evidence check', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        pageContent: 'White Sandwich Bread SGD 4.60 in stock',
      }),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        pageContent: 'unrelated shell content',
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ extractionFallback: 'exa' }));
    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(products[0]?.price).toBe(4.6);
    expect(products[0]?.rawPayload.extractionProvider).toBe('exa');
  });
});

describe('half-open provider cooldown', () => {
  it('probes after the skip window and recovers the rest of the scrape', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
    } as unknown as ExaProvider;
    // Two transport errors open the cooldown; every later call succeeds. Under
    // the pre-#6182 always-open cooldown, targets 2..N all died on
    // provider-cooldown (Tesco GB 2026-08-08: 11 of 12 pages).
    const firecrawl = {
      extract: vi
        .fn()
        .mockRejectedValueOnce(new Error('Firecrawl extract failed: HTTP 500'))
        .mockRejectedValueOnce(new Error('Firecrawl extract failed: HTTP 500'))
        .mockResolvedValue({
          data: goodExtract,
          pageContent: '$4.60 Meadows White Sandwich Bread',
        }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig());

    const outcomes: Array<'ok' | 'cooldown' | 'error'> = [];
    // Target 1 opens the gate (2 provider errors while iterating its single
    // candidate... one candidate = one call; run two targets to accumulate the
    // two errors, then observe the skip window and the probe).
    for (let i = 0; i < 2 + COOLDOWN_PROBE_INTERVAL + 2; i++) {
      const outcome = await adapter
        .fetchTarget(context, makeTarget())
        .then(() => 'ok' as const, (e: unknown) =>
          e instanceof SearchTargetError && e.failures.some((f) => f.reason === 'provider-cooldown')
            ? ('cooldown' as const)
            : ('error' as const));
      outcomes.push(outcome);
    }

    // 2 opening errors -> a bounded skip window -> a probe that succeeds ->
    // every later target extracts normally again.
    expect(outcomes.slice(0, 2)).toEqual(['error', 'error']);
    expect(outcomes.slice(2, 2 + COOLDOWN_PROBE_INTERVAL)).toEqual(
      Array.from({ length: COOLDOWN_PROBE_INTERVAL }, () => 'cooldown'),
    );
    expect(outcomes.slice(2 + COOLDOWN_PROBE_INTERVAL)).toEqual(['ok', 'ok']);
    // The skip window made no provider calls: 2 failures + probe + final = 4.
    expect((firecrawl.extract as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });
});

describe('bounded discovery re-draw', () => {
  it('retries the search once, wider, when no result passes the URL policy', async () => {
    const exa = {
      search: vi
        .fn()
        .mockResolvedValueOnce([
          { url: 'https://www.coldstorage.com.sg/img/uploads/flyer.pdf' },
          { url: 'https://www.coldstorage.com.sg/campaigns/index.html' },
        ])
        .mockResolvedValueOnce([{ url: PRODUCT_URL }]),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        pageContent: '$4.60 Meadows White Sandwich Bread',
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ urlPathContains: '/p/' }));
    const result = await adapter.fetchTarget(context, makeTarget());
    const products = await adapter.parseListing(context, result);

    expect(products[0]?.price).toBe(4.6);
    const searchMock = exa.search as ReturnType<typeof vi.fn>;
    expect(searchMock.mock.calls.length).toBe(2);
    // The re-draw widens the net: numResults doubled (floor 8).
    expect(searchMock.mock.calls[1]?.[1]).toMatchObject({ numResults: 8 });
  });

  it('still fails with the zero-candidate error when the re-draw also yields nothing', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: 'https://www.coldstorage.com.sg/img/uploads/flyer.pdf' }]),
    } as unknown as ExaProvider;
    const firecrawl = { extract: vi.fn() } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ urlPathContains: '/p/' }));

    await expect(adapter.fetchTarget(context, makeTarget())).rejects.toThrow(/failed host\/path check/);
    expect((exa.search as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(firecrawl.extract).not.toHaveBeenCalled();
  });
});

describe('renderWaitMs plumbing', () => {
  it('passes the configured settle wait to Firecrawl and not to Exa', async () => {
    const exa = {
      search: vi.fn().mockResolvedValue([{ url: PRODUCT_URL }]),
      extract: vi.fn().mockResolvedValue({ data: {} }),
    } as unknown as ExaProvider;
    const firecrawl = {
      extract: vi.fn().mockResolvedValue({
        data: goodExtract,
        pageContent: '$4.60 Meadows White Sandwich Bread',
      }),
    } as unknown as FirecrawlProvider;

    const adapter = new SearchAdapter(exa, firecrawl);
    const context = makeContext(makeConfig({ renderWaitMs: 8000 }));
    await adapter.fetchTarget(context, makeTarget());

    expect((firecrawl.extract as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({ waitFor: 8000 });
  });
});
