/**
 * Nasdaq earnings calendar (US only, keyless).
 *
 * Why this module exists: the single most expensive mistake in a US equity
 * portfolio is buying the day before an earnings report. The quote providers
 * know the price; SEC EDGAR knows the past; neither knows *when the next report
 * lands*. Nasdaq publishes that calendar as a plain JSON endpoint with no key,
 * no quota and no cookie — one request per date.
 *
 * The endpoint answers per day, so a window is a fan-out: one cached request per
 * calendar date. Weekends are skipped (Nasdaq returns no rows for them), and the
 * cache is shared process-wide, which is what keeps a page that asks for two
 * weeks of reports at fourteen upstream calls per six hours instead of per view.
 *
 * `time` in the payload distinguishes a pre-market report (`time-pre-market`)
 * from an after-close one (`time-after-hours`). That distinction matters for the
 * advice the UI gives: a pre-market report reprices the open, an after-close one
 * reprices the next open, and both make the following session untradeable on
 * momentum.
 */

import { PROVIDER_CONFIG } from './config.js';
import { httpGet, RateLimiter } from './http.js';

const CAL_URL = 'https://api.nasdaq.com/api/calendar/earnings';
const DAY_TTL_MS = 6 * 60 * 60 * 1000;
/** Nasdaq's own site is far more permissive than this; stay a good citizen. */
const NASDAQ_PER_MINUTE = 240;
const MAX_DAYS = 30;

const SESSION_BY_TIME = {
  'time-pre-market': 'pre',
  'time-after-hours': 'post',
  'time-not-supplied': 'unknown',
};

/**
 * Nasdaq formats money as `$88,237,580,000`, `$1.41`, `-$0.12` or `($0.12)`.
 * Anything else (an empty string, `N/A`) becomes null so the caller can tell
 * "zero" apart from "not reported".
 */
export function parseMoney(text) {
  if (text === null || text === undefined) return null;
  const raw = String(text).trim();
  if (!raw || /^n\/?a$/i.test(raw)) return null;
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const digits = raw.replace(/[^0-9.]/g, '');
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

/** Today's date in the exchange's own timezone, as `YYYY-MM-DD`. */
export function dateInNewYork(now = Date.now()) {
  // en-CA is the one locale whose short date is already ISO-ordered.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
}

/** `YYYY-MM-DD` + n days, staying in UTC so DST never shifts the result. */
export function addDays(date, n) {
  const [y, m, d] = String(date).split('-').map(Number);
  const stamp = Date.UTC(y, (m || 1) - 1, d || 1) + n * 86400000;
  const next = new Date(stamp);
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}

/** Whole days from `from` to `date`; negative when `date` is in the past. */
export function daysUntil(date, from) {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** The next `count` calendar dates that can carry a report (weekdays only). */
export function tradingDates(from, count) {
  const dates = [];
  let cursor = from;
  let guard = 0;
  while (dates.length < count && guard < count * 3 + 7) {
    const day = new Date(`${cursor}T00:00:00Z`).getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return dates;
}

/**
 * One day's payload → a flat event list. Kept pure so the offline suite can
 * feed it a recorded answer without touching the network.
 */
export function parseEarningsDay(payload) {
  const data = payload && payload.data;
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const events = [];
  for (const row of rows) {
    if (!row) continue;
    const symbol = String(row.symbol || '').trim().toUpperCase();
    if (!symbol) continue;
    events.push({
      symbol,
      name: row.name ? String(row.name) : null,
      session: SESSION_BY_TIME[row.time] || 'unknown',
      marketCap: parseMoney(row.marketCap),
      fiscalQuarterEnding: row.fiscalQuarterEnding ? String(row.fiscalQuarterEnding) : null,
      epsForecast: parseMoney(row.epsForecast),
      analysts: Number(row.noOfEsts) > 0 ? Number(row.noOfEsts) : null,
      lastYearEPS: parseMoney(row.lastYearEPS),
      lastYearReport: row.lastYearRptDt ? String(row.lastYearRptDt) : null,
    });
  }
  return { asOf: (data && data.asOf) || null, events };
}

export class EarningsCalendar {
  constructor(opts = {}) {
    this.limiter = opts.limiter || new RateLimiter(NASDAQ_PER_MINUTE);
    /** date → {at, value}; the value is `parseEarningsDay` plus its date. */
    this.days = new Map();
  }

  /** One calendar date, cached for six hours. */
  async day(date, { force = false } = {}) {
    const key = String(date).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error(`earnings calendar needs a YYYY-MM-DD date (got ${date})`);
    const cached = this.days.get(key);
    if (!force && cached && Date.now() - cached.at < DAY_TTL_MS) return cached.value;

    const res = await httpGet(`${CAL_URL}?date=${key}`, {
      provider: 'nasdaq',
      limiter: this.limiter,
      // Nasdaq's edge hangs up on a non-browser User-Agent (measured 2026-11-06:
      // the project UA times out at 12s, a Chrome UA answers 200 in 155ms), so
      // the UA is left to `HTTP_POLICY.userAgent`, which is already browser-shaped.
      headers: { ...PROVIDER_CONFIG.nasdaq.headers, 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const parsed = parseEarningsDay(res.json);
    const value = { date: key, asOf: parsed.asOf, events: parsed.events, source: 'nasdaq', timestamp: Date.now() };
    this.days.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * A window of weekday dates starting at `from` (default: today in New York).
   * Sequential on purpose: the limiter is per-provider, and fourteen parallel
   * requests would just queue behind it anyway.
   */
  async window({ from, days = 14, force = false } = {}) {
    const start = from ? String(from).slice(0, 10) : dateInNewYork();
    const span = Math.min(MAX_DAYS, Math.max(1, Math.trunc(Number(days)) || 14));
    const dates = tradingDates(start, span);
    const events = [];
    const failed = [];
    for (const date of dates) {
      try {
        const day = await this.day(date, { force });
        for (const event of day.events) events.push({ ...event, date });
      } catch (err) {
        failed.push({ date, error: (err && err.message) || 'upstream error' });
      }
    }
    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (b.marketCap || 0) - (a.marketCap || 0)));
    // The client asks "when does THIS ticker report", so the earliest hit wins.
    const bySymbol = {};
    for (const event of events) {
      if (!bySymbol[event.symbol]) bySymbol[event.symbol] = event;
    }
    return {
      from: dates[0] || start,
      to: dates[dates.length - 1] || start,
      today: dateInNewYork(),
      dates,
      events,
      bySymbol,
      failed,
      source: 'nasdaq',
      timestamp: Date.now(),
    };
  }
}

let shared = null;

/** Process-wide instance so a window is fetched once per six hours, not per view. */
export function earningsCalendar(opts = {}) {
  if (!shared) shared = new EarningsCalendar(opts);
  return shared;
}
