import { test } from 'node:test';
import assert from 'node:assert/strict';
import { result, boundPayload } from '../src/tools/util.js';

/**
 * Guards the context budget. Every case here is modelled on what production
 * actually returned on 2026-08-19, not on invented shapes:
 *
 *   get_market_sentiment   885 KB   838 KB of it one `sources` array of 4,569
 *   get_signal             270 KB   265 KB in raw.sentiment.data.sources (1,456)
 *   get_coin_sentiment     266 KB   265 KB in data.sources (1,456)
 *
 * None of that failed. It returned 200 and simply overflowed whatever context
 * the caller had, which is why only a size assertion catches it.
 */

const sources = (n) =>
  Array.from({ length: n }, (_, i) => ({
    url: `https://example.com/article-${i}-with-a-realistically-long-slug-here`,
    title: `Some headline number ${i} about the market and what it might mean`,
    source: 'example.com',
  }));

// The real shape: 22 rows, the first carrying an enormous provenance list.
const marketSentimentShape = () => [
  { id: 1, type: 'market', summary: 'Neutral with a hawkish tilt.', stance: 'neutral', sources: sources(4569) },
  ...Array.from({ length: 21 }, (_, i) => ({ id: i + 2, type: 'market', summary: 'x', stance: 'neutral', sources: sources(3) })),
];

test('the production payload that overflowed context is bounded', () => {
  const raw = marketSentimentShape();
  assert.ok(JSON.stringify(raw).length > 800_000, 'fixture must reproduce the real scale');
  const { data, truncated } = boundPayload(raw);
  const size = JSON.stringify(data).length;
  assert.ok(size <= 40_000, `bounded payload still ${size} bytes`);
  assert.ok(truncated?.some((t) => t.of === 4569), 'the 4,569-item list must be reported');
});

test('what survives is the part a trader asked for', () => {
  const { data } = boundPayload(marketSentimentShape());
  assert.equal(data[0].summary, 'Neutral with a hawkish tilt.');
  assert.equal(data[0].stance, 'neutral');
  assert.equal(data.length, 22, 'rows are kept; it is the giant nested list that is cut');
});

test('deeply nested lists are capped too, not just the top level', () => {
  // get_signal buried its 1,456 sources at raw.sentiment.data.sources.
  const { data, truncated } = boundPayload({ verdict: 'long', raw: { sentiment: { data: { sources: sources(1456) } } } });
  assert.equal(data.verdict, 'long');
  assert.ok(data.raw.sentiment.data.sources.length <= 50);
  assert.ok(truncated.some((t) => t.path.includes('sources') && t.of === 1456));
});

test('a normal response is passed through untouched and unannotated', () => {
  const small = { symbol: 'BTC', price: 64000, evidence: ['a', 'b', 'c'] };
  const { data, truncated } = boundPayload(small);
  assert.deepEqual(data, small);
  assert.equal(truncated, undefined);
  const r = result(small);
  assert.equal(r.content[0].text, JSON.stringify(small), 'no abridgement notice on an intact payload');
  assert.equal(r.structuredContent.meta, undefined);
});

test('an abridged result says so in the text block, not only in meta', () => {
  // A model that reads only `content` would otherwise treat a cut list as whole.
  const r = result(marketSentimentShape(), { summary: 'Market: neutral' });
  const text = r.content[0].text;
  assert.ok(text.startsWith('Market: neutral\n'), 'the tool summary still leads');
  assert.match(text, /\[abridged: .*of 4569/);
  assert.ok(Array.isArray(r.structuredContent.meta._truncated));
});

test('an existing meta is preserved alongside the truncation record', () => {
  const r = result(marketSentimentShape(), { meta: { source: 'cache' } });
  assert.equal(r.structuredContent.meta.source, 'cache');
  assert.ok(r.structuredContent.meta._truncated.length > 0);
});

test('a payload that is huge in strings rather than lists is still bounded', () => {
  const { data } = boundPayload({ note: 'x'.repeat(500_000) });
  assert.ok(JSON.stringify(data).length <= 40_000);
  assert.match(data.note, /…\[truncated\]$/);
});
