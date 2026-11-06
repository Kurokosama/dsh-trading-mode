/**
 * Nasdaq earnings calendar (US-only, keyless).
 *
 * The endpoint itself is one JSON blob per date; the risky parts are the date
 * arithmetic (weekends, exchange timezone, month boundaries) and the payload
 * normalisation (`$88,237,580,000`, `($0.12)`, `time-pre-market`). Both are
 * tested against hand-built shapes, so the suite never touches the network.
 *
 *   node tests/offline/calendar.test.mjs
 */
import assert from 'node:assert/strict';

import {
  EarningsCalendar,
  addDays,
  dateInNewYork,
  daysUntil,
  parseEarningsDay,
  parseMoney,
  tradingDates,
} from '../../lib/trading/calendar.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('calendar: earnings dates and payload');

await suite.check('money strings lose their currency noise and keep their sign', () => {
  assert.equal(parseMoney('$88,237,580,000'), 88_237_580_000);
  assert.equal(parseMoney('$1.41'), 1.41);
  assert.equal(parseMoney('($0.12)'), -0.12);
  assert.equal(parseMoney('-$0.12'), -0.12);
  assert.equal(parseMoney('0'), 0);
  assert.equal(parseMoney('N/A'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(null), null);
});

await suite.check('a report time maps to the session that reprices the tape', () => {
  const payload = {
    data: {
      asOf: 'Mon, Nov 9, 2026',
      rows: [
        { symbol: 'kkr', name: 'KKR & Co. Inc.', time: 'time-pre-market', marketCap: '$88,237,580,000', fiscalQuarterEnding: 'Sep/2026', epsForecast: '$1.41', noOfEsts: '7', lastYearEPS: '$1.22', lastYearRptDt: '11/07/2025' },
        { symbol: 'XYZ', name: 'Xyz Corp', time: 'time-after-hours', marketCap: '$1,000', epsForecast: '-$0.10', noOfEsts: '0' },
        { symbol: '   ', name: 'blank symbol is dropped' },
      ],
    },
  };
  const parsed = parseEarningsDay(payload);
  assert.equal(parsed.asOf, 'Mon, Nov 9, 2026');
  assert.equal(parsed.events.length, 2);
  const [first, second] = parsed.events;
  assert.equal(first.symbol, 'KKR');
  assert.equal(first.session, 'pre');
  assert.equal(first.marketCap, 88_237_580_000);
  assert.equal(first.epsForecast, 1.41);
  assert.equal(first.analysts, 7);
  assert.equal(first.lastYearEPS, 1.22);
  assert.equal(second.session, 'post');
  assert.equal(second.epsForecast, -0.1);
  assert.equal(second.analysts, null, 'zero estimates is not a count');
  assert.equal(second.fiscalQuarterEnding, null);
});

await suite.check('a day with no reports is an empty list, not an error', () => {
  assert.deepEqual(parseEarningsDay({ data: { asOf: 'Sat, Nov 7, 2026', rows: null } }).events, []);
  assert.deepEqual(parseEarningsDay({}).events, []);
  assert.deepEqual(parseEarningsDay(null).events, []);
});

await suite.check('weekends never appear in a window', () => {
  // 2026-11-06 is a Friday; the next five weekdays skip 11-07/11-08.
  assert.deepEqual(tradingDates('2026-11-06', 5), ['2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']);
  // Starting on a Saturday rolls to the Monday.
  assert.deepEqual(tradingDates('2026-11-07', 2), ['2026-11-09', '2026-11-10']);
});

await suite.check('date arithmetic survives month, year and DST boundaries', () => {
  assert.equal(addDays('2026-11-30', 1), '2026-12-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-07', 2), '2026-03-09', 'US DST starts 2026-03-08');
  assert.equal(daysUntil('2026-11-09', '2026-11-06'), 3);
  assert.equal(daysUntil('2026-11-06', '2026-11-09'), -3);
  assert.equal(daysUntil('not-a-date', '2026-11-06'), null);
});

await suite.check('"today" is the exchange date, not the machine date', () => {
  // 2026-11-07T03:00Z is still 2026-11-06 in New York (23:00 EDT).
  assert.equal(dateInNewYork(Date.parse('2026-11-07T03:00:00Z')), '2026-11-06');
  assert.equal(dateInNewYork(Date.parse('2026-11-07T05:30:00Z')), '2026-11-07');
});

await suite.check('a window keeps the earliest report per symbol and sorts by date', async () => {
  const cal = new EarningsCalendar();
  const table = {
    '2026-11-09': [
      { symbol: 'AAA', name: 'A', session: 'pre', marketCap: 500, epsForecast: 1, analysts: 3, fiscalQuarterEnding: 'Sep/2026', lastYearEPS: 0.9, lastYearReport: null },
      { symbol: 'BBB', name: 'B', session: 'post', marketCap: 900, epsForecast: 2, analysts: 4, fiscalQuarterEnding: 'Sep/2026', lastYearEPS: 1.8, lastYearReport: null },
    ],
    '2026-11-10': [{ symbol: 'AAA', name: 'A', session: 'post', marketCap: 500, epsForecast: 1.1, analysts: 3, fiscalQuarterEnding: 'Dec/2026', lastYearEPS: 1, lastYearReport: null }],
  };
  cal.day = async (date) => ({ date, asOf: date, events: table[date] || [], source: 'stub', timestamp: 0 });
  const window = await cal.window({ from: '2026-11-09', days: 2 });
  assert.equal(window.events.length, 3);
  assert.equal(window.bySymbol.AAA.date, '2026-11-09', 'the earlier report wins');
  assert.equal(window.bySymbol.BBB.session, 'post');
  assert.equal(window.dates.length, 2);
  assert.deepEqual(window.failed, []);
});

await suite.check('one dead date does not sink the whole window', async () => {
  const cal = new EarningsCalendar();
  cal.day = async (date) => {
    if (date === '2026-11-10') throw new Error('nasdaq timed out');
    return { date, asOf: date, events: [{ symbol: 'CCC', name: 'C', session: 'pre', marketCap: 1, epsForecast: null, analysts: null, fiscalQuarterEnding: null, lastYearEPS: null, lastYearReport: null }], source: 'stub', timestamp: 0 };
  };
  const window = await cal.window({ from: '2026-11-09', days: 2 });
  assert.equal(window.events.length, 1);
  assert.equal(window.failed.length, 1);
  assert.match(window.failed[0].error, /timed out/);
});

exitCodeFor(suite);
