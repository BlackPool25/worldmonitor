---
title: "A fail-open guard that formats untrusted input can throw, becoming a worse outage than the bug it guards"
date: 2026-08-05
problem_type: logic_error
category: logic-errors
module: seed-military-flights
component: opensky-cooldown
severity: high
tags:
  - fail-open
  - guard-clauses
  - untrusted-input
  - date-range
  - redis
  - seeders
symptoms:
  - "A corrupt cached value makes an entire scheduled run publish nothing, on every tick"
  - "RangeError: Invalid time value from a guard clause that was written to ignore that value"
  - "Railway reports the run SUCCESS while no data is published"
root_cause: "The reject-this-value branch formatted the untrusted value with new Date(n).toISOString(), which throws past the ECMAScript Date range; Number.isFinite admits such values, and the function ran outside any caller's try"
resolution_type: code_fix
related_issues:
  - 6241
related_prs:
  - 6252
---

# A fail-open guard that formats untrusted input can throw

## Problem

`scripts/seed-military-flights.mjs` persists an OpenSky 429 cooldown deadline to Redis so a
one-shot cron process can skip a doomed upstream call (#6241). The reader had an explicit
"this deadline is nonsense, ignore it" branch — the guard whose entire purpose was to stop a
corrupt record from disabling a data tier.

That branch could throw, and the throw was not contained. A corrupt record would have killed
the whole run — Wingbits included — every 5 minutes, forever.

## Symptoms

- The seed run publishes nothing at all, not even from upstreams unrelated to the guarded one.
- `RangeError: Invalid time value` from the branch written to *ignore* the bad value.
- Railway reports the deployment green; only the TTL-extension path runs, so cached data ages
  out silently.

## What Didn't Work

The original guard *looked* correct and had a passing test:

```js
if (remainingMs > OPENSKY_MAX_COOLDOWN_MS) {
  console.warn(`ignoring implausible cooldown deadline ${new Date(until).toISOString()}`);
  return { remainingMs: 0, recordPresent: true };  // fail open
}
```

The test seeded a deadline ten years out and asserted the upstream call still happened. It
passed. Ten years is ~2.1e12 ms — comfortably inside the JS `Date` range, so the fixture never
reached the throwing case. A mutation sweep that deleted the guard also "killed" its mutant,
which made the coverage look real.

## Solution

Two independent fixes, both applied:

```js
async function readOpenSkyCooldown() {
  const creds = getOptionalRedisCredentials();
  if (!creds) return { remainingMs: 0 };
  try {                                    // (2) try wraps the WHOLE body, not just the I/O
    const record = await redisGet(creds.url, creds.token, OPENSKY_COOLDOWN_KEY);
    const until = Number(record?.until);
    if (!Number.isFinite(until)) return { remainingMs: 0 };
    const remainingMs = until - Date.now();
    if (remainingMs > OPENSKY_MAX_COOLDOWN_MS) {
      // (1) log the RAW number — never format an untrusted value as a Date
      console.warn(`ignoring implausible cooldown deadline ${until}`);
      return { remainingMs: 0 };
    }
    return { remainingMs: Math.max(0, remainingMs) };
  } catch (err) {
    console.warn(`cooldown read failed, proceeding without it: ${err.message || err}`);
    return { remainingMs: 0 };
  }
}
```

And a fixture that actually reaches the case:

```js
// 1.78e18 — a nanosecond-scale timestamp. Number.isFinite admits it;
// new Date(1.78e18).toISOString() throws RangeError.
seedCooldown({ until: 1.78e18 });
```

## Why This Works

`Number.isFinite()` is not a range check. It admits every float up to ~1.8e308, while the
ECMAScript `Date` range is ±8.64e15 ms (about ±273,790 years). Any value between those two
bounds passes the finite check and then throws inside `toISOString()`.

That gap is not exotic. A writer that emits a nanosecond- or microsecond-scale timestamp lands
squarely in it — `Date.now() * 1e6` is 1.78e18.

The second fix matters independently: the guard's caller invoked
`readOpenSkyCooldown()` *outside* its own `try`, so the throw escaped `fetchOpenSkyGlobal`,
escaped `fetchAllStates`, and hit the top-level handler that abandons the publish and only
extends TTLs. A guard that runs before a `try` must contain its own failures.

## Prevention

**When writing a fail-open path, audit it for its own throw.** The branch that handles the bad
input is running *on* the bad input. Every formatter, parser, and constructor in it is reachable
with adversarial values. Ask: "if this value is hostile, does my rejection of it also fail?"

Specific rules this produced:

1. **Never format an untrusted number as a `Date`.** Log the raw value. `new Date(n).toISOString()`
   and `new Date(n).toLocaleString()` throw on out-of-range input; string interpolation never does.
2. **`Number.isFinite()` is not a domain check.** Pair it with the actual bound the consumer needs
   (`Math.abs(n) <= 8.64e15` for dates).
3. **Wrap the whole body, not just the I/O call.** A `try` around only the network call leaves the
   parsing of what it returned unprotected — and the parsing is what handles untrusted data.
4. **Size the fixture to the branch, not to the story.** "Absurd" in prose was ten years; "absurd"
   to the code was 8.64e15. A test whose fixture cannot reach the branch it names is green for the
   wrong reason.

Test that pins it:

```js
assert.ok(
  allStates.map((s) => s[0]).includes(WINGBITS_ONLY),
  'A corrupt deadline killed the whole run instead of being ignored.',
);
```

Asserting the *unrelated* upstream still published is what distinguishes "the guard failed open"
from "the guard threw" — asserting only that the guarded call happened cannot tell them apart.

## Related

- [OpenSky bbox area billing has a flat top tier](../integration-issues/opensky-bbox-area-billing-flat-top-tier.md) — the #6222 credit-spend fix this cooldown is the residual of.
- [Checks must fail closed when they lose their target](../best-practices/checks-must-fail-closed-when-they-lose-their-target.md) — the mirror case. Direction depends on blast radius: a *verification* check that loses its target must fail closed; a *cooldown* that loses its state must fail open, because the worst case of failing open is one wasted request while failing closed deletes a data tier.
