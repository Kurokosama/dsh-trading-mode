/**
 * NYSE closures and early closes (added in 1.1.0).
 *
 * Why a table: an exchange calendar is published years ahead and does not move,
 * while every authoritative endpoint is either rate-limited or wrapped in a
 * bot wall. The session chip used to say "regular-hours schedule only; one-off
 * holidays are not considered" — that caveat is worse than useless on
 * Thanksgiving morning, when the panel showed US "open" against a closed
 * market. Every row below was read from the official page named in
 * `CLOSURES_SOURCE` on `CLOSURES_VERIFIED_ON`.
 *
 * Refresh procedure (once the table runs out — 2028 is the last covered year):
 * open https://www.nyse.com/markets/hours-calendars and append the published
 * rows, keeping date order. Only *full-day* closures and the 13:00 ET early
 * closes belong here; the regular 09:30–16:00 window lives in config.js.
 *
 * Observed dates matter more than nominal ones: when a fixed-date holiday
 * falls on a weekend the exchange moves the closure (2026 Independence Day
 * closes Friday 3 July, 2027 Christmas closes Friday 24 December), so the rows
 * carry the *observed* day. 2028 has no New Year's Day closure at all — the
 * page says so explicitly.
 */

/** The day the whole table was last re-checked against the official page. */
export const CLOSURES_VERIFIED_ON = '2026-11-06';

/** Where the rows come from. Quoted in the UI so the claim is checkable. */
export const CLOSURES_SOURCE = 'https://www.nyse.com/markets/hours-calendars';

/** US Eastern wall clock when the market closes early. */
export const EARLY_CLOSE_TIME = '13:00';

/**
 * @typedef {{
 *   date: string,        // ISO 'YYYY-MM-DD', the observed day in New York
 *   name: string,        // English, as published
 *   nameZh: string,      // short Chinese label for the panel
 *   close: string|null,  // null = no trading at all; 'HH:MM' = early close
 * }} ClosureRow
 */

/** @type {ClosureRow[]} Sorted by date; full-day closures and early closes mixed. */
export const NYSE_CLOSURES = Object.freeze(
  [
    // 2026
    { date: '2026-01-01', name: "New Year's Day", nameZh: '元旦', close: null },
    { date: '2026-01-19', name: 'Martin Luther King, Jr. Day', nameZh: '马丁·路德·金纪念日', close: null },
    { date: '2026-02-16', name: "Washington's Birthday", nameZh: '总统日', close: null },
    { date: '2026-04-03', name: 'Good Friday', nameZh: '耶稣受难日', close: null },
    { date: '2026-05-25', name: 'Memorial Day', nameZh: '阵亡将士纪念日', close: null },
    { date: '2026-06-19', name: 'Juneteenth National Independence Day', nameZh: '六月节', close: null },
    { date: '2026-07-03', name: 'Independence Day (observed)', nameZh: '独立日', close: null },
    { date: '2026-09-07', name: 'Labor Day', nameZh: '劳动节', close: null },
    { date: '2026-11-26', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
    { date: '2026-11-27', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
    { date: '2026-12-24', name: 'Christmas Eve', nameZh: '圣诞前夜', close: '13:00' },
    { date: '2026-12-25', name: 'Christmas Day', nameZh: '圣诞节', close: null },
    // 2027
    { date: '2027-01-01', name: "New Year's Day", nameZh: '元旦', close: null },
    { date: '2027-01-18', name: 'Martin Luther King, Jr. Day', nameZh: '马丁·路德·金纪念日', close: null },
    { date: '2027-02-15', name: "Washington's Birthday", nameZh: '总统日', close: null },
    { date: '2027-03-26', name: 'Good Friday', nameZh: '耶稣受难日', close: null },
    { date: '2027-05-31', name: 'Memorial Day', nameZh: '阵亡将士纪念日', close: null },
    { date: '2027-06-18', name: 'Juneteenth National Independence Day (observed)', nameZh: '六月节', close: null },
    { date: '2027-07-05', name: 'Independence Day (observed)', nameZh: '独立日', close: null },
    { date: '2027-09-06', name: 'Labor Day', nameZh: '劳动节', close: null },
    { date: '2027-11-25', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
    { date: '2027-11-26', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
    { date: '2027-12-24', name: 'Christmas Day (observed)', nameZh: '圣诞节', close: null },
    // 2028 — no New Year's Day closure: 1 January 2028 is a Saturday.
    { date: '2028-01-17', name: 'Martin Luther King, Jr. Day', nameZh: '马丁·路德·金纪念日', close: null },
    { date: '2028-02-21', name: "Washington's Birthday", nameZh: '总统日', close: null },
    { date: '2028-04-14', name: 'Good Friday', nameZh: '耶稣受难日', close: null },
    { date: '2028-05-29', name: 'Memorial Day', nameZh: '阵亡将士纪念日', close: null },
    { date: '2028-06-19', name: 'Juneteenth National Independence Day', nameZh: '六月节', close: null },
    { date: '2028-07-03', name: 'Independence Day eve', nameZh: '独立日前夜', close: '13:00' },
    { date: '2028-07-04', name: 'Independence Day', nameZh: '独立日', close: null },
    { date: '2028-09-04', name: 'Labor Day', nameZh: '劳动节', close: null },
    { date: '2028-11-23', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
    { date: '2028-11-24', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
    { date: '2028-12-25', name: 'Christmas Day', nameZh: '圣诞节', close: null },
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
);

/** Midnight UTC for an ISO day, so a date difference never drifts with a clock. */function dayNumber(iso) {
  const text = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : null;
}

/**
 * Structural self-check used by the suite: every row sorted, unique, dated and
 * named, with a well-formed early-close time where one exists.
 * @returns {boolean}
 */
export function closuresAreSane() {
  if (!NYSE_CLOSURES.length) return false;
  let prev = '';
  for (const row of NYSE_CLOSURES) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || row.date <= prev) return false;
    if (typeof row.name !== 'string' || !row.name.trim()) return false;
    if (typeof row.nameZh !== 'string' || !row.nameZh.trim()) return false;
    if (row.close !== null && !/^\d{2}:\d{2}$/.test(row.close)) return false;
    prev = row.date;
  }
  return true;
}

/**
 * The closure row for one New York calendar day, or null on a normal day.
 * @param {string} iso 'YYYY-MM-DD'
 * @returns {ClosureRow|null}
 */
export function closureOn(iso) {
  const day = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return NYSE_CLOSURES.find((row) => row.date === day) || null;
}

/**
 * Closures inside `[from, from + days]`, nearest first, each carrying `days`.
 * A past `from` is allowed: `days` is counted forward from it, and negative
 * offsets are dropped, so the same helper serves both "what is coming" and
 * "what did this session have to absorb".
 *
 * @param {string} fromIso 'YYYY-MM-DD'
 * @param {number} [days] window length, clamped to 0..800
 * @returns {Array<ClosureRow & {days: number}>}
 */
export function closuresBetween(fromIso, days = 30) {
  const start = dayNumber(fromIso);
  if (start === null) return [];
  const span = Number.isFinite(Number(days)) ? Math.min(800, Math.max(0, Math.floor(Number(days)))) : 30;
  const out = [];
  for (const row of NYSE_CLOSURES) {
    const at = dayNumber(row.date);
    if (at === null) continue;
    const offset = at - start;
    if (offset < 0 || offset > span) continue;
    out.push({ ...row, days: offset });
  }
  return out;
}

/**
 * The first closure on or after `fromIso`, or null when the table does not
 * reach that far (the chip then falls back to plain weekday hours).
 * @param {string} fromIso
 * @param {number} [days]
 * @returns {(ClosureRow & {days: number})|null}
 */
export function nextClosure(fromIso, days = 400) {
  const list = closuresBetween(fromIso, days);
  return list.length ? list[0] : null;
}

/**
 * The monthly options expiry: standard US equity options settle on the third
 * Friday, and the CBOE moves that date to the Thursday when the Friday is an
 * exchange holiday. It is a volatility date rather than a session change, but it
 * belongs on the same calendar — the panel already knows every closure, so the
 * expiry costs no upstream request.
 */
export const OPTION_EXPIRY_RULE = 'third Friday of the month, moved to the Thursday before when that Friday is a market holiday';

/**
 * The expiry day for one month, shifted back when the exchange is shut.
 * @param {number} year full year
 * @param {number} month 1..12
 * @returns {{date: string, quarterly: boolean, shifted: boolean, name: string, nameZh: string, kind: string}}
 */
export function optionExpiryIn(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const weekday = first.getUTCDay();
  const firstFriday = 1 + ((5 - weekday + 7) % 7);
  let day = new Date(Date.UTC(year, month - 1, firstFriday + 14));
  let shifted = false;
  for (let guard = 0; guard < 3 && closureOn(day.toISOString().slice(0, 10)); guard += 1) {
    day = new Date(day.getTime() - 86_400_000);
    shifted = true;
  }
  return {
    date: day.toISOString().slice(0, 10),
    quarterly: month % 3 === 0,
    shifted,
    name: 'Monthly options expiry',
    nameZh: '期权到期日',
    kind: 'opex',
  };
}

/**
 * Expiry days inside `[from, from + days]`, nearest first, each carrying `days`.
 * @param {string} fromIso 'YYYY-MM-DD'
 * @param {number} [days] window length, clamped to 0..400
 * @returns {Array<ReturnType<typeof optionExpiryIn> & {days: number}>}
 */
export function optionExpiryBetween(fromIso, days = 45) {
  const start = dayNumber(fromIso);
  if (start === null) return [];
  const span = Number.isFinite(Number(days)) ? Math.min(400, Math.max(0, Math.floor(Number(days)))) : 45;
  const end = start + span;
  const from = new Date(start * 86_400_000);
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const out = [];
  while (cursor.getTime() / 86_400_000 <= end) {
    const row = optionExpiryIn(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1);
    const at = dayNumber(row.date);
    if (at !== null && at >= start && at <= end) out.push({ ...row, days: at - start });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
