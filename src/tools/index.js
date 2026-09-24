import { z } from 'zod';
import { apiGet, askQuery, ApiError } from '../http-client.js';
import { toMcpError } from '../errorMap.js';
import { unwrap, applyFilters, result } from './util.js';
import { KNOWN_EXCHANGES, canonicalExchange, categoryNames, closestNames, resolveName, rowsOf } from './scanResolve.js';

/**
 * Tool registry for the Shumi MCP server. Each typed tool maps 1:1 to a
 * coinrotator-ai `/api/cli/*` route (the same routes the shumi CLI calls), so
 * gating/tiers/x402 apply server-side unchanged. Tools are outcome-named, use
 * enum'd params where the CLI does, and are flagged read-only.
 *
 * `TYPED_TOOLS` is also consumed by the `shumi://capabilities` resource so the
 * data surface is described in exactly one place.
 */

const INTERVAL = z.enum(['1d', '1w']).describe('Trend interval: 1d (daily) or 1w (weekly).');

// Default cap on list-returning tools so a naive call can't dump the whole
// universe into the model's context (token cost). Callers raise/lower via `top`.
const DEFAULT_LIST_CAP = 50;

export const FUNDING_MOMENTUM_DESCRIPTION =
  'Perpetual funding-rate positioning context, market-wide or for one symbol. APR is already in percent units (1.7 = 1.7%). Positive funding means longs pay and shorts receive; negative funding means shorts pay and longs receive. Funding is context only, not a standalone directional, timing, or entry signal.';

export const COIN_RISK_DESCRIPTION =
  'Bundled risk context for one or more coins: price, funding APR, deterministic funding_paying_side, funding_receiving_side, carry_if_long and carry_if_short fields, daily/weekly trend, sentiment stance, and BTC correlation. Funding applies to perpetual positions only; spot positions neither pay nor receive it. Relay the carry fields exactly rather than inferring direction from crowding. The best single tool for "should I be worried about X".';

// Permissive shared output schema. The server's `{ data, meta }` envelope is
// always a JSON object, so this validates while we leave the inner data shape
// open. Per-tool tightening is a fast-follow once we capture live payloads.
/** The envelope, with `data` typed for the tools we have a verified shape for. */
function outputSchemaFor(toolName) {
  const dataSchema = DATA_SCHEMAS[toolName];
  return dataSchema ? { ...SHARED_OUTPUT_SCHEMA, data: dataSchema } : SHARED_OUTPUT_SCHEMA;
}

const SHARED_OUTPUT_SCHEMA = {
  data: z.unknown().describe('The tool payload, unwrapped from the CLI envelope.'),
  meta: z.unknown().optional().describe('Envelope metadata. Carries `_truncated` when a list was abridged to fit the response budget.'),
};

/**
 * A list of coin symbols, accepted either as an array or as a comma-separated
 * string, and normalised to an array.
 *
 * `get_coin_risk` took `symbols` as an array while `get_prices` took the same
 * parameter name as a comma-separated string. A model that learned the shape
 * from one tool sent it to the other and got a validation error, for a
 * parameter meaning exactly the same thing in both. Rather than pick a winner
 * and break whichever callers learned the other, both now accept both.
 */
const SYMBOL_LIST = z
  .union([z.array(z.string().min(1)), z.string().min(1)])
  .transform((v) => (Array.isArray(v) ? v : v.split(',').map((t) => t.trim()).filter(Boolean)));

// The two NLP tools return prose, not an envelope, so SHARED_OUTPUT_SCHEMA does
// not describe them. They shipped with no outputSchema at all, which left them
// the only tools a host could not introspect — it had to guess that the payload
// was an answer string. Declaring a schema also obliges every non-error return
// to carry structuredContent, which is why answerResult() exists rather than the
// two ad-hoc returns that were here before.
const ANSWER_OUTPUT_SCHEMA = {
  answer: z.string().optional().describe('The synthesized natural-language answer. Absent only when the engine produced no prose.'),
  steps: z.unknown().optional().describe('Raw engine steps. Present only as a fallback when `answer` is absent.'),
};

/**
 * Shape an NLP engine response for both content-only and structured hosts.
 *
 * `answer` is optional rather than required because the engine can legitimately
 * return steps with no prose, and filling `answer` with a JSON blob to satisfy a
 * required field would hand the caller a string that is not an answer.
 */
function answerResult(res) {
  const text = res?.text;
  if (text) return { content: [{ type: 'text', text }], structuredContent: { answer: text } };
  const steps = res?.steps ?? res;
  return { content: [{ type: 'text', text: JSON.stringify(steps) }], structuredContent: { steps } };
}

/**
 * The current trend lives in `currentTrend`, computed server-side from the last COMPLETE day.
 * `trends` is the run history, and its last row used to be read as "the trend now" — which
 * during the 00:20–01:30 UTC cron window was a half-written day. Older backends do not send
 * `currentTrend`, hence the fallback sentence.
 */
export const LOOKUP_COIN_DESCRIPTION =
  'Look up a single coin and its core metrics (price, trend, metadata) by symbol, name, CoinGecko/internal id, or on-chain contract address. ' +
  'Read the coin\'s CURRENT trend from `currentTrend` ({ trend: UP|DOWN|HODL, since, days, asOf, incompleteDayExcluded }; `currentTrendWeekly` when present is the weekly one), not from the last row of `trends` — `trends` is the history of past trend runs. ' +
  'Quote it as "<trend> since <since> (<days> days, as of <asOf>)". Only when `currentTrend` is absent, fall back to the last `trends` row.';

/**
 * `/api/coins/filter` sort keys. change24h / change7d answer movers questions ("what's pumping",
 * "top gainers/losers today / this week").
 */
export const SCAN_SORT_FIELDS = ['marketCap', 'change24h', 'change7d', 'streak', 'price'];

export const SCAN_COINS_DESCRIPTION =
  'Filter the tracked universe by trend direction, category, market-cap band, and exchange, and sort the result. ' +
  'For movers questions ("what\'s pumping", "top gainers/losers today", "biggest movers") use sort_by="change24h" ("change7d" for the week) — sort_order="desc" for gainers, "asc" for losers — ' +
  'and quote each row\'s change from the row itself (`change_24h_pct` / `change_7d_pct`, or `change24h` / `change7d`). With the default marketCap sort rows are plain coin names; ' +
  'a change sort may return `{ rows: [...] }` with a coverage summary instead of a bare list. ' +
  'category and exchange are matched by exact name: pass ONE category per call (e.g. "Meme", "Layer-2"; see list_categories), and exchanges by their full name (e.g. "Binance", "Coinbase Exchange"). ' +
  'A near-miss category is resolved to its real name; an unknown one returns an error listing the closest names, not an empty list.';

export const TYPED_TOOLS = [
  {
    name: 'lookup_coin',
    title: 'Look up a coin',
    description: LOOKUP_COIN_DESCRIPTION,
    inputSchema: {
      by: z.enum(['symbol', 'name', 'id', 'contract']).default('symbol').describe('How `identifier` is interpreted.'),
      identifier: z.string().min(1).describe('The symbol (BTC), name (Bitcoin), id (bitcoin), or contract address.'),
      chain: z
        .string()
        .optional()
        .describe('Chain for contract lookups (ethereum, bsc, solana, base, …). Required when by="contract".'),
    },
    build: ({ by, identifier, chain }) => {
      const id = encodeURIComponent(identifier);
      switch (by) {
        case 'name':
          return { route: `coin/by-name/${id}` };
        case 'id':
          return { route: `coin/by-id/${id}` };
        case 'contract':
          if (!chain) throw new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'chain is required when by="contract".' } });
          return { route: `coin/by-contract/${id}`, query: { chain } };
        case 'symbol':
        default:
          return { route: 'coin/lookup', query: { symbol: identifier } };
      }
    },
  },
  {
    name: 'resolve_coin',
    title: 'Resolve a coin (fuzzy)',
    description:
      'Fuzzily resolve a symbol, name, or contract to canonical coin candidates. Use this first when the user input is ambiguous, before calling other tools.',
    inputSchema: {
      query: z.string().min(1).describe('Symbol, name, or contract to resolve.'),
      limit: z.number().int().positive().max(50).optional().describe('Max candidates to return.'),
    },
    build: ({ query, limit }) => ({ route: 'resolve', query: { q: query, limit } }),
  },
  {
    name: 'get_coin_sentiment',
    title: 'Coin sentiment',
    description: 'On-chain/social sentiment aggregates for a single coin.',
    inputSchema: { symbol: z.string().min(1).describe('Coin symbol, e.g. BTC.') },
    build: ({ symbol }) => ({ route: `coin/sentiment/${encodeURIComponent(symbol)}` }),
  },
  {
    name: 'get_coin_historical',
    title: 'Coin metrics at a past point in time',
    description:
      'Market cap, volume, open interest, funding rate and price for a coin AS OF a chosen point in the past. Returns a single snapshot, not a series: call it once per point you want to compare (e.g. amount=7 interval=d for a week ago, then again with no offset for now). Use this to answer "how has funding/open interest changed since…".',
    inputSchema: {
      symbol: z.string().min(1).describe('Coin symbol, e.g. ETH.'),
      amount: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('How far back to look, in units of `interval`. Omit for the most recent snapshot.'),
      interval: z.enum(['h', 'd']).optional().describe('Unit for `amount`: h (hours) or d (days). Defaults to hours.'),
    },
    // The route has always taken these; the tool simply never passed them, so
    // every call returned "now" and the tool could not answer the historical
    // question its own name promises. Verified against production: amount=5&
    // interval=d returns a materially different snapshot from the bare call.
    build: ({ symbol, amount, interval }) => ({
      route: `coin/historical/${encodeURIComponent(symbol)}`,
      query: { ...(amount != null ? { amount: String(amount) } : {}), ...(interval ? { interval } : {}) },
    }),
  },
  {
    name: 'get_market_health',
    title: 'Market health',
    description: 'Overall market health: the UP/HODL/DOWN trend distribution and extreme movers. Set context for the full bundle.',
    inputSchema: { context: z.boolean().optional().describe('Include the full market-context bundle (breadth velocity, regime age, leadership).') },
    build: ({ context }) => ({ route: 'market/health', query: context ? { context: '1' } : {} }),
  },
  {
    name: 'get_global_market',
    title: 'Global market aggregates',
    description: 'Global market aggregates: BTC dominance, total market cap, total volume.',
    inputSchema: {},
    build: () => ({ route: 'market/global' }),
  },
  {
    name: 'get_market_crossing',
    title: 'Market trend crossing',
    description:
      'The most recent regime crossing — when one trend cohort (UP/HODL/DOWN) overtook another market-wide. Answers "has the market flipped?". Returns an empty `crossings` array plus a message when no crossing has fired.',
    inputSchema: {},
    build: () => ({ route: 'market/crossing' }),
  },
  {
    name: 'get_prices',
    title: 'Bulk live prices',
    description: 'Bulk live prices, optionally with 4h/24h/7d baseline overlays. Omit symbols for the full tracked set.',
    inputSchema: {
      symbols: SYMBOL_LIST.optional().describe('Symbols as an array ["BTC","ETH"] or a comma-separated string "BTC,ETH". Omit for all tracked coins.'),
      baselines: z.boolean().optional().describe('Include 4h/24h/7d baseline price overlay.'),
    },
    listFilters: true,
    // The route takes a comma-separated string on the wire regardless of the
    // shape the caller used.
    build: ({ symbols, baselines }) => ({
      route: 'market/prices',
      query: { symbols: symbols?.length ? symbols.join(',') : undefined, ...(baselines ? { baselines: '1' } : {}) },
    }),
  },
  {
    name: 'scan_trends',
    title: 'Scan trends',
    description:
      'Trend scanner. state=fresh (newly started), stale (longest running), aligned (multi-timeframe agreement), extreme (biggest moves), historical.',
    inputSchema: {
      state: z.enum(['fresh', 'stale', 'aligned', 'extreme', 'historical']).default('fresh').describe('Which trend slice to return.'),
      interval: INTERVAL.optional(),
      limit: z.number().int().positive().max(200).optional().describe('Max results.'),
    },
    listFilters: true,
    build: ({ state, interval, limit }) => ({ route: 'trends', query: { action: state, interval, limit } }),
  },
  {
    name: 'scan_coins',
    title: 'Scan / filter coins',
    description: SCAN_COINS_DESCRIPTION,
    inputSchema: {
      trend: z.enum(['UP', 'HODL', 'DOWN']).optional().describe('Filter by trend direction.'),
      category: z
        .string()
        .optional()
        .describe('ONE category, by its exact name, e.g. "Meme" or "Layer-2" (list_categories has the names). Comma-joined values match nothing; call once per category.'),
      mcap_min: z.number().optional().describe('Minimum market cap in USD.'),
      mcap_max: z.number().optional().describe('Maximum market cap in USD.'),
      exchange: z
        .string()
        .optional()
        .describe('Filter by exchange listing, full venue name, e.g. "Binance", "Coinbase Exchange", "OKX" ("Coinbase" is mapped for you).'),
      interval: INTERVAL.optional(),
      limit: z.number().int().positive().max(200).optional().describe('Max results.'),
      sort_by: z
        .enum(SCAN_SORT_FIELDS)
        .optional()
        .describe('Sort key (default marketCap). change24h / change7d = 24h / 7d price change, for movers / "what\'s pumping" questions.'),
      sort_order: z.enum(['asc', 'desc']).optional().describe('desc (default) = largest first; asc = smallest first (e.g. biggest 24h losers).'),
    },
    listFilters: true,
    run: (args, get) => runScan(args, get),
    // The upstream /api/coins/filter reads categories / marketCapMin / marketCapMax / exchanges /
    // sortBy / sortOrder. It silently ignores unknown keys, so sending the old snake_case names
    // meant the category, market-cap and exchange filters never applied (a scan with
    // mcap_max=1000000 returned Bitcoin first).
    build: ({ trend, category, mcap_min, mcap_max, exchange, interval, limit, sort_by, sort_order }) => ({
      route: 'scan',
      query: {
        trend,
        categories: category,
        marketCapMin: mcap_min,
        marketCapMax: mcap_max,
        exchanges: exchange,
        interval,
        limit,
        sortBy: sort_by,
        sortOrder: sort_order,
      },
    }),
  },
  {
    name: 'get_market_sentiment',
    title: 'Market sentiment',
    description:
      'Aggregate market sentiment. view=market/latest/summary (overall), narratives, categories, slopes/entity-slopes (what is trending), health (pipeline status).',
    inputSchema: {
      view: z
        .enum(['market', 'latest', 'summary', 'narratives', 'categories', 'health', 'slopes', 'entity-slopes'])
        .default('market')
        .describe('Which sentiment view to return.'),
    },
    listFilters: true,
    build: ({ view }) => ({ route: 'sentiment', query: { action: view } }),
  },
  {
    name: 'list_narratives',
    title: 'List narratives',
    description: 'List the currently active market narratives (e.g. "AI coins", "DeFi summer").',
    inputSchema: {},
    listFilters: true,
    build: () => ({ route: 'narratives' }),
  },
  {
    name: 'get_narrative',
    title: 'Narrative sentiment',
    description: 'Sentiment and momentum for a single named narrative.',
    inputSchema: { name: z.string().min(1).describe('Narrative name, e.g. "AI coins".') },
    build: ({ name }) => ({ route: 'sentiment', query: { action: 'narrative', name } }),
  },
  {
    name: 'list_categories',
    title: 'List categories',
    description: 'List tracked crypto categories by their exact names (e.g. "Meme", "Layer-2"), the names scan_coins expects.',
    inputSchema: {},
    listFilters: true,
    build: () => ({ route: 'category/list' }),
  },
  {
    name: 'get_category',
    title: 'Category detail',
    description: 'Detail for one category. view=info (trend breakdown), coins (member coins), sentiment.',
    inputSchema: {
      name: z.string().min(1).describe('Category name, e.g. "Layer 2".'),
      view: z.enum(['info', 'coins', 'sentiment']).default('info').describe('Which category view to return.'),
    },
    listFilters: true,
    build: ({ name, view }) => ({ route: `category/${view}/${encodeURIComponent(name)}` }),
  },
  {
    name: 'get_funding_momentum',
    title: 'Funding momentum',
    description: FUNDING_MOMENTUM_DESCRIPTION,
    inputSchema: { symbol: z.string().optional().describe('Restrict to one symbol, e.g. BTC. Omit for the market-wide view.') },
    build: ({ symbol }) => ({ route: 'funding/momentum', query: { symbol } }),
  },
  {
    name: 'get_funding_alerts',
    title: 'Funding alerts',
    description: 'Discrete funding-rate alert events (asset, trigger zone, funding at trigger, fired-at time).',
    inputSchema: {},
    listFilters: true,
    build: () => ({ route: 'funding/alerts' }),
  },
  {
    name: 'get_regime',
    title: 'Market regime',
    description:
      'Market regime signals. view=active (current positions), signals (all), confidence (scores). Provide symbol to get that symbol\'s regime history instead.',
    inputSchema: {
      view: z.enum(['active', 'signals', 'confidence']).default('active').describe('Which regime view to return (ignored when symbol is set).'),
      symbol: z.string().optional().describe('If set, returns regime history for this symbol.'),
    },
    build: ({ view, symbol }) =>
      symbol ? { route: 'regime', query: { action: 'history', symbol } } : { route: 'regime', query: { action: view } },
  },
  {
    name: 'get_signal',
    title: 'Synthesized signal',
    description: 'Synthesized verdict for a coin, combining trend, funding, sentiment and regime.',
    inputSchema: { symbol: z.string().min(1).describe('Coin symbol, e.g. SOL.') },
    build: ({ symbol }) => ({ route: `signal/${encodeURIComponent(symbol)}` }),
  },
  {
    name: 'get_signal_quality',
    title: 'Signal quality',
    description: 'Signal validation envelope for an asset: Sharpe ratio, win rate, sample size, reliability tier.',
    inputSchema: {
      asset: z.string().min(1).describe('Asset symbol, e.g. BTC.'),
      signal_type: z.string().optional().describe('Signal type (default: mean_reversion).'),
    },
    build: ({ asset, signal_type }) => ({ route: 'signal-quality', query: { asset, signal_type } }),
  },
  {
    name: 'get_pair_suggestions',
    title: 'Pair / delta-neutral suggestions',
    description:
      'Pair-trading and delta-neutral funding-arbitrage intelligence. mode=suggestions (pair ideas), delta-neutral (funding arb), history (backtest), signal (state for a specific pair — needs token_a & token_b).',
    inputSchema: {
      mode: z.enum(['suggestions', 'delta-neutral', 'history', 'signal']).default('suggestions').describe('Which pair view to return.'),
      symbol: z.string().optional().describe('Filter by symbol (suggestions / delta-neutral).'),
      exchange: z.string().optional().describe('Filter by exchange (delta-neutral).'),
      dex_only: z.boolean().optional().describe('DEX exchanges only (delta-neutral).'),
      token_a: z.string().optional().describe('First token (required for mode="signal"), e.g. ETH.'),
      token_b: z.string().optional().describe('Second token (required for mode="signal"), e.g. SOL.'),
      limit: z.number().int().positive().max(100).optional().describe('Max results.'),
    },
    listFilters: true,
    build: ({ mode, symbol, exchange, dex_only, token_a, token_b, limit }) => {
      if (mode === 'signal') {
        if (!token_a || !token_b) {
          throw new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'token_a and token_b are required when mode="signal".' } });
        }
        return { route: 'pairs', query: { action: 'signal', tokenA: token_a, tokenB: token_b } };
      }
      if (mode === 'history') return { route: 'pairs', query: { action: 'history' } };
      return {
        route: 'pairs',
        query: { action: mode, symbol, exchange, ...(dex_only ? { 'dex-only': '1' } : {}), limit },
      };
    },
  },
  {
    name: 'list_rwa_assets',
    title: 'List real-world assets',
    description:
      'List the tradable real-world assets — stocks and ETFs (AAPL, NVDA, SPY), metals and commodities (GOLD, SILVER, BRENT), stock indices (SP500, JP225) and FX. These trade as perps on Hyperliquid builder DEXes and are NOT crypto tokens; the crypto tools will not find them. Use this to answer "which stocks/commodities can I look at?".',
    inputSchema: {
      type: z.enum(['equity', 'etf', 'commodity', 'index', 'fx']).optional().describe('Filter by asset class.'),
      dex: z.string().optional().describe('Filter by builder-DEX slug, e.g. "xyz".'),
      top: z.number().int().positive().max(1000).optional().describe('Max assets to return (server default 200; the full universe is ~94).'),
    },
    // Deliberately no listFilters: the RWA universe is ~94 metadata-only rows, and the
    // shared 50-item default cap would silently hide a third of it from "what's available".
    build: ({ type, dex, top }) => ({ route: 'rwa/assets', query: { type, dex, top } }),
  },
  {
    name: 'get_rwa_asset',
    title: 'Real-world asset detail',
    description:
      'Price, daily/weekly trend and perp funding for one real-world asset (stock, ETF, commodity, index, FX). Look up by ticker (AAPL, GOLD) or by namespaced id (xyz:AAPL). Funding belongs to the PERPETUAL CONTRACT, not the underlying — `funding.apr` is the annualized rate in percent, `funding.rate` is the raw per-hour fraction. Do not use the crypto coin tools for these.',
    inputSchema: {
      by: z.enum(['symbol', 'id']).default('symbol').describe('How `identifier` is interpreted.'),
      identifier: z.string().min(1).describe('Ticker (AAPL, GOLD, SP500) or namespaced id (xyz:AAPL).'),
    },
    build: ({ by, identifier }) => {
      const id = encodeURIComponent(identifier);
      return { route: by === 'id' ? `rwa/asset/${id}` : `rwa/symbol/${id}` };
    },
  },
  {
    name: 'get_holders',
    title: 'Token holder tracking',
    description:
      'Tracked token-holder cohorts. view=watchlist (which token contracts are tracked), movements (recent holder-count changes for one contract). Answers "is the holder base growing or bleeding?".',
    inputSchema: {
      view: z.enum(['watchlist', 'movements']).default('watchlist').describe('Which holder view to return.'),
      contract: z.string().optional().describe('Token contract address. Required when view="movements".'),
      limit: z.number().int().positive().max(200).optional().describe('Max results.'),
    },
    listFilters: true,
    build: ({ view, contract, limit }) => {
      if (view === 'movements' && !contract) {
        throw new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'contract is required when view="movements".' } });
      }
      return { route: 'holders', query: { action: view, contract, limit } };
    },
  },
  {
    name: 'get_wallets',
    title: 'Wallet tracking',
    description:
      'Tracked wallets. view=watchlist (which wallets are tracked), movements (recent balance changes for one wallet address). Answers "what did this wallet do recently?".',
    inputSchema: {
      view: z.enum(['watchlist', 'movements']).default('watchlist').describe('Which wallet view to return.'),
      address: z.string().optional().describe('Wallet address. Required when view="movements".'),
      limit: z.number().int().positive().max(200).optional().describe('Max results.'),
    },
    listFilters: true,
    build: ({ view, address, limit }) => {
      if (view === 'movements' && !address) {
        throw new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'address is required when view="movements".' } });
      }
      return { route: 'wallets', query: { action: view, address, limit } };
    },
  },
  {
    name: 'get_futures_signals',
    title: 'Futures signals',
    description:
      'Perpetual-futures signal engine. view=state (currently open signals), log (recent fires), history (one asset\'s past signals — needs asset).',
    inputSchema: {
      view: z.enum(['state', 'log', 'history']).default('state').describe('Which futures view to return.'),
      asset: z.string().optional().describe('Asset symbol, e.g. BTC. Required when view="history".'),
    },
    listFilters: true,
    build: ({ view, asset }) => {
      if (view === 'history' && !asset) {
        throw new ApiError(400, { error: { code: 'BAD_REQUEST', message: 'asset is required when view="history".' } });
      }
      return { route: 'futures', query: { action: view, asset } };
    },
  },
  {
    name: 'get_basket',
    title: 'Basket snapshots',
    description: 'Daily snapshots of the tracked basket — composition and performance over time.',
    inputSchema: {},
    listFilters: true,
    build: () => ({ route: 'basket' }),
  },
  {
    name: 'get_transcripts',
    title: 'Transcript highlights',
    description:
      'Highlights mined from tracked video/podcast transcripts. view=highlights (extracted claims with the coins, sectors and macro tags they mention), sources (which channels are tracked). Answers "what are people actually saying about X?".',
    inputSchema: {
      view: z.enum(['highlights', 'sources']).default('highlights').describe('Which transcript view to return.'),
    },
    listFilters: true,
    build: ({ view }) => ({ route: 'transcripts', query: { action: view } }),
  },
  // NOT exposed: /api/cli/walkforward. The route exists and the CLI ships all three of its
  // actions, but two of them have nothing behind them — TrendPositions is empty and
  // TrendOutcomes holds a single row from 2026-05-28 — because Engine B is paused. Only
  // `signals` returns anything, and thinly (10 rows in the last 7 days). Add the tool when the
  // engine resumes; shipping it now would hand a paying caller an empty array with no reason.
  //
  // NOT exposed: /api/cli/watch/:stream. It is SSE, which does not fit MCP tool semantics.
];

/**
 * Per-tool shapes for the `data` field, so a client can see what a tool
 * returns without calling it — which is most of the point of declaring an
 * outputSchema at all. Tools absent from this map keep the untyped envelope.
 *
 * Every schema is permissive on purpose: all fields optional, objects `.loose()`.
 * That is not laziness, it is a correctness requirement. The SDK validates
 * structuredContent against outputSchema and throws a ProtocolError when it
 * fails, so a schema that is too strict does not mis-describe a payload — it
 * takes the whole tool down the first time upstream adds or nulls a field.
 * `fields` and `top` also let a caller ask for a SUBSET of the payload, so
 * required keys would break those callers by construction.
 *
 * Shapes were derived from a live sweep on a pro-tier account (2026-08-24);
 * each entry records the command whose real response it came from.
 */
const CURRENT_TREND = z.object({
  "trend": z.string().nullable().optional(),
  "since": z.string().nullable().optional(),
  "days": z.number().nullable().optional(),
  "asOf": z.string().nullable().optional(),
  "weeks": z.number().nullable().optional(),
  "incompleteDayExcluded": z.boolean().nullable().optional(),
}).loose();

export const DATA_SCHEMAS = {
  // verified against `shumi coin lookup BTC`
  lookup_coin: z.object({
    "coin": z.record(z.string(), z.unknown()).nullable().optional(),
    "trends": z.array(z.unknown()).nullable().optional(),
    "latestBands": z.record(z.string(), z.unknown()).nullable().optional(),
    "band_position": z.record(z.string(), z.unknown()).nullable().optional(),
    "average_streak": z.number().nullable().optional(),
    // Added by coinrotator-ai (epic movers-and-current-trend). Optional so an older backend
    // that does not send it still validates.
    "currentTrend": CURRENT_TREND.nullable().optional(),
    "currentTrendWeekly": CURRENT_TREND.nullable().optional(),
  }).loose(),
  // verified against `shumi resolve wif`
  resolve_coin: z.object({
    "query": z.string().nullable().optional(),
    "tried": z.array(z.unknown()).nullable().optional(),
    "matches": z.array(z.unknown()).nullable().optional(),
    "count": z.number().nullable().optional(),
  }).loose(),
  // verified against `shumi coin sentiment BTC`
  get_coin_sentiment: z.object({
    "success": z.boolean().nullable().optional(),
    "symbol": z.string().nullable().optional(),
    "data": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi coin historical BTC`
  get_coin_historical: z.object({
    "marketCap": z.unknown().optional(),
    "volume": z.unknown().optional(),
    "openInterest": z.string().nullable().optional(),
    "fundingRate": z.string().nullable().optional(),
    "futuresVolume24h": z.string().nullable().optional(),
    "priceUSD": z.number().nullable().optional(),
  }).loose(),
  // verified against `shumi market health`
  get_market_health: z.object({
    "date": z.string().nullable().optional(),
    "trends": z.record(z.string(), z.unknown()).nullable().optional(),
    "hasExtremes": z.boolean().nullable().optional(),
    "extremes": z.array(z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi market global`
  get_global_market: z.object({
    "totalMarketCap": z.record(z.string(), z.unknown()).nullable().optional(),
    "totalMarketVolume": z.record(z.string(), z.unknown()).nullable().optional(),
    "marketCapPercentage": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi market crossing`
  get_market_crossing: z.object({
    "crossings": z.array(z.unknown()).nullable().optional(),
    "message": z.string().nullable().optional(),
  }).loose(),
  // verified against `shumi trends fresh`
  scan_trends: z.array(z.unknown()),
  // verified against `shumi scan`. coinrotator-ai#378 may wrap change-sort rows with a
  // coverage summary as { rows: [...] }; both shapes must validate or the tool goes down.
  scan_coins: z.union([
    z.array(z.unknown()),
    z.object({ "rows": z.array(z.unknown()).nullable().optional() }).loose(),
  ]),
  // verified against `shumi sentiment latest`
  get_market_sentiment: z.object({
    "success": z.boolean().nullable().optional(),
    "data": z.array(z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi narratives`
  list_narratives: z.object({
    "success": z.boolean().nullable().optional(),
    "interval": z.string().nullable().optional(),
    "periods_back": z.number().nullable().optional(),
    "total_count": z.number().nullable().optional(),
    "analysis_type": z.string().nullable().optional(),
    "cache_age_minutes": z.unknown().optional(),
    "freshness_config": z.record(z.string(), z.unknown()).nullable().optional(),
    "surfaces": z.record(z.string(), z.unknown()).nullable().optional(),
    "narratives": z.array(z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi category list`
  list_categories: z.array(z.unknown()),
  // verified against `shumi funding momentum`
  get_funding_momentum: z.object({
    "timestamp": z.string().nullable().optional(),
    "market": z.record(z.string(), z.unknown()).nullable().optional(),
    "distribution": z.record(z.string(), z.unknown()).nullable().optional(),
    "assets": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi funding alerts`
  get_funding_alerts: z.object({
    "events": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi regime active`
  get_regime: z.object({
    "positions": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi signal BTC`
  get_signal: z.object({
    "symbol": z.string().nullable().optional(),
    "verdict": z.string().nullable().optional(),
    "score": z.number().nullable().optional(),
    "confidence": z.string().nullable().optional(),
    "as_of": z.string().nullable().optional(),
    "evidence": z.array(z.unknown()).nullable().optional(),
    "sources": z.record(z.string(), z.unknown()).nullable().optional(),
    "raw": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi pairs suggestions`
  get_pair_suggestions: z.object({
    "suggestions": z.array(z.unknown()).nullable().optional(),
    "timestamp": z.string().nullable().optional(),
    "totalPairsAnalyzed": z.number().nullable().optional(),
    "filters": z.record(z.string(), z.unknown()).nullable().optional(),
    "algorithm": z.string().nullable().optional(),
    "disclaimer": z.string().nullable().optional(),
    "gateStats": z.record(z.string(), z.unknown()).nullable().optional(),
    "concentrationWarnings": z.array(z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi holders watchlist`
  get_holders: z.object({
    "watchlist": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi wallets watchlist`
  get_wallets: z.object({
    "watchlist": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi futures state`
  get_futures_signals: z.object({
    "signals": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi basket`
  get_basket: z.object({
    "snapshots": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi transcripts sources`
  get_transcripts: z.object({
    "sources": z.array(z.unknown()).nullable().optional(),
    "meta": z.record(z.string(), z.unknown()).nullable().optional(),
  }).loose(),
  // verified against `shumi coin risk BTC`. One row for a single symbol,
  // an array when several were asked for — registerCoinRisk returns rows[0]
  // only when there is exactly one.
  get_coin_risk: z.union([
  z.object({
      "symbol": z.string().nullable().optional(),
      "coin_id": z.string().nullable().optional(),
      "price": z.number().nullable().optional(),
      "price_source": z.string().nullable().optional(),
      "price_as_of": z.string().nullable().optional(),
      "funding_rate": z.number().nullable().optional(),
      "funding_rate_unit": z.string().nullable().optional(),
      "funding_interval_hours": z.number().nullable().optional(),
      "funding_apr": z.number().nullable().optional(),
      "funding_apr_unit": z.string().nullable().optional(),
      "funding_scope": z.string().nullable().optional(),
      "funding_paying_side": z.string().nullable().optional(),
      "funding_receiving_side": z.string().nullable().optional(),
      "carry_if_long": z.string().nullable().optional(),
      "carry_if_short": z.string().nullable().optional(),
      "funding_interpretation": z.string().nullable().optional(),
      "trend_daily": z.string().nullable().optional(),
      "trend_daily_since": z.string().nullable().optional(),
      "trend_weekly": z.string().nullable().optional(),
      "trend_weekly_since": z.string().nullable().optional(),
      "sentiment_stance": z.string().nullable().optional(),
      "sentiment_summary": z.string().nullable().optional(),
      "btc_correlation": z.unknown().optional(),
    }).loose(),
    z.array(
  z.object({
      "symbol": z.string().nullable().optional(),
      "coin_id": z.string().nullable().optional(),
      "price": z.number().nullable().optional(),
      "price_source": z.string().nullable().optional(),
      "price_as_of": z.string().nullable().optional(),
      "funding_rate": z.number().nullable().optional(),
      "funding_rate_unit": z.string().nullable().optional(),
      "funding_interval_hours": z.number().nullable().optional(),
      "funding_apr": z.number().nullable().optional(),
      "funding_apr_unit": z.string().nullable().optional(),
      "funding_scope": z.string().nullable().optional(),
      "funding_paying_side": z.string().nullable().optional(),
      "funding_receiving_side": z.string().nullable().optional(),
      "carry_if_long": z.string().nullable().optional(),
      "carry_if_short": z.string().nullable().optional(),
      "funding_interpretation": z.string().nullable().optional(),
      "trend_daily": z.string().nullable().optional(),
      "trend_daily_since": z.string().nullable().optional(),
      "trend_weekly": z.string().nullable().optional(),
      "trend_weekly_since": z.string().nullable().optional(),
      "sentiment_stance": z.string().nullable().optional(),
      "sentiment_summary": z.string().nullable().optional(),
      "btc_correlation": z.unknown().optional(),
    }).loose(),
    ),
  ]),

};

function badRequest(message) {
  return new ApiError(400, { error: { code: 'BAD_REQUEST', message } });
}

const CATEGORY_LIST_TTL_MS = 60 * 60 * 1000;
let categoryListCache = null;

/** Category names, cached for an hour: they change with the nightly job, not per call. */
async function knownCategories(get) {
  if (categoryListCache && Date.now() - categoryListCache.at < CATEGORY_LIST_TTL_MS) return categoryListCache.names;
  const names = categoryNames(unwrap(await get('category/list', {})));
  categoryListCache = { at: Date.now(), names };
  return names;
}

/** Test seam: forget the cached category list. */
export function resetCategoryCache() {
  categoryListCache = null;
}

const list = (names) => names.map((n) => `"${n}"`).join(', ');

/**
 * scan_coins with name resolution. The scan runs as asked; only when it comes back empty
 * with a category or exchange filter set is the filter checked, so a correct name costs
 * nothing extra. A category that differs only in case or punctuation ("meme", "Layer 2") is
 * resolved and the scan re-run; one that matches no known name, or several, becomes a tool
 * error naming the closest ones instead of an empty list the model would read as "no coins".
 */
export async function runScan(args, get = apiGet) {
  const { category, exchange } = args;
  if (category && /[,;|]/.test(category)) {
    throw badRequest(`One category per call: "${category}" is matched as a single name and matches nothing. Call scan_coins once per category.`);
  }
  const notes = [];
  const exch = exchange ? canonicalExchange(exchange) : undefined;
  if (exch && exch !== exchange) notes.push(`exchange "${exchange}" matched as "${exch}"`);

  const { route, query } = TYPED_TOOLS.find((t) => t.name === 'scan_coins').build({ ...args, exchange: exch });
  let env = await get(route, query);
  const done = () => ({ env, summary: notes.length ? `[${notes.join('; ')}]` : undefined });
  if (rowsOf(unwrap(env)).length > 0 || (!category && !exch)) return done();

  if (category) {
    const r = resolveName(category, await knownCategories(get));
    if (r.status === 'resolved') {
      notes.push(`category "${category}" matched as "${r.name}"`);
      env = await get(route, { ...query, categories: r.name });
      if (rowsOf(unwrap(env)).length > 0) return done();
    } else if (r.status === 'ambiguous') {
      throw badRequest(`Category "${category}" matches several names: ${list(r.closest)}. Pass one of them exactly.`);
    } else if (r.status === 'none') {
      throw badRequest(
        `No category named "${category}" (names are exact and case-sensitive, e.g. "Meme", "Layer-2").` +
          (r.closest.length ? ` Closest: ${list(r.closest)}.` : '') +
          ' list_categories returns the valid names.',
      );
    }
  }

  if (exch && !KNOWN_EXCHANGES.includes(exch)) {
    const closest = closestNames(exch, KNOWN_EXCHANGES);
    throw badRequest(
      `No coins matched exchange "${exchange}". Exchanges are matched by their full venue name, e.g. "Binance", "Coinbase Exchange", "OKX".` +
        (closest.length ? ` Closest known: ${list(closest)}.` : ''),
    );
  }
  // The names are right; nothing matched the other filters.
  return done();
}

/** Register one typed tool. */
function registerTyped(server, def) {
  const inputSchema = { ...def.inputSchema };
  if (def.listFilters) {
    inputSchema.top = z.number().int().positive().optional().describe('Keep only the first N items (default 50). Raise for more, lower to save tokens.');
    inputSchema.fields = z.string().optional().describe('Token-saving: comma-separated top-level fields to keep.');
  }
  server.registerTool(
    def.name,
    {
      title: def.title,
      description: def.description,
      inputSchema,
      outputSchema: outputSchemaFor(def.name),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args = {}) => {
      try {
        let env;
        let summary;
        if (def.run) {
          ({ env, summary } = await def.run(args, apiGet));
        } else {
          const { route, query } = def.build(args);
          env = await apiGet(route, query || {});
        }
        let data = unwrap(env);
        if (def.listFilters) {
          // Apply the caller's filters, but default-cap when they didn't set `top`.
          const top = args.top ?? DEFAULT_LIST_CAP;
          data = applyFilters(data, { ...args, top });
        }
        return result(data, {
          summary,
          meta: env?.meta,
        });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}

export function buildRiskRows(envs) {
  return envs.map(({ s, env, err }) => {
    if (err) return { symbol: s.toUpperCase(), error: err.message };
    // Server may nest as { data: {...} } inside the envelope's data. Return the
    // contract unchanged so external host models receive deterministic carry.
    const data = unwrap(env)?.data ?? unwrap(env);
    return data ?? { symbol: s.toUpperCase(), error: 'no data' };
  });
}

/** Register `get_coin_risk` (special: fans out one request per symbol). */
function registerCoinRisk(server) {
  server.registerTool(
    'get_coin_risk',
    {
      title: 'Coin risk context',
      description: COIN_RISK_DESCRIPTION,
      inputSchema: {
        symbols: SYMBOL_LIST.refine((a) => a.length >= 1 && a.length <= 15, {
          message: 'Provide between 1 and 15 symbols.',
        }).describe('Symbols as an array ["BTC","ETH","SOL"] or a comma-separated string "BTC,ETH,SOL". 1-15 of them.'),
      },
      outputSchema: outputSchemaFor('get_coin_risk'),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbols }) => {
      try {
        const envs = await Promise.all(
          symbols.map((s) => apiGet(`coin/risk/${encodeURIComponent(s)}`).then((env) => ({ s, env })).catch((err) => ({ s, err }))),
        );
        if (envs.every((r) => r.err)) return toMcpError(envs[0].err);
        const rows = buildRiskRows(envs);
        const ok = rows.filter((r) => !r.error);
        const summary = `Risk context for ${rows.length} coin(s)${ok.length < rows.length ? ` (${rows.length - ok.length} unavailable)` : ''}.`;
        return result(rows.length === 1 ? rows[0] : rows, { summary });
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}

/** Register the two free-form NLP tools (ask / web search). */
function registerNlp(server) {
  server.registerTool(
    'ask_shumi',
    {
      title: 'Ask Shumi (free-form)',
      description:
        'Ask Shumi any crypto-market question in natural language. Shumi classifies the query, fetches the relevant data, and returns a synthesized answer. Use this when no specific typed tool fits, or for multi-part / comparative questions.',
      inputSchema: {
        query: z.string().min(1).describe('The natural-language question, e.g. "is funding extreme on SOL right now?".'),
        archetype: z.string().optional().describe('Specialization path (default "base"; e.g. "perp-dex").'),
      },
      outputSchema: ANSWER_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, archetype = 'base' }) => {
      try {
        return answerResult(await askQuery({ messages: [{ role: 'user', content: query }], archetype }));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );

  server.registerTool(
    'search_web',
    {
      title: 'Search the web',
      description: 'Search the web for crypto information, or get a direct answer. Backed by Shumi\'s web-search tool.',
      inputSchema: {
        query: z.string().min(1).describe('What to search for.'),
        answer: z.boolean().optional().describe('Return a direct synthesized answer instead of raw search results.'),
      },
      outputSchema: ANSWER_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, answer }) => {
      try {
        const constructed = answer ? `Answer this question: ${query}` : `Search the web for: ${query}`;
        return answerResult(await askQuery({ messages: [{ role: 'user', content: constructed }], commandContext: 'search' }));
      } catch (err) {
        return toMcpError(err);
      }
    },
  );
}

export { answerResult };

export function registerTools(server) {
  registerCoinRisk(server);
  for (const def of TYPED_TOOLS) registerTyped(server, def);
  registerNlp(server);
}

/** Lightweight descriptor of the data surface, for the capabilities resource. */
export function toolCatalog() {
  return {
    typed: [
      { name: 'get_coin_risk', title: 'Coin risk context' },
      ...TYPED_TOOLS.map((d) => ({ name: d.name, title: d.title })),
    ],
    nlp: [
      { name: 'ask_shumi', title: 'Ask Shumi (free-form)' },
      { name: 'search_web', title: 'Search the web' },
    ],
  };
}
