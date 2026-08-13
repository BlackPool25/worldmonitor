import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  acquire511Slot,
  create511RateLimiter,
  reset511RateLimiterForTests,
} from '../scripts/_511-rate-limit.mjs';

const SEEDER_SOURCE = readFileSync(new URL('../scripts/seed-provincial-511.mjs', import.meta.url), 'utf8');
const ADAPTER_SOURCE = readFileSync(new URL('../scripts/lib/provincial-511.mjs', import.meta.url), 'utf8');
const RELAY_SOURCE = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');

describe('per-host 511 limiter (#6618 v1)', () => {
  it('does not import the seeder from tests', () => {
    const self = readFileSync(new URL(import.meta.url), 'utf8');
    assert.equal(/from ['"][^'"]*seed-provincial-511/.test(self), false);
    assert.equal(self.includes('seed-provincial-511.mjs'), true, 'fixture: this file must still mention the seeder as text');
  });

  it('11th call for the same host waits; a different host has its own bucket', async () => {
    let nowMs = 1_000;
    const sleeps = [];
    const limiter = create511RateLimiter({
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
    });

    for (let i = 0; i < 10; i++) {
      await limiter.acquire511Slot('511on.ca');
    }
    assert.equal(limiter.pendingCount('511on.ca'), 10);
    assert.equal(limiter.pendingCount('511.alberta.ca'), 0);

    const eleventh = limiter.acquire511Slot('511on.ca');
    await eleventh;
    assert.ok(sleeps.length >= 1, '11th same-host call must wait for the window');
    assert.equal(sleeps[0], 60_000);

    sleeps.length = 0;
    await limiter.acquire511Slot('511.alberta.ca');
    assert.equal(sleeps.length, 0, 'a different host must not share the Ontario bucket');
  });

  it('three Ontario resources consume 3 tokens of the 511on.ca bucket', async () => {
    reset511RateLimiterForTests();
    await acquire511Slot('511on.ca');
    await acquire511Slot('511on.ca');
    await acquire511Slot('511on.ca');
    // BC Open511 is a different host and must not wait on Ontario's 3 tokens.
    const started = Date.now();
    await acquire511Slot('api.open511.gov.bc.ca');
    assert.ok(Date.now() - started < 50, 'BC host must not share the Ontario bucket');
  });

  it('adapter acquires the Ontario host slot before each fetch', () => {
    assert.match(ADAPTER_SOURCE, /acquire511Slot\(hostname\)/);
    assert.match(ADAPTER_SOURCE, /511on\.ca/);
    assert.doesNotMatch(ADAPTER_SOURCE, /open511\.gov\.bc/);
    assert.doesNotMatch(ADAPTER_SOURCE, /from ['"]\.\.\/\.\.\/shared\//);
  });

  it('seeder is a standalone nixpacks job and does not loop ais-relay', () => {
    assert.match(SEEDER_SOURCE, /fetchVendor511\(ONTARIO_511/);
    assert.match(SEEDER_SOURCE, /zeroIsValid:\s*true/);
    assert.match(SEEDER_SOURCE, /infra:ontario-511:v1/);
    assert.doesNotMatch(RELAY_SOURCE, /511on\.ca/);
    assert.doesNotMatch(RELAY_SOURCE, /ontario-511/);
    assert.doesNotMatch(RELAY_SOURCE, /canadaRoads/);
  });
});
