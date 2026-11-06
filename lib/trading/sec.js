/**
 * SEC EDGAR fundamentals (US only, keyless).
 *
 * Why this module exists: the quote providers in `providers/` answer "what is it
 * worth right now". They do not answer "what does the business earn", which is
 * the first thing anyone asks before buying a stock. EDGAR publishes that for
 * free, with no key and no per-call quota, so it is the natural second source
 * for a US-only fork.
 *
 * Two endpoints are used:
 *   - `company_tickers.json` maps a ticker to a zero-padded CIK (cached for a
 *     day; it is a ~700 KB file and changes slowly).
 *   - `companyfacts/CIK##########.json` returns every XBRL fact the filer has
 *     ever reported (cached for six hours; it only moves when a filing lands).
 *
 * SEC's fair-access policy asks every client to identify itself. The User-Agent
 * below names the project and a URL — no personal address is embedded, which
 * also keeps this file free of machine-specific paths.
 */

import { httpGet, RateLimiter } from './http.js';

const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const factsUrl = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`;

/** SEC fair access: stay under 10 requests/second (420/min ≈ 7/s). */
const SEC_PER_MINUTE = 420;

/**
 * SEC fair access asks for a User-Agent that identifies the client and carries
 * a contact address. Measured 2026-11-06: without an address-shaped contact
 * both `www.sec.gov` and `data.sec.gov` answer 403 ("Request Rate Threshold
 * Exceeded"), with one they answer 200. The address is the project's own
 * non-routable mailbox — deliberately not the maintainer's personal address.
 */
const USER_AGENT = 'dsh-trading-mode-us/0.9 (admin@dsh-trading-mode.local)';

const TICKER_TTL_MS = 24 * 60 * 60 * 1000;
const FACTS_TTL_MS = 6 * 60 * 60 * 1000;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Concept candidates, in preference order. Filers disagree about which tag they
 * use for the same line item, so each metric lists fallbacks and the first tag
 * that actually carries data wins.
 */
const METRICS = [
  { key: 'revenue', label: 'Revenue', unit: 'USD', concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'] },
  { key: 'grossProfit', label: 'Gross profit', unit: 'USD', concepts: ['GrossProfit'] },
  { key: 'operatingIncome', label: 'Operating income', unit: 'USD', concepts: ['OperatingIncomeLoss'] },
  { key: 'netIncome', label: 'Net income', unit: 'USD', concepts: ['NetIncomeLoss', 'ProfitLoss'] },
  { key: 'epsDiluted', label: 'EPS (diluted)', unit: 'USD/shares', concepts: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'] },
  { key: 'assets', label: 'Total assets', unit: 'USD', concepts: ['Assets'] },
  { key: 'liabilities', label: 'Total liabilities', unit: 'USD', concepts: ['Liabilities'] },
  { key: 'equity', label: 'Shareholders’ equity', unit: 'USD', concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { key: 'cash', label: 'Cash & equivalents', unit: 'USD', concepts: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  { key: 'sharesOutstanding', label: 'Shares outstanding', unit: 'shares', concepts: ['EntityCommonStockSharesOutstanding', 'CommonStockSharesOutstanding'] },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Duration of one XBRL row, or null for an instant (balance-sheet) fact. */
function spanOf(row) {
  const end = Date.parse(row.end || '');
  if (!Number.isFinite(end)) return null;
  const start = Date.parse(row.start || '');
  return { end, dur: Number.isFinite(start) ? (end - start) / DAY_MS : null };
}

/**
 * One concept's rows, reduced to a single comparable period.
 *
 * XBRL stores quarterly, year-to-date and annual figures under the same tag, so
 * "latest end" alone picks a six-month cumulative number and labels it a
 * quarter. The class is therefore decided once — annual when the filer still
 * files one recently, otherwise the latest quarter — and the year-ago value is
 * taken from the same class so the growth figure compares like with like.
 */
function candidateFor(entry) {
  if (!entry || !entry.units || typeof entry.units !== 'object') return null;
  const rows = [];
  for (const [unit, list] of Object.entries(entry.units)) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || !Number.isFinite(row.val)) continue;
      const span = spanOf(row);
      if (!span) continue;
      rows.push({ unit, val: row.val, end: span.end, dur: span.dur, fy: row.fy ?? null, fp: row.fp ?? null, form: row.form || null, filed: Date.parse(row.filed || '') || 0 });
    }
  }
  if (!rows.length) return null;
  const latest = (list) => list.reduce((a, b) => (!a || b.end > a.end || (b.end === a.end && b.filed > a.filed) ? b : a), null);
  const annual = latest(rows.filter((r) => r.dur != null && r.dur >= 300 && r.dur <= 400));
  const quarter = latest(rows.filter((r) => r.dur != null && r.dur >= 60 && r.dur <= 100));
  const instant = latest(rows.filter((r) => r.dur == null));
  const now = Date.now();
  // A two-year-old annual report is worse than a fresh quarter.
  const best = annual && now - annual.end < 540 * DAY_MS ? annual : quarter || annual || instant;
  if (!best) return null;
  let prior = null;
  if (best.dur != null) {
    const isAnnual = best.dur > 200;
    // Both classes compare against the same period a year earlier — a quarter is
    // "Q2 this year vs Q2 last year", never "this quarter vs the previous one",
    // which would be quarter-over-quarter under a misleading label.
    const target = best.end - YEAR_MS;
    const tolerance = isAnnual ? 60 * DAY_MS : 45 * DAY_MS;
    prior = latest(rows.filter((r) => r.unit === best.unit && r.dur != null && Math.abs(r.dur - best.dur) <= 30 && Math.abs(r.end - target) <= tolerance));
  }
  return { ...best, prior };
}

/**
 * Reduce a `companyfacts` payload to the handful of numbers a buyer cares
 * about. Pure: no network, no clock — this is what the offline suite exercises.
 *
 * @param {any} facts parsed `companyfacts` JSON
 * @returns {{entityName: string|null, metrics: Array<any>, fiscalYear: number|null, fiscalPeriod: string|null, filed: string|null, form: string|null}}
 */
export function pickMetrics(facts) {
  const empty = { entityName: null, metrics: [], fiscalYear: null, fiscalPeriod: null, filed: null, form: null };
  if (!facts || typeof facts !== 'object') return empty;
  const gaap = (facts.facts && facts.facts['us-gaap']) || {};
  const dei = (facts.facts && facts.facts.dei) || {};
  const metrics = [];

  for (const spec of METRICS) {
    // Filers switch tags over time: NVDA stopped reporting `Revenues` in 2022, so
    // taking the first concept that merely *has* data would show a four-year-old
    // number. All candidates are therefore compared, and the freshest one wins.
    let hit = null;
    let concept = null;
    for (const name of spec.concepts) {
      const candidate = candidateFor(gaap[name] || dei[name]);
      if (!candidate) continue;
      if (!hit || candidate.end > hit.end) {
        hit = candidate;
        concept = name;
      }
    }
    if (!hit) continue;
    metrics.push({
      key: spec.key,
      label: spec.label,
      concept,
      value: hit.val,
      unit: hit.unit || spec.unit,
      yoy: hit.prior && hit.prior.val !== 0 ? (hit.val - hit.prior.val) / Math.abs(hit.prior.val) : null,
      annual: hit.dur == null || hit.dur > 200,
      period: {
        end: new Date(hit.end).toISOString().slice(0, 10),
        fy: hit.fy,
        fp: hit.fp,
        form: hit.form,
        filed: hit.filed ? new Date(hit.filed).toISOString().slice(0, 10) : null,
      },
    });
  }

  // The most recent annual/quarterly period across all metrics describes the
  // snapshot as a whole; the UI shows it as "as of FY2025 Q3 (10-Q, filed …)".
  const newest = metrics
    .filter((m) => m.period.form)
    .sort((a, b) => (a.period.end < b.period.end ? 1 : -1))[0];

  return {
    entityName: typeof facts.entityName === 'string' ? facts.entityName : null,
    metrics,
    fiscalYear: newest ? newest.period.fy : null,
    fiscalPeriod: newest ? newest.period.fp : null,
    filed: newest ? newest.period.filed : null,
    form: newest ? newest.period.form : null,
  };
}

export class SecClient {
  constructor(opts = {}) {
    this.logger = opts.logger;
    this.limiter = opts.limiter || new RateLimiter(SEC_PER_MINUTE);
    this.tickers = null;
    this.tickersAt = 0;
    this.cache = new Map();
  }

  async tickerMap({ force = false } = {}) {
    const fresh = this.tickers && Date.now() - this.tickersAt < TICKER_TTL_MS;
    if (fresh && !force) return this.tickers;
    const tickerRes = await httpGet(TICKERS_URL, {
      provider: 'sec',
      limiter: this.limiter,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const payload = tickerRes.json;
    const map = new Map();
    for (const row of Object.values(payload || {})) {
      if (!row || !row.ticker || !row.cik_str) continue;
      map.set(String(row.ticker).toUpperCase(), { cik: String(row.cik_str).padStart(10, '0'), title: row.title || null });
    }
    this.tickers = map;
    this.tickersAt = Date.now();
    return map;
  }

  /** @returns {Promise<{symbol: string, cik: string, entityName: string|null, metrics: any[], fiscalYear: number|null, fiscalPeriod: string|null, filed: string|null, form: string|null, source: string, timestamp: number}>} */
  async fundamentals(symbol, { force = false } = {}) {
    const ticker = String(symbol || '').trim().toUpperCase();
    if (!ticker) throw new Error('SEC fundamentals needs a ticker');

    const cached = this.cache.get(ticker);
    if (!force && cached && Date.now() - cached.at < FACTS_TTL_MS) return cached.value;

    const map = await this.tickerMap();
    const row = map.get(ticker);
    if (!row) {
      // ETFs and funds file with the SEC too, but not against XBRL company facts;
      // an empty answer is the honest one and the UI says so.
      const value = { symbol: ticker, cik: null, entityName: null, metrics: [], fiscalYear: null, fiscalPeriod: null, filed: null, form: null, source: 'sec', timestamp: Date.now(), reason: 'no CIK for this ticker' };
      this.cache.set(ticker, { at: Date.now(), value });
      return value;
    }

    const factsRes = await httpGet(factsUrl(row.cik), {
      provider: 'sec',
      limiter: this.limiter,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const picked = pickMetrics(factsRes.json);
    const value = {
      symbol: ticker,
      cik: row.cik,
      entityName: picked.entityName || row.title || null,
      ...picked,
      source: 'sec',
      timestamp: Date.now(),
    };
    this.cache.set(ticker, { at: Date.now(), value });
    return value;
  }
}

let shared = null;

/** Process-wide instance so the ticker map is fetched once, not per request. */
export function secClient(opts = {}) {
  if (!shared) shared = new SecClient(opts);
  return shared;
}
