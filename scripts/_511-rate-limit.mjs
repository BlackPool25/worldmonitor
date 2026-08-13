/**
 * Per-host 511 token bucket: 10 calls / 60 seconds.
 *
 * Ontario 511 (and the same vendor's AB/MB APIs) throttle at 10 requests per
 * 60 seconds *per host*. A shared Canada bucket would stall Alberta because
 * Ontario consumed the quota. Each hostname gets its own in-process bucket.
 *
 * Do not reuse inbound api/_rate-limit.js / the `rl:` Redis prefix — this is
 * an egress limiter inside the seeder process, not the public API limiter.
 *
 * Issue #6618 v1.
 */

const DEFAULT_CAPACITY = 10;
const DEFAULT_WINDOW_MS = 60_000;

/**
 * @param {{
 *   capacity?: number,
 *   windowMs?: number,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} [opts]
 */
export function create511RateLimiter(opts = {}) {
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** @type {Map<string, number[]>} */
  const stampsByHost = new Map();

  /**
   * Wait until this process may call `host` without exceeding 10/60s.
   * @param {string} host
   */
  async function acquire511Slot(host) {
    if (typeof host !== 'string' || host.trim() === '') {
      throw new TypeError('acquire511Slot(host) requires a non-empty hostname');
    }
    const key = host.trim().toLowerCase();
    for (;;) {
      const nowMs = now();
      const windowStart = nowMs - windowMs;
      let stamps = stampsByHost.get(key) || [];
      stamps = stamps.filter((t) => t > windowStart);
      if (stamps.length < capacity) {
        stamps.push(nowMs);
        stampsByHost.set(key, stamps);
        return;
      }
      stampsByHost.set(key, stamps);
      const waitMs = Math.max(1, stamps[0] + windowMs - nowMs);
      await sleep(waitMs);
    }
  }

  function reset() {
    stampsByHost.clear();
  }

  /** @param {string} host */
  function pendingTokens(host) {
    const key = String(host || '').trim().toLowerCase();
    const nowMs = now();
    const stamps = (stampsByHost.get(key) || []).filter((t) => t > nowMs - windowMs);
    return stamps.length;
  }

  return { acquire511Slot, reset, pendingTokens, pendingCount: pendingTokens, capacity, windowMs };
}

const defaultLimiter = create511RateLimiter();

/** @param {string} host */
export async function acquire511Slot(host) {
  return defaultLimiter.acquire511Slot(host);
}

export function reset511RateLimiterForTests() {
  defaultLimiter.reset();
}

export const __testing__ = {
  reset() {
    defaultLimiter.reset();
  },
  pendingTokens(host) {
    return defaultLimiter.pendingTokens(host);
  },
};
