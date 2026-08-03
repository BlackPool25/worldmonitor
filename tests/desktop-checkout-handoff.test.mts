/**
 * #5911 — `startCheckout()` on desktop must open Dodo's hosted checkout in the
 * OS browser and must ask Dodo to return the buyer to a WEB origin.
 *
 * Two separate defects, both invisible to the existing web-path suites:
 *
 *   1. `window.location.assign(hostedCheckoutUrl)` replaced the entire Tauri
 *      WebView with Dodo's page — no tab, no back button — and ran 3DS/fraud
 *      inside an embedded WebView, the exact nesting #4449 moved away from.
 *   2. The return URL was built from `window.location.origin`, which on
 *      desktop is `tauri://localhost`. A buyer who paid was redirected to a
 *      route no browser can open, so the `?wm_checkout=return` reconciliation
 *      never ran anywhere.
 *
 * Drives the REAL `startCheckout` through the same esbuild stub harness the
 * other checkout suites use (`checkout-unparsable-success-body.test.mts`), so
 * the real hosted-URL guard, the real return-URL builders and the real
 * `external-navigation` + `tauri-bridge` modules are all exercised. Only the
 * runtime detector is stubbed, so a case states its runtime rather than
 * inferring one from a synthesised window.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { build, type Plugin } from 'esbuild';

interface TauriInvocation {
  command: string;
  payload?: Record<string, unknown>;
}

interface HarnessState {
  desktop: boolean;
  /** Bodies POSTed to /api/create-checkout. */
  requestBodies: Array<Record<string, unknown>>;
  invocations: TauriInvocation[];
  /** WebView navigations — must stay empty on desktop. */
  assignedUrls: string[];
  openedWindows: string[];
  toasts: string[];
  responseBody: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __desktopCheckoutHarness: HarnessState;
}

const HOSTED_CHECKOUT_URL = 'https://checkout.dodopayments.com/buy/sess_123';

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
}

/**
 * Minimal `document` double: the desktop branch renders the "return to app"
 * toast, which the web path never reached, so the shared harness never needed
 * one. Only what `utils/toast.ts` touches is modelled.
 */
function installDocument(): void {
  const body = {
    appendChild: (el: { textContent: string }) => {
      globalThis.__desktopCheckoutHarness.toasts.push(el.textContent);
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body,
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({
        className: '',
        textContent: '',
        style: {},
        classList: { add: () => {}, remove: () => {} },
        setAttribute: () => {},
        remove: () => {},
      }),
    },
  });
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (fn: () => void) => {
      fn();
      return 1;
    },
  });
}

function resetHarness(desktop: boolean): void {
  globalThis.__desktopCheckoutHarness = {
    desktop,
    requestBodies: [],
    invocations: [],
    assignedUrls: [],
    openedWindows: [],
    toasts: [],
    responseBody: JSON.stringify({ checkout_url: HOSTED_CHECKOUT_URL }),
  };

  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
      // The WebView origin a shipped Tauri build actually reports. On web the
      // suite uses the real dashboard origin.
      location: {
        href: desktop ? 'tauri://localhost/index.html' : 'https://worldmonitor.app/dashboard',
        origin: desktop ? 'tauri://localhost' : 'https://worldmonitor.app',
        pathname: desktop ? '/index.html' : '/dashboard',
        search: '',
        hash: '',
        assign: (url: string) => {
          globalThis.__desktopCheckoutHarness.assignedUrls.push(url);
        },
      },
      open: (url: string) => {
        globalThis.__desktopCheckoutHarness.openedWindows.push(url);
        return null;
      },
      history: { replaceState: () => {} },
      __TAURI_INTERNALS__: {
        invoke: async (command: string, payload?: Record<string, unknown>) => {
          globalThis.__desktopCheckoutHarness.invocations.push({ command, payload });
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: async (_url: string, init?: { body?: string }) => {
      const harness = globalThis.__desktopCheckoutHarness;
      harness.requestBodies.push(JSON.parse(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        text: async () => harness.responseBody,
        json: async () => JSON.parse(harness.responseBody),
        headers: { get: () => null },
      };
    },
  });
  installDocument();
}

const stubSources: Record<string, string> = {
  '@/bootstrap/sentry-defer': `
    export function enqueueSentryCall(fn) {
      fn({ addBreadcrumb: () => {}, captureMessage: () => {}, captureException: () => {} });
    }
  `,
  'dodopayments-checkout': `
    export const DodoPayments = {
      Initialize() {},
      Checkout: { isOpen: () => false, close: () => {}, open: () => {} },
    };
  `,
  // The one behavioural knob: which runtime the case is asserting. The real
  // detector has its own coverage in tests/desktop-external-handoff.test.mts,
  // which drives it from a synthesised Tauri window.
  './desktop-runtime': `
    export const isDesktopRuntime = () => globalThis.__desktopCheckoutHarness.desktop;
  `,
  './billing': `
    export const openBillingPortal = async () => {};
    export const prereserveBillingPortalTab = () => null;
  `,
  './clerk': `
    export const getCurrentClerkUser = () => ({ id: 'user_1', email: 'buyer@example.com' });
    export const getClerkToken = async () => 'tok_test';
    export const openSignIn = () => {};
  `,
  './analytics': `
    export const trackCheckoutStart = () => {};
  `,
  './auth-state': `
    export const subscribeAuthState = () => () => {};
  `,
  './checkout-attempt': `
    export const saveCheckoutAttempt = () => {};
    export const loadCheckoutAttempt = () => null;
    export const clearCheckoutAttempt = () => {};
  `,
  './checkout-error-toast': `
    export const showCheckoutErrorToast = () => {};
  `,
  './entitlements': `
    export const isEntitled = () => false;
    export const onEntitlementChange = () => () => {};
  `,
  './checkout-banner-state': `
    export const CLASSIC_AUTO_DISMISS_MS = 5000;
    export const EXTENDED_UNLOCK_TIMEOUT_MS = 30000;
    export const maskEmail = (email) => email ?? null;
  `,
  './referral-capture': `
    export const loadActiveReferral = () => null;
  `,
  './checkout-duplicate-dialog': `
    export const showDuplicateSubscriptionDialog = () => {};
  `,
  './checkout-pending-dialog': `
    export const showCheckoutPendingDialog = () => {};
  `,
  './checkout-plan-names': `
    export const resolvePlanDisplayName = () => 'Pro';
  `,
  './entitlement-watchdog': `
    export function createEntitlementWatchdog() {
      return { start: () => {}, stop: () => {}, isActive: () => false };
    }
  `,
};

const harnessPlugin: Plugin = {
  name: 'desktop-checkout-harness',
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) =>
      Object.hasOwn(stubSources, args.path) ? { path: args.path, namespace: 'dch-stub' } : null,
    );
    buildApi.onLoad({ filter: /.*/, namespace: 'dch-stub' }, (args) => ({
      contents: stubSources[args.path],
      loader: 'js',
    }));
  },
};

async function loadCheckoutModule(): Promise<{
  startCheckout: (productId: string) => Promise<boolean>;
  DESKTOP_CHECKOUT_HANDOFF_MESSAGE: string;
}> {
  const result = await build({
    absWorkingDir: process.cwd(),
    stdin: {
      contents:
        `export { startCheckout, DESKTOP_CHECKOUT_HANDOFF_MESSAGE } from './src/services/checkout.ts';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
    define: { 'import.meta.env.VITE_DODO_ENVIRONMENT': '"test_mode"' },
    plugins: [harnessPlugin],
  });
  const dataUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
  return await import(`${dataUrl}#${Date.now()}-${Math.random()}`);
}

describe('startCheckout on desktop (#5911)', () => {
  it('opens the hosted checkout in the OS browser instead of replacing the app', async () => {
    resetHarness(true);
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('pro_monthly'), true);

    assert.deepEqual(globalThis.__desktopCheckoutHarness.invocations, [
      { command: 'open_url', payload: { url: HOSTED_CHECKOUT_URL } },
    ]);
    // The reported bug, stated as a negative: the WebView must not navigate.
    assert.deepEqual(globalThis.__desktopCheckoutHarness.assignedUrls, []);
    assert.deepEqual(globalThis.__desktopCheckoutHarness.openedWindows, []);
  });

  it('asks Dodo to return the buyer to the web dashboard, not to tauri://localhost', async () => {
    resetHarness(true);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('pro_monthly');

    const [body] = globalThis.__desktopCheckoutHarness.requestBodies;
    assert.equal(body?.returnUrl, 'https://worldmonitor.app/dashboard?wm_checkout=return');
  });

  it('tells the buyer where checkout went and that nothing redirects back', async () => {
    // Without this the click is indistinguishable from a dead button: the app
    // window is unchanged and the browser may open behind a fullscreen app.
    resetHarness(true);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('pro_monthly');

    assert.deepEqual(globalThis.__desktopCheckoutHarness.toasts, [
      checkout.DESKTOP_CHECKOUT_HANDOFF_MESSAGE,
    ]);
  });

});

describe('startCheckout on web is unchanged (#5911 regression guard)', () => {
  it('still navigates the top window and never touches the native bridge', async () => {
    resetHarness(false);
    const checkout = await loadCheckoutModule();

    assert.equal(await checkout.startCheckout('pro_monthly'), true);

    assert.deepEqual(globalThis.__desktopCheckoutHarness.assignedUrls, [HOSTED_CHECKOUT_URL]);
    assert.deepEqual(globalThis.__desktopCheckoutHarness.invocations, []);
    assert.deepEqual(globalThis.__desktopCheckoutHarness.toasts, []);
  });

  it('keeps returning the buyer to the origin they started from', async () => {
    resetHarness(false);
    const checkout = await loadCheckoutModule();

    await checkout.startCheckout('pro_monthly');

    const [body] = globalThis.__desktopCheckoutHarness.requestBodies;
    assert.equal(body?.returnUrl, 'https://worldmonitor.app/dashboard?wm_checkout=return');
  });
});
