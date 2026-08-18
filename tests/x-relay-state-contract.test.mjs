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
    assert.match(functionBody('publishXSnapshot'), /if \(!dataWritten\)[\s\S]*if \(!cycleComplete\) return true;[\s\S]*X_FEED_META_KEY/);
  });

  it('does not clear a stuck in-flight poll or admit an overlapping generation', () => {
    const guard = functionBody('guardedXPoll');
    assert.match(guard, /if \(xPollInFlight\)[\s\S]*return;/);
    assert.doesNotMatch(guard, /force-clearing|xPollInFlight = false;[\s\S]*else/);
    assert.match(guard, /generation !== xState\.generation/);
  });

  it('refreshes seed metadata only for a complete coverage cycle', () => {
    assert.match(functionBody('pollXOnce'), /publishXSnapshot\(accounts\.length, next\.cycleComplete\)/);
    assert.match(functionBody('publishXSnapshot'), /if \(!cycleComplete\) return true;/);
  });

  it('lets RPC request tombstones while the first-party default hides them', () => {
    assert.match(relay, /includeDeleted = url\.searchParams\.get\('includeDeleted'\) === '1'/);
    assert.match(relay, /if \(!includeDeleted && it\.contentState === 'deleted'\) return false/);
  });
});
