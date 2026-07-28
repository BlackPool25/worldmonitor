import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeHtmlEntities } from '../scripts/_html-entities.mjs';

/** Mirrors what a well-formed feed generator produces for a plain-text string. */
function escapeXml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

describe('decodeHtmlEntities: one pass must decode exactly one level', () => {
  it('round-trips escaped text back to the original', () => {
    const originals = [
      'AT&T completes merger',
      'XSS via &lt;script&gt; in Acme SDK',
      'Q3 revenue > $2B & rising',
      'He said "no comment"',
      "Ireland's PM: 'no deal' & <no> comment",
      'plain headline with no entities',
    ];
    for (const original of originals) {
      assert.equal(decodeHtmlEntities(escapeXml(original)), original);
    }
  });

  it('does not double-decode escaped markup into live markup', () => {
    // A headline whose literal text is `&lt;script&gt;` escapes to `&amp;lt;script&amp;gt;`.
    // Decoding `&amp;` first would yield `<script>`.
    assert.equal(
      decodeHtmlEntities('XSS via &amp;lt;script&amp;gt; in Acme SDK'),
      'XSS via &lt;script&gt; in Acme SDK',
    );
  });

  it('does not double-decode &amp;quot; / &amp;#39; / &amp;nbsp;', () => {
    assert.equal(decodeHtmlEntities('&amp;quot;'), '&quot;');
    assert.equal(decodeHtmlEntities('&amp;#39;'), '&#39;');
    assert.equal(decodeHtmlEntities('&amp;nbsp;'), '&nbsp;');
  });

  it('decodes numeric references above the BMP', () => {
    assert.equal(decodeHtmlEntities('&#128512;'), '\u{1F600}');
    assert.equal(decodeHtmlEntities('&#x1F600;'), '\u{1F600}');
    assert.equal(decodeHtmlEntities('&#X1f600;'), '\u{1F600}');
  });

  it('drops out-of-range numeric references instead of throwing', () => {
    assert.equal(decodeHtmlEntities('a&#999999999;b'), 'ab');
    assert.equal(decodeHtmlEntities('a&#x110000;b'), 'ab');
  });

  it('still decodes a single level of the predefined entities', () => {
    assert.equal(decodeHtmlEntities('5 &lt; 6 &amp; 7 &gt; 2'), '5 < 6 & 7 > 2');
    assert.equal(decodeHtmlEntities('&quot;quoted&quot; &apos;single&apos;'), '"quoted" \'single\'');
    assert.equal(decodeHtmlEntities('&#39;&#x27;&#x2F;'), "''/");
  });

  it('decodes the named entities seeders historically handled', () => {
    assert.equal(decodeHtmlEntities('&nbsp;'), ' ');
    assert.equal(decodeHtmlEntities('&hellip;&mdash;&ndash;'), '…—–');
    assert.equal(decodeHtmlEntities('&lsquo;&rsquo;&ldquo;&rdquo;'), '‘’“”');
  });

  it('matches entities case-insensitively', () => {
    assert.equal(decodeHtmlEntities('&AMP;&LT;&NBSP;'), '&< ');
  });

  it('keeps unknown entities as-is by default', () => {
    assert.equal(decodeHtmlEntities('&bogus; &amp;'), '&bogus; &');
  });

  it('blanks unknown entities when unknownEntity: "blank"', () => {
    assert.equal(decodeHtmlEntities('a &bogus; b', { unknownEntity: 'blank' }), 'a   b');
    // Single pass: the `&bogus;` produced by decoding `&amp;bogus;` is NOT re-consumed.
    assert.equal(decodeHtmlEntities('&amp;bogus;', { unknownEntity: 'blank' }), '&bogus;');
  });

  it('tolerates nullish input', () => {
    assert.equal(decodeHtmlEntities(''), '');
    assert.equal(decodeHtmlEntities(null), '');
    assert.equal(decodeHtmlEntities(undefined), '');
  });
});
