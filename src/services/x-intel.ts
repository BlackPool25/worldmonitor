import { proxyUrl } from '@/utils';
import { isDesktopRuntime, toApiUrl } from '@/services/runtime';

export interface XItem {
  id: string;
  source: 'x';
  account: string;
  accountTitle: string;
  url: string;
  ts: string;
  text: string;
  topic: string;
  tags: string[];
  earlySignal: boolean;
  hasMedia?: boolean;
  lang?: string;
  contentState?: string;
}

export interface XFeedResponse {
  source: string;
  earlySignal: boolean;
  enabled: boolean;
  count: number;
  updatedAt: string | null;
  items: XItem[];
}

export const X_TOPICS = [
  { id: 'all', labelKey: 'components.xIntel.filterAll' },
  { id: 'breaking', labelKey: 'components.xIntel.filterBreaking' },
  { id: 'conflict', labelKey: 'components.xIntel.filterConflict' },
  { id: 'geopolitics', labelKey: 'components.xIntel.filterGeopolitics' },
  { id: 'middleeast', labelKey: 'components.xIntel.filterMiddleeast' },
  { id: 'osint', labelKey: 'components.xIntel.filterOsint' },
  { id: 'cyber', labelKey: 'components.xIntel.filterCyber' },
] as const;

let cachedResponse: XFeedResponse | null = null;
let cachedAt = 0;
let cachedLimit = 0;
const inFlight = new Map<number, Promise<XFeedResponse>>();
const CACHE_TTL = 30_000;
const MISSING_TIMESTAMP_ISO = new Date(0).toISOString();

function xFeedUrl(limit: number): string {
  const path = `/api/x-feed?limit=${limit}`;
  return isDesktopRuntime() ? proxyUrl(path) : toApiUrl(path);
}

export async function fetchXFeed(limit = 50, signal?: AbortSignal): Promise<XFeedResponse> {
  if (cachedResponse && cachedLimit >= limit && Date.now() - cachedAt < CACHE_TTL) return cachedResponse;
  let request = inFlight.get(limit);
  if (!request) {
    request = (async () => {
      const res = await fetch(xFeedUrl(limit));
      if (!res.ok) throw new Error(`X feed ${res.status}`);

      const json: XFeedResponse = await res.json();
      cachedResponse = json;
      cachedAt = Date.now();
      cachedLimit = limit;
      return json;
    })().finally(() => {
      inFlight.delete(limit);
    });
    inFlight.set(limit, request);
  }
  if (!signal) return request;
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  return new Promise<XFeedResponse>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    request.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function formatXTime(ts: string): string {
  const time = new Date(ts).getTime();
  if (!Number.isFinite(time) || ts === MISSING_TIMESTAMP_ISO) return 'unknown';

  const diff = Date.now() - time;
  if (diff < 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}
