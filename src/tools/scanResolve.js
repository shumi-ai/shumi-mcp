/**
 * Local helpers for scan_coins. No network calls.
 *
 * /api/cli/scan resolves category names itself: case and punctuation are ignored ("meme",
 * "Layer 2" and "layer-2" all find the stored "Meme" / "Layer-2"), either half of a bracketed
 * name works ("DeFi" finds "Decentralized Finance (DeFi)"), and an unknown name is a 400 that
 * lists close matches. So spelling is the server's job. The only rewrites kept here are true
 * synonyms that share no letters with the stored name, which the server cannot find:
 * "l2" (stored as "Layer-2") and "memecoin(s)" / "memes" (stored as "Meme").
 */

/** Lowercase and drop everything but letters and digits: "Layer 2" and "layer-2" collide. */
export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Synonyms the server's resolver does not know (checked against a copy of the Coin table,
// 2026-09-24). Spellings that differ only in case or punctuation are left to the server.
const CATEGORY_SYNONYMS = {
  memes: 'Meme',
  memecoin: 'Meme',
  memecoins: 'Meme',
  l2: 'Layer-2',
};

/** Stored category name for a known synonym, else `input` unchanged. */
export function canonicalCategory(input) {
  return CATEGORY_SYNONYMS[normalizeName(input)] ?? input;
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
