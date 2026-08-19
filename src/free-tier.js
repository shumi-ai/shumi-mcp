import { API_URL } from './config.js';

/**
 * The free-tier numbers quoted in conversion hints, read from the server rather
 * than written down here.
 *
 * These figures have drifted before — billing.js says so in as many words
 * ("the free-tier figure has drifted across README/scope/widget copy before, so
 * there is one source now") and publishes `GET /api/cli/manifest` as that one
 * source. This repo could not consume it, being a different codebase, and drifted
 * exactly as predicted: the hint promised "3 free queries" while the gate granted
 * 10 lifetime plus 1/day. A new user was told a wrong number by the first
 * sentence the server ever shows them.
 *
 * The manifest route is public and unauthenticated, so priming costs nothing and
 * needs no token. Everything here fails soft: until the fetch lands — and forever,
 * if it never does — the hint simply omits the numbers rather than inventing them.
 */

const RETRY_AFTER_MS = 60_000;

let freeTier = null;
let inFlight = false;
let nextAttemptAt = 0;

/**
 * Fire-and-forget prime. Never throws, never blocks, never runs twice at once.
 *
 * A failed attempt does NOT latch: the HTTP transport is long-running, and if
 * priming were one-shot then a manifest that happened to be redeploying at boot
 * would cost every user for the rest of the process's life. Failures are retried,
 * but no more often than once a minute, so a permanently unreachable manifest
 * costs one request per minute rather than one per error.
 */
export function primeFreeTier({ fetchImpl = fetch, timeoutMs = 4000, now = () => Date.now() } = {}) {
  if (freeTier || inFlight || now() < nextAttemptAt) return;
  inFlight = true;
  nextAttemptAt = now() + RETRY_AFTER_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  if (timer.unref) timer.unref();
  fetchImpl(`${API_URL}/manifest`, { signal: ctrl.signal })
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => {
      const t = body?.auth?.freeTier;
      if (t && Number.isFinite(t.lifetime) && Number.isFinite(t.dailyDrip)) freeTier = t;
    })
    .catch(() => {
      /* stay null — the hint drops the numbers rather than guessing */
    })
    .finally(() => {
      clearTimeout(timer);
      inFlight = false;
    });
}

const queries = (n) => `${n} ${n === 1 ? 'query' : 'queries'}`;

/** "10 queries free, then 1 more a day" — or null when the numbers are not known. */
export function freeTierPhrase() {
  if (!freeTier) return null;
  const { lifetime, dailyDrip } = freeTier;
  if (lifetime > 0 && dailyDrip > 0) return `${queries(lifetime)} free, then ${dailyDrip} more a day`;
  if (lifetime > 0) return `${queries(lifetime)} free`;
  if (dailyDrip > 0) return `${queries(dailyDrip)} free a day`;
  return null;
}

/** Test seam. */
export const __internal = {
  reset() { freeTier = null; inFlight = false; nextAttemptAt = 0; },
  set(t) { freeTier = t; },
  RETRY_AFTER_MS,
};
