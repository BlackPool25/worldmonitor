/**
 * Locks the 200-response contract on POST /api/create-checkout.
 *
 * Regression scope: WORLDMONITOR-XV — a Safari client got HTTP 200 whose
 * body was not valid JSON. The success path ran a bare `await resp.json()`,
 * so the parse threw a raw browser DOMException
 * (`SyntaxError: The string did not match the expected pattern.`, code 12)
 * that escaped past the deliberately-built "200 without a usable
 * checkout_url" contract-violation reporter into the generic catch. Three
 * consequences, all of which these tests pin shut:
 *
 *   1. No upstream snapshot was captured, so there is zero evidence of what
 *      the 200 body actually was (HTML interstitial? empty? truncated?) —
 *      the exact blindness the `!resp.ok` branch already fixed for 403s
 *      (WORLDMONITOR-RN).
 *   2. The reported message is engine-specific, so one bug fragments across
 *      a Sentry fingerprint per browser (Safari / Chrome / Firefox each
 *      phrase a JSON parse failure differently).
 *   3. Extending the snapshot to the 200 path introduces exposure the error
 *      path never had: a success body carries `anonymous_claim_token`, a
 *      credential persisted to localStorage as claim proof for migrating
 *      protected payment rows. It must never reach Sentry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  parseCheckoutSuccessBody,
  snapshotUpstreamResponse,
} from '../src/services/checkout-errors.ts';

function makeResp(headers: Record<string, string> = {}): { headers: Headers } {
  return { headers: new Headers(headers) };
}

describe('parseCheckoutSuccessBody', () => {
  it('returns the parsed object for a well-formed success body', () => {
    const body = parseCheckoutSuccessBody('{"checkout_url":"https://checkout.dodopayments.com/s/abc"}');
    assert.equal(body?.checkout_url, 'https://checkout.dodopayments.com/s/abc');
  });

  it('returns null for an empty 200 body (the shape that threw in WORLDMONITOR-XV)', () => {
    // A bare resp.json() on this input is what produced the Safari
    // DOMException. null is the signal "unparseable", which the caller
    // must report distinctly from a parsed body missing checkout_url.
    assert.equal(parseCheckoutSuccessBody(''), null);
  });

  it('returns null for an HTML body served with 200 (edge interstitial / middlebox)', () => {
    assert.equal(parseCheckoutSuccessBody('<!DOCTYPE html><html>Attention Required</html>'), null);
  });

  it('returns null for truncated JSON (mid-transit cut)', () => {
    assert.equal(parseCheckoutSuccessBody('{"checkout_url":"https://checkout.dod'), null);
    assert.equal(parseCheckoutSuccessBody('{'), null);
  });

  it('returns null for JSON that is not a plain object', () => {
    // Same structural-lie reasoning as parseCheckoutErrorBody: null, arrays
    // and primitives are valid JSON but cannot carry checkout_url, and
    // casting them would set traps for consumers without optional chaining.
    assert.equal(parseCheckoutSuccessBody('null'), null);
    assert.equal(parseCheckoutSuccessBody('[]'), null);
    assert.equal(parseCheckoutSuccessBody('[{"checkout_url":"https://x"}]'), null);
    assert.equal(parseCheckoutSuccessBody('42'), null);
    assert.equal(parseCheckoutSuccessBody('"https://checkout.example/s/abc"'), null);
  });

  it('distinguishes unparseable from parsed-but-missing-checkout_url', () => {
    // Both are contract violations, but they have different upstream
    // causes (transport corruption vs. a relay payload bug) and must not
    // collapse into one disposition.
    assert.equal(parseCheckoutSuccessBody('not json'), null);
    assert.deepEqual(parseCheckoutSuccessBody('{}'), {});
  });

  it('preserves anonymous_claim_token so the caller can still persist claim proof', () => {
    const body = parseCheckoutSuccessBody(
      '{"checkout_url":"https://checkout.dodopayments.com/s/a","anonymous_claim_token":"tok_live_123"}',
    );
    assert.equal(body?.anonymous_claim_token, 'tok_live_123');
  });
});

describe('snapshotUpstreamResponse — credential redaction', () => {
  it('redacts anonymous_claim_token so claim proof never reaches Sentry', () => {
    const snap = snapshotUpstreamResponse(
      makeResp(),
      '{"checkout_url":null,"anonymous_claim_token":"tok_live_SECRET123"}',
    );
    assert.ok(snap.bodySnippet, 'expected a body snippet');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET123'), 'token value leaked into snippet');
    assert.ok(snap.bodySnippet?.includes('[redacted]'), 'expected an explicit redaction marker');
    // The key must survive: knowing the field was present is diagnostic.
    assert.ok(snap.bodySnippet?.includes('anonymous_claim_token'));
  });

  it('redacts before truncating, so a token past the 200-char cap cannot leak', () => {
    // Order matters: truncate-then-redact would emit the first 200 chars
    // verbatim, and a token sitting at offset 40 would ship in full.
    const body = `{"anonymous_claim_token":"tok_live_SECRET123","pad":"${'x'.repeat(500)}"}`;
    const snap = snapshotUpstreamResponse(makeResp(), body);
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET123'));
    assert.equal(snap.bodySnippet?.length, 200);
  });

  it('redacts a truncated (unterminated) token string', () => {
    // A body cut mid-token still exposes the prefix, which is enough to
    // matter for a bearer-like credential.
    const snap = snapshotUpstreamResponse(makeResp(), '{"anonymous_claim_token":"tok_live_SECRET');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET'));
    assert.ok(snap.bodySnippet?.includes('[redacted]'));
  });

  it('tolerates whitespace around the JSON separator', () => {
    const snap = snapshotUpstreamResponse(makeResp(), '{"anonymous_claim_token"  :  "tok_live_SECRET"}');
    assert.ok(!snap.bodySnippet?.includes('tok_live_SECRET'));
  });

  it('leaves ordinary error bodies untouched (no regression to the RN diagnostic)', () => {
    // The !resp.ok path relies on seeing the real body; redaction must be
    // a no-op for anything that carries no claim token.
    const snap = snapshotUpstreamResponse(makeResp(), '{"error":"PRO_REQUIRED"}');
    assert.equal(snap.bodySnippet, '{"error":"PRO_REQUIRED"}');
    const html = snapshotUpstreamResponse(makeResp(), '<!DOCTYPE html><html>blocked</html>');
    assert.equal(html.bodySnippet, '<!DOCTYPE html><html>blocked</html>');
  });
});

describe('checkout.ts call-site pin', () => {
  // Count pin ONLY — the behavioural contract lives in the pure helpers
  // above. This exists solely to catch a future refactor reintroducing an
  // unguarded body read on this response, which no unit test of the
  // helpers can see.
  //
  // Deliberately anchored on `await resp.json(` rather than `resp.json(`:
  // both this file and the !ok branch discuss `resp.json()` in prose, and
  // a bare pattern counts those comments as violations. The awaited form
  // is the exact shape of the defect and does not appear in any comment.
  const source = readFileSync(
    fileURLToPath(new URL('../src/services/checkout.ts', import.meta.url)),
    'utf8',
  );

  it('never awaits resp.json() on the create-checkout response', () => {
    const matches = source.match(/await\s+resp\.json\s*\(/g) ?? [];
    assert.equal(
      matches.length,
      0,
      'awaiting resp.json() throws an engine-specific DOMException on a non-JSON 200 (WORLDMONITOR-XV) — read text() and parse defensively',
    );
  });

  it('reads both response bodies as text so upstream snapshots can be captured', () => {
    const matches = source.match(/await\s+resp\.text\s*\(/g) ?? [];
    assert.equal(matches.length, 2, 'expected one resp.text() on the !ok path and one on the success path');
  });
});
