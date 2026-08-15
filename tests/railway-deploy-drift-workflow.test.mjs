import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repoRoot, '.github/workflows/railway-deploy-drift.yml');
const source = readFileSync(workflowPath, 'utf8');
const workflow = YAML.parse(source);
const MAIN_GUARD = "${{ github.ref == 'refs/heads/main' }}";

function steps(job) {
  assert.ok(Array.isArray(job?.steps), 'job must define steps');
  return job.steps;
}

function stepNamed(job, name) {
  const step = steps(job).find((candidate) => candidate.name === name);
  assert.ok(step, `job must define ${JSON.stringify(name)}`);
  return step;
}

function gitRevision(revision) {
  const result = spawnSync('git', ['rev-parse', revision], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fakeRailwayCli({ repoRoot: fixtureRoot, headSha, previousSha }) {
  const { readFileSync: readFixture } = require('node:fs');

  const repository = 'koala73/worldmonitor';
  const manifest = JSON.parse(readFixture(`${fixtureRoot}/scripts/railway-native-autodeploy-fleet.json`, 'utf8'));
  const registry = JSON.parse(readFixture(`${fixtureRoot}/scripts/railway-services.json`, 'utf8'));
  const registryByName = new Map(registry.map((entry) => [entry.service, entry]));
  const servicesById = new Map(manifest.services.map((service) => [service.id, service]));
  const mode = process.env.RAILWAY_API_TOKEN;
  const targetServiceId = manifest.services[0].id;
  const args = process.argv.slice(2);

  const writeJson = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const fail = (message) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 97;
  };
  const argument = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const requireProject = () => {
    if (argument('--project') !== 'project-1') {
      fail(`Railway command was not scoped to project-1: ${JSON.stringify(args)}`);
      return false;
    }
    return true;
  };
  const serviceInstance = (service) => {
    const entry = registryByName.get(service.name);
    const rootDirectory = entry?.deployMode === 'nixpacks-root-scripts' ? 'scripts' : '';
    return {
      serviceId: service.id,
      source: { repo: repository, image: null },
      activeDeployments: deployments(service),
      rootDirectory,
      watchPatterns: entry?.watchPatterns ?? [],
      dockerfilePath: entry?.dockerfile ?? null,
      startCommand: null,
      cronSchedule: entry?.cronSchedule ?? null,
    };
  };
  const deployments = (service) => {
    if (mode === 'deploy-drift' && service.id === targetServiceId) {
      return [
        {
          id: `failed-${service.id}`,
          serviceId: service.id,
          status: 'FAILED',
          createdAt: '2030-01-02T00:00:00.000Z',
          meta: { commitHash: headSha },
        },
        {
          id: `running-${service.id}`,
          serviceId: service.id,
          status: 'SUCCESS',
          createdAt: '2030-01-01T00:00:00.000Z',
          meta: { commitHash: previousSha },
        },
      ];
    }
    return [{
      id: `running-${service.id}`,
      serviceId: service.id,
      status: 'SUCCESS',
      createdAt: '2030-01-01T00:00:00.000Z',
      meta: { commitHash: headSha },
    }];
  };

  if (!['healthy', 'config-drift', 'deploy-drift'].includes(mode)) {
    fail(`unexpected fake Viewer token ${JSON.stringify(mode)}`);
  } else if (args[0] === 'service' && args[1] === 'list') {
    if (requireProject()) {
      writeJson(manifest.services.map((service) => ({
        ...service,
        source: { repo: repository, image: null },
      })));
    }
  } else if (args[0] === 'status') {
    writeJson({
      environments: { edges: [{ node: { id: 'environment-1', name: 'production' } }] },
    });
  } else if (args[0] === 'api') {
    const query = args[1] ?? '';
    const variables = JSON.parse(argument('--variables'));
    if (query.includes('ViewerDeploymentConfig')) {
      const service = servicesById.get(variables.serviceId);
      if (!service) {
        fail(`unknown service ${variables.serviceId}`);
      } else {
        writeJson({
          data: {
            serviceInstance: serviceInstance(service),
            deploymentTriggers: {
              pageInfo: { hasNextPage: false },
              edges: [{
                node: {
                  serviceId: service.id,
                  repository,
                  branch: mode === 'config-drift' && service.id === targetServiceId
                    ? 'feature/drift'
                    : 'main',
                  checkSuites: false,
                  provider: 'github',
                },
              }],
            },
          },
        });
      }
    } else if (query.includes('FleetDeployments')) {
      writeJson({
        data: {
          deployments: {
            // The fleet event stream deliberately has no running deployment.
            // A healthy probe must use serviceInstance.activeDeployments as
            // its running baseline, stop after this page crosses head time,
            // and avoid every per-service deployment-list fallback.
            pageInfo: { hasNextPage: true, endCursor: 'older-events' },
            edges: manifest.services.map((service) => ({
              node: {
                id: `skipped-${service.id}`,
                serviceId: service.id,
                status: 'SKIPPED',
                createdAt: '2000-01-01T00:00:00.000Z',
                meta: { commitHash: previousSha },
              },
            })),
          },
        },
      });
    } else {
      fail('unexpected Railway GraphQL document');
    }
  } else if (args[0] === 'deployment' && args[1] === 'list') {
    fail(`unexpected per-service deployment fallback: ${JSON.stringify(args)}`);
  } else {
    fail(`unexpected Railway CLI arguments: ${JSON.stringify(args)}`);
  }
}

function createProbeFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'railway-drift-probe-'));
  const headSha = gitRevision('HEAD');
  const previousSha = gitRevision('HEAD^');
  const startedAtMs = Date.now();
  const fakeRailway = join(directory, 'railway');
  const fakeDate = join(directory, 'date');
  writeFileSync(
    fakeRailway,
    `#!/usr/bin/env node\nconst fixture = ${JSON.stringify({ repoRoot, headSha, previousSha })};\n(${fakeRailwayCli.toString()})(fixture);\n`,
  );
  writeFileSync(fakeDate, `#!/bin/sh\nprintf '%s\\n' '${startedAtMs}'\n`);
  chmodSync(fakeRailway, 0o755);
  chmodSync(fakeDate, 0o755);
  return { directory, headSha, startedAtMs };
}

function executeWorkflowShell(run, fixture, {
  mode = 'healthy',
  githubEnv = join(fixture.directory, 'github-env'),
  startedAtMs = fixture.startedAtMs,
} = {}) {
  return spawnSync('bash', [
    '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', run,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${fixture.directory}:${process.env.PATH}`,
      GITHUB_ENV: githubEnv,
      RAILWAY_API_TOKEN: mode,
      RAILWAY_PROJECT_ID: 'project-1',
      RAILWAY_COMPARISON_SHA: fixture.headSha,
      RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS: String(startedAtMs),
      RAILWAY_DRIFT_JOB_STARTED_AT_MS: String(startedAtMs),
    },
  });
}

describe('Railway Deploy Drift workflow', () => {
  it('is one hourly and manually dispatchable read-only workflow', () => {
    assert.equal(workflow.name, 'Railway Deploy Drift');
    assert.deepEqual(workflow.on.schedule, [{ cron: '17 * * * *' }]);
    assert.ok(Object.hasOwn(workflow.on, 'workflow_dispatch'));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(workflow.concurrency, {
      group: 'railway-deploy-drift-${{ github.ref }}',
      'cancel-in-progress': true,
    });
  });

  it('publishes independent config and deployment conclusions on main only', () => {
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['config-audit', 'deploy-drift']);
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job.if, MAIN_GUARD);
      assert.equal(job.needs, undefined);
      assert.equal(job['continue-on-error'], undefined);
      assert.deepEqual(job.environment, {
        name: 'ingestion-acceptance-production',
        deployment: false,
      });
    }
  });

  it('uses only the dedicated Viewer API token and never a mutation surface', () => {
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job.env, undefined, 'checkout, setup, and package install must not inherit the Viewer token');
      const credentialed = steps(job).filter((step) => step.env?.RAILWAY_API_TOKEN);
      assert.equal(credentialed.length, 1);
      for (const step of credentialed) {
        assert.equal(step.env.RAILWAY_API_TOKEN, '${{ secrets.RAILWAY_PRODUCTION_VIEWER_API_TOKEN }}');
        assert.equal(step.env.RAILWAY_PROJECT_ID, '${{ vars.RAILWAY_PROJECT_ID }}');
      }
      for (const step of steps(job).filter((candidate) => candidate.uses || candidate.name === 'Install pinned Railway CLI')) {
        assert.equal(step.env, undefined, `${step.name ?? step.uses} must not inherit the Viewer token`);
      }
    }
    assert.doesNotMatch(source, /\bRAILWAY_TOKEN\b/);
    assert.doesNotMatch(source, /RECONCILE|HMAC|DEPLOY_TOKEN|OPERATOR_TOKEN|WATCHDOG/i);
    assert.doesNotMatch(source, /actions:\s*write|deployments:\s*write|statuses:\s*write/);
    assert.doesNotMatch(source, /railway\s+(?:redeploy|up)|environment\s+(?:edit|config)|--apply/);
    assert.doesNotMatch(source, /gh\s+(?:workflow\s+run|api[^\n]*dispatch)|repository_dispatch|retry|recovery/i);
  });

  it('runs the Viewer-compatible deployment projection without variable access', () => {
    const audit = stepNamed(workflow.jobs['config-audit'], 'Audit Railway deployment configuration');
    assert.match(
      audit.run,
      /node scripts\/audit-railway-watch-paths\.mjs --environment production --deployment-only --concurrency 4 --json/,
    );
    assert.doesNotMatch(audit.run, /variable|environment config|--apply/i);
  });

  it('starts and executes both run budgets before every prerequisite', () => {
    const fixture = createProbeFixture();
    try {
      for (const { jobName, stepName, variable } of [
        {
          jobName: 'config-audit',
          stepName: 'Start config-audit run budget',
          variable: 'RAILWAY_CONFIG_AUDIT_JOB_STARTED_AT_MS',
        },
        {
          jobName: 'deploy-drift',
          stepName: 'Start deploy-drift run budget',
          variable: 'RAILWAY_DRIFT_JOB_STARTED_AT_MS',
        },
      ]) {
        const job = workflow.jobs[jobName];
        const budget = stepNamed(job, stepName);
        const githubEnv = join(fixture.directory, `budget-env-${jobName}`);
        assert.equal(steps(job).indexOf(budget), 0);
        const result = executeWorkflowShell(budget.run, fixture, { githubEnv });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(
          readFileSync(githubEnv, 'utf8'),
          `${variable}=${fixture.startedAtMs}\n`,
        );
      }
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('executes both production probes and preserves their fail-closed verdicts', () => {
    const audit = stepNamed(
      workflow.jobs['config-audit'],
      'Audit Railway deployment configuration',
    );
    const drift = stepNamed(
      workflow.jobs['deploy-drift'],
      'Check Railway deploy drift against main',
    );
    const fixture = createProbeFixture();

    try {
      const healthyAudit = executeWorkflowShell(audit.run, fixture);
      assert.equal(
        healthyAudit.status,
        0,
        `healthy config audit failed\nstdout:\n${healthyAudit.stdout}\nstderr:\n${healthyAudit.stderr}`,
      );
      assert.match(healthyAudit.stdout, /"drift": \[\]/);

      const healthyDrift = executeWorkflowShell(drift.run, fixture);
      assert.equal(
        healthyDrift.status,
        0,
        `healthy deploy drift failed\nstdout:\n${healthyDrift.stdout}\nstderr:\n${healthyDrift.stderr}`,
      );
      assert.match(healthyDrift.stdout, /Every service this repository deploys is running/);
      assert.match(
        healthyDrift.stderr,
        /Read 80 service histories in 1 fleet page\(s\) \(80 records\), 0 direct fallback\(s\)\./,
      );

      const projectedConfigDrift = executeWorkflowShell(audit.run, fixture, {
        mode: 'config-drift',
      });
      assert.notEqual(projectedConfigDrift.status, 0);
      assert.match(projectedConfigDrift.stdout, /"sourceBranch"/);
      assert.match(projectedConfigDrift.stdout, /"actual": "feature\/drift"/);

      const deploymentDrift = executeWorkflowShell(drift.run, fixture, {
        mode: 'deploy-drift',
      });
      assert.notEqual(deploymentDrift.status, 0);
      assert.match(deploymentDrift.stderr, /\[BUILD_FAILED\]/);
    } finally {
      rmSync(fixture.directory, { recursive: true, force: true });
    }
  });

  it('freezes checkout head, fetches ancestry fatally, and passes the immutable target', () => {
    const configCheckout = steps(workflow.jobs['config-audit'])
      .find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(configCheckout);
    assert.equal(configCheckout.uses, 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10');
    assert.equal(configCheckout.with?.['fetch-depth'], 1);
    assert.equal(configCheckout.with?.filter, undefined);
    assert.equal(configCheckout.with?.ref, undefined);

    const drift = workflow.jobs['deploy-drift'];
    const driftCheckout = steps(drift).find((step) => step.uses?.startsWith('actions/checkout@'));
    assert.ok(driftCheckout);
    assert.equal(driftCheckout.uses, 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10');
    assert.equal(driftCheckout.with?.['fetch-depth'], 0);
    assert.equal(driftCheckout.with?.filter, 'blob:none');
    assert.equal(driftCheckout.with?.ref, undefined);
    const freeze = stepNamed(drift, 'Freeze comparison head and fetch main ancestry');
    const check = stepNamed(drift, 'Check Railway deploy drift against main');
    assert.ok(steps(drift).indexOf(freeze) < steps(drift).indexOf(check));
    assert.match(freeze.run, /git rev-parse HEAD/);
    assert.match(freeze.run, /GITHUB_SHA/);
    assert.match(freeze.run, /RAILWAY_COMPARISON_SHA/);
    assert.match(
      freeze.run,
      /git fetch --quiet origin \+refs\/heads\/main:refs\/remotes\/origin\/main/,
    );
    assert.doesNotMatch(freeze.run, /git fetch[^\n]*--depth|git fetch[^\n]*\|\|/);
    assert.doesNotMatch(freeze.run, /git checkout|git switch|git reset/);
    assert.match(check.run, /--head "\$RAILWAY_COMPARISON_SHA"/);
    assert.match(check.run, /--concurrency 4/);
    assert.doesNotMatch(check.run, /\|\||continue-on-error/);
  });

  it('executes the frozen-head shell fail-closed on a mismatch or fetch failure', () => {
    const freeze = stepNamed(
      workflow.jobs['deploy-drift'],
      'Freeze comparison head and fetch main ancestry',
    );
    const directory = mkdtempSync(join(tmpdir(), 'railway-drift-freeze-'));
    const fakeGit = join(directory, 'git');
    writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "rev-parse" ]; then
  printf '%s\\n' "$FAKE_HEAD"
  exit 0
fi
if [ "$1" = "fetch" ]; then
  printf 'fetch\\n' >> "$FAKE_GIT_LOG"
  exit "$FAKE_FETCH_STATUS"
fi
exit 97
`);
    chmodSync(fakeGit, 0o755);

    const run = ({ checkedOut, eventSha, fetchStatus = 0, suffix }) => {
      const githubEnv = join(directory, `github-env-${suffix}`);
      const gitLog = join(directory, `git-log-${suffix}`);
      const result = spawnSync('bash', [
        '--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', freeze.run,
      ], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          GITHUB_ENV: githubEnv,
          GITHUB_SHA: eventSha,
          FAKE_HEAD: checkedOut,
          FAKE_FETCH_STATUS: String(fetchStatus),
          FAKE_GIT_LOG: gitLog,
        },
      });
      return { result, githubEnv, gitLog };
    };

    try {
      const accepted = run({ checkedOut: 'abc123', eventSha: 'abc123', suffix: 'accepted' });
      assert.equal(accepted.result.status, 0, accepted.result.stderr);
      assert.equal(readFileSync(accepted.githubEnv, 'utf8'), 'RAILWAY_COMPARISON_SHA=abc123\n');
      assert.equal(readFileSync(accepted.gitLog, 'utf8'), 'fetch\n');

      const mismatch = run({ checkedOut: 'abc123', eventSha: 'def456', suffix: 'mismatch' });
      assert.notEqual(mismatch.result.status, 0);
      assert.equal(existsSync(mismatch.gitLog), false, 'a mismatched checkout must fail before fetch');

      const fetchFailure = run({
        checkedOut: 'abc123',
        eventSha: 'abc123',
        fetchStatus: 42,
        suffix: 'fetch-failure',
      });
      assert.equal(fetchFailure.result.status, 42);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
