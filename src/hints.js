/**
 * Conversion hints, in one place so every path quotes the same numbers.
 *
 * This module exists because the previous fix missed a path. free-tier.js was
 * written to stop the server promising "3 free queries" when the gate grants ten
 * — but only errorMap.js was switched over to it. `authHeaderOrThrow` in
 * http-client.js kept its own hardcoded string, and that is the path an
 * unauthenticated caller actually hits, so the wrong number stayed live in
 * production on 2026-08-20, months after the fix. One exported builder, imported
 * by both, is what makes that class of miss impossible rather than unlikely.
 *
 * Lives apart from errorMap.js to avoid an import cycle: errorMap imports
 * ApiError from http-client, so http-client cannot import errorMap back.
 */

import { freeTierPhrase, primeFreeTier } from './free-tier.js';
import { currentRequest } from './request-context.js';

/**
 * How the caller is supposed to supply a token, which depends on transport.
 *
 * "Set the SHUMI_TOKEN environment variable" is sound advice over stdio and
 * useless over HTTP: a Claude or ChatGPT connector user is configuring a URL in
 * a web form and has no shell to export anything into. currentRequest() is only
 * populated by the Streamable HTTP transport, so it doubles as the transport
 * discriminator.
 *
 * Remote callers are pointed at the HEADER, never at `?apiKey=`. The server
 * still accepts the query form (see tokenFromConfig) because Smithery passes
 * config that way, but it must not be recommended: the MCP authorization spec
 * prohibits access tokens in the URI query string, and Anthropic's connector
 * documentation calls a credential in a URL a security vulnerability, because
 * URLs land in server logs, proxies and browser history. Claude's
 * `static_headers` connector type exists for exactly this case.
 */
function tokenAdvice() {
  return currentRequest()
    ? 'Then send it as an Authorization: Bearer header — in Claude, add it under the connector\'s request-header setting. Do not put it in the URL: a credential in a query string leaks through logs and history.'
    : 'Then set it as the SHUMI_TOKEN environment variable.';
}

/** Hint for 401/403 — never states an allowance it has not read from the server. */
export function authHint() {
  // The allowance is quoted from the server's manifest, never written down here
  // — see free-tier.js. Unknown numbers are omitted, not guessed.
  const phrase = freeTierPhrase();
  // Not known yet (boot race, or the manifest was down at startup). Kick off a
  // retry so the NEXT caller gets the number; this call still answers now.
  if (!phrase) primeFreeTier();
  return phrase
    ? `Create a free Shumi key at https://shumi.ai — ${phrase}. ${tokenAdvice()}`
    : `Create a free Shumi key at https://shumi.ai. ${tokenAdvice()}`;
}

/** Hint for 402/429 — the allowance is spent. */
export function billingHint() {
  return "You've used your free Shumi queries. Upgrade at https://shumi.ai — Plus is $20/mo (50 queries/day), Pro is $200/mo (unlimited). Holding $SHUMI also grants access.";
}

export function defaultHint(status) {
  if (status === 401 || status === 403) return authHint();
  if (status === 402 || status === 429) return billingHint();
  return undefined;
}
