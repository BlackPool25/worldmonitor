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
    assert.match(functionBody('publishXSnapshot'), /if \(!\(accountsPolled > 0\)\) return true/);
    assert.match(functionBody('startXPollLoop'), /sourceState: 'unavailable'/);
  });

  it('aborts and force-clears a stuck in-flight poll before starting a new generation', () => {
    const guard = functionBody('guardedXPoll');
    assert.match(guard, /force-clearing in-flight flag/);
    assert.match(guard, /xPollAbortController\?\.abort/);
    assert.match(guard, /generation !== xState\.generation/);
  });

  it('refreshes seed metadata after any successful account poll', () => {
    assert.match(functionBody('pollXOnce'), /publishXSnapshot\(accounts\.length, \{[\s\S]*cycleComplete: next\.cycleComplete[\s\S]*accountsPolled: next\.accountsPolled/);
    assert.match(functionBody('publishXSnapshot'), /fetchedAt: xState\.lastPollAt/);
    assert.match(functionBody('publishXSnapshot'), /if \(!\(accountsPolled > 0\)\) return true/);
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });
});
