import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { getToken, getDeviceId, getWalletAddress } from './config.js';

/**
 * PostHog product analytics for the Shumi MCP server. Mirrors the canonical
 * setup used across every Shumi surface (CLI, web, hub): all events go to the
 * managed reverse proxy at t.shumi.ai so one project sees the whole funnel.
 *
 * Telemetry is strictly fire-and-forget: a failure here must NEVER crash, slow,
 * or alter a tool call. Disabled (safe no-op) when SHUMI_TELEMETRY is off or no
 * key resolves — tests run with SHUMI_TELEMETRY=0 so they never emit.
 *
 * Identity model (canonical person id = lowercased wallet address, shared with
 * web + CLI so one human is one PostHog person across every surface):
 *   - stdio (single-user, runs on the user's machine): distinct_id is the
 *     wallet from `shumi login` / SHUMI_WALLET when known — identifySession()
 *     aliases the token-hash and device ids into that person. Without a wallet,
 *     falls back to token-hash, then machine fingerprint.
 *   - HTTP (multi-tenant, hosted): distinct_id is always a hash of the caller's
 *     bearer token (per-user, pseudonymous, never the secret itself). The
 *     wallet is unknown here; coinrotator-ai's stitchToWallet() aliases the
 *     same token-hash into the wallet person server-side on authentication.
 */

const DEFAULT_KEY = 'phc_xBnChEMGfPyg3CUKngxDcQsespURUnWKaUrfBdOOCyI';
const DEFAULT_HOST = 'https://t.shumi.ai';

let client = null;
let enabled = false;
let transportLabel = 'unknown';

export function initTelemetry(transport = 'unknown') {
  transportLabel = transport;
  const optOut = /^(0|false|off|no)$/i.test(process.env.SHUMI_TELEMETRY || '');
  const key = process.env.POSTHOG_API_KEY ?? DEFAULT_KEY;
  if (optOut || !key) {
    enabled = false;
    return;
  }
  const host = process.env.POSTHOG_HOST || DEFAULT_HOST;
  try {
    // HTTP is long-running: batch sends, rely on graceful-shutdown flush.
    // stdio sessions end when the MCP client kills the process — often without
    // a signal we get to handle — so send each event immediately instead of
    // batching, or a short session's events die in the queue.
    const flushAt = transport === 'stdio' ? 1 : 20;
    client = new PostHog(key, { host, flushAt, flushInterval: 10_000 });
    enabled = true;
  } catch {
    enabled = false;
  }
}

export function isEnabled() {
  return enabled;
}

/** First6…last4 wallet truncation for safe property capture (mirrors the CLI). */
function truncWallet(addr) {
  if (!addr || typeof addr !== 'string') return null;
  if (addr.length < 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Lowercased local wallet, stdio only — HTTP is multi-tenant, a process-level
 * wallet there would misattribute every caller to one person. */
function localWallet() {
  if (transportLabel !== 'stdio') return null;
  try {
    const w = getWalletAddress();
    return w && typeof w === 'string' ? w.toLowerCase() : null;
  } catch {
    return null;
  }
}

// MUST match coinrotator-ai lib/observability.js mcpTokenDistinctId():
//   shumi_key_<sha256(rawBearerToken)[:24]>
// Changing either side without the other silently breaks MCP↔hub stitching.
function tokenDistinctId() {
  try {
    const token = getToken();
    if (token) return `shumi_key_${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
  } catch {
    /* fall through */
  }
  return null;
}

/** Canonical per-caller id: wallet (stdio) > hash(token) > machine id. */
function distinctId() {
  const wallet = localWallet();
  if (wallet) return wallet;
  const tokenId = tokenDistinctId();
  if (tokenId) return tokenId;
  try {
    return `device_${getDeviceId()}`;
  } catch {
    return 'anonymous';
  }
}

/**
 * Fold this machine's pseudonymous ids (token-hash, device fingerprint) into
 * the wallet person, so stdio MCP usage lands on the same PostHog person as the
 * web session and the CLI. stdio only; call once at startup after
 * initTelemetry. No-op without a wallet or when telemetry is disabled.
 */
export function identifySession() {
  if (!enabled || !client) return;
  try {
    const wallet = localWallet();
    if (!wallet) return;
    const aliases = [tokenDistinctId()];
    try {
      aliases.push(`device_${getDeviceId()}`);
    } catch {
      /* skip */
    }
    for (const alias of aliases) {
      if (alias && alias !== wallet) client.alias({ distinctId: wallet, alias });
    }
    client.identify({ distinctId: wallet, properties: { $set: { wallet_truncated: truncWallet(wallet) } } });
  } catch {
    /* never throw from telemetry */
  }
}

export function capture(event, properties = {}) {
  if (!enabled || !client) return;
  try {
    client.capture({
      distinctId: distinctId(),
      event,
      // `surface` is the canonical cross-surface tag (all Shumi surfaces share
      // one PostHog project + key). Kept in sync with coinrotator/shumi-landing
      // (web) and coinrotator-ai ('api'/'cli').
      properties: { surface: 'mcp', transport: transportLabel, ...properties },
    });
  } catch {
    /* never throw from telemetry */
  }
}

export function captureError(error, properties = {}) {
  if (!enabled || !client) return;
  try {
    client.captureException(error, distinctId(), { surface: 'mcp', transport: transportLabel, ...properties });
  } catch {
    /* never throw from telemetry */
  }
}

/**
 * Monkeypatch a freshly-built McpServer so every tool registered afterwards has
 * its handler wrapped with a `mcp.tool_called` event (tool_name, status,
 * duration_ms) + exception capture. Transparent: the handler's result is passed
 * through untouched. No-op when telemetry is disabled, so tests see the bare
 * server. Tool ARGS are never captured (they can contain user queries).
 */
export function instrumentToolCalls(server) {
  if (!enabled) return;
  const original = server.registerTool.bind(server);
  server.registerTool = (name, config, handler) => {
    if (typeof handler !== 'function') return original(name, config, handler);
    const wrapped = async (...args) => {
      const start = Date.now();
      try {
        const res = await handler(...args);
        const isError = !!(res && res.isError);
        capture('mcp.tool_called', {
          tool_name: name,
          status: isError ? 'error' : 'ok',
          is_error: isError,
          duration_ms: Date.now() - start,
        });
        return res;
      } catch (err) {
        capture('mcp.tool_called', { tool_name: name, status: 'error', is_error: true, duration_ms: Date.now() - start });
        captureError(err, { tool_name: name });
        throw err;
      }
    };
    return original(name, config, wrapped);
  };
}

/** Flush + close. Call on graceful shutdown so queued events aren't lost. */
export async function shutdownTelemetry() {
  if (!client) return;
  try {
    await client.shutdown();
  } catch {
    /* ignore */
  }
  client = null;
  enabled = false;
}
