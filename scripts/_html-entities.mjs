/**
 * Shared single-pass HTML/XML entity decoder for seed scripts.
 *
 * Why single-pass: sequential `.replace(/&amp;/g, '&')` chains decode TWO
 * levels when `&amp;` runs before the other replaces — `&amp;lt;` becomes
 * `<` in one call, turning escaped text into live markup. One regex pass
 * over an alternation decodes exactly one level for every input.
 *
 * `String.fromCodePoint` throws `RangeError` on anything outside the Unicode
 * range, which would turn one malformed numeric reference (`&#999999999;`)
 * into a failed seed run. Out-of-range references are dropped instead.
 * `fromCharCode` is not usable here: it truncates to 16 bits, so `&#128512;`
 * would decode to U+F600 (a private-use glyph) rather than 😀.
 */

function decodeNumericReference(codePoint) {
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : '';
}

// Named entities the seeders historically handled. `nbsp` maps to a plain
// space (matching every prior decoder); curly quotes map to their correct
// Unicode code points.
const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
};

const ENTITY_RE = /&(?:#x([0-9a-f]+)|#(\d+)|([a-z][a-z0-9]*));/gi;

/**
 * Decode exactly one level of HTML/XML entities.
 *
 * @param {unknown} text
 * @param {{ unknownEntity?: 'keep' | 'blank' }} [options]
 *   `keep` (default) leaves unrecognized entities untouched; `blank` replaces
 *   them with a single space (the old seed-sovereign-wealth catch-all).
 */
export function decodeHtmlEntities(text, { unknownEntity = 'keep' } = {}) {
  return String(text ?? '').replace(ENTITY_RE, (match, hex, dec, name) => {
    if (hex !== undefined) return decodeNumericReference(parseInt(hex, 16));
    if (dec !== undefined) return decodeNumericReference(Number(dec));
    const value = NAMED_ENTITIES[name.toLowerCase()];
    if (value !== undefined) return value;
    return unknownEntity === 'blank' ? ' ' : match;
  });
}
