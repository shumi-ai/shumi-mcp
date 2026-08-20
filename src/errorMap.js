import { ApiError } from './http-client.js';
import { defaultHint } from './hints.js';

/**
 * Translate an ApiError (or any thrown error) into an MCP tool result with
 * `isError: true`. Mirrors the CLI's exit-code mapping (shumi-cli/src/lib/
 * exitCodes.js) but for MCP: instead of an exit code we hand the agent a
 * structured `{ error: { code, message, hint } }` payload so it can relay the
 * server's hint (e.g. "out of free queries — upgrade at …") to the user.
 *
 * We never swallow auth/billing failures — they carry the actionable hint.
 */

function codeForStatus(status) {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 402) return 'PAYMENT_REQUIRED';
  if (status >= 400 && status < 500) return 'UPSTREAM_4XX';
  if (status >= 500) return 'UPSTREAM_5XX';
  if (status === 0) return 'NETWORK';
  return 'INTERNAL';
}

/** Build the structured error payload (also used to shape NLP errors uniformly). */
export function errorPayload(err) {
  const status = err instanceof ApiError ? err.status : undefined;
  const e = err?.body?.error;
  const fromBody = e && typeof e === 'object' ? e : null;

  const code = fromBody?.code || (status !== undefined ? codeForStatus(status) : 'INTERNAL');
  const message =
    fromBody?.message || (typeof e === 'string' ? e : null) || err?.message || 'Request failed';
  const hint = fromBody?.hint || (status !== undefined ? defaultHint(status) : undefined);

  return { error: { code, message, ...(hint ? { hint } : {}) } };
}

/** Wrap a thrown error as an MCP `CallToolResult` with isError set. */
export function toMcpError(err) {
  return {
    content: [{ type: 'text', text: JSON.stringify(errorPayload(err), null, 2) }],
    isError: true,
  };
}
