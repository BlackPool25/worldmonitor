import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

const windowSnapshot = snapshotGlobal('window');
const stateKeys = [
  '__activationAuth',
  '__activationAuthListeners',
  '__activationSubscription',
  '__activationEntitlement',
  '__activationOpenedFor',
  '__activationOpenResult',
] as const;
const stateSnapshots = new Map(stateKeys.map((key) => [key, snapshotGlobal(key)]));

afterEach(() => {
  restoreGlobal('window', windowSnapshot);
  for (const key of stateKeys) restoreGlobal(key, stateSnapshots.get(key)!);
});

async function loadController(): Promise<typeof import('../src/app/pro-activation-controller.ts')> {
  const tempDir = mkdtempSync(join(tmpdir(), 'wm-pro-activation-controller-'));
  const outfile = join(tempDir, 'controller.bundle.mjs');
  const stubs = new Map([
    ['analytics-stub', 'export function trackProActivation() {}'],
    ['auth-stub', `
      export function getAuthState() { return globalThis.__activationAuth; }
      export function subscribeAuthState(callback) {
        globalThis.__activationAuthListeners.add(callback);
        callback(globalThis.__activationAuth);
        return () => globalThis.__activationAuthListeners.delete(callback);
      }
    `],
    ['billing-stub', `
      export function getSubscription() { return globalThis.__activationSubscription; }
      export function onSubscriptionChange() { return () => {}; }
    `],
    ['entitlements-stub', `
      export function getEntitlementState() { return globalThis.__activationEntitlement; }
      export function onEntitlementChange() { return () => {}; }
    `],
    ['interstitial-stub', `
      export async function openProActivationFlow(options) {
        globalThis.__activationOpenedFor.push(options.accountUserId);
        return globalThis.__activationOpenResult ?? 'opened';
      }
    `],
    ['chip-stub', 'export function maybeShowFinishSetupChip() {}'],
  ]);
  const aliases = new Map([
    ['@/services/analytics', 'analytics-stub'],
    ['@/services/auth-state', 'auth-stub'],
    ['@/services/billing', 'billing-stub'],
    ['@/services/entitlements', 'entitlements-stub'],
    ['@/components/ProActivationInterstitial', 'interstitial-stub'],
    ['@/components/ProActivationChip', 'chip-stub'],
  ]);

  const result = await build({
    entryPoints: [resolve(process.cwd(), 'src/app/pro-activation-controller.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
    plugins: [{
      name: 'pro-activation-controller-test-stubs',
      setup(buildApi) {
        buildApi.onResolve({ filter: /.*/ }, (args) => {
          const target = aliases.get(args.path);
          return target ? { path: target, namespace: 'stub' } : null;
        });
        buildApi.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: stubs.get(args.path),
          loader: 'js',
        }));
      },
    }],
  });

  writeFileSync(outfile, result.outputFiles[0].text, 'utf8');
  const mod = await import(`${pathToFileURL(outfile).href}?t=${Date.now()}`);
  rmSync(tempDir, { recursive: true, force: true });
  return mod as typeof import('../src/app/pro-activation-controller.ts');
}

function installBrowserState(options: { fastTimers?: boolean } = {}): void {
  const values = new Map<string, string>();
  // The real backoff schedule (2s..30s) would make retry-exhaustion tests slow
  // and flaky; fastTimers collapses every window.setTimeout delay to the next
  // tick while preserving real clearTimeout semantics.
  const timeoutFn = options.fastTimers
    ? ((handler: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) =>
        setTimeout(handler, 0, ...args)) as typeof setTimeout
    : setTimeout;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, String(value)),
        removeItem: (key: string) => values.delete(key),
      },
      setTimeout: timeoutFn,
      clearTimeout,
    },
  });
  Object.assign(globalThis, {
    __activationAuth: { user: null, isPending: false },
    __activationAuthListeners: new Set<(state: unknown) => void>(),
    __activationSubscription: null,
    __activationEntitlement: { planKey: 'free', validUntil: Date.now() + 60_000 },
    __activationOpenedFor: [] as string[],
    __activationOpenResult: 'opened' as string,
  });
}

/** A first-cycle Pro account eligible for the markerless cohort mount. */
function installEligibleMarkerlessAccount(userId: string): void {
  Object.assign(globalThis, {
    __activationAuth: {
      user: { id: userId, name: 'Markerless User', email: `${userId}@example.com`, role: 'pro' },
      isPending: false,
    },
    __activationSubscription: {
      activationKey: `opaque-${userId}-subscription`,
      activationOnboardingEligible: true,
      planKey: 'pro_monthly',
      currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
    __activationEntitlement: {
      planKey: 'pro_monthly',
      validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
    },
  });
}

describe('ProActivationController auth lifecycle', () => {
  it('re-evaluates a Pro account that signs in after signed-out resolution', async () => {
    installBrowserState();
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();

      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      assert.deepEqual(
        (globalThis as unknown as { __activationOpenedFor: string[] }).__activationOpenedFor,
        [],
      );

      Object.assign(globalThis, {
        __activationAuth: {
          user: {
            id: 'user-second-session',
            name: 'Second Session',
            email: 'second@example.com',
            role: 'pro',
          },
          isPending: false,
        },
        __activationSubscription: {
          activationKey: 'opaque-first-cycle-subscription',
          activationOnboardingEligible: true,
          planKey: 'pro_monthly',
          currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
        __activationEntitlement: {
          planKey: 'pro_monthly',
          validUntil: Date.now() + 30 * 24 * 60 * 60 * 1000,
        },
      });
      const authState = (globalThis as unknown as { __activationAuth: unknown }).__activationAuth;
      for (const listener of (
        globalThis as unknown as { __activationAuthListeners: Set<(state: unknown) => void> }
      ).__activationAuthListeners) {
        listener(authState);
      }

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      for (let attempt = 0; attempt < 40 && openedFor.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(openedFor, ['user-second-session']);
    } finally {
      controller.destroy();
    }
  });
});

describe('ProActivationController markerless mount() branching', () => {
  it("openFlow returning 'not-eligible' resolves the tab and stops re-attempting", async () => {
    installBrowserState();
    installEligibleMarkerlessAccount('user-not-eligible');
    (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'not-eligible';
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      for (let attempt = 0; attempt < 40 && openedFor.length === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(openedFor, ['user-not-eligible']);
      assert.equal((controller as unknown as { resolved: boolean }).resolved, true);
      assert.equal((controller as unknown as { mounting: boolean }).mounting, false);

      // Resolved tabs must not re-attempt on a later evaluate() call.
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();
      assert.deepEqual(openedFor, ['user-not-eligible']);
    } finally {
      controller.destroy();
    }
  });

  it("openFlow returning 'retry' backs off through the bounded schedule and then gives up", async () => {
    installBrowserState({ fastTimers: true });
    installEligibleMarkerlessAccount('user-retry-forever');
    (globalThis as unknown as { __activationOpenResult: string }).__activationOpenResult = 'retry';
    const { ProActivationController } = await loadController();
    const ctx = {
      isDestroyed: false,
      isDesktopApp: false,
      container: { dispatchEvent() {} },
      unifiedSettings: null,
    };
    const controller = new ProActivationController(ctx as never, {
      reloadPending: false,
      openAiAnalyst() {},
    });
    try {
      controller.init();
      await (controller as unknown as { evaluate(): Promise<void> }).evaluate();

      // With fast timers, the whole 5-attempt backoff schedule collapses to a
      // handful of ticks instead of the real ~60s cumulative delay.
      for (
        let attempt = 0;
        attempt < 200 && (controller as unknown as { resolved: boolean }).resolved === false;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((controller as unknown as { resolved: boolean }).resolved, true);

      const openedFor = (
        globalThis as unknown as { __activationOpenedFor: string[] }
      ).__activationOpenedFor;
      // One initial attempt plus every entry in ACTIVATION_FLOW_RETRY_DELAYS_MS.
      assert.equal(openedFor.length, 6);
      assert.ok(openedFor.every((id) => id === 'user-retry-forever'));
    } finally {
      controller.destroy();
    }
  });
});
