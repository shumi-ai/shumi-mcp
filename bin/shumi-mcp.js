#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createShumiServer } from '../src/server.js';
import { initTelemetry, identifySession, shutdownTelemetry } from '../src/telemetry.js';

/**
 * stdio entry point — the default. Run locally via `npx -y @shumi-ai/mcp`.
 * Auth comes from the SHUMI_TOKEN env var (or a prior `shumi login`).
 *
 * `serveStdio` owns the era decision: the opening exchange picks modern
 * (protocol revision 2026-07-28) or legacy 2025, one instance from the factory
 * is pinned for the connection, and everything after flows to it. Both eras get
 * the same tools because both come from the same factory — which is why this is
 * a factory now and not a single pre-built server.
 *
 * `legacy: 'serve'` is the default and is what we want: rejecting 2025 openings
 * would drop every MCP client that has not shipped the new revision yet.
 *
 * Nothing must be written to stdout except MCP protocol frames; diagnostics go
 * to stderr.
 */
function main() {
  initTelemetry('stdio');
  identifySession();
  const handle = serveStdio(() => createShumiServer(), {
    legacy: 'serve',
    onerror: (err) => process.stderr.write(`shumi-mcp: ${err?.stack || err}\n`),
  });
  process.stderr.write('shumi-mcp: stdio server ready\n');

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, async () => {
      await handle.close();
      await shutdownTelemetry();
      process.exit(0);
    });
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`shumi-mcp: fatal: ${err?.stack || err}\n`);
  process.exit(1);
}
