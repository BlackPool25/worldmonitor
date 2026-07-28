#!/usr/bin/env node
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_LOCAL_ENV_DUMPS = [
  '.env.vercel-backup',
  '.env.vercel-export',
];

export const FORBIDDEN_LOCAL_ENV_DUMP_PATTERN =
  /^\.env(?:[.-].*)?[.-](?:bak|backup|export)[^/]*$/i;

export function findLocalSecretDumps(rootDir = process.cwd()) {
  let fileNames;
  try {
    fileNames = readdirSync(rootDir);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const forbiddenNames = new Set(FORBIDDEN_LOCAL_ENV_DUMPS);
  return fileNames
    .filter((fileName) =>
      forbiddenNames.has(fileName) || FORBIDDEN_LOCAL_ENV_DUMP_PATTERN.test(fileName),
    )
    .sort();
}

export function formatLocalSecretDumpError(found) {
  return [
    'ERROR: local environment dump files are present in the repository root.',
    '',
    ...found.map((fileName) => `  - ${fileName}`),
    '',
    'Delete these plaintext dumps before pushing. Pull Vercel env values on demand',
    'and rotate exposed production secrets through the owning vendor dashboards.',
  ].join('\n');
}

export function runLocalSecretDumpCheck(rootDir = process.cwd()) {
  const found = findLocalSecretDumps(rootDir);
  if (found.length > 0) {
    throw new Error(formatLocalSecretDumpError(found));
  }
}

const isDirectRun = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isDirectRun) {
  try {
    runLocalSecretDumpCheck();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
