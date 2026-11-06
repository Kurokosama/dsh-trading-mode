/**
 * dsh-trading-mode — centralised market data configuration.
 *
 * Spec §51: every provider choice / TTL / endpoint configuration must live here.
 * No other module may hard-code a third-party endpoint or provider name.
 */

/** @typedef {'US'} Market */

/**
 * This fork covers US equities and ETFs only (see `docs/SCOPE.md`). The market
 * list stays a list so the router, the cache keys and the API shapes keep their
 * existing contracts — it just has one entry now, and every non-US feed is gone.
 */
export const MARKETS = ['US'];
export const STOCK_MARKETS = ['US'];
/** Human labels shared by the client, the API payloads and log lines. */
export const MARKET_LABELS = {
  US: 'United States',
};

/**
 * Per-market provider chain.
 *
 * `primary` is the spec-mandated provider for the market. `historicalFallback`
 * is only used for historical candles. `chain` is the ordered list the
 * MarketDataService walks when a provider is unhealthy or fails.
 *
 * NOTE (documented deviation): the spec names Yahoo as primary and Stooq as the
 * historical fallback. On the machine this plugin was built for, Yahoo and Stooq
 * both answer HTTP 403 to every unauthenticated request (IP-level block), so a
 * CN-reachable provider is included in the chain. Provider selection is by
 * health + config only — no business code depends on which one answered.
 *
 * @type {Record<Market, {primary: string, historicalFallback: string, chain: string[]}>}
 */
export const MARKET_DATA_CONFIG = {
  /**
   * Yahoo answers quotes and candles; Stooq is the end-of-day history fallback
   * and stays second in the chain. Nothing else is wired up: the mainland and
   * crypto feeds this project used to fall back to were removed with the US-only
   * scope change, so a broken Yahoo now surfaces as a degraded answer instead of
   * being papered over by a feed that cannot serve US prints correctly anyway.
   */
  US: { primary: 'yahoo', historicalFallback: 'stooq', chain: ['yahoo', 'stooq'] },
};

/**
 * Endpoint + protocol configuration for each provider implementation.
 * Provider modules read from here; nothing is inlined in provider logic.
 */
export const PROVIDER_CONFIG = {
  yahoo: {
    label: 'Yahoo Finance',
    quoteBase: 'https://query1.finance.yahoo.com',
    searchPath: '/v1/finance/search',
    chartPath: '/v8/finance/chart',
    quotePath: '/v7/finance/quote',
    profilePath: '/v10/finance/quoteSummary',
    crumbPath: '/v1/test/getcrumb',
    cookieUrl: 'https://fc.yahoo.com/',
    markets: ['US', 'HK'],
    intervals: ['5m', '15m', '30m', '1h', '1d', '1wk'],
    supportsSearch: true,
    supportsQuote: true,
    supportsCandles: true,
    supportsProfile: true,
    delaySeconds: null,
  },
  stooq: {
    label: 'Stooq',
    base: 'https://stooq.com/q/d/l/',
    quoteUrl: 'https://stooq.com/q/l/',
    markets: ['US', 'HK'],
    /** Stooq publishes end-of-day history only. */
    intervals: ['1d', '1wk'],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: true,
    supportsProfile: false,
    /** Stooq is an end-of-day historical feed; quotes derived from it are stale by definition. */
    delaySeconds: null,
  },
  nasdaq: {
    label: 'Nasdaq',
    base: 'https://api.nasdaq.com',
    screenerPath: '/api/screener/stocks',
    limit: 10_000,
    headers: { Accept: 'application/json', Referer: 'https://www.nasdaq.com/' },
    markets: ['US'],
    intervals: [],
    supportsSearch: false,
    supportsQuote: false,
    supportsCandles: false,
    supportsProfile: false,
    delaySeconds: null,
  },
};

/**
 * Cache key namespaces (spec §41).
 *
 * Every quote-like key carries the market. A bare crypto base is also a
 * plausible exchange ticker (`BTC` is a NYSE-listed trust, `SUI` a US REIT,
 * `APT` a NASDAQ listing), so a symbol-only key hands the US print to a crypto
 * request — or the other way round — for the whole TTL of the first lookup.
 */
export const CACHE_KEYS = {
  quote: (symbol, market) => `quote:${market ? `${market}:` : ''}${symbol}`,
  candles: (symbol, interval, range, market) => `candles:${market ? `${market}:` : ''}${symbol}:${interval}:${range}`,
  profile: (symbol, market) => `profile:${market ? `${market}:` : ''}${symbol}`,
  technical: (symbol, interval, range, market) => `technical:${market ? `${market}:` : ''}${symbol}:${interval}:${range}`,
  search: (market, query) => `search:${market}:${query.toLowerCase()}`,
};

/**
 * TTL policy, milliseconds (spec §42: short TTL while the market is open, long
 * TTL while it is closed).
 */
export const CACHE_TTL = {
  /** Quotes: fast-moving, keep them short. */
  open: { quote: 20_000, candles: 60_000, profile: 24 * 3600_000, technical: 60_000, search: 10 * 60_000 },
  /** Market closed: the last print will not change, so hold it longer. */
  closed: { quote: 10 * 60_000, candles: 30 * 60_000, profile: 24 * 3600_000, technical: 30 * 60_000, search: 60 * 60_000 },
  /** Hard ceiling: cached data older than this is never served, not even as stale. */
  maxStaleAge: { quote: 72 * 3600_000, candles: 7 * 24 * 3600_000, profile: 30 * 24 * 3600_000, technical: 24 * 3600_000, search: 24 * 3600_000 },
};

/** Resilience policy for the Market Data Service (spec §43/§74). */
export const HTTP_POLICY = {
  timeoutMs: 12_000,
  retries: 2,
  retryBaseDelayMs: 350,
  retryMaxDelayMs: 2_000,
  /** Token-bucket limit applied per provider, requests per minute. */
  rateLimitPerMinute: 120,
  /** After this many consecutive failures a provider is marked unhealthy. */
  failureThreshold: 3,
  /** How long an unhealthy provider is skipped before it gets a probe again. */
  healthCooldownMs: 60_000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

/**
 * ── Transport policy (0.6.0, publication task B2) ───────────────────────────
 * `http.js` implements two transports behind one interface:
 *
 *  - `standard` — plain `node:http(s)` with the runtime's own DNS order and no
 *    address-family pinning. This is what a generic network wants.
 *  - `compatibility` — remembers the family that last answered a host and pins
 *    one family per retry attempt, flipping between them. Needed on networks
 *    where one family accepts the TCP connection and then resets it (measured
 *    from a mainland-China home network, see `http.js`).
 *
 * `auto` (the default) starts on `standard` and switches *only the hosts that
 * actually fail* to `compatibility`, so nobody has to know which network they
 * are on. `compatibility` forces the old behaviour; `standard` forbids the
 * fallback entirely (useful to prove a network problem is not caused by it).
 */
export const NETWORK_MODES = ['auto', 'standard', 'compatibility'];

export const NETWORK_POLICY = {
  mode: 'auto',
};

let NETWORK_MODE_OVERRIDE = null;

/**
 * Set the transport mode. `undefined` / `null` / `''` clears the override and
 * restores the default. Throws a message that lists the accepted values.
 */
export function setNetworkMode(mode) {
  if (mode === undefined || mode === null || mode === '') {
    NETWORK_MODE_OVERRIDE = null;
    return networkMode();
  }
  if (!NETWORK_MODES.includes(mode)) {
    throw new Error(`networkMode must be one of ${NETWORK_MODES.join(', ')} (got ${JSON.stringify(mode)})`);
  }
  NETWORK_MODE_OVERRIDE = mode;
  return mode;
}

/** The transport mode in force: the user override, else `NETWORK_POLICY.mode`. */
export function networkMode() {
  return NETWORK_MODE_OVERRIDE || NETWORK_POLICY.mode;
}

/** Trading-session table used for TTL selection and staleness grading. */
export const MARKET_SESSIONS = {
  US: { timeZone: 'America/New_York', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  HK: { timeZone: 'Asia/Hong_Kong', open: '09:30', close: '16:00', days: [1, 2, 3, 4, 5] },
  /** Shanghai/Shenzhen: 09:30–11:30 and 13:00–15:00; the lunch break is not modelled. */
  CN: { timeZone: 'Asia/Shanghai', open: '09:30', close: '15:00', days: [1, 2, 3, 4, 5] },
  /** Tokyo: 09:00–11:30 and 12:30–15:00; the lunch break is not modelled. */
  JP: { timeZone: 'Asia/Tokyo', open: '09:00', close: '15:00', days: [1, 2, 3, 4, 5] },
  /** Crypto trades around the clock, every day. */
};

/** Candle intervals and the ranges offered in the UI (spec §36). */
export const INTERVALS = ['5m', '15m', '30m', '1h', '1d', '1wk'];
export const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y', 'max'];

/** Range → provider-specific code maps. */
export const RANGE_CONFIG = {
  '1d': { days: 1, label: '1D', defaultInterval: '5m' },
  '5d': { days: 5, label: '5D', defaultInterval: '30m' },
  '1mo': { days: 22, label: '1M', defaultInterval: '1d' },
  '3mo': { days: 66, label: '3M', defaultInterval: '1d' },
  '6mo': { days: 132, label: '6M', defaultInterval: '1d' },
  '1y': { days: 252, label: '1Y', defaultInterval: '1d' },
  '5y': { days: 1260, label: '5Y', defaultInterval: '1wk' },
  max: { days: 6000, label: 'MAX', defaultInterval: '1wk' },
};

/**
 * How many bars a range/interval pair needs. Providers that take an explicit
 * bar count (eastmoney `lmt`, tencent `param=...,count`) read this so the
 * request size stays a configuration decision, not a provider decision.
 */
const BARS_PER_DAY = {
  equity: { '5m': 78, '15m': 26, '30m': 13, '1h': 7, '1d': 1, '1wk': 0.2 },
};

/** Calendar days a range covers on `market`. */
export function rangeDays(range, market) {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['6mo'];
  return cfg.days;
}

export function candleLimit(range, interval, market) {
  const days = rangeDays(range, market);
  const perDay = BARS_PER_DAY.equity[interval] ?? 1;
  return Math.max(30, Math.min(1_600, Math.round(days * perDay) + 10));
}

/** Quant engine parameters (spec §29/§71). */
export const QUANT_CONFIG = {
  sma: [5, 10, 20, 50, 60, 200],
  ema: [12, 26],
  rsiPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  atrPeriod: 14,
  volumeAveragePeriod: 20,
  /** Swing window used for support/resistance candidate pivots. */
  pivotLookback: 3,
  pivotHorizon: 120,
  /** Minimum bars required before an indicator is reported at all. */
  minBars: { ma5: 5, ma10: 10, ma20: 20, ma50: 50, ma60: 60, ma200: 200, rsi14: 15, macd: 35, atr14: 15 },
};

/** Pinned model for analysis (spec §32). `null` = use the user's current model. */
export const AI_CONFIG = {
  /** When set (e.g. 'deepseek-chat'), overrides agentDefaultModel. */
  model: null,
  provider: null,
  maxTokens: 2_400,
  temperature: 0.2,
  /** Abort budget for one analysis call. */
  timeoutMs: 120_000,
  /**
   * Recency policy (0.7.0, renamed in 0.8.0). The model is handed the age of the
   * data it reasons about and the system prompt forbids describing old data as
   * current. Round-3 renamed the youngest grade `live` → `fresh` so no code path
   * or label can claim a real-time feed that the plugin has no authorisation for:
   *   - younger than `freshMaxAgeMs`     → 'fresh'
   *   - younger than `staleWarnMs`       → 'delayed'
   *   - older than `staleHistoricalMs`   → 'historical'
   * Anything in between is 'delayed' + a stale warning.
   */
  freshMaxAgeMs: 5 * 60_000,
  staleWarnMs: 30 * 60_000,
  staleHistoricalMs: 24 * 3600_000,
};

/**
 * Inbound request policy (0.7.0). Counted per rolling window, per DSH user and
 * globally, before any upstream work starts. `expensive` buckets are the routes
 * that fan out to several upstreams or to the LLM.
 */
export const API_POLICY = {
  windowMs: 60_000,
  /** All routes, per user / globally, per window. */
  perUser: 240,
  global: 1_200,
  expensive: {
    analyze: { perUser: 20, global: 60 },
    brief: { perUser: 6, global: 30 },
    universeRefresh: { perUser: 2, global: 4 },
  },
  /** Concurrent expensive operations, per user / globally. */
  maxConcurrentAnalyses: 2,
  maxConcurrentAnalysesGlobal: 4,
  /**
   * Round-3 (P0-b): fail closed. Every `/api/trading/*` request must pass the
   * host's own request fence (`connection.requestRejection`). When that fence is
   * missing or throws, the route refuses with 503 `HOST_SECURITY_UNAVAILABLE`
   * instead of serving unauthenticated callers. Only `GET /health` still answers,
   * and it carries no user data and touches no upstream.
   */
  requireHostFence: true,
  /**
   * The single, explicit exception: a local operator debugging on this machine
   * may set `security.allowUnfencedLoopback: true`. It applies **only** to
   * loopback peers, logs loudly at start-up, and is off by default. It is never
   * switched on automatically — there is no "development mode".
   */
  allowUnfencedLoopback: false,
};

/**
 * The loopback debugging exception currently in force (0.8.0).
 *
 * `undefined` means "no operator override": the shipped default
 * (`API_POLICY.allowUnfencedLoopback === false`) applies. The override is a
 * module-level value written only by `setAllowUnfencedLoopback()` at start-up,
 * so `API_POLICY` itself stays a truthful description of the shipped default
 * and a test can still assert it.
 */
let ALLOW_UNFENCED_LOOPBACK_OVERRIDE;

/**
 * Enable or clear the loopback debugging exception. Accepts `true`/`false`
 * (and the usual string/number truthy spellings); `undefined`/`null`/`''`
 * clears it. Anything else throws, so a typo in plugin config is reported at
 * start-up instead of silently weakening the fence.
 */
export function setAllowUnfencedLoopback(value) {
  if (value === undefined || value === null || value === '') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = undefined;
    return allowUnfencedLoopback();
  }
  if (value === true || value === 'true' || value === 1 || value === '1') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = true;
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    ALLOW_UNFENCED_LOOPBACK_OVERRIDE = false;
    return false;
  }
  throw new Error(`security.allowUnfencedLoopback must be true or false (got ${JSON.stringify(value)})`);
}

/** Is the loopback debugging exception in force? Defaults to the shipped `false`. */
export function allowUnfencedLoopback() {
  return ALLOW_UNFENCED_LOOPBACK_OVERRIDE === undefined
    ? API_POLICY.allowUnfencedLoopback
    : ALLOW_UNFENCED_LOOPBACK_OVERRIDE;
}

/**
 * Identity policy (0.8.0, round-3 P1⑦).
 *
 * Per-user data (watchlist, language preference) must never be filed under one
 * bucket that every browser of this DSH shares. The resolution order is:
 *
 *   1. the host's anonymous user id (`@deepseek-ai/dsh-anonymous-user-id`) —
 *      the same stable identity the harness itself persists;
 *   2. an operator-named local bucket (`identity.localBucket`), which is an
 *      explicit acknowledgement that this deployment is single-user;
 *   3. no identity at all.
 *
 * In case 3 market data still reads normally, but anything that writes per-user
 * data or is metered per user is refused with 503 `NO_IDENTITY`. The old silent
 * fallback to one shared `local` bucket is gone.
 */
export const IDENTITY_POLICY = {
  /** Operator-declared single-user bucket name, or null (not declared). */
  localBucket: null,
  /** Refuse per-user writes when the identity is unknown. */
  rejectWritesWithoutIdentity: true,
};

export const DISCLAIMER =
  'Market data and AI analysis are provided for informational purposes only and should not be considered financial advice.';

/**
 * Languages the UI (and therefore the AI output) can switch between. The
 * published spec carries no localisation section; this is the layer added in
 * 0.2.2 so the panel follows the DSH interface language and stays switchable.
 * All Chinese variants (`zh-CN`, `zh-TW`, `zh-Hans`, `zh_Hant`) normalise to the
 * single shipped `zh` dictionary.
 */
export const SUPPORTED_LANGS = ['en', 'zh'];
export const DEFAULT_LANG = 'en';

/** Anything locale-ish → a shipped language id, or `null` when unsupported. */
export function normalizeLang(value) {
  if (typeof value !== 'string') return null;
  const primary = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  if (primary === 'zh') return 'zh';
  if (primary === 'en') return 'en';
  return null;
}

/**
 * Last-resort *display* bucket only. Since 0.8.0 this is **not** used to file
 * per-user data: an unknown identity is reported as unknown and per-user writes
 * are refused (`IDENTITY_POLICY`), instead of silently sharing one bucket between
 * every browser that talks to this DSH.
 */
export const DEFAULT_USER = 'local';

/**
 * Full-universe browse configuration (added in 0.4.0).
 *
 * The remote search endpoint only ever answers a relevance slice of the whole
 * market, which left most US/HK listings unreachable from "Add Stock". The bulk
 * `clist` feed pages through every listed venue instead, so the browser and the
 * local search can cover the complete US/HK listing universe.
 *
 * `fs` values were measured live: US venues 105/106/107 (13,839 securities) and
 * the three HK equity boards (main 2,619 + GEM 315 + funds/REITs 490 = 3,424).
 * HK bonds (`t:2`), warrants (`t:6`) and callable bull/bear contracts (`t:5`)
 * are deliberately excluded: they are derivatives, not stocks, and would add
 * ~13,900 rows the assistant must never present as a company.
 */
export const UNIVERSE_BOARDS = {
  US: [
    { id: 'NASDAQ', label: 'NASDAQ', fs: 'm:105', exchange: 'NASDAQ' },
    { id: 'NYSE', label: 'NYSE', fs: 'm:106', exchange: 'NYSE' },
    { id: 'AMEX', label: 'AMEX', fs: 'm:107', exchange: 'AMEX' },
  ],
};

/** The bulk feed silently truncates anything above 100 rows per page. */
export const UNIVERSE_PAGE_SIZE = 100;
export const UNIVERSE_PAGE_LIMIT = 200;

/**
 * Wall-clock budget for one full universe refresh (0.7.0). A refresh walks every
 * board of every market page by page; on a bad network that can run for a long
 * time. When the budget is spent the run stops cleanly, keeps the rows already
 * absorbed, and reports `complete: false` plus a reason instead of hanging the
 * caller or the UI forever.
 */
export const UNIVERSE_POLICY = {
  budgetMs: 15 * 60_000,
  /** Minimum gap between two accepted refresh starts (in addition to the quota). */
  minRestartIntervalMs: 30_000,
};

/**
 * Listing-provider preference per market (0.4.1).
 *
 * Eastmoney's `clist` is the richest feed (Chinese names, board and industry per
 * row) but it is also the one most likely to be refused, so each market carries a
 * second feed that is verified reachable from the same network. The universe
 * layer walks this list in order and remembers which provider answered.
 */
/** Nasdaq's screener is the only listing feed this fork keeps. */
export const UNIVERSE_PROVIDERS = {
  US: ['nasdaq'],
};

/** Boards of one market, in display order. */
export function universeBoards(market) {
  const boards = UNIVERSE_BOARDS[market];
  return boards ? boards.slice() : [];
}

/** Resolve a board id (`NASDAQ`, `m:105`) or fall back to the market's first board. */
export function universeBoard(market, board) {
  const boards = universeBoards(market);
  if (!boards.length) throw new Error(`unsupported universe market: ${market}`);
  if (board === undefined || board === null || board === '') return boards[0];
  const raw = String(board).trim();
  const hit = boards.find((b) => b.id.toUpperCase() === raw.toUpperCase() || b.fs === raw);
  if (!hit) throw new Error(`unknown board ${raw} for ${market}`);
  return hit;
}

/** Security classes the remote *search* endpoint may return (measured live). */
export const SEARCH_SECURITY_TYPES = new Set(['1', '3', '4', '5']);
export const SEARCH_RESULT_LIMIT = 100;

/**
 * Minimum bars a candle response must carry before the router treats it as
 * *serving the range*.
 *
 * Measured: with the eastmoney kline feed refused, the chain fell through to
 * Tencent, whose US kline endpoint ignores the bar count and answers two rows —
 * a "successful" answer that renders an empty chart. A response carrying a
 * token handful of bars is treated as a failed attempt so the next provider is
 * tried; if no provider clears the bar the best attempt is still returned, so a
 * genuinely young listing (which has few bars to give) never loses its data.
 */
export function minBars(range, interval, market) {
  const days = rangeDays(range, market);
  const limit = candleLimit(range, interval, market);
  return Math.max(5, Math.min(limit, Math.round(days / 10) + 4));
}

/** Persisted universe snapshots stay well under the storage budget. */
export const MAX_UNIVERSE_BYTES = 12 * 1024 * 1024;

/** Default watchlist shipped with the onboarding seed (spec §24/§56). */
export const SEED_WATCHLIST = {
  US: ['AAPL', 'NVDA', 'TSLA'],
  ALL: ['AAPL', 'NVDA', 'TSLA'],
};

/**
 * Onboarding recommendation pool (spec §24). Offered as suggestions only — the
 * user must still add each one explicitly, so nothing is implied to be owned.
 */
export const RECOMMENDED_STARTERS = {
  US: ['AAPL', 'NVDA', 'TSLA', 'META', 'MSFT'],
  ALL: ['AAPL', 'NVDA', 'TSLA', 'META', 'MSFT'],
};

/**
 * ── Provider chains (0.6.0, publication task B1) ────────────────────────────
 * `MARKET_DATA_CONFIG` above is the *conservative default*: the order that was
 * measured to work from a mainland-China home network on 2026-10-07. A user on a
 * different network can reorder or trim a market's chain from the plugin config
 * without patching source:
 *
 *   - id: trading-mode
 *     config:
 *       providers:
 *         US: ['nasdaq', 'stooq']
 *
 * Validation is strict and *reported*, never silent: an unknown market, an
 * unknown provider id, a duplicate or an empty chain is rejected with a message
 * that lists the accepted values, and the defaults stay in force.
 */
const CHAIN_OVERRIDES = new Map();
let CHAIN_OVERRIDE_PROBLEMS = [];

/** Every provider id the plugin ships. */
export function providerIds() {
  return Object.keys(PROVIDER_CONFIG);
}

/** Validate a `providers` config block. Returns `{ chains, problems }`. */
export function validateProviderChains(overrides) {
  const problems = [];
  const chains = {};
  if (overrides === undefined || overrides === null) return { chains, problems };
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    problems.push(
      `providers must be an object that maps a market to an ordered provider list (got ${Array.isArray(overrides) ? 'array' : typeof overrides})`,
    );
    return { chains, problems };
  }
  for (const [market, value] of Object.entries(overrides)) {
    if (!MARKETS.includes(market)) {
      problems.push(`providers.${market}: unknown market (accepted: ${MARKETS.join(', ')})`);
      continue;
    }
    if (!Array.isArray(value)) {
      problems.push(`providers.${market}: expected an array of provider ids (accepted: ${providerIds().join(', ')})`);
      continue;
    }
    if (!value.length) {
      problems.push(`providers.${market}: the chain must list at least one provider (accepted: ${providerIds().join(', ')})`);
      continue;
    }
    const seen = new Set();
    let bad = false;
    for (const id of value) {
      if (typeof id !== 'string' || !PROVIDER_CONFIG[id]) {
        problems.push(`providers.${market}: unknown provider ${JSON.stringify(id)} (accepted: ${providerIds().join(', ')})`);
        bad = true;
        continue;
      }
      if (seen.has(id)) {
        problems.push(`providers.${market}: provider ${id} is listed twice`);
        bad = true;
        continue;
      }
      seen.add(id);
    }
    if (!bad) chains[market] = value.slice();
  }
  return { chains, problems };
}

/**
 * Apply a `providers` config block. Valid markets replace their default chain;
 * invalid entries are reported through the returned `problems` and ignored.
 */
export function applyProviderChains(overrides) {
  const { chains, problems } = validateProviderChains(overrides);
  CHAIN_OVERRIDES.clear();
  for (const [market, chain] of Object.entries(chains)) CHAIN_OVERRIDES.set(market, chain);
  CHAIN_OVERRIDE_PROBLEMS = problems;
  return { applied: Object.keys(chains), problems };
}

/** Problems found by the last `applyProviderChains` call. */
export function providerChainProblems() {
  return CHAIN_OVERRIDE_PROBLEMS.slice();
}

/** The active overrides, as a plain object. */
export function chainOverrides() {
  return Object.fromEntries([...CHAIN_OVERRIDES].map(([market, chain]) => [market, chain.slice()]));
}

/** The active, ordered provider chain for a market. */
export function providerChain(market) {
  const defaults = MARKET_DATA_CONFIG[market];
  if (!defaults) throw new Error(`unsupported market: ${market}`);
  const override = CHAIN_OVERRIDES.get(market);
  return (override || defaults.chain).slice();
}

export function marketConfig(market) {
  const cfg = MARKET_DATA_CONFIG[market];
  if (!cfg) throw new Error(`unsupported market: ${market}`);
  return { ...cfg, chain: providerChain(market) };
}

export function providerConfig(id) {
  const cfg = PROVIDER_CONFIG[id];
  if (!cfg) throw new Error(`unknown market data provider: ${id}`);
  return cfg;
}
