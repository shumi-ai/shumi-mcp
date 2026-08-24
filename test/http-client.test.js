import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The HTTP client is the auth gate and the retry policy in one file, and until
 * now had no tests at all: a regression in authHeaderOrThrow would silently let
 * unauthenticated calls through to the server (or lock authenticated ones out),
 * and a regression in the retry loop turns every Render cold-start into a tool
 * error shown to an agent.
 *
 * Hermetic on purpose: HOME points at an empty temp dir BEFORE any src import,
 * so a real ~/.shumi/config.json on a developer machine cannot leak a token
 * into the "unauthenticated" tests. config.js resolves its paths at module
 * load, which is why these imports are dynamic and come after.
 */
process.env.HOME = mkdtempSync(join(tmpdir(), 'shumi-mcp-http-'));
delete process.env.SHUMI_TOKEN;
delete process.env.SHUMI_WALLET;

const { apiGet, askQuery, ApiError } = await import('../src/http-client.js');
const { API_URL } = await import('../src/config.js');
const { runWithRequest } = await import('../src/request-context.js');
const { __internal } = await import('../src/free-tier.js');

const realFetch = globalThis.fetch;
let calls = [];
function stubFetch(impl) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    const n = calls.push({ url: String(url), init });
    return impl(n, String(url), init);
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const withToken = (fn) => runWithRequest({ token: 'tok_test' }, fn);

afterEach(() => {
  globalThis.fetch = realFetch;
  __internal.reset();
});

test('apiGet without a token fails closed with AUTH_REQUIRED before any network call', async () => {
  // Prime the free-tier figure via the seam so authHint does not fire a real
  // manifest fetch, and so the hint carries the server's number — this is the
  // exact path that quoted a hardcoded wrong allowance in production 2026-08-20.
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  stubFetch(() => {
    throw new Error('must not reach the network without a token');
  });
  await assert.rejects(apiGet('coin/lookup', { symbol: 'BTC' }), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 401);
    assert.equal(err.body.error.code, 'AUTH_REQUIRED');
    assert.match(err.body.error.hint, /10 queries free, then 1 more a day/);
    return true;
  });
  assert.equal(calls.length, 0, 'the request must be refused locally, not sent unauthenticated');
});

test('apiGet sends the per-request bearer token and joins the route onto API_URL', async () => {
  stubFetch(() => json({ data: { ok: 1 } }));
  // Leading slash must not produce a double slash in the URL.
  const body = await withToken(() => apiGet('/coin/lookup', { symbol: 'BTC' }));
  assert.deepEqual(body, { data: { ok: 1 } });
  assert.equal(calls[0].url, `${API_URL}/coin/lookup?symbol=BTC`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok_test');
});

test('query params: undefined/null/false/empty are dropped, 0 and strings survive', async () => {
  stubFetch(() => json({ data: [] }));
  await withToken(() => apiGet('trends', { a: undefined, b: null, c: false, d: '', limit: 0, interval: '4h' }));
  const url = new URL(calls[0].url);
  // 0 is a real value (limit=0, offset=0), not an absent one — dropping it
  // would silently turn an explicit request into the server default.
  assert.equal(url.search, '?limit=0&interval=4h');
});

test('apiGet retries transient 5xx and returns the eventual success', async () => {
  stubFetch((n) => (n < 3 ? json({ error: { message: 'cold start' } }, 503) : json({ data: { ok: true } })));
  const body = await withToken(() => apiGet('regime'));
  assert.deepEqual(body, { data: { ok: true } });
  assert.equal(calls.length, 3);
});

test('a 4xx is surfaced immediately — client errors must not be retried', async () => {
  // Retrying a 402 would burn the caller's quota checks three times over and
  // triple the latency of every gating response.
  stubFetch(() => json({ error: { code: 'PAYMENT_REQUIRED', message: 'out of credits' } }, 402));
  await assert.rejects(withToken(() => apiGet('regime')), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 402);
    assert.equal(err.message, 'out of credits');
    return true;
  });
  assert.equal(calls.length, 1);
});

test('an upstream that never recovers yields the last 5xx, not a hang', async () => {
  stubFetch(() => json({ error: { message: 'still down' } }, 503));
  await assert.rejects(withToken(() => apiGet('regime')), (err) => {
    assert.equal(err.status, 503);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('network failures are retried, then surfaced as a NETWORK ApiError', async () => {
  stubFetch(() => Promise.reject(new Error('ECONNRESET')));
  await assert.rejects(withToken(() => apiGet('regime')), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 0);
    assert.equal(err.body.error.code, 'NETWORK');
    assert.match(err.message, /ECONNRESET/);
    return true;
  });
  assert.equal(calls.length, 3);
});

test('a non-JSON error body is wrapped as INTERNAL, not thrown as a parse error', async () => {
  // Render error pages and proxies return HTML; the agent must see an ApiError
  // with the text, not a SyntaxError from JSON.parse.
  stubFetch(() => new Response('<html>bad gateway</html>', { status: 500 }));
  await assert.rejects(withToken(() => apiGet('regime')), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 500);
    assert.equal(err.body.error.code, 'INTERNAL');
    assert.equal(err.message, '<html>bad gateway</html>');
    return true;
  });
});

test('an empty 200 body resolves to null rather than crashing the parse', async () => {
  stubFetch(() => new Response('', { status: 200 }));
  assert.equal(await withToken(() => apiGet('regime')), null);
});

test('askQuery marks the MCP surface and carries the device id', async () => {
  stubFetch(() => json({ text: 'answer' }));
  const res = await withToken(() => askQuery({ messages: [{ role: 'user', content: 'q' }] }));
  assert.deepEqual(res, { text: 'answer' });
  assert.equal(calls[0].url, API_URL);
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  // client:'mcp' is what lets the server apply its per-surface answerer model
  // (Strapi mcpModelId); dropping it silently reroutes MCP traffic to the web
  // model.
  assert.equal(body.client, 'mcp');
  assert.equal(body.archetype, 'base');
  assert.equal(body.raw, false);
  assert.match(body.deviceId, /^[0-9a-f]{24}$/);
  assert.ok(!('walletAddress' in body), 'no wallet configured, none may be sent');
  assert.ok(!('commandContext' in body));
});

test('askQuery forwards the wallet only when one is configured', async () => {
  stubFetch(() => json({ text: 'ok' }));
  process.env.SHUMI_WALLET = '0xabc';
  try {
    await withToken(() => askQuery({ messages: [] }));
  } finally {
    delete process.env.SHUMI_WALLET;
  }
  assert.equal(JSON.parse(calls[0].init.body).walletAddress, '0xabc');
});

test('askQuery surfaces a non-2xx as ApiError with the server message', async () => {
  stubFetch(() => json({ error: { message: 'slow down' } }, 429));
  await assert.rejects(withToken(() => askQuery({ messages: [] })), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    assert.equal(err.message, 'slow down');
    return true;
  });
});
