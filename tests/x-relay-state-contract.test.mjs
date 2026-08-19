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
    assert.match(relay, /stuckAfterMs: X_POLL_INTERVAL_MS \+ 60_000/);
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
