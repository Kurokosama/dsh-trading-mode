import assert from 'node:assert/strict'
import test from 'node:test'
import { makeExtended, makeNews, makeProfile, makeQuote } from '../../lib/trading/schema.js'

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

test('schema: the sector mix keeps the real slicing, biggest first', () => {
  const p = makeProfile({
    symbol: 'VOO',
    market: 'US',
    name: 'Vanguard S&P 500 ETF',
    sectors: [
      { key: 'healthcare', name: 'Healthcare', weight: 9.26 },
      { key: 'technology', name: 'Technology', weight: 40.48 },
      { key: '', name: '', weight: 3 },
      { key: 'junk', name: 'Junk', weight: 0 },
      { key: 'scaled', name: 'Scaled', weight: 400 },
      null,
      { key: 'energy', name: 'Energy', weight: 3.4 },
    ],
  })
  assert.deepEqual(p.sectors.map((item) => item.key), ['technology', 'healthcare', 'energy'])
  assert.deepEqual(p.sectors.map((item) => item.weight), [40.48, 9.26, 3.4])
  // A zero or >100 share is a broken row, not a real slice of the fund.
  assert.ok(!p.sectors.some((item) => item.name === 'Junk' || item.name === 'Scaled'))
  assert.equal(p.sectors[0].name, 'Technology')
});

test('schema: the ex-dividend day is kept as an epoch or dropped', () => {
  const at = Date.UTC(2026, 10, 12); // 2026-11-12
  const withDate = makeProfile({ symbol: 'AAPL', market: 'US', name: 'Apple', exDividendDate: at });
  assert.equal(withDate.exDividendDate, at);
  // A junk or zero date would render as 1970, so it must not survive.
  assert.equal(makeProfile({ symbol: 'X', market: 'US', name: 'X', exDividendDate: 0 }).exDividendDate, null);
  assert.equal(makeProfile({ symbol: 'X', market: 'US', name: 'X', exDividendDate: 'soon' }).exDividendDate, null);
});

test('schema: no sector input keeps the field empty rather than fabricating rows', () => {
  const p = makeProfile({ symbol: 'AAPL', market: 'US', name: 'Apple' });
  assert.equal(p.sectors, undefined);
});

test('schema: no holdings input keeps the field empty rather than fabricating rows', () => {
  const p = makeProfile({ symbol: 'AAPL', market: 'US', name: 'Apple' })
  assert.equal(p.holdings, undefined)
})


test('schema: the analyst consensus keeps its range and needs coverage', () => {
  const p = makeProfile({
    symbol: 'AAPL',
    market: 'US',
    name: 'Apple',
    analysts: { targetMean: 332.6836, targetHigh: 405, targetLow: 250, rating: 'buy', ratingMean: 2.25, count: 39 },
  })
  assert.deepEqual(p.analysts, { targetMean: 332.6836, targetHigh: 405, targetLow: 250, rating: 'buy', ratingMean: 2.25, count: 39 })

  // A range with the ends crossed, or missing one of them, would put the mean
  // marker outside its own band — drop the pair instead of drawing nonsense.
  const crossed = makeProfile({ symbol: 'X', market: 'US', name: 'X', analysts: { targetMean: 10, targetHigh: 5, targetLow: 8, count: 3 } })
  assert.equal(crossed.analysts.targetHigh, null)
  assert.equal(crossed.analysts.targetLow, null)
  assert.equal(crossed.analysts.targetMean, 10)

  // Funds answer an empty block; a stray rating with nobody behind it is not a
  // consensus and must not render as "0 analysts · Hold".
  assert.equal(makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO', analysts: { rating: 'hold' } }).analysts, undefined)
  assert.equal(makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO', analysts: {} }).analysts, undefined)
  assert.equal(makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO' }).analysts, undefined)
  // A fractional count is rounded rather than printed as 38.5 analysts.
  assert.equal(makeProfile({ symbol: 'X', market: 'US', name: 'X', analysts: { count: 38.6, targetMean: 20 } }).analysts.count, 39)
})

test('schema: growth and margin ratios arrive as fractions and leave as percent', () => {
  const p = makeProfile({
    symbol: 'AAPL',
    market: 'US',
    name: 'Apple',
    stats: { forwardPe: 32.15, priceToBook: 44.39, beta: 1.089, revenueGrowth: 0.117, earningsGrowth: 0.141, grossMargin: 0.48786, netMargin: 0.27604, returnOnEquity: 1.42257, shortFloat: 0.0091 },
  })
  assert.equal(p.stats.revenueGrowth, 11.7)
  assert.equal(p.stats.earningsGrowth, 14.1)
  assert.equal(p.stats.grossMargin, 48.786)
  assert.equal(p.stats.netMargin, 27.604)
  assert.equal(p.stats.returnOnEquity, 142.257)
  assert.equal(p.stats.shortFloat, 0.91)
  assert.equal(p.stats.forwardPe, 32.15)
  assert.equal(p.stats.beta, 1.089)
  // Nothing usable means no card, not a grid of dashes.
  assert.equal(makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO', stats: {} }).stats, undefined)
  assert.equal(makeProfile({ symbol: 'VOO', market: 'US', name: 'VOO' }).stats, undefined)
})

test('schema: an extended-hours print keeps its session and drops when it cannot be trusted', () => {
  // v7 sends both sessions in one row; only the live one is meaningful, so the
  // session travels with the number instead of being inferred downstream.
  assert.deepEqual(
    makeExtended({ session: 'post', price: 342.65, change: 0.27999878, changePct: 0.08178251, at: 1794013183000 }),
    { session: 'post', price: 342.65, change: 0.28, changePct: 0.08, at: 1794013183000 },
  )
  // No session stamp, no price, or a nonsense session: nothing to show.
  assert.equal(makeExtended({ price: 342.65 }), null)
  assert.equal(makeExtended({ session: 'post' }), null)
  assert.equal(makeExtended({ session: 'overnight', price: 342.65 }), null)
  assert.equal(makeExtended({ session: 'pre', price: 0 }), null)
  // A missing change is a price, not an error — the chip just shows the session.
  assert.deepEqual(makeExtended({ session: 'pre', price: 341.2 }), { session: 'pre', price: 341.2, change: null, changePct: null, at: null })

  const quote = makeQuote({ symbol: 'AAPL', market: 'US', price: 342.37, change: -1.8, changePct: -0.52, extended: { session: 'post', price: 342.65, changePct: 0.08178251 } })
  assert.equal(quote.extended.session, 'post')
  assert.equal(quote.extended.changePct, 0.08)
  // A regular-session quote must stay free of the key so the chip never renders.
  assert.equal('extended' in makeQuote({ symbol: 'AAPL', market: 'US', price: 342.37 }), false)
})

test('schema: the news list drops what cannot be shown and keeps order', () => {
  const rows = makeNews([
    { id: 'a', title: '  Apple   ships a thing  ', publisher: 'Wire', link: 'https://example.test/a', at: 1_790_000_000_000 },
    // No title or no usable link: a card row here would be a dead line.
    { title: '   ', link: 'https://example.test/empty' },
    { title: 'No link at all' },
    { title: 'Javascript link', link: 'javascript:alert(1)' },
    // The same story arrives from two publishers; keep the first only.
    { title: 'Apple ships a thing', link: 'https://example.test/a' },
    { title: 'Second story', link: 'https://example.test/b', at: 'soon' },
  ])
  assert.equal(rows.length, 2)
  assert.equal(rows[0].title, 'Apple ships a thing', 'whitespace is normalised before the row is kept')
  assert.equal(rows[0].at, 1_790_000_000_000)
  assert.equal('publisher' in rows[1], false, 'an absent publisher is omitted, not an empty string')
  assert.equal(rows[1].at, null, 'a non-numeric timestamp becomes null')
  assert.equal(makeNews(null).length, 0, 'an empty answer is an empty list')
  assert.equal(makeNews(Array.from({ length: 30 }, (_, i) => ({ title: `t${i}`, link: `https://example.test/${i}` }))).length, 12, 'the list is capped')
})

test('schema: reported quarters keep their surprise and drop rows nobody can read', () => {
  const profile = makeProfile({
    symbol: 'AAPL',
    name: 'Apple Inc.',
    earningsSurprises: [
      { quarter: '2026-03-31', actual: 2.01, estimate: 1.94, surprisePct: 3.46, currency: 'USD' },
      { quarter: '2026-09-30', actual: 2.1, estimate: 1.9858, surprisePct: 5.75, currency: 'USD' },
      // No date, no actual, or an absurd surprise: not something to show.
      { quarter: '', actual: 1.1, estimate: 1.0, surprisePct: 10 },
      { quarter: '2026-06-30', actual: null, estimate: 1.8, surprisePct: 4 },
      { quarter: '2025-12-31', actual: 2.84, estimate: 2.67, surprisePct: 5000 },
    ],
  })
  const rows = profile.earningsSurprises
  assert.deepEqual(rows.map((row) => row.quarter), ['2026-09-30', '2026-03-31', '2025-12-31'], 'newest first, junk dates dropped')
  assert.equal(rows[0].surprisePct, 5.75, 'a real surprise survives')
  assert.equal(rows[2].surprisePct, null, 'an absurd surprise is dropped, the row stays')
  assert.equal(profile.earningsSurprises.length, 3, 'two rows were unusable')

  const empty = makeProfile({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF' })
  assert.equal(empty.earningsSurprises, undefined, 'no history, no key')
})

test('schema: the short book and the stakes behind a name land in percent', () => {
  const profile = makeProfile({
    symbol: 'AAPL',
    name: 'Apple Inc.',
    ownership: {
      institutions: 0.66577,
      insiders: 0.01655,
      shortFloat: 0.0091,
      shortShares: 131591865.4,
      shortPriorShares: 128759000,
      shortDays: 3.48,
      shortAsOf: '2026-10-15',
    },
  })
  const own = profile.ownership
  assert.equal(own.institutions, 66.577, 'a fraction leaves as a percent')
  assert.equal(own.insiders, 1.655, 'small stakes keep their decimals')
  assert.equal(own.shortFloat, 0.91, 'short float is a percent too')
  assert.equal(own.shortShares, 131591865, 'share counts are whole shares')
  assert.equal(own.shortChangePct, 2.2, 'the change against the prior month is rounded to one decimal')
  assert.equal(own.shortAsOf, '2026-10-15', 'the as-of date survives')

  const partial = makeProfile({
    symbol: 'MSFT',
    name: 'Microsoft',
    ownership: { institutions: 0.72, shortShares: 100, shortPriorShares: null, shortDays: 0, shortAsOf: 42 },
  }).ownership
  assert.equal(partial.shortChangePct, null, 'no prior month, no change')
  assert.equal(partial.shortDays, null, 'a zero days-to-cover is not a reading')
  assert.equal(partial.shortAsOf, null, 'a number is not a date')

  const empty = makeProfile({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', ownership: {} })
  assert.equal(empty.ownership, undefined, 'nothing usable means no block at all')
})

test('schema: sell-side momentum keeps the mix and the grade changes', () => {
  const profile = makeProfile({
    symbol: 'AAPL',
    name: 'Apple',
    ratings: {
      // Junk in the buckets must not become a slice: a negative count would
      // draw backwards, and a string would poison the total.
      trend: { strongBuy: 6, buy: 18, hold: 14, sell: 'x', strongSell: -2 },
      changes: [
        { firm: 'UBS', action: 'up', from: 'Neutral', to: 'Buy', at: 1762387200000 },
        { firm: 'Argus', action: 'main', from: 'Buy', to: 'Buy', at: 1762214400000 },
        { firm: 'Nope', action: 'downgrade', from: 'Buy', to: 'Sell', at: 1762300800000 },
        { firm: 'X'.repeat(80), action: 'init', from: null, to: 'Outperform', at: 1762128000000 },
        { firm: 'Stale', action: 'down', from: 'Buy', to: 'Hold', at: 0 },
      ],
    },
  });
  const r = profile.ratings;
  assert.equal(r.trend.total, 38, 'the total is the sum of usable buckets');
  assert.equal(r.trend.sell, 0, 'a non-numeric bucket reads as zero');
  assert.equal(r.trend.strongSell, 0, 'a negative bucket reads as zero');
  assert.equal(r.changes.length, 3, 'an unknown action and a missing timestamp are dropped');
  assert.deepEqual(r.changes.map((row) => row.firm.slice(0, 4)), ['UBS', 'Argu', 'XXXX'], 'the newest record leads');
  assert.equal(r.changes[2].firm.length, 40, 'a long firm name is clamped, not dropped');
  assert.equal(r.changes[2].from, null, 'a first-time rating has no previous grade');

  const trendOnly = makeProfile({ symbol: 'MSFT', name: 'Microsoft', ratings: { trend: { buy: 3 } } }).ratings;
  assert.equal(trendOnly.trend.total, 3, 'a mix without any changes still ships');
  assert.deepEqual(trendOnly.changes, [], 'and reports no changes rather than null');

  const none = makeProfile({ symbol: 'VOO', name: 'Vanguard S&P 500 ETF', ratings: { trend: { hold: 0 }, changes: [] } });
  assert.equal(none.ratings, undefined, 'nothing usable means no block at all');
  assert.equal(makeProfile({ symbol: 'SPY', name: 'SPDR S&P 500' }).ratings, undefined, 'a fund without coverage carries no ratings key');
})
