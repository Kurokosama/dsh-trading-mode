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
