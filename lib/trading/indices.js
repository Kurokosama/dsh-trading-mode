/**
 * Market index directory (added in 0.3.0 at the user's request: the panel must be
 * able to show the VIX, the Nasdaq, the Hang Seng and friends).
 *
 * This is the single curated table that turns *any* spelling a user or a provider
 * may hand us — `^VIX`, `VIX`, `恐慌指数`, `usVIX`, `100.NDX` — into one canonical
 * symbol with every provider dialect attached, so no provider format leaks into
 * business code or the UI (spec §16) and the symbol directory stays unified
 * (spec §23).
 *
 * The table is deliberately small: this fork ships the US benchmarks only, and
 * every entry is quoted and charted through Yahoo, the one feed this build keeps.
 * Aliases carry the Chinese names so a Chinese query resolves to the same record.
 */

/**
 * @typedef {{
 *   symbol: string, name: string, nameZh: string, market: 'US',
 *   currency: 'USD',
 *   exchange: string, group: 'US', order: number,
 *   tvSymbol: string, yahooSymbol: string, aliases: string[],
 * }} IndexRecord
 */

/** @type {IndexRecord[]} */
export const INDEX_DIRECTORY = [
  {
    symbol: '^IXIC',
    name: 'Nasdaq Composite',
    nameZh: '纳斯达克综合指数',
    market: 'US',
    currency: 'USD',
    exchange: 'NASDAQ',
    group: 'US',
    order: 10,
    tvSymbol: 'NASDAQ:IXIC',
    yahooSymbol: '^IXIC',
    aliases: ['IXIC', 'NASDAQ', 'NASDAQ COMPOSITE', 'COMP', '纳斯达克', '纳指', '纳斯达克综合'],
  },
  {
    symbol: '^NDX',
    name: 'Nasdaq 100',
    nameZh: '纳斯达克100指数',
    market: 'US',
    currency: 'USD',
    exchange: 'NASDAQ',
    group: 'US',
    order: 20,
    tvSymbol: 'NASDAQ:NDX',
    yahooSymbol: '^NDX',
    aliases: ['NDX', 'NDX100', 'NASDAQ100', 'NASDAQ 100', '纳斯达克100', '纳指100'],
  },
  {
    symbol: '^GSPC',
    name: 'S&P 500',
    nameZh: '标普500指数',
    market: 'US',
    currency: 'USD',
    exchange: 'SP',
    group: 'US',
    order: 30,
    tvSymbol: 'SP:SPX',
    yahooSymbol: '^GSPC',
    aliases: ['GSPC', 'SPX', 'SP500', 'INX', 'SP 500', '标普500', '标普', '标准普尔500'],
  },
  {
    symbol: '^DJI',
    name: 'Dow Jones Industrial Average',
    nameZh: '道琼斯工业指数',
    market: 'US',
    currency: 'USD',
    exchange: 'DJ',
    group: 'US',
    order: 40,
    tvSymbol: 'TVC:DJI',
    yahooSymbol: '^DJI',
    // NOTE: the bare alias `DOW` is deliberately absent — `DOW` is a real,
    // tradable US ticker (Dow Inc.), so resolving it to this index would hijack
    // a stock lookup. `DOW JONES` (with the space) is unambiguous.
    aliases: ['DJI', 'DJIA', 'DOW JONES', '道琼斯', '道指'],
  },
  {
    symbol: '^SOX',
    name: 'PHLX Semiconductor Index',
    nameZh: '费城半导体指数',
    market: 'US',
    currency: 'USD',
    exchange: 'PHLX',
    group: 'US',
    order: 43,
    tvSymbol: 'TVC:SOX',
    yahooSymbol: '^SOX',
    aliases: ['SOX', 'PHLX', 'SOX INDEX', '半导体指数', '费城半导体', '费半'],
  },
  {
    symbol: '^RUT',
    name: 'Russell 2000',
    nameZh: '罗素2000指数',
    market: 'US',
    currency: 'USD',
    exchange: 'RUSSELL',
    group: 'US',
    order: 45,
    tvSymbol: 'TVC:RUT',
    yahooSymbol: '^RUT',
    aliases: ['RUT', 'RUSSELL', 'RUSSELL 2000', 'RUSSELL2000', '罗素2000', '罗素'],
  },
  {
    symbol: '^VIX',
    name: 'CBOE Volatility Index',
    nameZh: '恐慌指数（VIX）',
    market: 'US',
    currency: 'USD',
    exchange: 'CBOE',
    group: 'US',
    order: 50,
    tvSymbol: 'TVC:VIX',
    yahooSymbol: '^VIX',
    aliases: ['VIX', 'VIX INDEX', 'CBOE VIX', 'VOLATILITY INDEX', '恐慌指数', '波动率指数'],
  },
];

/** Canonical symbol → record, plus the alias / provider-spelling lookups. */
const BY_SYMBOL = new Map(INDEX_DIRECTORY.map((entry) => [entry.symbol, entry]));
const BY_ALIAS = new Map();
const BY_PROVIDER_KEY = new Map();
for (const entry of INDEX_DIRECTORY) {
  for (const alias of entry.aliases) {
    const normalized = normalizeIndexKey(alias);
    if (normalized && !BY_ALIAS.has(normalized)) BY_ALIAS.set(normalized, entry.symbol);
  }
  for (const key of [entry.name, entry.nameZh, entry.yahooSymbol, entry.tvSymbol]) {
    const normalized = normalizeIndexKey(key);
    if (normalized && !BY_ALIAS.has(normalized)) BY_ALIAS.set(normalized, entry.symbol);
  }
  for (const key of [entry.yahooSymbol, entry.tvSymbol]) {
    const normalized = normalizeIndexKey(key);
    if (normalized && !BY_PROVIDER_KEY.has(normalized)) BY_PROVIDER_KEY.set(normalized, entry.symbol);
  }
}

/** The indices the Market Overview strip shows, in display order. */
export const DEFAULT_INDEX_SYMBOLS = INDEX_DIRECTORY.slice()
  .sort((a, b) => a.order - b.order)
  .map((entry) => entry.symbol);

export function normalizeIndexKey(value) {
  return String(value === undefined || value === null ? '' : value)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

/**
 * Resolve any index spelling to its directory record.
 * @param {string} input
 * @returns {IndexRecord|null}
 */
export function lookupIndex(input) {
  if (typeof input !== 'string' || !input.trim()) return null;
  const raw = input.trim();
  const upper = normalizeIndexKey(raw);
  const direct = BY_SYMBOL.get(upper);
  if (direct) return direct;
  const byAlias = BY_ALIAS.get(upper);
  if (byAlias) return BY_SYMBOL.get(byAlias) || null;
  const byProvider = BY_PROVIDER_KEY.get(normalizeIndexKey(raw));
  if (byProvider) return BY_SYMBOL.get(byProvider) || null;
  // A caret-prefixed spelling of an alias is still that index: `^SPX` is the
  // S&P 500 (whose canonical spelling here is `^GSPC`), not an unknown ticker.
  if (upper.startsWith('^')) {
    const bare = upper.slice(1);
    const aliased = BY_ALIAS.get(bare) || BY_PROVIDER_KEY.get(bare);
    if (aliased) return BY_SYMBOL.get(aliased) || null;
  }
  return null;
}

export function isIndexSymbol(value) {
  return Boolean(lookupIndex(value));
}

/**
 * Soft matching for the search box: a query such as `纳斯达克`, `vix` or `恒生`
 * must surface the index itself, not only the leveraged products that track it.
 * @param {string} query
 * @param {'US'} [market]
 * @param {number} [limit]
 */
export function searchIndices(query, market, limit = 4) {
  const needle = normalizeIndexKey(query);
  if (!needle) return [];
  const matches = [];
  for (const entry of INDEX_DIRECTORY) {
    if (market && entry.market !== market) continue;
    const haystack = [entry.symbol, entry.symbol.replace(/^\^/, ''), entry.name, entry.nameZh, ...entry.aliases].map(normalizeIndexKey);
    const exact = haystack.some((h) => h === needle);
    // Reverse containment ("SPX500" contains "SPX") only for real words, never
    // for a one-character haystack that would match almost any query.
    const partial = !exact && haystack.some((h) => h.includes(needle) || (h.length >= 2 && needle.includes(h)));
    if (!exact && !partial) continue;
    matches.push({ entry, exact });
  }
  // An exact alias always outranks a fuzzy hit, no matter where the record sits
  // in the directory: "纳斯达克100" is ^NDX, not ^IXIC's prefix match.
  matches.sort((a, b) => (a.exact === b.exact ? a.entry.order - b.entry.order : a.exact ? -1 : 1));
  return matches.slice(0, Math.max(0, limit)).map(({ entry, exact }) => ({
    symbol: entry.symbol,
    exchangeSymbol: entry.symbol,
    name: entry.name,
    nameZh: entry.nameZh,
    market: entry.market,
    exchange: entry.exchange,
    currency: entry.currency,
    kind: 'index',
    quoteType: 'INDEX',
    aliases: [...entry.aliases],
    ...(exact ? { exact: true } : {}),
  }));
}

/**
 * Provider filters. Declared here (next to the data that justifies them) and used
 * by the providers, so the router simply never offers a provider that cannot
 * serve a given index — no business-logic `if (symbol.startsWith('^'))`.
 * @param {string} symbol canonical index symbol
 * @param {'search'|'quote'|'candles'|'profile'} feature
 */
export function indexSupportFor(providerId, symbol, feature) {
  const entry = lookupIndex(symbol);
  if (!entry) return true;
  // Yahoo quotes, charts and searches every index in this table. Stooq has no
  // verified index mapping, so asking it would only burn a doomed call.
  if (providerId === 'stooq') return false;
  return true;
}

/** Public shape used by `GET /api/trading/indices` (code + label + external dialects). */
export function publicIndex(entry) {
  return {
    symbol: entry.symbol,
    name: entry.name,
    nameZh: entry.nameZh,
    market: entry.market,
    currency: entry.currency,
    exchange: entry.exchange,
    kind: 'index',
    group: entry.group,
    order: entry.order,
    // Dialect strings the UI needs to build "open the source page" links. These
    // are chart-site tickers (TradingView/Yahoo/腾讯财经 page ids), not our market
    // data provider keys, so they leak no upstream payload (§16).
    links: {
      tradingView: entry.tvSymbol,
      yahoo: entry.yahooSymbol,
    },
  };
}
