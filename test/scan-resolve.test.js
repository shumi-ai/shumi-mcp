import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runScan, resetCategoryCache, DATA_SCHEMAS, TYPED_TOOLS } from '../src/tools/index.js';
import { canonicalExchange, closestNames, resolveName, rowsOf } from '../src/tools/scanResolve.js';

// Real names from the Coin table (2026-09-24): "Layer-2", "BTC Layer 2", "Meme".
const CATEGORIES = ['Meme', 'Layer-2', 'BTC Layer 2', 'GMCI Layer 2 Index', 'Decentralized Finance (DeFi)', 'Layer 1 (L1)'];

/**
 * A fake apiGet that behaves like /api/coins/filter: exact, case-sensitive category match,
 * case-insensitive exact exchange match. Records every call.
 */
function fakeApi({ coins, wrap = false } = {}) {
  const universe = coins ?? [
    { name: 'Dogecoin', categories: ['Meme'], exchanges: ['Binance', 'Coinbase Exchange'] },
    { name: 'Arbitrum', categories: ['Layer-2'], exchanges: ['Binance'] },
  ];
  const calls = [];
  const get = async (route, query = {}) => {
    calls.push({ route, query });
    if (route === 'category/list') return { data: CATEGORIES };
    const rows = universe
      .filter((c) => !query.categories || c.categories.includes(query.categories))
      .filter((c) => !query.exchanges || c.exchanges.some((e) => e.toLowerCase() === String(query.exchanges).toLowerCase()))
      .map((c) => c.name);
    return { data: wrap ? { rows, coverage: { withChange: rows.length } } : rows };
  };
  return { get, calls };
}

beforeEach(() => resetCategoryCache());

test('a correct category costs one call and is sent unchanged', async () => {
  const { get, calls } = fakeApi();
  const { env, summary } = await runScan({ category: 'Meme' }, get);
  assert.deepEqual(env.data, ['Dogecoin']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query.categories, 'Meme');
  assert.equal(summary, undefined);
});

test('"meme" and "Layer 2" resolve to the real names and the scan is re-run', async () => {
  for (const [asked, real, coin] of [['meme', 'Meme', 'Dogecoin'], ['Layer 2', 'Layer-2', 'Arbitrum'], ['layer-2', 'Layer-2', 'Arbitrum']]) {
    resetCategoryCache();
    const { get, calls } = fakeApi();
    const { env, summary } = await runScan({ category: asked }, get);
    assert.deepEqual(env.data, [coin], asked);
    assert.equal(calls.at(-1).query.categories, real);
    assert.match(summary, new RegExp(`"${asked}" matched as "${real}"`));
  }
});

test('an unknown category is a tool error naming the closest real names, not an empty list', async () => {
  const { get } = fakeApi();
  await assert.rejects(runScan({ category: 'Layer Two' }, get), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /No category named "Layer Two"/);
    assert.match(err.message, /"Layer-2"/);
    assert.match(err.message, /list_categories/);
    return true;
  });
});

test('comma-joined categories are refused up front', async () => {
  const { get, calls } = fakeApi();
  await assert.rejects(runScan({ category: 'Meme,AI' }, get), /One category per call/);
  assert.equal(calls.length, 0);
});

test('a valid category with nothing matching the other filters still returns an empty list', async () => {
  const { get } = fakeApi({ coins: [] });
  const { env } = await runScan({ category: 'Meme', trend: 'UP' }, get);
  assert.deepEqual(env.data, []);
});

test('"Coinbase" is sent as "Coinbase Exchange"', async () => {
  const { get, calls } = fakeApi();
  const { env, summary } = await runScan({ exchange: 'coinbase' }, get);
  assert.equal(calls[0].query.exchanges, 'Coinbase Exchange');
  assert.deepEqual(env.data, ['Dogecoin']);
  assert.match(summary, /"coinbase" matched as "Coinbase Exchange"/);
});

test('an unknown exchange that matches nothing is a tool error with the closest venues', async () => {
  const { get } = fakeApi();
  await assert.rejects(runScan({ exchange: 'Krakenn' }, get), (err) => {
    assert.match(err.message, /No coins matched exchange "Krakenn"/);
    assert.match(err.message, /"Kraken"/);
    return true;
  });
});

test('the { rows } wrapper counts as rows, and validates against the output schema', async () => {
  const { get, calls } = fakeApi({ wrap: true });
  const { env } = await runScan({ category: 'Meme', sort_by: 'change24h' }, get);
  assert.deepEqual(env.data.rows, ['Dogecoin']);
  assert.equal(calls.length, 1);
  assert.ok(DATA_SCHEMAS.scan_coins.safeParse(env.data).success);
  assert.ok(DATA_SCHEMAS.scan_coins.safeParse(['Dogecoin']).success);
  assert.deepEqual(rowsOf({ rows: [1] }), [1]);
  assert.deepEqual(rowsOf(null), []);
});

test('resolveName / closestNames / canonicalExchange', () => {
  assert.deepEqual(resolveName('Meme', CATEGORIES), { status: 'exact', name: 'Meme' });
  assert.deepEqual(resolveName('MEME', CATEGORIES), { status: 'resolved', name: 'Meme' });
  assert.equal(resolveName('x', ['A-b', 'a b']).status, 'none');
  assert.equal(resolveName('ab', ['A-b', 'a b']).status, 'ambiguous');
  assert.ok(closestNames('layer 2', CATEGORIES).includes('Layer-2'));
  assert.equal(canonicalExchange('OKX'), 'OKX');
  assert.equal(canonicalExchange('okx'), 'OKX');
  assert.equal(canonicalExchange('Uniswap V3 (Ethereum)'), 'Uniswap V3 (Ethereum)');
});

test('the scan_coins description no longer carries the "Layer 2" example', () => {
  const t = TYPED_TOOLS.find((d) => d.name === 'scan_coins');
  assert.doesNotMatch(t.inputSchema.category.description, /"Layer 2"/);
  assert.match(t.inputSchema.category.description, /ONE category/);
  assert.match(t.description, /\{ rows: \[\.\.\.\] \}/);
});
