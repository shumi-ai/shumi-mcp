import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan, EMPTY_SCAN_NOTE, DATA_SCHEMAS, TYPED_TOOLS } from '../src/tools/index.js';
import { canonicalCategory, rowsOf } from '../src/tools/scanResolve.js';
import { ApiError } from '../src/http-client.js';
import { toMcpError } from '../src/errorMap.js';

const EXCHANGE_REFUSAL =
  'The exchange filter is not available on scan yet. Filter the returned coins with `shumi coin risk` or the funding routes instead.';

/**
 * A fake apiGet that behaves like /api/cli/scan since coinrotator-ai eaca92dd: refuses
 * `exchange` with a 400, and matches categories ignoring case and punctuation. Records every
 * call.
 */
const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
function fakeApi({ coins, wrap = false } = {}) {
  const universe = coins ?? [
    { name: 'Dogecoin', categories: ['Meme'] },
    { name: 'Arbitrum', categories: ['Layer-2'] },
    { name: 'Tiny', categories: ['Some Small Category'] },
  ];
  const calls = [];
  const get = async (route, query = {}) => {
    calls.push({ route, query });
    if (query.exchange !== undefined) {
      throw new ApiError(400, { schemaVersion: 1, error: { code: 'BAD_REQUEST', message: EXCHANGE_REFUSAL } });
    }
    const rows = universe
      .filter((c) => !query.categories || c.categories.some((cat) => norm(cat) === norm(query.categories)))
      .map((c) => c.name);
    return { data: wrap ? { rows, coverage: { withChange: rows.length } } : rows };
  };
  return { get, calls };
}

test('every scan is exactly one backend call, and never a category/list lookup', async () => {
  for (const args of [{ category: 'Meme' }, { category: 'meme' }, { category: 'Nope' }, { exchange: 'Hyperliquid' }, {}]) {
    const { get, calls } = fakeApi();
    await runScan(args, get).catch(() => {});
    assert.equal(calls.length, 1, JSON.stringify(args));
    assert.equal(calls[0].route, 'scan');
  }
});

test('a correct category is sent unchanged with no note', async () => {
  const { get, calls } = fakeApi();
  const { env, summary } = await runScan({ category: 'Meme' }, get);
  assert.deepEqual(env.data, ['Dogecoin']);
  assert.equal(calls[0].query.categories, 'Meme');
  assert.equal(summary, undefined);
});

test('case and punctuation variants go out as typed: the server resolves them', async () => {
  for (const [asked, coin] of [['meme', 'Dogecoin'], ['Layer 2', 'Arbitrum'], ['layer-2', 'Arbitrum']]) {
    const { get, calls } = fakeApi();
    const { env, summary } = await runScan({ category: asked }, get);
    assert.equal(calls[0].query.categories, asked, asked);
    assert.deepEqual(env.data, [coin]);
    assert.equal(summary, undefined);
  }
});

test('only synonyms the server cannot resolve are rewritten locally', async () => {
  for (const [asked, real, coin] of [['l2', 'Layer-2', 'Arbitrum'], ['memecoins', 'Meme', 'Dogecoin']]) {
    const { get, calls } = fakeApi();
    const { env, summary } = await runScan({ category: asked }, get);
    assert.equal(calls[0].query.categories, real, asked);
    assert.deepEqual(env.data, [coin]);
    assert.match(summary, new RegExp(`"${asked}" sent as "${real}"`));
  }
});

test('an unknown or small category is sent as given', async () => {
  const { get, calls } = fakeApi();
  const { env } = await runScan({ category: 'Some Small Category' }, get);
  assert.equal(calls[0].query.categories, 'Some Small Category');
  assert.deepEqual(env.data, ['Tiny']);
});

test('exchange goes out as `exchange` (never `exchanges`) and the server refusal is the tool error', async () => {
  const { get, calls } = fakeApi();
  const err = await runScan({ exchange: 'Hyperliquid', trend: 'UP' }, get).then(() => null, (e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.exchange, 'Hyperliquid');
  assert.equal('exchanges' in calls[0].query, false);
  const result = toMcpError(err);
  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error.code, 'BAD_REQUEST');
  assert.equal(payload.error.message, EXCHANGE_REFUSAL);
});

test('an empty result with a category set returns [] plus a note, not an error', async () => {
  const { get } = fakeApi();
  const { env, summary } = await runScan({ category: 'Layer Two' }, get);
  assert.deepEqual(env.data, []);
  assert.ok(summary.includes(EMPTY_SCAN_NOTE));
  assert.doesNotMatch(EMPTY_SCAN_NOTE, /case-sensitive|exact/);
  assert.match(EMPTY_SCAN_NOTE, /list_categories/);
  const filtered = await runScan({ category: 'Meme', trend: 'UP' }, fakeApi({ coins: [] }).get);
  assert.deepEqual(filtered.env.data, []);
  assert.ok(filtered.summary.includes(EMPTY_SCAN_NOTE));
  // No filter by name: an empty list needs no note.
  const plain = await runScan({ trend: 'UP' }, fakeApi({ coins: [] }).get);
  assert.equal(plain.summary, undefined);
});

test('comma-joined categories are refused up front, with no call', async () => {
  const { get, calls } = fakeApi();
  await assert.rejects(runScan({ category: 'Meme,AI' }, get), /One category per call/);
  assert.equal(calls.length, 0);
});

test('the { rows } wrapper counts as rows, and validates against the output schema', async () => {
  const { get } = fakeApi({ wrap: true });
  const { env, summary } = await runScan({ category: 'Meme', sort_by: 'change24h' }, get);
  assert.deepEqual(env.data.rows, ['Dogecoin']);
  assert.equal(summary, undefined);
  assert.ok(DATA_SCHEMAS.scan_coins.safeParse(env.data).success);
  assert.ok(DATA_SCHEMAS.scan_coins.safeParse(['Dogecoin']).success);
  assert.deepEqual(rowsOf({ rows: [1] }), [1]);
  assert.deepEqual(rowsOf(null), []);
});

test('canonicalCategory only touches synonyms, leaving spelling to the server', () => {
  assert.equal(canonicalCategory('L2'), 'Layer-2');
  assert.equal(canonicalCategory('Memecoin'), 'Meme');
  assert.equal(canonicalCategory('MEME'), 'MEME');
  assert.equal(canonicalCategory('Layer 2'), 'Layer 2');
  assert.equal(canonicalCategory('Decentralized Finance (DeFi)'), 'Decentralized Finance (DeFi)');
});

test('the scan_coins descriptions ask for one category and do not offer venue filtering', () => {
  const t = TYPED_TOOLS.find((d) => d.name === 'scan_coins');
  assert.match(t.inputSchema.category.description, /ONE category/);
  assert.doesNotMatch(t.inputSchema.category.description, /exact name/);
  assert.match(t.inputSchema.exchange.description, /Not supported yet/);
  assert.doesNotMatch(t.inputSchema.exchange.description, /Coinbase Exchange|Binance/);
  assert.doesNotMatch(t.description, /case-sensitive|full name/);
  assert.match(t.description, /no exchange filter yet/);
  assert.match(t.description, /\{ rows: \[\.\.\.\] \}/);
});
