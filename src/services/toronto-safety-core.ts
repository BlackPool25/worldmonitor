/**
 * Toronto public-safety source contract (#7012).
 *
 * Three signals stay distinct in storage, health, API, and UI labels:
 *   live_dispatch        — GTA Update police/fire (disabled, terms-review)
 *   reported_occurrence  — TPS Major Crime Indicators (official, on-demand)
 *   annual_aggregate     — TPS Calls for Service Attended (official, on-demand)
 *
 * This does not replace #6682 official live CAD. Do not fold either source
 * into canadaAlerts, canadaRoads, weather, news, or the official live-CAD
 * tracker. GTA location strings are never geocoded. TPS coordinates stay
 * the publisher's offset intersection points.
 */

export const TORONTO_SAFETY_SEMANTICS = Object.freeze({
  liveDispatch: 'live_dispatch',
  reportedOccurrence: 'reported_occurrence',
  annualAggregate: 'annual_aggregate',
} as const);

export type TorontoSafetySemantic =
  (typeof TORONTO_SAFETY_SEMANTICS)[keyof typeof TORONTO_SAFETY_SEMANTICS];

export interface TorontoSafetySourceDescriptor {
  id: string;
  semantic: TorontoSafetySemantic;
  canonicalKey: string;
  seedMetaKey: string;
  label: string;
  disclaimer: string;
  productionWriter: 'disabled' | 'on-demand';
  bootstrap: 'none';
  geocode: false;
}

export const TORONTO_SAFETY_SOURCES: readonly TorontoSafetySourceDescriptor[] = Object.freeze([
  {
    id: 'gta-update-police',
    semantic: TORONTO_SAFETY_SEMANTICS.liveDispatch,
    canonicalKey: 'safety:toronto:gta-update:police:v1',
    seedMetaKey: 'seed-meta:safety:gta-update-police',
    label: 'GTA Update police (unofficial live dispatch)',
    disclaimer:
      'Unofficial third-party TPS dispatch mirror. Delayed, incomplete, not official, not verified. Disabled pending written reuse permission.',
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'gta-update-fire',
    semantic: TORONTO_SAFETY_SEMANTICS.liveDispatch,
    canonicalKey: 'safety:toronto:gta-update:fire:v1',
    seedMetaKey: 'seed-meta:safety:gta-update-fire',
    label: 'GTA Update fire (unofficial live dispatch)',
    disclaimer:
      'Unofficial third-party TFS dispatch mirror. Delayed, incomplete, not official, not verified. Disabled pending written reuse permission.',
    productionWriter: 'disabled',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'tps-mci',
    semantic: TORONTO_SAFETY_SEMANTICS.reportedOccurrence,
    canonicalKey: 'safety:toronto:tps-mci:v1',
    seedMetaKey: 'seed-meta:safety:tps-mci',
    label: 'TPS Major Crime Indicators (reported occurrence)',
    disclaimer:
      'Contains information licensed under the Open Government Licence - Ontario. Retrospective offence/victim rows. Coordinates are deliberately offset. Not a live dispatch feed.',
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  },
  {
    id: 'tps-calls-attended',
    semantic: TORONTO_SAFETY_SEMANTICS.annualAggregate,
    canonicalKey: 'safety:toronto:tps-calls-attended:v1',
    seedMetaKey: 'seed-meta:safety:tps-calls-attended',
    label: 'TPS Calls for Service Attended (annual aggregate)',
    disclaimer:
      'Contains information licensed under the Open Government Licence - Ontario. Annual counts by division and neighbourhood. Not incident points.',
    productionWriter: 'on-demand',
    bootstrap: 'none',
    geocode: false,
  },
]);

export const TORONTO_SAFETY_CANONICAL_KEYS = Object.freeze(
  Object.fromEntries(TORONTO_SAFETY_SOURCES.map((source) => [source.id, source.canonicalKey])),
);

export function torontoSafetySourceById(id: string): TorontoSafetySourceDescriptor | undefined {
  return TORONTO_SAFETY_SOURCES.find((source) => source.id === id);
}

export function torontoSafetySourcesForSemantic(
  semantic: TorontoSafetySemantic,
): TorontoSafetySourceDescriptor[] {
  return TORONTO_SAFETY_SOURCES.filter((source) => source.semantic === semantic);
}
