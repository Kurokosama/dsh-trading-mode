/**
 * The index directory is a curated table, so it gets its own guard: adding a
 * record must not silently change what the strip promises, and a level that is
 * not a price has to say so.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_INDEX_SYMBOLS,
  INDEX_DIRECTORY,
  lookupIndex,
  publicIndex,
  searchIndices,
} from '../../lib/trading/indices.js'

import { createSuite, exitCodeFor } from './harness.mjs'

const suite = createSuite('indices: the US benchmark strip, now including rates and the dollar');

await suite.check('indices: the strip lists the seven benchmarks plus rates and the dollar', async () => {
  assert.equal(DEFAULT_INDEX_SYMBOLS.length, 9, `9 entries (got ${DEFAULT_INDEX_SYMBOLS.length})`)
  assert.deepEqual(
    DEFAULT_INDEX_SYMBOLS,
    ['^IXIC', '^NDX', '^GSPC', '^DJI', '^SOX', '^RUT', '^VIX', '^TNX', 'DX-Y.NYB'],
    'order is by the `order` column',
  )
  assert.ok(
    INDEX_DIRECTORY.every((entry) => entry.market === 'US' && entry.group === 'US'),
    'this fork ships US records only',
  )
  return '9 entries in order'
})

await suite.check('indices: rates and the dollar resolve from Chinese and English spellings', async () => {
  const cases = [
    ['美债10年', '^TNX'],
    ['十年期美债', '^TNX'],
    ['US10Y', '^TNX'],
    ['dxy', 'DX-Y.NYB'],
    ['美元指数', 'DX-Y.NYB'],
    ['^TNX', '^TNX'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(lookupIndex(input).symbol, expected, `${input} → ${expected}`)
  }
  assert.equal(lookupIndex('DXYX'), null, 'a near miss must not resolve')
  return 'aliases ok'
})

await suite.check('indices: a yield announces its unit, a level does not', async () => {
  assert.equal(publicIndex(lookupIndex('^TNX')).unit, '%', '^TNX prints a yield in percent')
  assert.equal(publicIndex(lookupIndex('^GSPC')).unit, undefined, 'an index level has no unit')
  assert.equal(publicIndex(lookupIndex('DX-Y.NYB')).unit, undefined, 'the dollar index is a level')
  // The unit must survive the wire shape, because the tile reads it from there.
  const wire = JSON.parse(JSON.stringify(publicIndex(lookupIndex('美债10年'))))
  assert.equal(wire.unit, '%', 'the unit survives serialisation')
  return 'unit threading ok'
})

await suite.check('indices: the search box surfaces them like any other benchmark', async () => {
  assert.equal(searchIndices('美债', undefined, 4)[0].symbol, '^TNX', '美债 → ^TNX')
  assert.equal(searchIndices('美元指数', undefined, 4)[0].symbol, 'DX-Y.NYB', '美元指数 → DX-Y.NYB')
  assert.equal(searchIndices('纳指', undefined, 4)[0].symbol, '^IXIC', 'the old aliases still win')
  return 'search ok'
})

process.exit(exitCodeFor(suite.finish()))
