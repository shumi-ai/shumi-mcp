import { API_URL, getToken, getDeviceId, getWalletAddress } from './config.js';
import { authHint } from './hints.js';

/**
 * HTTP client for the coinrotator-ai `/api/cli/*` surface. Mirrors
 * `shumi-cli/src/lib/api-client.js` (apiGet for typed routes, query for NLP) so
 * the MCP server returns the exact same `{ data, meta }` envelope and
 * `{ error: { code, message, hint } }` error shape the CLI does.
 *
 * Typed surface is the paid surface: a token is required. Server-side tier
 * gating / x402 still applies — a 402/429 here is the server telling us the
 * caller is out of quota, and we surface that hint verbatim.
 */

const TYPED_TIMEOUT_MS = 60_000;
const NLP_TIMEOUT_MS = 300_000;
const RETRY_STATUSES = new Set([502, 503, 504]);
const MAX_ATTEMPTS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  constructor(status, body) {
    const msg =
      body?.error?.message || (typeof body?.error === 'string' ? body.error : null) || body?.message || `API request failed: ${status}`;
    super(msg);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function authHeaderOrThrow() {
  const token = getToken();
  if (!token) {
    throw new ApiError(401, {
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required.',
        hint: authHint(),
      },
    });
  }
  return `Bearer ${token}`;
}

/**
 * GET a typed CLI endpoint (under `${API_URL}/<path>`). Returns the parsed JSON
 * envelope. Throws ApiError on non-2xx or network failure.
 */
export async function apiGet(path, query = {}) {
  const authorization = authHeaderOrThrow();

  const url = new URL(`${API_URL}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== false && v !== '') url.searchParams.set(k, String(v));
  }

  // GETs are idempotent, so retry transient upstream failures (5xx / network) a
  // couple of times — a single ECONNRESET or Render cold-start shouldn't surface
  // as a tool error to the agent.
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: authorization },
        signal: AbortSignal.timeout(TYPED_TIMEOUT_MS),
      });
    } catch (err) {
      lastErr = new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(250 * attempt);
        continue;
      }
      throw lastErr;
    }

    const text = await response.text();
    let body;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { error: { code: 'INTERNAL', message: text || 'invalid response' } };
    }

    if (response.ok) return body;

    if (RETRY_STATUSES.has(response.status) && attempt < MAX_ATTEMPTS) {
      lastErr = new ApiError(response.status, body);
      await sleep(250 * attempt);
      continue;
    }
    throw new ApiError(response.status, body);
  }
  throw lastErr;
}

/**
 * POST a free-form NLP query to the chat surface. Returns `{ text, steps }`
 * (full mode) or the raw step list when `raw` is true.
 */
export async function askQuery({ messages, raw = false, archetype = 'base', commandContext = null }) {
  const authorization = authHeaderOrThrow();

  const body = {
    messages,
    deviceId: getDeviceId(),
    raw,
    archetype,
    // Marks this call as MCP-surface so the server can apply its per-surface
    // answerer model (Strapi mcpModelId). The server ignores unknown values,
    // and older servers ignore the field entirely.
    client: 'mcp',
  };
  const wallet = getWalletAddress();
  if (wallet) body.walletAddress = wallet;
  if (commandContext) body.commandContext = commandContext;

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(NLP_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ApiError(0, { error: { code: 'NETWORK', message: `Network error: ${err.message}` } });
  }

  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { error: { code: 'INTERNAL', message: text || 'invalid response' } };
  }

  if (!response.ok) throw new ApiError(response.status, json);
  return json;
}
