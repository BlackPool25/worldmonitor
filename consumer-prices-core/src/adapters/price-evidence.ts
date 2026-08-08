/**
 * On-page price evidence check (#6182).
 *
 * The anti-fabrication defense used to be purely behavioral — prompt wording
 * telling the extractor never to invent a price (#6270). That wording also
 * produced fleet-wide false negatives: extractors returned null for prices
 * that were printed on the page (a printed price next to an "Out of stock"
 * notice, a buy box adjacent to a recommendation carousel). Recovering those
 * requires softening the prompt, and softening the prompt is only safe if
 * fabrication is caught by PROOF instead of fear: a price we accept must have
 * its digits actually present in the rendered page content the same provider
 * call returned.
 *
 * 'no-content' means the check could not run (provider returned no rendered
 * content, or the price value itself is not verifiable); callers treat that as
 * the historical pass-through behavior, not as evidence either way.
 */
export type PriceEvidence = 'verified' | 'unverified' | 'no-content';

/** Max characters between the whole part and the fraction part of a price the
 * page renders as separate elements ("49" … ".79" … "AED"). Markdown flattening
 * inserts blank lines between them; unrelated digits hundreds of characters
 * apart must not pair up. */
const SPLIT_ADJACENCY_WINDOW = 40;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Digit-boundary guard: `4.60` must not match inside `34.601`. */
function standaloneNumberPattern(numberText: string): RegExp {
  return new RegExp(`(?<![\\d.,])${escapeRegExp(numberText)}(?![\\d])`);
}

/** Western thousands groupings of an integer string: 1234 -> 1,234 / 1.234. */
function thousandsVariants(digits: string): string[] {
  if (digits.length <= 3) return [];
  const grouped: string[] = [];
  for (const sep of [',', '.']) {
    let out = '';
    for (let i = 0; i < digits.length; i++) {
      const fromEnd = digits.length - i;
      if (i > 0 && fromEnd % 3 === 0) out += sep;
      out += digits[i];
    }
    grouped.push(out);
  }
  return grouped;
}

export function priceEvidenceOnPage(price: number, content: string | null | undefined): PriceEvidence {
  if (!Number.isFinite(price) || price <= 0) return 'no-content';
  if (!content || !content.trim()) return 'no-content';

  const fixed = price.toFixed(2); // "7.90"
  const [whole, fracPadded] = fixed.split('.');
  const fracShort = fracPadded.replace(/0$/, ''); // "9" for 7.90, "79" stays
  const isInteger = fracPadded === '00';

  const wholeForms = [whole, ...thousandsVariants(whole)];

  if (isInteger) {
    // Integer price: the full digit run as a standalone number token.
    return wholeForms.some((w) => standaloneNumberPattern(w).test(content)) ? 'verified' : 'unverified';
  }

  const fracForms = fracShort && fracShort !== fracPadded ? [fracPadded, fracShort] : [fracPadded];

  // Contiguous decimal: every whole-form × separator × fraction-form.
  for (const w of wholeForms) {
    for (const sep of ['.', ',']) {
      for (const f of fracForms) {
        if (standaloneNumberPattern(`${w}${sep}${f}`).test(content)) return 'verified';
      }
    }
  }

  // Split rendering: whole part and ".frac"/",frac" as separate nearby tokens.
  for (const w of wholeForms) {
    for (const f of fracForms) {
      const splitPattern = new RegExp(
        `(?<![\\d.,])${escapeRegExp(w)}(?![\\d])[\\s\\S]{0,${SPLIT_ADJACENCY_WINDOW}}?[.,]${escapeRegExp(f)}(?![\\d])`,
      );
      if (splitPattern.test(content)) return 'verified';
    }
  }

  return 'unverified';
}
