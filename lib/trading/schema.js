/**
 * Unified market-data schema (spec §14/§17/§18/§19) plus the normalisers that
 * turn provider-native payloads into it.
 *
 * Nothing above this layer may see a provider-specific field name: providers
 * return these shapes or throw.
 */

import { currencyOf, parseSymbol, stockSymbol } from './symbols.js';
import { gradeFreshness } from './sessions.js';
import { roundPrice } from './http.js';

/**
 * @typedef {Object} StockSymbol
 * @property {string} symbol          canonical, e.g. AAPL or 0700.HK
 * @property {string} exchangeSymbol  provider-exchange spelling
 * @property {string} name
 * @property {string} [nameZh]
 * @property {'US'|'HK'|'CN'|'JP'|'CRYPTO'} market
 * @property {string} exchange
 * @property {'USD'|'HKD'|'CNY'|'JPY'|'USDT'} currency
 */

/**
 * @typedef {Object} MarketQuote
 * @property {string} symbol
 * @property {'US'|'HK'|'CN'|'JP'|'CRYPTO'} market
 * @property {'USD'|'HKD'|'CNY'|'JPY'|'USDT'} currency
 * @property {number} price
 * @property {number|null} change
 * @property {number|null} changePct
 * @property {number|null} open
 * @property {number|null} high
 * @property {number|null} low
 * @property {number|null} previousClose
 * @property {number|null} volume
 * @property {number} timestamp        epoch ms of the upstream print
 * @property {string} source           provider id that produced the value
 * @property {number|null} delaySeconds
 * @property {boolean} stale
 */

/**
 * @typedef {Object} Candle
 * @property {number} timestamp epoch ms
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * @typedef {Object} CompanyProfile
 * @property {string} symbol
 * @property {string} name
 * @property {string} [nameZh]
 * @property {string} market
 * @property {string} exchange
 * @property {string} currency
 * @property {string} [industry]
 * @property {string} [sector]
 * @property {string} [country]
 * @property {string} [website]
 * @property {string} [description]
 * @property {number|null} marketCap
 * @property {number|null} [peRatio]
 * @property {number|null} [sharesOutstanding]
 * @property {number|null} [dividendYield]    // annual yield in percent (Normalized)
 * @property {number|null} [dividendRate]     // per-share annual dividend amount
 * @property {number|null} [exDividendDate]   // epoch ms of the last/next ex-dividend day
 * @property {number|null} [expenseRatio]     // in percent, the net expense ratio of a fund
 * @property {string} [fundFamily]
 * @property {Array<{symbol?: string, name: string, weight: number|null}>} [holdings] // top fund positions, largest first, at most 10
 * @property {Array<{key?: string, name: string, weight: number}>} [sectors] // fund sector mix in percent, largest first
 * @property {{targetMean: number|null, targetHigh: number|null, targetLow: number|null, rating: string|null, ratingMean: number|null, count: number|null}} [analysts] // sell-side consensus, only when someone covers the name
 * @property {{forwardPe: number|null, priceToBook: number|null, beta: number|null, revenueGrowth: number|null, earningsGrowth: number|null, grossMargin: number|null, netMargin: number|null, returnOnEquity: number|null, shortFloat: number|null}} [stats] // growth and margin ratios, already in percent
 * @property {string} source
 * @property {number} timestamp
 */

/** A finite, strictly positive number, or null. */
function positive(value) {
  return Number.isFinite(value) && value > 0 ? value : null;
}

const clampText = (v, max = 1_200) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : undefined;

/**
 * Build a MarketQuote, deriving change/changePct when the provider omits them.
 * @param {Partial<MarketQuote> & {symbol: string}} input
 * @returns {MarketQuote}
 */
export function makeQuote(input) {
  const parsed = parseSymbol(input.symbol, input.market);
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  const price = isNum(input.price) ? roundPrice(input.price) : null;
  if (price === null) {
    const err = new Error(`no price available for ${parsed.symbol}`);
    err.code = 'NO_PRICE';
    throw err;
  }
  let change = isNum(input.change) ? input.change : null;
  let changePct = isNum(input.changePct) ? input.changePct : null;
  const previousClose = isNum(input.previousClose) ? roundPrice(input.previousClose) : null;
  if (change === null && previousClose) change = roundPrice(price - previousClose);
  if (changePct === null && previousClose) changePct = Number((((price - previousClose) / previousClose) * 100).toFixed(2));
  const timestamp = isNum(input.timestamp) ? input.timestamp : Date.now();
  const freshness = gradeFreshness(timestamp, parsed.market);
  return {
    symbol: parsed.symbol,
    market: parsed.market,
    currency: input.currency || currencyOf(parsed.market),
    price,
    change: isNum(change) ? Number(change.toFixed(4)) : null,
    changePct: isNum(changePct) ? Number(changePct.toFixed(2)) : null,
    open: isNum(input.open) ? roundPrice(input.open) : null,
    high: isNum(input.high) ? roundPrice(input.high) : null,
    low: isNum(input.low) ? roundPrice(input.low) : null,
    previousClose,
    volume: isNum(input.volume) ? Math.round(input.volume) : null,
    timestamp,
    source: input.source || 'unknown',
    delaySeconds: isNum(input.delaySeconds) ? input.delaySeconds : input.delaySeconds === null ? null : null,
    stale: input.stale === true ? true : freshness.stale,
    freshness: input.freshness || freshness.note,
    ...(input.name ? { name: input.name } : {}),
    ...(input.nameZh ? { nameZh: input.nameZh } : {}),
    ...(input.exchange ? { exchange: input.exchange } : {}),
  };
}

/** @param {Partial<Candle>[]} rows */
export function makeCandles(rows) {
  const out = [];
  for (const r of rows || []) {
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    if (!isNum(r.timestamp) || !isNum(r.close)) continue;
    out.push({
      timestamp: r.timestamp,
      open: isNum(r.open) ? r.open : r.close,
      high: isNum(r.high) ? r.high : r.close,
      low: isNum(r.low) ? r.low : r.close,
      close: r.close,
      volume: isNum(r.volume) ? r.volume : 0,
    });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  // De-duplicate identical timestamps, keeping the last observation.
  const dedup = [];
  for (const c of out) {
    if (dedup.length && dedup[dedup.length - 1].timestamp === c.timestamp) dedup[dedup.length - 1] = c;
    else dedup.push(c);
  }
  return dedup;
}

/** @param {Partial<CompanyProfile> & {symbol: string}} input */
export function makeProfile(input) {
  const base = stockSymbol({ symbol: input.symbol, name: input.name, nameZh: input.nameZh, market: input.market, exchange: input.exchange, currency: input.currency });
  return {
    symbol: base.symbol,
    name: base.name,
    ...(input.nameZh || base.nameZh ? { nameZh: input.nameZh || base.nameZh } : {}),
    market: base.market,
    exchange: base.exchange,
    currency: base.currency,
    industry: clampText(input.industry, 120),
    sector: clampText(input.sector, 120),
    country: clampText(input.country, 60),
    website: clampText(input.website, 200),
    description: clampText(input.description, 1_200),
    marketCap: Number.isFinite(input.marketCap) ? input.marketCap : null,
    peRatio: Number.isFinite(input.peRatio) ? input.peRatio : null,
    sharesOutstanding: Number.isFinite(input.sharesOutstanding) ? input.sharesOutstanding : null,
    // Yahoo reports summaryDetail.dividendYield as a fractional rate on the
    // quoteSummary/v10 path (< 1 even for a 5% yielder), while some mirrors
    // already send percent. Anything below 1 is safely read as a fraction — no
    // real security yields ≥ 100% — anything at or above 1 is kept as percent.
    dividendYield: (() => {
      const rate = input.dividendYield;
      if (!Number.isFinite(rate) || rate <= 0) return null;
      const percent = rate < 1 ? rate * 100 : rate;
      return Math.round(percent * 10_000) / 10_000;
    })(),
    dividendRate: Number.isFinite(input.dividendRate) ? input.dividendRate : null,
    // Epoch ms, or nothing: a junk date must not render as 1970.
    exDividendDate: Number.isFinite(input.exDividendDate) && input.exDividendDate > 0 ? input.exDividendDate : null,
    // Percent, as the provider normalised it: fees are only published on the
    // profile path, so the provider owns the fraction-vs-percent dialect.
    expenseRatio: Number.isFinite(input.expenseRatio) && input.expenseRatio > 0 ? input.expenseRatio : null,
    fundFamily: clampText(input.fundFamily, 120),
    // Keep only facts worth showing: a name (or an investable ticker) plus a
    // sane weight, largest first, at most ten rows. Junk rows disappear rather
    // than render as "—" filler.
    holdings: Array.isArray(input.holdings)
      ? input.holdings
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            symbol: item.symbol && typeof item.symbol === 'string' && item.symbol.trim() ? item.symbol.trim().toUpperCase() : undefined,
            name: clampText(item.name, 120) || (item.symbol ? String(item.symbol).trim().toUpperCase() : ''),
            weight: Number.isFinite(item.weight) && item.weight > 0 && item.weight <= 100 ? item.weight : null,
          }))
          .filter((item) => item.name && item.weight != null)
          .sort((a, b) => (b.weight || 0) - (a.weight || 0))
          .slice(0, 10)
      : undefined,
    // The sector mix is the same shape as the holdings table — a label and a
    // share — so it gets the same honesty rules: no junk rows, no "—" filler,
    // biggest slice first. `key` stays as the provider's stable identifier so
    // the client can localise the label without matching English strings.
    sectors: Array.isArray(input.sectors)
      ? input.sectors
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            key: clampText(item.key, 40) || undefined,
            name: clampText(item.name, 60),
            weight: Number.isFinite(item.weight) && item.weight > 0 && item.weight <= 100 ? item.weight : null,
          }))
          .filter((item) => item.name && item.weight != null)
          .sort((a, b) => (b.weight || 0) - (a.weight || 0))
          .slice(0, 11)
      : undefined,
    // Sell-side consensus. Coverage is the gate: a rating list with nobody
    // behind it (Yahoo sends an empty block for funds) must not render as
    // "0 analysts, Hold".
    analysts: (() => {
      const raw = input.analysts;
      if (!raw || typeof raw !== 'object') return undefined;
      const count = Number.isFinite(raw.count) && raw.count > 0 ? Math.round(raw.count) : null;
      const targetMean = positive(raw.targetMean);
      const rating = clampText(raw.rating, 40);
      const ratingMean = Number.isFinite(raw.ratingMean) && raw.ratingMean > 0 && raw.ratingMean <= 5 ? raw.ratingMean : null;
      // A high/low pair that lost its mean is half a story; the range needs
      // both ends, and a one-sided range would misplace the marker.
      const targetHigh = positive(raw.targetHigh);
      const targetLow = positive(raw.targetLow);
      const range = targetHigh != null && targetLow != null && targetHigh > targetLow ? { targetHigh, targetLow } : { targetHigh: null, targetLow: null };
      // A rating without a target price or a head-count is a stray fragment,
      // not a consensus worth a card.
      if (count == null && targetMean == null) return undefined;
      return { targetMean, ...range, rating: rating || null, ratingMean, count };
    })(),
    // Growth and margin ratios arrive as fractions (0.117 = 11.7%) on the
    // quoteSummary path only, so they are normalised here like the yield.
    stats: (() => {
      const raw = input.stats;
      if (!raw || typeof raw !== 'object') return undefined;
      const pct = (value) => {
        if (!Number.isFinite(value)) return null;
        return Math.round(value * 100 * 10_000) / 10_000;
      };
      const out = {
        forwardPe: positive(raw.forwardPe),
        priceToBook: positive(raw.priceToBook),
        beta: Number.isFinite(raw.beta) ? raw.beta : null,
        revenueGrowth: pct(raw.revenueGrowth),
        earningsGrowth: pct(raw.earningsGrowth),
        grossMargin: pct(raw.grossMargin),
        netMargin: pct(raw.netMargin),
        returnOnEquity: pct(raw.returnOnEquity),
        shortFloat: pct(raw.shortFloat),
      };
      return Object.values(out).some((value) => value != null) ? out : undefined;
    })(),
    source: input.source || 'unknown',
    timestamp: Number.isFinite(input.timestamp) ? input.timestamp : Date.now(),
  };
}

/** Validate that an object is a usable MarketQuote (used by provider tests). */
export function assertQuote(q) {
  const problems = [];
  if (!q || typeof q !== 'object') problems.push('not an object');
  else {
    if (typeof q.symbol !== 'string' || !q.symbol) problems.push('symbol');
    if (!['US', 'HK', 'CN', 'JP', 'CRYPTO'].includes(q.market)) problems.push('market');
    if (!['USD', 'HKD', 'CNY', 'JPY', 'USDT'].includes(q.currency)) problems.push('currency');
    if (!Number.isFinite(q.price)) problems.push('price');
    if (!Number.isFinite(q.timestamp)) problems.push('timestamp');
    if (typeof q.source !== 'string' || !q.source) problems.push('source');
    if (!(q.delaySeconds === null || Number.isFinite(q.delaySeconds))) problems.push('delaySeconds');
    if (typeof q.stale !== 'boolean') problems.push('stale');
  }
  if (problems.length) throw new Error(`invalid MarketQuote: ${problems.join(', ')}`);
  return true;
}

/**
 * Provider contract. Concrete providers extend this and set `capabilities`.
 * A provider that cannot serve a request must throw a TradingError — never
 * return empty data silently (§74).
 */
export class MarketDataProvider {
  /**
   * @param {{id: string, label?: string, logger?: any, limiter?: any}} opts
   */
  constructor(opts) {
    this.id = opts.id;
    this.label = opts.label || opts.id;
    this.logger = opts.logger || null;
    this.limiter = opts.limiter || null;
    this.capabilities = { search: false, quote: false, candles: false, profile: false };
    this.markets = [];
    /** Intervals the provider can actually serve; `null` = unconstrained. */
    this.intervals = opts.intervals || null;
  }

  supports(feature, market) {
    if (!this.capabilities[feature]) return false;
    if (market && this.markets.length && !this.markets.includes(market)) return false;
    return true;
  }

  /** Interval gate used by the router so a provider is never asked for what it cannot do. */
  supportsInterval(interval) {
    return !this.intervals || this.intervals.includes(interval);
  }

  /**
   * Symbol gate, for instrument classes a provider cannot serve even though it
   * handles the market/feature (market indices live outside the stock venue
   * tables). Returning false removes the provider from the candidate list instead
   * of letting it fail and pollute its health (§44).
   */
  supportsSymbol(symbol, feature) {
    return true;
  }

  /* eslint-disable no-unused-vars */
  async searchStocks(query, market) {
    throw notImplemented(this, 'searchStocks');
  }

  async getQuote(symbol) {
    throw notImplemented(this, 'getQuote');
  }

  async getCandles(symbol, interval, range) {
    throw notImplemented(this, 'getCandles');
  }

  async getCompanyProfile(symbol) {
    throw notImplemented(this, 'getCompanyProfile');
  }
  /* eslint-enable no-unused-vars */
}

function notImplemented(provider, method) {
  const err = new Error(`${provider.id}.${method} is not supported`);
  err.code = 'NOT_IMPLEMENTED';
  err.provider = provider.id;
  return err;
}
