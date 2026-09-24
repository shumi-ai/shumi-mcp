import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COIN_RISK_DESCRIPTION,
  FUNDING_MOMENTUM_DESCRIPTION,
  DATA_SCHEMAS,
  LOOKUP_COIN_DESCRIPTION,
  SCAN_COINS_DESCRIPTION,
  TYPED_TOOLS,
  answerResult,
  buildRiskRows,
  registerTools,
  toolCatalog,
} from '../src/tools/index.js';
import { applyFilters, unwrap } from '../src/tools/util.js';

function byName(name) {
  const def = TYPED_TOOLS.find((d) => d.name === name);
  assert.ok(def, `tool ${name} exists`);
  return def;
}

test('lookup_coin routes by identifier kind', () => {
  const t = byName('lookup_coin');
  assert.deepEqual(t.build({ by: 'symbol', identifier: 'BTC' }), { route: 'coin/lookup', query: { symbol: 'BTC' } });
  assert.deepEqual(t.build({ by: 'name', identifier: 'Bitcoin' }), { route: 'coin/by-name/Bitcoin' });
  assert.deepEqual(t.build({ by: 'id', identifier: 'bitcoin' }), { route: 'coin/by-id/bitcoin' });
  assert.deepEqual(t.build({ by: 'contract', identifier: '0xabc', chain: 'ethereum' }), {
    route: 'coin/by-contract/0xabc',
    query: { chain: 'ethereum' },
  });
});

test('lookup_coin requires chain for contract lookups', () => {
  const t = byName('lookup_coin');
  assert.throws(() => t.build({ by: 'contract', identifier: '0xabc' }), /chain is required/);
});

test('lookup_coin keeps currentTrend instead of dropping it', () => {
  const currentTrend = { trend: 'HODL', since: '2026-09-19', days: 5, asOf: '2026-09-23', incompleteDayExcluded: true };
  const parsed = DATA_SCHEMAS.lookup_coin.parse({ coin: { id: 'bitcoin' }, trends: [], currentTrend, currentTrendWeekly: null });
  assert.deepEqual(parsed.currentTrend, currentTrend);
  assert.equal(parsed.currentTrendWeekly, null);
  // An older backend sends no currentTrend at all; that must still validate.
  assert.ok(DATA_SCHEMAS.lookup_coin.safeParse({ coin: { id: 'bitcoin' }, trends: [] }).success);
});

test('lookup_coin tells the model to read the current trend from currentTrend', () => {
  const t = byName('lookup_coin');
  assert.equal(t.description, LOOKUP_COIN_DESCRIPTION);
  assert.match(t.description, /CURRENT trend from `currentTrend`/);
  assert.match(t.description, /not from the last row of `trends`/);
});

test('scan_coins sends the parameter names /api/coins/filter actually reads, and exchange unmapped', () => {
  const t = byName('scan_coins');
  assert.deepEqual(
    t.build({ trend: 'UP', category: 'Layer 2', mcap_min: 1e6, mcap_max: 1e9, exchange: 'Binance', limit: 10 }).query,
    {
      trend: 'UP',
      categories: 'Layer 2',
      marketCapMin: 1e6,
      marketCapMax: 1e9,
      exchange: 'Binance',
      interval: undefined,
      limit: 10,
      sortBy: undefined,
      sortOrder: undefined,
    },
  );
});

test('scan_coins can sort by 24h change for movers questions', () => {
  const t = byName('scan_coins');
  const q = t.build({ sort_by: 'change24h', sort_order: 'asc', limit: 10 }).query;
  assert.equal(q.sortBy, 'change24h');
  assert.equal(q.sortOrder, 'asc');
  for (const v of ['marketCap', 'change24h', 'change7d', 'streak', 'price']) assert.ok(t.inputSchema.sort_by.safeParse(v).success, v);
  assert.equal(t.inputSchema.sort_by.safeParse('volume').success, false);
  assert.equal(t.description, SCAN_COINS_DESCRIPTION);
  assert.match(t.description, /movers/);
  assert.match(t.description, /sort_by="change24h"/);
});

test('scan_trends maps state -> action', () => {
  const t = byName('scan_trends');
  assert.deepEqual(t.build({ state: 'aligned', limit: 5 }), { route: 'trends', query: { action: 'aligned', interval: undefined, limit: 5 } });
});

test('funding momentum defines units, payer direction, and context-only use', () => {
  const tool = byName('get_funding_momentum');
  assert.equal(tool.description, FUNDING_MOMENTUM_DESCRIPTION);
  assert.match(tool.description, /1\.7 = 1\.7%/);
  assert.match(tool.description, /Positive funding means longs pay and shorts receive/);
  assert.match(tool.description, /negative funding means shorts pay and longs receive/i);
  assert.match(tool.description, /not a standalone directional, timing, or entry signal/);
});

test('coin risk contract tells host models to relay deterministic carry', () => {
  assert.match(COIN_RISK_DESCRIPTION, /funding_paying_side/);
  assert.match(COIN_RISK_DESCRIPTION, /carry_if_long and carry_if_short/);
  assert.match(COIN_RISK_DESCRIPTION, /spot positions neither pay nor receive/);
  assert.match(COIN_RISK_DESCRIPTION, /Relay the carry fields exactly/);

  const contract = {
    symbol: 'BTC',
    funding_apr: 7.43505,
    funding_apr_unit: 'percent',
    funding_paying_side: 'longs',
    funding_receiving_side: 'shorts',
    carry_if_long: 'Long perpetual positions pay funding at +7.4% APR.',
    carry_if_short: 'Short perpetual positions receive funding at +7.4% APR.',
  };
  assert.deepEqual(buildRiskRows([{ s: 'BTC', env: { data: contract } }]), [contract]);
});

test('get_regime switches to history when symbol provided', () => {
  const t = byName('get_regime');
  assert.deepEqual(t.build({ view: 'active' }), { route: 'regime', query: { action: 'active' } });
  assert.deepEqual(t.build({ view: 'active', symbol: 'ETH' }), { route: 'regime', query: { action: 'history', symbol: 'ETH' } });
});

test('get_pair_suggestions requires both tokens for signal mode', () => {
  const t = byName('get_pair_suggestions');
  assert.throws(() => t.build({ mode: 'signal', token_a: 'ETH' }), /token_a and token_b/);
  assert.deepEqual(t.build({ mode: 'signal', token_a: 'ETH', token_b: 'SOL' }), {
    route: 'pairs',
    query: { action: 'signal', tokenA: 'ETH', tokenB: 'SOL' },
  });
});

test('get_category builds nested route', () => {
  const t = byName('get_category');
  assert.deepEqual(t.build({ name: 'Layer 2', view: 'coins' }), { route: 'category/coins/Layer%202' });
});

test('get_rwa_asset routes by ticker or namespaced id', () => {
  const t = byName('get_rwa_asset');
  assert.deepEqual(t.build({ by: 'symbol', identifier: 'AAPL' }), { route: 'rwa/symbol/AAPL' });
  // The colon in a namespaced id must survive as %3A, not split the path.
  assert.deepEqual(t.build({ by: 'id', identifier: 'xyz:AAPL' }), { route: 'rwa/asset/xyz%3AAAPL' });
});

test('list_rwa_assets passes class and dex filters through to the server', () => {
  const t = byName('list_rwa_assets');
  assert.deepEqual(t.build({ type: 'commodity', dex: 'xyz', top: 50 }), {
    route: 'rwa/assets',
    query: { type: 'commodity', dex: 'xyz', top: 50 },
  });
});

test('movement/history views require their identifier', () => {
  assert.throws(() => byName('get_holders').build({ view: 'movements' }), /contract is required/);
  assert.throws(() => byName('get_wallets').build({ view: 'movements' }), /address is required/);
  assert.throws(() => byName('get_futures_signals').build({ view: 'history' }), /asset is required/);
});

test('view params map to the server action param', () => {
  assert.deepEqual(byName('get_holders').build({ view: 'watchlist' }), {
    route: 'holders',
    query: { action: 'watchlist', contract: undefined, limit: undefined },
  });
  assert.deepEqual(byName('get_transcripts').build({ view: 'sources' }), {
    route: 'transcripts',
    query: { action: 'sources' },
  });
});

test('walkforward is deliberately absent while Engine B is paused', () => {
  assert.equal(TYPED_TOOLS.find((t) => t.name.includes('walkforward')), undefined);
});

test('every typed tool has a description and a build fn', () => {
  for (const t of TYPED_TOOLS) {
    assert.ok(typeof t.description === 'string' && t.description.length > 10, `${t.name} description`);
    assert.equal(typeof t.build, 'function', `${t.name} build`);
  }
});

test('unwrap pulls the data field out of the envelope', () => {
  assert.deepEqual(unwrap({ data: { a: 1 }, meta: {} }), { a: 1 });
  assert.deepEqual(unwrap({ a: 1 }), { a: 1 });
});

test('applyFilters: top slices arrays and fields whitelists keys', () => {
  assert.deepEqual(applyFilters([1, 2, 3, 4], { top: 2 }), [1, 2]);
  assert.deepEqual(applyFilters({ items: [1, 2, 3] }, { top: 2 }), { items: [1, 2] });
  assert.deepEqual(applyFilters([{ a: 1, b: 2 }], { fields: 'a' }), [{ a: 1 }]);
});

test('toolCatalog lists coin risk and the nlp tools', () => {
  const c = toolCatalog();
  assert.ok(c.typed.some((t) => t.name === 'get_coin_risk'));
  assert.ok(c.nlp.some((t) => t.name === 'ask_shumi'));
});

test('get_coin_historical passes the time offset through to the route', () => {
  // The tool shipped without these, so every call returned "now" — a tool whose
  // name promises history could not answer a historical question. Verified
  // against production: amount=5&interval=d returns a different snapshot.
  const t = TYPED_TOOLS.find((x) => x.name === 'get_coin_historical');
  assert.deepEqual(t.build({ symbol: 'BTC' }), { route: 'coin/historical/BTC', query: {} });
  assert.deepEqual(t.build({ symbol: 'BTC', amount: 7, interval: 'd' }), {
    route: 'coin/historical/BTC',
    query: { amount: '7', interval: 'd' },
  });
  assert.deepEqual(t.build({ symbol: 'ETH', interval: 'h' }).query, { interval: 'h' });
});

// ── NLP tool output contract ────────────────────────────────────────────────
// ask_shumi and search_web shipped with no outputSchema, so a host had to guess
// that the payload was an answer string. Declaring one obliges every non-error
// return to carry structuredContent; these tests pin both halves together, since
// declaring the schema without the structured return is worse than neither.

test('every registered tool declares an outputSchema', () => {
  const registered = [];
  const server = {
    registerTool(name, config) {
      registered.push({ name, hasOutputSchema: Boolean(config.outputSchema) });
    },
  };
  registerTools(server);

  const missing = registered.filter((t) => !t.hasOutputSchema).map((t) => t.name);
  assert.deepEqual(missing, [], `tools without outputSchema: ${missing.join(', ')}`);
  assert.equal(registered.length, TYPED_TOOLS.length + 3); // + get_coin_risk, ask_shumi, search_web
});

test('answerResult puts prose in both content and structuredContent', () => {
  const r = answerResult({ text: 'Funding on SOL is +18% APR; longs pay.' });
  assert.equal(r.content[0].text, 'Funding on SOL is +18% APR; longs pay.');
  assert.equal(r.structuredContent.answer, 'Funding on SOL is +18% APR; longs pay.');
  assert.equal(r.structuredContent.steps, undefined);
});

test('answerResult falls back to steps rather than faking an answer', () => {
  // A JSON blob in `answer` would be a string that is not an answer.
  const r = answerResult({ steps: [{ tool: 'get_prices' }] });
  assert.equal(r.structuredContent.answer, undefined);
  assert.deepEqual(r.structuredContent.steps, [{ tool: 'get_prices' }]);
  assert.equal(r.content[0].text, JSON.stringify([{ tool: 'get_prices' }]));
});

test('answerResult always returns structuredContent, as the declared schema requires', () => {
  for (const res of [{ text: 'x' }, { steps: [] }, {}, null]) {
    assert.ok(answerResult(res).structuredContent, `structuredContent missing for ${JSON.stringify(res)}`);
  }
});

/**
 * `symbols` meant the same thing in get_coin_risk and get_prices but was typed
 * differently in each — an array in one, a comma-separated string in the other.
 * A model that learned the shape from one tool got a validation error from the
 * other. Both accept both now; these pin that so the divergence cannot return.
 */
test('get_prices accepts symbols as an array and as a comma-separated string', () => {
  const prices = TYPED_TOOLS.find((t) => t.name === 'get_prices');
  const schema = prices.inputSchema.symbols;

  const fromArray = schema.parse(['BTC', 'ETH']);
  const fromString = schema.parse('BTC,ETH');
  assert.deepEqual(fromArray, ['BTC', 'ETH']);
  assert.deepEqual(fromString, ['BTC', 'ETH']);

  // Whichever shape came in, the wire query is the comma-separated form.
  assert.equal(prices.build({ symbols: fromArray }).query.symbols, 'BTC,ETH');
  assert.equal(prices.build({ symbols: fromString }).query.symbols, 'BTC,ETH');
});

test('get_prices with no symbols still means "all tracked coins"', () => {
  const prices = TYPED_TOOLS.find((t) => t.name === 'get_prices');
  assert.equal(prices.build({}).query.symbols, undefined);
});

test('a comma-separated string tolerates spacing and empty entries', () => {
  const prices = TYPED_TOOLS.find((t) => t.name === 'get_prices');
  assert.deepEqual(prices.inputSchema.symbols.parse(' BTC , ETH ,'), ['BTC', 'ETH']);
});

/**
 * The SDK validates structuredContent against outputSchema and throws a
 * ProtocolError when it fails, so an over-strict schema does not merely
 * mis-describe a payload — it takes the tool down. These pin the properties
 * that keep that from happening.
 */
test('every typed data schema tolerates a payload it does not fully describe', () => {
  // `fields` and `top` let a caller request a SUBSET, and upstream adds keys
  // without notice. Both must validate.
  for (const [name, schema] of Object.entries(DATA_SCHEMAS)) {
    const subset = schema.safeParse({});
    const superset = schema.safeParse({ some_key_upstream_added_later: 'x' });
    // Array-shaped and union-shaped schemas legitimately reject a bare object;
    // for those, assert on the shape they do accept.
    if (!subset.success) {
      assert.ok(schema.safeParse([]).success, `${name}: rejects both {} and []`);
      continue;
    }
    assert.ok(superset.success, `${name}: rejects an unknown extra key`);
  }
});

test('data schemas are declared only for tools that have one, and are wired in', () => {
  const named = new Set(TYPED_TOOLS.map((t) => t.name));
  named.add('get_coin_risk'); // registered outside TYPED_TOOLS
  for (const name of Object.keys(DATA_SCHEMAS)) {
    assert.ok(named.has(name), `DATA_SCHEMAS has an entry for unknown tool ${name}`);
  }
});
