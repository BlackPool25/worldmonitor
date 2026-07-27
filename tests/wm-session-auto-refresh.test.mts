// Tests for the auto-refresh layers added to wm-session.ts:
//
//   Layer 1 — periodic refresh:
//     - setInterval-driven mint while the document is visible.
//     - Skips when document.visibilityState !== 'visible'.
//     - Skips when the cached token is still fresh.
//     - visibilitychange listener mints when the tab becomes visible
//       and the cached token is expired.
//
//   Layer 2 — refresh-on-401 inside the fetch interceptor:
//     - A 401 from the API triggers ensureWmSession() and a single replay.
//     - Premium-RPC paths short-circuit BEFORE the wms_ branch — no retry.
//     - When the caller already supplied Authorization, the wms_ branch
//       is skipped — no retry.
//     - If the retry also 401s, the second response is returned (no infinite loop).
//
// Why both layers:
//   Periodic refresh catches the common case (tab open overnight, laptop wake).
//   Refresh-on-401 is belt-and-suspenders for HMAC-key rotation incidents and
//   any edge case the periodic check missed (e.g. server-side cache flap).
//
// The interceptor lives on a module-scoped flag (`interceptorInstalled`), so
// we install it ONCE here and drive behaviour by swapping the captured
// `original` fetch's responses per test.

import assert from 'node:assert/strict';
import { describe, it, before, beforeEach, after } from 'node:test';

// ---------------------------------------------------------------------------
// Stub browser globals BEFORE the wm-session module is imported. The module
// calls `typeof window === 'undefined'` to gate installation, and reads
// `document.visibilityState` from inside the periodic-refresh closures.
// ---------------------------------------------------------------------------

interface StubDocument {
  visibilityState: 'visible' | 'hidden';
  addEventListener: (type: string, listener: () => void) => void;
  __listeners: Map<string, Array<() => void>>;
  __dispatch: (type: string) => void;
}

const stubDocument: StubDocument = {
  visibilityState: 'visible',
  __listeners: new Map(),
  addEventListener(type, listener) {
    const arr = stubDocument.__listeners.get(type) ?? [];
    arr.push(listener);
    stubDocument.__listeners.set(type, arr);
  },
  __dispatch(type) {
    const arr = stubDocument.__listeners.get(type) ?? [];
    for (const fn of arr) fn();
  },
};

// Stash the most recently registered setInterval callback so tests can fire
// it synchronously without waiting wall-clock time.
let lastIntervalCallback: (() => void) | null = null;
let lastIntervalMs = 0;
const stubSetInterval = ((cb: () => void, ms: number) => {
  lastIntervalCallback = cb;
  lastIntervalMs = ms;
  // Return a fake handle; we never call clearInterval in this test.
  return 1 as unknown as ReturnType<typeof setInterval>;
}) as typeof setInterval;

// Capture the underlying fetch so the interceptor wraps THIS function. Tests
// reassign `currentFetchHandler` to swap responses per scenario.
type FetchHandler = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let currentFetchHandler: FetchHandler = () => Promise.resolve(new Response('default', { status: 200 }));
const stubFetch: typeof fetch = ((input: RequestInfo | URL, init?: RequestInit) => currentFetchHandler(input, init)) as typeof fetch;

// In-memory sessionStorage so loadFromStorage / saveToStorage don't blow up.
const memoryStorage = new Map<string, string>();
const stubSessionStorage: Storage = {
  get length() { return memoryStorage.size; },
  clear() { memoryStorage.clear(); },
  getItem(key) { return memoryStorage.has(key) ? memoryStorage.get(key)! : null; },
  key(i) { return Array.from(memoryStorage.keys())[i] ?? null; },
  removeItem(key) { memoryStorage.delete(key); },
  setItem(key, value) { memoryStorage.set(key, String(value)); },
};

// localStorage stub — touched by src/config/variant.ts during module import.
const memoryLocalStorage = new Map<string, string>();
const stubLocalStorage: Storage = {
  get length() { return memoryLocalStorage.size; },
  clear() { memoryLocalStorage.clear(); },
  getItem(key) { return memoryLocalStorage.has(key) ? memoryLocalStorage.get(key)! : null; },
  key(i) { return Array.from(memoryLocalStorage.keys())[i] ?? null; },
  removeItem(key) { memoryLocalStorage.delete(key); },
  setItem(key, value) { memoryLocalStorage.set(key, String(value)); },
};

// Inject all globals before import. Cast through unknown — node doesn't ship
// a Window type and we only need the touched fields.
(globalThis as unknown as { window: unknown }).window = globalThis;
(globalThis as unknown as { document: StubDocument }).document = stubDocument;
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = stubSessionStorage;
(globalThis as unknown as { localStorage: Storage }).localStorage = stubLocalStorage;
(globalThis as unknown as { setInterval: typeof setInterval }).setInterval = stubSetInterval;
(globalThis as unknown as { fetch: typeof fetch }).fetch = stubFetch;
// `location` must include `hostname` because src/config/variant.ts (loaded
// transitively via runtime.ts → wm-session.ts) reads `location.hostname` at
// module-eval time and calls `.startsWith(...)` on it.
(globalThis as unknown as { location: Location }).location = {
  href: 'https://worldmonitor.app/',
  origin: 'https://worldmonitor.app',
  hostname: 'worldmonitor.app',
  protocol: 'https:',
  host: 'worldmonitor.app',
} as Location;

// ---------------------------------------------------------------------------
// Now import the module and install the interceptor exactly once.
// ---------------------------------------------------------------------------

let mod: typeof import('../src/services/wm-session.ts');
let wrappedFetch: typeof fetch;

before(async () => {
  mod = await import('../src/services/wm-session.ts');
  mod.installWmSessionFetchInterceptor();
  // After install, globalThis.fetch is the wrapper.
  wrappedFetch = (globalThis as unknown as { fetch: typeof fetch }).fetch;
  assert.notEqual(wrappedFetch, stubFetch, 'interceptor should have replaced globalThis.fetch');
  assert.ok(lastIntervalCallback, 'install should register a setInterval callback');
  assert.equal(lastIntervalMs, 30 * 60 * 1000, 'interval should fire every 30 minutes');
});

beforeEach(() => {
  memoryStorage.clear();
  stubDocument.visibilityState = 'visible';
  // Reset the module's cached/inflight state so each test starts from a
  // clean slate. Without this, a `cached` token from a prior test (set via
  // ensureWmSession's storage path) would short-circuit the next test's
  // mint attempt.
  mod.__resetWmSessionForTests();
  // Default handler: no API endpoint configured per test.
  currentFetchHandler = () => Promise.resolve(new Response('unhandled', { status: 500 }));
});

after(() => {
  // Best-effort cleanup so a follow-on test file doesn't see our globals.
  // node:test runs files in their own process so this is mostly defensive.
  memoryStorage.clear();
});

// Helpers --------------------------------------------------------------------

function setStoredSessionExp(_token: string, expMs: number): void {
  memoryStorage.set('wm-session-exp', JSON.stringify({ exp: expMs }));
}

// Fresh = exp far in the future. Expired = exp in the past (or within the
// 5-minute REFRESH_MARGIN_MS window — same effective behaviour for isFresh).
const FAR_FUTURE = Date.now() + 12 * 60 * 60 * 1000;
const PAST = Date.now() - 1000;

// Force the in-memory `cached` state by calling the module's API. ensureWmSession
// reads sessionStorage when cached is null — set the storage and prime via
// getWmSessionToken doesn't help because that only reads cached. We rely on
// ensureWmSession's storage path to populate `cached`.
async function primeCachedFromStorage(): Promise<void> {
  await mod.ensureWmSession();
}

// ---------------------------------------------------------------------------
// Layer 1 — periodic refresh
// ---------------------------------------------------------------------------

describe('wm-session periodic refresh (Layer 1)', () => {
  it('skips the periodic mint when document is hidden', async () => {
    // Cached token is expired so the interval would otherwise mint.
    setStoredSessionExp('wms_old', PAST);
    await primeCachedFromStorage(); // cached stays null because PAST is not fresh

    stubDocument.visibilityState = 'hidden';

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    // Fire the periodic callback. Should be a no-op because hidden.
    lastIntervalCallback?.();
    // Allow any microtasks/promises to settle.
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'hidden tab must NOT trigger a mint');
  });

  it('skips the periodic mint when the cached token is still fresh', async () => {
    setStoredSessionExp('wms_fresh', FAR_FUTURE);
    await primeCachedFromStorage(); // primes `cached` with fresh value

    stubDocument.visibilityState = 'visible';

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    lastIntervalCallback?.();
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'fresh cached token must NOT trigger a mint');
  });

  it('visibilitychange handler mints when token is expired and tab becomes visible', async () => {
    // beforeEach() reset cached/inflight + cleared storage, so the freshness
    // gate inside the listener evaluates to false and the mint runs.
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    stubDocument.visibilityState = 'visible';
    stubDocument.__dispatch('visibilitychange');
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 1, 'expired cache + visible tab must mint once via visibilitychange');
  });

  it('visibilitychange handler does NOT mint when the cached token is fresh', async () => {
    setStoredSessionExp('wms_fresh_visible', FAR_FUTURE);
    await primeCachedFromStorage(); // primes cached with fresh token

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    stubDocument.visibilityState = 'visible';
    stubDocument.__dispatch('visibilitychange');
    await new Promise((r) => setImmediate(r));

    assert.equal(mintCalls, 0, 'fresh cached token must short-circuit the visibility handler');
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — refresh-on-401
// ---------------------------------------------------------------------------

describe('wm-session refresh-on-401 (Layer 2)', () => {
  it('retries an API 401 with a freshly-minted token', async () => {
    // Prime cached with an expiry for a cookie the server will reject.
    setStoredSessionExp('wms_stale', FAR_FUTURE);
    await primeCachedFromStorage();
    assert.equal(mod.getWmSessionToken(), null);

    let bootstrapAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        assert.equal(init?.credentials, 'include');
        return Promise.resolve(new Response(bootstrapAttempts === 1 ? 'expired' : 'ok', {
          status: bootstrapAttempts === 1 ? 401 : 200,
        }));
      }
      return Promise.resolve(new Response('unhandled', { status: 500 }));
    };

    const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    assert.equal(resp.status, 200, 'final response should be the retried 200');
    assert.equal(bootstrapAttempts, 2, 'bootstrap should be called twice (initial 401 + retry)');
    assert.equal(mintCalls, 1, 'one mint between the 401 and the retry');
  });

  it('does NOT retry when the path is in PREMIUM_RPC_PATHS', async () => {
    setStoredSessionExp('wms_anything', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      return Promise.resolve(new Response('forbidden', { status: 401 }));
    };

    // Pick any premium path — analyze-stock is one.
    const resp = await wrappedFetch('https://api.worldmonitor.app/api/market/v1/analyze-stock');
    assert.equal(resp.status, 401);
    assert.equal(attempts, 1, 'premium path must NOT trigger a retry inside this interceptor');
    assert.equal(mintCalls, 0, 'premium path must NOT mint a wms_ token (the dedicated injector handles it)');
  });

  it('does NOT retry when the caller supplied Authorization', async () => {
    setStoredSessionExp('wms_anything', FAR_FUTURE);
    await primeCachedFromStorage();

    let attempts = 0;
    let mintCalls = 0;
    let lastSeenAuth: string | null = null;
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      attempts += 1;
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      lastSeenAuth = headers.get('Authorization');
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap', {
      headers: { Authorization: 'Bearer caller-supplied-jwt' },
    });
    assert.equal(resp.status, 401);
    assert.equal(attempts, 1, 'caller-supplied Authorization must NOT be retried by the wms_ interceptor');
    assert.equal(mintCalls, 0, 'caller-supplied Authorization must NOT trigger a wms_ mint');
    assert.equal(lastSeenAuth, 'Bearer caller-supplied-jwt', 'caller Authorization must pass through untouched');
  });

  it('suppresses later anonymous API calls when a refreshed session is still rejected', async () => {
    // No cached expiry and no stored expiry. Server 401s, the interceptor
    // mints a fresh cookie, replays with credentials, server 401s again.
    // The second 401 must be returned as-is (no further retry); later calls
    // are suppressed by the dead-session cooldown.
    //
    // The cookie-cannot-be-delivered failure this models rejects EVERY route,
    // so two distinct routes must fail before the global cooldown engages
    // (#5674 — one route's denial is not evidence about the session).
    memoryStorage.clear();

    let apiAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        // Mint always succeeds with a fresh token; the server still rejects
        // every gated route to simulate HMAC-key rotation lag.
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      apiAttempts += 1;
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'the failed recovery returns the server response');

      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the second distinct route also returns the server response');

      const suppressed = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(suppressed.status, 503, 'the dead session suppresses later gated calls during the cooldown');
      assert.equal(suppressed.headers.get('x-wm-session-degraded'), '1');
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(apiAttempts, 4, 'one retry per corroborating route — later calls must not reach the API');
    assert.equal(mintCalls, 3, 'initial preflight mint plus one recovery mint per route; no later remints');
    assert.deepEqual(warnings, [
      '[wm-session] refreshed HttpOnly session cookie was still rejected; suppressing anonymous API calls briefly',
    ]);
  });

  it('forwards only explicit credential-less public tier reads during the dead-session cooldown', async () => {
    memoryStorage.clear();

    const forwarded: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
    currentFetchHandler = (input, init) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
      forwarded.push({ url, credentials });
      if (url.includes('public=1')) return Promise.resolve(new Response('public-tier', { status: 200 }));
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const failed = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(failed.status, 401, 'failed recovery returns the server response');
      // Two distinct routes must fail before the global cooldown engages (#5674).
      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the corroborating failure enters the dead-session cooldown');

      const fast = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
        credentials: 'omit',
      });
      assert.equal(fast.status, 200, 'string input should reach the public tier while the session is dead');

      const slowRequest = new Request('https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', {
        credentials: 'omit',
      });
      const slow = await wrappedFetch(slowRequest);
      assert.equal(slow.status, 200, 'Request input should preserve its effective omit credentials');

      const digest = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', {
        credentials: 'omit',
      });
      assert.equal(digest.status, 200, 'public digest should bypass dead-session suppression');

      const displacement = await wrappedFetch('https://api.worldmonitor.app/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1', {
        credentials: 'omit',
      });
      assert.equal(displacement.status, 200, 'public displacement should bypass dead-session suppression');

      const missingPublicFlag = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast', {
        credentials: 'omit',
      });
      assert.equal(missingPublicFlag.status, 503, 'ordinary tier reads must remain session-gated');

      const credentialed = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', {
        credentials: 'include',
      });
      assert.equal(credentialed.status, 503, 'credentialed tier reads must remain session-gated');
    } finally {
      console.warn = originalWarn;
    }

    assert.deepEqual(
      forwarded.slice(-4),
      [
        { url: 'https://api.worldmonitor.app/api/bootstrap?tier=fast&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/bootstrap?public=1&tier=slow', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/news/v1/list-feed-digest?variant=full&lang=en&public=1', credentials: 'omit' },
        { url: 'https://api.worldmonitor.app/api/displacement/v1/get-displacement-summary?flow_limit=50&public=1', credentials: 'omit' },
      ],
      'only exact credential-less public data requests should reach native fetch during cooldown',
    );
  });

  it('captures ONE wm_session_dead Sentry warning per degraded episode, not one per suppressed call', async () => {
    // reportServerError (premium-fetch.ts) deliberately skips the synthetic
    // X-Wm-Session-Degraded 503s, so this once-per-episode capture is the
    // only remote signal that anonymous browsing is degraded (#5245).
    memoryStorage.clear();

    const { captures } = collectSentry();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      // Two distinct routes must fail before the episode starts (#5674).
      await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      // Later calls are suppressed by the cooldown — no additional captures.
      const s1 = await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      const s2 = await wrappedFetch('https://api.worldmonitor.app/api/supply-chain/v1/get-shipping-stress');
      assert.equal(s1.status, 503);
      assert.equal(s2.status, 503);
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one Sentry capture per dead-session episode');
    assert.equal(dead[0].msg, 'wm-session dead: anonymous API calls suppressed');
    assert.equal(dead[0].ctx.level, 'warning');
    assert.equal(dead[0].ctx.tags?.reason, 'retry_401');
    assert.equal(dead[0].ctx.tags?.route, '/api/infrastructure/v1/get-cable-health');
  });

  it('tags wm_session_dead as mint_failed when recovery cannot mint a session', async () => {
    memoryStorage.clear();

    const captures: Array<{ msg: string; ctx: { level?: string; tags?: Record<string, string> } }> = [];
    mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
      fn({ captureMessage: (msg: string, ctx: { level?: string; tags?: Record<string, string> }) => { captures.push({ msg, ctx }); } });
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response('mint unavailable', { status: 503 }));
      }
      return Promise.resolve(new Response('unauthorized', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'failed recovery returns the original server response');
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(mintCalls, 2, 'initial preflight and recovery mint both fail');
    assert.equal(captures.length, 1, 'the failed mint starts one degraded episode');
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_dead');
    assert.equal(captures[0].ctx.tags?.reason, 'mint_failed');
  });

  it('a throwing Sentry enqueue never skips the degraded-event dispatch nor rejects the recovery return', async () => {
    // greptile P2 on PR #5247: the capture sits upstream of the
    // WM_SESSION_DEGRADED_EVENT dispatch AND inside the interceptor's 401
    // recovery path — an unguarded throw would both hide the UI toast and
    // turn the wrapped fetch into a rejection instead of returning the 401.
    memoryStorage.clear();
    mod.__setWmSessionSentryEnqueueForTests((() => {
      throw new Error('sdk exploded');
    }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);

    // window === globalThis in this harness, and Node's main-thread
    // globalThis is not an EventTarget — stub dispatchEvent so the module's
    // `typeof window.dispatchEvent === 'function'` guard takes the dispatch
    // branch and we can observe it.
    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(resp.status, 401, 'recovery must return the server 401, not reject');
      // A throwing enqueue must not break the per-route report either, and the
      // corroborating route is what reaches the degraded-event dispatch (#5674).
      const corroborating = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
      assert.equal(corroborating.status, 401, 'the corroborating recovery must also return, not reject');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 1, 'degraded event must still dispatch when telemetry throws');
  });

  it('single-flights the MINT across a concurrent 401 burst, and lets the burst corroborate itself', async () => {
    // The invariant that matters is the MINT count: one shared mint for the
    // whole burst, never one per caller (#5219 amplification).
    //
    // Each follower does re-send once with the freshly minted cookie, and that
    // is load-bearing rather than waste (#5674): a dashboard fires its panels
    // together, so the cookie-cannot-be-delivered failure arrives as ONE
    // concurrent burst. If followers returned the leader's verdict without
    // testing their own route, the burst would contribute a single strike and
    // could never reach SESSION_DEAD_ROUTE_QUORUM — the global cooldown would be
    // deferred to a later sequential round. Verifying its own route is also what
    // keeps this honest in the other direction: a follower whose route is
    // actually healthy gets a 200 and clears the corroboration evidence.
    memoryStorage.clear();
    let gatedAttempts = 0;
    let mintCalls = 0;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      gatedAttempts += 1;
      return Promise.resolve(new Response('still-rejected', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const responses = await Promise.all([
        wrappedFetch('https://api.worldmonitor.app/api/bootstrap'),
        wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses'),
        wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health'),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [401, 401, 401]);
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(mintCalls, 2, 'all callers share the initial mint and one recovery mint');
    assert.equal(
      gatedAttempts, 6,
      'three initial 401s, the leader’s verifier retry, and one fresh-cookie re-send per follower — no extra MINTS',
    );
    // The behavioural delta this burst exists to pin: three distinct routes all
    // rejected a demonstrably fresh cookie, which is the #5219/#5251 failure, so
    // the quorum is satisfied by the burst itself rather than a later round.
    assert.equal(
      mod.isWmSessionDead(), true,
      'a concurrent burst of distinct routes rejecting a fresh cookie must reach the quorum',
    );
  });

  it('replays a delayed stale 401 after another caller has refreshed the session', async () => {
    memoryStorage.clear();
    let mintCalls = 0;
    let bootstrapAttempts = 0;
    let cableAttempts = 0;
    let releaseDelayed401: (() => void) | null = null;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mintCalls += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        return Promise.resolve(new Response(bootstrapAttempts === 1 ? 'stale' : 'recovered', {
          status: bootstrapAttempts === 1 ? 401 : 200,
        }));
      }
      cableAttempts += 1;
      if (cableAttempts === 1) {
        return new Promise((resolve) => {
          releaseDelayed401 = () => resolve(new Response('stale', { status: 401 }));
        });
      }
      return Promise.resolve(new Response('recovered', { status: 200 }));
    };

    const first = wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
    const delayed = wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/get-cable-health');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(releaseDelayed401, 'the second request should already be awaiting its stale response');
    releaseDelayed401?.();

    const [firstResponse, delayedResponse] = await Promise.all([first, delayed]);
    assert.equal(firstResponse.status, 200);
    assert.equal(delayedResponse.status, 200);
    assert.equal(mintCalls, 2, 'one initial mint plus one recovery mint');
    assert.equal(bootstrapAttempts, 2, 'the first caller verifies the reminted cookie once');
    assert.equal(cableAttempts, 2, 'the delayed stale response replays without invalidating the fresh session');
  });
});

// ---------------------------------------------------------------------------
// #5674 — one route's denial must not black out the whole anonymous session
// ---------------------------------------------------------------------------
//
// WORLDMONITOR-WG regrew 34x (traffic-normalized) after #5516 with 97% of
// episodes tagged `retry_401`. Server-side telemetry (wm_api_usage, Axiom)
// for 12 sampled affected browsers showed 11 of them emitting ZERO 401s for
// the entire episode, and sibling routes on the same tab returning 200 in the
// same second the client declared the session dead. The cookie was healthy;
// the diagnosis was not.
//
// Two things are pinned here:
//   1. The offending route is now aggregable (`route` tag + manual breadcrumb),
//      because neither Sentry's fetch instrumentation nor the gateway's own
//      telemetry can see the 401 that causes the episode.
//   2. A lone route may suppress only itself. Blacking out every anonymous
//      call still requires corroboration from a second distinct route — which
//      the original "browser cannot deliver the cookie" failure (#5219/#5251)
//      always produces, since it makes EVERY route 401.

type Capture = { msg: string; ctx: { level?: string; tags?: Record<string, string> } };
type Crumb = { category?: string; message?: string; data?: Record<string, string> };

function collectSentry(): { captures: Capture[]; crumbs: Crumb[]; order: string[] } {
  const captures: Capture[] = [];
  const crumbs: Crumb[] = [];
  const order: string[] = [];
  mod.__setWmSessionSentryEnqueueForTests(((fn: (s: unknown) => void) => {
    fn({
      captureMessage: (msg: string, ctx: Capture['ctx']) => {
        captures.push({ msg, ctx });
        order.push(`capture:${ctx.tags?.kind ?? '?'}`);
      },
      addBreadcrumb: (crumb: Crumb) => {
        crumbs.push(crumb);
        order.push(`crumb:${crumb.message ?? '?'}`);
      },
    });
  }) as Parameters<typeof mod.__setWmSessionSentryEnqueueForTests>[0]);
  return { captures, crumbs, order };
}

/** Mint always succeeds; only the listed routes 401. */
function handlerRejecting(rejected: string[], counters: { mints: number; hits: Map<string, number> }): FetchHandler {
  return (input) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    if (url.includes('/api/wm-session')) {
      counters.mints += 1;
      return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
    counters.hits.set(url, (counters.hits.get(url) ?? 0) + 1);
    const denied = rejected.some((route) => url.includes(route));
    return Promise.resolve(new Response(denied ? 'denied' : 'ok', { status: denied ? 401 : 200 }));
  };
}

describe('wm-session route-scoped recovery failures (#5674)', () => {
  it('reduces a pathname to a bounded, aggregable route tag', () => {
    assert.equal(
      mod.toRouteTag('/api/intelligence/v1/get-risk-scores'),
      '/api/intelligence/v1/get-risk-scores',
      'a real static API route is preserved verbatim so it can be read off the tag',
    );
    assert.equal(mod.toRouteTag('/api/bootstrap'), '/api/bootstrap');
    assert.equal(mod.toRouteTag('/api/v2/shipping/route-intelligence'), '/api/v2/shipping/route-intelligence');

    // Dynamic segments are caller-controlled — collapse them or the tag's
    // cardinality is unbounded and Sentry stops aggregating.
    assert.equal(mod.toRouteTag('/api/v2/shipping/webhooks/sub_8f2a11'), '/api/v2/shipping/webhooks/:id');
    assert.equal(mod.toRouteTag('/api/user/prefs/9d4c7b2e'), '/api/user/prefs/:id');
    assert.equal(mod.toRouteTag('/api/thing/' + 'x'.repeat(64)), '/api/thing/:id');

    // Real RPC method names embed small numbers. Collapsing these would throw
    // away the only thing the tag exists to deliver (#5674 AC#1) while looking
    // exactly like a legitimately-collapsed dynamic route family, so a triager
    // would read `/api/climate/v1/:id` and dismiss it as unresolvable noise.
    assert.equal(mod.toRouteTag('/api/climate/v1/get-co2-monitoring'), '/api/climate/v1/get-co2-monitoring');
    assert.equal(mod.toRouteTag('/api/health/v1/get-pm25-exposure'), '/api/health/v1/get-pm25-exposure');
    assert.equal(mod.toRouteTag('/api/economic/v1/get-g20-outlook'), '/api/economic/v1/get-g20-outlook');
    // ...but a segment whose word STARTS with a digit, or that runs letters and
    // digits together at id length, is an identifier and must still collapse.
    assert.equal(mod.toRouteTag('/api/brief/2026-07-27'), '/api/brief/:id');
    assert.equal(mod.toRouteTag('/api/thing/a1b2c3d4e5'), '/api/thing/:id');

    // The longest real route name in the registered table (33 chars) must
    // survive verbatim. A 32-char per-segment cap collapsed this live panel
    // route to `/api/supply-chain/v1/:id`, which is worse than no tag: it reads
    // as a legitimately-collapsed dynamic family, so a triager reading the
    // census would dismiss the one route it was supposed to name.
    assert.equal(
      mod.toRouteTag('/api/supply-chain/v1/get-china-corridor-control-towers'),
      '/api/supply-chain/v1/get-china-corridor-control-towers',
      'the longest real route name must not be mistaken for an id',
    );
    // Next-longest sits at exactly 32, i.e. one character from the old cap.
    assert.equal(
      mod.toRouteTag('/api/consumer-prices/v1/get-consumer-price-basket-series'),
      '/api/consumer-prices/v1/get-consumer-price-basket-series',
    );

    // Non-API paths never reach the wms_ branch; bucket rather than leak.
    assert.equal(mod.toRouteTag('/dashboard'), 'other');
    assert.equal(mod.toRouteTag(''), 'other');

    // Segment cap: many short segments are truncated by MAX_ROUTE_TAG_SEGMENTS.
    const many = mod.toRouteTag(`/api/${Array.from({ length: 40 }, () => 'segment').join('/')}`);
    assert.ok(many.length <= 96, `route tag must stay bounded, got ${many.length}`);
    assert.equal(many.split('/').filter(Boolean).length, 8, 'segment cap applies');
    // Length cap: 8 legal-but-long segments clear the segment cap, so this is
    // the case that actually exercises MAX_ROUTE_TAG_LENGTH. The previous
    // 40-short-segment input collapsed to 60 chars and never reached the slice.
    const wide = mod.toRouteTag(`/api/${Array.from({ length: 7 }, () => 'x'.repeat(30)).join('/')}`);
    assert.ok(wide.length > 60, 'pre-slice input must exceed the segment-cap-only length');
    assert.equal(wide.length, 96, 'the length cap itself must truncate');
  });

  it('suppresses ONLY the offending route when a single endpoint 401s after a fresh mint', async () => {
    memoryStorage.clear();
    const { captures, crumbs } = collectSentry();

    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
    try {
      const denied = await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(denied.status, 401, "the caller still receives the server's own verdict");

      // The exact scenario Axiom proved: sibling routes are healthy and must
      // keep working. Today's code returns 503 for both of these.
      const sibling = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      const sibling2 = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(sibling.status, 200, 'a healthy sibling route must NOT be blacked out by another route’s 401');
      assert.equal(sibling2.status, 200, 'the anonymous session is alive — every other panel keeps loading');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 0, 'no degraded-session toast for a single-route denial');
    assert.deepEqual(warnings, [], 'the session was never dead, so nothing warns about suppression');
    assert.equal(mod.isWmSessionDead(), false, 'the global cooldown must NOT engage on one route');

    assert.equal(captures.length, 1, 'the offending route is still reported exactly once');
    // A distinct `kind` keeps WORLDMONITOR-WG the blackout counter it was
    // designed to be (#5245) while this becomes the route census (#5674).
    assert.equal(captures[0].ctx.tags?.kind, 'wm_session_route_401');
    assert.equal(captures[0].ctx.tags?.route, '/api/intelligence/v1/get-risk-scores');
    assert.equal(crumbs.length, 1, 'the invisible 401 gets a manual breadcrumb');
    assert.equal(crumbs[0].data?.route, '/api/intelligence/v1/get-risk-scores');
  });

  it('does not re-mint for a route that already failed its fresh-cookie replay', async () => {
    memoryStorage.clear();
    const { captures } = collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const url = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);
      const mintsAfterFirst = counters.mints;
      const second = await wrappedFetch(url);
      const third = await wrappedFetch(url);
      assert.equal(second.status, 401);
      assert.equal(third.status, 401);
      assert.equal(
        counters.mints, mintsAfterFirst,
        'a struck route must not spend another mint — that is the #5219 amplification this guards',
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(counters.hits.get(url), 4, 'first attempt + one verifier retry, then one bare pass-through each');
    // reportRouteRecoveryFailure is documented as bounded to one report per
    // route per cooldown window. Without this assertion a regression that
    // re-reported on every pass-through would keep the suite green while
    // multiplying wm_session_route_401 volume in Sentry.
    assert.equal(captures.length, 1, 'a struck route must not re-report on every pass-through hit');
  });

  it('still blacks out the session once a SECOND distinct route fails the fresh-cookie replay', async () => {
    // The original #5219/#5251 failure — the browser cannot deliver the
    // HttpOnly cookie at all — makes every route 401, so the quorum is reached
    // and the global cooldown must still engage.
    memoryStorage.clear();
    const { captures, crumbs, order } = collectSentry();

    let degradedEvents = 0;
    const g = globalThis as unknown as { dispatchEvent?: (ev: Event) => boolean };
    g.dispatchEvent = (ev: Event) => {
      if (ev.type === mod.WM_SESSION_DEGRADED_EVENT) degradedEvents += 1;
      return true;
    };

    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/'], counters);

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const first = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(first.status, 401);
      assert.equal(mod.isWmSessionDead(), false, 'one route is not yet proof');

      const second = await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(second.status, 401, 'the corroborating route returns the server response');
      assert.equal(mod.isWmSessionDead(), true, 'two distinct routes DO prove the cookie is not being delivered');

      const suppressed = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(suppressed.status, 503, 'the global cooldown engages exactly as before');
      assert.equal(suppressed.headers.get('x-wm-session-degraded'), '1');
    } finally {
      console.warn = originalWarn;
      delete g.dispatchEvent;
    }

    assert.equal(degradedEvents, 1, 'the degraded toast fires once the session really is dead');
    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1, 'exactly one wm_session_dead per episode');
    assert.equal(dead[0].ctx.tags?.reason, 'retry_401');
    assert.equal(
      dead[0].ctx.tags?.route, '/api/intelligence/v1/get-risk-scores',
      'the blackout capture names the route that tripped it (#5674 AC#1)',
    );
    assert.ok(
      crumbs.some((c) => c.data?.route === '/api/intelligence/v1/get-risk-scores' && c.data?.reason === 'retry_401'),
      'the otherwise-invisible 401 is recorded as a breadcrumb before the capture',
    );
    // ORDERING is the load-bearing half of the AC#1 fix, not mere existence: the
    // manual crumb only lands in the episode's event if it is added BEFORE the
    // captureMessage. Assert the interleaving the harness collects, or a
    // regression that swapped the two calls would keep every other assertion
    // above green while restoring the invisible-401 blind spot.
    const deadCapture = order.indexOf('capture:wm_session_dead');
    const deadCrumb = order.indexOf('crumb:wm-session recovery failed');
    assert.ok(deadCrumb >= 0 && deadCapture >= 0, `both events must be recorded, got ${JSON.stringify(order)}`);
    assert.ok(deadCrumb < deadCapture, `breadcrumb must precede the capture, got ${JSON.stringify(order)}`);
  });

  it('does NOT black out when two route denials fall outside the corroboration window', async () => {
    // Corroboration is temporal coincidence, not "twice in 15 minutes". Two
    // unrelated endpoint bugs an hour apart are not evidence that the cookie is
    // undeliverable, and blacking out a demonstrably healthy session on that
    // basis is the exact harm #5674 is about.
    memoryStorage.clear();
    collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/'], counters);

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(mod.isWmSessionDead(), false, 'one route is not yet proof');

      // Well past SESSION_DEAD_CORROBORATION_MS but well inside the 15-minute
      // per-route suppression window.
      clock += 5 * 60 * 1000;
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(
        mod.isWmSessionDead(), false,
        'a denial 5 minutes later is not corroborating evidence of a session-wide failure',
      );
    } finally {
      Date.now = realNow;
      console.warn = originalWarn;
    }
  });

  it('lets a healthy sibling’s 200 retire the corroboration evidence', async () => {
    // The #5674 diagnosis rested on siblings returning 200 in the very same
    // second the client declared the session dead. A success is therefore
    // counter-evidence and must void the quorum — while NOT releasing the struck
    // route's own mint guard, which is what keeps #5219 amplification bounded.
    memoryStorage.clear();
    collectSentry();
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(
      ['/api/intelligence/v1/get-risk-scores', '/api/economic/v1/get-bls-series'],
      counters,
    );

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(mod.isWmSessionDead(), false, 'one broken endpoint is not a dead session');

      const healthy = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(healthy.status, 200, 'the sibling is fine, which is the whole point');

      // A second, unrelated broken endpoint. Two failures — but a success in
      // between proved the cookie is being delivered, so this is two endpoint
      // bugs, not a session failure.
      await wrappedFetch('https://api.worldmonitor.app/api/economic/v1/get-bls-series');
      assert.equal(
        mod.isWmSessionDead(), false,
        'a proven-live session must not be blacked out by two unrelated endpoint denials',
      );

      const stillWorking = await wrappedFetch('https://api.worldmonitor.app/api/news/v1/list-feed-digest');
      assert.equal(stillWorking.status, 200, 'every healthy panel keeps loading');

      // The mint guard for the broken route must survive the sibling's success,
      // or it would remint on every poll (~120/hr instead of ~4/hr).
      const mintsBefore = counters.mints;
      await wrappedFetch('https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores');
      assert.equal(
        counters.mints, mintsBefore,
        'a sibling’s success must NOT release the struck route’s mint guard (#5219)',
      );
    } finally {
      console.warn = originalWarn;
    }
  });

  it('clears route strikes when a key-bound session replaces the anonymous one', async () => {
    // establishWmKeySession is what migrateLegacyKeysToHttpOnlySession calls when
    // a user holding a legacy widget/pro key upgrades. Strikes recorded against
    // the anonymous identity say nothing about what the key-bound one may reach,
    // so a paying user must not inherit a 15-minute suppression on their panel.
    memoryStorage.clear();
    collectSentry();
    const gated = '/api/intelligence/v1/get-risk-scores';
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        counters.mints += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      counters.hits.set(url, (counters.hits.get(url) ?? 0) + 1);
      const denied = url.includes(gated);
      return Promise.resolve(new Response(denied ? 'denied' : 'ok', { status: denied ? 401 : 200 }));
    };

    const url = `https://api.worldmonitor.app${gated}`;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);

      // Struck: the next call short-circuits, spending neither a mint nor a retry.
      let mintsBefore = counters.mints;
      let hitsBefore = counters.hits.get(url) ?? 0;
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsBefore, 'a struck route spends no mint');
      assert.equal(counters.hits.get(url), hitsBefore + 1, 'a struck route passes through exactly once');

      assert.equal(await mod.establishWmKeySession({ proKey: 'pk_test' }), true, 'the key session is established');

      // Still denied, so the observable difference is whether recovery is
      // ATTEMPTED. Asserting a 200 here instead would pass even with the clear
      // removed, because a route that starts succeeding returns at the success
      // branch before the struck check is ever consulted.
      mintsBefore = counters.mints;
      hitsBefore = counters.hits.get(url) ?? 0;
      await wrappedFetch(url);
      assert.equal(
        counters.mints, mintsBefore + 1,
        'the upgraded identity must get a fresh recovery attempt, not inherit the anonymous strike',
      );
      assert.equal(counters.hits.get(url), hitsBefore + 2, 'initial attempt plus the verifier retry');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('gives a struck route the free newer-cookie replay when the session has moved on', async () => {
    // The struck-route short-circuit must sit BELOW the sessionGeneration check.
    // That replay spends no mint, so denying it to a struck route pins the route
    // to a stale 401 for the rest of its 15-minute window even after an
    // unrelated caller has already obtained a cookie that works.
    memoryStorage.clear();
    collectSentry();
    const struck = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    let mints = 0;
    let struckAttempts = 0;
    let bootstrapAttempts = 0;
    let releaseStale401: (() => void) | null = null;
    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) {
        mints += 1;
        return Promise.resolve(new Response(JSON.stringify({ exp: FAR_FUTURE }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      if (url.includes('/api/bootstrap')) {
        bootstrapAttempts += 1;
        // 401 once, then accept — this is what advances sessionGeneration.
        return Promise.resolve(new Response('x', { status: bootstrapAttempts === 1 ? 401 : 200 }));
      }
      struckAttempts += 1;
      // Attempts 1-2 strike the route. Attempt 3 hangs, holding a stale 401 open
      // across another caller's refresh. Attempt 4 is the replay, which works.
      if (struckAttempts === 3) {
        return new Promise((resolve) => { releaseStale401 = () => resolve(new Response('stale', { status: 401 })); });
      }
      return Promise.resolve(new Response('x', { status: struckAttempts >= 4 ? 200 : 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(struck);
      assert.equal(struckAttempts, 2, 'the route is struck after its fresh-cookie replay fails');

      const delayed = wrappedFetch(struck);
      await new Promise((resolve) => { setImmediate(resolve); });
      assert.ok(releaseStale401, 'the struck route should be awaiting its stale 401');

      // An unrelated caller recovers the session, advancing sessionGeneration.
      const other = await wrappedFetch('https://api.worldmonitor.app/api/bootstrap');
      assert.equal(other.status, 200, 'the unrelated caller recovers normally');

      releaseStale401?.();
      const replayed = await delayed;
      assert.equal(
        replayed.status, 200,
        'a struck route must still take the mint-free newer-cookie replay once the generation advances',
      );
      assert.equal(struckAttempts, 4, 'the stale 401 was replayed rather than handed back');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('trips the global cooldown immediately when the mint itself fails', async () => {
    // mint_failed is session-wide by construction: no cookie exists for ANY
    // route, so corroboration would be pure delay.
    memoryStorage.clear();
    const { captures, crumbs } = collectSentry();

    currentFetchHandler = (input) => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
      if (url.includes('/api/wm-session')) return Promise.resolve(new Response('mint down', { status: 503 }));
      return Promise.resolve(new Response('denied', { status: 401 }));
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const resp = await wrappedFetch('https://api.worldmonitor.app/api/infrastructure/v1/list-service-statuses');
      assert.equal(resp.status, 401);
      assert.equal(mod.isWmSessionDead(), true, 'a failed mint needs no second route');
    } finally {
      console.warn = originalWarn;
    }

    const dead = captures.filter((c) => c.ctx.tags?.kind === 'wm_session_dead');
    assert.equal(dead.length, 1);
    assert.equal(dead[0].ctx.tags?.reason, 'mint_failed');
    // The `route` tag must name what FAILED, since grouping WORLDMONITOR-WG by it
    // to find the offending endpoint is the tag's whole purpose. On mint_failed
    // the mint is what failed; the in-flight route is a bystander and tagging it
    // would seed the route census with innocent endpoints.
    assert.equal(dead[0].ctx.tags?.route, '/api/wm-session');
    // The bystander is still useful for triage, so it rides the breadcrumb.
    assert.ok(
      crumbs.some((c) => c.data?.blocked === '/api/infrastructure/v1/list-service-statuses'),
      `the blocked route is preserved on the breadcrumb, got ${JSON.stringify(crumbs.map((c) => c.data))}`,
    );
  });

  it('releases a struck route once its suppression window lapses', async () => {
    // The strike is a time-boxed mint guard, not a permanent verdict. If expiry
    // did not actually release it, a route denied once would never attempt
    // recovery again for the life of the tab.
    memoryStorage.clear();
    collectSentry();
    const url = 'https://api.worldmonitor.app/api/intelligence/v1/get-risk-scores';
    const counters = { mints: 0, hits: new Map<string, number>() };
    currentFetchHandler = handlerRejecting(['/api/intelligence/v1/get-risk-scores'], counters);

    const realNow = Date.now;
    let clock = realNow.call(Date);
    Date.now = () => clock;
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await wrappedFetch(url);
      assert.deepEqual(mod.getStruckRoutes(), ['/api/intelligence/v1/get-risk-scores'], 'the route is struck');

      const mintsWhileStruck = counters.mints;
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsWhileStruck, 'still struck: no mint');

      // Past the per-route suppression TTL.
      clock += 15 * 60 * 1000 + 1;
      assert.deepEqual(mod.getStruckRoutes(), [], 'the strike lapsed');
      await wrappedFetch(url);
      assert.equal(counters.mints, mintsWhileStruck + 1, 'a lapsed strike lets recovery run again');
    } finally {
      Date.now = realNow;
      console.warn = originalWarn;
    }
  });
});
