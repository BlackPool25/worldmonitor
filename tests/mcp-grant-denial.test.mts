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
  retryableGrantDelayMs,
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

  it('does not resolve inherited object properties as messages', () => {
    // `code` comes from a server JSON body, so a plain index lookup would return
    // Object.prototype members — a `code` of "toString" yielded a Function, which
    // renders as source text in the error view.
    for (const code of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const msg = grantErrorMessage(code);
      assert.equal(typeof msg, 'string', `${code} must not resolve to a non-string`);
      assert.equal(msg, grantErrorMessage(undefined), `${code} must take the fallback`);
    }
  });
});

describe('retryableGrantDelayMs', () => {
  it('honors the advertised delay', () => {
    assert.equal(retryableGrantDelayMs('5'), 5_000);
    assert.equal(retryableGrantDelayMs('1'), 1_000);
    assert.equal(retryableGrantDelayMs('22'), 22_000);
  });

  it('falls back to the server default for a missing or unusable header', () => {
    // RFC 9110 also permits an HTTP-date, which Number() makes NaN — the default
    // is the right answer there rather than re-enabling instantly.
    for (const header of [null, '', 'soon', '0', '-3', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      assert.equal(
        retryableGrantDelayMs(header),
        5_000,
        `Retry-After ${JSON.stringify(header)} must fall back to the 5s default`,
      );
    }
  });

  it('clamps to the server ceiling rather than disabling the button indefinitely', () => {
    assert.equal(retryableGrantDelayMs('60'), 60_000);
    assert.equal(retryableGrantDelayMs('3600'), 60_000);
  });

  it('never returns 0 — re-enabling instantly walks into the negative cache', () => {
    for (const header of [null, '0', '-1', '0.1', 'nonsense']) {
      assert.ok(
        retryableGrantDelayMs(header) > 0,
        `Retry-After ${JSON.stringify(header)} must still impose a wait`,
      );
    }
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
    // A retryable denial is worthless if the button stays disabled.
    assert.equal(
      [...pageSource.matchAll(/btn\.disabled = false/g)].length,
      1,
      'button re-enabling must stay in the single `reenable` helper',
    );
    // Three immediate call sites (network-error catch, sign_in, unparseable mint
    // response) plus one DEFERRED hand-back for the retryable branch, which waits
    // out Retry-After first. Counting both forms keeps a future branch that
    // forgets either one from passing.
    const immediate = [...pageSource.matchAll(/reenable\(\)/g)].length;
    const deferred = [...pageSource.matchAll(/setTimeout\(reenable\b/g)].length;
    assert.equal(immediate, 3, 'the three immediate exits must hand the button back');
    assert.equal(deferred, 1, 'the retryable exit must hand it back after the advertised delay');
  });

  /**
   * WHAT THESE PINS DO NOT COVER — stated so nobody mistakes green for covered.
   *
   * They assert occurrence counts, not the verdict -> DOM mapping. Swapping the
   * bodies of the `retryable` and `terminal` branches in onAuthorizeClick would
   * leave every count identical and every pin green, while the user got a torn-down
   * page for a transient blip and a stuck consent card for a dead nonce.
   *
   * That mapping is genuinely uncovered: the page manipulates real elements, this
   * repo has no jsdom, and there is no e2e spec for /mcp-grant. The decision it
   * routes on IS unit-tested (classifyGrantDenial above), so what is missing is
   * only the wiring — which is exactly the class a regex cannot honestly pin
   * (memory: source-regex wiring guards false-pass). Tracked in #5654.
   */
  /**
   * Greptile flagged this on the PR: a retryable denial on the CONTEXT load went
   * to `showErrorView`, which has no retry control — so a transient blip at page
   * load stranded the user on a dead end even though the nonce was untouched (the
   * context load is a GET; only the mint consumes it). The mint path already
   * recovered properly, so the two were asymmetric.
   *
   * Pinned structurally because the DOM behaviour itself is unreachable here
   * (#5654): the context path must schedule a bounded retry, and its retry budget
   * must be guarded so a Clerk-driven re-entry cannot stack timers.
   */
  it('retries a retryable context load instead of stranding the user on the error view', () => {
    assert.match(
      pageSource,
      /verdict\.action === 'retryable' && !contextRetryUsed/,
      'the context load must have a retryable branch that does not fall to showErrorView',
    );
    assert.match(
      pageSource,
      /contextRetryUsed = true/,
      'the context retry must be bounded — an unguarded timer stacks on Clerk re-entry',
    );
    assert.equal(
      [...pageSource.matchAll(/void loadContext\(nonce\)/g)].length,
      1,
      'exactly one self-retry call site; a second is an unbounded reload loop',
    );
  });

  it('documents the uncovered verdict-to-DOM wiring rather than implying it is pinned', () => {
    // A canary, not a guard: if the page stops routing through the classifier at
    // all, the count pin above already fails. This exists so the limitation is
    // visible in the suite output rather than only in a comment.
    assert.match(pageSource, /verdict\.action === 'retryable'/);
    assert.match(pageSource, /showErrorView\(verdict\.message\)/);
  });
});
