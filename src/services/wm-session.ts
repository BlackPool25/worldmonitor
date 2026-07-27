// Client-side helper for the anonymous-browser session cookie (issue #3541).
//
// The server's validateApiKey() (api/_api-key.js) no longer trusts header-only
// signals like Origin / Referer / Sec-Fetch-Site to authorize key-less browser
// access — every header is forgeable by curl. Anonymous browsers now mint a
// short-lived HMAC-signed token via POST /api/wm-session. The token is stored
// by the server in an HttpOnly cookie; JavaScript only tracks the expiry.
//
// Two pieces:
//   1. ensureWmSession() — asks the server to mint/refresh the HttpOnly cookie.
//   2. installWmSessionFetchInterceptor() — patch globalThis.fetch ONCE so
//      every call to our API origin includes credentials. Avoids touching
//      ~50 fetch sites individually.

import { getCanonicalApiOrigin, toApiUrl } from './runtime';
import { PREMIUM_RPC_PATHS } from '@/shared/premium-paths';
import { isPublicSharedRpcRequest } from '@/shared/public-rpc-cache';
import { enqueueSentryCall } from '@/bootstrap/sentry-defer';

const STORAGE_KEY = 'wm-session-exp';
// Refresh well before expiry so a half-loaded page doesn't fail mid-flight.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Abort a session mint that stalls. Without this, a hung /api/wm-session response
// strands every concurrent caller on the shared `inflight` promise forever.
let fetchNewSessionTimeoutMs = 10_000;
// Periodic refresh cadence — wake every 30 minutes to renew before the
// 12-hour token expires. Long-lived tabs (overnight, multi-day) lose the
// token without this; the original implementation had no auto-refresh.
const PERIODIC_REFRESH_MS = 30 * 60 * 1000;
// A rejected retry means the browser cannot currently deliver the HttpOnly
// cookie (for example, strict cookie settings). Avoid amplifying that into a
// request + mint + retry loop for every panel refresh.
const SESSION_DEAD_COOLDOWN_MS = 15 * 60 * 1000;
// A single endpoint that still 401s after a fresh mint proves nothing about
// the session cookie (#5674). Server telemetry for the regrown WORLDMONITOR-WG
// episodes showed 11 of 12 sampled affected browsers emitting ZERO server-side
// 401s across the whole episode — sibling routes on the same tab returned 200
// in the very same second the client declared the session dead. Treating one
// route's denial as proof of a dead cookie is what turns a single endpoint
// problem into a 15-minute blackout of every anonymous panel.
//
// Require corroboration from this many DISTINCT routes before suppressing all
// anonymous traffic. The failure mode #5219/#5251 originally targeted — the
// browser cannot deliver the HttpOnly cookie at all — makes EVERY route 401,
// so it still reaches the quorum (after one extra mint) and still engages the
// global cooldown.
const SESSION_DEAD_ROUTE_QUORUM = 2;
export const WM_SESSION_DEGRADED_EVENT = 'wm-session-degraded';

type WmSessionDeadReason = 'mint_failed' | 'retry_401';

interface StoredSession {
  exp: number;
}

let cached: StoredSession | null = null;
let inflight: Promise<boolean> | null = null;
let recoveryInFlight: Promise<Response | null> | null = null;
let sessionGeneration = 0;
let interceptorInstalled = false;
let nativeSessionFetch: typeof fetch | null = null;
let sessionDeadUntil = 0;
let sentryEnqueue: typeof enqueueSentryCall = enqueueSentryCall;
// Routes whose replay-with-a-fresh-cookie still 401'd, mapped to the moment
// their strike lapses. Doubles as the corroboration counter and as the
// per-route suppression list.
const routeStrikes = new Map<string, number>();

// Sentry tags must stay low-cardinality. Interceptor traffic only ever targets
// our own /api/ surface, but dynamic segments (`/api/v2/shipping/webhooks/
// <subscriberId>`) and the catch-all not-found route can still carry
// caller-controlled values, so collapse anything id-shaped before tagging.
const MAX_ROUTE_TAG_SEGMENTS = 8;
const MAX_ROUTE_TAG_LENGTH = 96;

/**
 * Reduce a request pathname to a bounded, aggregable Sentry tag value.
 * Exported for direct unit coverage — the cardinality guarantee is the whole
 * point of the tag, and it is not observable from the interceptor's outside.
 */
export function toRouteTag(pathname: string): string {
  if (!pathname.startsWith('/api/')) return 'other';
  const segments = pathname.split('/').filter(Boolean).slice(0, MAX_ROUTE_TAG_SEGMENTS);
  const safe = segments.map((segment) => {
    // `v1`/`v2` are real, fixed route segments; every other digit-bearing or
    // over-long segment is treated as an identifier.
    if (/^v\d+$/.test(segment)) return segment;
    if (/\d/.test(segment) || segment.length > 32 || !/^[A-Za-z][A-Za-z._-]*$/.test(segment)) return ':id';
    return segment;
  });
  return `/${safe.join('/')}`.slice(0, MAX_ROUTE_TAG_LENGTH);
}

export function isWmSessionDead(): boolean {
  if (sessionDeadUntil <= Date.now()) {
    sessionDeadUntil = 0;
    return false;
  }
  return true;
}

/**
 * True when `route` already failed a replay-with-a-fresh-cookie inside the
 * current window. Re-running recovery for it would re-derive the same denial
 * and spend another mint, which is the request+mint+retry amplification #5219
 * exists to prevent.
 */
function isRouteStruck(route: string): boolean {
  const until = routeStrikes.get(route);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  routeStrikes.delete(route);
  return false;
}

/** Record a failed fresh-mint replay for `route`; returns the live strike count. */
function recordRouteStrike(route: string): number {
  const now = Date.now();
  for (const [struck, until] of routeStrikes) {
    if (until <= now) routeStrikes.delete(struck);
  }
  routeStrikes.set(route, now + SESSION_DEAD_COOLDOWN_MS);
  return routeStrikes.size;
}

function addSessionBreadcrumb(message: string, data: Record<string, string>): void {
  // Sentry's automatic fetch instrumentation cannot see these requests: the
  // interceptor captured `window.fetch` before the deferred Sentry.init wrapped
  // it, so every retry it issues bypasses the SDK. The outer call DOES get a
  // breadcrumb, but only once its promise settles — which is after this
  // episode's captureMessage has already been sent. Without a manual crumb the
  // 401 is invisible in the event that exists to explain it (#5674).
  try {
    sentryEnqueue((s) => s.addBreadcrumb({
      category: 'wm-session',
      level: 'warning',
      message,
      data,
    }));
  } catch { /* best-effort telemetry */ }
}

function markWmSessionDead(reason: WmSessionDeadReason, route: string): void {
  const alreadyDead = isWmSessionDead();
  sessionDeadUntil = Date.now() + SESSION_DEAD_COOLDOWN_MS;
  cached = null;
  // The global cooldown supersedes per-route suppression — every anonymous
  // call is already blocked, so keeping strikes alive past it would only make
  // the first post-cooldown failure trip the quorum on stale evidence.
  routeStrikes.clear();
  try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  if (alreadyDead) return;
  console.warn('[wm-session] refreshed HttpOnly session cookie was still rejected; suppressing anonymous API calls briefly');
  // One warning per degraded episode — reportServerError (premium-fetch.ts)
  // deliberately skips the synthetic X-Wm-Session-Degraded 503s, so this is
  // the only remote signal that anonymous browsing is degraded (#5245).
  // Guarded: a telemetry throw must never skip the degraded-event dispatch
  // below, nor turn the interceptor's recovery return into a rejection.
  const routeTag = toRouteTag(route);
  addSessionBreadcrumb('wm-session recovery failed', { route: routeTag, reason });
  try {
    sentryEnqueue((s) => s.captureMessage(
      'wm-session dead: anonymous API calls suppressed',
      { level: 'warning', tags: { kind: 'wm_session_dead', reason, route: routeTag } },
    ));
  } catch { /* best-effort telemetry */ }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new Event(WM_SESSION_DEGRADED_EVENT));
  }
}

/**
 * A lone route failed its replay with a demonstrably fresh cookie. Suppress
 * just that route and report it under its own `kind` so WORLDMONITOR-WG stays
 * the blackout counter it was designed to be (#5245) while the offending
 * endpoint still becomes aggregable. Bounded to one report per route per
 * cooldown window: a struck route short-circuits before recovery runs again.
 */
function reportRouteRecoveryFailure(route: string): void {
  const routeTag = toRouteTag(route);
  addSessionBreadcrumb('wm-session route denied after fresh mint', { route: routeTag });
  try {
    sentryEnqueue((s) => s.captureMessage(
      'wm-session route rejected after fresh mint',
      { level: 'info', tags: { kind: 'wm_session_route_401', route: routeTag } },
    ));
  } catch { /* best-effort telemetry */ }
}

/**
 * Decide how far a failed recovery should reach.
 *
 * `mint_failed` is session-wide by construction — /api/wm-session itself did
 * not hand back a cookie, so no route can succeed. It trips the global
 * cooldown immediately, exactly as before.
 *
 * `retry_401` only implicates the one route that was replayed, so it needs
 * SESSION_DEAD_ROUTE_QUORUM distinct routes before it may black out the tab.
 */
function noteRecoveryFailure(reason: WmSessionDeadReason, route: string): void {
  if (reason === 'mint_failed') {
    markWmSessionDead(reason, route);
    return;
  }
  if (recordRouteStrike(route) >= SESSION_DEAD_ROUTE_QUORUM) {
    markWmSessionDead(reason, route);
    return;
  }
  reportRouteRecoveryFailure(route);
}

function sessionDegradedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Anonymous session temporarily unavailable' }), {
    status: 503,
    headers: {
      'Content-Type': 'application/json',
      'X-Wm-Session-Degraded': '1',
    },
  });
}

function isFresh(s: StoredSession | null): s is StoredSession {
  return !!s && s.exp - REFRESH_MARGIN_MS > Date.now();
}

function loadFromStorage(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.exp === 'number') return { exp: parsed.exp };
  } catch { /* ignore */ }
  return null;
}

function saveToStorage(s: StoredSession): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

async function fetchNewSession(body?: { widgetKey?: string; proKey?: string }): Promise<StoredSession | null> {
  try {
    const fetchImpl = nativeSessionFetch ?? globalThis.fetch;
    const resp = await fetchImpl(toApiUrl('/api/wm-session'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(fetchNewSessionTimeoutMs),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { exp?: unknown };
    if (typeof data?.exp !== 'number') return null;
    return { exp: data.exp };
  } catch {
    return null;
  }
}

export async function ensureWmSession(): Promise<boolean> {
  if (isWmSessionDead()) return false;
  if (isFresh(cached)) return true;
  if (inflight) return inflight;

  const stored = loadFromStorage();
  if (isFresh(stored)) {
    cached = stored;
    return true;
  }

  inflight = (async () => {
    const fresh = await fetchNewSession();
    if (fresh) {
      cached = fresh;
      sessionGeneration += 1;
      saveToStorage(fresh);
      return true;
    }
    return false;
  })().finally(() => { inflight = null; });

  return inflight;
}

export function getWmSessionToken(): string | null {
  // Tokens are HttpOnly now; callers can only know whether the cookie should
  // be fresh by calling ensureWmSession().
  return null;
}

export async function establishWmKeySession(keys: { widgetKey?: string; proKey?: string }): Promise<boolean> {
  const fresh = await fetchNewSession(keys);
  if (!fresh) return false;
  cached = fresh;
  sessionGeneration += 1;
  sessionDeadUntil = 0;
  // A key-bound session is a clean slate: strikes recorded against the old
  // anonymous identity say nothing about what this one may reach.
  routeStrikes.clear();
  saveToStorage(fresh);
  return true;
}

function withCredentials(init?: RequestInit): RequestInit {
  return { ...(init ?? {}), credentials: init?.credentials ?? 'include' };
}

// Test-only escape hatch. The interceptor lifecycle is module-scoped (one
// install per process) so unit tests can't easily simulate token-state
// transitions across cases without a way to clear `cached` and `inflight`.
// Production code never imports this — it's exclusively for `tests/wm-session-*`.
//
// `interceptorInstalled` is also reset so a test that calls this followed by
// `installWmSessionFetchInterceptor()` actually re-runs the install path
// instead of silently no-op'ing on the install guard. Without it, future
// tests that wipe state and expect a fresh install would see a stale
// `window.fetch` wrapper from a prior test.
export function __resetWmSessionForTests(): void {
  cached = null;
  inflight = null;
  recoveryInFlight = null;
  sessionGeneration = 0;
  interceptorInstalled = false;
  sessionDeadUntil = 0;
  routeStrikes.clear();
  sentryEnqueue = enqueueSentryCall;
  fetchNewSessionTimeoutMs = 10_000;
}

// Test-only: shrink the mint timeout so adversarial repros for hung fetches
// don't need to wait the production 10s budget.
export function __setWmSessionFetchTimeoutForTests(ms: number): void {
  fetchNewSessionTimeoutMs = ms;
}

// Test-only: observe the once-per-episode dead-session Sentry capture without
// loading the SDK. Reset back to the real enqueue by __resetWmSessionForTests.
export function __setWmSessionSentryEnqueueForTests(fn: typeof enqueueSentryCall): void {
  sentryEnqueue = fn;
}

// Install a one-shot fetch wrapper that includes HttpOnly session cookies on
// API calls.
// Only patches calls to our API origin (or relative /api/ paths). Other fetches
// (Sentry, Clerk, third-party CDNs) are forwarded to native fetch unchanged.
//
// Decide whether a fetch URL should go through the wms_-injection branch.
// Exported (and named with no implementation detail in its signature) so the
// regression test in tests/wm-session-interceptor-target.test.mts can lock the
// shape of this decision without needing a JSDOM/happy-dom environment to
// stand up the full interceptor.
//
// Two failure modes pinned here:
//
//   1. PR #3574 — `apiOrigin` was '' on browsers, so the cross-origin match
//      silently returned false for every absolute URL. Bug class: matcher
//      under-matches → wms_ never attached → 401 on every browser request.
//
//   2. PR #3575 review — using raw `startsWith(apiOrigin)` for absolute URLs
//      lets attacker-controlled origins that embed the canonical-origin
//      string as a prefix (e.g. `https://api.worldmonitor.app.evil.example/`)
//      OR as the userinfo portion (`https://api.worldmonitor.app@evil/`)
//      slip through, sending the wms_ token to a foreign host. Bug class:
//      matcher over-matches → token leaks cross-origin.
//
// The fix: relative `/api/` paths still take a fast prefix check (no host
// to validate, can only resolve same-origin). Absolute URLs are parsed via
// `new URL` and compared by `.origin` (exact-match, RFC-3986-correct), with
// an additional `/api/` pathname guard so the matcher never attaches the
// token to non-API paths even if they happen to be on the API host.
export function isApiCallTarget(url: string, apiOrigin: string): boolean {
  if (url.startsWith('/api/')) return true;
  if (apiOrigin === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === apiOrigin && parsed.pathname.startsWith('/api/');
}

function isCredentiallessPublicDataRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  url: string,
): boolean {
  const credentials = init?.credentials ?? (input instanceof Request ? input.credentials : undefined);
  if (credentials !== 'omit') return false;

  let parsed: URL;
  try {
    parsed = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href);
  } catch {
    return false;
  }

  const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (isPublicSharedRpcRequest(parsed, method)) return true;
  if (pathname !== '/api/bootstrap' || method.toUpperCase() !== 'GET') return false;

  const params = Array.from(parsed.searchParams.keys());
  if (params.some((key) => key !== 'tier' && key !== 'public')) return false;

  const tiers = parsed.searchParams.getAll('tier');
  const publicFlags = parsed.searchParams.getAll('public');
  return tiers.length === 1
    && (tiers[0] === 'fast' || tiers[0] === 'slow')
    && publicFlags.length === 1
    && publicFlags[0] === '1';
}

// If a caller already set Authorization / X-WorldMonitor-Key / X-Api-Key, we
// don't override — Clerk Bearer JWT and explicit user keys still take
// precedence over the anonymous session token.
export function installWmSessionFetchInterceptor(): void {
  if (interceptorInstalled || typeof window === 'undefined') return;
  interceptorInstalled = true;

  // CRITICAL: must be getCanonicalApiOrigin(), NOT getApiBaseUrl(). The latter
  // returns '' for non-desktop runtimes (see runtime.ts:111), which makes the
  // interceptor's cross-origin match below silently fail for every browser
  // request to https://api.worldmonitor.app/api/* — the interceptor only
  // catches relative '/api/' paths, the wms_ token never gets attached, and
  // the gateway returns {"error":"API key required"}. Production incident
  // 2026-05-03: every browser request 401'd because of this.
  const apiOrigin = (() => {
    try { return new URL(getCanonicalApiOrigin()).origin; } catch { return ''; }
  })();
  // AGENTS.md bans `fetch.bind(globalThis)` to avoid freezing a stale
  // reference. The prescribed alternative `(...args) => globalThis.fetch(...)`
  // would recurse here because the very next line replaces `window.fetch`
  // with our wrapper — re-entering through `globalThis.fetch` would loop
  // forever. The correct minimal pattern that captures the pre-wrapping
  // value AND avoids `.bind()` is a plain assignment: in modern browsers
  // `fetch` is already bound to its global receiver and the unbound
  // reference works correctly when called as `original(...)`.
  const original = window.fetch;
  nativeSessionFetch = original;

  window.fetch = async function wmSessionFetch(input, init) {
    const url = (() => {
      if (typeof input === 'string') return input;
      if (input instanceof URL) return input.href;
      if (input instanceof Request) return input.url;
      return '';
    })();

    if (!isApiCallTarget(url, apiOrigin)) return original(input, init);

    // Public tier hydration is intentionally credential-less and does not rely
    // on the anonymous wm-session cookie. Let this exact request shape reach
    // the native fetch even while session recovery is cooling down; otherwise
    // the interceptor's synthetic 503 prevents the public CDN path from
    // restoring the dashboard. Keep the bypass narrow so arbitrary bootstrap
    // reads cannot opt out of the normal session machinery.
    if (isCredentiallessPublicDataRequest(input, init, url)) return original(input, init);

    // Premium routes have a dedicated auth-injection layer
    // (`installWebApiRedirect`'s `enrichInitForPremium` adds Clerk Bearer JWT,
    // WORLDMONITOR_API_KEY, or tester key based on what the user has). Stepping
    // aside lets that inner layer attach the right credential — if we set
    // X-WorldMonitor-Key=wms_... here, the premium injector sees the header
    // and bails, and the server then 401s because wms_ is rejected on premium
    // routes (it's anonymous, not user-bound). PR #3557 review finding.
    const path = (() => {
      try {
        return new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).pathname;
      } catch {
        return url.split('?')[0] ?? url;
      }
    })();
    if (PREMIUM_RPC_PATHS.has(path)) return original(input, withCredentials(init));

    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    // Caller already authenticated (Bearer JWT, explicit user/widget key, etc).
    // Don't override — Clerk and explicit-key paths take precedence.
    if (
      headers.has('Authorization') ||
      headers.has('X-WorldMonitor-Key') ||
      headers.has('X-Api-Key')
    ) {
      return original(input, withCredentials(init));
    }

    if (isWmSessionDead()) return sessionDegradedResponse();

    await ensureWmSession().catch(() => false);

    if (isWmSessionDead()) return sessionDegradedResponse();

    // A Request body is a one-shot stream — clone BEFORE the first send so
    // the refresh-on-401 retry below has an intact body to replay. For
    // string/URL inputs, body lives on `init` and Headers merging is enough.
    const requestClone = input instanceof Request ? input.clone() : null;

    const sendWith = (h: Headers, src: typeof input): Promise<Response> => {
      if (src instanceof Request) {
        const cloned = new Request(src, { ...withCredentials(init), headers: h });
        return original(cloned);
      }
      return original(src, { ...withCredentials(init), headers: h });
    };

    const requestSessionGeneration = sessionGeneration;
    const resp = await sendWith(headers, input);

    // Layer 2 — refresh-on-401. A single transient blip (HMAC-key rotation,
    // expiry race, server-side cache flap) shouldn't strand the tab. If we
    // had no token to begin with OR the token we sent was rejected, mint a
    // fresh one and replay ONCE. Premium routes already returned above; the
    // wms_ token is irrelevant there.
    if (resp.status !== 401) return resp;

    // This route already 401'd once with a demonstrably fresh cookie. Running
    // recovery again would re-derive the same denial at the cost of another
    // mint, so hand the server's own verdict back to the caller untouched —
    // and, critically, leave the session (and every other route) alone.
    if (isRouteStruck(path)) return resp;

    // A slower initial request can report the old cookie after another caller
    // already recovered it. Replay with the newer cookie instead of clearing
    // that success and spending another mint.
    if (sessionGeneration !== requestSessionGeneration) {
      return sendWith(new Headers(headers), requestClone ?? input);
    }

    // Invalidate the cached expiry (and its sessionStorage twin) before
    // re-minting. ensureWmSession() is opportunistic — without invalidation,
    // it would return the same not-yet-clock-expired token that the server
    // just rejected (HMAC-key rotation: token signature is wrong even though
    // `exp` is in the future), and the retry would 401 with the same header.
    cached = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }

    // One request verifies the reminted cookie. Other simultaneous 401s wait
    // for that result instead of each multiplying the failed retry.
    if (!recoveryInFlight) {
      const recovery = (async (): Promise<Response | null> => {
        const fresh = await ensureWmSession().catch(() => false);
        if (!fresh) {
          noteRecoveryFailure('mint_failed', path);
          return null;
        }
        const retryResp = await sendWith(new Headers(headers), requestClone ?? input);
        if (retryResp.status === 401) {
          noteRecoveryFailure('retry_401', path);
          return null;
        }
        return retryResp;
      })();
      recoveryInFlight = recovery;
      void recovery.then(
        () => { if (recoveryInFlight === recovery) recoveryInFlight = null; },
        () => { if (recoveryInFlight === recovery) recoveryInFlight = null; },
      );
      return (await recovery) ?? resp;
    }

    const verified = await recoveryInFlight;
    if (!verified) return resp;
    return sendWith(new Headers(headers), requestClone ?? input);
  };

  // Layer 1 — periodic refresh. The token is short-lived (12h server-side)
  // and originally there was no auto-refresh, so a tab open overnight (or
  // a laptop that slept) returned 401 on every API call after expiry.
  //
  // Two complementary primitives:
  //   1. setInterval at PERIODIC_REFRESH_MS — wakes opportunistically.
  //      Gated on document.visibilityState so a hidden tab on a sleeping
  //      laptop doesn't fire a flurry of mints when the laptop wakes (N
  //      tabs all hitting /api/wm-session in parallel).
  //   2. visibilitychange listener — when the user returns to a hidden
  //      tab, check freshness immediately. Catches the case where the
  //      interval skipped many beats while hidden.
  //
  // Errors are swallowed — periodic refresh is best-effort; the
  // refresh-on-401 layer above is the safety net.
  if (typeof setInterval === 'function') {
    setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (isFresh(cached)) return;
      ensureWmSession().catch(() => { /* best-effort */ });
    }, PERIODIC_REFRESH_MS);
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (isFresh(cached)) return;
      ensureWmSession().catch(() => { /* best-effort */ });
    });
  }
}
