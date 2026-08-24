import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Token resolution IS the auth story of this server: whichever string getToken
 * returns is what gets sent upstream as the caller's identity. The priority
 * order (per-request > env > CLI login file) and the expiry gate had no tests,
 * and every failure mode is silent — the wrong branch does not error, it just
 * bills or rate-limits the wrong principal.
 *
 * HOME is pointed at a temp dir BEFORE the import so the developer's real
 * ~/.shumi/config.json can never leak into these tests; config.js resolves the
 * path at module load, hence the dynamic imports.
 */
const HOME = mkdtempSync(join(tmpdir(), 'shumi-mcp-config-'));
process.env.HOME = HOME;
delete process.env.SHUMI_TOKEN;
delete process.env.SHUMI_WALLET;

const { getToken, getWalletAddress, getDeviceId } = await import('../src/config.js');
const { runWithRequest, currentRequest } = await import('../src/request-context.js');

const CONFIG_DIR = join(HOME, '.shumi');
function writeConfig(obj) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(join(CONFIG_DIR, 'config.json'), typeof obj === 'string' ? obj : JSON.stringify(obj));
}

afterEach(() => {
  delete process.env.SHUMI_TOKEN;
  delete process.env.SHUMI_WALLET;
  rmSync(CONFIG_DIR, { recursive: true, force: true });
});

test('with nothing configured there is no token — the gate stays closed', () => {
  assert.equal(getToken(), null);
});

test('token priority: per-request beats env beats CLI login file', () => {
  // On the shared remote transport this ordering is caller isolation: if env or
  // file ever won over the per-request token, every remote caller would be
  // billed to the operator's own key.
  writeConfig({ token: 'file_tok' });
  process.env.SHUMI_TOKEN = 'env_tok';
  assert.equal(runWithRequest({ token: 'req_tok' }, () => getToken()), 'req_tok');
  assert.equal(getToken(), 'env_tok');
  delete process.env.SHUMI_TOKEN;
  assert.equal(getToken(), 'file_tok');
});

test('a request context without a token falls through to the next source', () => {
  process.env.SHUMI_TOKEN = 'env_tok';
  assert.equal(runWithRequest({}, () => getToken()), 'env_tok');
});

test('an expired CLI login is refused, not sent upstream', () => {
  writeConfig({ token: 'file_tok', expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(getToken(), null, 'an expired token must resolve to unauthenticated');
  writeConfig({ token: 'file_tok', expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assert.equal(getToken(), 'file_tok');
  writeConfig({ token: 'file_tok' }); // shumi_sk_* keys carry no expiry
  assert.equal(getToken(), 'file_tok');
});

test('a corrupted config file fails soft to unauthenticated', () => {
  writeConfig('{not json');
  assert.equal(getToken(), null);
  assert.equal(getWalletAddress(), null);
});

test('device id is deterministic and matches the CLI fingerprint shape', () => {
  // Server-side quota and analytics key on this: a per-boot random id would let
  // every restart look like a fresh machine.
  const id = getDeviceId();
  assert.equal(getDeviceId(), id);
  assert.match(id, /^[0-9a-f]{24}$/);
});

test('wallet resolution: env beats config file, absent is null', () => {
  assert.equal(getWalletAddress(), null);
  writeConfig({ walletAddress: '0xfile' });
  assert.equal(getWalletAddress(), '0xfile');
  process.env.SHUMI_WALLET = '0xenv';
  assert.equal(getWalletAddress(), '0xenv');
});

test('request context is per-async-chain, not process-global', async () => {
  assert.equal(currentRequest(), null);
  // Two concurrent "requests" must each see their own token — this is the
  // property that makes the stateless HTTP transport safe to share.
  const tick = () => new Promise((r) => setImmediate(r));
  const [a, b] = await Promise.all([
    runWithRequest({ token: 'a' }, async () => {
      await tick();
      return currentRequest().token;
    }),
    runWithRequest({ token: 'b' }, async () => {
      await tick();
      return currentRequest().token;
    }),
  ]);
  assert.equal(a, 'a');
  assert.equal(b, 'b');
  assert.equal(currentRequest(), null, 'context must not leak out of the request');
});
