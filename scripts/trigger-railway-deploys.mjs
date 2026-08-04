#!/usr/bin/env node

import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  BROAD_WATCH_PATTERNS,
  RAILWAY_CALL_TIMEOUT_MS,
  isRepositoryService,
  readArgument,
  runRailway,
} from './audit-railway-watch-paths.mjs';

const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_CONCURRENCY = 8;
const MAX_RAILWAY_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 1000;
const ZERO_SHA = /^0{40}$/u;
const REGISTRY_URL = new URL('./railway-services.json', import.meta.url);
const execFileAsync = promisify(execFile);

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizePath(value) {
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replace(/^\/+|\/+$/gu, '');
}

function normalizePatterns(patterns, label) {
  if (!Array.isArray(patterns)) {
    throw new Error(`${label} watchPatterns must be an array`);
  }
  return [...new Set(patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw new Error(`${label} watchPatterns must contain non-empty strings`);
    }
    const normalized = normalizePath(pattern.trim());
    if (!normalized || normalized.startsWith('!')) {
      throw new Error(`${label} watchPatterns must contain repository-relative positive paths`);
    }
    return normalized;
  }))];
}

function segmentMatches(fileSegment, patternSegment) {
  let source = '';
  for (let index = 0; index < patternSegment.length; index += 1) {
    const char = patternSegment[index];
    if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u').test(fileSegment);
}

function matchPathSegments(fileSegments, patternSegments, fileIndex, patternIndex, memo) {
  const key = `${fileIndex}:${patternIndex}`;
  if (memo.has(key)) return memo.get(key);

  let matched;
  if (patternIndex === patternSegments.length) {
    matched = fileIndex === fileSegments.length;
  } else if (patternSegments[patternIndex] === '**') {
    matched = matchPathSegments(fileSegments, patternSegments, fileIndex, patternIndex + 1, memo)
      || (fileIndex < fileSegments.length
        && matchPathSegments(fileSegments, patternSegments, fileIndex + 1, patternIndex, memo));
  } else {
    matched = fileIndex < fileSegments.length
      && segmentMatches(fileSegments[fileIndex], patternSegments[patternIndex])
      && matchPathSegments(fileSegments, patternSegments, fileIndex + 1, patternIndex + 1, memo);
  }

  memo.set(key, matched);
  return matched;
}

/** Match one repository-relative changed path against a Railway-style glob. */
export function matchesWatchPattern(file, pattern) {
  if (typeof file !== 'string' || typeof pattern !== 'string') return false;
  const normalizedFile = normalizePath(file);
  const normalizedPattern = normalizePath(pattern);
  if (!normalizedFile || !normalizedPattern || normalizedPattern.startsWith('!')) return false;
  return matchPathSegments(
    normalizedFile.split('/'),
    normalizedPattern.split('/'),
    0,
    0,
    new Map(),
  );
}

function registryByServiceName(registry) {
  if (!Array.isArray(registry)) throw new Error('Railway service registry must be an array');
  const entries = new Map();
  for (const entry of registry) {
    if (typeof entry?.service !== 'string' || entry.service.length === 0) {
      throw new Error('Railway registry entries must have a service name');
    }
    if (entries.has(entry.service)) {
      throw new Error(`Railway service registry contains duplicate service ${entry.service}`);
    }
    entries.set(entry.service, entry);
  }
  return entries;
}

/**
 * Resolve the repository-side trigger scope for one live Railway service.
 *
 * A non-empty registry closure is authoritative. An explicitly empty registry
 * closure means the service already watches the whole repository, so an extra
 * CI redeploy would duplicate Railway's normal trigger. For services that do
 * not yet have a checked-in closure, retain their live filtered scope and add
 * the broad scripts/shared contract: the scheduled Railway audit requires that
 * fallback for unmanaged seeders, and matching it here makes the Railway
 * matcher itself non-load-bearing.
 */
export function triggerScopeForService(service, registryEntries) {
  const name = service?.name ?? service?.service;
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Railway service must have a name');
  }

  const registryEntry = registryEntries instanceof Map
    ? registryEntries.get(name)
    : registryByServiceName(registryEntries).get(name);

  if (registryEntry && hasOwn(registryEntry, 'watchPatterns')) {
    const patterns = normalizePatterns(registryEntry.watchPatterns, `${name} registry entry`);
    return patterns.length === 0
      ? null
      : { patterns, source: 'registry' };
  }

  const livePatterns = service?.build?.watchPatterns;
  if (livePatterns == null) return null;
  const patterns = normalizePatterns(livePatterns, `${name} live service`);
  if (patterns.length === 0) return null;

  return {
    patterns: [...new Set([...patterns, ...BROAD_WATCH_PATTERNS])],
    source: 'live-plus-broad-fallback',
  };
}

/**
 * Select only filtered repository services whose dependency scope changed.
 * `changedFiles: null` is the fail-closed representation of an unavailable
 * diff: every filtered service is selected, while whole-repository services
 * remain excluded because Railway already triggers those normally.
 */
export function selectChangedRailwayServices({ services, registry, changedFiles }) {
  if (!Array.isArray(services)) throw new Error('Railway service list must be an array');
  const registryEntries = registryByServiceName(registry);
  if (changedFiles != null && !Array.isArray(changedFiles)) {
    throw new Error('changedFiles must be an array or null');
  }
  const normalizedChangedFiles = changedFiles == null ? null : changedFiles.map((file) => {
    if (typeof file !== 'string') throw new Error('changedFiles must contain strings');
    return normalizePath(file);
  }).filter(Boolean);

  return services
    .filter(isRepositoryService)
    .map((service) => {
      const name = service.name ?? service.service;
      const scope = triggerScopeForService(service, registryEntries);
      if (!scope) return null;
      const changed = normalizedChangedFiles == null
        || normalizedChangedFiles.some((file) => scope.patterns.some((pattern) => matchesWatchPattern(file, pattern)));
      if (!changed) return null;
      return {
        service: name,
        serviceId: service.id ?? null,
        patterns: scope.patterns,
        source: scope.source,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.service.localeCompare(right.service));
}

export function buildRailwayRedeployArgs(service, environment, projectId) {
  if (typeof service !== 'string' || service.length === 0) {
    throw new Error('Railway redeploy requires a service');
  }
  if (typeof environment !== 'string' || environment.length === 0) {
    throw new Error('Railway redeploy requires an environment');
  }
  return [
    'redeploy',
    '--from-source',
    '--service',
    service,
    '--environment',
    environment,
    ...(projectId ? ['--project', projectId] : []),
    '--yes',
    '--json',
  ];
}

export function buildRailwayDeployReport({
  environment,
  before,
  after,
  changedFiles,
  services,
  results,
}) {
  return {
    environment,
    before,
    after,
    changedFiles,
    services,
    ...(results ? { results } : {}),
  };
}

export function buildRailwayEnvironmentConfigArgs(environment) {
  if (typeof environment !== 'string' || environment.length === 0) {
    throw new Error('Railway environment config requires an environment');
  }
  return ['environment', 'config', '--environment', environment, '--json'];
}

export function isTransientRailwayError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = [error?.message, error?.stderr].filter(Boolean).join(' ');
  return /^(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN)$/u.test(code)
    || error?.killed === true
    || /(?:timed? out|timeout|rate limit|\b429\b|temporarily unavailable|internal server error|bad gateway|service unavailable|gateway timeout)/iu.test(message);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function execRailwayRedeployWithRetry(service, environment, projectId) {
  const args = buildRailwayRedeployArgs(service, environment, projectId);
  for (let attempt = 1; attempt <= MAX_RAILWAY_ATTEMPTS; attempt += 1) {
    try {
      return await execFileAsync('railway', args, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
        timeout: RAILWAY_CALL_TIMEOUT_MS,
      });
    } catch (error) {
      if (attempt === MAX_RAILWAY_ATTEMPTS || !isTransientRailwayError(error)) throw error;
      const delay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      console.warn(`Transient Railway trigger failure for ${service}; retrying in ${delay}ms.`);
      await wait(delay);
    }
  }
  throw new Error(`Railway trigger attempts exhausted for ${service}`);
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: RAILWAY_CALL_TIMEOUT_MS,
  });
  if (result.signal) throw new Error(`git ${args.join(' ')} timed out`);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed (${result.status}): ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function changedFilesBetween(before, after) {
  if (!before || !after || ZERO_SHA.test(before) || ZERO_SHA.test(after)) return null;
  try {
    // Disable rename detection so both the removed and added paths participate
    // in matching. A rename can remove a service dependency even when its new
    // name is outside that service's old closure.
    return runGit(['diff', '--name-only', '--no-renames', before, after, '--'])
      .split('\n')
      .map((file) => file.trim())
      .filter(Boolean);
  } catch (error) {
    console.warn(
      `Could not resolve ${before}..${after}; selecting every filtered Railway service defensively: `
        + (error instanceof Error ? error.message : String(error)),
    );
    return null;
  }
}

function readRegistry() {
  return JSON.parse(readFileSync(REGISTRY_URL, 'utf8'));
}

/** Join service-list identities with build metadata from environment config. */
export function mergeRailwayServiceConfig(services, config) {
  if (!Array.isArray(services)) throw new Error('Railway service list must be an array');
  if (!config?.services || typeof config.services !== 'object' || Array.isArray(config.services)) {
    throw new Error('Railway environment config must contain a services object');
  }
  return services.map((service) => {
    const id = service?.id;
    const configured = id ? config.services[id] : undefined;
    const merged = {
      ...service,
      ...(configured ?? {}),
      id,
      name: service?.name ?? configured?.name,
      source: service?.source ?? configured?.source,
    };
    if (isRepositoryService(merged) && (!id || !configured)) {
      throw new Error(`Railway environment config is missing repository service ${service?.name ?? id}`);
    }
    return merged;
  });
}

function readRepositoryServices(environment, projectId) {
  const serviceArgs = ['service', 'list'];
  if (projectId) serviceArgs.push('--project', projectId);
  serviceArgs.push('--environment', environment, '--json');
  const services = JSON.parse(runRailway(serviceArgs));
  const config = JSON.parse(runRailway(buildRailwayEnvironmentConfigArgs(environment)));
  const repositoryServices = mergeRailwayServiceConfig(services, config).filter(isRepositoryService);
  if (repositoryServices.length === 0) {
    throw new Error('Railway service list returned no repository-backed services');
  }
  return repositoryServices;
}

/** Run an async worker over items with a bounded number of in-flight calls. */
export async function mapWithConcurrency(items, limit, worker) {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('concurrency must be a positive integer');
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function triggerSelectedServices(selected, environment, projectId, concurrency) {
  return mapWithConcurrency(selected, concurrency, async (entry) => {
    const target = entry.serviceId ?? entry.service;
    try {
      await execRailwayRedeployWithRetry(target, environment, projectId);
      return { ...entry, ok: true };
    } catch (error) {
      return {
        ...entry,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function main() {
  const environment = readArgument(process.argv, '--environment', DEFAULT_ENVIRONMENT);
  const projectId = readArgument(process.argv, '--project', process.env.RAILWAY_PROJECT_ID ?? null);
  if (!projectId) throw new Error('Railway project ID is required via --project or RAILWAY_PROJECT_ID');

  const before = readArgument(process.argv, '--before', process.env.GITHUB_EVENT_BEFORE ?? null);
  const after = readArgument(process.argv, '--after', process.env.GITHUB_SHA ?? null)
    ?? runGit(['rev-parse', 'HEAD']);
  const changedFiles = changedFilesBetween(before, after);
  const selected = selectChangedRailwayServices({
    services: readRepositoryServices(environment, projectId),
    registry: readRegistry(),
    changedFiles,
  });
  const asJson = process.argv.includes('--json');
  const dryRun = process.argv.includes('--dry-run');

  if (!asJson) {
    console.log(
      `Railway CI deploy trigger: environment=${environment} before=${before ?? 'unavailable'} `
        + `after=${after} changedFiles=${changedFiles == null ? 'unavailable' : changedFiles.length} `
        + `services=${selected.length}${dryRun ? ' mode=dry-run' : ''}`,
    );
    for (const entry of selected) {
      console.log(`- ${entry.service} [${entry.source}] ${entry.patterns.join(', ')}`);
    }
  }

  if (dryRun || selected.length === 0) {
    if (asJson) {
      console.log(JSON.stringify(buildRailwayDeployReport({
        environment,
        before,
        after,
        changedFiles,
        services: selected,
      }), null, 2));
    }
    return;
  }

  const concurrency = Number(readArgument(
    process.argv,
    '--concurrency',
    String(DEFAULT_CONCURRENCY),
  ));
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('--concurrency must be a positive integer');
  }

  const results = await triggerSelectedServices(selected, environment, projectId, concurrency);
  const failed = results.filter((result) => !result.ok);
  if (asJson) {
    console.log(JSON.stringify(buildRailwayDeployReport({
      environment,
      before,
      after,
      changedFiles,
      services: selected,
      results,
    }), null, 2));
  } else {
    for (const result of results.filter((entry) => entry.ok)) {
      console.log(`Triggered latest-source deploy for ${result.service}.`);
    }
    for (const result of failed) {
      console.error(`Failed to trigger latest-source deploy for ${result.service}: ${result.error}`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} Railway deploy trigger(s) failed`);
  }
}

function isMainModule() {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href
      === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href;
  } catch {
    return false;
  }
}

if (process.argv[1] && isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
