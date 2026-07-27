---
title: "One route's 401 declared the whole anonymous session dead — and the 401 never reached our server"
date: 2026-07-27
category: logic-errors
module: wm-session
problem_type: logic_error
component: authentication
severity: high
symptoms:
  - "Sentry WORLDMONITOR-WG (`kind: wm_session_dead`) regrew 34x traffic-normalized in three days after #5516 fixed one contributor, with 97% tagged `retry_401` (mint succeeded, replay still 401'd)"
  - "Each episode suppressed every anonymous API call for 15 minutes (#5219 cooldown) — a dashboard of blank widgets"
  - "The 401 was invisible in Sentry breadcrumbs: 94 fetch breadcrumbs across 5 sampled events, zero non-2xx"
  - "Axiom `wm_api_usage` showed ZERO server-side 401s for 11 of 12 sampled affected browsers, while sibling routes returned 200 in the same second the client declared the session dead"
root_cause: logic_error
resolution_type: code_fix
related_components: [tooling, testing_framework]
tags: [wm-session, anonymous-session, sentry, axiom, telemetry-blind-spot, blast-radius, diagnosis-technique, 401]
---

# One route's 401 declared the whole anonymous session dead — and the 401 never reached our server

## Problem

`markWmSessionDead('retry_401')` fired whenever a single endpoint returned 401 *after* the interceptor had minted a fresh session cookie and replayed the request. That call suppressed **all** anonymous API traffic for 15 minutes. The inference — "a fresh cookie was rejected, therefore the cookie is dead" — was drawn from one route's evidence and applied session-wide.

The diagnosis was wrong. The cookie was healthy in essentially every episode.

## Symptoms

Traffic-normalized WG rate (against `web-vital: INP` as a traffic proxy) went 58 -> 1,953 per 1k INP in three days after #5516 landed, while traffic itself *fell*. Monotonic, so regrowth rather than a blip. Reason split on the last 100 events: 97 `retry_401` / 3 `mint_failed`.

## What Didn't Work

**Reading the client's breadcrumbs.** Sentry showed only 2xx. Two independent reasons, and it matters that it's both:

1. `installWmSessionFetchInterceptor` captures `window.fetch` at install (`src/services/wm-session.ts`), before the deferred `scheduleSentryInit()` (`src/main.ts`) wraps it. Every retry the interceptor issues therefore goes through the pre-Sentry native fetch and is never instrumented.
2. The *outer* call does get an automatic breadcrumb — but only when its promise settles, which is **after** the episode's `captureMessage` has already been sent. In a sampled event the last breadcrumb was a 200 at `07:46:29.126` and the dead-session warning landed at `07:46:29.127`.

**Chasing the issue's leading hypothesis — "another premium/tier-gated route not classified as premium client-side," the same class as #5516.** Two independent facts kill it:

- Every tier-gated route is a *gateway* route, and the gateway emits `auth_401` to `wm_api_usage` for every 401 it returns. The affected users produced none.
- Routes in `PREMIUM_RPC_PATHS` short-circuit at the top of the interceptor (`return original(input, withCredentials(init))`) **before** the recovery branch, so a listed route structurally cannot produce `retry_401`. This also silently invalidates any test that picks a premium path to model this bug — two of the first drafts here failed for exactly that reason.

**Assuming a browser/cookie-policy cause.** The Sentry tag breakdown is Chrome 32,058 / Safari 5,653 / Edge 5,557 / Firefox 2,963 — i.e. ordinary traffic mix, not the Safari/Firefox skew that third-party-cookie blocking would produce.

## Solution

Two changes in `src/services/wm-session.ts` (PR #5677, opened against #5674; unmerged as of this writing).

**1. Make the route aggregable.** `markWmSessionDead` takes the request path, tags a bounded `route`, and leaves a manual breadcrumb *before* the capture so it lands in the event that exists to explain it:

```ts
const routeTag = toRouteTag(route);
addSessionBreadcrumb('wm-session recovery failed', { route: routeTag, reason });
sentryEnqueue((s) => s.captureMessage(
  'wm-session dead: anonymous API calls suppressed',
  { level: 'warning', tags: { kind: 'wm_session_dead', reason, route: routeTag } },
));
```

`toRouteTag` is exported for direct unit coverage — the cardinality bound *is* the feature, and it is not observable from outside the interceptor. It preserves real static routes verbatim and `v1`/`v2` version segments, collapses id-shaped segments to `:id`, buckets non-`/api/` paths to `other`, and caps at 8 segments / 96 chars.

**2. Require corroboration before the global blackout.** A lone route gets per-route suppression and its own `kind`; two distinct routes are needed to black out the tab:

```ts
function noteRecoveryFailure(reason: WmSessionDeadReason, route: string): void {
  if (reason === 'mint_failed') { markWmSessionDead(reason, route); return; }
  if (recordRouteStrike(route) >= SESSION_DEAD_ROUTE_QUORUM) { markWmSessionDead(reason, route); return; }
  reportRouteRecoveryFailure(route);
}
```

A struck route also short-circuits before recovery (`if (isRouteStruck(path)) return resp;`), returning the server's real 401 instead of spending another mint — preserving the request+mint+retry amplification guard that motivated #5219.

## Why This Works

`mint_failed` and `retry_401` carry different scopes, and the old code conflated them. `mint_failed` means `/api/wm-session` itself returned nothing usable, so no cookie exists for *any* route — session-wide by construction, and it still trips immediately. `retry_401` only ever observed **one** route.

The failure #5219/#5251 originally targeted — the browser cannot deliver the HttpOnly cookie at all — makes *every* route 401, so it still reaches the quorum and still engages the cooldown, at a cost of one extra mint. The protection is preserved; only the over-generalization is removed.

The strike map is self-bounding: the quorum is 2 and `markWmSessionDead` clears it, so it never holds more than two entries.

## Prevention

**When a client-side signal blames a server response, confirm the server ever sent it.** The decisive query cross-references the two telemetry stores by IP — Sentry's `user` tag is `ip:<addr>`:

```bash
# 1. affected users + timestamps
curl -s -H "Authorization: Bearer $SENTRY_AUTH_TOKEN" \
  "https://sentry.io/api/0/issues/<id>/events/?statsPeriod=24h"

# 2. what the server actually saw for those IPs in that window
#    (Axiom APL; note the field is `route`, not `path`)
wm_api_usage | where ip in ("1.0.210.48", ...) | summarize c=count() by ip, status
```

11 of 12 returning `200` only is not a subtle hint — it is proof the client's premise is false, and it reframes the whole investigation in one query.

**Know which routes `wm_api_usage` actually covers.** It is emitted by `server/gateway.ts`'s `emitRequest`, so it sees **gateway routes only**. Non-gateway Vercel functions (`/api/bootstrap`, `/api/oref-alerts`, `/api/rss-proxy`) and any CDN-served response never appear — for the sampled user, `list-feed-digest` and `oref-alerts` showed 200 in Sentry breadcrumbs with no Axiom row at all. "Absent from Axiom" therefore means *either* "never happened" *or* "did not reach the gateway"; only the cross-reference against a second source distinguishes them.

**Match the blast radius of a mitigation to the scope of its evidence.** A route-scoped observation licenses a route-scoped response. Requiring a quorum of independent observations before a global action is the general shape, and it costs one extra probe in the genuine global case.

**Check the deliverability of a new telemetry level before relying on it.** `level: 'info'` was verified to flow (web-vitals ship 50k+ info events on this project) rather than assumed — a filtered-out capture would have silently defeated the entire diagnostic purpose of the change.

**Pick a non-premium route when testing this interceptor branch.** `PREMIUM_RPC_PATHS` members return before recovery runs, so a test built on one exercises nothing and passes for the wrong reason.

## Related

- #5674 (this issue), PR #5677
- #5516 — removed one contributor (country-intel-brief Pro denials), not the class
- #5251 — original diagnosis; #5245 — the telemetry itself; #5219 — the 15-minute cooldown
- `tests/wm-session-auto-refresh.test.mts` — the five regression tests, each proven red against the pre-change code before the fix was restored
