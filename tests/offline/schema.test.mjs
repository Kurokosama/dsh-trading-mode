import assert from 'node:assert/strict'
import test from 'node:test'
import { makeProfile } from '../../lib/trading/schema.js'

test('schema: profile normalization keeps the dividend and fund facts usable', () => {
  // Yahoo quoteSummary/v10 reports summaryDetail.dividendYield as a fraction
  // (0.0044 for a 0.44% yielder); makeProfile is the single place that decides
  // the stored unit, so the client can format without re-guessing.
  const f = makeProfile({
    symbol: 'VOO',
    market: 'US',
    name: 'Vanguard S&P 500 ETF',
    dividendYield: 0.0126,
    dividendRate: 6.14,
    expenseRatio: 0.03,
    fundFamily: 'Vanguard',
  })
  assert.equal(f.dividendYield, 1.26)
  assert.equal(f.dividendRate, 6.14)
  assert.equal(f.expenseRatio, 0.03)
  assert.equal(f.fundFamily, 'Vanguard')
})

test('schema: percent-style yields pass through untouched', () => {
  // Some mirrors already send percent. Anything at or above 1 cannot be a
  // fraction (no security yields 100%), so it is stored as-is.
  const p = makeProfile({ symbol: 'SCHD', market: 'US', name: 'SCHD', dividendYield: 3.52 })
  assert.equal(p.dividendYield, 3.52)
})

test('schema: absent or nonsensical dividend facts collapse to null', () => {
  const bare = makeProfile({ symbol: 'BRK-B', market: 'US', name: 'Berkshire' })
  assert.equal(bare.dividendYield, null)
  assert.equal(bare.dividendRate, null)
  assert.equal(bare.expenseRatio, null)
  assert.equal(bare.fundFamily, undefined)

  const junk = makeProfile({ symbol: 'X', market: 'US', name: 'X', dividendYield: -0.2, dividendRate: Number.NaN, expenseRatio: '0.1' })
  assert.equal(junk.dividendYield, null)
  assert.equal(junk.dividendRate, null)
  assert.equal(junk.expenseRatio, null)
})

test('schema: fundFamily is clamped like the other text fields', () => {
  const long = 'x'.repeat(400)
  const p = makeProfile({ symbol: 'SPY', market: 'US', name: 'SPY', fundFamily: long })
  assert.equal(p.fundFamily.length, 120)
  const dirty = makeProfile({ symbol: 'QQQ', market: 'US', name: 'QQQ', fundFamily: '  Invesco   QQQ  Trust  ' })
  assert.equal(dirty.fundFamily, 'Invesco QQQ Trust')
})

test('schema: the top-ten holdings list is trimmed to presentable facts', () => {
  const rows = [
    { symbol: 'nvda', name: 'NVIDIA', weight: 9.1 },
    { name: 'Nameless giant', weight: 7.2 },
    { symbol: 'MSFT', name: 'Microsoft', weight: 8.0 },
    { symbol: 'JUNK', name: 'dropped', weight: 'nope' },
    { name: 'no weight', weight: null },
    null,
    { symbol: 'WEIRD', name: 'negative kept out', weight: -3 },
  ]
    .concat(Array.from({ length: 12 }, (_, index) => ({ symbol: `X${index}`, name: `Filler ${index}`, weight: 0.01 * (index + 1) })))
  const p = makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO', holdings: rows })
  assert.ok(Array.isArray(p.holdings) && p.holdings.length === 10, `expected 10 rows, got ${p.holdings && p.holdings.length}`)
  // The honest top-of-book rows must not be crowded out by the filler.
  assert.deepEqual(p.holdings.slice(0, 3).map((item) => item.symbol), ['NVDA', 'MSFT', undefined])
  // A missing ticker keeps the name but never fabricates an investable row.
  const nameless = p.holdings.find((item) => typeof item.symbol !== 'string')
  assert.ok(nameless, 'the name-only row must survive filtering')
  assert.equal(nameless.name, 'Nameless giant')
  assert.equal(nameless.symbol, undefined)
  // Junk weights disappear rather than render as filler rows.
  assert.ok(!p.holdings.some((item) => item.symbol === 'JUNK' || item.symbol === 'WEIRD'))
  assert.ok(p.holdings.every((item) => item.weight == null || (item.weight > 0 && item.weight <= 100)))
  // A "weight" above 100 is impossible for a share of the fund: it is either a
  // double-scaled figure or junk, so the row drops instead of showing 839%.
  const absurd = makeProfile({
    symbol: 'VOO',
    market: 'US',
    name: 'VOO',
    holdings: [
      { name: 'Oversized', weight: 839 },
      { name: 'Zero', weight: 0 },
      { name: 'Fine', weight: 4.5 },
    ],
  })
  assert.deepEqual(absurd.holdings.map((item) => item.name), ['Fine'])
})

test('schema: no holdings input keeps the field empty rather than fabricating rows', () => {
  const p = makeProfile({ symbol: 'AAPL', market: 'US', name: 'Apple' })
  assert.equal(p.holdings, undefined)
})

