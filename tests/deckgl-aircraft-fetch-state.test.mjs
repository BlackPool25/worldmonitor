import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(resolve(root, 'src/components/DeckGLMap.ts'), 'utf8');

describe('DeckGL aircraft fetch state', () => {
  it('clears readiness with aircraft data only for the current failed request', () => {
    const fetchMethod = source.match(
      /private fetchViewportAircraft\(\): void \{[\s\S]+?\n {2}\}(?=\n\n {2}public setNaturalEvents)/,
    )?.[0];
    assert.ok(fetchMethod, 'fetchViewportAircraft must remain discoverable');

    const errorHandler = fetchMethod.match(/\.catch\(\(err\) => \{([\s\S]+?)\n {4}\}\);/)?.[1];
    assert.ok(errorHandler, 'aircraft fetch must retain an error handler');
    assert.match(
      errorHandler,
      /if \(seq === this\.aircraftFetchSeq\) \{\s*this\.aircraftPositions = \[\];\s*this\.onAircraftPositionsUpdate\?\.\(\[\]\);\s*this\.setLayerReady\('flights', false\);\s*this\.render\(\);\s*\}/,
      'a current failure must clear both aircraft data and the layer ready state',
    );
    assert.doesNotMatch(
      errorHandler.replace(/if \(seq === this\.aircraftFetchSeq\) \{[\s\S]+?\n {6}\}/, ''),
      /setLayer(?:Loading|Ready)\('flights'/,
      'a stale failure must not settle a newer request\'s loading or ready state',
    );
  });
});
