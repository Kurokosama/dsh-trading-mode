/**
 * SEC EDGAR fundamentals (US-only, keyless).
 *
 * The parsing rules are the risky part — XBRL stores quarterly, year-to-date and
 * annual figures under one tag, and filers rename tags over the years — so they
 * are tested against a hand-built `companyfacts` shape rather than the network.
 *
 *   node tests/offline/sec.test.mjs
 */
import assert from 'node:assert/strict';

import { pickMetrics } from '../../lib/trading/sec.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('sec: EDGAR fundamentals selection');

/** Build one XBRL row. */
function row(val, end, { start, form = '10-Q', fy = 2026, fp = 'Q2', filed = end } = {}) {
  return { val, end, ...(start ? { start } : {}), form, fy, fp, filed, accn: 'x' };
}

function facts(gaap, extra = {}) {
  return { cik: 1, entityName: 'Example Corp', facts: { 'us-gaap': gaap, ...extra } };
}

await suite.check('a fresh annual figure beats a stale annual one', () => {
  const payload = facts({
    Revenues: {
      units: { USD: [row(100, '2021-12-31', { start: '2021-01-01', form: '10-K', fy: 2021 }), row(200, '2022-12-31', { start: '2022-01-01', form: '10-K', fy: 2022 })] },
    },
  });
  const picked = pickMetrics(payload);
  const revenue = picked.metrics.find((m) => m.key === 'revenue');
  assert.equal(revenue.value, 200, 'latest annual wins');
  assert.equal(revenue.annual, true);
  assert.equal(revenue.period.end, '2022-12-31');
  return 'revenue=200 FY2022';
});

await suite.check('the newest tag wins over the first tag that has data', () => {
  // Mirrors NVDA: `Revenues` stopped being filed in 2022 while the modern tag
  // keeps reporting. Taking the first populated tag showed a four-year-old number.
  const payload = facts({
    Revenues: { units: { USD: [row(26_914_000_000, '2022-01-30', { start: '2021-01-31', form: '10-K' })] } },
    RevenueFromContractWithCustomerExcludingAssessedTax: {
      units: { USD: [row(215_938_000_000, '2026-01-25', { start: '2025-01-26', form: '10-K' })] },
    },
  });
  const revenue = pickMetrics(payload).metrics.find((m) => m.key === 'revenue');
  assert.equal(revenue.value, 215_938_000_000);
  assert.equal(revenue.concept, 'RevenueFromContractWithCustomerExcludingAssessedTax');
  return 'modern tag wins';
});

await suite.check('year-to-date rows are not reported as a quarter', () => {
  // The same tag carries a 3-month row and a 6-month row ending on the same day.
  const payload = facts({
    NetIncomeLoss: {
      units: {
        USD: [
          row(10, '2026-06-30', { start: '2026-04-01' }),
          row(25, '2026-06-30', { start: '2026-01-01' }),
        ],
      },
    },
  });
  const netIncome = pickMetrics(payload).metrics.find((m) => m.key === 'netIncome');
  assert.equal(netIncome.value, 10, 'the 90-day figure is the quarter');
  assert.equal(netIncome.annual, false);
  return 'quarter=10 (not the 25 YTD)';
});

await suite.check('year-over-year growth compares like with like', () => {
  const payload = facts({
    NetIncomeLoss: {
      units: {
        USD: [
          row(100, '2025-06-30', { start: '2025-04-01' }),
          row(150, '2026-06-30', { start: '2026-04-01' }),
          row(400, '2026-06-30', { start: '2026-01-01' }),
        ],
      },
    },
  });
  const netIncome = pickMetrics(payload).metrics.find((m) => m.key === 'netIncome');
  assert.equal(netIncome.value, 150);
  assert.equal(Math.round(netIncome.yoy * 1000) / 10, 50, '150 vs 100 is +50%');
  return 'yoy=+50%';
});

await suite.check('balance-sheet instants take the newest date and report no growth', () => {
  const payload = facts({
    Assets: {
      units: {
        USD: [
          row(900, '2025-12-31'),
          row(1000, '2026-06-30'),
        ],
      },
    },
  });
  const assets = pickMetrics(payload).metrics.find((m) => m.key === 'assets');
  assert.equal(assets.value, 1000);
  assert.equal(assets.yoy, null, 'instants have no year-ago comparison');
  return 'assets=1000 as of 2026-06-30';
});

await suite.check('a filer with no XBRL facts yields an empty, non-throwing answer', () => {
  const picked = pickMetrics({ facts: {} });
  assert.deepEqual(picked.metrics, []);
  assert.equal(picked.entityName, null);
  assert.deepEqual(pickMetrics(null).metrics, []);
  return 'empty payload → empty metrics';
});

await suite.check('the snapshot period follows the newest filing', () => {
  const payload = facts({
    NetIncomeLoss: { units: { USD: [row(10, '2026-06-30', { start: '2026-04-01', form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-01' })] } },
    Assets: { units: { USD: [row(500, '2026-06-30', { form: '10-Q', fy: 2026, fp: 'Q2', filed: '2026-08-01' })] } },
  });
  const picked = pickMetrics(payload);
  assert.equal(picked.fiscalYear, 2026);
  assert.equal(picked.fiscalPeriod, 'Q2');
  assert.equal(picked.form, '10-Q');
  assert.equal(picked.filed, '2026-08-01');
  return 'FY2026 Q2 10-Q filed 2026-08-01';
});

process.exit(exitCodeFor(suite.finish()));
