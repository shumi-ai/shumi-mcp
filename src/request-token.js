/**
 * Where a request's Shumi key comes from, across every way this server is reached.
 *
 * Extracted from http-server.js so it can be tested: that module starts listening
 * on import, so importing it in a test binds a port.
 */

/**
 * Read the key from a request header.
 *
 * Deliberately lenient, because of how Claude's `static_headers` connector type
 * works: an organisation administrator types a header NAME and VALUE by hand,
 * once, in a web form. We do not control either field, and a mistyped pair fails
 * closed with no diagnostic the admin can see — the connector simply behaves as
 * if unauthenticated. So accept the three shapes an admin plausibly enters:
 *
 *   Authorization: Bearer shumi_sk_…   the documented form
 *   Authorization: shumi_sk_…          bare value, no scheme (very common by hand)
 *   x-api-key: shumi_sk_…              matches the coinrotator-ai API convention,
 *                                      so anyone reading those docs picks it
 *
 * The bare-Authorization case is only honoured for values that look like our own
 * keys. Accepting any bare string would swallow a genuine credential from some
 * other scheme (Basic, Negotiate) and forward it upstream as if it were ours.
 */
export const KEY_PREFIX = 'shumi_sk_';

export function headerToken(req) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();

  const header = req.headers['authorization'] || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();

  const bare = header.trim();
  if (bare && !bare.includes(' ') && bare.startsWith(KEY_PREFIX)) return bare;

  return null;
}

// Smithery-hosted containers receive the user's session config as a base64-JSON
// `config` query param (or flat query params), not an Authorization header. Map
// the configured key to our bearer token so the SAME server works whether it's
// our Render deploy (header auth) or Smithery-hosted (config injection).
function tokenFromConfig(url) {
  const cfg = url.searchParams.get('config');
  if (cfg) {
    try {
      const obj = JSON.parse(Buffer.from(cfg, 'base64').toString('utf8'));
      const t = obj.shumiToken || obj.apiKey || obj.token || obj.SHUMI_TOKEN;
      if (t) return String(t);
    } catch {
      /* ignore malformed config */
    }
  }
  return url.searchParams.get('shumiToken') || url.searchParams.get('api_key') || null;
}

export function resolveRequestToken(req, url) {
  return headerToken(req) || tokenFromConfig(url);
}
