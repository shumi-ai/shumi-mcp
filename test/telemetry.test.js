import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTelemetry, isEnabled, capture, captureError, identifySession, shutdownTelemetry } from '../src/telemetry.js';
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server';
import { createShumiServer } from '../src/server.js';
import { sessionStartProperties } from '../src/mcp-handler.js';

// The suite runs with SHUMI_TELEMETRY=0 (see package.json), so every public
// entry point must be a safe no-op — telemetry must never throw or emit here.

test('telemetry is disabled under SHUMI_TELEMETRY=0', () => {
  initTelemetry('stdio');
  assert.equal(isEnabled(), false);
});

test('all telemetry entry points are no-op safe when disabled', async () => {
  initTelemetry('stdio');
  capture('mcp.session_started', { client_name: 'test' });
  captureError(new Error('boom'), { tool_name: 'test' });
  identifySession();
  await shutdownTelemetry();
});

test('createShumiServer wires the session_started initialize hook', () => {
  const server = createShumiServer();
  assert.equal(typeof server.server.oninitialized, 'function');
  // Firing it before initialization (no clientInfo yet) must not throw.
  server.server.oninitialized();
});

// --- first-contact detection, both protocol eras -----------------------------
// The initialize hook in server.js only fires on stdio. Over HTTP the event is
// derived from the request body instead, so that derivation needs its own test:
// a wrong shape here would not throw, it would just stop reporting who connects.

test('legacy initialize is recognised as first contact', () => {
  const props = sessionStartProperties(
    { method: 'initialize', params: { protocolVersion: '2025-11-25', clientInfo: { name: 'Claude Desktop', version: '1.2.3' } } },
    '0.1.3',
  );
  assert.deepEqual(props, {
    client_name: 'Claude Desktop',
    client_version: '1.2.3',
    server_version: '0.1.3',
    protocol_era: 'legacy',
  });
});

test('modern server/discover is recognised, with clientInfo out of the _meta envelope', () => {
  const props = sessionStartProperties(
    { method: 'server/discover', params: { _meta: { [CLIENT_INFO_META_KEY]: { name: 'Cursor', version: '4.0' } } } },
    '0.1.3',
  );
  assert.deepEqual(props, {
    client_name: 'Cursor',
    client_version: '4.0',
    server_version: '0.1.3',
    protocol_era: 'modern',
  });
});

test('ordinary traffic is not first contact', () => {
  for (const body of [
    { method: 'tools/list', params: {} },
    { method: 'tools/call', params: { name: 'lookup_coin' } },
    undefined,
    null,
    {},
  ]) {
    assert.equal(sessionStartProperties(body, '0.1.3'), null);
  }
});

test('a first-contact request without clientInfo still reports, with blanks', () => {
  const props = sessionStartProperties({ method: 'initialize', params: {} }, '0.1.3');
  assert.equal(props.protocol_era, 'legacy');
  assert.equal(props.client_name, undefined);
  assert.equal(props.server_version, '0.1.3');
});

// --- error-tracking contract (epic posthog-error-tracking) -------------------

test('before_send fills the contract on autocaptured exceptions', async () => {
  const { withErrorContract } = await import('../src/telemetry.js');
  const ev = withErrorContract({
    event: '$exception',
    properties: { $exception_list: [{ type: 'Error', mechanism: { type: 'onuncaughtexception', handled: false } }] },
  });
  assert.equal(ev.properties.surface, 'mcp');
  assert.equal(ev.properties.severity, 'error');
  assert.ok(['production', 'development', 'preview'].includes(ev.properties.release_stage));
  assert.equal(typeof ev.properties.app_version, 'string');
  assert.equal(ev.properties.handled, false);
});

test('before_send keeps explicit captureError values and ignores other events', async () => {
  const { withErrorContract } = await import('../src/telemetry.js');
  const ev = withErrorContract({
    event: '$exception',
    properties: { severity: 'warning', handled: true, tool_name: 'x', $exception_list: [{ mechanism: { handled: true } }] },
  });
  assert.equal(ev.properties.severity, 'warning');
  assert.equal(ev.properties.handled, true);
  assert.equal(ev.properties.tool_name, 'x');
  const other = { event: 'mcp.tool_called', properties: { a: 1 } };
  assert.deepEqual(withErrorContract(other), { event: 'mcp.tool_called', properties: { a: 1 } });
  assert.doesNotThrow(() => withErrorContract(null));
});

test('release stage: Render prod / Render preview / npm install / checkout', async () => {
  const { resolveReleaseStage } = await import('../src/telemetry.js');
  assert.equal(resolveReleaseStage({ RENDER: 'true' }), 'production');
  assert.equal(resolveReleaseStage({ RENDER: 'true', IS_PULL_REQUEST: 'true' }), 'preview');
  assert.equal(resolveReleaseStage({}, 'file:///Users/x/.npm/_npx/abc/node_modules/shumi-mcp/src/telemetry.js'), 'production');
  assert.equal(resolveReleaseStage({}, 'file:///Users/x/code/shumi-mcp/src/telemetry.js'), 'development');
});
