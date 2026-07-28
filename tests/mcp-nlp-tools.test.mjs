// Tool-level coverage for the #5697 on-demand NLP utilities:
// classify_event, extract_entities, get_news_clusters, get_keyword_spikes.
// Follows the get_procurement_opportunities template: import the real edge
// handler, inject Pro deps, and mock only the network edges (canonical API
// fetches + Upstash REST for the spike tool).
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  HMAC_SECRET,
  callBody,
  makeProDeps,
  proReq,
} from './helpers/mcp-pro-deps.mjs';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

const FAKE_UPSTASH = 'https://fake-upstash.test';

const classifyResponse = {
  classification: {
    category: 'conflict',
    subcategory: 'critical',
    severity: 'SEVERITY_LEVEL_HIGH',
    confidence: 0.9,
    analysis: '',
    entities: [],
  },
};

const digestResponse = {
  generatedAt: '2026-07-28T12:00:00.000Z',
  categories: {
    politics: {
      items: [
        { source: 'Reuters', title: 'Iran closes Strait of Hormuz to all tanker traffic', link: 'https://n/1', publishedAt: 1785405600000, isAlert: true, threat: { level: 'THREAT_LEVEL_CRITICAL', category: 'conflict', confidence: 0.9, source: 'llm' } },
        { source: 'AP', title: 'Iran closes Strait of Hormuz, tanker traffic halted', link: 'https://n/2', publishedAt: 1785405900000, isAlert: false, threat: { level: 'THREAT_LEVEL_HIGH', category: 'conflict', confidence: 0.8, source: 'keyword' } },
      ],
    },
    tech: {
      items: [
        { source: 'BleepingComputer', title: 'CVE-2026-12345 exploited by APT28 against Microsoft cloud tenants', link: 'https://n/3', publishedAt: 1785406000000, isAlert: false, threat: { level: 'THREAT_LEVEL_MEDIUM', category: 'cyber', confidence: 0.7, source: 'keyword' } },
        // Duplicate of the politics item — the digest adapter must dedupe by link.
        { source: 'Reuters', title: 'Iran closes Strait of Hormuz to all tanker traffic', link: 'https://n/1', publishedAt: 1785405600000, isAlert: true },
      ],
    },
  },
};

// Emulates the real Upstash semantics rather than echoing fixtures back: a
// mock that ignores ZRANGE's arguments would stay green through a max/min
// swap (the natural ZRANGEBYSCORE-order mistake) that returns empty forever
// against real Redis.
function upstashPipelineResponder(commands, state) {
  const first = commands[0]?.[0];
  if (first === 'ZRANGE') {
    const [, key, max, min, byscore, rev, withscores, limitKw, offset, count] = commands[0];
    assert.equal(key, 'digest:accumulator:v1:full:en');
    assert.deepEqual([byscore, rev, withscores, limitKw], ['BYSCORE', 'REV', 'WITHSCORES', 'LIMIT']);
    assert.equal(offset, '0');
    assert.ok(Number(max) >= Number(min), 'REV BYSCORE takes max before min; swapped bounds return empty on real Redis');
    const maxScore = Number(max);
    const minScore = Number(min);
    const cap = Number(count);
    const pairs = [];
    for (let i = 0; i + 1 < state.zrangeFlat.length; i += 2) {
      const score = Number(state.zrangeFlat[i + 1]);
      if (score >= minScore && score <= maxScore) pairs.push([state.zrangeFlat[i], state.zrangeFlat[i + 1]]);
    }
    pairs.sort((a, b) => Number(b[1]) - Number(a[1])); // REV: newest first
    return [{ result: pairs.slice(0, cap).flat() }];
  }
  if (first === 'HMGET') {
    return commands.map((cmd) => {
      assert.deepEqual(cmd.slice(2), ['title'], 'HMGET must request exactly the title field');
      const hash = String(cmd[1]).replace('story:track:v1:', '');
      return { result: [state.titlesByHash.get(hash) ?? null] };
    });
  }
  if (first === 'SMEMBERS') {
    return commands.map((cmd) => {
      const hash = String(cmd[1]).replace('story:sources:v1:', '');
      return { result: state.sourcesByHash.get(hash) ?? [] };
    });
  }
  if (first === 'SET') {
    state.storedPayloads.set(commands[0][1], commands[0][2]);
    return [{ result: 'OK' }];
  }
  return commands.map(() => ({ result: null }));
}

describe('#5697 NLP MCP tools', () => {
  let mcpHandler;
  let requests;
  let upstashState;
  let pipelineCalls;

  beforeEach(async () => {
    process.env.MCP_INTERNAL_HMAC_SECRET = HMAC_SECRET;
    process.env.MCP_TELEMETRY = 'false';
    process.env.UPSTASH_REDIS_REST_URL = FAKE_UPSTASH;
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    requests = [];
    pipelineCalls = 0;
    upstashState = {
      zrangeFlat: [],
      titlesByHash: new Map(),
      sourcesByHash: new Map(),
      storedPayloads: new Map(),
      // Command verbs whose pipelines should fail (partial-outage simulation).
      failCommands: new Set(),
    };

    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith(FAKE_UPSTASH)) {
        if (url.includes('/pipeline')) {
          const commands = JSON.parse(init.body);
          if (upstashState.failCommands.has(commands[0]?.[0])) {
            return new Response('upstash unavailable', { status: 500 });
          }
          // Count only spike-tool I/O; the per-minute limiter's evalsha rides
          // the same mocked endpoint and must not trip the cache assertions.
          if (['ZRANGE', 'HMGET', 'SMEMBERS', 'SET'].includes(commands[0]?.[0])) {
            pipelineCalls += 1;
          }
          return Response.json(upstashPipelineResponder(commands, upstashState));
        }
        // GET /get/<key>
        if (upstashState.failCacheRead) return new Response('upstash unavailable', { status: 500 });
        const key = decodeURIComponent(url.slice(`${FAKE_UPSTASH}/get/`.length));
        const stored = upstashState.storedPayloads.get(key) ?? null;
        return Response.json({ result: stored });
      }
      requests.push({ url, init });
      if (url.includes('/api/intelligence/v1/classify-event')) {
        return Response.json(classifyResponse);
      }
      if (url.includes('/api/news/v1/list-feed-digest')) {
        return Response.json(digestResponse);
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const mod = await import(`../api/mcp.ts?nlp=${Date.now()}-${Math.random()}`);
    mcpHandler = mod.mcpHandler;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete process.env[key];
    });
    Object.assign(process.env, originalEnv);
  });

  async function callTool(name, args = {}, depsOverrides = {}) {
    const { deps, pipe } = makeProDeps(depsOverrides);
    const response = await mcpHandler(proReq('POST', callBody(name, args)), deps);
    const body = await response.json();
    const result = body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) : null;
    return { response, body, result, pipe };
  }

  it('lists all four tools with their caps in tools/list', async () => {
    const listed = await mcpHandler(new Request('https://worldmonitor.app/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }));
    const tools = (await listed.json()).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    assert.equal(byName.get('classify_event')?.inputSchema.properties.text.maxLength, 500);
    assert.deepEqual(byName.get('classify_event')?.inputSchema.required, ['text']);
    assert.equal(byName.get('extract_entities')?.inputSchema.properties.text.maxLength, 2048);
    assert.equal(byName.get('get_news_clusters')?.inputSchema.properties.limit.maximum, 25);
    assert.equal(byName.get('get_keyword_spikes')?.inputSchema.properties.window_hours.maximum, 12);
  });

  describe('classify_event', () => {
    it('proxies the canonical route and maps subcategory to level', async () => {
      const { response, result, pipe } = await callTool('classify_event', { text: 'Iran closes Strait of Hormuz' });
      assert.equal(response.status, 200);
      const requestUrl = new URL(requests[0].url);
      assert.equal(requestUrl.pathname, '/api/intelligence/v1/classify-event');
      assert.equal(requestUrl.searchParams.get('title'), 'Iran closes Strait of Hormuz');
      assert.ok(requests[0].init.headers['X-WM-MCP-Internal'], 'internal entitlement identity required');
      assert.deepEqual(result.classification, {
        category: 'conflict', level: 'critical', severity: 'SEVERITY_LEVEL_HIGH', confidence: 0.9,
      });
      assert.equal(pipe.count, 1, 'classify_event must consume the daily quota reservation');
    });

    it('rejects missing and oversized text without reaching the route', async () => {
      const missing = await callTool('classify_event', {});
      assert.match(missing.result.error, /text is required/);
      assert.equal(missing.result.classification, null, 'error envelopes keep the required member present');
      const oversized = await callTool('classify_event', { text: 'x'.repeat(501) });
      assert.match(oversized.result.error, /500-character limit/);
      assert.equal(oversized.result.classification, null);
      assert.equal(requests.length, 0, 'validation failures must not fetch');
    });

    it('returns a null classification when the classifier declines', async () => {
      const originalFetchImpl = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/intelligence/v1/classify-event')) {
          requests.push({ url, init });
          return Response.json({});
        }
        return originalFetchImpl(input, init);
      };
      try {
        const { result } = await callTool('classify_event', { text: 'Unclassifiable filler headline' });
        assert.equal(result.classification, null, 'the documented declined-classification contract');
        assert.equal('error' in result, false, 'a declined classification is not a tool error');
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });

    it('enforces the Pro entitlement gate before fetching', async () => {
      const { response, body } = await callTool('classify_event', { text: 'headline' }, {
        getEntitlements: async () => ({ planKey: 'free', features: { tier: 0, mcpAccess: false }, validUntil: Date.now() + 86_400_000 }),
      });
      assert.equal(response.status, 401);
      assert.equal(body.error.code, -32001);
      assert.equal(requests.length, 0);
    });
  });

  describe('extract_entities', () => {
    it('extracts registry + pattern entities from supplied text without any fetch', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'CVE-2026-12345 exploited by APT28 against Microsoft cloud tenants, Putin briefed',
      });
      assert.equal(result.mode, 'text');
      const ids = result.entities.map((e) => e.entityId);
      assert.ok(ids.includes('MSFT'), `expected MSFT in ${ids.join(', ')}`);
      const patterns = result.patternEntities.map((p) => `${p.kind}:${p.value}`);
      assert.ok(patterns.includes('cve:CVE-2026-12345'));
      assert.ok(patterns.includes('apt:APT28'));
      assert.ok(patterns.includes('leader:putin'));
      assert.equal(requests.length, 0, 'text mode must not fetch the digest');
    });

    it('rejects oversized text and non-string text while honoring its own outputSchema', async () => {
      for (const args of [{ text: 'y'.repeat(2049) }, { text: 42 }]) {
        const { result } = await callTool('extract_entities', args);
        assert.ok(result.error, `expected a validation error for ${JSON.stringify(args)}`);
        // outputSchema declares mode/entities/patternEntities required — a bare
        // {error} envelope breaks schema-validating agent clients.
        assert.equal(result.mode, 'text');
        assert.deepEqual(result.entities, []);
        assert.deepEqual(result.patternEntities, []);
      }
      assert.equal(requests.length, 0);
    });

    it('honors a non-default limit in text mode', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'Microsoft, Apple, Nvidia, Google and Amazon brief Putin on CVE-2026-1111 and CVE-2026-2222',
        limit: 2,
      });
      assert.equal(result.entities.length, 2, 'limit must cap the registry entity list');
      assert.ok(result.patternEntities.length <= 2, 'limit must cap the pattern entity list too');
    });

    it('de-duplicates repeated pattern entities in text mode', async () => {
      const { result } = await callTool('extract_entities', {
        text: 'CVE-2026-12345 again: CVE-2026-12345 exploited by APT28, and APT28 resurfaces',
      });
      const values = result.patternEntities.map((p) => p.value);
      assert.deepEqual([...new Set(values)], values, 'repeated mentions must collapse to one entry');
      assert.ok(values.includes('CVE-2026-12345') && values.includes('APT28'));
    });

    it('aggregates entities across the digest when no text is given', async () => {
      const { result } = await callTool('extract_entities', {});
      assert.equal(result.mode, 'headlines');
      assert.equal(result.headlineCount, 3, 'digest adapter must dedupe the repeated link');
      assert.equal(result.generatedAt, '2026-07-28T12:00:00.000Z');
      const requestUrl = new URL(requests[0].url);
      assert.equal(requestUrl.pathname, '/api/news/v1/list-feed-digest');
      assert.equal(requestUrl.searchParams.get('variant'), 'full');
      const msft = result.entities.find((e) => e.entityId === 'MSFT');
      assert.ok(msft, 'aggregation must find Microsoft');
      assert.equal(msft.mentionCount, 1);
      const cve = result.patternEntities.find((p) => p.kind === 'cve');
      assert.equal(cve?.value, 'CVE-2026-12345');
    });
  });

  describe('get_news_clusters', () => {
    it('clusters the digest with the shared algorithm and projects compact clusters', async () => {
      const { result } = await callTool('get_news_clusters', {});
      assert.equal(result.headlineCount, 3);
      assert.equal(result.totalClusters, 2);
      const hormuz = result.clusters.find((c) => c.memberCount === 2);
      assert.ok(hormuz, 'the two Hormuz headlines must form one cluster');
      assert.deepEqual(new Set(hormuz.sources), new Set(['Reuters', 'AP']));
      assert.ok(hormuz.topKeywords.includes('hormuz'));
      assert.equal(hormuz.threatLevel, 'critical');
      assert.equal(hormuz.isAlert, true);
      assert.ok(hormuz.firstSeen.endsWith('Z') && hormuz.lastUpdated.endsWith('Z'));
    });

    it('applies min_sources and limit filters', async () => {
      const { result } = await callTool('get_news_clusters', { min_sources: 2, limit: 1 });
      assert.equal(result.clusters.length, 1);
      assert.equal(result.clusters[0].memberCount, 2);
      assert.equal(result.clusters[0].distinctSourceCount, 2);
      assert.equal(result.totalClusters, 2, 'totalClusters reports the pre-filter count');
    });

    it('filters min_sources on distinct outlets, not repeat headlines from one outlet', async () => {
      const originalFetchImpl = globalThis.fetch;
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (url.includes('/api/news/v1/list-feed-digest')) {
          requests.push({ url, init });
          return Response.json({
            generatedAt: '2026-07-28T12:00:00.000Z',
            categories: {
              politics: {
                items: [
                  // Same outlet filing the same story twice: two members, ONE source.
                  { source: 'Reuters', title: 'Sanctions package advances through committee', link: 'https://s/1', publishedAt: 1785405600000, isAlert: false },
                  { source: 'Reuters', title: 'Sanctions package advances through committee vote', link: 'https://s/2', publishedAt: 1785405700000, isAlert: false },
                ],
              },
            },
          });
        }
        return originalFetchImpl(input, init);
      };
      try {
        const { result } = await callTool('get_news_clusters', { min_sources: 2 });
        assert.equal(result.totalClusters, 1, 'the two near-identical headlines cluster together');
        assert.equal(result.clusters.length, 0,
          'one outlet filing twice is not two-source corroboration');
      } finally {
        globalThis.fetch = originalFetchImpl;
      }
    });
  });

  describe('get_keyword_spikes', () => {
    function seedAccumulator() {
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 5; i++) {
        const hash = `spike${i}`;
        const lastSeen = now - i * 10 * 60 * 1000;
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Zaporizhzhia plant shelling escalates (${i})`);
        upstashState.sourcesByHash.set(hash, [`source-${i % 3}`]);
      }
      for (let i = 0; i < 30; i++) {
        const hash = `base${i}`;
        const lastSeen = now - (3 + i) * 60 * 60 * 1000;
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Weather outlook stays calm (${i})`);
      }
      upstashState.zrangeFlat = flat;
    }

    it('computes spikes from the story accumulator and caches the result', async () => {
      seedAccumulator();
      const first = await callTool('get_keyword_spikes', {});
      assert.equal(first.response.status, 200);
      assert.equal(first.result.story_count, 35);
      // The fixture's oldest story sits 32h back, so the honest sampled span is
      // 32h — asserting a flat 48 here is exactly the bug the span fix removed.
      assert.equal(first.result.baseline_hours, 32);
      assert.equal(first.result.sample_truncated, false);
      const terms = first.result.spikes.map((s) => s.term);
      assert.ok(terms.includes('zaporizhzhia'), `expected zaporizhzhia, got: ${terms.join(', ')}`);
      const spike = first.result.spikes.find((s) => s.term === 'zaporizhzhia');
      assert.equal(spike.count, 5);
      assert.equal(spike.uniqueSources, 3);
      assert.ok(upstashState.storedPayloads.size === 1, 'result must be cached');
      assert.ok(pipelineCalls > 0);

      // Second call must be served from the cache without touching pipelines.
      pipelineCalls = 0;
      const second = await callTool('get_keyword_spikes', {});
      assert.equal(pipelineCalls, 0, 'cached call must not re-run Redis pipelines');
      assert.deepEqual(
        second.result.spikes.map((s) => s.term),
        first.result.spikes.map((s) => s.term),
      );
    });

    it('returns an explicit note when the accumulator is empty', async () => {
      const { result } = await callTool('get_keyword_spikes', {});
      assert.deepEqual(result.spikes, []);
      assert.match(result.note, /accumulator unavailable or empty/);
    });

    it('clamps malformed window/min_count/limit params to defaults', async () => {
      seedAccumulator();
      const { result } = await callTool('get_keyword_spikes', { window_hours: 99.5, min_count: -3, limit: 'many' });
      assert.equal(result.window_hours, 2, 'non-integer window falls back to the default');
      // The cache key embeds the clamped minCount, so it proves the clamp
      // applied rather than the raw -3 reaching the spike math.
      assert.deepEqual([...upstashState.storedPayloads.keys()], ['intelligence:keyword-spikes:mcp:v1:2h:2'],
        'out-of-range integer min_count clamps to the schema minimum (2); the raw -3 must never reach the spike math');
      assert.ok(result.spikes.length <= 10, 'non-integer limit falls back to the default 10');
    });

    it('reports the sampled baseline span instead of assuming the full retention window', async () => {
      // 900 stories inside ~3h: the per-call cap truncates the sample, so a
      // 48h baseline claim would divide by a span never actually read.
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 900; i++) {
        const hash = `dense${i}`;
        const lastSeen = now - Math.floor(i * 12_000); // 12s apart -> ~3h total
        flat.push(hash, String(lastSeen));
        upstashState.titlesByHash.set(hash, `Routine market wrap number ${i}`);
        upstashState.sourcesByHash.set(hash, [`src-${i % 5}`]);
      }
      upstashState.zrangeFlat = flat;

      const { result } = await callTool('get_keyword_spikes', {});
      assert.equal(result.sample_truncated, true, 'hitting the story cap must be disclosed');
      assert.ok(result.baseline_hours < 48, `baseline_hours must reflect the sampled span, got ${result.baseline_hours}`);
      assert.ok(result.baseline_hours >= 4, `sampled span should cover the ~3h read, got ${result.baseline_hours}`);
      assert.equal(result.story_count, 800, 'the cap bounds the corpus actually processed');
    });

    it('exercises multi-chunk HMGET/SMEMBERS reassembly past the 200-item boundary', async () => {
      const now = Date.now();
      const flat = [];
      for (let i = 0; i < 450; i++) {
        const hash = `chunk${i}`;
        flat.push(hash, String(now - i * 1_000));
        upstashState.titlesByHash.set(hash, `Chunk boundary headline ${i}`);
        upstashState.sourcesByHash.set(hash, [`outlet-${i % 4}`]);
      }
      upstashState.zrangeFlat = flat;

      const { result } = await callTool('get_keyword_spikes', {});
      assert.equal(result.story_count, 450, 'titles from every chunk must be reassembled');
      assert.equal(result.sample_truncated, false);
    });

    it('does not cache a partial story-store read and says so', async () => {
      seedAccumulator();
      upstashState.failCommands.add('HMGET');

      const { result } = await callTool('get_keyword_spikes', {});
      assert.match(result.note, /partial story-store read/);
      assert.equal(upstashState.storedPayloads.size, 0,
        'a degraded corpus must never poison the shared 10-minute cache');
    });

    it('falls back to live computation when the cache read fails', async () => {
      seedAccumulator();
      upstashState.failCacheRead = true;

      const { response, result } = await callTool('get_keyword_spikes', {});
      assert.equal(response.status, 200, 'a cache-read outage must degrade, not error the tool');
      assert.ok(result.spikes.map((s) => s.term).includes('zaporizhzhia'));
    });
  });
});

// The edge bundle cannot import server/_shared/cache-keys.ts, so get_keyword_spikes
// hardcodes the accumulator/story-track/story-sources key strings. Tests CAN import
// both sides, so this pins them together: a server-side key-version bump would
// otherwise leave the tool reading dead keys and reporting "accumulator unavailable"
// forever, with every other test still green.
describe('#5697 spike-tool Redis key drift', () => {
  it('keeps the hardcoded key literals aligned with server/_shared/cache-keys.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { STORY_TRACK_KEY_PREFIX, STORY_SOURCES_KEY_PREFIX, DIGEST_ACCUMULATOR_KEY } =
      await import('../server/_shared/cache-keys.ts');

    const src = readFileSync(new URL('../api/mcp/registry/rpc-tools.ts', import.meta.url), 'utf8');
    assert.ok(
      src.includes(`'${DIGEST_ACCUMULATOR_KEY('full', 'en')}'`),
      `rpc-tools.ts must read the canonical accumulator key ${DIGEST_ACCUMULATOR_KEY('full', 'en')}`,
    );
    assert.ok(
      src.includes(`\`${STORY_TRACK_KEY_PREFIX}\${`),
      `rpc-tools.ts must build story-track keys from ${STORY_TRACK_KEY_PREFIX}`,
    );
    assert.ok(
      src.includes(`\`${STORY_SOURCES_KEY_PREFIX}\${`),
      `rpc-tools.ts must build story-sources keys from ${STORY_SOURCES_KEY_PREFIX}`,
    );
  });
});
