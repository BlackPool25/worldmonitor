/**
 * #5911 — billing/upgrade navigation must LEAVE the desktop WebView.
 *
 * Before this, `openBillingPortal()` had no desktop branch: it ran
 * `window.open` / `window.location.assign`, which inside Tauri navigates the
 * app's own WebView to Dodo's portal. The user loses the entire app to a
 * third-party page with no tab strip and no back button.
 *
 * The established convention (`components/Panel.ts`,
 * `components/ResilienceWidget.ts`, the anchor interceptor in
 * `app/event-handlers.ts`) is `invokeTauri('open_url', { url })`, which hands
 * the URL to the OS default browser.
 *
 * These drive the REAL `isDesktopRuntime()` detector — the window shape below
 * is what a shipped Tauri build actually presents — plus the REAL
 * `tauri-bridge`, `external-navigation` and `billing` modules. Only Clerk and
 * the Convex client are doubled, because a portal session is a server
 * round-trip. The decisive assertion in every desktop case is negative: the
 * WebView never navigated.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

interface TauriInvocation {
  command: string;
  payload?: Record<string, unknown>;
}

interface WindowProbe {
  invocations: TauriInvocation[];
  opened: Array<[string, string | undefined, string | undefined]>;
  assigned: string[];
  /** Handles returned by window.open that the code under test then closed. */
  closedTabs: number;
  /** Simulates the Rust side rejecting (bad scheme, opener failure). */
  invokeRejects: boolean;
  /** Simulates a popup blocker: window.open returns null. */
  popupBlocked: boolean;
}

let probe: WindowProbe;

function makeTab(): { closed: boolean; location: { href: string }; close: () => void } {
  const tab = {
    closed: false,
    location: { href: '' },
    close(): void {
      tab.closed = true;
      probe.closedTabs += 1;
    },
  };
  return tab;
}

/**
 * `desktop` mirrors a shipped Tauri window: bridge globals present, a
 * `tauri://localhost` origin and `Tauri` in the UA. `web` deliberately trips
 * none of `detectDesktopRuntime`'s signals (no globals, https on the real
 * host, plain UA) so the web path is asserted against the same real detector.
 */
function installWindow(kind: 'desktop' | 'web'): void {
  probe = {
    invocations: [],
    opened: [],
    assigned: [],
    closedTabs: 0,
    invokeRejects: false,
    popupBlocked: false,
  };

  const desktop = kind === 'desktop';
  const location = {
    protocol: desktop ? 'tauri:' : 'https:',
    host: desktop ? 'tauri.localhost' : 'worldmonitor.app',
    hostname: desktop ? 'tauri.localhost' : 'worldmonitor.app',
    origin: desktop ? 'tauri://localhost' : 'https://worldmonitor.app',
    href: desktop ? 'tauri://localhost/index.html' : 'https://worldmonitor.app/dashboard',
    assign: (url: string) => {
      probe.assigned.push(url);
    },
  };
  const win: Record<string, unknown> = {
    navigator: { userAgent: desktop ? 'Mozilla/5.0 Tauri/2.11.5' : 'Mozilla/5.0 Chrome/140' },
    location,
    open: (url: string, target?: string, features?: string) => {
      probe.opened.push([url, target, features]);
      return probe.popupBlocked ? null : makeTab();
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  if (desktop) {
    win.__TAURI_INTERNALS__ = {
      invoke: async (command: string, payload?: Record<string, unknown>) => {
        probe.invocations.push({ command, payload });
        if (probe.invokeRejects) throw new Error('open_url refused the URL');
      },
    };
  }

  Object.defineProperty(globalThis, 'window', { configurable: true, value: win });
  // `config/variant.ts` reads the bare `location` global, not `window.location`.
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location });
}

// Every module under test reads `window` lazily (per call), but `billing.ts`
// still reaches module-scope browser reads through its own graph — so a
// window must exist before the imports below.
installWindow('web');

const { openExternalUrl, prereserveExternalTab } = await import(
  '../src/services/external-navigation.ts'
);
const { openBillingPortal, prereserveBillingPortalTab } = await import(
  '../src/services/billing.ts'
);
const { __setClerkInstanceForTests } = await import('../src/services/clerk.ts');
const { __setConvexClientForTests } = await import('../src/services/convex-client.ts');

const PORTAL_URL = 'https://checkout.dodopayments.com/portal/session-abc';

class FakePortalClient {
  authConfigs: Array<{ onChange: (ok: boolean) => void }> = [];
  setAuth(_fetchToken: unknown, onChange: (ok: boolean) => void): void {
    this.authConfigs.push({ onChange });
  }
  onUpdate(): (() => void) & { unsubscribe: () => void } {
    const unsubscribe = () => {};
    return Object.assign(unsubscribe, { unsubscribe });
  }
  async query(): Promise<unknown> {
    return null;
  }
  async mutation(): Promise<unknown> {
    return null;
  }
  async action(): Promise<unknown> {
    return { portal_url: PORTAL_URL };
  }
}

/** Signed-in user whose Convex socket has already confirmed the identity. */
function installSignedInPortalUser(): void {
  __setClerkInstanceForTests({
    session: { getToken: async () => 'token-a' },
    user: { id: 'A' },
  } as never);
  const fake = new FakePortalClient();
  __setConvexClientForTests(fake as never);
  fake.authConfigs[0]?.onChange(true);
}

afterEach(() => {
  __setClerkInstanceForTests(null);
  __setConvexClientForTests(null);
});

describe('openExternalUrl — desktop', () => {
  it('hands the URL to the OS browser and never navigates the WebView', async () => {
    installWindow('desktop');

    await openExternalUrl('https://worldmonitor.app/pro');

    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: 'https://worldmonitor.app/pro' } },
    ]);
    // The whole point: neither of the two ways the WebView could be replaced.
    assert.deepEqual(probe.assigned, []);
    assert.deepEqual(probe.opened, []);
  });

  it('closes a tab a caller reserved before it knew the runtime', async () => {
    installWindow('desktop');
    const stray = makeTab();

    await openExternalUrl('https://worldmonitor.app/pro', stray);

    assert.equal(stray.closed, true, 'a blank WebView window must not be left behind the browser');
    assert.equal(stray.location.href, '', 'the reserved tab must never be navigated on desktop');
    assert.equal(probe.invocations.length, 1);
  });

  it('falls back to window.open when the native opener refuses', async () => {
    installWindow('desktop');
    probe.invokeRejects = true;

    await openExternalUrl('https://worldmonitor.app/pro');

    assert.equal(probe.invocations.length, 1, 'the native path must be tried first');
    assert.deepEqual(probe.opened, [
      ['https://worldmonitor.app/pro', '_blank', 'noopener,noreferrer'],
    ]);
    assert.deepEqual(probe.assigned, [], 'the fallback must still not replace the app');
  });
});

describe('openExternalUrl — web', () => {
  it('navigates a reserved tab in place so the popup blocker stays satisfied', async () => {
    installWindow('web');
    const reserved = makeTab();

    await openExternalUrl(PORTAL_URL, reserved);

    assert.equal(reserved.location.href, PORTAL_URL);
    assert.deepEqual(probe.opened, [], 'a second window.open would be the blocked one');
    assert.deepEqual(probe.invocations, []);
  });

  it('opens a fresh tab when nothing was reserved', async () => {
    installWindow('web');

    await openExternalUrl(PORTAL_URL);

    assert.deepEqual(probe.opened, [[PORTAL_URL, '_blank', 'noopener,noreferrer']]);
    assert.deepEqual(probe.assigned, []);
  });

  it('falls back to same-tab navigation when the popup is blocked', async () => {
    installWindow('web');
    probe.popupBlocked = true;

    await openExternalUrl(PORTAL_URL);

    assert.deepEqual(probe.assigned, [PORTAL_URL], 'a blocked upgrade click must not look dead');
  });
});

describe('prereserveExternalTab', () => {
  it('reserves nothing on desktop — there is no popup to protect', () => {
    installWindow('desktop');

    assert.equal(prereserveExternalTab(), null);
    assert.deepEqual(probe.opened, [], 'a blank window.open would strand an empty WebView');
  });

  it('still reserves a blank tab on web', () => {
    installWindow('web');

    assert.notEqual(prereserveExternalTab(), null);
    assert.deepEqual(probe.opened, [['', '_blank', 'noopener,noreferrer']]);
  });

  it('is what prereserveBillingPortalTab delegates to, so billing inherits both', () => {
    installWindow('desktop');
    assert.equal(prereserveBillingPortalTab(), null);

    installWindow('web');
    assert.notEqual(prereserveBillingPortalTab(), null);
  });
});

describe('openBillingPortal — desktop', () => {
  it('opens the personalized portal session in the OS browser', async () => {
    installWindow('desktop');
    installSignedInPortalUser();

    assert.deepEqual(await openBillingPortal(prereserveBillingPortalTab()), {
      outcome: 'opened',
      url: PORTAL_URL,
    });

    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: PORTAL_URL } },
    ]);
    // Regression guard for the reported bug: the WebView itself became the
    // Dodo portal, with no way back to the app.
    assert.deepEqual(probe.assigned, []);
    assert.deepEqual(probe.opened, []);
  });

  it('routes the signed-out fallback portal the same way', async () => {
    installWindow('desktop');

    const result = await openBillingPortal(prereserveBillingPortalTab());

    assert.deepEqual(result, { outcome: 'opened', url: 'https://customer.dodopayments.com' });
    assert.deepEqual(probe.invocations, [
      { command: 'open_url', payload: { url: 'https://customer.dodopayments.com' } },
    ]);
    assert.deepEqual(probe.assigned, []);
  });
});

describe('openBillingPortal — web', () => {
  it('keeps navigating the pre-reserved tab, with no native bridge call', async () => {
    installWindow('web');
    installSignedInPortalUser();
    const reserved = prereserveBillingPortalTab();

    assert.deepEqual(await openBillingPortal(reserved), {
      outcome: 'opened',
      url: PORTAL_URL,
    });

    assert.equal(reserved?.location.href, PORTAL_URL);
    assert.deepEqual(probe.invocations, []);
  });
});
