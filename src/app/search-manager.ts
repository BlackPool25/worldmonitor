import type { AppContext, AppModule } from '@/app/app-context';
import type { SearchResult } from '@/components/search-types';
import {
  searchMatchIdentity,
  type SearchMatch,
} from '@/components/search-types';
import type { SearchScope } from '@/components/search-scope';
import type { NewsItem, MapLayers, MilitaryBase, MilitaryFlight } from '@/types';
import type { MapView, TimeRange } from '@/components/MapContainer';
import type { Command } from '@/config/commands';
import { SearchModal } from '@/components/SearchModal';
import type { CIIPanel } from '@/components/CIIPanel';
import {
  SITE_VARIANT,
  STORAGE_KEYS,
  ALL_PANELS,
  FREE_MAX_PANELS,
  countFreePanelCapUsage,
  getEffectivePanelConfig,
  isFreePanelCapCounted,
  isPanelEntitled,
} from '@/config';
import {
  getAllowedLayerKeys,
  isLayerCommandAllowed,
  isLayerExecutable,
  isLayerEntitled,
} from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import { LAYER_PRESETS, LAYER_KEY_MAP } from '@/config/commands';
import { TIER1_COUNTRIES } from '@/services/country-instability';
import { getCachedCountryScores } from '@/services/cached-risk-scores';
import { CURATED_COUNTRIES } from '@/config/countries';
import { getCountryBbox } from '@/services/country-geometry';
import { INTEL_HOTSPOTS, CONFLICT_ZONES } from '@/config/geo';
import { getCachedMilitaryBases, preloadMilitaryBases } from '@/services/military-base-config';
import { UNDERSEA_CABLES, NUCLEAR_FACILITIES } from '@/config/geo-map';
import { PIPELINES } from '@/config/pipelines';
import { AI_DATA_CENTERS } from '@/config/ai-datacenters';
import { GAMMA_IRRADIATORS } from '@/config/irradiators';
import { TECH_COMPANIES } from '@/config/tech-companies';
import { AI_RESEARCH_LABS } from '@/config/ai-research-labs';
import { STARTUP_ECOSYSTEMS } from '@/config/startup-ecosystems';
import { TECH_HQS, ACCELERATORS } from '@/config/tech-geo';
import { STOCK_EXCHANGES, FINANCIAL_CENTERS, CENTRAL_BANKS, COMMODITY_HUBS } from '@/config/finance-geo';
import { trackSearchResultSelected, trackCountrySelected } from '@/services/analytics';
import { t } from '@/services/i18n';
import { saveToStorage, setTheme } from '@/utils';
import { CountryIntelManager } from '@/app/country-intel';
import type { PositionSample } from '@/services/aviation';
import { fetchAircraftPositions } from '@/services/aviation';
import { subscribeWidgetAccess } from '@/services/widget-store';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { hasPremiumAccess } from '@/services/panel-gating';
import { onEntitlementChange } from '@/services/entitlements';
import { subscribeRuntimeConfig } from '@/services/runtime-config';
import {
  runWithAgentAnalyticsSuppressed,
  suppressNextAgentPanelView,
} from '@/services/agent-analytics-privacy';
import { OpaqueResultCache } from '@/services/opaque-result-cache';
import type {
  DashboardSearchDescriptor,
  DashboardSearchOpenResult,
  DashboardSearchResponse,
  DashboardSearchScope,
} from '@/services/webmcp';
import {
  DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS,
  DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TITLE_MAX_CHARS,
  DASHBOARD_SEARCH_TYPE_MAX_CHARS,
} from '@/services/webmcp';

const SEARCH_RESULT_CACHE_MAX_ENTRIES = 64;
const SEARCH_RESULT_CACHE_TTL_MS = 2 * 60 * 1000;
const FLIGHT_SEARCH_SOURCE_TTL_MS = 2 * 60 * 1000;
const LAYER_PRESET_PRIMARY_LAYERS: Record<string, (keyof MapLayers)[]> = {
  military: ['bases', 'flights', 'military'],
  finance: ['stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'economic'],
  infra: ['cables', 'pipelines', 'datacenters', 'spaceports', 'minerals'],
  intel: ['conflicts', 'hotspots', 'protests', 'ucdpEvents', 'displacement'],
  minimal: ['conflicts', 'hotspots'],
};

interface IssuedSearchResult {
  query: string;
  scope: DashboardSearchScope;
  identity: string;
  indexRevision: number;
  authContext: string;
  securityEpoch: number;
  variant: string;
}

export interface SearchManagerCallbacks {
  openCountryBriefByCode: (
    code: string,
    country: string,
    options?: { trackDetailedAnalytics?: boolean },
  ) => boolean | Promise<boolean>;
  /** Enables a currently-disabled panel (CMD+K "Add"). Returns false if blocked (unknown / free-tier cap). */
  enablePanel: (panelId: string, options?: { trackDetailedAnalytics?: boolean }) => boolean;
}

export class SearchManager implements AppModule {
  private ctx: AppContext;
  private callbacks: SearchManagerCallbacks;
  private highlightTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  private suppressDetailedSelectionAnalytics = false;
  private securityEpoch = 0;
  private authUnsubscribe: (() => void) | null = null;
  private entitlementUnsubscribe: (() => void) | null = null;
  private runtimeConfigUnsubscribe: (() => void) | null = null;
  private widgetAccessUnsubscribe: (() => void) | null = null;
  private destroyed = false;
  private flightSourceExpiresAt = 0;
  private searchIndexReady: Promise<void> = Promise.resolve();
  private readonly resultCache = new OpaqueResultCache<IssuedSearchResult>({
    maxEntries: SEARCH_RESULT_CACHE_MAX_ENTRIES,
    ttlMs: SEARCH_RESULT_CACHE_TTL_MS,
  });

  constructor(ctx: AppContext, callbacks: SearchManagerCallbacks) {
    this.ctx = ctx;
    this.callbacks = callbacks;
  }

  init(): void {
    this.destroyed = false;
    this.observeSecurityContext();
    this.setupSearchModal();
  }

  public whenSearchIndexReady(): Promise<void> {
    return this.searchIndexReady;
  }

  destroy(): void {
    this.destroyed = true;
    this.authUnsubscribe?.();
    this.authUnsubscribe = null;
    this.entitlementUnsubscribe?.();
    this.entitlementUnsubscribe = null;
    this.runtimeConfigUnsubscribe?.();
    this.runtimeConfigUnsubscribe = null;
    this.widgetAccessUnsubscribe?.();
    this.widgetAccessUnsubscribe = null;
    this.resultCache.clear();
  }

  private setupSearchModal(): void {
    const searchOptions = SITE_VARIANT === 'tech'
      ? { placeholder: t('modals.search.placeholderTech') }
      : SITE_VARIANT === 'happy'
        ? { placeholder: 'Search or type a command...' }
        : SITE_VARIANT === 'finance'
          ? { placeholder: t('modals.search.placeholderFinance') }
          : { placeholder: t('modals.search.placeholder') };
    this.ctx.searchModal = new SearchModal(this.ctx.container, searchOptions);

    if (SITE_VARIANT === 'happy') {
      // Happy variant: no geopolitical/military/infrastructure sources
    } else if (SITE_VARIANT === 'tech') {
      this.ctx.searchModal.registerSource('techcompany', TECH_COMPANIES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: `${c.sector} ${c.city} ${c.keyProducts?.join(' ') || ''}`.trim(),
        data: c,
      })));

      this.ctx.searchModal.registerSource('ailab', AI_RESEARCH_LABS.map(l => ({
        id: l.id,
        title: l.name,
        subtitle: `${l.type} ${l.city} ${l.focusAreas?.join(' ') || ''}`.trim(),
        data: l,
      })));

      this.ctx.searchModal.registerSource('startup', STARTUP_ECOSYSTEMS.map(s => ({
        id: s.id,
        title: s.name,
        subtitle: `${s.ecosystemTier} ${s.topSectors?.join(' ') || ''} ${s.notableStartups?.join(' ') || ''}`.trim(),
        data: s,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major internet backbone' : 'Undersea cable',
        data: c,
      })));

      this.ctx.searchModal.registerSource('techhq', TECH_HQS.map(h => ({
        id: h.id,
        title: h.company,
        subtitle: `${h.type === 'faang' ? 'Big Tech' : h.type === 'unicorn' ? 'Unicorn' : 'Public'} • ${h.city}, ${h.country}`,
        data: h,
      })));

      this.ctx.searchModal.registerSource('accelerator', ACCELERATORS.map(a => ({
        id: a.id,
        title: a.name,
        subtitle: `${a.type} • ${a.city}, ${a.country}${a.notable ? ` • ${a.notable.slice(0, 2).join(', ')}` : ''}`,
        data: a,
      })));
    } else {
      this.ctx.searchModal.registerSource('hotspot', INTEL_HOTSPOTS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: h.subtext || 'Intelligence hotspot',
        searchText: `${h.keywords?.join(' ') || ''} ${h.description || ''}`.trim(),
        data: h,
      })));

      this.ctx.searchModal.registerSource('conflict', CONFLICT_ZONES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.parties?.join(' ') || 'Conflict zone',
        searchText: `${c.keywords?.join(' ') || ''} ${c.description || ''}`.trim(),
        data: c,
      })));

      if (getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has('bases')) {
        this.searchIndexReady = this.registerBaseSearchSource();
      }

      this.ctx.searchModal.registerSource('pipeline', PIPELINES.map(p => ({
        id: p.id,
        title: p.name,
        subtitle: `${p.type} ${p.operator || ''} ${p.countries?.join(' ') || ''}`.trim(),
        data: p,
      })));

      this.ctx.searchModal.registerSource('cable', UNDERSEA_CABLES.map(c => ({
        id: c.id,
        title: c.name,
        subtitle: c.major ? 'Major cable' : '',
        data: c,
      })));

      this.ctx.searchModal.registerSource('datacenter', AI_DATA_CENTERS.map(d => ({
        id: d.id,
        title: d.name,
        subtitle: `${d.owner} ${d.chipType || ''}`.trim(),
        data: d,
      })));

      this.ctx.searchModal.registerSource('nuclear', NUCLEAR_FACILITIES.map(n => ({
        id: n.id,
        title: n.name,
        subtitle: `${n.type} ${n.operator || ''}`.trim(),
        data: n,
      })));

      this.ctx.searchModal.registerSource('irradiator', GAMMA_IRRADIATORS.map(g => ({
        id: g.id,
        title: `${g.city}, ${g.country}`,
        subtitle: g.organization || '',
        data: g,
      })));
    }

    if (SITE_VARIANT === 'finance') {
      this.ctx.searchModal.registerSource('exchange', STOCK_EXCHANGES.map(e => ({
        id: e.id,
        title: `${e.shortName} - ${e.name}`,
        subtitle: `${e.tier} • ${e.city}, ${e.country}${e.marketCap ? ` • $${e.marketCap}T` : ''}`,
        data: e,
      })));

      this.ctx.searchModal.registerSource('financialcenter', FINANCIAL_CENTERS.map(f => ({
        id: f.id,
        title: f.name,
        subtitle: `${f.type} financial center${f.gfciRank ? ` • GFCI #${f.gfciRank}` : ''}${f.specialties ? ` • ${f.specialties.slice(0, 3).join(', ')}` : ''}`,
        data: f,
      })));

      this.ctx.searchModal.registerSource('centralbank', CENTRAL_BANKS.map(b => ({
        id: b.id,
        title: `${b.shortName} - ${b.name}`,
        subtitle: `${b.type}${b.currency ? ` • ${b.currency}` : ''} • ${b.city}, ${b.country}`,
        data: b,
      })));

    }

    if (getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has('commodityHubs')) {
      this.ctx.searchModal.registerSource('commodityhub', COMMODITY_HUBS.map(h => ({
        id: h.id,
        title: h.name,
        subtitle: `${h.type} • ${h.city}, ${h.country}${h.commodities ? ` • ${h.commodities.slice(0, 3).join(', ')}` : ''}`,
        data: h,
      })));
    }

    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems());

    this.syncPanelSearchIndex();
    // Filter CMD+K layer commands by (a) variant-allowed, (b) renderer-kind
    // compatibility (a deck-only layer can't run on the SVG fallback or the
    // globe), (c) premium entitlement for locked layers. Without (a)–(b), layer
    // commands surface where they'd silently fail the variant/renderer guard
    // (e.g. `layer:storageFacilities` on tech/finance/commodity/happy, or globe
    // / SVG-mobile). Without (c), free users could enable locked layers like
    // resilienceScore, leaving a checked+disabled checkbox (#6045).
    // Currently-on locked layers stay visible so free users can turn them off
    // if stuck state survived from an older session.
    this.ctx.searchModal.setLayerExecutableFn((layerKey) => {
      const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
      if (!(key in this.ctx.mapLayers)) return false;
      const variantAllowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
      if (!variantAllowed.has(key)) return false;
      const kind = this.ctx.map?.isGlobeMode?.()
        ? 'globe'
        : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
      return isLayerCommandAllowed(
        key,
        this.ctx.mapLayers[key],
        kind,
        hasPremiumAccess(getAuthState()),
      );
    });
    this.ctx.searchModal.setCommandVisibleFn((command) => this.isModalCommandVisible(command));
    this.ctx.searchModal.setResultVisibleFn((result) => this.isSearchResultVisible(result));
    this.ctx.searchModal.setOnSelect((result) => this.handleSearchResult(result));
    this.ctx.searchModal.setOnCommand((cmd) => this.handleCommand(cmd));
    // Always wire flight search; check pro status reactively inside the callback
    // so mid-session sign-ins get the feature without a page reload.
    this.ctx.searchModal.setOnFlightSearch((callsign) => {
      if (!hasPremiumAccess(getAuthState())) return;
      fetchAircraftPositions({ callsign }).then((positions) => {
        if (!this.ctx.searchModal) return;
        // Deduplicate by callsign: keep the most recently observed entry per callsign.
        const seen = new Map<string, PositionSample>();
        for (const p of positions) {
          const key = (p.callsign || p.icao24).trim().toUpperCase();
          const existing = seen.get(key);
          if (!existing || p.observedAt > existing.observedAt) {
            seen.set(key, p);
          }
        }
        const items = [...seen.values()].map(p => {
          const fl = Number.isFinite(p.altitudeFt) ? Math.round(p.altitudeFt / 100) : null;
          const kts = Number.isFinite(p.groundSpeedKts) ? Math.round(p.groundSpeedKts) : null;
          return {
            id: p.icao24,
            title: (p.callsign || p.icao24).trim().toUpperCase(),
            subtitle: p.onGround
              ? t('modals.search.flightOnGround')
              : fl !== null && kts !== null
                ? t('modals.search.flightAirborne', { fl: String(fl), kts: String(kts) })
                : fl !== null ? `FL${fl}` : t('modals.search.flightOnGround'),
            data: { kind: 'adsb' as const, lat: p.lat, lon: p.lon, layer: 'flights' as const },
          };
        });
        this.flightSourceExpiresAt = items.length > 0
          ? Date.now() + FLIGHT_SEARCH_SOURCE_TTL_MS
          : 0;
        this.ctx.searchModal.registerSource('flight', items);
        this.ctx.searchModal.refreshSearch();
      }).catch(() => {
        this.flightSourceExpiresAt = 0;
        this.ctx.searchModal?.registerSource('flight', []);
        this.ctx.searchModal?.refreshSearch();
      });
    });

  }

  private async registerBaseSearchSource(): Promise<void> {
    const register = (bases: MilitaryBase[]) => {
      this.ctx.searchModal?.registerSource('base', bases.map(b => ({
        id: b.id,
        title: b.name,
        subtitle: `${b.type} ${b.description || ''}`.trim(),
        data: b,
      })));
    };

    const cached = getCachedMilitaryBases();
    if (cached.length > 0) {
      register(cached);
      return;
    }
    try {
      register(await preloadMilitaryBases());
    } catch {
      // Static search enrichment is optional; continue with the other sources.
    }
  }

  public async searchDashboard(
    query: string,
    scope: DashboardSearchScope,
    limit: number,
  ): Promise<DashboardSearchResponse> {
    await this.searchIndexReady;
    if (this.destroyed) throw new Error('Search manager destroyed');
    this.updateSearchIndex({ updateVisibleMetrics: false });
    const modal = this.ctx.searchModal;
    if (!modal) throw new Error('Search index is not initialised');

    const matches = modal.search(query, scope as SearchScope).orderedMatches;
    const candidates = matches.slice(0, limit).map((match) => ({
      match,
      descriptor: {
        type: this.searchMatchType(match).slice(0, DASHBOARD_SEARCH_TYPE_MAX_CHARS),
        title: this.searchMatchTitle(match).slice(0, DASHBOARD_SEARCH_TITLE_MAX_CHARS),
        ...(this.searchMatchSubtitle(match) ? {
          subtitle: this.searchMatchSubtitle(match)!.slice(
            0,
            DASHBOARD_SEARCH_SUBTITLE_MAX_CHARS,
          ),
        } : {}),
        executable: this.isSearchMatchExecutable(match),
      },
    }));
    const accepted: typeof candidates = [];
    for (const candidate of candidates) {
      const projectedResults = [...accepted, candidate].map(({ descriptor }) => ({
        key: `sr_${'0'.repeat(32)}`,
        ...descriptor,
      }));
      if (JSON.stringify({
        queryLength: query.length,
        results: projectedResults,
        resultCount: projectedResults.length,
        // false is one character longer than true, so it safely reserves the
        // larger envelope regardless of whether the final result is complete.
        truncated: false,
      }).length > DASHBOARD_SEARCH_OUTPUT_TARGET_CHARS) break;
      accepted.push(candidate);
    }
    const authContext = this.getSearchAuthContext();
    const results: DashboardSearchDescriptor[] = accepted.map(({ match, descriptor }) => ({
      key: this.resultCache.issue({
        query,
        scope,
        identity: searchMatchIdentity(match),
        indexRevision: modal.getSearchIndexRevision(),
        authContext,
        securityEpoch: this.securityEpoch,
        variant: SITE_VARIANT,
      }),
      ...descriptor,
    }));

    return {
      queryLength: query.length,
      results,
      resultCount: results.length,
      truncated: matches.length > results.length,
    };
  }

  public async openSearchResult(
    resultKey: string,
    waitForMapReady?: () => Promise<void>,
  ): Promise<DashboardSearchOpenResult> {
    if (this.destroyed) {
      return { ok: false, status: 'denied', reason: 'invalid_or_expired_key' };
    }
    const issued = this.resultCache.get(resultKey);
    if (!issued) {
      return { ok: false, status: 'denied', reason: 'invalid_or_expired_key' };
    }
    // Keys are single-use capabilities. Delete before any validation or side
    // effect so re-entrant or replayed calls fail closed.
    this.resultCache.delete(resultKey);

    if (
      issued.variant !== SITE_VARIANT
      || issued.authContext !== this.getSearchAuthContext()
      || issued.securityEpoch !== this.securityEpoch
    ) {
      return { ok: false, status: 'denied', reason: 'search_state_changed' };
    }

    this.updateSearchIndex({ updateVisibleMetrics: false });
    const modal = this.ctx.searchModal;
    if (!modal) return { ok: false, status: 'denied', reason: 'search_state_changed' };
    let liveMatch = modal.search(issued.query, issued.scope as SearchScope).orderedMatches
      .find((match) => searchMatchIdentity(match) === issued.identity);
    if (!liveMatch) {
      return { ok: false, status: 'denied', reason: 'result_no_longer_available' };
    }
    if (issued.indexRevision !== modal.getSearchIndexRevision()) {
      return { ok: false, status: 'denied', reason: 'search_state_changed' };
    }
    // A descriptor that is already non-executable must fail before renderer
    // readiness is requested. In particular, an opaque key must not become a
    // way to wake the deferred map renderer for a result that policy rejects.
    if (!this.isSearchMatchExecutable(liveMatch)) {
      return { ok: false, status: 'denied', reason: 'result_no_longer_executable' };
    }
    if (this.searchMatchRequiresMapRenderer(liveMatch) && waitForMapReady) {
      await waitForMapReady();
      if (this.destroyed) {
        return { ok: false, status: 'denied', reason: 'search_state_changed' };
      }
      if (
        issued.variant !== SITE_VARIANT
        || issued.authContext !== this.getSearchAuthContext()
        || issued.securityEpoch !== this.securityEpoch
      ) {
        return { ok: false, status: 'denied', reason: 'search_state_changed' };
      }
      this.updateSearchIndex({ updateVisibleMetrics: false });
      liveMatch = this.ctx.searchModal
        ?.search(issued.query, issued.scope as SearchScope).orderedMatches
        .find((match) => searchMatchIdentity(match) === issued.identity);
      if (!liveMatch) {
        return { ok: false, status: 'denied', reason: 'result_no_longer_available' };
      }
      if (issued.indexRevision !== this.ctx.searchModal?.getSearchIndexRevision()) {
        return { ok: false, status: 'denied', reason: 'search_state_changed' };
      }
    }
    if (!this.isSearchMatchExecutable(liveMatch)) {
      return { ok: false, status: 'denied', reason: 'result_no_longer_executable' };
    }

    if (this.destroyed) {
      return { ok: false, status: 'denied', reason: 'search_state_changed' };
    }
    this.ctx.searchModal?.closeForProgrammaticSelection();
    if (!(await this.selectSearchMatch(liveMatch))) {
      return { ok: false, status: 'denied', reason: 'result_no_longer_executable' };
    }
    return { ok: true, status: 'opened', type: this.searchMatchType(liveMatch) };
  }

  private async selectSearchMatch(match: SearchMatch): Promise<boolean> {
    this.suppressDetailedSelectionAnalytics = true;
    try {
      return await runWithAgentAnalyticsSuppressed(() => {
        if (match.kind === 'command') {
          return this.handleCommand(match.command);
        }
        return this.handleSearchResult(match.result);
      });
    } finally {
      this.suppressDetailedSelectionAnalytics = false;
    }
  }

  private searchMatchType(match: SearchMatch): string {
    return match.kind === 'command' ? 'command' : match.result.type;
  }

  private searchMatchTitle(match: SearchMatch): string {
    return match.kind === 'command' ? match.title : match.result.title;
  }

  private searchMatchSubtitle(match: SearchMatch): string | undefined {
    return match.kind === 'command' ? match.subtitle : match.result.subtitle;
  }

  private searchMatchRequiresMapRenderer(match: SearchMatch): boolean {
    if (match.kind === 'result') {
      return !['country', 'news', 'market', 'prediction'].includes(match.result.type);
    }
    const [category = '', action = ''] = match.command.id.split(':', 2);
    return ['nav', 'country-map', 'layer', 'layers', 'time'].includes(category)
      || (category === 'view' && ['resilience', 'route-explorer'].includes(action));
  }

  private getSearchAuthContext(): string {
    const auth = getAuthState();
    // The cache needs a live-state sanity check, not account identity. Auth
    // listeners rotate securityEpoch on every emission, including A -> B and
    // A -> signed-out -> A, so never retain a user ID alongside query text.
    return `${auth.user ? 'signed-in' : 'anonymous'}:${auth.isPending ? 'pending' : 'settled'}:${hasPremiumAccess(auth) ? 'premium' : 'free'}`;
  }

  private observeSecurityContext(): void {
    if (
      this.authUnsubscribe
      || this.entitlementUnsubscribe
      || this.runtimeConfigUnsubscribe
      || this.widgetAccessUnsubscribe
    ) return;
    const invalidate = (): void => {
      this.securityEpoch += 1;
      this.resultCache.clear();
      if (!hasPremiumAccess(getAuthState())) {
        this.ctx.searchModal?.registerSource('flight', []);
      }
    };
    let subscribingAuth = true;
    this.authUnsubscribe = subscribeAuthState(() => {
      if (!subscribingAuth) invalidate();
    });
    subscribingAuth = false;
    let subscribingEntitlements = true;
    this.entitlementUnsubscribe = onEntitlementChange(() => {
      if (!subscribingEntitlements) invalidate();
    });
    subscribingEntitlements = false;
    this.runtimeConfigUnsubscribe = subscribeRuntimeConfig(invalidate);
    this.widgetAccessUnsubscribe = subscribeWidgetAccess(invalidate);
  }

  private isSearchMatchExecutable(match: SearchMatch): boolean {
    if (match.kind === 'command') return this.isCommandExecutable(match.command);
    return this.isSearchResultExecutable(match.result);
  }

  /** Human CMD+K keeps its complete command deck; agent issuance is narrower. */
  private isModalCommandVisible(command: Command): boolean {
    const [category = '', action = ''] = command.id.split(':', 2);
    if (category === 'panel') {
      const panelId = action.split('@')[0];
      if (!panelId) return false;
      const effective = ALL_PANELS[panelId]
        ? getEffectivePanelConfig(panelId, SITE_VARIANT)
        : undefined;
      return !!effective && isPanelEntitled(
        panelId,
        effective,
        hasPremiumAccess(getAuthState()),
      );
    }
    if (category === 'layer') return this.isLayerCommandExecutable(action);
    if (category === 'layers') return this.hasVisibleLayerPreset(action);
    if (category === 'view' && action === 'resilience') {
      return this.isLayerCommandExecutable('resilienceScore');
    }
    if (category === 'country-map') return getCountryBbox(action) !== null;
    return ['nav', 'country', 'time', 'view'].includes(category);
  }

  private isCommandExecutable(command: Command): boolean {
    const [category, action = ''] = command.id.split(':', 2);
    switch (category) {
      case 'panel': {
        const panelId = action.split('@')[0];
        if (!panelId) return false;
        const config = this.ctx.panelSettings[panelId];
        if (!config) return false;
        const effective = ALL_PANELS[panelId]
          ? getEffectivePanelConfig(panelId, SITE_VARIANT)
          : undefined;
        const premium = hasPremiumAccess(getAuthState());
        if (!effective || !isPanelEntitled(panelId, effective, premium)) return false;
        if (config.enabled) return this.hasLivePanelTarget(panelId);
        if (premium) return true;
        return !isFreePanelCapCounted(panelId)
          || countFreePanelCapUsage(this.ctx.panelSettings) < FREE_MAX_PANELS;
      }
      case 'layer':
        return this.isLayerCommandExecutable(action);
      case 'layers':
        return this.hasExecutableLayerPreset(action);
      case 'nav':
      case 'country':
        return true;
      case 'time':
        return !(this.ctx.map?.isGlobeMode?.() ?? false);
      case 'country-map':
        return getCountryBbox(action) !== null;
      case 'view':
        if (action === 'resilience') return this.isLayerCommandExecutable('resilienceScore');
        // Settings/route-explorer emit their own content-bearing or account-
        // tier analytics, refresh tears down the capability response, and
        // fullscreen requires a transient user activation WebMCP cannot grant.
        // Keep those visible in CMD+K but out of agent-issued descriptors.
        return ['dark', 'light'].includes(action);
      default:
        return false;
    }
  }

  private hasLivePanelTarget(panelId: string): boolean {
    const panel = this.ctx.panels[panelId];
    if (panel?.getElement().isConnected) return true;
    // Deferred shells are live navigation targets: scrolling them into the
    // IntersectionObserver margin is what mounts the real panel in place.
    return [...document.querySelectorAll<HTMLElement>('[data-panel]')]
      .some((element) => element.dataset.panel === panelId);
  }

  private resolveExecutableNewsPanel(
    link: string,
  ): [string, AppContext['newsPanels'][string]] | null {
    for (const [panelId, panel] of Object.entries(this.ctx.newsPanels)) {
      if (
        this.ctx.panelSettings[panelId]?.enabled === true
        && this.hasLivePanelTarget(panelId)
        && panel.hasNewsItem(link)
      ) {
        return [panelId, panel];
      }
    }
    return null;
  }

  private isLayerCommandExecutable(layerKey: string): boolean {
    const key = (LAYER_KEY_MAP[layerKey] || layerKey) as keyof MapLayers;
    if (!(key in this.ctx.mapLayers)) return false;
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(key)) return false;
    const renderer: MapRenderer = this.ctx.map?.isGlobeMode?.() ? 'globe' : 'flat';
    return isLayerCommandAllowed(
      key,
      this.ctx.mapLayers[key],
      renderer,
      this.ctx.map?.isDeckGLActive?.() ?? false,
      hasPremiumAccess(getAuthState()),
    );
  }

  private hasExecutableLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    const primaryLayers = LAYER_PRESET_PRIMARY_LAYERS[action];
    if (!primaryLayers) return false;
    // Minimal promises both of its named layers. Larger presets may contain
    // contextual extras (for example waterways in military); require at least
    // one defining layer so an incidental overlap cannot advertise the preset.
    if (action === 'minimal') {
      return primaryLayers.every((key) => this.isLayerCommandExecutable(key));
    }
    return primaryLayers.some((key) => this.isLayerCommandExecutable(key));
  }

  private hasVisibleLayerPreset(action: string): boolean {
    if (action === 'none') return true;
    if (action === 'all') {
      return Object.keys(this.ctx.mapLayers).some((key) => this.isLayerCommandExecutable(key));
    }
    return (LAYER_PRESETS[action] ?? []).some((key) => this.isLayerCommandExecutable(key));
  }

  private isSearchResultExecutable(result: SearchResult): boolean {
    if (!this.isSearchResultVisible(result)) return false;
    const requiredLayer = this.resultRequiredLayer(result);
    if (requiredLayer && !this.isEntityLayerExecutable(requiredLayer)) return false;
    if (
      this.ctx.map?.isGlobeMode?.()
      && [
        'hotspot', 'conflict', 'base', 'pipeline', 'cable', 'datacenter', 'nuclear', 'irradiator',
        'techcompany', 'ailab', 'startup', 'techhq', 'accelerator',
        'exchange', 'financialcenter', 'centralbank', 'commodityhub',
      ]
        .includes(result.type)
    ) return false;
    switch (result.type) {
      case 'news':
        return this.resolveExecutableNewsPanel((result.data as NewsItem).link) !== null;
      case 'market':
        return this.ctx.panelSettings.markets?.enabled === true
          && this.hasLivePanelTarget('markets');
      case 'prediction':
        return this.ctx.panelSettings.polymarket?.enabled === true
          && this.hasLivePanelTarget('polymarket');
      case 'flight':
        return hasPremiumAccess(getAuthState());
      default:
        return true;
    }
  }

  private isSearchResultVisible(result: SearchResult): boolean {
    if (result.type === 'flight' && !hasPremiumAccess(getAuthState())) return false;
    const requiredLayer = this.resultRequiredLayer(result);
    if (!requiredLayer) return true;
    return getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant).has(requiredLayer);
  }

  private isEntityLayerExecutable(layer: keyof MapLayers): boolean {
    const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
    if (!allowed.has(layer)) return false;
    const renderer: MapRenderer = this.ctx.map?.isGlobeMode?.() ? 'globe' : 'flat';
    return isLayerExecutable(
      layer,
      renderer,
      this.ctx.map?.isDeckGLActive?.() ?? false,
    ) && isLayerEntitled(layer, hasPremiumAccess(getAuthState()));
  }

  private resultRequiredLayer(result: SearchResult): keyof MapLayers | null {
    switch (result.type) {
      case 'hotspot': return 'hotspots';
      case 'conflict': return 'conflicts';
      case 'base': return 'bases';
      case 'pipeline': return 'pipelines';
      case 'cable': return 'cables';
      case 'datacenter': return 'datacenters';
      case 'nuclear': return 'nuclear';
      case 'irradiator': return 'irradiators';
      case 'earthquake': return 'natural';
      case 'outage': return 'outages';
      case 'techcompany':
      case 'techhq': return 'techHQs';
      case 'startup': return 'startupHubs';
      case 'techevent': return 'techEvents';
      case 'accelerator': return 'accelerators';
      case 'exchange': return 'stockExchanges';
      case 'financialcenter': return 'financialCenters';
      case 'centralbank': return 'centralBanks';
      case 'commodityhub': return 'commodityHubs';
      case 'flight': {
        const layer = (result.data as { layer?: unknown }).layer;
        return layer === 'military' ? 'military' : 'flights';
      }
      default: return null;
    }
  }

  private handleSearchResult(result: SearchResult): boolean | Promise<boolean> {
    trackSearchResultSelected(result.type, {
      includeAttribution: !this.suppressDetailedSelectionAnalytics,
    });
    switch (result.type) {
      case 'news': {
        const item = result.data as NewsItem;
        const target = this.resolveExecutableNewsPanel(item.link);
        if (!target) return false;
        const [targetPanelId, targetPanel] = target;
        this.scrollToPanel(targetPanelId);
        setTimeout(() => targetPanel.scrollToNewsItem(item.link), 300);
        break;
      }
      case 'hotspot': {
        const hotspot = result.data as typeof INTEL_HOTSPOTS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerHotspotClick(hotspot.id); }, 300);
        break;
      }
      case 'conflict': {
        const conflict = result.data as typeof CONFLICT_ZONES[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerConflictClick(conflict.id); }, 300);
        break;
      }
      case 'market': {
        this.scrollToPanel('markets');
        break;
      }
      case 'prediction': {
        this.scrollToPanel('polymarket');
        break;
      }
      case 'base': {
        const base = result.data as MilitaryBase;
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.triggerBaseClick(base.id); }, 300);
        break;
      }
      case 'pipeline': {
        const pipeline = result.data as typeof PIPELINES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('pipelines');
        this.ctx.mapLayers.pipelines = true;
        setTimeout(() => { this.ctx.map?.triggerPipelineClick(pipeline.id); }, 300);
        break;
      }
      case 'cable': {
        const cable = result.data as typeof UNDERSEA_CABLES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('cables');
        this.ctx.mapLayers.cables = true;
        setTimeout(() => { this.ctx.map?.triggerCableClick(cable.id); }, 300);
        break;
      }
      case 'datacenter': {
        const dc = result.data as typeof AI_DATA_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('datacenters');
        this.ctx.mapLayers.datacenters = true;
        setTimeout(() => { this.ctx.map?.triggerDatacenterClick(dc.id); }, 300);
        break;
      }
      case 'nuclear': {
        const nuc = result.data as typeof NUCLEAR_FACILITIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('nuclear');
        this.ctx.mapLayers.nuclear = true;
        setTimeout(() => { this.ctx.map?.triggerNuclearClick(nuc.id); }, 300);
        break;
      }
      case 'irradiator': {
        const irr = result.data as typeof GAMMA_IRRADIATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('irradiators');
        this.ctx.mapLayers.irradiators = true;
        setTimeout(() => { this.ctx.map?.triggerIrradiatorClick(irr.id); }, 300);
        break;
      }
      case 'earthquake':
      case 'outage':
        this.ctx.map?.setView('global');
        break;
      case 'techcompany': {
        const company = result.data as typeof TECH_COMPANIES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(company.lat, company.lon, 4); }, 300);
        break;
      }
      case 'ailab': {
        const lab = result.data as typeof AI_RESEARCH_LABS[0];
        this.ctx.map?.setView('global');
        setTimeout(() => { this.ctx.map?.setCenter(lab.lat, lab.lon, 4); }, 300);
        break;
      }
      case 'startup': {
        const ecosystem = result.data as typeof STARTUP_ECOSYSTEMS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('startupHubs');
        this.ctx.mapLayers.startupHubs = true;
        setTimeout(() => { this.ctx.map?.setCenter(ecosystem.lat, ecosystem.lon, 4); }, 300);
        break;
      }
      case 'techevent': {
        const event = result.data as { lat: number; lng: number };
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techEvents');
        this.ctx.mapLayers.techEvents = true;
        setTimeout(() => { this.ctx.map?.setCenter(event.lat, event.lng, 5); }, 300);
        break;
      }
      case 'techhq': {
        const hq = result.data as typeof TECH_HQS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('techHQs');
        this.ctx.mapLayers.techHQs = true;
        setTimeout(() => { this.ctx.map?.setCenter(hq.lat, hq.lon, 4); }, 300);
        break;
      }
      case 'accelerator': {
        const acc = result.data as typeof ACCELERATORS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('accelerators');
        this.ctx.mapLayers.accelerators = true;
        setTimeout(() => { this.ctx.map?.setCenter(acc.lat, acc.lon, 4); }, 300);
        break;
      }
      case 'exchange': {
        const exchange = result.data as typeof STOCK_EXCHANGES[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('stockExchanges');
        this.ctx.mapLayers.stockExchanges = true;
        setTimeout(() => { this.ctx.map?.setCenter(exchange.lat, exchange.lon, 4); }, 300);
        break;
      }
      case 'financialcenter': {
        const fc = result.data as typeof FINANCIAL_CENTERS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('financialCenters');
        this.ctx.mapLayers.financialCenters = true;
        setTimeout(() => { this.ctx.map?.setCenter(fc.lat, fc.lon, 4); }, 300);
        break;
      }
      case 'centralbank': {
        const bank = result.data as typeof CENTRAL_BANKS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('centralBanks');
        this.ctx.mapLayers.centralBanks = true;
        setTimeout(() => { this.ctx.map?.setCenter(bank.lat, bank.lon, 4); }, 300);
        break;
      }
      case 'commodityhub': {
        const hub = result.data as typeof COMMODITY_HUBS[0];
        this.ctx.map?.setView('global');
        this.ctx.map?.enableLayer('commodityHubs');
        this.ctx.mapLayers.commodityHubs = true;
        setTimeout(() => { this.ctx.map?.setCenter(hub.lat, hub.lon, 4); }, 300);
        break;
      }
      case 'country': {
        const { code, name } = result.data as { code: string; name: string };
        if (!this.suppressDetailedSelectionAnalytics) trackCountrySelected(code, name, 'search');
        return this.callbacks.openCountryBriefByCode(code, name, {
          trackDetailedAnalytics: !this.suppressDetailedSelectionAnalytics,
        });
      }
      case 'flight': {
        const { lat, lon, layer } = result.data as { kind: string; lat: number; lon: number; layer: keyof MapLayers };
        this.ctx.map?.enableLayer(layer);
        this.ctx.mapLayers[layer] = true;
        setTimeout(() => { this.ctx.map?.setCenter(lat, lon, 9); }, 300);
        break;
      }
    }
    return true;
  }

  private handleCommand(cmd: Command): boolean | Promise<boolean> {
    const colonIdx = cmd.id.indexOf(':');
    if (colonIdx === -1) return false;
    const category = cmd.id.slice(0, colonIdx);
    const action = cmd.id.slice(colonIdx + 1);

    switch (category) {
      case 'nav':
        this.ctx.map?.setView(action as MapView);
        {
          const sel = document.getElementById('regionSelect') as HTMLSelectElement;
          if (sel) sel.value = action;
        }
        break;

      case 'layers': {
        const allowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
        // Preset paths (`layers:all`, `layers:infra`, …) also need the
        // renderer-kind gate that per-layer toggles go through. Without
        // it, a user in globe mode or on the SVG fallback can run
        // `layers:infra` and silently flip deck-only layers on — those
        // layers set to `true` in state but produce no rendered output,
        // and since the picker hides them under the current renderer the
        // user has no way to toggle them back off without switching
        // modes. Codex P2 on PR #3366.
        // Premium entitlement is also required for locked layers (#6045).
        const kind = this.ctx.map?.isGlobeMode?.()
          ? 'globe'
          : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
        const premium = hasPremiumAccess(getAuthState());
        const executable = (k: keyof MapLayers): boolean =>
          allowed.has(k)
          && isLayerExecutable(k, kind)
          && isLayerEntitled(k, premium);
        if (action === 'all') {
          for (const key of Object.keys(this.ctx.mapLayers)) {
            this.ctx.mapLayers[key as keyof MapLayers] = executable(key as keyof MapLayers);
          }
        } else if (action === 'none') {
          for (const key of Object.keys(this.ctx.mapLayers))
            this.ctx.mapLayers[key as keyof MapLayers] = false;
        } else {
          const preset = LAYER_PRESETS[action];
          if (preset) {
            for (const key of Object.keys(this.ctx.mapLayers))
              this.ctx.mapLayers[key as keyof MapLayers] = false;
            for (const layer of preset) {
              if (executable(layer)) this.ctx.mapLayers[layer] = true;
            }
          }
        }
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        this.ctx.map?.setLayers(this.ctx.mapLayers);
        break;
      }

      case 'layer': {
        const layerKey = (LAYER_KEY_MAP[action] || action) as keyof MapLayers;
        if (!(layerKey in this.ctx.mapLayers)) return false;
        const variantAllowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
        if (!variantAllowed.has(layerKey)) return false;
        // Renderer / DeckGL gate. Mirrors the filter applied in SearchModal
        // so direct activation paths (keyboard-accelerator, programmatic
        // dispatch, etc.) don't flip a layer on that can't render.
        const kind = this.ctx.map?.isGlobeMode?.()
          ? 'globe'
          : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
        const currentValue = this.ctx.mapLayers[layerKey];
        // Locked premium layers: free users may turn them OFF (heal stuck
        // state) but must not turn them ON (#6045).
        if (!isLayerCommandAllowed(
          layerKey,
          currentValue,
          kind,
          hasPremiumAccess(getAuthState()),
        )) return false;
        let newValue = !currentValue;
        if (newValue && layerKey === 'resilienceScore' && !this.ctx.map?.isDeckGLActive?.()) {
          newValue = false;
        }
        this.ctx.mapLayers[layerKey] = newValue;
        saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
        if (newValue) {
          this.ctx.map?.enableLayer(layerKey);
        } else {
          this.ctx.map?.setLayers(this.ctx.mapLayers);
        }
        break;
      }

      case 'panel': {
        // CMD+K can now surface disabled-but-available panels (Add affordance).
        // Enable first so the element exists, then scroll once it renders.
        // An optional `@<tab>` suffix deep-links to a specific tab within the
        // panel (e.g. `consumer-prices@world` → global inflation view).
        const [panelId, subTab] = action.split('@');
        if (!panelId) break;
        const cfg = this.ctx.panelSettings[panelId];
        if (cfg && !cfg.enabled) {
          if (this.callbacks.enablePanel(panelId, {
            trackDetailedAnalytics: !this.suppressDetailedSelectionAnalytics,
          })) {
            this.scrollToPanelWhenReady(panelId);
            if (subTab) this.dispatchPanelTab(panelId, subTab);
            break;
          }
          return false;
        }
        this.scrollToPanel(panelId);
        if (subTab) this.dispatchPanelTab(panelId, subTab);
        break;
      }

      case 'view':
        if (action === 'dark' || action === 'light') {
          setTheme(action);
        } else if (action === 'fullscreen') {
          if (document.fullscreenElement) {
            try { void document.exitFullscreen()?.catch(() => {}); } catch {}
          } else {
            const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
            if (el.requestFullscreen) {
              try { void el.requestFullscreen()?.catch(() => {}); } catch {}
            } else if (el.webkitRequestFullscreen) {
              try { el.webkitRequestFullscreen(); } catch {}
            }
          }
        } else if (action === 'settings') {
          this.ctx.unifiedSettings?.open();
        } else if (action === 'refresh') {
          window.location.reload();
        } else if (action === 'resilience') {
          // view:resilience is a dedicated shortcut for resilienceScore.
          // Same entitlement gate as layer:resilienceScore (#6045).
          const layerKey = 'resilienceScore' as keyof MapLayers;
          const variantAllowed = getAllowedLayerKeys((SITE_VARIANT || 'full') as MapVariant);
          if (!variantAllowed.has(layerKey)) break;
          const currentValue = this.ctx.mapLayers[layerKey];
          const kind = this.ctx.map?.isGlobeMode?.()
            ? 'globe'
            : (this.ctx.map?.isDeckGLActive?.() ? 'deck' : 'svg');
          if (!isLayerCommandAllowed(
            layerKey,
            currentValue,
            kind,
            hasPremiumAccess(getAuthState()),
          )) break;
          let newValue = !currentValue;
          if (newValue && !this.ctx.map?.isDeckGLActive?.()) newValue = false;
          this.ctx.mapLayers[layerKey] = newValue;
          saveToStorage(STORAGE_KEYS.mapLayers, this.ctx.mapLayers);
          if (newValue) {
            this.ctx.map?.enableLayer(layerKey);
          } else {
            this.ctx.map?.setLayers(this.ctx.mapLayers);
          }
        } else if (action === 'route-explorer') {
          void import('@/components/RouteExplorer/RouteExplorer').then((m) => {
            const explorer = m.getRouteExplorer();
            explorer.setMap(this.ctx.map);
            explorer.open();
          });
        }
        break;

      case 'time':
        this.ctx.map?.setTimeRange(action as TimeRange);
        break;

      case 'country': {
        const name = TIER1_COUNTRIES[action]
          || CURATED_COUNTRIES[action]?.name
          || new Intl.DisplayNames(['en'], { type: 'region' }).of(action)
          || action;
        if (!this.suppressDetailedSelectionAnalytics) trackCountrySelected(action, name, 'command');
        return this.callbacks.openCountryBriefByCode(action, name, {
          trackDetailedAnalytics: !this.suppressDetailedSelectionAnalytics,
        });
      }

      case 'country-map': {
        const bbox = getCountryBbox(action);
        if (bbox) {
          const [minLon, minLat, maxLon, maxLat] = bbox;
          const lat = (minLat + maxLat) / 2;
          const lon = (minLon + maxLon) / 2;
          const span = Math.max(maxLat - minLat, maxLon - minLon);
          const zoom = span > 40 ? 3 : span > 15 ? 4 : span > 5 ? 5 : 6;
          this.ctx.map?.setView('global');
          setTimeout(() => { this.ctx.map?.setCenter(lat, lon, zoom); }, 300);
        }
        break;
      }
    }
    return true;
  }

  /**
   * Scrolls to a panel that may have just been enabled. Async-mounted panels
   * (e.g. deduction, regional-intelligence mount via dynamic import) aren't in
   * the DOM on the next tick, so retry over ~1s before giving up. The panel is
   * already enabled regardless — only the scroll is best-effort.
   */
  private scrollToPanelWhenReady(panelId: string, attemptsLeft = 12): void {
    if (this.suppressDetailedSelectionAnalytics) suppressNextAgentPanelView(panelId);
    if (document.querySelector(`[data-panel="${panelId}"]`)) {
      this.scrollToPanel(panelId);
      return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(() => this.scrollToPanelWhenReady(panelId, attemptsLeft - 1), 80);
  }

  /**
   * Deep-links to a tab inside a panel by dispatching the panel's open-tab
   * event once it's mounted. Deferred-shell placeholders carry the same
   * data-panel attribute but no listener — only the REAL panel element (shell
   * excluded via data-deferred-panel) proves the constructor has run, so we
   * retry until the shell is replaced in place. The scroll helpers above
   * intentionally still match shells: a shell occupies the panel's slot, and
   * scrolling to it is what brings it into the IntersectionObserver margin
   * that triggers the mount.
   */
  private dispatchPanelTab(panelId: string, tab: string, attemptsLeft = 12): void {
    // Currently only Consumer Prices exposes a tab deep-link contract.
    if (panelId !== 'consumer-prices') return;
    if (document.querySelector(`[data-panel="${panelId}"]:not([data-deferred-panel])`)) {
      window.dispatchEvent(new CustomEvent('wm-consumer-prices-open-tab', { detail: { tab } }));
      return;
    }
    if (attemptsLeft <= 0) return;
    setTimeout(() => this.dispatchPanelTab(panelId, tab, attemptsLeft - 1), 80);
  }

  private scrollToPanel(panelId: string): void {
    if (this.suppressDetailedSelectionAnalytics) suppressNextAgentPanelView(panelId);
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
      this.applyHighlight(panel);
    }
  }

  private applyHighlight(el: Element): void {
    const prev = this.highlightTimers.get(el);
    if (prev) clearTimeout(prev);
    el.classList.remove('search-highlight');
    void (el as HTMLElement).offsetWidth;
    el.classList.add('search-highlight');
    this.highlightTimers.set(el, setTimeout(() => {
      el.classList.remove('search-highlight');
      this.highlightTimers.delete(el);
    }, 3100));
  }

  updateFlightSource(
    adsb: PositionSample[],
    military: MilitaryFlight[],
    updatedAt = Date.now(),
  ): void {
    if (!this.ctx.searchModal) return;
    if (!hasPremiumAccess(getAuthState())) {
      this.flightSourceExpiresAt = 0;
      this.ctx.searchModal.registerSource('flight', []);
      return;
    }
    const items = [
      ...adsb.map(p => {
        const fl = Number.isFinite(p.altitudeFt) ? Math.round(p.altitudeFt / 100) : null;
        const kts = Number.isFinite(p.groundSpeedKts) ? Math.round(p.groundSpeedKts) : null;
        return {
          id: p.icao24,
          title: (p.callsign || p.icao24).trim().toUpperCase(),
          subtitle: p.onGround
            ? t('modals.search.flightOnGround')
            : fl !== null && kts !== null
              ? t('modals.search.flightAirborne', { fl: String(fl), kts: String(kts) })
              : fl !== null
                ? `FL${fl}`
                : t('modals.search.flightOnGround'),
          data: { kind: 'adsb' as const, lat: p.lat, lon: p.lon, layer: 'flights' as const },
        };
      }),
      ...military.map(f => {
        const fl = Number.isFinite(f.altitude) ? Math.round(f.altitude / 100) : null;
        return {
          id: f.hexCode,
          title: (f.callsign || f.hexCode).trim().toUpperCase(),
          subtitle: f.onGround
            ? t('modals.search.flightMilitaryOnGround', { type: f.aircraftType })
            : fl !== null
              ? t('modals.search.flightMilitary', { type: f.aircraftType, fl: String(fl) })
              : t('modals.search.flightMilitaryOnGround', { type: f.aircraftType }),
          data: { kind: 'military' as const, lat: f.lat, lon: f.lon, layer: 'military' as const },
        };
      }),
    ];
    this.flightSourceExpiresAt = items.length > 0
      ? updatedAt + FLIGHT_SEARCH_SOURCE_TTL_MS
      : 0;
    const currentItems = this.flightSourceExpiresAt > Date.now() ? items : [];
    if (currentItems.length === 0) this.flightSourceExpiresAt = 0;
    this.ctx.searchModal.registerSource('flight', currentItems);
  }

  updateSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;

    const sourceOptions = { updateVisibleMetrics: options?.updateVisibleMetrics !== false };
    if (this.flightSourceExpiresAt > 0 && Date.now() >= this.flightSourceExpiresAt) {
      this.flightSourceExpiresAt = 0;
      this.ctx.searchModal.registerSource('flight', [], sourceOptions);
    }
    this.syncPanelSearchIndex(sourceOptions);
    this.ctx.searchModal.registerSource('country', this.buildCountrySearchItems(), sourceOptions);

    const newsItems = this.ctx.allNews.slice(0, 500).map(n => ({
      id: n.link,
      title: n.title,
      subtitle: n.source,
      data: n,
    }));
    console.log(`[Search] Indexing ${newsItems.length} news items (allNews total: ${this.ctx.allNews.length})`);
    this.ctx.searchModal.registerSource('news', newsItems, sourceOptions);

    this.ctx.searchModal.registerSource('prediction', this.ctx.latestPredictions.map(p => ({
      id: p.title,
      title: p.title,
      subtitle: `${Math.round(p.yesPrice)}% probability`,
      data: p,
    })), sourceOptions);

    this.ctx.searchModal.registerSource('market', this.ctx.latestMarkets.map(m => ({
      id: m.symbol,
      title: `${m.symbol} - ${m.name}`,
      subtitle: `$${m.price?.toFixed(2) || 'N/A'}`,
      data: m,
    })), sourceOptions);

    if (SITE_VARIANT === 'tech') {
      this.ctx.searchModal.registerSource('techevent', this.ctx.latestTechEvents.map((e) => ({
        id: e.id,
        title: e.title,
        subtitle: `${e.location} • ${new Date(e.startDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
        data: e,
      })), sourceOptions);
    }
  }

  /**
   * Feeds CMD+K two panel sets: `active` (currently enabled) and `available`
   * (every entitled panel the user could cross-enable on this variant — all
   * of ALL_PANELS merge into panelSettings per App.ts). The modal surfaces
   * available-but-disabled panels with an "Add" affordance; selecting one
   * routes through enablePanel(). Without the available set, search could
   * only jump to panels already on screen — the core discoverability gap.
   */
  private syncPanelSearchIndex(options?: { updateVisibleMetrics?: boolean }): void {
    if (!this.ctx.searchModal) return;
    const hasPremium = hasPremiumAccess(getAuthState());
    this.ctx.searchModal.setActivePanels(
      Object.entries(this.ctx.panelSettings).filter(([, v]) => v.enabled).map(([k]) => k),
      options,
    );
    this.ctx.searchModal.setAvailablePanels(
      Object.keys(this.ctx.panelSettings).filter((k) => {
        // Keep unregistered/dynamic keys out of search; the resolver would
        // otherwise return a disabled synthetic fallback for unknown keys.
        const cfg = ALL_PANELS[k] ? getEffectivePanelConfig(k, SITE_VARIANT) : undefined;
        return cfg ? isPanelEntitled(k, cfg, hasPremium) : false;
      }),
      options,
    );
  }

  private buildCountrySearchItems(): { id: string; title: string; subtitle: string; data: { code: string; name: string } }[] {
    const cachedScores = getCachedCountryScores();
    const panelScores = (this.ctx.panels.cii as CIIPanel | undefined)?.getScores() ?? [];
    const scores = cachedScores.length > 0
      ? cachedScores
      : panelScores;
    const ciiByCode = new Map(scores.map((score) => [score.code, score]));
    return Object.entries(TIER1_COUNTRIES).map(([code, name]) => {
      const score = ciiByCode.get(code);
      return {
        id: code,
        title: `${CountryIntelManager.toFlagEmoji(code)} ${name}`,
        subtitle: score ? `CII: ${score.score}/100 • ${score.level}` : 'Country Brief',
        data: { code, name },
      };
    });
  }
}
