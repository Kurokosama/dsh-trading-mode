/**
 * The holdings headline feed (1.1.0).
 *
 * `/news?symbols=A,B,C` merges the per-symbol caches behind one request, so the
 * merge itself is the part worth pinning down: order, deduplication, the symbol
 * tag, and the per-symbol cap that keeps one loud ticker from owning the card.
 * Pure in-process checks, no network.
 *
 *   node tests/offline/news.test.mjs
 */
import assert from 'node:assert/strict';

import { mergeNewsFeed } from '../../lib/trading/service.js';
import { createSuite, exitCodeFor } from './harness.mjs';

const suite = createSuite('news: the holdings feed merges, orders and stays mixed');

const at = (hour) => Date.UTC(2026, 10, 6, hour);
const row = (id, hour, link) => ({ id, title: `story ${id}`, link: link || `https://example.test/${id}`, at: hour === null ? null : at(hour) });

await suite.check('newest first, and each row says which holding it came from', () => {
  const merged = mergeNewsFeed([
    { symbol: 'AAPL', rows: [row('a1', 9), row('a2', 13)] },
    { symbol: 'NVDA', rows: [row('n1', 11)] },
  ], 8);
  assert.deepEqual(merged.map((item) => item.id), ['a2', 'n1', 'a1'], 'the feed reads newest first');
  assert.deepEqual(merged.map((item) => item.symbol), ['AAPL', 'NVDA', 'AAPL'], 'every row carries its symbol');
  return `ordered ${merged.map((item) => item.id).join('>')}`;
});

await suite.check('one story linked twice appears once, and a missing date sinks', () => {
  const merged = mergeNewsFeed([
    { symbol: 'AAPL', rows: [row('same', 10, 'https://example.test/one')] },
    { symbol: 'MSFT', rows: [row('same', 12, 'https://example.test/one'), row('undated', null)] },
  ], 8);
  assert.equal(merged.length, 2, `the duplicate link is dropped, got ${merged.length}`);
  assert.equal(merged[0].symbol, 'AAPL', 'the first sighting wins');
  assert.equal(merged[merged.length - 1].id, 'undated', 'a headline with no date sorts last');
  return 'duplicate links collapse, undated rows sink';
});

await suite.check('a loud symbol cannot take the whole card', () => {
  const loud = { symbol: 'NVDA', rows: [row('n1', 20), row('n2', 19), row('n3', 18), row('n4', 17)] };
  const quiet = { symbol: 'VOO', rows: [row('v1', 10)] };
  const merged = mergeNewsFeed([loud, quiet], 8);
  const nvda = merged.filter((item) => item.symbol === 'NVDA');
  assert.equal(nvda.length, 2, `two rows per symbol, got ${nvda.length}`);
  assert(merged.some((item) => item.symbol === 'VOO'), 'the quiet holding still gets a line');
  // A single-symbol feed is not capped: it is the only thing there is to read.
  const solo = mergeNewsFeed([loud], 8);
  assert.equal(solo.length, 4, `a lone symbol keeps its rows, got ${solo.length}`);
  // The limit is respected even when every bucket is full.
  const capped = mergeNewsFeed([loud, quiet, { symbol: 'AAPL', rows: [row('a1', 5), row('a2', 4)] }], 3);
  assert.equal(capped.length, 3, `the limit holds, got ${capped.length}`);
  return `mixed feed ${merged.map((item) => item.symbol).join('/')}, solo ${solo.length}`;
});

await suite.check('nothing in, nothing out', () => {
  assert.deepEqual(mergeNewsFeed([], 8), [], 'an empty feed is empty');
  assert.deepEqual(mergeNewsFeed(null, 8), [], 'a missing feed is tolerated');
  assert.deepEqual(mergeNewsFeed([{ symbol: 'AAPL', rows: null }], 8), [], 'a symbol with no rows contributes nothing');
  return 'empty inputs stay empty';
});

process.exit(exitCodeFor(suite));
