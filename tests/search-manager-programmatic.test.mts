/**
 * Manager-level regression coverage for programmatic dashboard search (#6212).
 *
 * SearchManager cannot be imported by node:test without loading the complete
 * browser/worker graph. Extract the production class (the same technique used
 * by other manager tests) and provide narrow doubles for its module globals.
 * The public searchDashboard/openSearchResult methods and their real selection,
 * visibility, entitlement, renderer, and capability code all run unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import ts from 'typescript';

import {
  LAYER_REGISTRY,
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerEntitled,
  isLayerExecutable,
} from '../src/config/map-layer-definitions.ts';
import { searchMatchIdentity, type SearchMatch, type SearchResult } from '../src/components/search-types.ts';
import { OpaqueResultCache } from '../src/services/opaque-result-cache.ts';

type Variant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity' | 'energy';

const managerSource = readFileSync(
  new URL('../src/app/search-manager.ts', import.meta.url),
  'utf8',
);

const sourceFile = ts.createSourceFile(
  'search-manager.ts',
  managerSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const managerNode = sourceFile.statements.find((statement): statement is ts.ClassDeclaration => (
  ts.isClassDeclaration(statement) && statement.name?.text === 'SearchManager'
));
assert.ok(managerNode, 'SearchManager class must remain in src/app/search-manager.ts');
const managerClassSource = managerNode.getText(sourceFile).replace(/^export\s+/, '');
const managerClassJs = ts.transpileModule(managerClassSource, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ES2022,
    useDefineForClassFields: true,
  },
}).outputText;

function extractClassJs(path: string, className: string): string {
  const moduleSource = readFileSync(new URL(path, import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(path, moduleSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declaration = parsed.statements.find((statement): statement is ts.ClassDeclaration => (
    ts.isClassDeclaration(statement) && statement.name?.text === className
  ));
  assert.ok(declaration, `${className} must remain in ${path}`);
  return ts.transpileModule(declaration.getText(parsed).replace(/^export\s+/, ''), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      useDefineForClassFields: true,
    },
  }).outputText;
}

const selectionDispatcherClassJs = extractClassJs(
  '../src/app/search-selection-dispatcher.ts',
  'SearchSelectionDispatcher',
);
const webMcpSearchControllerClassJs = extractClassJs(
  '../src/app/webmcp-search-controller.ts',
  'WebMcpSearchController',
);

interface Runtime {
  auth: { user?: { id: string; role?: string } };
  premium: boolean;
  pro: boolean;
  panelEntitled: boolean;
  selectedResultTypes: string[];
  detailedCountryAnalytics: Array<[string, string, string]>;
  authListeners: Set<() => void>;
  entitlementListeners: Set<() => void>;
  runtimeConfigListeners: Set<() => void>;
  widgetAccessListeners: Set<() => void>;
  liveFlightQueries: string[];
  deferTimers: boolean;
  nextTimerId: number;
  pendingTimers: Map<number, () => void>;
}

interface ModalDouble {
  matches: SearchMatch[];
  revision: number;
  openCalls: number;
  closeCalls: number;
  clearedSources: string[];
  flightCallsign: string | null;
  search(query: string, scope: string): {
    orderedMatches: SearchMatch[];
    flightCallsign: string | null;
  };
  getSearchIndexRevision(): number;
  registerSource(type: string, items: unknown[]): void;
  refreshSearch(): void;
  open(): void;
  closeForProgrammaticSelection(): void;
}

interface Scenario {
  manager: any;
  runtime: Runtime;
  modal: ModalDouble;
  ctx: any;
  calls: {
    views: string[];
    layers: string[];
    centers: Array<[number, number, number]>;
    timeRanges: string[];
    hotspotIds: string[];
    conflictIds: string[];
    pipelineIds: string[];
    countryBriefs: Array<[string, string, { trackDetailedAnalytics?: boolean } | undefined]>;
    enabledPanels: Array<[string, { trackDetailedAnalytics?: boolean } | undefined]>;
    scrolledPanels: string[];
  };
  state: {
    globe: boolean;
    deckGL: boolean;
    updateCount: number;
    onUpdate?: (count: number) => void;
  };
}

function createHarness(variant: Variant, runtime: Runtime): new (ctx: any, callbacks: any) => any {
  const dependencyNames = [
    'OpaqueResultCache',
    'SEARCH_RESULT_CACHE_MAX_ENTRIES',
    'SEARCH_RESULT_CACHE_TTL_MS',
    'FLIGHT_SEARCH_SOURCE_TTL_MS',
    'LAYER_PRESET_PRIMARY_LAYERS',
    'SITE_VARIANT',
    'DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS',
    'DASHBOARD_SEARCH_TYPE_MAX_CHARS',
    'DASHBOARD_SEARCH_TITLE_MAX_CHARS',
    'DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS',
    'searchMatchIdentity',
    'getAuthState',
    'hasPremiumAccess',
    'subscribeAuthState',
    'onEntitlementChange',
    'subscribeRuntimeConfig',
    'subscribeWidgetAccess',
    'ALL_PANELS',
    'getEffectivePanelConfig',
    'isPanelEntitled',
    'isProUser',
    'isFreePanelCapCounted',
    'countFreePanelCapUsage',
    'FREE_MAX_PANELS',
    'getAllowedLayerKeys',
    'isLayerCommandAllowed',
    'isLayerExecutable',
    'isLayerEntitled',
    'LAYER_PRESETS',
    'LAYER_KEY_MAP',
    'trackSearchResultSelected',
    'trackCountrySelected',
    'runWithAgentAnalyticsSuppressed',
    'suppressNextAgentPanelView',
    'saveToStorage',
    'STORAGE_KEYS',
    'setTheme',
    'TIER1_COUNTRIES',
    'CURATED_COUNTRIES',
    'getCountryBbox',
    't',
    'setTimeout',
    'clearTimeout',
    'fetchAircraftPositions',
  ];
  const dependencyValues = [
    OpaqueResultCache,
    64,
    120_000,
    120_000,
    {
      military: ['bases', 'flights', 'military'],
      finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic'],
      infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
      intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
      minimal: ['conflicts', 'hotspots'],
    },
    variant,
    10_000,
    80,
    240,
    320,
    searchMatchIdentity,
    () => runtime.auth,
    () => runtime.premium,
    (listener: () => void) => {
      runtime.authListeners.add(listener);
      return () => runtime.authListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.entitlementListeners.add(listener);
      return () => runtime.entitlementListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.runtimeConfigListeners.add(listener);
      return () => runtime.runtimeConfigListeners.delete(listener);
    },
    (listener: () => void) => {
      runtime.widgetAccessListeners.add(listener);
      return () => runtime.widgetAccessListeners.delete(listener);
    },
    { 'test-panel': { id: 'test-panel' } },
    (panelId: string) => panelId === 'test-panel' ? { id: panelId } : undefined,
    () => runtime.panelEntitled,
    () => runtime.pro,
    () => true,
    () => 0,
    6,
    getAllowedLayerKeys,
    isLayerCommandAllowed,
    isLayerExecutable,
    isLayerEntitled,
    {
      military: ['bases', 'nuclear', 'flights', 'military', 'waterways'],
      finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic', 'tradeRoutes'],
      infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
      intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
      minimal: ['conflicts', 'hotspots'],
    },
    {},
    (type: string) => runtime.selectedResultTypes.push(type),
    (code: string, name: string, source: string) => {
      runtime.detailedCountryAnalytics.push([code, name, source]);
    },
    <T>(callback: () => T) => callback(),
    () => {},
    () => {},
    { mapLayers: 'mapLayers' },
    () => {},
    { US: 'United States' },
    {},
    () => null,
    (key: string) => key,
    (callback: () => void) => {
      if (!runtime.deferTimers) {
        queueMicrotask(callback);
        return 0;
      }
      const timer = runtime.nextTimerId++;
      runtime.pendingTimers.set(timer, callback);
      return timer;
    },
    (timer: number) => { runtime.pendingTimers.delete(timer); },
    (request: { callsign?: string }) => {
      runtime.liveFlightQueries.push(request.callsign ?? '');
      return Promise.resolve([{
        icao24: 'abc123',
        callsign: request.callsign ?? 'AB123',
        lat: 1,
        lon: 2,
        altitudeFt: 30_000,
        groundSpeedKts: 450,
        observedAt: Date.now(),
        onGround: false,
      }]);
    },
  ];

  // eslint-disable-next-line no-new-func
  return new Function(
    ...dependencyNames,
    `${selectionDispatcherClassJs}\n${webMcpSearchControllerClassJs}\n${managerClassJs}\nreturn SearchManager;`,
  )(...dependencyValues) as new (ctx: any, callbacks: any) => any;
}

function resultMatch(
  type: SearchResult['type'],
  id: string,
  title: string,
  data: unknown,
  subtitle?: string,
): SearchMatch {
  return {
    kind: 'result',
    score: 2,
    result: { type, id, title, subtitle, data },
  };
}

function commandMatch(id: string, category: string, title = id): SearchMatch {
  return {
    kind: 'command',
    score: 2,
    title,
    subtitle: category,
    command: {
      id,
      category,
      label: title,
      keywords: [title.toLowerCase()],
      icon: '',
    },
  } as SearchMatch;
}

function makeScenario(
  matches: SearchMatch[],
  variant: Variant = 'full',
): Scenario {
  const runtime: Runtime = {
    auth: { user: { id: 'user-a', role: 'pro' } },
    premium: true,
    pro: true,
    panelEntitled: true,
    selectedResultTypes: [],
    detailedCountryAnalytics: [],
    authListeners: new Set(),
    entitlementListeners: new Set(),
    runtimeConfigListeners: new Set(),
    widgetAccessListeners: new Set(),
    liveFlightQueries: [],
    deferTimers: false,
    nextTimerId: 1,
    pendingTimers: new Map(),
  };
  const calls: Scenario['calls'] = {
    views: [],
    layers: [],
    centers: [],
    timeRanges: [],
    hotspotIds: [],
    conflictIds: [],
    pipelineIds: [],
    countryBriefs: [],
    enabledPanels: [],
    scrolledPanels: [],
  };
  const state: Scenario['state'] = {
    globe: false,
    deckGL: true,
    updateCount: 0,
  };
  const modal: ModalDouble = {
    matches: [...matches],
    revision: 1,
    openCalls: 0,
    closeCalls: 0,
    clearedSources: [],
    flightCallsign: null,
    search: () => ({
      orderedMatches: [...modal.matches],
      flightCallsign: modal.flightCallsign,
    }),
    getSearchIndexRevision: () => modal.revision,
    registerSource: (type, items) => {
      if (items.length === 0) modal.clearedSources.push(type);
      if (type === 'flight' && items.length > 0) {
        modal.matches = (items as Array<{
          id: string;
          title: string;
          subtitle?: string;
          data: unknown;
        }>).map((item) => resultMatch('flight', item.id, item.title, item.data, item.subtitle));
      }
    },
    refreshSearch: () => {},
    open: () => { modal.openCalls += 1; },
    closeForProgrammaticSelection: () => { modal.closeCalls += 1; },
  };
  const mapLayers = Object.fromEntries(
    Object.keys(LAYER_REGISTRY).map((key) => [key, false]),
  );
  const ctx = {
    searchModal: modal,
    mapLayers,
    map: {
      isGlobeMode: () => state.globe,
      isDeckGLActive: () => state.deckGL,
      setView: (view: string) => calls.views.push(view),
      enableLayer: (layer: string) => calls.layers.push(layer),
      setLayers: () => {},
      setCenter: (lat: number, lon: number, zoom: number) => calls.centers.push([lat, lon, zoom]),
      setTimeRange: (range: string) => calls.timeRanges.push(range),
      triggerHotspotClick: (id: string) => calls.hotspotIds.push(id),
      triggerConflictClick: (id: string) => calls.conflictIds.push(id),
      triggerPipelineClick: (id: string) => calls.pipelineIds.push(id),
    },
    panelSettings: {
      'test-panel': { enabled: false },
      markets: { enabled: true },
      polymarket: { enabled: true },
    },
    panels: {},
    newsPanels: {},
    allNews: [],
    latestPredictions: [],
    latestMarkets: [],
    latestTechEvents: [],
  };
  const Harness = createHarness(variant, runtime);
  const manager = new Harness(ctx, {
    openCountryBriefByCode: (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean },
    ) => {
      calls.countryBriefs.push([code, name, options]);
      return true;
    },
    enablePanel: (
      panelId: string,
      options?: { trackDetailedAnalytics?: boolean },
    ) => {
      calls.enabledPanels.push([panelId, options]);
      return true;
    },
  });
  manager.updateSearchIndex = () => {
    state.updateCount += 1;
    state.onUpdate?.(state.updateCount);
  };
  manager.searchSelection.scrollToPanel = (panelId: string) => calls.scrolledPanels.push(panelId);
  manager.searchSelection.scrollToPanelWhenReady = (panelId: string) => calls.scrolledPanels.push(panelId);
  manager.searchSelection.dispatchPanelTab = () => {};
  manager.destroyed = false;

  return { manager, runtime, modal, ctx, calls, state };
}

async function searchThenOpen(scenario: Scenario, index = 0) {
  const response = await scenario.manager.searchDashboard('needle', 'all', 10);
  const descriptor = response.results[index];
  assert.ok(descriptor, `expected search result at index ${index}`);
  const opened = await scenario.manager.openSearchResult(descriptor.key, async () => {});
  return { response, descriptor, opened };
}

function flushTimers(runtime: Runtime): void {
  while (runtime.pendingTimers.size > 0) {
    const callbacks = [...runtime.pendingTimers.values()];
    runtime.pendingTimers.clear();
    for (const callback of callbacks) callback();
  }
}

describe('SearchManager programmatic dashboard search (#6212)', () => {
  it('denies forged keys and consumes issued keys before selection', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);

    assert.deepEqual(await scenario.manager.openSearchResult(`sr_${'f'.repeat(32)}`), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });

    const first = await searchThenOpen(scenario);
    assert.deepEqual(first.opened, { ok: true, status: 'opened', type: 'country' });
    assert.deepEqual(await scenario.manager.openSearchResult(first.descriptor.key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.equal(scenario.calls.countryBriefs.length, 1, 'replay must not repeat selection');
    assert.equal(scenario.modal.openCalls, 0, 'programmatic search must not open CMD+K');
  });

  it('cancels delayed work from an earlier programmatic selection', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'old-hotspot', 'Old hotspot', { id: 'old-hotspot' }),
      resultMatch('country', 'CA', 'Canada', { code: 'CA', name: 'Canada' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[0].key),
      { ok: true, status: 'opened', type: 'hotspot' },
    );
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[1].key),
      { ok: true, status: 'opened', type: 'country' },
    );

    flushTimers(scenario.runtime);
    assert.deepEqual(scenario.calls.hotspotIds, []);
    assert.deepEqual(scenario.calls.countryBriefs, [[
      'CA',
      'Canada',
      { trackDetailedAnalytics: false },
    ]]);
  });

  it('cancels delayed programmatic selection work on destroy', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'stale-hotspot', 'Stale hotspot', { id: 'stale-hotspot' }),
    ]);
    scenario.runtime.deferTimers = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);

    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[0].key),
      { ok: true, status: 'opened', type: 'hotspot' },
    );
    assert.equal(scenario.runtime.pendingTimers.size, 1);
    scenario.manager.destroy();
    flushTimers(scenario.runtime);

    assert.deepEqual(scenario.calls.hotspotIds, []);
  });

  it('re-resolves a refreshed target and dispatches its fresh non-indexed payload', async () => {
    const oldMatch = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Old display name' },
      'CII: 42',
    );
    const freshMatch = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Fresh display name' },
      'CII: 42',
    );
    const scenario = makeScenario([oldMatch]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.matches = [freshMatch];
      }
    };

    const { opened } = await searchThenOpen(scenario);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'country' });
    assert.deepEqual(scenario.calls.countryBriefs, [[
      'XZ',
      'Fresh display name',
      { trackDetailedAnalytics: false },
    ]]);
    assert.deepEqual(
      scenario.runtime.detailedCountryAnalytics,
      [],
      'agent selection must suppress detailed country analytics',
    );
  });

  it('keeps the latest aircraft snapshot and republishes it on premium restoration', () => {
    const scenario = makeScenario([]);
    scenario.manager.observeSecurityContext();

    scenario.runtime.premium = false;
    scenario.runtime.pro = false;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    scenario.manager.updateFlightSource([{
      icao24: 'abc123',
      callsign: 'AB123',
      lat: 1,
      lon: 2,
      altitudeFt: 30_000,
      groundSpeedKts: 450,
      observedAt: Date.now(),
      onGround: false,
    }], [], Date.now());

    scenario.runtime.premium = true;
    scenario.runtime.pro = true;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    assert.equal(scenario.modal.matches[0]?.result.type, 'flight');
    assert.equal(scenario.modal.matches[0]?.result.id, 'abc123');
  });

  it('uses the live callsign fallback for programmatic search', async () => {
    const scenario = makeScenario([]);
    scenario.modal.flightCallsign = 'AB123';

    const response = await scenario.manager.searchDashboard('flight ab123', 'signals', 10);

    assert.deepEqual(scenario.runtime.liveFlightQueries, ['AB123']);
    assert.equal(response.results[0]?.type, 'flight');
    assert.equal(response.results[0]?.title, 'AB123');
  });

  it('keeps analytics origin local while an agent country selection is awaiting presentation', async () => {
    const agentMatch = resultMatch(
      'country',
      'US',
      'United States',
      { code: 'US', name: 'United States' },
    );
    const humanMatch = resultMatch(
      'country',
      'CA',
      'Canada',
      { code: 'CA', name: 'Canada' },
    );
    const scenario = makeScenario([agentMatch]);
    let resolveAgentSelection!: (opened: boolean) => void;
    let selectionCount = 0;
    scenario.manager.callbacks.openCountryBriefByCode = (
      code: string,
      name: string,
      options?: { trackDetailedAnalytics?: boolean },
    ) => {
      scenario.calls.countryBriefs.push([code, name, options]);
      selectionCount += 1;
      if (selectionCount === 1) {
        return new Promise<boolean>((resolve) => {
          resolveAgentSelection = resolve;
        });
      }
      return true;
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    const pendingAgentOpen = scenario.manager.openSearchResult(key);
    assert.equal(scenario.calls.countryBriefs.length, 1, 'agent selection should be awaiting presentation');

    assert.equal(scenario.manager.searchSelection.handleSearchResult(humanMatch.result), true);
    assert.deepEqual(scenario.runtime.detailedCountryAnalytics, [[
      'CA',
      'Canada',
      'search',
    ]]);
    assert.deepEqual(scenario.calls.countryBriefs, [
      ['US', 'United States', { trackDetailedAnalytics: false }],
      ['CA', 'Canada', { trackDetailedAnalytics: true }],
    ]);

    resolveAgentSelection(true);
    assert.deepEqual(await pendingAgentOpen, {
      ok: true,
      status: 'opened',
      type: 'country',
    });
  });

  it('fails closed when the semantic search index revision changes', async () => {
    const match = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Example Republic' },
      'CII: 42',
    );
    const scenario = makeScenario([match]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) scenario.modal.revision += 1;
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    assert.deepEqual(scenario.calls.countryBriefs, []);
  });

  it('waits for async source hydration before issuing capabilities', async () => {
    const match = resultMatch(
      'country',
      'XZ',
      'Example Republic',
      { code: 'XZ', name: 'Example Republic' },
    );
    const scenario = makeScenario([match]);
    let releaseHydration!: () => void;
    scenario.manager.searchIndexReady = new Promise<void>((resolve) => {
      releaseHydration = resolve;
    });
    let settled = false;
    const pendingSearch = scenario.manager.searchDashboard('needle', 'all', 10)
      .then((response: unknown) => {
        settled = true;
        return response;
      });
    await Promise.resolve();
    assert.equal(settled, false);
    releaseHydration();
    const response = await pendingSearch;
    const key = (response as { results: Array<{ key: string }> }).results[0]?.key;
    assert.ok(key);
    const opened = await scenario.manager.openSearchResult(key);
    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'country' });
    assert.equal(scenario.calls.countryBriefs.length, 1);
  });

  it('denies without selection when destroyed during renderer readiness', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    const opened = await scenario.manager.openSearchResult(key, async () => {
      scenario.manager.destroy();
    });
    assert.deepEqual(opened, {
      ok: false,
      status: 'denied',
      reason: 'search_state_changed',
    });
    assert.deepEqual(scenario.calls.pipelineIds, []);
  });

  it('denies a key when an index revision removes its logical target', async () => {
    const scenario = makeScenario([
      resultMatch('hotspot', 'removed', 'Removed hotspot', { id: 'removed' }),
    ]);
    scenario.state.onUpdate = (count) => {
      if (count === 2) {
        scenario.modal.revision += 1;
        scenario.modal.matches = [];
      }
    };

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_available',
    });
    assert.deepEqual(scenario.calls.hotspotIds, []);
  });

  it('invalidates capabilities across an A -> signed-out -> A security-context cycle', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.observeSecurityContext();
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.runtime.auth = {};
    scenario.runtime.premium = false;
    for (const listener of scenario.runtime.authListeners) listener();
    scenario.runtime.auth = { user: { id: 'user-a', role: 'pro' } };
    scenario.runtime.premium = true;
    for (const listener of scenario.runtime.authListeners) listener();

    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.ok(scenario.modal.clearedSources.includes('flight'));
    assert.deepEqual(scenario.calls.countryBriefs, []);
    scenario.manager.destroy();
  });

  it('invalidates capabilities across a same-user entitlement downgrade and restoration', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.observeSecurityContext();
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.runtime.premium = false;
    scenario.runtime.pro = false;
    for (const listener of scenario.runtime.entitlementListeners) listener();
    scenario.runtime.premium = true;
    scenario.runtime.pro = true;
    for (const listener of scenario.runtime.entitlementListeners) listener();

    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'invalid_or_expired_key',
    });
    assert.deepEqual(scenario.calls.countryBriefs, []);
    scenario.manager.destroy();
  });

  it('revalidates executability after a renderer flip', async () => {
    const scenario = makeScenario([
      resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
    ]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, true);
    const key = response.results[0]?.key;
    assert.ok(key);

    scenario.state.globe = true;
    let readinessCalls = 0;
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {
      readinessCalls += 1;
    }), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(readinessCalls, 0, 'a denied key must not wake the deferred renderer');
    assert.deepEqual(scenario.calls.layers, []);
    assert.deepEqual(scenario.calls.pipelineIds, []);
  });

  it('denies cached civilian aircraft after a globe switch while retaining military aircraft', async () => {
    const civilian = resultMatch(
      'flight',
      'civilian-1',
      'NEEDLE1',
      { kind: 'adsb', lat: 1, lon: 2, layer: 'flights' },
    );
    const military = resultMatch(
      'flight',
      'military-1',
      'NEEDLE2',
      { kind: 'military', lat: 3, lon: 4, layer: 'military' },
    );
    const scenario = makeScenario([civilian, military]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.deepEqual(response.results.map((result: { executable: boolean }) => result.executable), [
      true,
      true,
    ]);

    scenario.state.globe = true;
    let readinessCalls = 0;
    assert.deepEqual(await scenario.manager.openSearchResult(
      response.results[0].key,
      async () => { readinessCalls += 1; },
    ), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(readinessCalls, 0, 'an invisible civilian target must not wake the renderer');

    assert.deepEqual(await scenario.manager.openSearchResult(
      response.results[1].key,
      async () => { readinessCalls += 1; },
    ), {
      ok: true,
      status: 'opened',
      type: 'flight',
    });
    assert.equal(readinessCalls, 1);
    assert.deepEqual(scenario.calls.layers, ['military']);
    assert.deepEqual(scenario.calls.centers, [[3, 4, 9]]);
  });

  it('denies globe time commands that only mutate hidden renderer state', async () => {
    const scenario = makeScenario([
      commandMatch('time:24h', 'actions', 'Last 24 hours'),
    ]);
    scenario.state.globe = true;
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.results[0]?.executable, false);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key, async () => {}), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.deepEqual(scenario.calls.timeRanges, []);
  });

  it('denies news retained only by a disabled hidden panel', () => {
    const news = resultMatch('news', 'story', 'Needle story', { link: 'https://example.test/story' });
    const scenario = makeScenario([news]);
    scenario.ctx.newsPanels = {
      politics: { hasNewsItem: () => true },
    };
    scenario.ctx.panelSettings.politics = { enabled: false };
    assert.equal(scenario.manager.isSearchResultExecutable(news.result), false);
  });

  it('opens a duplicate news link in an enabled live panel instead of a disabled first match', async () => {
    const link = 'https://example.test/duplicate-story';
    const news = resultMatch('news', 'duplicate-story', 'Needle story', { link });
    const scenario = makeScenario([news]);
    const itemScrolls: string[] = [];
    scenario.ctx.newsPanels = {
      disabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('disabled'),
      },
      enabled: {
        hasNewsItem: () => true,
        scrollToNewsItem: () => itemScrolls.push('enabled'),
      },
    };
    scenario.ctx.panelSettings.disabled = { enabled: false };
    scenario.ctx.panelSettings.enabled = { enabled: true };
    scenario.ctx.panels.enabled = {
      getElement: () => ({ isConnected: true }),
    };

    const { opened } = await searchThenOpen(scenario);

    assert.deepEqual(opened, { ok: true, status: 'opened', type: 'news' });
    assert.deepEqual(scenario.calls.scrolledPanels, ['enabled']);
    assert.deepEqual(itemScrolls, ['enabled']);
  });

  it('does not report a country opened when the lazy brief surface fails', async () => {
    const scenario = makeScenario([
      resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
    ]);
    scenario.manager.callbacks.openCountryBriefByCode = async () => false;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
  });

  it('awaits country commands and closes an open palette before dispatch', async () => {
    const scenario = makeScenario([
      commandMatch('country:US', 'actions', 'United States'),
    ]);
    scenario.manager.callbacks.openCountryBriefByCode = async () => false;

    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    const key = response.results[0]?.key;
    assert.ok(key);
    assert.deepEqual(await scenario.manager.openSearchResult(key), {
      ok: false,
      status: 'denied',
      reason: 'result_no_longer_executable',
    });
    assert.equal(scenario.modal.closeCalls, 1);
  });

  it('keeps human-only commands visible while denying agent no-op or unsafe paths', () => {
    const scenario = makeScenario([]);
    for (const action of ['settings', 'route-explorer', 'refresh', 'fullscreen']) {
      const command = commandMatch(`view:${action}`, 'view', action).command;
      assert.equal(scenario.manager.isModalCommandVisible(command), true, action);
      assert.equal(scenario.manager.isCommandExecutable(command), false, action);
    }

    const themeCommand = commandMatch('view:dark', 'view', 'dark').command;
    assert.equal(scenario.manager.isModalCommandVisible(themeCommand), true);
    assert.equal(scenario.manager.isCommandExecutable(themeCommand), true);

    const unloadedCountryMap = commandMatch('country-map:US', 'country-map', 'United States').command;
    assert.equal(scenario.manager.isModalCommandVisible(unloadedCountryMap), false);
    assert.equal(scenario.manager.isCommandExecutable(unloadedCountryMap), false);
  });

  it('does not treat an incidental preset overlap as a meaningful agent action', () => {
    const finance = makeScenario([], 'finance');
    const militaryPreset = commandMatch('layers:military', 'layers', 'Military layers').command;
    assert.equal(finance.manager.isModalCommandVisible(militaryPreset), true);
    assert.equal(finance.manager.isCommandExecutable(militaryPreset), false);

    const full = makeScenario([], 'full');
    assert.equal(full.manager.isCommandExecutable(militaryPreset), true);
  });

  it('routes country, panel, map, infrastructure, finance, and command selections through shared handlers', async () => {
    const cases: Array<{
      label: string;
      variant?: Variant;
      match: SearchMatch;
      verify(scenario: Scenario): void;
    }> = [
      {
        label: 'country',
        match: resultMatch('country', 'US', 'United States', { code: 'US', name: 'United States' }),
        verify: ({ calls, runtime }) => {
          assert.deepEqual(calls.countryBriefs, [[
            'US',
            'United States',
            { trackDetailedAnalytics: false },
          ]]);
          assert.deepEqual(runtime.detailedCountryAnalytics, []);
        },
      },
      {
        label: 'panel',
        match: commandMatch('panel:test-panel', 'panels', 'Test panel'),
        verify: ({ calls }) => {
          assert.deepEqual(calls.enabledPanels, [[
            'test-panel',
            { trackDetailedAnalytics: false },
          ]]);
          assert.deepEqual(calls.scrolledPanels, ['test-panel']);
        },
      },
      {
        label: 'hotspot',
        match: resultMatch('hotspot', 'hs-1', 'Needle hotspot', { id: 'hs-1' }),
        verify: ({ calls }) => assert.deepEqual(calls.hotspotIds, ['hs-1']),
      },
      {
        label: 'conflict',
        match: resultMatch('conflict', 'conflict-1', 'Needle conflict', { id: 'conflict-1' }),
        verify: ({ calls }) => assert.deepEqual(calls.conflictIds, ['conflict-1']),
      },
      {
        label: 'infrastructure',
        match: resultMatch('pipeline', 'pipe-1', 'Needle pipeline', { id: 'pipe-1' }),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('pipelines'));
          assert.deepEqual(calls.pipelineIds, ['pipe-1']);
        },
      },
      {
        label: 'finance',
        variant: 'finance',
        match: resultMatch(
          'exchange',
          'xnas',
          'Needle exchange',
          { id: 'xnas', lat: 40.7, lon: -74 },
        ),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('stockExchanges'));
          assert.deepEqual(calls.centers, [[40.7, -74, 4]]);
        },
      },
      {
        label: 'tech event',
        variant: 'tech',
        match: resultMatch(
          'techevent',
          'event-1',
          'Needle tech event',
          { id: 'event-1', lat: 37.8, lng: -122.4 },
        ),
        verify: ({ calls }) => {
          assert.ok(calls.layers.includes('techEvents'));
          assert.deepEqual(calls.centers, [[37.8, -122.4, 5]]);
        },
      },
      {
        label: 'command',
        match: commandMatch('time:7d', 'actions', 'Last seven days'),
        verify: ({ calls }) => assert.deepEqual(calls.timeRanges, ['7d']),
      },
    ];

    for (const testCase of cases) {
      const scenario = makeScenario([testCase.match], testCase.variant);
      const { opened } = await searchThenOpen(scenario);
      assert.deepEqual(
        opened,
        {
          ok: true,
          status: 'opened',
          type: testCase.match.kind === 'command' ? 'command' : testCase.match.result.type,
        },
        testCase.label,
      );
      testCase.verify(scenario);
      assert.equal(scenario.modal.openCalls, 0, `${testCase.label} must not open CMD+K`);
    }
  });

  it('keeps same-id flight capabilities bound to their exact civilian or military target', async () => {
    const civilian = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'adsb', lat: 1, lon: 2, layer: 'flights' },
    );
    const military = resultMatch(
      'flight',
      'abc123',
      'NEEDLE1',
      { kind: 'military', lat: 3, lon: 4, layer: 'military' },
    );
    assert.notEqual(searchMatchIdentity(civilian), searchMatchIdentity(military));
    const scenario = makeScenario([civilian, military]);
    const response = await scenario.manager.searchDashboard('needle', 'all', 10);
    assert.equal(response.resultCount, 2);

    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[0].key, async () => {}),
      { ok: true, status: 'opened', type: 'flight' },
    );
    assert.deepEqual(
      await scenario.manager.openSearchResult(response.results[1].key, async () => {}),
      { ok: true, status: 'opened', type: 'flight' },
    );
    assert.deepEqual(scenario.calls.layers, ['flights', 'military']);
    assert.deepEqual(scenario.calls.centers, [[1, 2, 9], [3, 4, 9]]);
  });

  it('clears an expired live-flight source before search or selection', () => {
    const scenario = makeScenario([]);
    scenario.manager.flightSourceExpiresAt = Date.now() - 1;
    scenario.manager.updateSearchIndex = undefined;

    // Run the production refresh method now that the narrow harness state is
    // configured. Unrelated index helpers are replaced with no-ops.
    scenario.manager.syncPanelSearchIndex = () => {};
    scenario.manager.buildCountrySearchItems = () => [];
    scenario.ctx.allNews = [];
    scenario.ctx.latestPredictions = [];
    scenario.ctx.latestMarkets = [];
    const productionUpdate = Object.getPrototypeOf(scenario.manager).updateSearchIndex;
    productionUpdate.call(scenario.manager, { updateVisibleMetrics: false });

    assert.ok(scenario.modal.clearedSources.includes('flight'));
    assert.equal(scenario.manager.flightSourceExpiresAt, 0);
  });

  it('populates flight search for every premium access path, including runtime API keys', () => {
    const scenario = makeScenario([]);
    scenario.runtime.pro = false;
    scenario.runtime.premium = true;

    scenario.manager.updateFlightSource([{
      icao24: 'abc123',
      callsign: 'NEEDLE1',
      altitudeFt: 30_000,
      groundSpeedKts: 420,
      onGround: false,
      lat: 1,
      lon: 2,
    }], [], Date.now());

    assert.ok(scenario.manager.flightSourceExpiresAt > Date.now());
    assert.equal(scenario.modal.clearedSources.includes('flight'), false);
    const flightSearchWiring = managerSource.slice(
      managerSource.indexOf("setOnFlightSearch((callsign)"),
      managerSource.indexOf("private async registerBaseSearchSource"),
    );
    assert.match(flightSearchWiring, /if \(!hasPremiumAccess\(getAuthState\(\)\)\) return;/);
    assert.doesNotMatch(flightSearchWiring, /if \(!isProUser\(\)/);
  });

  it('uses the same premium policy for panel entitlement and free-cap bypass', () => {
    const scenario = makeScenario([
      commandMatch('panel:test-panel', 'panels', 'Needle panel'),
    ]);
    scenario.runtime.pro = false;
    scenario.runtime.premium = true;
    scenario.runtime.panelEntitled = true;

    assert.equal(scenario.manager.isCommandExecutable(
      commandMatch('panel:test-panel', 'panels').command,
    ), true);
  });

  it('enforces the six-variant entity visibility matrix without leaking foreign domains', () => {
    const probes: Record<string, SearchResult> = {
      country: {
        type: 'country', id: 'US', title: 'United States', data: { code: 'US', name: 'United States' },
      },
      hotspot: { type: 'hotspot', id: 'hs', title: 'Hotspot', data: { id: 'hs' } },
      pipeline: { type: 'pipeline', id: 'pipe', title: 'Pipeline', data: { id: 'pipe' } },
      techcompany: { type: 'techcompany', id: 'tech', title: 'Tech', data: { id: 'tech' } },
      exchange: { type: 'exchange', id: 'exchange', title: 'Exchange', data: { id: 'exchange' } },
      commodityhub: { type: 'commodityhub', id: 'hub', title: 'Hub', data: { id: 'hub' } },
    };
    const expected: Record<Variant, string[]> = {
      full: ['country', 'hotspot', 'pipeline'],
      tech: ['country', 'techcompany'],
      finance: ['country', 'pipeline', 'exchange', 'commodityhub'],
      happy: ['country'],
      commodity: ['country', 'pipeline', 'commodityhub'],
      energy: ['country', 'pipeline', 'commodityhub'],
    };

    for (const variant of Object.keys(expected) as Variant[]) {
      const scenario = makeScenario([], variant);
      const visible = Object.entries(probes)
        .filter(([, result]) => scenario.manager.isSearchResultVisible(result))
        .map(([name]) => name);
      assert.deepEqual(visible, expected[variant], variant);
      assert.equal(scenario.modal.openCalls, 0, variant);
    }
  });

  it('registers commodity hubs through the shared variant-layer policy', () => {
    const enabledVariants = (['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as Variant[])
      .filter((variant) => getAllowedLayerKeys(variant).has('commodityHubs'));
    assert.deepEqual(enabledVariants, ['finance', 'commodity', 'energy']);

    let commodityRegistration: ts.CallExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'registerSource'
        && ts.isStringLiteral(node.arguments[0])
        && node.arguments[0].text === 'commodityhub'
      ) {
        commodityRegistration = node;
      }
      ts.forEachChild(node, visit);
    };
    visit(managerNode);
    assert.ok(commodityRegistration, 'commodityhub source must be registered');

    let parent: ts.Node | undefined = commodityRegistration.parent;
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
    assert.ok(parent && ts.isIfStatement(parent), 'commodityhub registration must be policy-gated');
    assert.match(
      parent.expression.getText(sourceFile),
      /getAllowedLayerKeys[\s\S]+?\.has\('commodityHubs'\)/,
    );
  });

  it('preloads military bases only for variants where base results are visible', () => {
    const calls: ts.CallExpression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'registerBaseSearchSource'
      ) calls.push(node);
      ts.forEachChild(node, visit);
    };
    visit(managerNode);
    assert.equal(calls.length, 1);
    let parent: ts.Node | undefined = calls[0]?.parent;
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent;
    assert.ok(parent && ts.isIfStatement(parent));
    assert.match(parent.expression.getText(sourceFile), /\.has\('bases'\)/);
    assert.deepEqual(
      (['full', 'tech', 'finance', 'happy', 'commodity', 'energy'] as Variant[])
        .filter((variant) => getAllowedLayerKeys(variant).has('bases')),
      ['full'],
    );
  });
});
