import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

function functionBody(name) {
  const start = relay.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const next = relay.indexOf('\nfunction ', start + 1);
  return relay.slice(start, next >= 0 ? next : relay.length);
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
    assert.match(functionBody('publishXSnapshot'), /fetchedAt: xState\.lastPollAt/);
    assert.match(functionBody('publishXSnapshot'), /const meta = accountsPolled > 0/);
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });
});
