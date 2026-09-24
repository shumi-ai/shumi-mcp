import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End to end through the registered scan_coins handler and the real HTTP client, with only
 * fetch stubbed. /api/cli/scan refuses `exchange` on purpose (coinrotator-ai eaca92dd): its
 * venue data is spot tickers only, so a filtered list would be a misleading answer. 1.2.0 sent
 * `exchanges`, which skipped that refusal. This pins the wire name and that the server's
 * message reaches the host as the tool error.
 *
 * Hermetic like http-client.test.js: HOME is an empty temp dir before any src import.
 */
process.env.HOME = mkdtempSync(join(tmpdir(), 'shumi-mcp-scan-'));
delete process.env.SHUMI_TOKEN;
delete process.env.SHUMI_WALLET;

const { registerTools } = await import('../src/tools/index.js');
const { runWithRequest } = await import('../src/request-context.js');

const REFUSAL =
  'The exchange filter is not available on scan yet. Filter the returned coins with `shumi coin risk` or the funding routes instead.';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function scanHandler() {
  let handler;
  registerTools({
    registerTool(name, _config, fn) {
      if (name === 'scan_coins') handler = fn;
    },
  });
  return handler;
}

test('scan_coins sends exchange as `exchange` and returns the server refusal as the tool error', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    return new Response(JSON.stringify({ schemaVersion: 1, error: { code: 'BAD_REQUEST', message: REFUSAL } }), { status: 400 });
  };
  const result = await runWithRequest({ token: 'tok_test' }, () => scanHandler()({ exchange: 'Hyperliquid', trend: 'UP' }));

  const scanCalls = urls.filter((u) => u.pathname.endsWith('/scan'));
  assert.equal(scanCalls.length, 1);
  assert.equal(scanCalls[0].searchParams.get('exchange'), 'Hyperliquid');
  assert.equal(scanCalls[0].searchParams.has('exchanges'), false);

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.code, 'BAD_REQUEST');
  assert.equal(payload.error.message, REFUSAL);
});

test('a category scan still reaches the server as `categories`, unchanged', async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(new URL(String(url)));
    return new Response(JSON.stringify({ schemaVersion: 1, data: ['Dogecoin'] }), { status: 200 });
  };
  const result = await runWithRequest({ token: 'tok_test' }, () => scanHandler()({ category: 'meme' }));

  const scan = urls.find((u) => u.pathname.endsWith('/scan'));
  assert.equal(scan.searchParams.get('categories'), 'meme');
  assert.equal(scan.searchParams.has('exchange'), false);
  assert.notEqual(result.isError, true);
});
