/**
 * Name resolution for scan_coins filters.
 *
 * /api/coins/filter matches `categories` exactly and case-sensitively
 * (`categories @> ARRAY[...]`), and `exchanges` exactly but case-insensitively against
 * `tickers[].market.name`. So "Layer 2" and "meme" match nothing (the names are "Layer-2"
 * and "Meme"), and "Coinbase" matches nothing (the name is "Coinbase Exchange"). An empty
 * list then reads to the model as "no such coins", which is a confident wrong answer.
 */

/** Lowercase and drop everything but letters and digits: "Layer 2" and "layer-2" collide. */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Resolve `input` against known `names`.
 * - exact:     `input` is itself a known name.
 * - resolved:  exactly one known name matches case/punctuation-insensitively.
 * - ambiguous: several do.
 * - none:      nothing does; `closest` holds up to 5 near names.
 */
export function resolveName(input, names) {
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n))];
  if (list.includes(input)) return { status: 'exact', name: input };
  const key = normalizeName(input);
  const hits = list.filter((n) => normalizeName(n) === key);
  if (hits.length === 1) return { status: 'resolved', name: hits[0] };
  if (hits.length > 1) return { status: 'ambiguous', closest: hits.slice(0, 5) };
  return { status: 'none', closest: closestNames(input, list) };
}

/** Near names: containment first, then shared words, then shared leading characters. */
export function closestNames(input, names, max = 5) {
  const key = normalizeName(input);
  const words = String(input ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
  const score = (n) => {
    const nk = normalizeName(n);
    if (!key) return 0;
    let s = 0;
    if (nk.includes(key) || (nk && key.includes(nk))) s += 10;
    const nw = n.toLowerCase().split(/[^a-z0-9]+/);
    for (const w of words) if (nw.includes(w)) s += 3;
    let p = 0;
    while (p < nk.length && p < key.length && nk[p] === key[p]) p++;
    return s + Math.min(p, 4);
  };
  return names
    .map((n) => [n, score(n)])
    .filter(([, s]) => s >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([n]) => n);
}

/** Category names from the category/list payload (strings, or objects carrying a name). */
export function categoryNames(data) {
  const arr = Array.isArray(data) ? data : rowsOf(data);
  return arr.map((c) => (typeof c === 'string' ? c : c?.name ?? c?.category ?? null)).filter(Boolean);
}

/**
 * The rows of a scan response. The backend returns a bare array; a change sort may wrap it
 * with a coverage summary as `{ rows: [...] }`.
 */
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['rows', 'coins', 'data', 'items']) if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

/**
 * Exchange names as they appear in tickers[].market.name for the large venues (checked against
 * a copy of the Coin table, 2026-09-24), plus the short names people use for them.
 */
export const KNOWN_EXCHANGES = [
  'Binance', 'Binance US', 'Bitfinex', 'Bitget', 'Bithumb', 'Bybit', 'Coinbase Exchange',
  'Crypto.com Exchange', 'Gate', 'HTX', 'Hyperliquid', 'Kraken', 'KuCoin', 'MEXC', 'OKX', 'Upbit',
];
const EXCHANGE_ALIASES = {
  coinbase: 'Coinbase Exchange',
  coinbasepro: 'Coinbase Exchange',
  cryptocom: 'Crypto.com Exchange',
  huobi: 'HTX',
  gateio: 'Gate',
  binanceus: 'Binance US',
};

/** Canonical exchange name for `input`, or `input` unchanged when it is not a venue we know. */
export function canonicalExchange(input) {
  const key = normalizeName(input);
  if (EXCHANGE_ALIASES[key]) return EXCHANGE_ALIASES[key];
  return KNOWN_EXCHANGES.find((n) => normalizeName(n) === key) ?? input;
}
