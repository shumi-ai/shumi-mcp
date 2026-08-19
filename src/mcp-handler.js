import { createMcpHandler, CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { createShumiServer } from './server.js';

/**
 * The dual-era MCP handler, separated from the HTTP wiring so the era routing
 * can be tested without binding a port.
 *
 * One handler serves both protocol revisions from ONE factory:
 *
 * - Modern (2026-07-28) — stateless. No `initialize`, no `Mcp-Session-Id`.
 *   The request's own headers carry the routing information (`Mcp-Method`, and
 *   `Mcp-Name` for `tools/call`), so an intermediary can route and meter a call
 *   without parsing the JSON body.
 * - Legacy (2025) — `legacy: 'stateless'`, the handler's default. Old clients
 *   keep their `initialize` handshake, but each exchange gets its own instance
 *   instead of a session. GET and DELETE were session operations and are
 *   answered 405.
 *
 * The factory runs per request. Building all 31 tools and 2 resources measures
 * p50 1.1 ms / p95 5.0 ms on an M-series laptop — real, but small next to the
 * upstream coinrotator-ai call every tool makes, and the price of holding no
 * cross-request state at all.
 */
export function createHandler({ onerror } = {}) {
  return createMcpHandler(() => createShumiServer(), { legacy: 'stateless', onerror });
}

/**
 * The properties for an `mcp.session_started` event, or null when this request
 * is not a first contact.
 *
 * Both eras announce themselves in a first, distinguishable request:
 *   - legacy — `initialize`, with `params.clientInfo`
 *   - modern — `server/discover`, with clientInfo in the `_meta` envelope
 *
 * Known gap, stated rather than papered over: a modern client MAY skip
 * `server/discover` (the spec makes it optional for clients), and such a client
 * is then only visible through its tool calls. There is no session to hang a
 * first-contact event on — which is the point of the revision.
 *
 * Pure, so the shape handling is testable without emitting anything.
 */
export function sessionStartProperties(body, serverVersion) {
  const method = body?.method;
  if (method !== 'initialize' && method !== 'server/discover') return null;
  const params = body.params || {};
  const clientInfo = params.clientInfo || params._meta?.[CLIENT_INFO_META_KEY] || {};
  return {
    client_name: clientInfo.name,
    client_version: clientInfo.version,
    server_version: serverVersion,
    protocol_era: method === 'initialize' ? 'legacy' : 'modern',
  };
}
