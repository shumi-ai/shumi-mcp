import { createHash } from 'node:crypto';
import { PostHog } from 'posthog-node';
import { getToken, getDeviceId } from './config.js';

/**
 * PostHog product analytics for the Shumi MCP server. Mirrors the canonical
 * setup used across every Shumi surface (CLI, web, hub): all events go to the
 * managed reverse proxy at t.shumi.ai so one project sees the whole funnel.
 *
 * Telemetry is strictly fire-and-forget: a failure here must NEVER crash, slow,
 * or alter a tool call. Disabled (safe no-op) when SHUMI_TELEMETRY is off or no
 * key resolves — tests run with SHUMI_TELEMETRY=0 so they never emit.
 *
 * distinct_id is a hash of the caller's bearer token (per-user, pseudonymous,
 * never the secret itself), so the multi-tenant HTTP transport attributes each
 * request to its own key; stdio falls back to the machine fingerprint.
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
    // Long-running server: batch sends, rely on graceful-shutdown flush.
    client = new PostHog(key, { host, flushAt: 20, flushInterval: 10_000 });
    enabled = true;
  } catch {
    enabled = false;
  }
}

export function isEnabled() {
  return enabled;
}

/** Pseudonymous per-caller id: hash(token) when present, else machine id. */
function distinctId() {
  try {
    const token = getToken();
    if (token) return `shumi_key_${createHash('sha256').update(token).digest('hex').slice(0, 24)}`;
  } catch {
    /* fall through */
  }
  try {
    return `device_${getDeviceId()}`;
  } catch {
    return 'anonymous';
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
