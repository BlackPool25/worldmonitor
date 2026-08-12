export const FOOD_STOCKS_CANONICAL_KEY = 'resilience:food-stocks:v1';
export const FOOD_STOCKS_WORLD_KEY = '_world';
export const KNOWN_COMMODITIES = new Set(['wheat', 'corn', 'rice', 'soybeans', 'barley', 'palmOil']);

const COMMODITY_ALIASES: Record<string, string> = {
  wheat: 'wheat',
  corn: 'corn',
  maize: 'corn',
  rice: 'rice',
  soy: 'soybeans',
  soybean: 'soybeans',
  soybeans: 'soybeans',
  barley: 'barley',
  palmoil: 'palmOil',
  palm_oil: 'palmOil',
  'palm-oil': 'palmOil',
};

export function normalizeFoodStocksCommodity(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const slug = COMMODITY_ALIASES[trimmed.toLowerCase().replace(/\s+/g, '')];
  if (slug && KNOWN_COMMODITIES.has(slug)) return slug;
  if (KNOWN_COMMODITIES.has(trimmed)) return trimmed;
  return null;
}

export function normalizeFoodStocksCountry(raw: string): string | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  const upper = trimmed.toUpperCase();
  if (upper === 'WORLD' || upper === 'WLD' || upper === '_WORLD') return FOOD_STOCKS_WORLD_KEY;
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return null;
}
