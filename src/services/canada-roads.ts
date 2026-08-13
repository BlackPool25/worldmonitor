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
  source?: string;
}

/** Unions bootstrap `canadaRoads` (infra:ontario-511:v1) with `albertaRoads` (infra:alberta-511:v1). */
const breaker = createCircuitBreaker<CanadaRoadRecord[]>({
  name: 'Canada 511',
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
    data?: unknown;
  };
  if (value.data && typeof value.data === 'object' && value.data !== value) {
    const nested = recordsFromPayload(value.data);
    if (nested) return nested;
  }
  if (Array.isArray(value.records)) return value.records;
  const combined = [
    ...(Array.isArray(value.events) ? value.events : []),
    ...(Array.isArray(value.alerts) ? value.alerts : []),
    ...(Array.isArray(value.conditions) ? value.conditions : []),
  ];
  return combined.length || Array.isArray(value.events) ? combined : null;
}

function stampSource(
  records: CanadaRoadRecord[] | null,
  source: string,
  jurisdiction: string,
): CanadaRoadRecord[] | null {
  if (!records) return null;
  return records.map((record) => ({
    ...record,
    source: record.source || source,
    jurisdiction: record.jurisdiction || jurisdiction,
  }));
}

export function unionCanadaRoadRecords(
  ...groups: Array<CanadaRoadRecord[] | null>
): CanadaRoadRecord[] | null {
  const present = groups.filter((group): group is CanadaRoadRecord[] => group != null);
  if (present.length === 0) return null;
  const seen = new Set<string>();
  const out: CanadaRoadRecord[] = [];
  for (const group of present) {
    for (const record of group) {
      const id = `${record.source || record.jurisdiction || ''}:${record.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(record);
    }
  }
  return out;
}

export async function fetchCanadaRoads(): Promise<CanadaRoadRecord[]> {
  return breaker.execute(async () => {
    const ontarioHydrated = stampSource(
      recordsFromPayload(getHydratedData('canadaRoads')),
      'ontario-511',
      'ON',
    );
    const albertaHydrated = stampSource(
      recordsFromPayload(getHydratedData('albertaRoads')),
      'alberta-511',
      'AB',
    );
    if (ontarioHydrated != null && albertaHydrated != null) {
      return unionCanadaRoadRecords(ontarioHydrated, albertaHydrated) ?? [];
    }

    const missing: string[] = [];
    if (ontarioHydrated == null) missing.push('canadaRoads');
    if (albertaHydrated == null) missing.push('albertaRoads');
    const resp = await fetch(
      toApiUrl(`/api/bootstrap?keys=${missing.join(',')}`),
      { credentials: 'include', signal: AbortSignal.timeout(8000) },
    );
    if (!resp.ok) throw new Error(`Bootstrap fetch failed: ${resp.status}`);
    const json = await resp.json() as { data?: { canadaRoads?: unknown; albertaRoads?: unknown } };
    const ontario = ontarioHydrated ?? stampSource(
      recordsFromPayload(json.data?.canadaRoads),
      'ontario-511',
      'ON',
    );
    const alberta = albertaHydrated ?? stampSource(
      recordsFromPayload(json.data?.albertaRoads),
      'alberta-511',
      'AB',
    );
    const records = unionCanadaRoadRecords(ontario, alberta);
    if (records) return records;

    throw new Error('No Canada 511 data in bootstrap');
  }, []);
}

export function getCanadaRoadsStatus(): string {
  return breaker.getStatus();
}
