import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { apiGet } from './http-client.js';
import { errorPayload } from './errorMap.js';
import { registerTools, toolCatalog } from './tools/index.js';
import { instrumentToolCalls } from './telemetry.js';

export const SERVER_NAME = 'shumi';

// Read rather than hardcode. This constant is what every client sees in the
// initialize handshake, and as a literal it went stale immediately: the live
// server was still announcing 0.1.0 while the package was on 0.1.2. It is the
// version a user would quote in a bug report, so it is the worst of the five
// places to let drift. npm always ships package.json in the tarball, so this
// resolves for an installed package as well as from a checkout.
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

/**
 * Build a fully-configured Shumi MCP server. Transport-agnostic: the same
 * server is wired to stdio (bin/shumi-mcp.js) or Streamable HTTP
 * (src/http-server.js). All tools/resources are registered here exactly once.
 */
export function createShumiServer() {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'Shumi exposes crypto trade-intelligence (prices, trends, funding rates, sentiment, narratives, regime, signals, pair/delta-neutral ideas) over the same data surface as the shumi CLI. Prefer the specific typed tools (get_coin_risk, get_market_health, scan_trends, …) for deterministic data; use ask_shumi for free-form or multi-part questions. All tools are read-only.',
    },
  );

  // Wrap tool handlers with PostHog instrumentation before registering them
  // (no-op when telemetry is disabled). Must run before registerTools.
  instrumentToolCalls(server);
  registerTools(server);
  registerResources(server);

  return server;
}

function registerResources(server) {
  // Describes the data surface in one place (the tools themselves are also
  // discoverable via tools/list — this is a human/agent-friendly overview).
  server.registerResource(
    'capabilities',
    'shumi://capabilities',
    {
      title: 'Shumi capabilities',
      description: 'The Shumi data surface: every tool this server exposes, grouped by typed vs free-form.',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ server: SERVER_NAME, version: SERVER_VERSION, tools: toolCatalog() }, null, 2),
        },
      ],
    }),
  );

  // Current entitlement for the authenticated token (tier / source / expiry).
  server.registerResource(
    'billing-tier',
    'shumi://billing/tier',
    {
      title: 'Billing tier',
      description: 'The current Shumi entitlement (tier, source, expiry) for the authenticated token.',
      mimeType: 'application/json',
    },
    async (uri) => {
      let payload;
      try {
        const env = await apiGet('billing/tier');
        payload = env && typeof env === 'object' && 'data' in env ? env.data : env;
      } catch (err) {
        payload = errorPayload(err);
      }
      return {
        contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }],
      };
    },
  );
}
