import { createCircuitBreaker } from '@/utils';
import { getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';

export interface CanadaRoadRecord {
  id: string;
  kind?: 'event' | 'alert' | 'condition';
  lat: number | null;
  lon: number | null;
  centroid?: [number, number] | null;
  severity: string;
  eventType: string;
  isFullClosure: boolean;
  lanesAffected: string | null;
  roadwayName?: string;
  headline: string;
  description: string;
  path?: [number, number][] | null;
  jurisdiction: string;
  resource?: string;
}

const breaker = createCircuitBreaker<CanadaRoadRecord[]>({
  name: 'Ontario 511',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

function recordsFromPayload(payload: unknown): CanadaRoadRecord[] | null {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as {
    records?: CanadaRoadRecord[];
    events?: CanadaRoadRecord[];
    alerts?: CanadaRoadRecord[];
    conditions?: CanadaRoadRecord[];
  };
  if (Array.isArray(value.records)) return value.records;
  const combined = [
    ...(Array.isArray(value.events) ? value.events : []),
    ...(Array.isArray(value.alerts) ? value.alerts : []),
    ...(Array.isArray(value.conditions) ? value.conditions : []),
  ];
  return combined.length || Array.isArray(value.events) ? combined : null;
}

export async function fetchCanadaRoads(): Promise<CanadaRoadRecord[]> {
  return breaker.execute(async () => {
    const hydrated = recordsFromPayload(getHydratedData('canadaRoads'));
    if (hydrated) return hydrated;

    const resp = await fetch(
      toApiUrl('/api/bootstrap?keys=canadaRoads'),
      { credentials: 'include', signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) throw new Error(`Bootstrap fetch failed: ${resp.status}`);
    const json = await resp.json() as { data?: { canadaRoads?: unknown } };
    const records = recordsFromPayload(json.data?.canadaRoads);
    if (records) return records;

    throw new Error('No Ontario 511 data in bootstrap');
  }, []);
}

export function getCanadaRoadsStatus(): string {
  return breaker.getStatus();
}
