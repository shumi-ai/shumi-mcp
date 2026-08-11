# Changelog

All notable changes to `@shumi-ai/mcp` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
