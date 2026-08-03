---
title: Hardening one side of a parity contract re-opens the divergence it was meant to close
date: 2026-08-03
category: best-practices
module: api/mcp, api/health.js
problem_type: best_practice
component: testing_framework
severity: high
applies_when:
  - "A change's thesis is that two surfaces must agree about the same underlying key or record"
  - "Applying a review fix that makes one side of an agreeing pair stricter or more fail-closed"
  - "Two consumers reach the same shared assessor through independently-written gates"
  - "Writing tests for a contract whose correctness is a property of a pair, not of either half"
tags:
  - parity
  - fail-closed
  - cross-surface-agreement
  - mutation-testing
  - review-fixes
  - health-monitoring
  - mcp
---

# Hardening one side of a parity contract re-opens the divergence it was meant to close

## Context

[#6080](https://github.com/koala73/worldmonitor/issues/6080) existed because two surfaces disagreed about one seed-meta key: `/api/health` reported `STALE_CONTENT` for PortWatch port activity while the MCP freshness envelope over the same key reported `stale: false`. The fix taught MCP to evaluate the same per-country content dimension through the same shared assessor (`api/_content-freshness.js`).

Review found three fail-opens in that first implementation. The most important: a failed read of the durable activation marker was swallowed to `null`, which read as "not activated", which **granted the deployment-order grace** — so a single Redis blip relabelled a real producer regression as deploy lag. The fix made MCP's activation state three-valued, requiring positive proof before granting grace (`api/mcp/freshness.ts:26`, `:73`).

That fix introduced a **new** divergence in the exact dimension the PR existed to close.

`/api/health` cannot distinguish a marker it failed to read from one that is genuinely absent — both land in the same bucket:

```js
// api/health.js:2026
if (!r?.error && Number(r?.result) === 1) activatedNames.add(activationEntries[i][0]);
```

An errored read simply never enters the set, and `contentFreshnessPending` then tests `!activatedNames.has(...)`, so the grace is granted. After the hardening, for a pre-activation key whose marker read errors, health reports `OK` while MCP reports `stale: true`.

## Guidance

**When a change's thesis is "surfaces A and B must agree", correctness is a property of the pair. Test it as a pair, and re-ask the agreement question against every fix.**

Three concrete practices:

1. **Write the joint loop before hardening anything.** A test that drives the full input space through *both* surfaces and asserts they agree. Hardening one side is then what turns it red, at the moment you do it.

2. **After applying any review fix to a parity-shaped change, ask literally: "which input class does my fix now treat differently from the other side?"** The strengthened guard is precisely the region where the other side's behavior was never re-examined.

3. **When the surfaces must genuinely differ, encode the weaker invariant that is actually true** rather than keeping a parity claim that has become false. Here the shipped assertion is one-directional and testable:

```js
// tests/mcp-portwatch-content-freshness-parity.test.mjs:587
it('never diverges in the unsafe direction', () => {
  for (const activated of [true, false, null]) {
    for (const meta of [STALE_CONTENT_META, FRESH_META, NO_BLOCK]) {
      const healthStale = healthVerdict(meta, { activated: activated === true }).status !== 'OK';
      if (!healthStale) continue;
      assert.equal(mcpStale(meta, { activated }), true,
        `MCP reported fresh where health alarmed (activated=${activated})`);
    }
  }
});
```

"They cannot disagree" was false. "MCP never answers fresh where health alarms" is true, is the property that actually matters, and survives the deliberate asymmetry.

## Why This Matters

**Per-side verification is structurally blind to this class of bug.** The first fix passed a 14-mutant sweep and 174 tests. Every one of them compared MCP against *fixtures*; not one compared MCP against *health* on the newly-hardened input class. Mutation testing proves a guard is load-bearing within its own surface — it says nothing about whether two surfaces still answer alike.

Two reviewers found it independently. Without them it would have shipped as a regression in the very dimension the PR was named for.

**The direction of a divergence matters more than its existence.** Reverting MCP to match health would have restored a fail-open two other reviewers had flagged. The right resolution was to keep the safer behavior, document the asymmetry with its direction, pin it with a test, and file the alignment work as [#6095](https://github.com/koala73/worldmonitor/issues/6095) — never to leave it undocumented while the PR body claimed parity.

**A grace granted on absence of evidence never expires.** "Marker missing → assume pre-activation → stay quiet" cannot tell a rollout window from an evicted key. Grace must require a positive read; unknown must fail closed.

## When to Apply

- Any change whose purpose is agreement between two consumers of one source of truth — health vs MCP, an alarm vs the data gate it protects, an API vs its cached projection.
- Any review round on such a change, especially one that makes a guard *stricter*.
- When two consumers share an assessor but reach it through independently-written gates: the shared code does not make the gates agree.

## Examples

Verification that would have caught it, versus verification that did not:

```js
// Did NOT catch it — asserts MCP against a fixture. Both the mutation sweep
// and the pre-review suite were built entirely from this shape.
assert.equal(mcpStale(NO_BLOCK_META, { activated: null }), true);

// WOULD have caught it — asserts the two surfaces against each other on the
// input class the hardening changed.
assert.equal(healthVerdict(NO_BLOCK, { activated: false }).status, 'OK');
assert.equal(mcpStale(NO_BLOCK, { activated: null }), true);
// ^ these now disagree; the test forces that to be a deliberate, documented
//   decision instead of an unnoticed regression.
```

A related trap from the same work: after switching the marker read from `GET` to `EXISTS`, a test asserting "the marker's stored *value* is irrelevant" became unfalsifiable — no code path read that value any more. It was removed rather than left as coverage theatre. See [checks-must-fail-closed-when-they-lose-their-target](./checks-must-fail-closed-when-they-lose-their-target.md).
