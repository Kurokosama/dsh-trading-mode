/**
 * Symbol directory (0.8.x).
 *
 * The seed exists so a search resolves a name even when the upstream suggest
 * endpoint is unreachable, and so a Chinese-reading user can type the Chinese
 * name of a name they hold. These checks pin the two things that decide whether
 * that works: every seeded stock keeps a Chinese label, and the matcher accepts
 * a *longer* Chinese query than the stored label without letting short Latin
 * aliases answer unrelated queries.
 *
 *   node tests/offline/directory.test.mjs
 */
import assert from 'node:assert/strict';

import { SEED_DIRECTORY, SymbolDirectory } from '../../lib/trading/directory.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('directory: seeded names and the Chinese search path');

const directory = new SymbolDirectory();
const symbols = (query, market = 'US', limit = 3) => directory.search(query, market, limit).map((row) => row.symbol);

await suite.check('the seed is well-formed and nothing is duplicated', () => {
  assert.ok(SEED_DIRECTORY.length >= 75, `the seed grew to ${SEED_DIRECTORY.length} entries`);
  const seen = new Set();
  for (const entry of SEED_DIRECTORY) {
    assert.match(entry.symbol, /^[A-Z][A-Z0-9.]*$/, `${entry.symbol} looks like a ticker`);
    assert.equal(seen.has(entry.symbol), false, `${entry.symbol} must not be listed twice`);
    seen.add(entry.symbol);
    assert.equal(typeof entry.name, 'string', `${entry.symbol} needs an English name`);
    assert.ok(entry.name.length > 2, `${entry.symbol} name is too short to be useful`);
    assert.match(entry.exchange, /^(NYSE|NASDAQ)$/, `${entry.symbol} needs a real exchange`);
  }
  assert.equal(directory.size, SEED_DIRECTORY.length, 'the directory indexes every seeded row');
});

await suite.check('every US stock in the seed carries a Chinese label', () => {
  const funds = new Set(['VOO', 'VTI', 'VXUS', 'QQQ', 'SPY', 'SCHD', 'SCHG', 'VGT', 'SGOV', 'SMH', 'GLD', 'TLT', 'IWM']);
  const stocks = SEED_DIRECTORY.filter((entry) => !funds.has(entry.symbol));
  const unlabelled = stocks.filter((entry) => !entry.nameZh);
  assert.deepEqual(unlabelled.map((entry) => entry.symbol), [], 'a stock without a label cannot be found by name');
  // A handful of names are known in Chinese by their Latin brand (Meta,
  // Palantir, ServiceNow, Coinbase), so the CJK count is what is pinned here.
  const withCjk = stocks.filter((entry) => /[\u4e00-\u9fff]/.test(entry.nameZh));
  assert.ok(withCjk.length >= 50, `the stock half carries ${withCjk.length} Chinese labels`);
  assert.ok(stocks.length >= 55, `the stock half of the seed has ${stocks.length} rows`);
  for (const entry of stocks) {
    assert.deepEqual(symbols(entry.nameZh), [entry.symbol], `${entry.nameZh} must resolve to ${entry.symbol}`);
  }
});

await suite.check('a Chinese name finds its ticker, common names included', () => {
  const expected = {
    苹果: 'AAPL',
    微软: 'MSFT',
    英伟达: 'NVDA',
    特斯拉: 'TSLA',
    可口可乐: 'KO',
    百事: 'PEP',
    摩根大通: 'JPM',
    高盛: 'GS',
    辉瑞: 'PFE',
    波音: 'BA',
    星巴克: 'SBUX',
    迪士尼: 'DIS',
    奈飞: 'NFLX',
    百度: 'BIDU',
    京东: 'JD',
    拼多多: 'PDD',
    蔚来: 'NIO',
    携程: 'TCOM',
  };
  for (const [query, symbol] of Object.entries(expected)) {
    assert.deepEqual(symbols(query), [symbol], `${query} must resolve to ${symbol}`);
  }
});

await suite.check('a longer Chinese query still lands on the shorter stored label', () => {
  // The stored label is "苹果"; the query the user types is often "苹果公司".
  // Forward containment cannot answer that, so CJK values match both ways.
  assert.deepEqual(symbols('苹果公司'), ['AAPL']);
  assert.deepEqual(symbols('小鹏汽车'), ['XPEV']);
  assert.deepEqual(symbols('理想汽车'), ['LI']);
  assert.deepEqual(symbols('百事可乐'), ['PEP']);
  assert.deepEqual(symbols('美光科技'), ['MU']);
  assert.deepEqual(symbols('美国银行'), ['BAC']);
});

await suite.check('Latin aliases and bare tickers keep working, and misses stay empty', () => {
  assert.deepEqual(symbols('coke'), ['KO']);
  assert.deepEqual(symbols('jpmorgan'), ['JPM']);
  assert.deepEqual(symbols('goldman'), ['GS']);
  assert.deepEqual(symbols('KO'), ['KO']);
  assert.deepEqual(symbols('nvda'), ['NVDA']);
  // The CJK reverse-match must not leak into Latin: "macroeconomics" contains
  // "ma", and Mastercard is seeded as MA.
  assert.deepEqual(symbols('macroeconomics'), []);
  assert.deepEqual(symbols('zzzznotaticker'), []);
});

await suite.check('the limit and the market filter are honoured', () => {
  assert.equal(directory.search('a', 'US', 3).length, 3, 'limit caps the result set');
  assert.deepEqual(
    directory.search('百度', 'US', 3).map((row) => row.market),
    ['US'],
    'a US-only search never returns another market',
  );
  assert.deepEqual(symbols('百度', 'HK'), [], 'the same query returns nothing across the border');
  assert.deepEqual(symbols(''), [], 'an empty query is not a search');
});

await suite.check('a live result enriches a seeded row without losing its Chinese name', () => {
  const copy = new SymbolDirectory();
  const before = copy.lookup('KO');
  assert.equal(before.nameZh, '可口可乐');
  copy.put({ symbol: 'ko', name: 'Coca-Cola Co', aliases: ['new alias'] });
  const after = copy.lookup('KO');
  assert.equal(after.nameZh, '可口可乐', 'the Chinese label survives an English-only update');
  assert.equal(after.aliases.includes('new alias'), true, 'aliases accumulate');
  assert.equal(after.name, 'Coca-Cola Co', 'a live name wins over the seed name');
});

process.exit(exitCodeFor(suite.finish()));
