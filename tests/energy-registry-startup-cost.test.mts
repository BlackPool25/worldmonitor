// Energy pipeline/storage registries must not ride a universal tier, and a
// default-off layer must not fetch them at startup (#7046).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { bootstrapTierKeyNames } from '../shared/bootstrap-tier-keys.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const ENERGY_KEYS = ['pipelinesGas', 'pipelinesOil', 'storageFacilities'] as const;

function layerDefault(rel: string, objectName: string, layer: string): boolean {
  const src = read(rel);
  const decl = new RegExp(`const ${objectName}[^=]*=\\s*\\{`).exec(src);
  assert.ok(decl, `${rel} must declare ${objectName}`);
  const from = src.indexOf('{', decl.index);
  let depth = 0;
  let end = -1;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  assert.ok(end > from, `${objectName} in ${rel} must be a closed object literal`);
  const body = src.slice(from, end + 1);
  const match = new RegExp(`\\b${layer}:\\s*(true|false)\\b`).exec(body);
  assert.ok(match, `${objectName} in ${rel} must set ${layer}`);
  return match[1] === 'true';
}

test('energy registries are on-demand, not tier freight', () => {
  const fast = new Set(bootstrapTierKeyNames('fast'));
  const slow = new Set(bootstrapTierKeyNames('slow'));
  const onDemand = new Set(bootstrapTierKeyNames('on-demand'));
  for (const key of ENERGY_KEYS) {
    assert.ok(onDemand.has(key), `${key} must be on-demand`);
    assert.equal(fast.has(key), false, `${key} must not ride FAST`);
    assert.equal(slow.has(key), false, `${key} must not ride SLOW`);
  }
});

test('full and happy defaults keep energy layers off', () => {
  for (const [rel, name] of [
    ['src/config/panels.ts', 'FULL_MAP_LAYERS'],
    ['src/config/panels.ts', 'FULL_MOBILE_MAP_LAYERS'],
  ] as const) {
    assert.equal(layerDefault(rel, name, 'pipelines'), false, `${name}.pipelines`);
    assert.equal(layerDefault(rel, name, 'storageFacilities'), false, `${name}.storageFacilities`);
  }
});

test('energy variant keeps pipeline and storage layers on', () => {
  assert.equal(layerDefault('src/config/panels.ts', 'ENERGY_MAP_LAYERS', 'pipelines'), true);
  assert.equal(layerDefault('src/config/panels.ts', 'ENERGY_MAP_LAYERS', 'storageFacilities'), true);
});

test('data-loader only demands energy registries when the matching layer is on', () => {
  const src = read('src/app/data-loader.ts');
  assert.match(
    src,
    /mapLayers\.pipelines\) tasks\.push\(\{ name: 'pipelineRegistries'/,
  );
  assert.match(
    src,
    /mapLayers\.storageFacilities\) tasks\.push\(\{ name: 'storageFacilities'/,
  );
  assert.match(src, /case 'pipelines':/);
  assert.match(src, /case 'storageFacilities':/);
  assert.match(src, /ensurePipelineRegistriesHydrated\(/);
  assert.match(src, /ensureStorageFacilityRegistryHydrated\(/);
});

test('energy panels stay lazy-mounted and hydrate leftover then ensureHydrated', () => {
  const layout = read('src/app/panel-layout.ts');
  assert.match(layout, /lazyPanel\('pipeline-status'/);
  assert.match(layout, /lazyPanel\('storage-facility-map'/);

  const pipeline = read('src/components/PipelineStatusPanel.ts');
  assert.match(pipeline, /let \{ gas, oil \} = getCachedPipelineRegistries\(\)/);
  assert.match(pipeline, /await ensurePipelineRegistriesHydrated\(/);
  assert.match(pipeline, /this\.runWhenConnected\(apply\)/);
  assert.match(pipeline, /First paint skips RPC/);

  const storage = read('src/components/StorageFacilityMapPanel.ts');
  assert.match(storage, /let \{ registry \} = getCachedStorageFacilityRegistry\(\)/);
  assert.match(storage, /await ensureStorageFacilityRegistryHydrated\(/);
  assert.match(storage, /this\.runWhenConnected\(apply\)/);
});

test('demoted on-demand keys stay behind their deferred surfaces', () => {
  const src = read('src/app/data-loader.ts');
  assert.match(src, /mapLayers\.flights\) tasks\.push\(\{ name: 'flights'/);
  assert.match(src, /hasPremiumAccess\(\) && shouldLoad\('wsb-ticker-scanner'\)/);
  assert.match(read('src/services/aviation/index.ts'), /ensureHydrated\('flightDelays'\)/);
  assert.match(read('src/components/WsbTickerScannerPanel.ts'), /ensureHydrated\('wsbTickers'\)/);
});
