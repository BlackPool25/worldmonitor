/**
 * Shared setup for the DOM-behavioral gate tests (#5634).
 *
 * Two environment gaps this file closes, both of which silently produce
 * FALSE PASSES if left open:
 *
 *   1. i18next is a module singleton that the app initialises in `initI18n()`.
 *      Nothing initialises it under test, and an uninitialised i18next returns
 *      `undefined` from `t()` — so every locked-state assertion comparing one
 *      reason's copy to another would trivially hold with both sides
 *      `undefined`. `initTestI18n()` loads the REAL production `en.json` and
 *      then asserts a probe key actually resolved.
 *   2. happy-dom does not implement `window.print()`, so `printReportDocument`
 *      would always take its reject path and the "PDF succeeded" branch of the
 *      click cycle would never be exercised. `installPrintRecorder()` shims it
 *      on the BrowserWindow prototype every iframe shares, and records what
 *      was actually in the printed document.
 */

import i18next from 'i18next';

import en from '@/locales/en.json';

/**
 * Initialise the i18next singleton with the real English dictionary.
 *
 * Deliberately NOT `initI18n()` from `@/services/i18n`: that path runs
 * navigator language detection, localStorage migration and an async
 * `import.meta.glob` preload whose timing would make copy assertions racy.
 * The dictionary here is the same file that preload ends up merging, so the
 * strings under test are the ones users see.
 */
export async function initTestI18n(): Promise<void> {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: 'en',
      fallbackLng: 'en',
      resources: { en: { translation: en as Record<string, unknown> } },
      interpolation: { escapeValue: false },
    });
  }

  // Fail loudly rather than let the suite pass on `undefined` copy.
  const probe = i18next.t('components.exportGate.upgradeCta');
  if (typeof probe !== 'string' || probe.length === 0) {
    throw new Error(`[dom-harness] i18n did not initialise — t() returned ${String(probe)}`);
  }
}

/** Translate through the same singleton the components use. */
export function tt(key: string, options?: Record<string, unknown>): string {
  return i18next.t(key, options);
}

export interface PrintRecorder {
  /** `document.body.innerHTML` of every document `print()` was called on. */
  readonly printed: string[];
  /** Make the next `print()` throw, to exercise the failure path. */
  failNext(error: Error): void;
  restore(): void;
}

/**
 * Give happy-dom a `window.print()`.
 *
 * The shim lands on the prototype shared by every iframe's `contentWindow`,
 * so it covers the iframe `printReportDocument` creates internally — no
 * dependency injection, which is the point: the composed click cycle must be
 * provable through the same call path production uses.
 */
export function installPrintRecorder(): PrintRecorder {
  const probeFrame = document.createElement('iframe');
  document.body.appendChild(probeFrame);
  const probeWindow = probeFrame.contentWindow;
  probeFrame.remove();
  if (!probeWindow) {
    throw new Error('[dom-harness] iframe exposed no contentWindow — cannot shim print()');
  }
  const windowProto = Object.getPrototypeOf(probeWindow) as Record<string, unknown>;

  const hadOwn = Object.prototype.hasOwnProperty.call(windowProto, 'print');
  const previous = windowProto.print;

  const printed: string[] = [];
  let pendingError: Error | null = null;

  windowProto.print = function print(this: Window): void {
    if (pendingError) {
      const err = pendingError;
      pendingError = null;
      throw err;
    }
    printed.push(this.document.body.innerHTML);
  };

  return {
    printed,
    failNext(error: Error) {
      pendingError = error;
    },
    restore() {
      if (hadOwn) windowProto.print = previous;
      else delete windowProto.print;
    },
  };
}
