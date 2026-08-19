#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createShumiServer } from '../src/server.js';
import { initTelemetry, shutdownTelemetry } from '../src/telemetry.js';

/**
 * stdio entry point — the default. Run locally via `npx -y @shumi-ai/mcp`.
 * Auth comes from the SHUMI_TOKEN env var (or a prior `shumi login`).
 *
 * Nothing must be written to stdout except MCP protocol frames; diagnostics go
 * to stderr.
 */
async function main() {
  initTelemetry('stdio');
  const server = createShumiServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('shumi-mcp: stdio server ready\n');

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      await shutdownTelemetry();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  process.stderr.write(`shumi-mcp: fatal: ${err?.stack || err}\n`);
  process.exit(1);
});
