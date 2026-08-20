import { test } from 'node:test';
import assert from 'node:assert/strict';
import { primeFreeTier, freeTierPhrase, __internal } from '../src/free-tier.js';
import { errorPayload } from '../src/errorMap.js';
import { ApiError } from '../src/http-client.js';

/**
 * The numbers in the conversion hint are the first thing a new user reads, and
 * they were wrong in production: the hint promised "3 free queries" while the
 * gate granted 10 lifetime plus 1/day. Nothing failed — a wrong number is not an
 * exception — so only a test that compares against the server's own figure keeps
 * this honest.
 */

test('no numbers are invented before the manifest lands', () => {
  __internal.reset();
  assert.equal(freeTierPhrase(), null);
  const hint = errorPayload(new ApiError(401, {})).error.hint;
  assert.ok(hint.includes('Create a free Shumi key'));
  assert.ok(!/\d/.test(hint.replace('https://shumi.ai', '')), `hint must quote no allowance yet: ${hint}`);
});

test('the phrase is built from the manifest figures', () => {
  __internal.reset();
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  assert.equal(freeTierPhrase(), '10 queries free, then 1 more a day');
  assert.ok(errorPayload(new ApiError(401, {})).error.hint.includes('— 10 queries free, then 1 more a day.'));
});

test('singular and drip-only and grant-only shapes all read correctly', () => {
  __internal.reset(); __internal.set({ lifetime: 1, dailyDrip: 2 });
  assert.equal(freeTierPhrase(), '1 query free, then 2 more a day');
  __internal.set({ lifetime: 0, dailyDrip: 3 });
  assert.equal(freeTierPhrase(), '3 queries free a day');
  __internal.set({ lifetime: 5, dailyDrip: 0 });
  assert.equal(freeTierPhrase(), '5 queries free');
});

test('a broken or slow manifest leaves the hint number-free rather than wrong', async () => {
  __internal.reset();
  primeFreeTier({ fetchImpl: async () => { throw new Error('network down'); } });
  await new Promise((r) => setImmediate(r));
  assert.equal(freeTierPhrase(), null);

  __internal.reset();
  primeFreeTier({ fetchImpl: async () => ({ ok: true, json: async () => ({ auth: { freeTier: { lifetime: 'ten' } } }) }) });
  await new Promise((r) => setImmediate(r));
  assert.equal(freeTierPhrase(), null, 'non-numeric figures must be rejected, not stringified into the hint');
});

test('priming reads auth.freeTier from a manifest-shaped body', async () => {
  __internal.reset();
  let requested = null;
  primeFreeTier({
    fetchImpl: async (url) => { requested = url; return { ok: true, json: async () => ({ auth: { freeTier: { lifetime: 10, dailyDrip: 1 } } }) }; },
  });
  await new Promise((r) => setImmediate(r));
  assert.ok(String(requested).endsWith('/manifest'));
  assert.equal(freeTierPhrase(), '10 queries free, then 1 more a day');
});

test('a failed prime is retried later, but not on every error', async () => {
  __internal.reset();
  let calls = 0;
  let clock = 1_000_000;
  const opts = { fetchImpl: async () => { calls++; throw new Error('manifest down'); }, now: () => clock };

  primeFreeTier(opts);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);

  // Immediately after a failure: backed off, no second request.
  primeFreeTier(opts);
  primeFreeTier(opts);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1, 'a down manifest must not be hammered once per error');

  // Past the backoff window it tries again — a boot-time outage must not latch
  // for the life of a long-running HTTP server.
  clock += __internal.RETRY_AFTER_MS + 1;
  primeFreeTier(opts);
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 2);
});

test('once known, the figure is never re-fetched', async () => {
  __internal.reset();
  let calls = 0;
  const fetchImpl = async () => { calls++; return { ok: true, json: async () => ({ auth: { freeTier: { lifetime: 10, dailyDrip: 1 } } }) }; };
  primeFreeTier({ fetchImpl });
  await new Promise((r) => setImmediate(r));
  primeFreeTier({ fetchImpl });
  primeFreeTier({ fetchImpl });
  assert.equal(calls, 1);
  assert.equal(freeTierPhrase(), '10 queries free, then 1 more a day');
});

test('concurrent primes collapse into one request', async () => {
  __internal.reset();
  let calls = 0;
  const fetchImpl = () => { calls++; return new Promise((r) => setTimeout(() => r({ ok: true, json: async () => ({ auth: { freeTier: { lifetime: 4, dailyDrip: 2 } } }) }), 5)); };
  primeFreeTier({ fetchImpl });
  primeFreeTier({ fetchImpl });
  primeFreeTier({ fetchImpl });
  assert.equal(calls, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(freeTierPhrase(), '4 queries free, then 2 more a day');
});

// ── The escaped path ────────────────────────────────────────────────────────
// free-tier.js was written to stop the server promising "3 free queries" when
// the gate grants ten. Only errorMap.js was switched over; authHeaderOrThrow in
// http-client.js kept its own hardcoded string, so the wrong number was still
// live in production on 2026-08-20. These pin both paths to one builder.

test('the no-token hint quotes the manifest, not a hardcoded number', async () => {
  __internal.reset();
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  const { authHint } = await import('../src/hints.js');
  const hint = authHint();
  assert.match(hint, /10 queries free, then 1 more a day/);
  assert.doesNotMatch(hint, /3 free queries/);
});

test('an unknown allowance is omitted, never guessed', async () => {
  __internal.reset();
  const { authHint } = await import('../src/hints.js');
  const hint = authHint();
  assert.match(hint, /Create a free Shumi key/);
  assert.doesNotMatch(hint, /\d+ quer/); // no number at all rather than a wrong one
});

test('remote callers are told about the URL/header, not an environment variable', async () => {
  __internal.reset();
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  const { authHint } = await import('../src/hints.js');
  const { runWithRequest } = await import('../src/request-context.js');
  // A Claude or ChatGPT connector user configures a URL in a web form and has no
  // shell to export SHUMI_TOKEN into.
  const remote = runWithRequest({ token: null }, () => authHint());
  assert.match(remote, /connector URL as \?apiKey=|Authorization: Bearer/);
  assert.doesNotMatch(remote, /environment variable/);
  // stdio keeps the env-var advice, which is correct there.
  assert.match(authHint(), /SHUMI_TOKEN environment variable/);
});
