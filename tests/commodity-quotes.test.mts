import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapErrorToResponse } from '../server/error-mapper.ts';
import {
  SUPPORTED_COMMODITY_SYMBOLS,
  UnsupportedCommoditySymbolError,
  filterCommoditySeed,
  normalizeCommoditySymbol,
  resolveCommodityQuery,
} from '../server/worldmonitor/market/v1/list-commodity-quotes';

function seedQuote(symbol) {
  return { symbol, name: symbol, display: symbol, price: 1, change: 0, sparkline: [] };
}

describe('listCommodityQuotes contract (#6307)', () => {
  it('exposes the configured default commodity symbols as the supported set', () => {
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS instanceof Set);
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.size >= 30, 'expected the full seed commodity set');
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.has('GC=F'), 'gold futures is a default commodity');
    assert.ok(SUPPORTED_COMMODITY_SYMBOLS.has('BZ=F'), 'Brent crude is a default commodity');
  });

  it('normalizes symbols (trim, de-whitespace, upper)', () => {
    assert.equal(normalizeCommoditySymbol('  gc  = f '), 'GC=F');
    assert.equal(normalizeCommoditySymbol('cl=F'), 'CL=F');
    assert.equal(normalizeCommoditySymbol('  BZ=F'), 'BZ=F');
  });

  it('returns an empty resolution (symbols=[]) for an empty request', () => {
    const res = resolveCommodityQuery([]);
    assert.deepEqual(res, { symbols: [], overCap: false });
  });

  it('resolves supported symbols in request order, deduplicating', () => {
    const res = resolveCommodityQuery(['CL=F', 'gc=f', 'CL=F', ' BZ=F ']);
    assert.deepEqual(res.symbols, ['CL=F', 'GC=F', 'BZ=F']);
    assert.equal(res.overCap, false);
  });

  it('throws UnsupportedCommoditySymbolError (HTTP 400) for any unsupported symbol', () => {
    assert.throws(
      () => resolveCommodityQuery(['GC=F', 'AAPL']),
      (err) => {
        assert.ok(err instanceof UnsupportedCommoditySymbolError, `expected UnsupportedCommoditySymbolError, got ${String(err)}`);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /AAPL/);
        return true;
      },
    );
    // Rejection is explicit even when a supported symbol is also present.
    assert.throws(() => resolveCommodityQuery(['GC=F', 'INVALID']), UnsupportedCommoditySymbolError);
  });

  it('rejects whitespace-only symbols instead of treating them as empty→defaults', () => {
    assert.throws(
      () => resolveCommodityQuery(['   ', '\t']),
      (err) => {
        assert.ok(err instanceof UnsupportedCommoditySymbolError);
        assert.equal(err.statusCode, 400);
        assert.match(err.message, /blank/);
        return true;
      },
    );
    // Blank mixed with a supported symbol still fails closed (never partial success).
    assert.throws(() => resolveCommodityQuery(['GC=F', '  ']), UnsupportedCommoditySymbolError);
  });

  it('caps cardinality beyond the configured cap (over-cap is explicit)', () => {
    const many = Array.from({ length: 80 }, (_, i) => `SYM${i}`);
    // none of these are supported → would throw, so build capped against a
    // permissive supported set to exercise the cap independent of support.
    const supported = new Set(many);
    const res = resolveCommodityQuery(many, supported, 64);
    assert.equal(res.symbols.length, 64);
    assert.equal(res.overCap, true);
  });

  it('filters seed quotes to requested symbols in seed order', () => {
    const seed = ['GC=F', 'CL=F', 'SI=F'].map(seedQuote);
    const filtered = filterCommoditySeed(seed, ['CL=F', 'GC=F']);
    assert.deepEqual(filtered.map((q) => q.symbol), ['GC=F', 'CL=F']);
  });

  it('returns the full seed when no symbols are requested (empty → defaults)', () => {
    const seed = ['GC=F', 'CL=F', 'SI=F'].map(seedQuote);
    assert.deepEqual(filterCommoditySeed(seed, []).map((q) => q.symbol), ['GC=F', 'CL=F', 'SI=F']);
  });

  it('surfaces the unsupported-symbol rejection as HTTP 400 through the error mapper', async () => {
    const err = new UnsupportedCommoditySymbolError(['AAPL']);
    const response = mapErrorToResponse(err, new Request('https://api.worldmonitor.app/api/market/v1/list-commodity-quotes?symbols=AAPL'));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { message: err.message });
  });
});
