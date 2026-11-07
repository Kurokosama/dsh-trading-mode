/**
 * Yahoo Finance provider — the spec's primary market data source (§7/§51).
 *
 * Uses only documented, unauthenticated JSON endpoints. No scraping, no
 * websocket reverse engineering (搂16). The crumb/cookie handshake is the
 * officially required dance for the quote endpoints; it is refreshed lazily and
 * retried once when Yahoo answers 401/403.
 *
 * NOTE: from some networks (including the build machine) Yahoo answers 403 for
 * every request. The provider then reports a blocked upstream and the Market
 * Data Service falls through to the next provider in the chain, which is the
 * intended behaviour of the abstraction.
 */

import { PROVIDER_CONFIG, RANGE_CONFIG } from '../config.js';
import { CODES, TradingError } from '../errors.js';
import { httpGet, num } from '../http.js';
import { MarketDataProvider, makeCandles, makeProfile, makeQuote } from '../schema.js';
import { currencyOf, parseSymbol } from '../symbols.js';

const RANGE_MAP = { '1d': '1d', '5d': '5d', '1mo': '1mo', '3mo': '3mo', '6mo': '6mo', '1y': '1y', '5y': '5y', max: 'max' };
const INTERVAL_MAP = { '5m': '5m', '15m': '15m', '30m': '30m', '1h': '60m', '1d': '1d', '1wk': '1wk' };
const EXCHANGE_NAMES = {
  NMS: 'NASDAQ',
  NGM: 'NASDAQ',
  NCM: 'NASDAQ',
  NYQ: 'NYSE',
  PCX: 'NYSE Arca',
  ASE: 'AMEX',
  HKG: 'HKEX',
};

/**
 * v7 keeps both sessions in one row (preMarketPrice, postMarketPrice) and marks
 * which one is live via marketState; anything outside those states has no
 * extended print worth showing, so it returns undefined rather than a stale one.
 * @param {any} row
 */
/** How stale an overnight after-hours print may be before it stops counting. */
const EXTENDED_MAX_AGE_MS = 20 * 60 * 60 * 1000;

function extendedOf(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return undefined;
  const state = typeof row.marketState === 'string' ? row.marketState.toUpperCase() : '';
  const pre = state === 'PRE' || state === 'PREPRE';
  const post = state === 'POST' || state === 'POSTPOST';
  // After the bell the venue reports CLOSED while the after-hours print is still
  // the most recent trade — worth showing, but only while it is fresh, because a
  // Friday evening print on Sunday would read as today's move.
  const latePost = !pre && !post && state === 'CLOSED';
  if (!pre && !post && !latePost) return undefined;
  const price = num(pre ? row.preMarketPrice : row.postMarketPrice);
  if (price === null) return undefined;
  const at = num(pre ? row.preMarketTime : row.postMarketTime);
  if (latePost && (at === null || now - at * 1000 > EXTENDED_MAX_AGE_MS)) return undefined;
  return {
    session: pre ? 'pre' : 'post',
    price,
    change: num(pre ? row.preMarketChange : row.postMarketChange),
    changePct: num(pre ? row.preMarketChangePercent : row.postMarketChangePercent),
    at: at === null ? null : at * 1000,
  };
}

export class YahooProvider extends MarketDataProvider {
  constructor(opts) {
    super({ id: 'yahoo', label: PROVIDER_CONFIG.yahoo.label, ...opts });
    this.capabilities = { search: true, quote: true, candles: true, profile: true, news: true };
    this.markets = ['US', 'HK'];
    this.intervals = PROVIDER_CONFIG.yahoo.intervals;
    this.session = null; // { cookie, crumb, at }
  }

  /** Acquire the cookie+crumb pair required by Yahoo's authenticated endpoints. */
  async ensureSession(force = false) {
    const now = Date.now();
    if (!force && this.session && now - this.session.at < 3_600_000) return this.session;
    const cfg = PROVIDER_CONFIG.yahoo;
    let cookie = '';
    try {
      const res = await httpGet(cfg.cookieUrl, { provider: this.id, retries: 0, accept: 'text', allowErrorStatus: true, limiter: this.limiter });
      const raw = res.headers && typeof res.headers.get === 'function' ? res.headers.get('set-cookie') : '';
      cookie = (String(raw || '').match(/\b(A1|A3)=[^;]+/) || [''])[0];
    } catch {
      cookie = '';
    }
    const crumbRes = await httpGet(`${cfg.quoteBase}${cfg.crumbPath}`, {
      provider: this.id,
      retries: 0,
      accept: 'text',
      limiter: this.limiter,
      headers: cookie ? { Cookie: cookie } : {},
    }).catch(() => ({ body: '' }));
    const crumb = typeof crumbRes.body === 'string' && crumbRes.body.length < 32 ? crumbRes.body.trim() : '';
    this.session = { cookie, crumb, at: now };
    return this.session;
  }

  /** GET with the session attached, refreshing the crumb once on 401/403. */
  async authed(url, { useCrumb = true } = {}) {
    const session = await this.ensureSession();
    const headers = {};
    if (session.cookie) headers.Cookie = session.cookie;
    if (useCrumb && session.crumb) headers['X-Frag'] = '';
    const withCrumb = (base, crumb) => {
      if (!useCrumb || !crumb) return base;
      return `${base}${base.includes('?') ? '&' : '?'}crumb=${encodeURIComponent(crumb)}`;
    };
    try {
      return await httpGet(withCrumb(url, session.crumb), { provider: this.id, limiter: this.limiter, headers });
    } catch (err) {
      if (err && (err.status === 401 || err.status === 403)) {
        const fresh = await this.ensureSession(true);
        return httpGet(withCrumb(url, fresh.crumb), { provider: this.id, limiter: this.limiter, headers });
      }
      throw err;
    }
  }

  async searchStocks(query, market) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const url = `${cfg.quoteBase}${cfg.searchPath}?q=${encodeURIComponent(query)}&quotesCount=20&newsCount=0&listsCount=0&enableFuzzyQuery=false`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
    const quotes = (res.json && res.json.quotes) || [];
    const out = [];
    for (const q of quotes) {
      if (!q || typeof q.symbol !== 'string') continue;
      const quoteType = String(q.quoteType || '').toUpperCase();
      if (quoteType && !['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX'].includes(quoteType)) continue;
      const isHK = /\.HK$/i.test(q.symbol);
      const mkt = isHK ? 'HK' : 'US';
      if (market && market !== mkt) continue;
      let parsed;
      try {
        parsed = parseSymbol(q.symbol, mkt);
      } catch {
        continue;
      }
      if (parsed.market !== mkt) continue;
      const name = q.longname || q.shortname || q.symbol;
      out.push({
        symbol: parsed.symbol,
        exchangeSymbol: parsed.symbol,
        name,
        market: mkt,
        exchange: EXCHANGE_NAMES[q.exchange] || q.exchDisp || (mkt === 'HK' ? 'HKEX' : 'NASDAQ'),
        currency: currencyOf(mkt),
        quoteType,
      });
      if (out.length >= 12) break;
    }
    return out;
  }

  async getQuote(symbol) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    try {
      // `fields=` truncates the v7 payload to just the named fields. Asking for
      // regularMarketPrice alone silently stripped regularMarketChange /
      // ChangePercent / PreviousClose, so every watchlist row rendered as
      // "$344.34 —" with no day change. Request the whole row instead.
      // includePrePost: the same row then carries the pre/post session price, so
      // a US watchlist can show what the market is doing outside 09:30–16:00 ET
      // without a second request. The fields only mean something in their own
      // session, which is why the provider stamps the session onto them.
      const res = await this.authed(`${cfg.quoteBase}${cfg.quotePath}?symbols=${encodeURIComponent(parsed.symbol)}&includePrePost=true`);
      const row = res.json && res.json.quoteResponse && res.json.quoteResponse.result && res.json.quoteResponse.result[0];
      if (!row || !num(row.regularMarketPrice)) throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
      const quote = makeQuote({
        symbol: parsed.symbol,
        market: parsed.market,
        currency: row.currency || currencyOf(parsed.market),
        price: num(row.regularMarketPrice),
        change: num(row.regularMarketChange),
        changePct: num(row.regularMarketChangePercent),
        open: num(row.regularMarketOpen),
        high: num(row.regularMarketDayHigh),
        low: num(row.regularMarketDayLow),
        previousClose: num(row.regularMarketPreviousClose),
        volume: num(row.regularMarketVolume),
        timestamp: num(row.regularMarketTime) ? num(row.regularMarketTime) * 1000 : Date.now(),
        name: row.longName || row.shortName || undefined,
        exchange: EXCHANGE_NAMES[row.fullExchangeName] || row.fullExchangeName || undefined,
        source: this.id,
        delaySeconds: PROVIDER_CONFIG.yahoo.delaySeconds,
        extended: extendedOf(row),
      });
      // A quote with no day change renders as "$344.34 —" in the watchlist,
      // which is nearly information-free. The chart meta always carries
      // chartPreviousClose, so re-derive the row from there when the quote
      // endpoint still omits the change fields.
      if (quote.change === null && quote.changePct === null) {
        try {
          return await this.quoteFromChart(parsed);
        } catch {
          return quote;
        }
      }
      return quote;
    } catch (err) {
      if (err instanceof TradingError && err.code === CODES.UPSTREAM_BLOCKED) throw err;
      // Fallback: the chart endpoint is more permissive and carries a usable meta block.
      return this.quoteFromChart(parsed);
    }
  }

  async quoteFromChart(parsed) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const res = await httpGet(`${cfg.quoteBase}${cfg.chartPath}/${encodeURIComponent(parsed.symbol)}?range=1d&interval=1d`, {
      provider: this.id,
      limiter: this.limiter,
    });
    const meta = res.json && res.json.chart && res.json.chart.result && res.json.chart.result[0] && res.json.chart.result[0].meta;
    if (!meta || !num(meta.regularMarketPrice)) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no quote for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return makeQuote({
      symbol: parsed.symbol,
      market: parsed.market,
      currency: meta.currency || currencyOf(parsed.market),
      price: num(meta.regularMarketPrice),
      previousClose: num(meta.chartPreviousClose) ?? num(meta.previousClose),
      high: num(meta.regularMarketDayHigh),
      low: num(meta.regularMarketDayLow),
      volume: num(meta.regularMarketVolume),
      timestamp: num(meta.regularMarketTime) ? num(meta.regularMarketTime) * 1000 : Date.now(),
      name: meta.longName || meta.shortName || undefined,
      source: this.id,
      delaySeconds: PROVIDER_CONFIG.yahoo.delaySeconds,
    });
  }

  async getCandles(symbol, interval, range) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    const yInterval = INTERVAL_MAP[interval];
    const yRange = RANGE_MAP[range] || RANGE_MAP['6mo'];
    if (!yInterval) throw new TradingError(CODES.UNSUPPORTED_INTERVAL, `yahoo does not support interval ${interval}`, { provider: this.id });
    const url = `${cfg.quoteBase}${cfg.chartPath}/${encodeURIComponent(parsed.symbol)}?range=${yRange}&interval=${yInterval}&includePrePost=false&events=div%2Csplit`;
    const res = await httpGet(url, { provider: this.id, limiter: this.limiter });
    const result = res.json && res.json.chart && res.json.chart.result && res.json.chart.result[0];
    if (!result || !result.timestamp || !result.indicators || !result.indicators.quote) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo returned no candles for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    const q = result.indicators.quote[0];
    const rows = result.timestamp.map((ts, i) => ({
      timestamp: ts * 1000,
      open: num(q.open && q.open[i]),
      high: num(q.high && q.high[i]),
      low: num(q.low && q.low[i]),
      close: num(q.close && q.close[i]),
      volume: num(q.volume && q.volume[i]) || 0,
    }));
    const candles = makeCandles(rows);
    if (!candles.length) {
      throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo returned an empty candle series for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    }
    return candles.slice(-Math.min(candles.length, maxBars(range)));
  }

  async getCompanyProfile(symbol) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    // fundProfile carries the ETF facts (sponsor, expense ratio), topHoldings the
    // ten largest positions, financialData the sell-side consensus and
    // defaultKeyStatistics the per-share ratios; each is a separate module on
    // quoteSummary/v10. Requesting them for the wrong instrument costs nothing:
    // Yahoo answers {}.
    const url = `${cfg.quoteBase}${cfg.profilePath}/${encodeURIComponent(parsed.symbol)}?modules=assetProfile%2Cprice%2CsummaryDetail%2CfundProfile%2CtopHoldings%2CfinancialData%2CdefaultKeyStatistics%2CearningsHistory`;
    const res = await this.authed(url);
    const row = res.json && res.json.quoteSummary && res.json.quoteSummary.result && res.json.quoteSummary.result[0];
    if (!row) throw new TradingError(CODES.DATA_UNAVAILABLE, `yahoo has no profile for ${parsed.symbol}`, { provider: this.id, symbol: parsed.symbol });
    const a = row.assetProfile || {};
    const p = row.price || {};
    const d = row.summaryDetail || {};
    const f = row.fundProfile || {};
    const fees = f.feesExpensesInvestment || {};
    const th = row.topHoldings || {};
    const fin = row.financialData || {};
    const ks = row.defaultKeyStatistics || {};
    const eh = row.earningsHistory || {};
    return makeProfile({
      symbol: parsed.symbol,
      market: parsed.market,
      name: p.longName || p.shortName || parsed.symbol,
      exchange: p.exchangeName || (parsed.market === 'HK' ? 'HKEX' : 'NASDAQ'),
      currency: p.currency || currencyOf(parsed.market),
      industry: a.industry,
      sector: a.sector,
      country: a.country,
      website: a.website,
      description: a.longBusinessSummary,
      // Yahoo reports each quarter as {raw: epoch, fmt: 'YYYY-MM-DD'} and the
      // surprise as a fraction (-0.0321 for -3.21%). The provider owns that
      // dialect, so the schema only ever sees percent and an ISO date.
      earningsSurprises: Array.isArray(eh.history)
        ? eh.history.map((item) => {
            const q = item && item.quarter ? item.quarter : null
            const when = q && typeof q.fmt === 'string' ? q.fmt : q && typeof q.raw === 'number' ? new Date(q.raw * 1000).toISOString().slice(0, 10) : null
            return {
              quarter: when,
              actual: fieldNum(item && item.epsActual),
              estimate: fieldNum(item && item.epsEstimate),
              surprisePct: fieldNum(item && item.surprisePercent) == null ? null : round4(fieldNum(item && item.surprisePercent) * 100),
              currency: (item && item.currency) || p.currency || currencyOf(parsed.market),
            }
          })
        : undefined,
      marketCap: fieldNum(p.marketCap) ?? fieldNum(d.marketCap),
      peRatio: fieldNum(d.trailingPE) ?? fieldNum(d.forwardPE),
      sharesOutstanding: fieldNum(d.sharesOutstanding),
      // Funds report the yield under `yield` and leave `dividendYield` empty;
      // stocks report `dividendYield` as a fraction (0.0032 for 0.32%).
      // Left as Yahoo's fraction (0.0032 = 0.32%): makeProfile owns the
      // fraction-vs-percent normalisation for yields, because mirrors on the
      // same schema sometimes send the percent already.
      dividendYield: round4(fieldNum(d.dividendYield) ?? fieldNum(d.yield)),
      dividendRate: round4(fieldNum(d.trailingAnnualDividendRate) ?? fieldNum(d.dividendRate)),
      // Funds frequently answer {} here; stocks answer the last scheduled
      // ex-dividend day, which may already be in the past. Seconds → ms.
      exDividendDate: (() => {
        const at = fieldNum(d.exDividendDate);
        if (!Number.isFinite(at) || at <= 0) return null;
        return at < 1e12 ? at * 1000 : at;
      })(),
      // `annualReportExpenseRatio` is the figure the fund publishes; the net and
      // gross aliases are frequently empty objects, so they are fallbacks only.
      // Yahoo reports it as a fraction (0.000945) — scaled to percent here.
      expenseRatio: (() => {
        const fee = fieldNum(fees.annualReportExpenseRatio) ?? fieldNum(fees.netExpRatio) ?? fieldNum(fees.grossExpRatio);
        return fee == null ? null : round4(fee * 100);
      })(),
      fundFamily: f.family,
      // topHoldings.holdings carries the ten largest positions; holdingPercent is
      // a fraction of the fund (0.0839 for 8.39%), so it is scaled to percent
      // here and every downstream consumer reads plain percentages.
      holdings: (Array.isArray(th.holdings) ? th.holdings : []).map((item) => ({
        symbol: item && item.symbol,
        name: item && (item.holdingName || item.symbol),
        weight: item && fieldNum(item.holdingPercent) != null ? round4(fieldNum(item.holdingPercent) * 100) : null,
      })),
      // sectorWeightings is an array of single-key objects
      // (`[{ technology: { raw: 0.4048 } }, …]`), one key per sector, values
      // again as fractions of the fund.
      sectors: (Array.isArray(th.sectorWeightings) ? th.sectorWeightings : []).map((entry) => {
        const key = entry && typeof entry === 'object' ? Object.keys(entry)[0] : '';
        const share = key ? fieldNum(entry[key]) : null;
        return {
          key: key || undefined,
          name: SECTOR_LABELS[key] || (key ? humanise(key) : ''),
          weight: share == null ? null : round4(share * 100),
        };
      }),
      // Sell-side consensus lives in financialData; funds leave it empty and
      // makeProfile drops the block when nobody covers the name.
      analysts: {
        targetMean: fieldNum(fin.targetMeanPrice),
        targetHigh: fieldNum(fin.targetHighPrice),
        targetLow: fieldNum(fin.targetLowPrice),
        rating: typeof fin.recommendationKey === 'string' ? fin.recommendationKey.trim() : null,
        ratingMean: fieldNum(fin.recommendationMean),
        count: fieldNum(fin.numberOfAnalystOpinions),
      },
      // Growth and margins stay fractions here; makeProfile converts them.
      stats: {
        forwardPe: fieldNum(ks.forwardPE),
        priceToBook: fieldNum(ks.priceToBook),
        beta: fieldNum(ks.beta),
        revenueGrowth: fieldNum(fin.revenueGrowth),
        earningsGrowth: fieldNum(fin.earningsGrowth),
        grossMargin: fieldNum(fin.grossMargins),
        netMargin: fieldNum(fin.profitMargins),
        returnOnEquity: fieldNum(fin.returnOnEquity),
        shortFloat: fieldNum(ks.shortPercentOfFloat),
      },
      source: this.id,
      timestamp: Date.now(),
    });
  }

  /**
   * Headlines for one symbol.
   *
   * Yahoo's search endpoint is the only free news feed it exposes, and it
   * matches on text as well as tickers: the top row for AAPL was a peer's
   * earnings call that merely listed it under relatedTickers. Rows are
   * therefore filtered to those that actually name the symbol, ranked so a
   * story where the symbol leads beats one that mentions it in passing, and
   * only then trimmed — otherwise the card fills with other companies' news.
   */
  async getNews(symbol, limit = 6) {
    const cfg = PROVIDER_CONFIG.yahoo;
    const parsed = parseSymbol(symbol);
    const count = Math.min(12, Math.max(1, Math.round(Number(limit) || 6)));
    const url = `${cfg.quoteBase}/v1/finance/search?q=${encodeURIComponent(parsed.symbol)}&newsCount=${count * 3}&quotesCount=0`;
    const res = await this.authed(url);
    const rows = res.json && Array.isArray(res.json.news) ? res.json.news : [];
    // The search feed matches on text, so a story that merely mentions the
    // name can rank beside one that is about it. A row that lists only a
    // couple of tickers is focused on them; one that lists a dozen is a
    // round-up. Weighting by that keeps "Apple is cutting AI budgets" above
    // "Uber's robo push", which happens to list Apple first.
    const rank = (item) => {
      const tickers = Array.isArray(item.relatedTickers)
        ? item.relatedTickers.map((ticker) => String(ticker).toUpperCase())
        : [];
      const at = tickers.indexOf(parsed.symbol);
      if (at < 0) return -1;
      const focus = tickers.length <= 2 ? 2 : tickers.length <= 5 ? 1.5 : 1;
      return (at === 0 ? 2 : 1) * focus;
    };
    return rows
      .map((item) => ({ item, score: rank(item) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score || (fieldNum(b.item.providerPublishTime) || 0) - (fieldNum(a.item.providerPublishTime) || 0))
      .slice(0, count)
      .map(({ item }) => ({
        id: typeof item.uuid === 'string' ? item.uuid : undefined,
        title: item.title,
        publisher: item.publisher,
        link: item.link,
        at: fieldNum(item.providerPublishTime) ? fieldNum(item.providerPublishTime) * 1000 : null,
      }));
  }
}

// Yahoo's sector identifiers are snake_case and stable; the labels below are
// the readings its own site uses, so the client only has to localise English.
const SECTOR_LABELS = {
  realestate: 'Real estate',
  consumer_cyclical: 'Consumer cyclical',
  basic_materials: 'Basic materials',
  consumer_defensive: 'Consumer defensive',
  technology: 'Technology',
  communication_services: 'Communication services',
  financial_services: 'Financial services',
  utilities: 'Utilities',
  industrials: 'Industrials',
  energy: 'Energy',
  healthcare: 'Healthcare',
};

function humanise(key) {
  return key.replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function round4(value) {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : null;
}

/**
 * Yahoo's quoteSummary/v10 wraps every number as `{ raw, fmt, longFmt }`, while
 * the v7 quote endpoint returns plain numbers. `num()` only understands plain
 * values, so profile fields need this unwrapping step first — reading the raw
 * member (and only then parsing the display string) keeps the fact, not the
 * rounded presentation.
 */
function fieldNum(value) {
  if (value && typeof value === 'object') {
    const direct = num(value.raw);
    if (direct != null) return direct;
    return num(typeof value.fmt === 'string' ? value.fmt : null);
  }
  return num(value);
}

function maxBars(range) {
  const cfg = RANGE_CONFIG[range] || RANGE_CONFIG['6mo'];
  return Math.min(3_000, Math.max(30, cfg.days * (range === '1d' || range === '5d' ? 40 : 1)));
}
