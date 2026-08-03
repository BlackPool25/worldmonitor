/**
 * Runtime-correct "send the user to this URL, outside the app".
 *
 * Desktop (Tauri) hands the URL to the OS browser through the `open_url` IPC
 * command — the convention already used by `components/Panel.ts`,
 * `components/ResilienceWidget.ts` and the capture-phase anchor interceptor in
 * `app/event-handlers.ts`. Navigating the WebView itself replaces the entire
 * app with a third-party page and leaves the user with no browser chrome to
 * get back; for payment pages it also runs 3DS/fraud checks inside an embedded
 * WebView, which is exactly the nesting that hung Dodo checkouts in #4449.
 *
 * Web keeps the popup-blocker dance: browsers only honour `window.open()`
 * inside a live user gesture, so a caller may reserve a blank tab
 * synchronously in its click handler (`prereserveExternalTab`) and pass the
 * handle here to be navigated once the async work resolves.
 *
 * The Rust side of `open_url` accepts `https://` only (plus `http://` for
 * localhost) and opens through the OS default handler, never a shell — see
 * `src-tauri/src/main.rs` and `src-tauri/open-url-safety.test.mjs`. A rejected
 * scheme therefore surfaces as a rejected promise here rather than a silent
 * no-op, and falls through to `window.open`.
 */

import { isDesktopRuntime } from './desktop-runtime';
import { invokeTauri } from './tauri-bridge';

/**
 * Reserve a blank tab SYNCHRONOUSLY inside a click handler so an async
 * external navigation can land in it without tripping the popup blocker.
 * Callers must call this before awaiting anything, then pass the handle to
 * `openExternalUrl`.
 *
 * Returns `null` on desktop: the URL leaves for the OS browser, so there is
 * no popup to pre-reserve, and a blank `window.open` inside the Tauri WebView
 * would strand an empty window behind the app.
 */
export function prereserveExternalTab(): Window | null {
  if (isDesktopRuntime()) return null;
  return window.open('', '_blank', 'noopener,noreferrer');
}

export async function openExternalUrl(
  url: string,
  preopened?: Window | null,
): Promise<void> {
  if (isDesktopRuntime()) {
    // A pre-reserved tab is a web-only workaround. Close any handle a caller
    // reserved before it knew the runtime, so the OS browser doesn't come
    // forward over an orphaned blank WebView window.
    if (preopened && !preopened.closed) preopened.close();
    try {
      await invokeTauri<void>('open_url', { url });
      return;
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
  }

  if (preopened && !preopened.closed) {
    preopened.location.href = url;
    return;
  }
  const fresh = window.open(url, '_blank', 'noopener,noreferrer');
  // Popup blocked and no reserved tab: same-tab navigation beats silently
  // doing nothing, which is how a blocked upgrade click used to look.
  if (!fresh) window.location.assign(url);
}
