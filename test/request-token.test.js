import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerToken, resolveRequestToken } from '../src/request-token.js';

const url = (u = 'https://mcp.shumi.ai/mcp') => new URL(u);
const req = (headers) => ({ headers });

// Claude's `static_headers` connector type has an organisation administrator type
// a header NAME and VALUE by hand, once, in a web form. We control neither field,
// and a mistyped pair fails closed with no diagnostic they can see — the connector
// just behaves as if unauthenticated. These pin the shapes we accept.

test('the documented form works', () => {
  assert.equal(headerToken(req({ authorization: 'Bearer shumi_sk_abc' })), 'shumi_sk_abc');
  assert.equal(headerToken(req({ authorization: 'bearer shumi_sk_abc' })), 'shumi_sk_abc'); // scheme is case-insensitive
});

test('a bare key in Authorization is accepted — admins routinely omit the scheme', () => {
  assert.equal(headerToken(req({ authorization: 'shumi_sk_abc' })), 'shumi_sk_abc');
  assert.equal(headerToken(req({ authorization: '  shumi_sk_abc  ' })), 'shumi_sk_abc');
});

test('x-api-key is accepted — it is the coinrotator-ai convention admins will have read', () => {
  assert.equal(headerToken(req({ 'x-api-key': 'shumi_sk_abc' })), 'shumi_sk_abc');
});

test('x-api-key wins over Authorization when both are present', () => {
  // An admin who set x-api-key meant it; a stale Authorization header from a proxy
  // should not shadow the credential they actually configured.
  assert.equal(headerToken(req({ 'x-api-key': 'shumi_sk_configured', authorization: 'Bearer shumi_sk_stale' })), 'shumi_sk_configured');
});

test('a foreign bare credential is NOT swallowed', () => {
  // Accepting any bare Authorization value would take a Basic/Negotiate credential
  // from some other scheme and forward it upstream as if it were ours.
  assert.equal(headerToken(req({ authorization: 'Basic dXNlcjpwdw==' })), null);
  assert.equal(headerToken(req({ authorization: 'Negotiate YIIC' })), null);
  assert.equal(headerToken(req({ authorization: 'someothertoken' })), null);
});

test('no header at all resolves to null, not an empty string', () => {
  assert.equal(headerToken(req({})), null);
  assert.equal(headerToken(req({ authorization: '' })), null);
  assert.equal(headerToken(req({ 'x-api-key': '   ' })), null);
});

test('headers win over the query string', () => {
  const t = resolveRequestToken(req({ authorization: 'Bearer shumi_sk_header' }), url('https://x/mcp?shumiToken=shumi_sk_query'));
  assert.equal(t, 'shumi_sk_header');
});

test('the Smithery config param still works, and ?apiKey= still does not', () => {
  // Smithery injects session config as base64 JSON; that path must keep working.
  const cfg = Buffer.from(JSON.stringify({ shumiToken: 'shumi_sk_cfg' })).toString('base64');
  assert.equal(resolveRequestToken(req({}), url(`https://x/mcp?config=${cfg}`)), 'shumi_sk_cfg');
  // ?apiKey= was never an accepted flat param — worth pinning, because it was
  // briefly recommended in an auth hint that pointed at a form the server ignores.
  assert.equal(resolveRequestToken(req({}), url('https://x/mcp?apiKey=shumi_sk_q')), null);
});
