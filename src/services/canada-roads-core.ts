export interface CanadaRoadRecord {
  id: string;
  kind?: 'event' | 'alert' | 'condition';
  lat: number | null;
  lon: number | null;
  centroid?: [number, number] | null;
  severity: string;
  eventType: string;
  type?: string;
  isFullClosure: boolean;
  lanesAffected: string | null;
  roadwayName?: string;
  headline: string;
  description: string;
  path?: [number, number][] | null;
  jurisdiction: string;
  resource?: string;
  source?: string;
  district?: string | null;
  currImpact?: string | null;
  createdTime?: number | null;
  lastUpdated?: number | null;
  startTime?: number | null;
  endTime?: number | null;
}

export type CanadaRoadSourceState = 'available' | 'empty' | 'unavailable' | 'malformed';

export interface CanadaRoadSourceDescriptor {
  key: string;
  source: string;
  jurisdiction: string;
  onDemand: boolean;
}

export type CanadaRoadSourceStates = Record<string, CanadaRoadSourceState>;

export function recordsFromPayload(payload: unknown): CanadaRoadRecord[] | null {
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

export interface CanadaRoadCoreDependencies {
  getHydrated: (key: string) => unknown | undefined;
  fetchMissing: (descriptor: CanadaRoadSourceDescriptor) => Promise<unknown | undefined>;
}

export async function loadCanadaRoadSourcesCore(
  descriptors: readonly CanadaRoadSourceDescriptor[],
  dependencies: CanadaRoadCoreDependencies,
): Promise<{ records: CanadaRoadRecord[] | null; states: CanadaRoadSourceStates }> {
  const settled = await Promise.allSettled(descriptors.map(async (descriptor) => {
    const hydrated = dependencies.getHydrated(descriptor.key);
    const payload = hydrated !== undefined
      ? hydrated
      : await dependencies.fetchMissing(descriptor);
    if (payload == null) return { records: null, state: 'unavailable' as const };
    const records = stampSource(
      recordsFromPayload(payload),
      descriptor.source,
      descriptor.jurisdiction,
    );
    if (records == null) return { records, state: 'malformed' as const };
    return {
      records,
      state: records.length > 0 ? 'available' as const : 'empty' as const,
    };
  }));

  const states: CanadaRoadSourceStates = {};
  const groups: Array<CanadaRoadRecord[] | null> = [];
  settled.forEach((result, index) => {
    const descriptor = descriptors[index];
    if (!descriptor) return;
    if (result.status === 'rejected') {
      states[descriptor.key] = 'unavailable';
      groups.push(null);
      return;
    }
    states[descriptor.key] = result.value.state;
    groups.push(result.value.records);
  });
  return { records: unionCanadaRoadRecords(...groups), states };
}
