import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { TierPreferenceHandoff } from '../src/app/tier-preference-handoff';

/**
 * Deterministic timer seam. The expiry is a real setTimeout in production, so
 * the tests drive it explicitly rather than sleeping — a live clock would make
 * the boundary cases untestable.
 */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let nextId = 1;
  return {
    schedule: (fn: () => void) => {
      const id = nextId++;
      pending.set(id, fn);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: (handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    },
    get armed() { return pending.size; },
    fireAll() {
      for (const fn of [...pending.values()]) fn();
      pending.clear();
    },
  };
}

const make = (timers: ReturnType<typeof manualTimers>) =>
  new TierPreferenceHandoff({ schedule: timers.schedule, cancel: timers.cancel });

describe('tier preference account handoff', () => {
  it('defers only the signing-in account until its cloud completion signal', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    const generation = handoff.begin('account-b');

    assert.equal(handoff.shouldDefer('account-b'), true);
    assert.equal(handoff.shouldDefer('account-a'), false);
    assert.equal(handoff.complete(generation, 'account-b', 'account-b'), true);
    assert.equal(handoff.shouldDefer('account-b'), false);
  });

  it('does not let a stale completion clear a newer account handoff', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    const first = handoff.begin('account-a');
    const second = handoff.begin('account-b');

    assert.equal(handoff.complete(first, 'account-a', 'account-b'), false);
    assert.equal(handoff.shouldDefer('account-b'), true);
    assert.equal(handoff.complete(second, 'account-b', null), false);
    assert.equal(handoff.shouldDefer('account-b'), false);
  });

  // Regression: an id-only guard passed here, because the ids match. The queue
  // settles the superseded attempt BEFORE the new one runs, so this ordering is
  // deterministic rather than a narrow race.
  it('rejects a stale completion for the same account after sign-out and back in', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    const firstAttempt = handoff.begin('account-a');
    handoff.clear();
    const secondAttempt = handoff.begin('account-a');

    assert.notEqual(firstAttempt, secondAttempt);
    assert.equal(
      handoff.complete(firstAttempt, 'account-a', 'account-a'),
      false,
      'the superseded attempt must not release the live handoff',
    );
    assert.equal(
      handoff.shouldDefer('account-a'),
      true,
      'the second sign-in is still waiting for its own cloud prefs',
    );
    assert.equal(handoff.complete(secondAttempt, 'account-a', 'account-a'), true);
  });

  it('releases the deferral and reconciles when no terminal outcome arrives', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    let reconciled = 0;
    handoff.begin('account-a', () => { reconciled += 1; });

    assert.equal(handoff.shouldDefer('account-a'), true);
    timers.fireAll();

    assert.equal(reconciled, 1, 'expiry must run the reconciliation itself');
    assert.equal(
      handoff.shouldDefer('account-a'),
      false,
      'a stalled sign-in may delay enforcement but must never cancel it',
    );
  });

  it('disarms the expiry once a terminal outcome arrives', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    let reconciled = 0;
    const generation = handoff.begin('account-a', () => { reconciled += 1; });

    assert.equal(handoff.complete(generation, 'account-a', 'account-a'), true);
    assert.equal(timers.armed, 0, 'completion must cancel the pending expiry');
    timers.fireAll();
    assert.equal(reconciled, 0, 'a completed handoff must not also fire its expiry');
  });

  it('disarms the expiry on sign-out', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    let reconciled = 0;
    handoff.begin('account-a', () => { reconciled += 1; });
    handoff.clear();

    assert.equal(timers.armed, 0);
    timers.fireAll();
    assert.equal(reconciled, 0, 'a signed-out handoff must not reconcile');
  });

  it('supersedes a previous expiry when a new handoff begins', () => {
    const timers = manualTimers();
    const handoff = make(timers);
    const fired: string[] = [];
    handoff.begin('account-a', () => fired.push('a'));
    handoff.begin('account-b', () => fired.push('b'));

    timers.fireAll();
    assert.deepEqual(fired, ['b'], 'only the live handoff may expire');
  });
});
