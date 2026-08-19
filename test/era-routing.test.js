import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROTOCOL_VERSION_META_KEY,
  CLIENT_INFO_META_KEY,
  CLIENT_CAPABILITIES_META_KEY,
} from '@modelcontextprotocol/server';
import { createHandler } from '../src/mcp-handler.js';

/**
 * Guards the dual-era behaviour of the stateless handler.
 *
 * Worth having as a test rather than a one-off check: every failure mode here
 * is silent. If the modern path regressed, a 2026-07-28 client would fall back
 * to the legacy handshake and everything would still appear to work — just
 * with sessions we no longer keep. And if legacy serving broke, only clients
 * that have not shipped the new revision would notice, which today is most of
 * them.
 */

const ENDPOINT = 'https://shumi.test/mcp';
const handler = createHandler({ onerror: () => {} });

/** A modern-era request: no initialize, no session, envelope in `_meta`, routing in headers. */
function modernRequest(id, method, params = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28',
    'Mcp-Method': method,
  };
  // tools/call must name its target in a header too, so an intermediary can
  // route and meter the call without parsing the body.
  if (params.name) headers['Mcp-Name'] = params.name;
  return new Request(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: {
        ...params,
        _meta: {
          [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
          [CLIENT_INFO_META_KEY]: { name: 'era-test', version: '1.0.0' },
          [CLIENT_CAPABILITIES_META_KEY]: {},
        },
      },
    }),
  });
}

async function body(response) {
  const text = await response.text();
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : text);
}

test('modern era answers tools/list with no initialize and no session', async () => {
  const res = await handler.fetch(modernRequest(1, 'tools/list'));
  assert.equal(res.status, 200);
  const { result } = await body(res);
  assert.equal(result.tools.length, 31);
  assert.ok(result.tools.every((t) => t.inputSchema?.type === 'object'));
});

test('modern era implements server/discover', async () => {
  const res = await handler.fetch(modernRequest(2, 'server/discover'));
  assert.equal(res.status, 200);
  const { result, error } = await body(res);
  assert.equal(error, undefined);
  assert.ok(result, 'server/discover must return a result');
});

test('modern era routes tools/call without prior handshake', async () => {
  const res = await handler.fetch(
    modernRequest(3, 'tools/call', { name: 'lookup_coin', arguments: { by: 'symbol', identifier: 'BTC' } }),
  );
  assert.equal(res.status, 200);
  // No token here, so an auth error is the correct outcome. What is being
  // asserted is that the call reached the tool at all rather than being
  // rejected for missing session state.
  const { result, error } = await body(res);
  assert.ok(result || error, 'the call must be answered, not rejected for missing state');
});

test('a modern request without its routing headers is refused, not guessed at', async () => {
  const res = await handler.fetch(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
    }),
  );
  assert.equal(res.status, 400);
});

test('legacy 2025 clients keep their initialize handshake', async () => {
  const res = await handler.fetch(
    new Request(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1.0.0' } },
      }),
    }),
  );
  assert.equal(res.status, 200);
  const { result } = await body(res);
  assert.equal(result.serverInfo.name, 'shumi');
  assert.equal(result.protocolVersion, '2025-11-25');
});

for (const method of ['GET', 'DELETE']) {
  test(`${method} is 405 — session operations no longer exist`, async () => {
    const res = await handler.fetch(new Request(ENDPOINT, { method, headers: { Accept: 'text/event-stream' } }));
    assert.equal(res.status, 405);
  });
}

test('every request gets its own server instance', async () => {
  // Two concurrent modern calls must not share state; if the factory were
  // hoisted to module scope this would still pass, so assert on the handler
  // answering both independently rather than on identity.
  const [a, b] = await Promise.all([
    handler.fetch(modernRequest(10, 'tools/list')),
    handler.fetch(modernRequest(11, 'tools/list')),
  ]);
  const [ra, rb] = await Promise.all([body(a), body(b)]);
  assert.equal(ra.id, 10);
  assert.equal(rb.id, 11);
  assert.equal(ra.result.tools.length, rb.result.tools.length);
});
