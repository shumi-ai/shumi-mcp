# Changelog

All notable changes to `@shumi-ai/mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-08-19

First release on the current MCP protocol revision, and the first stateless one.
The version is 1.0.0 rather than a patch because session support is removed, not
merely deprecated — see Removed.

### Added
- **Protocol revision `2026-07-28`.** Served on both transports, alongside every
  older revision, from one server factory. Modern exchanges carry no
  `initialize` and no `Mcp-Session-Id`: routing rides in headers (`Mcp-Method`,
  plus `Mcp-Name` on `tools/call`) and the protocol envelope in `params._meta`,
  so an intermediary can route and meter a call without parsing the body.
- `server/discover`, the revision's replacement for the `initialize` handshake.
- `protocol_era` on `mcp.session_started`, making the client-side 2025 → 2026
  migration visible.
- `test/era-routing.test.js` — guards the era switching, where every failure mode
  is silent: a broken modern path just falls back to the legacy handshake.

### Changed
- MCP SDK v1 → v2 (`@modelcontextprotocol/server` + `/node`), and zod 3 → 4.
  zod 4 is required, not preferred: SDK v2 reads schemas through Standard
  Schema, and a zod-3 schema is accepted at registration and then fails the
  whole of `tools/list` — one bad schema would hide all 31 tools.
- The HTTP transport is stateless. Each request is answered by its own instance
  (p50 1.1 ms / p95 5.0 ms to build all 31 tools and 2 resources).
- stdio uses `serveStdio`, which pins one instance per connection — no
  per-request cost there.
- `GET /health` reports `stateless: true` instead of a live session count.
- `mcp.session_started` is captured at the HTTP transport edge. The
  `oninitialized` hook cannot fire under stateless serving, because the
  `notifications/initialized` message it hangs off arrives as a separate request
  on a different instance. On stdio the hook is unchanged.

### Removed
- The session store, its reaper, and `GET`/`DELETE /mcp`, which were session
  operations and now return `405`. Nothing outlives a request, so the OOM the
  reaper existed to prevent cannot occur.
- `SHUMI_MCP_SESSION_TTL_MS`, `SHUMI_MCP_MAX_SESSIONS` and
  `SHUMI_MCP_SESSION_SWEEP_MS`. Safe to delete from any deployment; unset they
  do nothing.

### Known gap
- A modern client MAY skip `server/discover`, and such a client is visible only
  through its tool calls. There is no session to hang a first-contact event on —
  that is the point of the revision, not an oversight.

## [0.1.0] – [0.1.3]

The pre-1.0 line. These entries accumulated across those four releases and were
never cut into per-version sections.

### Added
- Initial Shumi MCP server: 29 typed tools + `ask_shumi` / `search_web`, and the
  `shumi://capabilities` and `shumi://billing/tier` resources.
- Full parity with the `/api/cli` surface the CLI already covers: real-world assets
  (`list_rwa_assets`, `get_rwa_asset`), holder and wallet tracking (`get_holders`,
  `get_wallets`), futures signals (`get_futures_signals`), basket snapshots
  (`get_basket`), transcript highlights (`get_transcripts`), and market trend
  crossings (`get_market_crossing`). `walkforward` is intentionally left out until
  Engine B resumes — two of its three actions have no rows behind them.
- stdio transport (`bin/shumi-mcp.js`) and Streamable HTTP transport
  (`src/http-server.js`, MCP `2025-11-25`).
- Bearer-token auth (`SHUMI_TOKEN`), with server-side tier gating inherited from
  the coinrotator-ai `/api/cli` surface.
- Structured tool output: typed tools declare an output schema and return
  `structuredContent` alongside compact-JSON text.
- Conversion-grade auth/quota hints that point users to https://shumi.ai
  (free trial → Plus/Pro upgrade), in the product voice.
- Default cap on list-returning tools (raise/lower via `top`) to bound token use.
- Transient-5xx/network retry on typed GETs.
- Forward-compatible OAuth: env-gated RFC 9728 Protected Resource Metadata and a
  `401 + WWW-Authenticate` challenge on the HTTP transport (dormant until an
  authorization server is configured).
- Unit tests for the error map and tool route-building.
- Project hygiene: LICENSE, CI (Node 20/22), `mcpName`, `publishConfig`.
