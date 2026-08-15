import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.js';

// Fake transport mirroring the bits the store touches: a sessionId and close().
function fakeTransport(id) {
  return { sessionId: id, closed: false, close() { this.closed = true; } };
}

// Injectable clock so TTL/idle logic is deterministic (no real timers).
function clock(start = 0) {
  const c = { t: start };
  c.now = () => c.t;
  c.advance = (ms) => { c.t += ms; };
  return c;
}

test('reap closes and removes only sessions idle past the TTL', () => {
  const c = clock();
  const store = new SessionStore({ ttlMs: 1000, now: c.now });
  const a = fakeTransport('a');
  const b = fakeTransport('b');
  store.set('a', a);
  c.advance(600);
  store.set('b', b); // b is 600ms younger than a

  c.advance(600); // a idle 1200ms (> TTL), b idle 600ms (<= TTL)
  const reaped = store.reap();

  assert.equal(reaped, 1);
  assert.equal(store.has('a'), false);
  assert.equal(a.closed, true, 'reaped transport is closed');
  assert.equal(store.has('b'), true);
  assert.equal(b.closed, false, 'live transport is left open');
});

test('get() marks a session active so it survives the next sweep', () => {
  const c = clock();
  const store = new SessionStore({ ttlMs: 1000, now: c.now });
  const a = fakeTransport('a');
  store.set('a', a);

  c.advance(900);
  assert.equal(store.get('a'), a); // touches lastActivity -> now
  c.advance(900); // only 900ms since the touch, still under TTL

  assert.equal(store.reap(), 0);
  assert.equal(store.has('a'), true);
  assert.equal(a.closed, false);
});

test('hard cap evicts the least-recently-active session and closes it', () => {
  const c = clock();
  const store = new SessionStore({ maxSessions: 2, ttlMs: 1_000_000, now: c.now });
  const a = fakeTransport('a');
  const b = fakeTransport('b');
  const d = fakeTransport('d');
  store.set('a', a);
  c.advance(10);
  store.set('b', b);
  c.advance(10);
  store.get('a'); // a is now more-recently-active than b
  c.advance(10);

  store.set('d', d); // over cap -> evict the oldest active (b)

  assert.equal(store.size, 2);
  assert.equal(store.has('b'), false);
  assert.equal(b.closed, true, 'evicted transport is closed');
  assert.equal(store.has('a'), true);
  assert.equal(store.has('d'), true);
});

test('delete() removes without closing (the onclose path)', () => {
  const store = new SessionStore();
  const a = fakeTransport('a');
  store.set('a', a);

  assert.equal(store.delete('a'), true);
  assert.equal(store.has('a'), false);
  assert.equal(a.closed, false, 'delete must not close — the caller already did');
  assert.equal(store.delete('a'), false, 'deleting a missing session is a harmless no-op');
});

test('eviction is re-entrancy safe when close() calls back into delete()', () => {
  const c = clock();
  const store = new SessionStore({ ttlMs: 1000, now: c.now });
  // Mirror the real onclose handler: close() deletes the session from the store.
  const a = { sessionId: 'a', closed: false, close() { this.closed = true; store.delete('a'); } };
  store.set('a', a);
  c.advance(2000);

  assert.doesNotThrow(() => store.reap());
  assert.equal(a.closed, true);
  assert.equal(store.has('a'), false);
  assert.equal(store.size, 0);
});

test('a failed close() does not stop the rest of the sweep', () => {
  const c = clock();
  const store = new SessionStore({ ttlMs: 1000, now: c.now });
  const bad = { sessionId: 'bad', close() { throw new Error('boom'); } };
  const good = fakeTransport('good');
  store.set('bad', bad);
  store.set('good', good);
  c.advance(2000);

  assert.equal(store.reap(), 2);
  assert.equal(store.size, 0);
  assert.equal(good.closed, true);
});

test('startReaper is idempotent and stopReaper is safe to call anytime', () => {
  const store = new SessionStore();
  const t1 = store.startReaper(60_000);
  const t2 = store.startReaper(60_000);
  assert.equal(t1, t2, 'second start returns the same timer, does not spawn another');
  assert.doesNotThrow(() => store.stopReaper());
  assert.doesNotThrow(() => store.stopReaper(), 'stopping twice is safe');
});
