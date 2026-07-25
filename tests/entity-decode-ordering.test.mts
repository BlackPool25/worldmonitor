import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// #5436: every hand-rolled entity decoder must decode `&amp;` LAST. Decoding
// it first turns the escaped ampersand of `&amp;lt;` into a live `&`, which a
// later replace then consumes as `&lt;` — one pass decoding two levels, so
// double-escaped payloads (`&amp;lt;script&amp;gt;`) re-emerge as live markup
// after tag-stripping. Two decoders also fed unvalidated numeric refs straight
// into String.fromCodePoint, which throws RangeError above 0x10FFFF.

import { htmlToPlainText } from '../scripts/_trade-parse-utils.mjs';
import { decodeHtmlEntities as decodeEnergy } from '../scripts/seed-energy-intelligence.mjs';
import { decodeHtmlEntities as decodeFatf } from '../scripts/seed-fatf-listing.mjs';
import { decodeHtml as decodeGlobalTenders } from '../scripts/seed-global-tenders.mjs';
import { decodeEntities as decodeRegulatory } from '../scripts/seed-regulatory-actions.mjs';
import { stripHtml as stripAdvisoriesHtml } from '../scripts/seed-security-advisories.mjs';
import { decodeHtmlEntities as decodePanelNews } from '../src/components/CountryDeepDivePanel-news-utils';

const DOUBLE_ESCAPED = '&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;';

describe('single-level decode: &amp;lt; must yield the text "&lt;", never "<"', () => {
  const plainDecoders: Array<[string, (s: string) => string]> = [
    ['seed-energy-intelligence', decodeEnergy],
    ['seed-fatf-listing', decodeFatf],
    ['seed-regulatory-actions', decodeRegulatory],
    ['CountryDeepDivePanel-news-utils', decodePanelNews],
  ];

  for (const [name, decode] of plainDecoders) {
    it(`${name}: double-escaped markup stays escaped one level`, () => {
      const out = decode(DOUBLE_ESCAPED);
      assert.ok(!out.includes('<script'), `${name} produced live markup: ${out}`);
      assert.ok(out.includes('&lt;script&gt;'), `${name} lost the single-escaped form: ${out}`);
    });

    it(`${name}: plain &amp; still decodes`, () => {
      assert.equal(decode('Fish &amp; Chips'), 'Fish & Chips');
    });

    it(`${name}: singly-escaped entities still decode`, () => {
      assert.equal(decode('&lt;b&gt;'), '<b>');
    });
  }
});

describe('strip-then-decode pipelines cannot be re-armed by double escaping', () => {
  it('seed-security-advisories stripHtml: double-escaped <script> does not survive the strip', () => {
    const out = stripAdvisoriesHtml(`<p>ACSC alert</p> ${DOUBLE_ESCAPED}`);
    assert.ok(!out.includes('<script'), `live markup in: ${out}`);
    assert.ok(out.includes('ACSC alert'));
  });

  it('seed-global-tenders decodeHtml: double-escaped <script> does not survive the strip', () => {
    const out = decodeGlobalTenders(`<b>Tender</b> ${DOUBLE_ESCAPED}`);
    assert.ok(!out.includes('<script'), `live markup in: ${out}`);
    assert.ok(out.includes('Tender'));
  });

  it('_trade-parse-utils htmlToPlainText: &amp;quot; stays one level', () => {
    assert.equal(htmlToPlainText('&amp;quot;x&amp;quot;'), '&quot;x&quot;');
    assert.equal(htmlToPlainText('&quot;x&quot;'), '"x"');
  });
});

describe('numeric refs are bounds-checked instead of throwing RangeError', () => {
  const numericDecoders: Array<[string, (s: string) => string]> = [
    ['seed-energy-intelligence', decodeEnergy],
    ['seed-regulatory-actions', decodeRegulatory],
  ];

  for (const [name, decode] of numericDecoders) {
    it(`${name}: out-of-range refs are dropped without throwing`, () => {
      assert.doesNotThrow(() => decode('&#x110000;'));
      assert.doesNotThrow(() => decode('&#9999999999;'));
      assert.equal(decode('a&#x110000;b'), 'ab');
    });

    it(`${name}: valid refs still decode (incl. astral plane)`, () => {
      assert.equal(decode('&#128512;'), '\u{1F600}');
      assert.equal(decode('&#x27;'), "'");
    });
  }
});
