import { createCircuitBreaker } from '@/utils';
import { ensureHydrated, getHydratedData } from '@/services/bootstrap';
import { toApiUrl } from '@/services/runtime';
import {
  loadCanadaRoadSourcesCore,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

export {
  recordsFromPayload,
  unionCanadaRoadRecords,
  type CanadaRoadRecord,
  type CanadaRoadSourceDescriptor,
  type CanadaRoadSourceState,
  type CanadaRoadSourceStates,
} from './canada-roads-core';

/**
 * Unions bootstrap `canadaRoads` (infra:ontario-511:v1) and `albertaRoads`
 * (infra:alberta-511:v1) with on-demand `torontoRoads`
 * (infra:toronto-roads:v1).
 */
export const CANADA_ROAD_SOURCES: readonly CanadaRoadSourceDescriptor[] = Object.freeze([
  { key: 'canadaRoads', source: 'ontario-511', jurisdiction: 'ON', onDemand: false },
  { key: 'albertaRoads', source: 'alberta-511', jurisdiction: 'AB', onDemand: false },
  { key: 'torontoRoads', source: 'toronto-roads', jurisdiction: 'Toronto', onDemand: true },
]);

let lastSourceStates: CanadaRoadSourceStates = Object.fromEntries(
  CANADA_ROAD_SOURCES.map(({ key }) => [key, 'unavailable']),
);

const breaker = createCircuitBreaker<CanadaRoadRecord[]>({
  name: 'Canada roads',
  cacheTtlMs: 30 * 60 * 1000,
  persistCache: true,
});

const ON_DEMAND_LOADERS: Record<string, () => Promise<unknown | undefined>> = {
  torontoRoads: () => ensureHydrated('torontoRoads'),
};

const HYDRATED_LOADERS: Record<string, () => unknown | undefined> = {
  canadaRoads: () => getHydratedData('canadaRoads'),
  albertaRoads: () => getHydratedData('albertaRoads'),
  torontoRoads: () => getHydratedData('torontoRoads'),
};

interface CanadaRoadLoadDependencies {
  getHydrated?: (key: string) => unknown | undefined;
  ensureOnDemand?: (key: string) => Promise<unknown | undefined>;
  fetchFn?: typeof fetch;
}

async function fetchTierKey(key: string, fetchFn: typeof fetch): Promise<unknown | undefined> {
  const resp = await fetchFn(
    toApiUrl(`/api/bootstrap?keys=${encodeURIComponent(key)}`),
    { credentials: 'include', signal: AbortSignal.timeout(8000) },
  );
  if (!resp.ok) throw new Error(`Bootstrap fetch failed for ${key}: ${resp.status}`);
  const json = await resp.json() as { data?: Record<string, unknown> };
  return json.data?.[key];
}

export function loadCanadaRoadSources(
  descriptors: readonly CanadaRoadSourceDescriptor[] = CANADA_ROAD_SOURCES,
  dependencies: CanadaRoadLoadDependencies = {},
): Promise<{ records: CanadaRoadRecord[] | null; states: CanadaRoadSourceStates }> {
  const fetchFn = dependencies.fetchFn ?? fetch;
  return loadCanadaRoadSourcesCore(descriptors, {
    getHydrated: (key) => dependencies.getHydrated
      ? dependencies.getHydrated(key)
      : HYDRATED_LOADERS[key]?.(),
    fetchMissing: (descriptor) => descriptor.onDemand
      ? dependencies.ensureOnDemand
        ? dependencies.ensureOnDemand(descriptor.key)
        : ON_DEMAND_LOADERS[descriptor.key]?.() ?? Promise.resolve(undefined)
      : fetchTierKey(descriptor.key, fetchFn),
  });
}

export async function fetchCanadaRoads(): Promise<CanadaRoadRecord[]> {
  return breaker.execute(async () => {
    const result = await loadCanadaRoadSources();
    lastSourceStates = result.states;
    if (result.records != null) return result.records;
    throw new Error('No usable Canada road source in bootstrap');
  }, []);
}

export function getCanadaRoadSourceStates(): CanadaRoadSourceStates {
  return { ...lastSourceStates };
}

export function getCanadaRoadsStatus(): string {
  return breaker.getStatus();
}
