import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { defaultHint, billingHint, authHint } from '../src/hints.js';
import { __internal } from '../src/free-tier.js';

/**
 * defaultHint is the status→advice router: 401/403 mean "you have no key",
 * 402/429 mean "your allowance is spent". Crossing those wires tells a paying
 * user who hit a rate limit to go create a free key, and tells a keyless user
 * to upgrade a subscription they do not have — both dead ends for conversion.
 * free-tier.test.js covers authHint's wording; this file pins the routing.
 */

afterEach(() => __internal.reset());

test('auth statuses route to key creation, billing statuses to upgrade', () => {
  // Seed the allowance via the test seam so authHint never fires a manifest fetch.
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  for (const status of [401, 403]) {
    assert.match(defaultHint(status), /Create a free Shumi key/, `status ${status}`);
  }
  for (const status of [402, 429]) {
    assert.equal(defaultHint(status), billingHint(), `status ${status}`);
  }
});

test('statuses without a conversion story get no hint at all', () => {
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  for (const status of [400, 404, 500, 503, 0, undefined]) {
    assert.equal(defaultHint(status), undefined, `status ${status}`);
  }
});

test('the billing hint sells the upgrade, never the free key', () => {
  // A spent allowance is a converting moment; sending that user back to "create
  // a free key" would be both wrong (they have one) and lost revenue.
  const hint = billingHint();
  assert.match(hint, /Upgrade at https:\/\/shumi\.ai/);
  assert.match(hint, /\$SHUMI/); // the hold-gate alternative must stay mentioned
  assert.doesNotMatch(hint, /Create a free/);
  assert.doesNotMatch(defaultHint(402), /Create a free/);
});

test('the auth hint never routes through the billing pitch', () => {
  __internal.set({ lifetime: 10, dailyDrip: 1 });
  assert.doesNotMatch(authHint(), /Upgrade at/);
});
