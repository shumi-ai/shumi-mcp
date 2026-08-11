# @shumi-ai/mcp

Shumi crypto trade-intelligence as an [MCP](https://modelcontextprotocol.io) server — the same
market intelligence the [`shumi` CLI](https://www.npmjs.com/package/shumi) provides, for any MCP
client (Claude Desktop, Claude Code, Cursor, agents).

It's a thin wrapper over Shumi's data API: prices, trends, funding rates, sentiment, narratives,
market regime, synthesized signals, pair / delta-neutral ideas, real-world assets, holder and
wallet tracking, and transcript highlights. All tools are read-only.

## Quick start

You need a Shumi API key (`shumi_sk_…`). Create one at <https://shumi.ai>.

### Claude Desktop / Claude Code

Add to your MCP config (`claude_desktop_config.json`, or `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "shumi": {
      "command": "npx",
      "args": ["-y", "@shumi-ai/mcp"],
      "env": {
        "SHUMI_TOKEN": "shumi_sk_your_key_here"
      }
    }
  }
}
```

Restart the client. The `shumi` tools (e.g. `get_coin_risk`, `get_market_health`, `ask_shumi`)
appear automatically.

### Cursor

`~/.cursor/mcp.json` uses the same `command` / `args` / `env` shape as above.

## Tools

**Typed (deterministic):** `get_coin_risk`, `lookup_coin`, `resolve_coin`, `get_coin_sentiment`,
`get_coin_historical`, `get_market_health`, `get_market_crossing`, `get_global_market`,
`get_prices`, `scan_trends`, `scan_coins`, `get_market_sentiment`, `list_narratives`,
`get_narrative`, `list_categories`, `get_category`, `get_funding_momentum`, `get_funding_alerts`,
`get_regime`, `get_signal`, `get_signal_quality`, `get_pair_suggestions`, `list_rwa_assets`,
`get_rwa_asset`, `get_holders`, `get_wallets`, `get_futures_signals`, `get_basket`,
`get_transcripts`.

**Real-world assets** (`list_rwa_assets`, `get_rwa_asset`) cover stocks, ETFs, commodities,
indices and FX trading as perps on Hyperliquid builder DEXes. They are not crypto tokens — the
coin tools will not find them.

**Free-form:** `ask_shumi` (natural-language questions — Shumi classifies, fetches, and synthesizes)
and `search_web`.

List-returning tools accept `top` (keep first N items) and `fields` (comma-separated keys to keep)
to save tokens.

**Resources:** `shumi://capabilities` (the data surface) and `shumi://billing/tier` (your current
entitlement).

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `SHUMI_TOKEN` | — | API key (`shumi_sk_*`). **Required.** |
| `SHUMI_API_URL` | production coinrotator-ai endpoint | Override the API base URL. |
| `SHUMI_WALLET` | — | Wallet address to include in NLP query context. |

Gating (free / access / pro tiers and pay-per-call) is enforced server-side, exactly as for the CLI —
out-of-quota responses come back as a structured error with an actionable hint.

## Remote (Streamable HTTP)

For a hosted, multi-user deployment, run the Streamable HTTP transport (MCP `2025-11-25`):

```bash
PORT=8787 SHUMI_MCP_ALLOWED_ORIGINS=https://yourapp.com npm run start:http
```

Each request authenticates with its own `Authorization: Bearer shumi_sk_*` header; that token is
forwarded to the upstream API per request. Endpoint: `POST/GET/DELETE /mcp`, health: `GET /health`.

## Develop

```bash
npm install
npm test                # unit tests (no network)
npm run inspect         # open the MCP Inspector against the stdio server
SHUMI_TOKEN=… npm start # run the stdio server
```

## Not included in v1

`holders` / `wallets` movement tracking, transcripts, walkforward, futures, basket, and live
streaming (`watch`). These are available in the CLI today; open an issue if you need them via MCP.
