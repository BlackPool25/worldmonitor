---
title: "A unique match is not an identity: verify attribution against an authoritative field"
date: 2026-07-28
category: conventions
module: intelligence company resolution (SEC EDGAR)
problem_type: convention
component: service_object
severity: high
applies_when:
  - "Re-enabling an endpoint that was disabled because it produced fabricated or misattributed data"
  - "Resolving a user-supplied identifier (domain, name, slug, email host) to a real-world entity"
  - "Reviewing code where a lookup falls back from an exact key to a fuzzy or prefix match"
  - "A resolver returns a single candidate and the caller treats singularity as proof of correctness"
  - "Deciding what an entity lookup should return when it cannot confirm a match"
related_components:
  - service_object
  - testing_framework
tags:
  - attribution
  - entity-resolution
  - fail-closed
  - fabricated-data
  - mutation-testing
  - sec-edgar
---

# A unique match is not an identity: verify attribution against an authoritative field

## Context

WorldMonitor's `get-company-enrichment` and `list-company-signals` RPCs were deliberately
disabled in PR #3777 (issues #3754/#3755) because they **fabricated** company intelligence:
they guessed a code-host org from a domain label and attributed whatever that guessed
identity returned. Any domain whose label collapsed to an unrelated org slug was assigned
someone else's footprint. The handler doc block set the bar for re-enabling:

> Re-enable only behind a verified attribution model (maintained company-to-code-host
> registry plus proper filer-CIK matching), never with another domain-slug heuristic.

Issue #5695 asked for the real data product. The obvious reading of that bar — "resolve
through an authoritative registry instead of guessing" — is necessary but **not sufficient**,
and the gap is subtle enough that it survived several rounds of self-review.

## Guidance

When resolving a user-supplied identifier to an entity, **uniqueness of the match is not
evidence that the match is correct.** Treat a non-exact match as *provisional* until it is
confirmed against a field the authoritative source itself publishes about that entity.

Concretely, the resolution ladder that shipped:

```ts
// ticker: exact key in the SEC registry — authoritative, done.
if (ticker) return map[ticker] ? { ...entry, matchedBy: 'ticker' } : null;

// name: exact title, else a prefix match that is UNIQUE ACROSS FILERS.
// An ambiguous prefix resolves to NOTHING — picking the "most canonical"
// title is a coin flip between two real companies.
if (name) return matchByName(map, name, { requireUnique: true, matchedBy: 'name' });

// domain: matched the same way, but the result is PROVISIONAL.
if (domain) return matchByName(map, label, { requireUnique: true, matchedBy: 'domain' });
```

and then, in each handler, the confirmation step that makes the domain path safe:

```ts
// A domain match is provisional: a unique name-prefix hit is not proof of
// identity. Confirm it against the filer's SEC-registered website, or return
// nothing rather than attribute another company's filings (#3754/#3755).
if (resolved.matchedBy === 'domain'
    && !filerWebsiteMatchesDomain(domain ?? '', submissions?.website ?? '')) {
  return unresolved(ticker, name, domain);
}
```

The confirmation helper **fails closed** — an absent or unparseable website means "cannot
confirm", never "close enough":

```ts
export function filerWebsiteMatchesDomain(requestedDomain: string, filerWebsite: string): boolean {
  const requested = normalizeHost(requestedDomain);
  const filer = normalizeHost(filerWebsite);
  if (!requested || !filer) return false;          // cannot confirm -> refuse
  return requested === filer
    || filer.endsWith(`.${requested}`)
    || requested.endsWith(`.${filer}`);
}
```

Three rules generalize out of this:

1. **Rank match strength and carry it in the return value.** `matchedBy: 'ticker' | 'name' |
   'domain'` lets the caller apply confirmation only where it is needed, instead of every
   caller re-deriving how the match was made (or forgetting to).
2. **Ambiguity resolves to nothing, never to a tie-break.** Sorting candidates by title
   length and taking the first is a guess wearing a heuristic's clothing.
3. **Confirm against a field the authority publishes about the entity**, not against a
   restatement of the input. The SEC registry supplies the candidate; the SEC *submissions*
   record supplies the independent website used to confirm it.

## Why This Matters

`requireUnique: true` alone feels like it closes the hole, and it closes the *ambiguous*
case — but not the **wrong single match**, which is the one that actually ships bad data:

- `delta.com` prefix-matches exactly one filer named `Delta Apparel Inc` (Delta Air Lines
  files under a different name). Unique. Confidently wrong.
- The caller receives a well-formed envelope with a real CIK, real filings, and a real
  market cap — all belonging to a company the user never asked about.

That is indistinguishable, from the outside, from the fabrication that got these endpoints
disabled in the first place. A resolver that returns *nothing* is a visible gap a caller can
handle; a resolver that returns *the wrong company* is a silent data-integrity failure that
looks like success.

This is the same failure shape already documented in this repo:
[a permissive default that leaked unattributed alerts](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md)
(fixed by inverting to default-DROP + explicit allowlist) and
[authority-gated seed sources](../integration-issues/authority-gated-cyclone-seed-sources.md)
(never infer identity/equivalence from a name match alone). The recurring lesson is that
**identity inference must be admitted explicitly, not fallen into by default.**

## When to Apply

Apply the provisional-match-plus-confirmation shape when **all** of these hold:

- The input is user-supplied and low-precision (a domain, a display name, a slug)
- The lookup can succeed with a single candidate without that candidate being right
- Being wrong produces confident, well-formed output rather than a visible error

Skip it when the identifier is an exact key in the authority's own namespace (a ticker, a
CIK, a UUID) — there is nothing to confirm.

If no authoritative confirmation field exists at all, the honest options are to drop the
lookup path or to return the candidate **clearly marked as unconfirmed**. Do not ship an
unmarked guess.

## Examples

Prove the guard with mutation, not with a passing test. A test that passes both with and
without the guard is not coverage — and this class of guard is especially easy to write
tests around that never exercise it. Neutering the condition must turn the tests red:

```
# guard neutered:  if (false && resolved.matchedBy === 'domain' && !filerWebsiteMatchesDomain(...))
✖ refuses a unique-but-unconfirmed domain match (wrong-company attribution guard)
✖ refuses an unconfirmed domain match for signals too
ℹ pass 31   ℹ fail 2

# guard restored:
ℹ pass 33   ℹ fail 0
```

The behavioral test states the failure in terms of attribution, not mechanics:

```ts
it('refuses a unique-but-unconfirmed domain match (wrong-company attribution guard)', async () => {
  // "zebrafields" uniquely prefix-matches Zebrafields Corp in the registry,
  // but that filer's registered website is a different company — the exact
  // wrong-attribution shape from #3754/#3755. Must resolve to nothing.
  installFetchMock({
    submissions: { ...SUBMISSIONS_FIXTURE, name: 'Zebrafields Corp', website: 'https://www.someone-else.example' },
    profile: { name: 'Zebrafields Corp', exchange: 'NYSE' },
  });
  const resp = await getCompanyEnrichment(ctx, { ticker: '', name: '', domain: 'zebrafields.example' });
  assert.deepEqual(resp.sources, [], 'no source may be attributed on an unconfirmed domain match');
  assert.equal(resp.company?.cik, '');
});
```

Two independent adversarial reviewers on **different model families** (Codex and an Opus
in-process reviewer) converged on this same finding — the strongest signal in an 11-reviewer
pass, and worth more than agreement among reviewers sharing a model. Both phrased it the
same way: uniqueness had been mistaken for proof.

Shipped in PR #5738 (issue #5695). See also
[mutation-test every detection layer](verify-the-verifier-mutation-test-every-detection-layer.md)
for why the mutation step above is non-optional.
