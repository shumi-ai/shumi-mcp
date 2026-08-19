/**
 * End-to-end verification harness. Exercises the real MCP server — every tool,
 * over a real transport — and prints a pass/fail matrix. This is the
 * pre-registry "is it bulletproof" check.
 *
 * Usage:
 *   SHUMI_TOKEN=shumi_sk_... node verify-live.mjs                 # local stdio
 *   SHUMI_TOKEN=shumi_sk_... node verify-live.mjs --remote        # deployed Render URL
 *   SHUMI_TOKEN=shumi_sk_... node verify-live.mjs --remote <url>  # any URL
 *   ... add --nlp to also exercise ask_shumi / search_web (slow, costs a query each)
 *
 * Notes:
 * - Each tool call consumes one query against your tier (free = 3 lifetime, so
 *   use an Access/Pro key for a full green sweep; a free key will show QUOTA
 *   after 3 calls — which still proves the funnel + error path).
 * - Without SHUMI_TOKEN every call should come back AUTH (clean error path).
 */
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const argv = process.argv.slice(2);
const remoteIdx = argv.indexOf('--remote');
const useRemote = remoteIdx !== -1;
const remoteUrl =
  useRemote && argv[remoteIdx + 1] && !argv[remoteIdx + 1].startsWith('--')
    ? argv[remoteIdx + 1]
    : 'https://shumi-mcp.onrender.com/mcp';
const withNlp = argv.includes('--nlp');
const token = process.env.SHUMI_TOKEN || '';

// Cheap typed tools first (one query each), with minimal valid args.
const CORE = [
  ['get_market_health', {}],
  ['get_global_market', {}],
  ['get_coin_risk', { symbols: ['BTC'] }],
  ['lookup_coin', { by: 'symbol', identifier: 'BTC' }],
  ['resolve_coin', { query: 'bitcoin', limit: 3 }],
  ['get_coin_sentiment', { symbol: 'BTC' }],
  ['get_coin_historical', { symbol: 'BTC' }],
  ['get_prices', { symbols: 'BTC,ETH' }],
  ['scan_trends', { state: 'fresh', top: 3 }],
  ['scan_coins', { trend: 'UP', top: 3 }],
  ['get_market_sentiment', { view: 'market' }],
  ['list_narratives', { top: 3 }],
  ['list_categories', { top: 3 }],
  ['get_funding_momentum', {}],
  ['get_funding_alerts', {}],
  ['get_regime', { view: 'active' }],
  ['get_signal', { symbol: 'BTC' }],
  ['get_signal_quality', { asset: 'BTC' }],
  ['get_pair_suggestions', { mode: 'suggestions', limit: 3 }],
];
const NLP = [
  ['ask_shumi', { query: 'What is the current market regime, in one sentence?' }],
  ['search_web', { query: 'latest Ethereum ETF flows', answer: true }],
];

function classify(res) {
  if (!res?.isError) {
    // typed tools must carry structuredContent; NLP tools may be text-only.
    return { status: 'OK', detail: res?.structuredContent ? 'structured' : 'text' };
  }
  let code = 'ERROR';
  let msg = '';
  try {
    const p = JSON.parse(res.content[0].text);
    code = p.error?.code || 'ERROR';
    msg = p.error?.message || '';
  } catch {
    msg = res.content?.[0]?.text?.slice(0, 60) || '';
  }
  if (code === 'AUTH_REQUIRED' || code === 'AUTH_INVALID') return { status: 'AUTH', detail: code };
  if (code === 'RATE_LIMITED' || code === 'PAYMENT_REQUIRED') return { status: 'QUOTA', detail: code };
  return { status: 'ERROR', detail: `${code} ${msg}`.trim() };
}

async function makeClient() {
  const client = new Client({ name: 'shumi-verify', version: '0' });
  if (useRemote) {
    const transport = new StreamableHTTPClientTransport(new URL(remoteUrl), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    });
    await client.connect(transport);
  } else {
    const transport = new StdioClientTransport({
      command: 'node',
      args: ['bin/shumi-mcp.js'],
      env: { ...process.env, SHUMI_NO_CONFIG: '1' },
    });
    await client.connect(transport);
  }
  return client;
}

async function main() {
  console.log(`Target: ${useRemote ? remoteUrl : 'local stdio (bin/shumi-mcp.js)'}`);
  console.log(`Token:  ${token ? token.slice(0, 10) + '… present' : 'NONE (expect all AUTH)'}\n`);

  const client = await makeClient();

  const { tools } = await client.listTools();
  const { resources } = await client.listResources();
  console.log(`tools/list: ${tools.length}  | resources: ${resources.length}`);
  const missingSchema = tools.filter((t) => !t.name.startsWith('ask') && t.name !== 'search_web' && !t.outputSchema);
  console.log(`typed tools missing outputSchema: ${missingSchema.length === 0 ? 'none ✓' : missingSchema.map((t) => t.name).join(', ')}\n`);

  const cases = withNlp ? [...CORE, ...NLP] : CORE;
  const counts = { OK: 0, AUTH: 0, QUOTA: 0, ERROR: 0 };
  for (const [name, args] of cases) {
    let line;
    try {
      const res = await client.callTool({ name, arguments: args });
      const { status, detail } = classify(res);
      counts[status]++;
      const mark = status === 'OK' ? '✓' : status === 'ERROR' ? '✗' : '•';
      line = `${mark} ${name.padEnd(22)} ${status.padEnd(6)} ${detail}`;
    } catch (err) {
      counts.ERROR++;
      line = `✗ ${name.padEnd(22)} THROW  ${err.message}`;
    }
    console.log(line);
  }

  console.log(`\nsummary: OK=${counts.OK} AUTH=${counts.AUTH} QUOTA=${counts.QUOTA} ERROR=${counts.ERROR}`);
  await client.close();

  // Bulletproof verdict: no protocol-level ERRORs/THROWs. AUTH/QUOTA are valid
  // outcomes (they prove the gating + error path), OK proves the data path.
  if (counts.ERROR > 0) {
    console.log('VERDICT: ✗ failures present — not ready to submit.');
    process.exit(1);
  }
  if (counts.OK === 0 && token) {
    console.log('VERDICT: ⚠ token present but no OK — likely out of quota; rerun with an Access/Pro key.');
    process.exit(1);
  }
  console.log('VERDICT: ✓ no protocol errors.' + (counts.OK ? ' Data path verified.' : ' (Add a token to verify the data path.)'));
}

main().catch((err) => {
  console.error('harness error:', err);
  process.exit(1);
});
