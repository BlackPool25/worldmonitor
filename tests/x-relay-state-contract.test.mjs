import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function functionBody(name) {
  const start = relay.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  // Every function in this file is top-level, but most are `async function`.
  // Terminating only on `\nfunction ` made an async declaration invisible as an
  // end marker, so a body ran on through every async function that followed it
  // — publishXSnapshot's "body" swallowed pollXOnce, and any assertion here
  // could be satisfied by code in a different function. Stop at the next
  // top-level declaration of either kind.
  const rest = relay.slice(start + 1);
  const offsets = ['\nfunction ', '\nasync function ']
    .map((marker) => rest.indexOf(marker))
    .filter((index) => index >= 0);
  const next = offsets.length ? Math.min(...offsets) : -1;
  return next >= 0 ? rest.slice(0, next) : rest;
}

describe('X relay state and health contract', () => {
  it('hydrates before the first poll and publishes the versioned serving snapshot', () => {
    assert.match(functionBody('startXPollLoop'), /await hydrateXState\(\)/);
    assert.match(functionBody('publishXSnapshot'), /buildXFeedSnapshot/);
    assert.match(functionBody('publishXSnapshot'), /buildXPollState/);
    assert.match(functionBody('publishXSnapshot'), /X_FEED_POLL_STATE_KEY/);
    assert.match(functionBody('publishXSnapshot'), /accountsPolled > 0/);
    assert.doesNotMatch(functionBody('startXPollLoop'), /sourceState: 'unavailable'/);
    assert.match(functionBody('pollXOnce'), /upstashSetNx\(X_FEED_POLL_LOCK_KEY/);
    assert.match(functionBody('pollXOnce'), /upstashReleaseLockIfOwner\(X_FEED_POLL_LOCK_KEY/);
    assert.match(functionBody('publishXSnapshot'), /upstashPublishXIfLockOwner/);
    assert.match(functionBody('startXPollLoop'), /xState\.lastPollAt \+ X_POLL_INTERVAL_MS/);
    assert.match(functionBody('startXPollLoop'), /xState\.rateLimitedUntil/);
  });

  it('aborts and force-clears a stuck in-flight poll before starting a new generation', () => {
    assert.match(relay, /createPollGenerationGuard/);
    assert.match(relay, /stuckAfterMs: X_POLL_STUCK_AFTER_MS/);

    // The guard's run counter must NOT be xState.generation. That field is the
    // persisted snapshot version, and hydrateXState rewrites it from Redis in
    // the middle of a live poll (lease conflict, hydration retry) — which
    // retired the generation the guard was fencing on, so its `.finally` never
    // cleared inFlight and the next tick skipped a whole cycle.
    assert.match(relay, /let xPollGeneration = 0;/);
    assert.match(relay, /getGeneration: \(\) => xPollGeneration/);
    assert.match(relay, /setGeneration: \(generation\) => \{ xPollGeneration = generation; \}/);
    assert.doesNotMatch(relay, /getGeneration: \(\) => xState\.generation/);
    assert.doesNotMatch(functionBody('pollXOnce'), /generation !== xState\.generation/);

    // The abort has to fire while the Redis lease is still held, and the guard is
    // only re-evaluated when a scheduled tick calls it — so the threshold must
    // sit below the CADENCE, not merely below the lease TTL: nothing evaluates it
    // in between, so a value in that gap never fires at all. Execute the two
    // definitions we actually ship across the clamp range instead of pinning
    // their literals, so a re-tune of either cannot drift them apart.
    const leaseExpression = /const X_FEED_POLL_LOCK_TTL_SECONDS = ([^;]+);/.exec(relay);
    const stuckExpression = /const X_POLL_STUCK_AFTER_MS = ([^;]+);/.exec(relay);
    assert.ok(leaseExpression && stuckExpression, 'lease TTL and stuck threshold must both be named constants');
    const evaluate = (expression, intervalMs) => new Function('X_POLL_INTERVAL_MS', `return (${expression});`)(intervalMs);
    for (const intervalMs of [5 * 60_000, 10 * 60_000, 15 * 60_000]) {
      const stuckAfterMs = evaluate(stuckExpression[1], intervalMs);
      const leaseMs = evaluate(leaseExpression[1], intervalMs) * 1000;
      assert.ok(stuckAfterMs > 0, `stuck threshold must stay positive at a ${intervalMs}ms cadence`);
      assert.ok(stuckAfterMs < intervalMs, `stuck threshold must fire on the next tick at a ${intervalMs}ms cadence`);
      assert.ok(stuckAfterMs < leaseMs, `stuck threshold must fire before the lease lapses at a ${intervalMs}ms cadence`);
    }
  });

  it('refreshes seed metadata after any successful account poll', () => {
    assert.match(functionBody('pollXOnce'), /publishXSnapshot\(accounts\.length, \{[\s\S]*cycleComplete: next\.cycleComplete[\s\S]*accountsPolled: next\.accountsPolled/);
    // fetchedAt still comes from the poll timestamp, now via the candidate state
    // publishXSnapshot is handed (defaulting to xState) rather than reading the
    // live object — publish has to run BEFORE the commit, so it cannot read
    // xState for this value.
    assert.match(functionBody('publishXSnapshot'), /fetchedAt: state\.lastPollAt/);
    assert.match(functionBody('publishXSnapshot'), /state = xState/);
    assert.match(functionBody('publishXSnapshot'), /const meta = accountsPolled > 0/);
  });

  it('treats Redis as the source of truth, not the in-memory poll state', () => {
    const poll = functionBody('pollXOnce');
    const hydrate = functionBody('hydrateXState');

    // A failed GET is not an empty feed: hydration fails closed, and a poll will
    // not publish over last-good state it could not read.
    assert.match(hydrate, /readFailed/);
    assert.match(hydrate, /hydrationFailed = true/);
    assert.match(poll, /xState\.hydrationFailed/);

    // Cursors are re-read under the lock so a stale replica cannot write its
    // whole stale cursor map back over a peer's newer one.
    assert.match(poll, /upstashGet\(X_FEED_POLL_STATE_KEY/);

    // The serving snapshot is re-read with them. Poll state deliberately carries
    // no items, so without this a replica that lost the lease republishes the
    // item set it hydrated BEFORE the holder published — dropping that peer's
    // posts for good, because the cursors it just read have already advanced
    // past their ids and they are never re-fetched.
    assert.match(poll, /upstashGet\(X_FEED_CACHE_KEY/);
    assert.match(poll, /mergeAndDedup\(xState\.items/);

    // A 429 backoff this process just recorded must not be cleared by an older
    // Redis copy: hydrateXState also runs mid-poll, so it takes the LATER
    // deadline and the HIGHER attempt count, matching mergeRefreshedPollState.
    assert.match(hydrate, /rateLimitedUntil = Math\.max\(/);
    assert.match(hydrate, /rateLimitAttempt = Math\.max\(/);

    // A lock-loser refreshes instead of serving frozen process-local items.
    assert.match(poll, /shared lease is[\s\S]*?await hydrateXState\(\)/);

    // Publish precedes commit; the old order must not come back.
    assert.match(poll, /const published = await publishXSnapshot/);
    assert.match(poll, /Object\.assign\(xState, candidate\)/);
    assert.doesNotMatch(poll, /xState\.items = next\.items;[\s\S]*?await publishXSnapshot/);
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });
});
