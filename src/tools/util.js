/**
 * Small helpers shared by tool handlers: unwrap the server envelope, apply
 * client-side token-saving filters (mirrors the CLI's --top/--fields in
 * shumi-cli/src/lib/typedCmd.js), and shape the MCP result.
 */

/** Unwrap the `{ data, meta }` envelope to its payload, keeping `meta` aside. */
export function unwrap(env) {
  if (env && typeof env === 'object' && 'data' in env) return env.data;
  return env;
}

function pick(obj, keep) {
  const out = {};
  for (const k of keep) if (k in obj) out[k] = obj[k];
  return out;
}

/**
 * --top / --fields equivalents. `top` slices an array (or the first
 * array-valued field of an object); `fields` whitelists top-level keys.
 */
export function applyFilters(data, { top, fields } = {}) {
  let d = data;
  if (top && Array.isArray(d)) {
    d = d.slice(0, top);
  } else if (top && d && typeof d === 'object') {
    for (const k of Object.keys(d)) {
      if (Array.isArray(d[k])) {
        d = { ...d, [k]: d[k].slice(0, top) };
        break;
      }
    }
  }
  if (fields) {
    const keep = new Set(
      String(fields)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
    if (Array.isArray(d)) {
      d = d.map((row) => (row && typeof row === 'object' ? pick(row, keep) : row));
    } else if (d && typeof d === 'object') {
      d = pick(d, keep);
    }
  }
  return d;
}

/**
 * Context guard: bound how much any single tool result can put into a model's
 * context window.
 *
 * `top` bounds the NUMBER of rows, which is no protection at all when one row is
 * enormous. Measured against production: `get_market_sentiment` returned 885 KB
 * — roughly 227k tokens, more than most context windows hold — and 838 KB of it
 * was a single `sources` array of 4,569 provenance links hanging off the first of
 * 22 rows. `get_signal` and `get_coin_sentiment` carried the same array at ~265 KB.
 * A trader asking "how does the market feel?" wants the one-paragraph summary and
 * the stance; nobody wants 4,569 URLs, and no agent survives being handed them.
 *
 * So arrays are capped at every depth, not just the top level. What was dropped
 * is reported in `meta._truncated` rather than being silently swallowed — the
 * model is told the data was abridged and by how much, so it can narrow with
 * `fields` or a symbol instead of assuming it saw everything.
 *
 * The byte ceiling is ~10k tokens. That is deliberately tight: it is a per-CALL
 * budget, and an agent answering one trading question may make several. A 50-item
 * cap alone left market sentiment at 59 KB (~15k tokens) because 22 rows each kept
 * 50 sources — the ceiling is what actually forces those lists down.
 *
 * Both limits are env-tunable for self-hosters who really do want the firehose.
 */
const MAX_ARRAY_ITEMS = Number(process.env.SHUMI_MCP_MAX_ARRAY_ITEMS) || 50;
const MAX_RESPONSE_BYTES = Number(process.env.SHUMI_MCP_MAX_RESPONSE_BYTES) || 40_000;
const MAX_STRING_CHARS = 4000;

function capArrays(value, maxItems, dropped, path = '') {
  if (Array.isArray(value)) {
    if (value.length > maxItems) dropped.push({ path: path || 'data', kept: maxItems, of: value.length });
    return value.slice(0, maxItems).map((v, i) => capArrays(v, maxItems, dropped, `${path}[${i}]`));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capArrays(v, maxItems, dropped, path ? `${path}.${k}` : k);
    return out;
  }
  return value;
}

function capStrings(value) {
  if (typeof value === 'string') return value.length > MAX_STRING_CHARS ? `${value.slice(0, MAX_STRING_CHARS)}…[truncated]` : value;
  if (Array.isArray(value)) return value.map(capStrings);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = capStrings(v);
    return out;
  }
  return value;
}

/**
 * Returns `{ data, truncated }`. `truncated` is undefined when nothing was
 * dropped, so an untouched response carries no extra noise.
 */
export function boundPayload(data) {
  for (const cap of [MAX_ARRAY_ITEMS, 20, 10, 5, 1]) {
    const dropped = [];
    const out = capArrays(data, cap, dropped);
    if (JSON.stringify(out).length <= MAX_RESPONSE_BYTES) {
      return dropped.length ? { data: out, truncated: dropped } : { data: out };
    }
  }
  // Pathological: still oversized with one item per array, so the bulk is in
  // strings rather than lists. Clip those too rather than ship a payload that
  // cannot be read.
  const dropped = [];
  const out = capStrings(capArrays(data, 1, dropped));
  return { data: out, truncated: dropped.length ? dropped : [{ path: 'data', kept: 0, of: 0, reason: 'oversized strings clipped' }] };
}

/**
 * Build an MCP CallToolResult with BOTH a text block (compact JSON, optionally
 * led by a one-line summary — for clients/models without structured support and
 * for backward compatibility) AND `structuredContent` (the typed envelope, for
 * clients that consume structured output). Compact, not pretty-printed, to save
 * tokens on every call. `structuredContent` is always an object so it validates
 * against the permissive shared output schema.
 */
export function result(data, { summary, meta } = {}) {
  const { data: bounded, truncated } = boundPayload(data);
  const json = JSON.stringify(bounded);
  const lines = [];
  if (summary) lines.push(summary);
  if (truncated) {
    // Say it in the text block too: a model reading only `content` would
    // otherwise treat an abridged list as the complete one.
    const worst = truncated.reduce((a, b) => (b.of > a.of ? b : a));
    lines.push(`[abridged: ${worst.path} kept ${worst.kept} of ${worst.of}${truncated.length > 1 ? `, +${truncated.length - 1} more list(s)` : ''}. Narrow with fields/top for the rest.]`);
  }
  const text = lines.length ? `${lines.join('\n')}\n${json}` : json;
  const fullMeta = truncated ? { ...(meta || {}), _truncated: truncated } : meta;
  const structuredContent = fullMeta === undefined ? { data: bounded } : { data: bounded, meta: fullMeta };
  return { content: [{ type: 'text', text }], structuredContent };
}

/** Run a summarizer defensively — a formatting bug must never fail the tool. */
export function safe(fn, data) {
  try {
    return fn(data);
  } catch {
    return undefined;
  }
}
