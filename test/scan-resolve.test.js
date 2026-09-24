import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan, EMPTY_SCAN_NOTE, DATA_SCHEMAS, TYPED_TOOLS } from '../src/tools/index.js';
import { canonicalCategory, canonicalExchange, rowsOf } from '../src/tools/scanResolve.js';

/**
 * A fake apiGet that behaves like /api/coins/filter: exact, case-sensitive category match,
 * case-insensitive exact exchange match. Records every call.
 */
function fakeApi({ coins, wrap = false } = {}) {
  const universe = coins ?? [
    { name: 'Dogecoin', categories: ['Meme'], exchanges: ['Binance', 'Coinbase Exchange'] },
    { name: 'Arbitrum', categories: ['Layer-2'], exchanges: ['Binance'] },
    { name: 'Tiny', categories: ['Some Small Category'], exchanges: ['Some DEX (Base)'] },
  ];
  const calls = [];
  const get = async (route, query = {}) => {
    calls.push({ route, query });
    const rows = universe
      .filter((c) => !query.categories || c.categories.includes(query.categories))
      .filter((c) => !query.exchanges || c.exchanges.some((e) => e.toLowerCase() === String(query.exchanges).toLowerCase()))
      .map((c) => c.name);
    return { data: wrap ? { rows, coverage: { withChange: rows.length } } : rows };
  };
  return { get, calls };
}

test('every scan is exactly one backend call, and never a category/list lookup', async () => {
  for (const args of [{ category: 'Meme' }, { category: 'meme' }, { category: 'Nope' }, { exchange: 'Krakenn' }, {}]) {
    const { get, calls } = fakeApi();
    await runScan(args, get);
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

test('known misspellings are rewritten locally before the one call', async () => {
  for (const [asked, real, coin] of [['meme', 'Meme', 'Dogecoin'], ['Layer 2', 'Layer-2', 'Arbitrum'], ['layer-2', 'Layer-2', 'Arbitrum']]) {
    const { get, calls } = fakeApi();
    const { env, summary } = await runScan({ category: asked }, get);
    assert.equal(calls[0].query.categories, real, asked);
    assert.deepEqual(env.data, [coin]);
    assert.match(summary, new RegExp(`"${asked}" sent as "${real}"`));
  }
  const { get, calls } = fakeApi();
  await runScan({ exchange: 'coinbase' }, get);
  assert.equal(calls[0].query.exchanges, 'Coinbase Exchange');
});

test('an unknown or small category is sent as given, never rejected', async () => {
  const { get, calls } = fakeApi();
  const { env } = await runScan({ category: 'Some Small Category' }, get);
  assert.equal(calls[0].query.categories, 'Some Small Category');
  assert.deepEqual(env.data, ['Tiny']);
  const other = fakeApi();
  const { env: env2 } = await runScan({ exchange: 'Some DEX (Base)' }, other.get);
  assert.deepEqual(env2.data, ['Tiny']);
});

test('an empty result with a category or exchange set returns [] plus a note, not an error', async () => {
  const { get } = fakeApi();
  const { env, summary } = await runScan({ category: 'Layer Two' }, get);
  assert.deepEqual(env.data, []);
  assert.ok(summary.includes(EMPTY_SCAN_NOTE));
  assert.match(EMPTY_SCAN_NOTE, /exact and case-sensitive/);
  assert.match(EMPTY_SCAN_NOTE, /list_categories/);
  const ex = await runScan({ exchange: 'Krakenn' }, fakeApi().get);
  assert.deepEqual(ex.env.data, []);
  assert.ok(ex.summary.includes(EMPTY_SCAN_NOTE));
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

test('canonicalCategory / canonicalExchange only touch known spellings', () => {
  assert.equal(canonicalCategory('MEME'), 'Meme');
  assert.equal(canonicalCategory('Decentralized Finance (DeFi)'), 'Decentralized Finance (DeFi)');
  assert.equal(canonicalExchange('Huobi'), 'HTX');
  assert.equal(canonicalExchange('OKX'), 'OKX');
  assert.equal(canonicalExchange('Uniswap V3 (Ethereum)'), 'Uniswap V3 (Ethereum)');
});

test('the scan_coins descriptions use real names and one category per call', () => {
  const t = TYPED_TOOLS.find((d) => d.name === 'scan_coins');
  assert.doesNotMatch(t.inputSchema.category.description, /"Layer 2"/);
  assert.match(t.inputSchema.category.description, /ONE category/);
  assert.match(t.inputSchema.category.description, /"Layer-2"/);
  assert.match(t.inputSchema.exchange.description, /"Coinbase Exchange"/);
  assert.match(t.description, /\{ rows: \[\.\.\.\] \}/);
});
