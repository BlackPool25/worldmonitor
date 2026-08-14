import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import handler from '../api/opensky.js';

describe('OpenSky legacy proxy product boundary', () => {
  const originalFetch = globalThis.fetch;
  const originalRelayUrl = process.env.WS_RELAY_URL;
  const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;

  beforeEach(() => {
    process.env.WS_RELAY_URL = 'https://relay.test';
    process.env.WORLDMONITOR_VALID_KEYS = 'desktop-product-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalRelayUrl == null) delete process.env.WS_RELAY_URL;
    else process.env.WS_RELAY_URL = originalRelayUrl;
    if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  });

  it('does not expose the proxy to browser sessions or API clients', async () => {
    let upstreamCalls = 0;
    globalThis.fetch = async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ states: [] }));
    };

    for (const headers of [
      { 'X-WorldMonitor-Key': 'wms_browser-session' },
      { 'X-Api-Key': 'desktop-product-key' },
    ]) {
      const response = await handler(new Request('https://worldmonitor.app/api/opensky', { headers }));
      assert.equal(response.status, 404);
    }
    assert.equal(upstreamCalls, 0);
  });

  it('keeps the authenticated Tauri desktop product path available', async () => {
    let upstreamUrl = '';
    globalThis.fetch = async (url) => {
      upstreamUrl = String(url);
      return new Response(JSON.stringify({ states: [['abc123']] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const response = await handler(new Request('https://worldmonitor.app/api/opensky?icao24=abc123', {
      headers: {
        Origin: 'tauri://localhost',
        'X-WorldMonitor-Key': 'desktop-product-key',
      },
    }));
    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, 'https://relay.test/opensky?icao24=abc123');
    assert.deepEqual(await response.json(), { states: [['abc123']] });
  });
});
