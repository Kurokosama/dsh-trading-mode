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
  assert.equal(MACRO_VERIFIED_ON, '2026-11-06');
  const key = (rows) => rows.map((row) => `${row.date} ${row.time} ${row.kind}`).join(';');
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2026-11-10')),
    '2026-11-10 08:30 cpi',
    'November CPI is the print the user asked about',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.kind === 'fomc')),
    '2026-12-09 14:00 fomc',
    'the December FOMC decision lands on day two at 14:00 ET',
  );
  assert.equal(
    key(MACRO_EVENTS.filter((row) => row.date === '2026-12-25')),
    '',
    'Christmas Day has no release rows',
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
  assert.deepEqual(
    upcomingMacro('2026-11-13', 90).map((row) => row.kind),
    ['ppi', 'gdp', 'pce', 'jobs', 'fomc', 'cpi', 'ppi', 'gdp', 'pce', 'jobs', 'cpi', 'ppi'],
    'the widest window reaches into January 2027 (the launch date itself is a PPI day)',
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
