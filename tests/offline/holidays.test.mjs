/**
 * NYSE closures and early closes (1.1.0).
 *
 * The table is hand-verified against the official page (see lib/trading/
 * holidays.js), so the checks that matter are structural — rows stay sorted
 * and well-formed, the anchor rows that motivated the feature are present —
 * plus the behavioural ones: a full-day closure must beat the wall clock, and
 * an early close must shorten the regular session without closing the market.
 * Pure in-process checks, no clock waiting, no network.
 *
 *   node tests/offline/holidays.test.mjs
 */
import assert from 'node:assert/strict';

import {
  CLOSURES_SOURCE,
  CLOSURES_VERIFIED_ON,
  EARLY_CLOSE_TIME,
  NYSE_CLOSURES,
  closureOn,
  closuresAreSane,
  closuresBetween,
  nextClosure,
} from '../../lib/trading/holidays.js';
import { marketStatus } from '../../lib/trading/sessions.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('holidays: NYSE closures, early closes and the session clock');

/** Noon UTC on a day is noon *before* the New York open in winter (UTC-5). */
const utc = (text) => new Date(text);

await suite.check('the curated table is well-formed and sorted', () => {
  assert.equal(closuresAreSane(), true);
  assert.equal(CLOSURES_VERIFIED_ON, '2026-11-06');
  assert.match(CLOSURES_SOURCE, /nyse\.com/);
  assert.equal(EARLY_CLOSE_TIME, '13:00');
  // Every row must be a weekday: a closure dated on a Saturday would silently
  // never fire, because the weekend check answers first.
  for (const row of NYSE_CLOSURES) {
    const weekday = utc(`${row.date}T16:00:00Z`).getUTCDay();
    assert.ok(weekday >= 1 && weekday <= 5, `${row.date} (${row.name}) must fall on a weekday`);
  }
});

await suite.check('the anchor rows read from the official page are present', () => {
  const keys = NYSE_CLOSURES.map((row) => `${row.date} ${row.close || 'closed'}`).join(';');
  assert.ok(keys.includes('2026-11-26 closed'), 'Thanksgiving 2026 closes the market');
  assert.ok(keys.includes('2026-11-27 13:00'), 'the day after Thanksgiving is a 13:00 ET early close');
  assert.ok(keys.includes('2026-12-24 13:00'), 'Christmas Eve 2026 is a 13:00 ET early close');
  assert.ok(keys.includes('2027-07-05 closed'), 'Independence Day observed moves to Monday 5 July 2027');
  assert.ok(!keys.includes('2028-01-01'), '2028 has no New Year closure: 1 January is a Saturday');
});

await suite.check('lookups answer per day, and the window filter counts forward only', () => {
  assert.equal(closureOn('2026-11-26').nameZh, '感恩节');
  assert.equal(closureOn('2026-11-25'), null, 'the Wednesday before Thanksgiving is a normal session');
  assert.equal(closureOn('not-a-date'), null);

  const rows = closuresBetween('2026-11-01', 60);
  assert.deepEqual(
    rows.map((row) => `${row.date}:${row.days}:${row.close || 'closed'}`),
    ['2026-11-26:25:closed', '2026-11-27:26:13:00', '2026-12-24:53:13:00', '2026-12-25:54:closed'],
    'the window carries the day offset the API prints',
  );
  assert.deepEqual(closuresBetween('2026-11-01', -5), [], 'a negative window yields nothing');
  assert.equal(closuresBetween('2026-11-27', 0).length, 1, 'a zero-day window still covers the day itself');
  assert.equal(nextClosure('2026-11-01').date, '2026-11-26');
  assert.equal(nextClosure('2029-01-01'), null, 'past the last verified row the table answers nothing');
});

await suite.check('a full-day closure beats the wall clock', () => {
  // 15:00Z is 10:00 EST — mid-morning of a regular session on any other day.
  const thanksgiving = marketStatus('US', utc('2026-11-26T15:00:00Z'));
  assert.equal(thanksgiving.open, false);
  assert.equal(thanksgiving.session, 'closed');
  assert.equal(thanksgiving.reason, 'holiday');
  assert.equal(thanksgiving.closure.nameZh, '感恩节');
  // The day before is untouched: the same hour is a live session.
  const wednesday = marketStatus('US', utc('2026-11-25T15:00:00Z'));
  assert.equal(wednesday.open, true);
  assert.equal(wednesday.session, 'regular');
  // Other markets never consult the NYSE table.
  assert.equal(marketStatus('HK', utc('2026-11-26T15:00:00Z')).reason !== 'holiday', true);
});

await suite.check('an early close shortens the session instead of closing the day', () => {
  const morning = marketStatus('US', utc('2026-11-27T15:00:00Z')); // 10:00 EST
  assert.equal(morning.open, true, 'the morning of a 13:00 close still trades');
  assert.equal(morning.session, 'regular');
  const afternoon = marketStatus('US', utc('2026-11-27T18:30:00Z')); // 13:30 EST
  assert.equal(afternoon.open, false);
  assert.equal(afternoon.session, 'post');
  assert.equal(afternoon.reason, 'after-hours (early close)');
  assert.equal(afternoon.closure.close, '13:00');
  // A normal Friday at the same clock is still a regular session.
  const normal = marketStatus('US', utc('2026-11-20T18:30:00Z'));
  assert.equal(normal.open, true);
  assert.equal(normal.session, 'regular');
  // Before the open the early close changes nothing.
  assert.equal(marketStatus('US', utc('2026-11-27T12:00:00Z')).session, 'pre');
});

process.exit(exitCodeFor(suite.finish()));
