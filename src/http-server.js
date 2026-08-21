import http from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createHandler, sessionStartProperties } from './mcp-handler.js';
import { SERVER_VERSION } from './server.js';
import { runWithRequest } from './request-context.js';
import { resolveRequestToken } from './request-token.js';
import { initTelemetry, capture, shutdownTelemetry } from './telemetry.js';
import { primeFreeTier } from './free-tier.js';

// Initialize PostHog once for the lifetime of the HTTP server (multi-tenant:
// each request is attributed to its own bearer token inside the tool handler).
initTelemetry('http');
primeFreeTier(); // fire-and-forget; the hint drops its numbers until it lands

/**
 * Remote transport — one `createMcpHandler` serving both protocol eras.
 *
 * Modern (protocol revision 2026-07-28) is stateless by construction: there is
 * no `initialize` handshake and no `Mcp-Session-Id`, so every request is
 * answered by a fresh server built from the factory below. Legacy 2025-era
 * clients are still served, via the handler's built-in `legacy: 'stateless'`
 * posture — the same factory, one instance per request, no session table. GET
 * and DELETE were session operations, so under stateless serving the handler
 * answers them 405.
 *
 * That is why `session-store.js` is gone rather than merely unused: with no
 * session id to key on there is nothing to store, and the idle-session reaper
 * it existed to provide (the OOM fix in #12) is moot when no state outlives a
 * request.
 *
 * Auth inherits the CLI model: each request carries `Authorization: Bearer
 * shumi_sk_*`, threaded to the upstream call through AsyncLocalStorage so
 * multiple users share one process safely. Server-side tiers/quota/x402 still
 * apply. (OAuth 2.1 metadata-discovery is the Phase-3 standards upgrade.)
 */

const PORT = Number(process.env.PORT || 8787);
const MCP_PATH = process.env.SHUMI_MCP_PATH || '/mcp';
// Lock down in production by listing allowed browser origins (comma-separated).
// Empty = permissive (non-browser MCP clients send no Origin).
const ALLOWED_ORIGINS = (process.env.SHUMI_MCP_ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Forward-compat OAuth (Phase 2). When an Authorization Server is configured
// (the thin Stytch-over-Dynamic AS), we advertise it per RFC 9728 so connector
// clients (Claude Desktop/web, ChatGPT) can discover it. Until then this is
// dormant and the server runs on Bearer `shumi_sk_*` only — no behavior change.
const AUTH_SERVER = process.env.SHUMI_MCP_AUTH_SERVER || '';
const PUBLIC_URL = (process.env.SHUMI_MCP_PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, '');

function protectedResourceMetadata() {
  return { resource: `${PUBLIC_URL}${MCP_PATH}`, authorization_servers: [AUTH_SERVER] };
}

// One handler for both eras (see mcp-handler.js for the era rules).
const mcpHandler = createHandler({
  onerror: (err) => process.stderr.write(`shumi-mcp(mcp): ${err?.stack || err}\n`),
});
const handleMcp = toNodeHandler(mcpHandler, {
  onerror: (err) => process.stderr.write(`shumi-mcp(adapter): ${err?.stack || err}\n`),
});

function originAllowed(origin) {
  if (!origin) return true; // non-browser clients omit Origin (DNS-rebinding N/A)
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
}


// The handler can read the body itself, but then nothing bounds it. Read it
// here to keep the 4 MB cap and hand the parsed value over as `parsedBody`.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 4 * 1024 * 1024) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * `mcp.session_started` for the HTTP transport.
 *
 * The `oninitialized` hook in server.js cannot serve this here: it hangs off
 * the `notifications/initialized` message, which under stateless serving is a
 * separate request answered by a different instance, so it never fires. The
 * event is captured at the transport edge instead, off the body we already
 * parse for the size cap. Which requests count as first contact — and what the
 * modern era does not tell us — is documented on sessionStartProperties().
 */
function captureSessionStart(body) {
  const props = sessionStartProperties(body, SERVER_VERSION);
  if (props) capture('mcp.session_started', props);
}

function writeJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function rpcError(res, status, message, id = null) {
  writeJson(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    return writeJson(res, 200, { ok: true, server: 'shumi-mcp', stateless: true });
  }

  // RFC 9728 Protected Resource Metadata — only advertised once an AS is set.
  if (AUTH_SERVER && url.pathname === '/.well-known/oauth-protected-resource') {
    return writeJson(res, 200, protectedResourceMetadata());
  }

  if (url.pathname !== MCP_PATH) {
    return rpcError(res, 404, 'Not found');
  }

  const token = resolveRequestToken(req, url);

  // When OAuth is enabled, an unauthenticated MCP request gets a spec-compliant
  // 401 pointing at the metadata document so clients can start the OAuth dance.
  if (AUTH_SERVER && !token) {
    res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    return rpcError(res, 401, 'Authentication required');
  }

  if (!originAllowed(req.headers.origin)) {
    return rpcError(res, 403, 'Origin not allowed');
  }

  try {
    const body = req.method === 'POST' ? await readJsonBody(req) : undefined;
    // Attribution needs the caller's token, so capture inside the context.
    return await runWithRequest({ token }, () => {
      captureSessionStart(body);
      return handleMcp(req, res, body);
    });
  } catch (err) {
    process.stderr.write(`shumi-mcp(http): ${err?.stack || err}\n`);
    if (!res.headersSent) rpcError(res, 500, 'Internal error');
  }
});

server.listen(PORT, () => {
  process.stderr.write(`shumi-mcp: stateless MCP server on http://localhost:${PORT}${MCP_PATH}\n`);
});

// Flush queued analytics on shutdown (Render sends SIGTERM on deploy/scale).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    server.close();
    await mcpHandler.close();
    await shutdownTelemetry();
    process.exit(0);
  });
}
