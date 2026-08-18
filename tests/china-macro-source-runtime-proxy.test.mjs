import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  fetchText,
  requestBudget,
  shouldRetryViaProxy,
} from '../scripts/china-macro/source-runtime.mjs';

// A permissive policy for the fake host these tests fetch.
const POLICY = {
  origin: 'https://example.test',
  path: () => true,
};

const connectionFailure = () => Object.assign(new TypeError('fetch failed'), {
  cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
});

describe('china-macro proxy fallback (#6676 NBS egress block)', () => {
  describe('shouldRetryViaProxy', () => {
    it('retries a connection-level failure', () => {
      assert.equal(shouldRetryViaProxy(connectionFailure()), true);
    });

    it('never retries our own contract guard', () => {
      // The URL/redirect/size rejection is our decision, not a transport
      // problem; a second egress point would reach the same verdict.
      assert.equal(
        shouldRetryViaProxy({ code: 'SOURCE_CONTRACT_VIOLATION', publicReason: 'UNAPPROVED_URL' }),
        false,
      );
    });

    it('never retries a caller-initiated abort', () => {
      assert.equal(shouldRetryViaProxy(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
    });

    it('never retries a TLS chain failure', () => {
      // fetchText already treats these as permanent, and a different route hits
      // the same certificate.
      assert.equal(shouldRetryViaProxy({ code: 'SELF_SIGNED_CERT_IN_CHAIN' }), false);
      assert.equal(shouldRetryViaProxy(new Error('self signed certificate in chain')), false);
    });
  });

  describe('fetchText', () => {
    it('leaves the direct path untouched when no proxy is configured', async () => {
      let calls = 0;
      const fetchFn = async () => {
        calls += 1;
        return new Response('<html>ok</html>', { status: 200 });
      };
      const budget = requestBudget(4);
      const result = await fetchText(fetchFn, 'https://example.test/a', {
        policy: POLICY,
        budget,
      });
      assert.match(result.text, /ok/);
      assert.equal(calls, 1);
      assert.equal(budget.count, 1, 'a healthy direct fetch must not grow a hop or a request');
    });

    it('does not reach for the proxy when the publisher ANSWERS with an error status', async () => {
      // 403/429 is the publisher deciding, not a network block. Re-asking from a
      // second egress point would be evading that decision — the line this
      // fallback must not cross. fetch() does not throw on status, so the
      // request simply returns and no fallback is considered.
      let proxyUsed = false;
      const fetchFn = async () => new Response('denied', { status: 403 });
      const budget = requestBudget(4);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget,
          proxyUrl: 'http://user:pass@proxy.test:8080',
          onProxyFallback: () => { proxyUsed = true; },
        }),
        (err) => err?.status === 403,
        'a publisher status must propagate as itself',
      );
      assert.equal(proxyUsed, false, 'a publisher status must never be re-asked through the proxy');
    });

    it('surfaces the ORIGINAL direct error when the proxy also fails', async () => {
      // Reporting the proxy's failure would bury why the direct route failed,
      // which is the diagnosis that matters.
      const fetchFn = async () => { throw connectionFailure(); };
      const budget = requestBudget(8);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget,
          // Unparseable proxy config -> fetchThroughProxy returns null, so the
          // direct-path handling runs and rethrows the original.
          proxyUrl: 'not-a-proxy-url',
        }),
        (err) => /fetch failed/.test(String(err?.message)),
      );
    });

    it('a request budget still bounds the load a blocked publisher receives', async () => {
      // The fallback must not become an escape hatch from the budget: a proxied
      // retry reaches the publisher a second time and is counted, so a source
      // that fails every attempt still cannot be hammered.
      const fetchFn = async () => { throw connectionFailure(); };
      const budget = requestBudget(1);
      await assert.rejects(
        fetchText(fetchFn, 'https://example.test/a', {
          policy: POLICY,
          budget,
          proxyUrl: 'not-a-proxy-url',
        }),
      );
      assert.equal(budget.count, 1, 'the budget must still cap total requests');
    });
  });
});
