/**
 * Symbol Directory (spec §23).
 *
 * A single place that maps whatever the user typed — a ticker, an English name,
 * a Chinese name, or a bare HK number — onto the canonical unified symbol
 * (§17/§22), and that enriches the display with names the market data providers
 * may not return.
 *
 * The seed table covers the acceptance list of §22/§24 so search keeps working
 * even when the upstream suggest endpoint is unreachable; live search results are
 * merged in at runtime and take precedence.
 */

import { currencyOf, exchangeOf, parseSymbol } from './symbols.js';

/** True when a string contains Han characters. */
export function hasCjk(value) {
  return typeof value === 'string' && /[\u3400-\u9fff\uf900-\ufaff]/.test(value);
}

/**
 * Keep `name` English and `nameZh` Chinese (§17). US quotes from the upstream
 * providers arrive with the Chinese name only, so without this the detail page
 * would show "苹果" as the company name and lose the English one entirely.
 *
 * @param {{name?: string, nameZh?: string}} record
 * @param {{symbol?: string, name?: string, nameZh?: string}} known
 */
export function splitNames(record = {}, known = {}) {
  let name = record.name && record.name !== record.symbol ? record.name : null;
  let nameZh = record.nameZh || null;
  if (hasCjk(name)) {
    if (!nameZh) nameZh = name;
    const english = known.name && known.name !== known.symbol && !hasCjk(known.name) ? known.name : null;
    if (english) name = english;
  }
  if (!name && known.name && known.name !== known.symbol) name = known.name;
  if (!nameZh && known.nameZh) nameZh = known.nameZh;
  const out = { name: name || record.name || known.name || null };
  // Never emit an empty key: `nameZh: undefined` would survive into JSON.
  if (nameZh) out.nameZh = nameZh;
  return out;
}

/**
 * @typedef {{symbol: string, name: string, nameZh?: string, exchange: string, aliases?: string[]}} DirectoryEntry
 */

/** @type {DirectoryEntry[]} */
export const SEED_DIRECTORY = [
  // US large caps and the ETFs this build's audience actually holds. The seed
  // exists so search resolves a name (English or Chinese) even when the upstream
  // suggest endpoint is unreachable; live results are merged in and win.
  { symbol: 'AAPL', name: 'Apple Inc.', nameZh: '苹果', exchange: 'NASDAQ', aliases: ['apple'] },
  { symbol: 'MSFT', name: 'Microsoft Corporation', nameZh: '微软', exchange: 'NASDAQ', aliases: ['microsoft'] },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', nameZh: '英伟达', exchange: 'NASDAQ', aliases: ['nvidia'] },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', nameZh: '谷歌', exchange: 'NASDAQ', aliases: ['google', 'alphabet'] },
  { symbol: 'AMZN', name: 'Amazon.com, Inc.', nameZh: '亚马逊', exchange: 'NASDAQ', aliases: ['amazon'] },
  { symbol: 'META', name: 'Meta Platforms, Inc.', nameZh: 'Meta', exchange: 'NASDAQ', aliases: ['facebook'] },
  { symbol: 'TSLA', name: 'Tesla, Inc.', nameZh: '特斯拉', exchange: 'NASDAQ', aliases: ['tesla'] },
  { symbol: 'AVGO', name: 'Broadcom Inc.', nameZh: '博通', exchange: 'NASDAQ', aliases: ['broadcom'] },
  { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.', nameZh: '超威半导体', exchange: 'NASDAQ', aliases: ['amd'] },
  { symbol: 'TSM', name: 'Taiwan Semiconductor Manufacturing', nameZh: '台积电', exchange: 'NYSE', aliases: ['tsmc'] },
  { symbol: 'LLY', name: 'Eli Lilly and Company', nameZh: '礼来', exchange: 'NYSE', aliases: ['eli lilly'] },
  { symbol: 'UBER', name: 'Uber Technologies, Inc.', nameZh: '优步', exchange: 'NYSE', aliases: ['uber'] },
  { symbol: 'COST', name: 'Costco Wholesale Corporation', nameZh: '好市多', exchange: 'NASDAQ', aliases: ['costco'] },
  { symbol: 'BABA', name: 'Alibaba Group Holding Limited', nameZh: '阿里巴巴', exchange: 'NYSE', aliases: ['alibaba'] },
  // Broad-market and sector ETFs (the fork covers equities and ETFs only).
  { symbol: 'VOO', name: 'Vanguard S&P 500 ETF', nameZh: '先锋标普500 ETF', exchange: 'NYSE', aliases: ['vanguard sp500', '标普500'] },
  { symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', nameZh: '先锋全市场 ETF', exchange: 'NYSE', aliases: ['vanguard total market'] },
  { symbol: 'VXUS', name: 'Vanguard Total International Stock ETF', nameZh: '先锋全国际股票 ETF', exchange: 'NASDAQ', aliases: ['vanguard international'] },
  { symbol: 'QQQ', name: 'Invesco QQQ Trust', nameZh: '纳指100 ETF', exchange: 'NASDAQ', aliases: ['invesco qqq', '纳斯达克100'] },
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', nameZh: '标普500 ETF', exchange: 'NYSE', aliases: ['spdr sp500'] },
  { symbol: 'SCHD', name: 'Schwab US Dividend Equity ETF', nameZh: '嘉信美国股息股票 ETF', exchange: 'NYSE', aliases: ['schwab dividend'] },
  { symbol: 'SCHG', name: 'Schwab US Large-Cap Growth ETF', nameZh: '嘉信美国大盘成长 ETF', exchange: 'NYSE', aliases: ['schwab growth'] },
  { symbol: 'VGT', name: 'Vanguard Information Technology ETF', nameZh: '先锋信息技术 ETF', exchange: 'NYSE', aliases: ['vanguard technology'] },
  { symbol: 'SGOV', name: 'iShares 0-3 Month Treasury Bond ETF', nameZh: '安硕0-3月美债 ETF', exchange: 'NYSE', aliases: ['ishares treasury', '短期美债'] },
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF', nameZh: '半导体 ETF', exchange: 'NASDAQ', aliases: ['semiconductor'] },
  { symbol: 'GLD', name: 'SPDR Gold Shares', nameZh: '黄金 ETF', exchange: 'NYSE', aliases: ['gold'] },
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF', nameZh: '安硕20年期以上美债 ETF', exchange: 'NASDAQ', aliases: ['long treasury', '长债'] },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', nameZh: '罗素2000 ETF', exchange: 'NYSE', aliases: ['russell 2000', '小盘股'] },
  { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc. Class B', nameZh: '伯克希尔 B', exchange: 'NYSE', aliases: ['berkshire'] },
];

export class SymbolDirectory {
  /**
   * @param {{entries?: DirectoryEntry[], logger?: any}} [opts]
   */
  constructor(opts = {}) {
    this.logger = opts.logger || null;
    this.bySymbol = new Map();
    /** Free-text index: lowercase alias/name → symbol. */
    this.index = new Map();
    for (const entry of opts.entries || SEED_DIRECTORY) this.put(entry);
  }

  /** Insert or enrich an entry (live provider results win over the seed). */
  put(entry) {
    if (!entry || !entry.symbol) return null;
    let parsed;
    try {
      parsed = parseSymbol(entry.symbol, entry.market);
    } catch {
      return null;
    }
    const existing = this.bySymbol.get(parsed.symbol);
    const merged = {
      symbol: parsed.symbol,
      name: entry.name || (existing && existing.name) || parsed.symbol,
      ...(entry.nameZh || (existing && existing.nameZh) ? { nameZh: entry.nameZh || existing.nameZh } : {}),
      market: parsed.market,
      exchange: entry.exchange || (existing && existing.exchange) || exchangeOf(parsed.market, parsed.board),
      currency: entry.currency || (existing && existing.currency) || currencyOf(parsed.market),
      aliases: [...new Set([...(existing?.aliases || []), ...(entry.aliases || [])])],
    };
    this.bySymbol.set(parsed.symbol, merged);
    for (const key of this.keysOf(merged)) if (!this.index.has(key)) this.index.set(key, parsed.symbol);
    return merged;
  }

  keysOf(entry) {
    const keys = new Set();
    const add = (v) => {
      if (typeof v === 'string' && v.trim()) keys.add(v.trim().toLowerCase());
    };
    add(entry.symbol);
    add(entry.symbol.replace(/\.HK$/i, ''));
    add(entry.name);
    add(entry.nameZh);
    for (const alias of entry.aliases || []) add(alias);
    // The first word of an English company name ("Apple" from "Apple Inc.").
    if (entry.name && /^[A-Za-z]/.test(entry.name)) add(entry.name.split(/[\s,.]+/)[0]);
    return keys;
  }

  /**
   * Canonical record for a symbol, or a minimal synthesised one.
   *
   * `market` is an optional hint: a bare `BTC` or `SOL` is indistinguishable from
   * a US ticker, so callers that already know the market must say so or the record
   * comes back as a NASDAQ/USD listing.
   */
  lookup(symbol, market) {
    let parsed;
    try {
      parsed = parseSymbol(symbol, market);
    } catch {
      return null;
    }
    const found = this.bySymbol.get(parsed.symbol);
    if (found) return { ...found };
    return {
      symbol: parsed.symbol,
      name: parsed.symbol,
      market: parsed.market,
      exchange: exchangeOf(parsed.market, parsed.board),
      currency: currencyOf(parsed.market),
      aliases: [],
    };
  }

  /** Enrich an arbitrary result set with directory names. */
  enrich(records) {
    return (records || []).map((record) => {
      const known = this.lookup(record.symbol, record.market);
      if (!known) return record;
      // A US default currency on a non-US row (providers often send none) is a bug,
      // not information: fall back to the currency of the record's own market.
      const marketCurrency = currencyOf(record.market || known.market);
      const currency = record.currency && record.currency !== 'USD' ? record.currency : marketCurrency;
      const merged = { ...record, ...splitNames(record, known), exchange: record.exchange || known.exchange, currency };
      this.put(merged);
      return merged;
    });
  }

  /**
   * Offline/local search across the directory. Providers are still asked first;
   * this exists so the §22 acceptance queries (Chinese names, bare HK numbers)
   * resolve even without a reachable suggest endpoint.
   */
  search(query, market, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const exact = this.index.get(q);
    const hits = [];
    const seen = new Set();
    if (exact) {
      const record = this.lookup(exact);
      if (record && (!market || record.market === market)) {
        hits.push(record);
        seen.add(record.symbol);
      }
    }
    for (const entry of this.bySymbol.values()) {
      if (hits.length >= limit) break;
      if (seen.has(entry.symbol)) continue;
      if (market && entry.market !== market) continue;
      const haystack = [entry.symbol, entry.symbol.replace(/\.HK$/i, ''), entry.name, entry.nameZh, ...(entry.aliases || [])]
        .filter(Boolean)
        .map((v) => String(v).toLowerCase());
      if (haystack.some((v) => v.startsWith(q) || v.includes(q))) {
        hits.push({ ...entry });
        seen.add(entry.symbol);
      }
    }
    return hits.slice(0, limit);
  }

  get size() {
    return this.bySymbol.size;
  }

  toJSON() {
    return [...this.bySymbol.values()];
  }
}
