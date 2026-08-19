import { createMcpHandler } from '@modelcontextprotocol/server';
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
