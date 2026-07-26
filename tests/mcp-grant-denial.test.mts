/**
 * #5622 — how the apex `/mcp-grant` consent page reacts to a handshake denial.
 *
 * The bug this pins: `api/internal/mcp-grant-{context,mint}` now answer an
 * unverifiable entitlement with a retryable 503 `TIER_VERIFICATION_UNAVAILABLE`,
 * but the page's error mapping was a `switch` with a terminal `default`. An
 * unknown code therefore rendered "could not be completed. Start over from your
 * MCP client." and destroyed the consent card — turning the one denial the user
 * could have simply clicked through into a dead end.
 *
 * The module under test is a zero-import leaf so it stays importable under
 * `tsx --test`: `src/mcp-grant-main.ts` boots Clerk and touches
 * window/localStorage at import time, which is why the decision was unreachable
 * from a test before it was extracted (same constraint as
 * tests/premium-denial.test.mts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classifyGrantDenial,
  grantErrorMessage,
} from '../src/services/mcp-grant-denial.ts';

describe('grantErrorMessage', () => {
  it('gives the retryable code copy that invites another attempt', () => {
    const msg = grantErrorMessage('TIER_VERIFICATION_UNAVAILABLE');
    assert.match(msg, /temporary/i);
    assert.match(msg, /try again/i);
    assert.doesNotMatch(
      msg,
      /Start over from your MCP client/,
      'the nonce is still valid — sending the user back to their client wastes it',
    );
  });

  it('keeps the terminal codes terminal', () => {
    assert.match(grantErrorMessage('INVALID_NONCE'), /expired or is invalid/);
    assert.match(grantErrorMessage('INSUFFICIENT_TIER'), /Pro subscription is required/);
    assert.match(grantErrorMessage('UNKNOWN_CLIENT'), /no longer registered/);
    assert.match(grantErrorMessage('INVALID_REDIRECT_URI'), /not allowed/);
  });

  it('covers NONCE_CLAIMED_BY_OTHER_USER rather than falling through to the generic copy', () => {
    // The anti-hijack 403 (F2) existed before this module and was NOT in the
    // page's switch, so a victim saw generic copy for a security-relevant state.
    const msg = grantErrorMessage('NONCE_CLAIMED_BY_OTHER_USER');
    assert.match(msg, /another account/i);
    assert.notEqual(msg, grantErrorMessage('SOMETHING_ELSE'));
  });

  it('falls back for an unknown or absent code', () => {
    const fallback = grantErrorMessage(undefined);
    assert.match(fallback, /could not be completed/);
    assert.equal(grantErrorMessage('WHATEVER_NEW_CODE'), fallback);
    assert.equal(grantErrorMessage(''), fallback);
  });
});

describe('classifyGrantDenial', () => {
  it('#5622: the retryable entitlement code keeps the consent card', () => {
    assert.deepEqual(
      classifyGrantDenial(503, 'TIER_VERIFICATION_UNAVAILABLE').action,
      'retryable',
    );
  });

  it('a Redis transport 503 is retryable too — it always read that way, it just could not say so', () => {
    assert.equal(classifyGrantDenial(503, 'SERVICE_UNAVAILABLE').action, 'retryable');
  });

  it('a 401 is sign-in regardless of body, matching the page it replaced', () => {
    for (const code of [undefined, 'UNAUTHENTICATED', 'TIER_VERIFICATION_UNAVAILABLE']) {
      assert.equal(classifyGrantDenial(401, code).action, 'sign_in');
    }
  });

  it('every terminal code stays terminal', () => {
    for (const code of [
      'INVALID_NONCE',
      'UNKNOWN_CLIENT',
      'INVALID_REDIRECT_URI',
      'INSUFFICIENT_TIER',
      'NONCE_CLAIMED_BY_OTHER_USER',
      'CONFIGURATION_ERROR',
    ]) {
      assert.equal(
        classifyGrantDenial(403, code).action,
        'terminal',
        `${code} must not become a retry loop`,
      );
    }
  });

  it('a bare 503 with no readable code is terminal — an intermediary is not the handshake', () => {
    // Retrying on status alone would loop against a CDN/WAF page forever. The
    // retryable set is an explicit allowlist for exactly this reason.
    assert.equal(classifyGrantDenial(503, undefined).action, 'terminal');
    assert.equal(classifyGrantDenial(503, 'Bad Gateway').action, 'terminal');
  });

  it('a confirmed lapse is terminal even though it arrives on the same gate', () => {
    // The server keeps INSUFFICIENT_TIER for a provider-confirmed lapse; the page
    // must not retry it just because a X-Billing-Verification header is present.
    assert.equal(classifyGrantDenial(403, 'INSUFFICIENT_TIER').action, 'terminal');
  });

  it('the verdict always carries the message for the same code', () => {
    for (const [status, code] of [[503, 'TIER_VERIFICATION_UNAVAILABLE'], [403, 'INVALID_NONCE'], [401, undefined]] as const) {
      assert.equal(classifyGrantDenial(status, code).message, grantErrorMessage(code));
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: call-site COUNT pins only
// ---------------------------------------------------------------------------

/**
 * The page builds its DOM against real elements, so there is no jsdom here to
 * drive it end-to-end. Deliberately NOT a proximity regex on the retry branch —
 * that shape has been demonstrated to pass with the bug restored verbatim
 * (memory: source-regex wiring guards false-pass). What is pinned instead is
 * structural and countable: the page routes both fetches through the classifier
 * and no longer holds its own copy of the mapping.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pageSource = readFileSync(resolve(root, 'src/mcp-grant-main.ts'), 'utf8');

describe('mcp-grant page routes denials through the shared classifier', () => {
  it('classifies both the context load and the mint click', () => {
    const calls = [...pageSource.matchAll(/classifyGrantDenial\(/g)];
    assert.equal(
      calls.length,
      2,
      'expected exactly two call sites — loadContext and onAuthorizeClick. '
      + 'A third means a new fetch, a missing one means a path went unclassified.',
    );
  });

  it('no longer carries its own error-code switch', () => {
    assert.doesNotMatch(
      pageSource,
      /function errorCodeToMessage/,
      'a second copy of the mapping is how the two drift',
    );
  });

  it('re-enables the Authorize button through one shared helper', () => {
    // A retryable denial is worthless if the button stays disabled. Counting the
    // raw re-enable pairs catches a future branch that forgets to call it.
    assert.equal(
      [...pageSource.matchAll(/btn\.disabled = false/g)].length,
      1,
      'button re-enabling must stay in the single `reenable` helper',
    );
    assert.ok(
      [...pageSource.matchAll(/reenable\(\)/g)].length >= 4,
      'every non-navigating exit from onAuthorizeClick must hand the button back',
    );
  });
});
