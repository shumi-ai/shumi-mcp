import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';

// Render sends SIGTERM on deploy/scale. If it lands while the crash handler is
// flushing to PostHog, the process must still exit 1, not the graceful 0.

const serverPath = new URL('../src/http-server.js', import.meta.url).pathname;

async function runServer({ crash }) {
  // A PostHog host that accepts and never answers, so a crash flush hangs.
  const sink = net.createServer(() => {}).listen(0, '127.0.0.1');
  await new Promise((r) => sink.once('listening', r));
  // The crash handler sets exitCode = 1 before it starts flushing (telemetry.js).
  // Simulate a crash that is mid-flush when SIGTERM lands: exitCode is already 1.
  const preload = crash ? `data:text/javascript,process.exitCode = 1;` : null;
  const args = [...(preload ? ['--import', preload] : []), serverPath];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      PORT: '0',
      SHUMI_TELEMETRY: '1',
      POSTHOG_API_KEY: 'phc_test',
      POSTHOG_HOST: `http://127.0.0.1:${sink.address().port}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((r) => child.on('exit', (c, s) => r(c ?? s)));
  let stderr = '';
  // Signal only once the server is listening: its SIGTERM handler is registered
  // by then. A fixed delay races slow CI runners and hits Node's default kill.
  const ready = new Promise((resolve) => {
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.includes('stateless MCP server on')) resolve();
    });
  });
  // Never hang the suite: SIGKILL after 10s whatever happens.
  const guard = setTimeout(() => child.kill('SIGKILL'), 10_000);
  await Promise.race([ready, exited]);
  child.kill('SIGTERM');
  const code = await exited;
  clearTimeout(guard);
  sink.close();
  return { code, stderr };
}

test('SIGTERM during a crash flush still exits 1', async () => {
  const { code, stderr } = await runServer({ crash: true });
  assert.equal(code, 1, stderr);
});

test('a plain SIGTERM still exits 0', async () => {
  const { code, stderr } = await runServer({ crash: false });
  assert.equal(code, 0, stderr);
});
