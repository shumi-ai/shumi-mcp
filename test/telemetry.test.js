import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initTelemetry, isEnabled, capture, captureError, identifySession, shutdownTelemetry } from '../src/telemetry.js';
import { createShumiServer } from '../src/server.js';

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
