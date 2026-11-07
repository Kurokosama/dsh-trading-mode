/**
 * US macro-data release calendar (added in 0.5.0 at the user's request: the
 * event card must warn about *market-moving prints*, not only company
 * earnings).
 *
 * Why a curated table instead of a live feed: every authoritative source is
 * hostile to server-side fetches — BLS answers plain requests with HTTP 403
 * (Akamai TLS fingerprinting, Chrome user agents included) and Nasdaq's
 * `/api/calendar/economic` endpoint answers 404. The release *schedule*,
 * however, is published months in advance and rarely moves, so a hand-verified
 * table is the honest answer: every row below was read from the official
 * calendar page named in the comment, on the date in `VERIFIED_ON`.
 *
 * Refresh procedure (when the table runs out): open
 *   https://www.bls.gov/schedule/news_release/{cpi,ppi,empsit}.htm
 *   https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
 *   https://www.bea.gov/news/schedule
 * in a real browser (a browser context passes the bot wall; a server does not)
 * and append the rows that follow, keeping date order. All times are US
 * Eastern as published: `08:30` covers CPI/PPI/employment/GDP/PCE, and the
 * FOMC row carries the statement time (`14:00`).
 */

/** The day the whole table was last re-checked against the official pages. */
export const MACRO_VERIFIED_ON = '2026-11-06';

/** Stable machine kinds; the client maps these to localized names. */
const KINDS = new Set(['cpi', 'ppi', 'jobs', 'gdp', 'pce', 'fomc']);

/**
 * @typedef {{
 *   date: string,   // ISO 'YYYY-MM-DD', the release day
 *   time: string,   // US Eastern, 'HH:MM' in 24h
 *   kind: 'cpi'|'ppi'|'jobs'|'gdp'|'pce'|'fomc',
 *   ref: string,    // what is being released (English, no locale fuss)
 * }} MacroRow
 */

/** @type {MacroRow[]} Sorted by (date, time). */
export const MACRO_EVENTS = [
  { date: '2026-11-10', time: '08:30', kind: 'cpi', ref: 'October 2026 CPI' },
  { date: '2026-11-13', time: '08:30', kind: 'ppi', ref: 'October 2026 PPI' },
  { date: '2026-11-25', time: '08:30', kind: 'gdp', ref: 'Q3 2026 GDP, second estimate' },
  { date: '2026-11-25', time: '08:30', kind: 'pce', ref: 'October 2026 Personal Income and Outlays (PCE)' },
  { date: '2026-12-04', time: '08:30', kind: 'jobs', ref: 'November 2026 Employment Situation' },
  { date: '2026-12-09', time: '14:00', kind: 'fomc', ref: 'FOMC meeting Dec 8–9, statement and SEP' },
  { date: '2026-12-10', time: '08:30', kind: 'cpi', ref: 'November 2026 CPI' },
  { date: '2026-12-15', time: '08:30', kind: 'ppi', ref: 'November 2026 PPI' },
  { date: '2026-12-23', time: '08:30', kind: 'gdp', ref: 'Q3 2026 GDP, third estimate' },
  { date: '2026-12-23', time: '08:30', kind: 'pce', ref: 'November 2026 Personal Income and Outlays (PCE)' },
  { date: '2027-01-08', time: '08:30', kind: 'jobs', ref: 'December 2026 Employment Situation' },
  { date: '2027-01-13', time: '08:30', kind: 'cpi', ref: 'December 2026 CPI' },
  { date: '2027-01-14', time: '08:30', kind: 'ppi', ref: 'December 2026 PPI' },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC-safe duration in whole days between two ISO dates ('2026-11-10'). */
function isoDaysBetween(from, to) {
  const a = /^(\d{4})-(\d{2})-(\d{2})$/.exec(from);
  const b = /^(\d{4})-(\d{2})-(\d{2})$/.exec(to);
  if (!a || !b) return null;
  const ms = Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])) - Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
  return Math.round(ms / DAY_MS);
}

/**
 * Macro releases inside a calendar-day window from `from`.
 *
 * * `from` — inclusive start date ('YYYY-MM-DD'; anything unparsable counts as
 *   today, so a caller can pass client-provided data unchecked);
 * * `days` — window length in calendar days, 0 = today only; anything outside
 *   1..90 clamps, negatives behave like 0.
 *
 * @returns {Array<MacroRow & {days: number}>} filtered copies, in date order.
 */
export function upcomingMacro(from, days) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : todayIso();
  const window = Number.isFinite(days) ? Math.max(0, Math.min(90, Math.floor(days))) : 0;
  return MACRO_EVENTS.flatMap((row) => {
    const offset = isoDaysBetween(start, row.date);
    if (offset === null || offset < 0 || offset > window) return [];
    return [{ ...row, days: offset }];
  });
}

/** Today's date as the server sees it (UTC midnight view, ISO). */
export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/** True when the table itself is well-formed (used by the offline suite). */
export function macroTableIsSane() {
  return MACRO_EVENTS.every((row) => KINDS.has(row.kind) && /^\d{4}-\d{2}-\d{2}$/.test(row.date) && /^\d{2}:\d{2}$/.test(row.time));
}
