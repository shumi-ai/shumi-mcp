import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createShumiServer } from './server.js';
import { runWithRequest } from './request-context.js';
import { initTelemetry, shutdownTelemetry } from './telemetry.js';
import { SessionStore, DEFAULT_TTL_MS, DEFAULT_MAX_SESSIONS, DEFAULT_SWEEP_MS } from './session-store.js';

// Initialize PostHog once for the lifetime of the HTTP server (multi-tenant:
// each request is attributed to its own bearer token inside the tool handler).
initTelemetry('http');

/**
 * Remote transport — Streamable HTTP (MCP 2025-11-25), the current recommended
 * transport for hosted servers (the older HTTP+SSE transport is deprecated).
 *
 * Auth inherits the CLI model: each request carries `Authorization: Bearer
 * shumi_sk_*`, which we thread through to the upstream call via AsyncLocalStorage
 * so multiple users share one process safely. Server-side tiers/quota/x402 still
 * apply. (OAuth 2.1 metadata-discovery is the Phase-3 standards upgrade.)
 *
 * Stateful: one transport + McpServer per session, keyed by Mcp-Session-Id.
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

// Bounded sessionId -> transport store. Idle sessions are reaped on a timer so
// liveness probes that `initialize` but never DELETE cannot leak the heap to an
// OOM (see session-store.js). Tunables via env, sensible defaults otherwise.
const SESSION_TTL_MS = Number(process.env.SHUMI_MCP_SESSION_TTL_MS) || DEFAULT_TTL_MS;
const MAX_SESSIONS = Number(process.env.SHUMI_MCP_MAX_SESSIONS) || DEFAULT_MAX_SESSIONS;
const SESSION_SWEEP_MS = Number(process.env.SHUMI_MCP_SESSION_SWEEP_MS) || DEFAULT_SWEEP_MS;
const transports = new SessionStore({ ttlMs: SESSION_TTL_MS, maxSessions: MAX_SESSIONS });

function originAllowed(origin) {
  if (!origin) return true; // non-browser clients omit Origin (DNS-rebinding N/A)
  if (ALLOWED_ORIGINS.length === 0) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

function bearerToken(req) {
  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

// Smithery-hosted containers receive the user's session config as a base64-JSON
// `config` query param (or flat query params), not an Authorization header. Map
// the configured key to our bearer token so the SAME server works whether it's
// our Render deploy (header auth) or Smithery-hosted (config injection).
function tokenFromConfig(url) {
  const cfg = url.searchParams.get('config');
  if (cfg) {
    try {
      const obj = JSON.parse(Buffer.from(cfg, 'base64').toString('utf8'));
      const t = obj.shumiToken || obj.apiKey || obj.token || obj.SHUMI_TOKEN;
      if (t) return String(t);
    } catch {
      /* ignore malformed config */
    }
  }
  return url.searchParams.get('shumiToken') || url.searchParams.get('api_key') || null;
}

function resolveRequestToken(req, url) {
  return bearerToken(req) || tokenFromConfig(url);
}

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
    return writeJson(res, 200, { ok: true, server: 'shumi-mcp', sessions: transports.size });
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

  const sessionId = req.headers['mcp-session-id'];

  try {
    // GET (SSE stream) and DELETE (session teardown) require an existing session.
    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId && transports.get(sessionId);
      if (!transport) return rpcError(res, 400, 'Unknown or missing session');
      return runWithRequest({ token }, () => transport.handleRequest(req, res));
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'GET, POST, DELETE' });
      return res.end();
    }

    const body = await readJsonBody(req);

    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (!isInitializeRequest(body)) {
        return rpcError(res, 400, 'No valid session; send an initialize request first');
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) transports.delete(transport.sessionId);
      };
      const mcp = createShumiServer();
      await mcp.connect(transport);
    }

    return runWithRequest({ token }, () => transport.handleRequest(req, res, body));
  } catch (err) {
    process.stderr.write(`shumi-mcp(http): ${err?.stack || err}\n`);
    if (!res.headersSent) rpcError(res, 500, 'Internal error');
  }
});

server.listen(PORT, () => {
  process.stderr.write(`shumi-mcp: Streamable HTTP server on http://localhost:${PORT}${MCP_PATH}\n`);
});

// Reap idle sessions so probe traffic can't grow the heap unbounded.
transports.startReaper(SESSION_SWEEP_MS, (reaped) => {
  process.stderr.write(`shumi-mcp: reaped ${reaped} idle session(s), ${transports.size} active\n`);
});

// Flush queued analytics on shutdown (Render sends SIGTERM on deploy/scale).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    transports.stopReaper();
    server.close();
    await shutdownTelemetry();
    process.exit(0);
  });
}
