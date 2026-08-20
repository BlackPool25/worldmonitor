/**
 * Fetch timeout signal with a fallback for engines that lack
 * `AbortSignal.timeout` (Baseline 2024 / Chrome 103+).
 *
 * WORLDMONITOR-109: Chrome Mobile 101 on Android 9 threw
 * `TypeError: AbortSignal.timeout is not a function` in the /pro
 * pricing catalog `useEffect` before `fetch` ran. `AbortController` +
 * `setTimeout` covers that class without a polyfill package.
 */
export function createTimeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => {
    try {
      controller.abort();
    } catch {
      /* already aborted or exotic AbortController */
    }
  }, ms);
  return controller.signal;
}
