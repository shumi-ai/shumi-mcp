/**
 * Bounded session store for the Streamable-HTTP transport.
 *
 * The stateful transport keeps one `StreamableHTTPServerTransport` + connected
 * `McpServer` per Mcp-Session-Id. A plain Map leaks: entries are only removed on
 * an explicit DELETE (`transport.onclose`), but liveness probes (mcpbeat,
 * SentinelOracle, registry health checks) send `initialize` every minute and
 * never DELETE. Each one strands a transport + full server in the map forever,
 * so the heap climbs ~7 MB/h until Node OOM-aborts (exit 134) — observed ~daily.
 *
 * This store bounds the leak two ways:
 *   1. Idle TTL — a background sweep closes sessions idle beyond `ttlMs`.
 *   2. Hard cap — at capacity, the least-recently-active session is evicted
 *      before a new one is admitted (safety net against a probe storm).
 *
 * Reaping is deterministic and clock-injectable, so it is unit-tested without a
 * live server or real timers.
 */

export const DEFAULT_TTL_MS = 10 * 60 * 1000; // reap sessions idle > 10 min
export const DEFAULT_MAX_SESSIONS = 500; // hard cap; well above real concurrency
export const DEFAULT_SWEEP_MS = 60 * 1000; // reaper cadence

export class SessionStore {
  /** @type {Map<string, { transport: any, lastActivity: number }>} */
  #sessions = new Map();
  #ttlMs;
  #maxSessions;
  #now;
  #timer = null;

  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] Idle timeout before a session is reaped.
   * @param {number} [opts.maxSessions] Hard cap on concurrent sessions.
   * @param {() => number} [opts.now] Clock (injectable for tests).
   */
  constructor({ ttlMs = DEFAULT_TTL_MS, maxSessions = DEFAULT_MAX_SESSIONS, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#maxSessions = maxSessions;
    this.#now = now;
  }

  get size() {
    return this.#sessions.size;
  }

  has(id) {
    return this.#sessions.has(id);
  }

  /** Return the transport for `id` and mark it active, or undefined if unknown. */
  get(id) {
    const entry = this.#sessions.get(id);
    if (!entry) return undefined;
    entry.lastActivity = this.#now();
    return entry.transport;
  }

  /** Mark an existing session active without fetching it. */
  touch(id) {
    const entry = this.#sessions.get(id);
    if (entry) entry.lastActivity = this.#now();
  }

  /**
   * Admit a new session. Enforces the hard cap first by evicting the
   * least-recently-active session(s) — bounded work, never unbounded.
   */
  set(id, transport) {
    while (!this.#sessions.has(id) && this.#sessions.size >= this.#maxSessions) {
      const oldest = this.#oldestId();
      if (oldest === undefined) break;
      this.#evict(oldest);
    }
    this.#sessions.set(id, { transport, lastActivity: this.#now() });
  }

  /** Remove a session from the map without closing it (used by onclose). */
  delete(id) {
    return this.#sessions.delete(id);
  }

  #oldestId() {
    let oldestId;
    let oldestTs = Infinity;
    for (const [id, entry] of this.#sessions) {
      if (entry.lastActivity < oldestTs) {
        oldestTs = entry.lastActivity;
        oldestId = id;
      }
    }
    return oldestId;
  }

  // Delete from the map first, THEN close — so the transport's onclose handler
  // (which calls delete again) is a harmless no-op and cannot re-enter.
  #evict(id) {
    const entry = this.#sessions.get(id);
    if (!entry) return;
    this.#sessions.delete(id);
    try {
      entry.transport?.close?.();
    } catch {
      /* best-effort: a failed close must not block reaping the rest */
    }
  }

  /** Close and remove every session idle for longer than `ttlMs`. Returns the count reaped. */
  reap() {
    const cutoff = this.#now() - this.#ttlMs;
    let reaped = 0;
    for (const [id, entry] of this.#sessions) {
      if (entry.lastActivity <= cutoff) {
        this.#evict(id);
        reaped += 1;
      }
    }
    return reaped;
  }

  /**
   * Start the background reaper. Idempotent. The interval is `unref`'d so it
   * never keeps the process alive on its own.
   * @param {number} [intervalMs]
   * @param {(reaped: number) => void} [onReap] Called after a sweep that reaped >0.
   */
  startReaper(intervalMs = DEFAULT_SWEEP_MS, onReap) {
    if (this.#timer) return this.#timer;
    this.#timer = setInterval(() => {
      const n = this.reap();
      if (n > 0 && onReap) onReap(n);
    }, intervalMs);
    this.#timer.unref?.();
    return this.#timer;
  }

  stopReaper() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
