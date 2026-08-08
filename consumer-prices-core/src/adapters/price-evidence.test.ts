import { describe, expect, it } from 'vitest';
import { priceEvidenceOnPage } from './price-evidence.js';

describe('priceEvidenceOnPage', () => {
  it('passes through when no page content is available', () => {
    expect(priceEvidenceOnPage(4.6, undefined)).toBe('no-content');
    expect(priceEvidenceOnPage(4.6, '')).toBe('no-content');
    expect(priceEvidenceOnPage(4.6, '   ')).toBe('no-content');
  });

  it('passes through for non-verifiable price values', () => {
    expect(priceEvidenceOnPage(Number.NaN, 'page')).toBe('no-content');
    expect(priceEvidenceOnPage(0, 'page')).toBe('no-content');
    expect(priceEvidenceOnPage(-3, 'page')).toBe('no-content');
  });

  it('verifies a contiguous dot-decimal price', () => {
    expect(priceEvidenceOnPage(4.6, 'EVERYDAY LOW PRICE\n\n$4.60\n\n$0.66 / 100G')).toBe('verified');
  });

  it('verifies a contiguous comma-decimal price (pt-BR)', () => {
    expect(priceEvidenceOnPage(7.9, 'Leite Integral Piracanjuba 1 Litro\n\nR$ 7,90\n\nOps! sem estoque')).toBe('verified');
  });

  it('verifies a short decimal without a padded zero', () => {
    expect(priceEvidenceOnPage(7.9, 'preço: 7.9 reais')).toBe('verified');
  });

  it('verifies a split-rendered price (whole and fraction in separate nodes)', () => {
    // Carrefour AE renders "49" ".79" "AED" as separate lines.
    expect(priceEvidenceOnPage(49.79, 'Jumbo Pack 68 Diapers\n\n49\n\n.79\n\nAED\n\nOnly 3 left')).toBe('verified');
  });

  it('does not split-match across unrelated distant digits', () => {
    // "49" appears, ".79" appears — but 600 chars apart.
    const page = `49 diapers ${'x'.repeat(600)} rated .79 stars`;
    expect(priceEvidenceOnPage(49.79, page)).toBe('unverified');
  });

  it('rejects a fabricated price absent from the page', () => {
    const shell = "We couldn't find the page you were looking for. Explore our catalogue instead.";
    expect(priceEvidenceOnPage(3.95, shell)).toBe('unverified');
  });

  it('does not verify from digits embedded inside larger numbers', () => {
    // 4.60 must not match inside 34.601 or 4.6087.
    expect(priceEvidenceOnPage(4.6, 'weight 34.601g and id 4.6087-x')).toBe('unverified');
  });

  it('verifies an integer price as a standalone token', () => {
    expect(priceEvidenceOnPage(455, 'MRP: ₹455 (incl. taxes)')).toBe('verified');
    expect(priceEvidenceOnPage(455, 'order #4550 shipped')).toBe('unverified');
  });

  it('verifies a thousands-separated price', () => {
    expect(priceEvidenceOnPage(1234.56, 'now $1,234.56 only')).toBe('verified');
    expect(priceEvidenceOnPage(1234.56, 'agora R$ 1.234,56')).toBe('verified');
  });
});
