import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const callSiteFiles = [
  'src/components/Panel.ts',
  'src/components/ResilienceWidget.ts',
  'src/app/event-handlers.ts',
  'src/app/desktop-updater.ts',
  'src/settings-main.ts',
  'src/components/RuntimeConfigPanel.ts',
];

describe('external navigation call-site contract (#6120)', () => {
  it('routes every renderer open_url handoff through openExternalUrl', () => {
    const directOpenUrlCalls = [];
    const missingHelperImports = [];
    const missingHelperCalls = [];

    for (const relativePath of callSiteFiles) {
      const source = readFileSync(join(root, relativePath), 'utf8');
      if (/\binvokeTauri(?:<[^>]+>)?\(\s*['"]open_url['"]/.test(source)) {
        directOpenUrlCalls.push(relativePath);
      }
      if (!source.includes('external-navigation')) {
        missingHelperImports.push(relativePath);
      }
      if (!/\bopenExternalUrl\s*\(/.test(source)) {
        missingHelperCalls.push(relativePath);
      }
    }

    assert.deepEqual(directOpenUrlCalls, [], 'renderer call sites must not hand-roll open_url');
    assert.deepEqual(missingHelperImports, [], 'every migrated call site must import external-navigation');
    assert.deepEqual(missingHelperCalls, [], 'every migrated call site must call openExternalUrl');
  });
});
