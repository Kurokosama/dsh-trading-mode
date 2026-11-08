/**
 * Macro release calendar (0.5.0).
 *
 * The table is hand-verified against the official BLS/FRB/BEA calendar pages
 * (see lib/trading/macro.js), so the checks that matter are structural: rows
 * stay sorted and well-formed, the verified anchor rows that motivated the
 * feature are present, and the window filter clamps the way the API contract
 * promises. Pure in-process checks — no clock waiting, no network.
 *
 *   node tests/offline/macro.test.mjs
 */
import assert from 'node:assert/strict';

import { MACRO_EVENTS, MACRO_VERIFIED_ON, macroTableIsSane, todayIso, upcomingMacro } from '../../lib/trading/macro.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('macro: curated release calendar and window filter');

await suite.check('the curated table is well-formed and sorted', () => {
  assert.equal(macroTableIsSane(), true);
  for (let i = 1; i < MACRO_EVENTS.length; i += 1) {
    const prev = MACRO_EVENTS[i - 1];
    const curr = MACRO_EVENTS[i];
    const order = curr.date > prev.date || (curr.date === prev.date && curr.time >= prev.time);
    assert.equal(order, true, `${prev.date} ${prev.time} must precede ${curr.date} ${curr.time}`);
  }
});

await suite.check('the anchor rows verified on 2026-11-06 are present', () => {
  assert.equal(MACRO_VERIFIED_ON, '2026-11-08');
  const key = (rows) => rows.map((row) => `${row.date} ${row.time} ${row.kind}`).join(';');
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2026-11-10')),
    '2026-11-10 08:30 cpi',
    'November CPI is the print the user asked about',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2026-12-09')),
    '2026-12-09 14:00 fomc',
    'the December FOMC decision lands on day two at 14:00 ET',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2026-12-25')),
    '',
    'Christmas Day has no release rows',
  );
});

await suite.check('the rows verified on 2026-11-08 carry the published times', () => {
  const key = (rows) => rows.map((row) => `${row.date} ${row.time} ${row.kind}`).join(';');
  // The Fed's own press release names the statement day, not just the meeting:
  // "a policy statement at 2 p.m. Eastern Time on the second day" of each
  // 2027 meeting (federalreserve.gov/newsevents/pressreleases/monetary20250905a.htm).
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.kind === 'fomc')),
    '2026-12-09 14:00 fomc;2027-01-26 14:00 fomc;2027-03-17 14:00 fomc;2027-04-28 14:00 fomc',
    'every FOMC row is the second day of its meeting at 14:00 ET',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => ['2027-01-26', '2027-03-17', '2027-04-28'].includes(row.date))),
    '2027-01-26 14:00 fomc;2027-03-17 14:00 fomc;2027-04-28 14:00 fomc',
    'no other release is claimed for a meeting day',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2027-01-28')),
    '2027-01-28 08:30 gdp;2027-01-28 08:30 pce',
    'BEA publishes the Q4 advance GDP and December PCE on the same morning',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2027-02-11' || row.date === '2027-02-12')),
    '2027-02-11 08:30 cpi;2027-02-12 08:30 ppi',
    'BLS keeps CPI and PPI on consecutive mornings, as published',
  );
});

await suite.check('the table answers the window it is read with', () => {
  // The board asks `/macro?days=30` and clamps at 90 days, so the useful claim
  // is not "some rows exist in 2027" but: from any date the panel can be opened
  // on inside the covered year, a 30-day window answers something. A curated
  // table that runs out quietly reads as "no macro risk this month".
  const lastRow = MACRO_EVENTS[MACRO_EVENTS.length - 1];
  assert.ok(
    lastRow.date >= todayIso(),
    `the table must not end in the past (last row ${lastRow.date})`,
  );
  const gaps = MACRO_EVENTS.reduce((worst, row, i) => {
    if (i === 0) return worst;
    const days = Math.round((Date.parse(row.date) - Date.parse(MACRO_EVENTS[i - 1].date)) / 86400000);
    return days > worst.days ? { days, from: MACRO_EVENTS[i - 1].date, to: row.date } : worst;
  }, { days: 0, from: '', to: '' });
  assert.ok(
    gaps.days <= 30,
    `a ${gaps.days}-day gap between ${gaps.from} and ${gaps.to} would leave the board blind`,
  );
});

await suite.check('upcomingMacro filters by window and sorts by date', () => {
  const soon = upcomingMacro('2026-11-06', 30);
  assert.deepEqual(
    soon.map((row) => `${row.date}/${row.kind}`),
    ['2026-11-10/cpi', '2026-11-13/ppi', '2026-11-25/gdp', '2026-11-25/pce', '2026-12-04/jobs'],
  );
  assert.deepEqual(
    soon.map((row) => row.days),
    [4, 7, 19, 19, 28],
  );
  assert.deepEqual(
    upcomingMacro('2026-11-06', 1).map((row) => row.kind),
    [],
    'a two-day window has no releases yet',
  );
  assert.deepEqual(
    upcomingMacro('2026-12-10', 0).map((row) => row.kind),
    ['cpi'],
    'day zero includes the release landing today',
  );
  const wide = upcomingMacro('2026-11-13', 90);
  assert.deepEqual(
    wide.map((row) => `${row.date}/${row.kind}`),
    [
      '2026-11-13/ppi', '2026-11-25/gdp', '2026-11-25/pce', '2026-12-04/jobs', '2026-12-09/fomc',
      '2026-12-10/cpi', '2026-12-15/ppi', '2026-12-23/gdp', '2026-12-23/pce', '2027-01-08/jobs',
      '2027-01-13/cpi', '2027-01-14/ppi', '2027-01-26/fomc', '2027-01-28/gdp', '2027-01-28/pce',
      '2027-02-05/jobs', '2027-02-11/cpi',
    ],
    'the widest window runs from a PPI day straight through January 2027',
  );
  assert.deepEqual(
    wide.map((row) => row.days),
    [0, 12, 12, 21, 26, 27, 32, 40, 40, 56, 61, 62, 74, 76, 76, 84, 90],
    'the day offsets are calendar days from the window start',
  );
});

await suite.check('upcomingMacro degrades gracefully on bad input', () => {
  const today = todayIso();
  const expectedToday = MACRO_EVENTS.filter((row) => row.date === today).length;
  assert.equal(upcomingMacro('not-a-date', 0).length, expectedToday, "an unparsable from means today's zero-day window");
  assert.deepEqual(upcomingMacro('2026-11-10', -5).map((row) => row.kind), ['cpi'], 'a negative window collapses to zero days');
  const wide = upcomingMacro('2026-11-10', 1e9);
  assert.equal(wide.length, upcomingMacro('2026-11-10', 90).length, 'an absurd window clamps to the 90-day cap');
});

process.exit(exitCodeFor(suite.finish()));
