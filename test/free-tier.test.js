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
