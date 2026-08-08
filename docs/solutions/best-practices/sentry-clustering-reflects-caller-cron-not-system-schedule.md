---
title: Clustered Sentry events at a time boundary reflect the caller's schedule, not a system-side failure
date: 2026-08-08
category: best-practices
module: api/mcp get_world_brief tool + shared/insights-snapshot freshness gate
problem_type: best_practice
component: brief_system
severity: medium
applies_when:
  - Triaging a Sentry issue whose events cluster on a round time boundary such as the top of the hour or midnight
  - The failing tool or endpoint is called almost exclusively by scheduled agents or cron-driven integrations, not interactive humans
  - Before concluding a system-side hourly job (cron, seeder, cache refresh) is the root cause of a clustered failure pattern
symptoms:
  - '"$e: Seeded world brief unavailable" events cluster inside the first minute after every hour boundary'
  - Event pairs land 3-4 seconds apart, resembling one caller's retry rather than two independent incidents
  - "Sentry tag aggregates (/issues/{id}/tags/) show only a handful of distinct users, all on cloud-provider egress IPs"
tags: [sentry-triage, mcp, world-brief, sampling-bias, freshness-gate, diagnosability]
---

# Clustered Sentry events at a time boundary reflect the caller's schedule, not a system-side failure

## Context

Sentry issue WORLDMONITOR-YJ (`$e: Seeded world brief unavailable`, group 7651864851) fired 14 times for 12 distinct users between 2026-08-04 and 2026-08-07, every event tagged `tool=get_world_brief`, `route=api/mcp`, `auth_kind=pro`. Every occurrence landed within the first 45 seconds after an hour boundary, in 7 tight pairs 3–4 seconds apart. That shape invites the diagnosis "a scheduled job breaks at the top of every hour" — and this repo has real landmines that make it plausible (a freshness budget numerically equal to a producer refresh period is a known failure class here (auto memory [claude])).

The diagnosis is wrong, and the trap is general: **the event clock belonged to the caller, not the system.** The tool's only production caller is a claude.ai agent on an hourly cron; each "pair" is that one caller's single retry. The failure it samples is *continuous*, not periodic — `scripts/seed-insights.mjs` runs sub-hourly (production logs in #5947 record ~10-minute cycles; the seeder's own comment at `scripts/seed-insights.mjs:90` cites a 30-minute cron — under either figure, nothing in the pipeline ticks hourly), and on repeated synthesis rejection preserves the last-known-good payload with its original `generatedAt` (open producer defect #5947). Once that payload's age crosses the 60-minute acceptance gate (`INSIGHTS_MAX_AGE_MS`, `shared/insights-snapshot.js:7`), every `get_world_brief` call fails closed until a synthesis succeeds — multi-hour outage windows that the hourly caller sampled 7 times in 4 days.

The opacity had already cost a prior investigation: a 2026-08-06 triage session examined this same issue, traced the same gate chain, classified it "working-as-designed fail-closed" and deferred to #5947 — leaving the bare message in place, so this session had to re-derive the entire caller-cadence analysis from scratch two days later (session history).

## Guidance

**Diagnostic sequence for a periodic-looking Sentry issue:**

1. **Pull tag cardinality before theorizing** (`GET /api/0/issues/{id}/tags/`). 14 events / 12 users where every "user" is a cloud-egress IP is a handful of scheduled agents, not organic traffic. The tag aggregate endpoint also exposes per-stage/per-release splits that identify the code path instantly when stack frames are minified.
2. **Diff timestamps *within* an apparent incident.** Events 3–4 seconds apart are one caller's retry, not independent occurrences. Count incident *windows*, not events.
3. **Compare the observed period against each candidate clock.** The producer cadence here is sub-hourly (10–30 minutes depending on source — logs vs. code comment); the acceptance budget is 60 minutes; the observed period was 60 minutes — matching the *caller's* hourly cron, not any system clock. Also check window spacing: the 7 pair-windows were irregularly spaced (1h, 2h, 3h, 7h, and two ~29h gaps) across 6 release SHAs, ruling out both "fires every hour" and "one bad deploy."

**Fix-side pattern — name the gate that rejected:** a fail-closed alarm that can only say "unavailable" forces this re-derivation on every recurrence. The shipped change (PR #6333, merged 2026-08-08) makes the rejection self-describing while keeping the client contract stable:

- `shared/insights-snapshot.js:78-90` — `insightsSnapshotRejection(raw, nowMs)` returns `null` or a bounded reason (`malformed-snapshot`, `missing-generated-at`, `future-generated-at`, `stale-snapshot`); `isAcceptedInsightsSnapshot` is derived from it (`=== null`), so the boolean and the reason cannot drift.
- `api/mcp/registry/rpc-tools.ts:106-157` — `projectSeededWorldBrief` returns a `{ value } | { reason }` union, layering MCP-specific reasons (`empty-brief`, `status-not-ok`, `no-headlines`, `missing-sources`, `malformed-sources`); the throw site emits `Seeded world brief unavailable (<reason>)`.
- Grouping and contract invariants hold by construction: `api/mcp/error-fingerprint.ts:28-37` keys non-HTTP errors on the error *name*, so the message suffix cannot fragment Sentry grouping; `api/mcp/dispatch.ts:417-429` keeps the client-facing RPC error at the generic `Required data inputs are unavailable`.

The producer side already has a bounded-failure vocabulary (`consecutiveFailures`, `lastSuccessAt`, `servedGeneratedAt`, `lastSynthesisFailureCode` on the `newsInsights` health key) that a second, independent session deliberately used as its template for another seeder — extend that vocabulary when adding reason-naming; never invent a parallel one (session history).

## Why This Matters

The one-caller-one-clock model explains every observed feature without inventing a system bug: the ~30-second offset window is cron-fire jitter, the 3–4s pair gap is the caller's retry interval, the irregular multi-hour gaps are hourly polls landing inside or outside >60-minute stale windows. Conflating the consumer's clock with the producer's sends the investigation into the wrong codebase — here it would have pointed at the seeder's scheduler, which has no hourly component at all.

The reason-naming half matters because recurrence is certain until #5947's residuals are fixed: post-deploy, a `stale-snapshot` label points on-call at the producer (#5947) in one glance, while `missing-sources`/`malformed-sources` would point at a schema regression in the projection — opposite responses that the bare message could not distinguish, as two independent triage sessions proved by each re-deriving the analysis.

## When to Apply

- Any Sentry issue whose events cluster on a round boundary (hourly, daily, midnight-UTC) — especially when the surface is API/MCP tooling consumed by scheduled agents rather than humans.
- Any fail-closed gate with multiple rejection conditions that shares one error message — add the bounded reason enum *before* the first 2am page, splitting operator-facing detail (Sentry/logs) from the stable generic client message.
- Before citing "freshness budget equals refresh period" as a root cause: verify the producer actually runs on the period you observed. Here the numerically-suggestive 60-minute gate was coincidental — the producer runs every 10 minutes.

## Examples

Observed event pairs (UTC, from the Sentry events API; egress IPs are cloud-provider ranges):

| Pair | Events | Δ | Release |
|---|---|---|---|
| 1 | 08-04 14:00:38 / 14:00:41 | 3s | `cf3ac877` |
| 2 | 08-04 21:00:38 / 21:00:42 | 4s | `028ecc22` |
| 3 | 08-06 02:00:41 / 02:00:45 | 4s | `1e350817` |
| 4 | 08-06 03:00:19 / 03:00:22 | 3s | `01d56caf` |
| 5 | 08-07 08:00:14 / 08:00:18 | 4s | `6b908a21` |
| 6 | 08-07 11:00:38 / 11:00:42 | 4s | `6b908a21` |
| 7 | 08-07 13:00:40 / 13:00:43 | 3s | `a7d600cd` |

Verification of the reason-naming change (failing-first): `tests/insights-snapshot.test.mjs:51-110` asserts each rejection reason plus a parity case locking `isAcceptedInsightsSnapshot(raw) === (insightsSnapshotRejection(raw) === null)` including the exact 60-minute boundary; `tests/mcp-world-brief-routing.test.mjs:277-336` drives three rejection scenarios through the real MCP handler and asserts the operator message carries the reason while the RPC message stays generic.

## Related

- GitHub #5947 (open) — the producer defect behind the stale windows: repeated synthesis rejection preserves stale LKG while `fetchedAt` advances. Its core composer fix (dotted-acronym citation split, PR #6119) merged 2026-08-04, yet windows continued through 08-07 — consistent with the residual rejection chain: composer gate rejects openrouter output → falls back to groq → groq 429s → gate again (session history).
- GitHub #6112 / PR #6134 — the earlier rewire that grounded MCP `get_world_brief` in the seeded snapshot; the code this change extends.
- [mcp-freshness-check-for-a-new-key-stales-the-whole-tool](../design-patterns/mcp-freshness-check-for-a-new-key-stales-the-whole-tool.md) — same subsystem, same class: an MCP freshness gate producing a wrong staleness verdict for a reason outside its stated design.
- [multi-source-freshness-clock-must-reduce-with-min](../design-patterns/multi-source-freshness-clock-must-reduce-with-min.md) — the freshness-clock design pattern this producer defect violates from another angle (a clock that advances while content does not).
- [sentry-noise-filtering-with-stack-gating-and-signature-matching](./sentry-noise-filtering-with-stack-gating-and-signature-matching.md) — the repo's general Sentry-triage craft reference; this doc adds the periodicity-attribution technique.
