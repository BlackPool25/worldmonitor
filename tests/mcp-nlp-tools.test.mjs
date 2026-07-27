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

function upstashPipelineResponder(commands, state) {
  const first = commands[0]?.[0];
  if (first === 'ZRANGE') {
    return [{ result: state.zrangeFlat }];
  }
  if (first === 'HMGET') {
    return commands.map((cmd) => {
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
    };

    globalThis.fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith(FAKE_UPSTASH)) {
        if (url.includes('/pipeline')) {
          const commands = JSON.parse(init.body);
          // Count only spike-tool I/O; the per-minute limiter's evalsha rides
          // the same mocked endpoint and must not trip the cache assertions.
          if (['ZRANGE', 'HMGET', 'SMEMBERS', 'SET'].includes(commands[0]?.[0])) {
            pipelineCalls += 1;
          }
          return Response.json(upstashPipelineResponder(commands, upstashState));
        }
        // GET /get/<key>
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
      const oversized = await callTool('classify_event', { text: 'x'.repeat(501) });
      assert.match(oversized.result.error, /500-character limit/);
      assert.equal(requests.length, 0, 'validation failures must not fetch');
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

    it('rejects oversized text and non-string text', async () => {
      const oversized = await callTool('extract_entities', { text: 'y'.repeat(2049) });
      assert.match(oversized.result.error, /2048-character limit/);
      const nonString = await callTool('extract_entities', { text: 42 });
      assert.match(nonString.result.error, /must be a string/);
      assert.equal(requests.length, 0);
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
      assert.equal(result.totalClusters, 2, 'totalClusters reports the pre-filter count');
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
      assert.equal(first.result.baseline_hours, 48);
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
      assert.ok(Array.isArray(result.spikes));
    });
  });
});
