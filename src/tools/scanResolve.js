/**
 * Local-only name fixes for scan_coins filters. No network calls.
 *
 * /api/coins/filter matches `categories` exactly and case-sensitively
 * (`categories @> ARRAY[...]`), and `exchanges` exactly but case-insensitively against
 * `tickers[].market.name`. So "Layer 2" and "meme" match nothing (the names are "Layer-2"
 * and "Meme"), and "Coinbase" matches nothing (the name is "Coinbase Exchange"). The few
 * spellings people actually type are rewritten here from static maps; anything else is sent
 * as given, and an empty result carries a note instead of a guess.
 */

/** Lowercase and drop everything but letters and digits: "Layer 2" and "layer-2" collide. */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Real category names checked against a copy of the Coin table (2026-09-24).
const CATEGORY_FIXES = {
  meme: 'Meme',
  memes: 'Meme',
  memecoin: 'Meme',
  memecoins: 'Meme',
  layer2: 'Layer-2',
  l2: 'Layer-2',
};

// Venue names as they appear in tickers[].market.name (same check), for the short names people use.
const EXCHANGE_FIXES = {
  coinbase: 'Coinbase Exchange',
  coinbasepro: 'Coinbase Exchange',
  cryptocom: 'Crypto.com Exchange',
  huobi: 'HTX',
  gateio: 'Gate',
};

/** Real category name for a known misspelling, else `input` unchanged. */
export function canonicalCategory(input) {
  return CATEGORY_FIXES[normalizeName(input)] ?? input;
}

/** Real venue name for a known short name, else `input` unchanged. */
export function canonicalExchange(input) {
  return EXCHANGE_FIXES[normalizeName(input)] ?? input;
}

/**
 * The rows of a scan response: a bare array, or `{ rows: [...] }` should a change sort ever
 * wrap them with a coverage summary.
 */
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object' && Array.isArray(data.rows)) return data.rows;
  return [];
}
