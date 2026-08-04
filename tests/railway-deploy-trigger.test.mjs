import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  buildRailwayDeployReport,
  buildRailwayEnvironmentConfigArgs,
  buildRailwayRedeployArgs,
  isTransientRailwayError,
  mergeRailwayServiceConfig,
  matchesWatchPattern,
  selectChangedRailwayServices,
} from '../scripts/trigger-railway-deploys.mjs';

const REPOSITORY = 'koala73/worldmonitor';

function repositoryService(name, watchPatterns) {
  return {
    name,
    source: { repo: REPOSITORY },
    build: watchPatterns === undefined ? {} : { watchPatterns },
  };
}

function names(services) {
  return services.map(({ service }) => service);
}

describe('Railway CI deploy trigger', () => {
  it('joins Railway service identities with environment build metadata', () => {
    const merged = mergeRailwayServiceConfig(
      [{ ...repositoryService('seed-live', ['scripts/**']), id: 'seed-live-id' }],
      {
        services: {
          'seed-live-id': {
            build: { watchPatterns: ['scripts/seed-live.mjs'] },
          },
        },
      },
    );

    assert.deepEqual(merged, [{
      name: 'seed-live',
      source: { repo: REPOSITORY },
      build: { watchPatterns: ['scripts/seed-live.mjs'] },
      id: 'seed-live-id',
    }]);
  });

  it('fails closed when live metadata omits a repository service', () => {
    assert.throws(
      () => mergeRailwayServiceConfig(
        [{ ...repositoryService('seed-missing'), id: 'seed-missing-id' }],
        { services: {} },
      ),
      /environment config is missing repository service seed-missing/,
    );
  });

  it('uses the registry closure instead of a broader live Railway filter', () => {
    const selected = selectChangedRailwayServices({
      services: [repositoryService('seed-exact', ['scripts/**'])],
      registry: [{ service: 'seed-exact', watchPatterns: ['scripts/seed-exact.mjs'] }],
      changedFiles: ['scripts/unrelated.mjs'],
    });

    assert.deepEqual(names(selected), []);
    assert.deepEqual(
      names(selectChangedRailwayServices({
        services: [repositoryService('seed-exact', ['scripts/**'])],
        registry: [{ service: 'seed-exact', watchPatterns: ['scripts/seed-exact.mjs'] }],
        changedFiles: ['scripts/seed-exact.mjs'],
      })),
      ['seed-exact'],
    );
  });

  it('adds the broad safety contract to unmanaged filtered services', () => {
    const service = repositoryService('seed-legacy', ['consumer-prices-core/**']);

    assert.deepEqual(
      names(selectChangedRailwayServices({
        services: [service],
        registry: [],
        changedFiles: ['scripts/shared-helper.mjs'],
      })),
      ['seed-legacy'],
    );
    assert.deepEqual(
      names(selectChangedRailwayServices({
        services: [service],
        registry: [],
        changedFiles: ['consumer-prices-core/src/jobs/publish.ts'],
      })),
      ['seed-legacy'],
    );
    assert.deepEqual(
      names(selectChangedRailwayServices({
        services: [service],
        registry: [],
        changedFiles: ['src/App.ts'],
      })),
      [],
    );
  });

  it('does not redundantly redeploy services already watching the whole repository', () => {
    assert.deepEqual(
      names(selectChangedRailwayServices({
        services: [repositoryService('whole-repo', [])],
        registry: [{ service: 'whole-repo', watchPatterns: [] }],
        changedFiles: ['src/App.ts'],
      })),
      [],
    );
  });

  it('fails closed when the pushed range cannot be resolved', () => {
    const selected = selectChangedRailwayServices({
      services: [
        repositoryService('seed-exact', ['scripts/**']),
        repositoryService('seed-whole-repo', []),
      ],
      registry: [
        { service: 'seed-exact', watchPatterns: ['scripts/seed-exact.mjs'] },
        { service: 'seed-whole-repo', watchPatterns: [] },
      ],
      changedFiles: null,
    });

    assert.deepEqual(names(selected), ['seed-exact']);
  });

  it('matches exact paths, single-segment globs, and recursive globs', () => {
    assert.equal(matchesWatchPattern('scripts/seed.mjs', 'scripts/seed.mjs'), true);
    assert.equal(matchesWatchPattern('scripts/nested/seed.mjs', 'scripts/*.mjs'), false);
    assert.equal(matchesWatchPattern('scripts/nested/seed.mjs', 'scripts/**'), true);
    assert.equal(matchesWatchPattern('seed.mjs', '**/*.mjs'), true);
    assert.equal(matchesWatchPattern('scripts/seed.ts', '**/*.mjs'), false);
  });

  it('builds an explicit latest-source redeploy command', () => {
    assert.deepEqual(
      buildRailwayRedeployArgs('seed-exact', 'production', 'project-123'),
      [
        'redeploy',
        '--from-source',
        '--service',
        'seed-exact',
        '--environment',
        'production',
        '--project',
        'project-123',
        '--yes',
        '--json',
      ],
    );
  });

  it('builds a project-independent environment config command', () => {
    assert.deepEqual(
      buildRailwayEnvironmentConfigArgs('production'),
      ['environment', 'config', '--environment', 'production', '--json'],
    );
  });

  it('classifies retryable Railway CLI failures narrowly', () => {
    assert.equal(isTransientRailwayError(Object.assign(new Error('network timeout'), { code: 'ETIMEDOUT' })), true);
    assert.equal(isTransientRailwayError(Object.assign(new Error('permission denied'), { code: 'EACCES' })), false);
  });

  it('keeps JSON output as a single machine-readable report', () => {
    assert.deepEqual(
      buildRailwayDeployReport({
        environment: 'production',
        before: 'before-sha',
        after: 'after-sha',
        changedFiles: ['scripts/seed-exact.mjs'],
        services: [{ service: 'seed-exact' }],
        results: [{ service: 'seed-exact', ok: true }],
      }),
      {
        environment: 'production',
        before: 'before-sha',
        after: 'after-sha',
        changedFiles: ['scripts/seed-exact.mjs'],
        services: [{ service: 'seed-exact' }],
        results: [{ service: 'seed-exact', ok: true }],
      },
    );
  });

  it('does not use a lossy fixed concurrency group for main pushes', () => {
    const workflow = readFileSync(
      new URL('../.github/workflows/railway-deploy.yml', import.meta.url),
      'utf8',
    );

    assert.match(workflow, /push:\n {4}branches: \[main\]/);
    assert.doesNotMatch(workflow, /^ {2}concurrency:/m);
    assert.doesNotMatch(workflow, /group: railway-deploy-main/);
    assert.match(workflow, /persist-credentials: false/);
    assert.match(workflow, /npm install --global --ignore-scripts @railway\/cli@5\.30\.1/);
    assert.match(workflow, /timeout 60s railway status/);
  });

  it('rejects malformed registry watch paths instead of silently skipping a service', () => {
    assert.throws(
      () => selectChangedRailwayServices({
        services: [repositoryService('seed-malformed', ['scripts/**'])],
        registry: [{ service: 'seed-malformed', watchPatterns: 'scripts/**' }],
        changedFiles: ['scripts/seed.mjs'],
      }),
      /watchPatterns must be an array/,
    );
    assert.throws(
      () => selectChangedRailwayServices({
        services: [repositoryService('seed-empty-pattern', ['scripts/**'])],
        registry: [{ service: 'seed-empty-pattern', watchPatterns: ['/'] }],
        changedFiles: ['scripts/seed.mjs'],
      }),
      /repository-relative positive paths/,
    );
  });
});
