---
title: "Corroboration counts publisher families, not feed labels"
date: 2026-08-10
category: best-practices
module: "World Brief gates, digest scoring, corroboration badges (#6428)"
problem_type: best_practice
component: digest_ranking
severity: high
applies_when: "Counting how many independent sources carried a story — a brief gate, a ranking boost, or an N-sources badge"
status: adopted-publisher-family-counting
tags: [corroboration, syndication, publisher-family, world-brief, ranking, replay-log]
---

# Corroboration counts publisher families, not feed labels

## Decision

**Every corroboration count reads distinct publisher families. `cluster.sources` stays the feed-label list for attribution and links, and is never counted directly.** The brief-lead threshold stays at **2 publishers**, chosen from the measurement below rather than carried over by default.

This is the correctness prerequisite that [source-label RRF needs independent corroboration](./source-label-rrf-needs-independent-corroboration.md) identified as missing. That record rejected a *new* ranking method for relying on label breadth; the two gates already shipping relied on exactly the same signal.

## What was wrong

`cluster.sources` is a list of deduplicated feed labels (`scripts/_clustering.mjs`). Nothing mapped a label to a publisher, and WorldMonitor runs many feeds per newsroom — nine BBC editions, eight Reuters desks, four CNBC verticals. Every count built on that list read one newsroom's own editions as that many independent sources:

| Consumer | Counted | Consequence |
| --- | --- | --- |
| `isBriefLeadEligible` | feed labels ≥ 2 | two editions of one newsroom cleared "corroboration as a hard requirement, not a tiebreaker" |
| `publisherCount` (now `publisherFamilyCount`) | max of three label counts | up to 72 ranking points for one publisher's breadth |
| `assignStoryIdentity` (`dedup.mjs`) | `Set` of labels | inflated `corroborationCount` → `importanceScore` (5 sources × 20 pts) |
| `computeEntityCorroborationSignals` | `Set` of labels | manufactured entity corroboration, which is the gate's *second* arm |
| `uniqueSourceCount`, "✓ N sources", "N sources", MULTI-SOURCE, CSV `Sources` | labels — or worse, **articles** | the number shown to a user overstated independence |

The client badges were the worst case: they read `sourceCount`, the **article** count, so one outlet republishing itself rendered as two sources.

## Measurement

Two harnesses, because they answer different questions. Each computes both variants from **one** corpus per sample — the digest rotates, so measuring "before" and "after" in separate runs would compare different news.

**1. Retained replay log** (`digest:replay-log:v1:full:en:all:*`) — 5 days spanning 3 weeks, 683 ticks, 279,390 representative stories. Same `sources` label semantics; the population is the digest's dedup representatives rather than seed-insights' clusters.

| Metric | Labels ≥ 2 (before) | Families ≥ 2 (adopted) | Families ≥ 3 |
| --- | --- | --- | --- |
| Stories counted as corroborated | 60,964 (21.8%) | 40,557 (14.5%) | 18,005 (6.4%) |
| Ticks with ≥ 1 corroborated story | 100.0% | 99.9% | 99.9% |

**33.5% of everything the old gate called corroborated was a single publisher.** The most frequent offenders, by occurrence:

| Count | Label set | One publisher |
| --- | --- | --- |
| 9,162 | `Hacker News` + `YC News` | Hacker News (`news.ycombinator.com`) |
| 2,965 | `CNBC` + `CNBC Markets` | CNBC |
| 1,958 | `The Verge` + `The Verge AI` | The Verge |
| 1,144 | `Yahoo Finance` + `Yahoo Finance Commodities` | Yahoo Finance |
| 375 | `Reuters Business` + `Reuters Energy` | Reuters |

**2. Live pipeline** — the current `news:digest:v1:full:en` replayed through the real `clusterItems` → `selectTopStories` → `pickBriefCluster`. 282 items, 255 clusters: corpus-eligible clusters fall 13 → 8 at families ≥ 2, and a brief lead remains available. Five of the thirteen were one publisher, including `["Reuters US","Reuters Asia"]` and `["BBC Middle East","BBC World"]`.

## Why the threshold stays at 2

Two genuinely independent publishers is a strictly stronger bar than two labels, so the same number rejects more — which is the point. The measurement shows what each candidate threshold costs:

- **Families ≥ 2** removes 33.5% of false corroboration at a publication-rate cost of 0.1 percentage points (one tick in 683 lost its only corroborated story).
- **Families ≥ 3** buys no additional publication-rate headroom (also 99.9%) but shrinks the eligible pool 3.4× further, to 6.4% of stories. [#5947](https://github.com/koala73/worldmonitor/issues/5947) is the record of what a thin eligible pool costs: 35 consecutive dark briefs. Paying that risk for no measured gain is the wrong trade.

Raising the bar again is a decision for after the map covers cross-publisher syndication (below), not before.

## The map, and how it fails

`shared/publisher-families.json` curates label → family. `shared/publisher-families.js` resolves it and **fails closed in the direction that never invents independence**: an unmapped label becomes its own namespaced family (`label:<name>`), so a new feed is never silently folded into another publisher's byline, and never disappears from the count either — it simply cannot corroborate anything but itself.

Curated data rots both ways, so `tests/publisher-families.test.mjs` locks both:

- **Dead entries** — a mapped label no feed config declares is a rename or a typo that silently stopped merging its publisher.
- **Missing entries** — any two feed labels resolving to the same publisher host must land in one family. This is derived from the feed configs, so the next feed added for a publisher already in the map fails the test instead of quietly inflating a count. It earned its keep immediately: it caught a Yahoo Finance pair the hand-written map missed.

Aggregator hosts (`news.google.com`, feedburner, megaphone) are excluded from that invariant — two labels sharing a syndication transport prove nothing about the publisher, so those merges are curated by hand or left separate.

## Known limit: cross-publisher syndication

This map collapses **one publisher's own labels**. It cannot see that an unrelated outlet reprinted a Reuters wire, because the feed label carries no information about the wire: the ingest parser stamps `item.source = feed.name` and drops the RSS `<source>` element that names the originating publisher. Recovering that is a parser change, not a map change, and it is tracked separately. Until then a corroboration count is an upper bound on independence — a much tighter one than before, but still an upper bound.

The same limit applies to the ~87 keyword-query Google News feeds ("Oil & Gas", "AI News"), which identify a *query*, not a publisher. Where such a feed is named after a publisher (`Reuters Crypto`, `Bloomberg Crypto`, `a16z Insights`) it is folded into that publisher's family — the conservative direction. The rest stay their own family under the fail-closed default.

## Related

- [source-label-rrf-needs-independent-corroboration](./source-label-rrf-needs-independent-corroboration.md) — the record that named this failure mode and deferred [#5991](https://github.com/koala73/worldmonitor/issues/5991) for it
- [#5947](https://github.com/koala73/worldmonitor/issues/5947) — why the brief reserves a slot for a corroborated cluster, and why the eligible pool must not go thin
- [#5981](https://github.com/koala73/worldmonitor/issues/5981) — entity-resolution-first correlation epic
