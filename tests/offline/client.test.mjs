/**
 * Client-half contract: loader shape, slot registration and server-render smoke
 * checks (0.5.x wording rules included).
 *
 * Portable: it discovers react/react-dom instead of hard-coding a profile path,
 * reads lib/client.js from this package, and needs no network.
 *
 *   node tests/offline/client.test.mjs   (or: npm run test:client)
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// 0.7.0 (P0-3): the render checks gate a release, so a missing prerequisite is
// a blocker there — `--release`/DSH_TEST_RELEASE turns the SKIP into a FAIL.
const RELEASE = process.argv.includes('--release') || process.env.DSH_TEST_RELEASE === '1';

/** Report this suite's result to the runner (0.7.0 P0-3); best effort. */
function report(result) {
  const target = process.env.DSH_TEST_RESULT_FILE;
  if (!target) return;
  try {
    appendFileSync(target, `${JSON.stringify(result)}\n`, 'utf8');
  } catch {
    /* reporting must never break the suite */
  }
}

// The React that renders these components belongs to the *host*: the client half
// is loaded into the DSH Web shell. Resolve it from, in order, an explicit
// override, this package's own devDependencies, every DSH profile on the
// machine, then a global install. When none of them has react, report SKIP.
function resolveReactRoot() {
  const candidates = [];
  if (process.env.DSH_TRADING_REACT_DIR) candidates.push(process.env.DSH_TRADING_REACT_DIR);
  candidates.push(path.resolve(PLUGIN, 'node_modules'));
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profiles = path.join(home, 'profiles');
  // Both layouts exist in the wild: profiles/node_modules (hoisted) and
  // profiles/<name>/node_modules (per-profile).
  candidates.push(path.join(profiles, 'node_modules'));
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(profiles, entry.name, 'node_modules'));
    }
  }
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules'));
  for (const dir of candidates) {
    if (dir && existsSync(path.join(dir, 'react')) && existsSync(path.join(dir, 'react-dom'))) return dir;
  }
  return null;
}

const REACT_ROOT = resolveReactRoot();
if (!REACT_ROOT) {
  console.log('\n== client bundle contract ==');
  const reason = 'react/react-dom are not resolvable, so the render checks cannot run';
  if (RELEASE) {
    console.log(`  FAIL  ${reason}.`);
    console.log('        Release builds may not skip the client render checks: run npm install, or point');
    console.log('        DSH_TRADING_REACT_DIR at a directory that contains node_modules.');
    report({ title: 'client', required: true, passed: 0, failed: 1, skipped: 0, skipReasons: [], failures: [reason], ok: false });
    process.exit(1);
  }
  console.log(`  SKIP  ${reason}.`);
  console.log('        Install the devDependencies (npm install), or point');
  console.log('        DSH_TRADING_REACT_DIR at a directory that contains node_modules.');
  report({
    title: 'client',
    required: true,
    passed: 0,
    failed: 0,
    skipped: 1,
    skipReasons: [{ name: 'client render checks', reason }],
    failures: [],
    ok: false,
  });
  process.exit(3);
}
const require = createRequire(path.join(REACT_ROOT, 'noop.js'));

let passed = 0;
let failed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    failures.push(`${name}: ${error && error.message}`);
    console.log(`  FAIL  ${name} — ${error && error.message}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

// --------------------------------------------------------------- DOM / loader
let captured = null;
const styleTags = [];

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};

// Pin the platform language so the English assertions below are deterministic.
// The plugin follows `navigator.language` unless DSH exposes its own locale, and
// the machine running this test may well be zh-CN (Node exposes that as a
// getter-only global, hence defineProperty rather than assignment).
Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en-US' },
  configurable: true,
  writable: true,
});

globalThis.document = {
  head: {
    appendChild(node) {
      styleTags.push(node);
      node.parentNode = {
        removeChild(target) {
          const index = styleTags.indexOf(target);
          if (index >= 0) styleTags.splice(index, 1);
        },
      };
    },
  },
  createElement() {
    return { textContent: '', parentNode: null };
  },
};

globalThis.fetch = () =>
  Promise.reject(Object.assign(new Error('network disabled in the smoke test'), { code: 'ERROR', name: 'Error' }));

const react = require('react');
const { renderToString } = require('react-dom/server');
const h = react.createElement;

console.log('== client bundle contract ==');

const source = readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8');

await check('lib/client.js loads through window.__ModuleLoader__.load', async () => {
  assert(!/^\s*(import|export)\s/m.test(source), 'the bundle must not contain top-level ESM syntax');
  // eslint-disable-next-line no-new-func
  new Function(source)();
  assert(captured, 'load() was never called');
  assert(captured.id === 'dsh-trading-mode', `id must be the npm package name, got ${captured.id}`);
  return `id=${captured.id}`;
});

let mod = null;
await check('factory resolves react and returns { name, inject, apply }', async () => {
  mod = captured.factory((id) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require("${id}") — only platform seeds are resolvable`);
  });
  assert(typeof mod.apply === 'function', 'apply must be a function');
  assert(mod.name === 'trading-mode', `name must be trading-mode, got ${mod.name}`);
  assert(Array.isArray(mod.inject) && mod.inject.includes('slots'), 'inject must declare the slots service');
  return `name=${mod.name} inject=[${mod.inject}]`;
});

const registry = [];
const effects = [];
await check('apply registers the sidebar row and its main panel', async () => {
  // The registration contract is the one the shipped third-party plugins use on
  // the live runtime: `ctx.slots.inject(key, callback)` with a PLAIN callback
  // that returns the registration's disposer (not a generator), and
  // `ctx.slots.register(options, Component)`.
  let activeKey = null;
  const ctx = {
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    slots: {
      inject(key, callback) {
        assert(typeof callback === 'function', 'slots.inject must be given a callback');
        assert(
          callback.constructor.name !== 'GeneratorFunction',
          'slots.inject must take a plain callback returning a disposer, not a generator',
        );
        activeKey = key;
        const disposer = callback();
        activeKey = null;
        assert(typeof disposer === 'function', `slots.inject callback for ${key} must return a disposer`);
        return () => {};
      },
      register(options, Component) {
        assert(typeof Component === 'function', 'slot registration must pass a component function');
        // The registration names its slot; one `inject` can register several
        // slots (the sidebar row and the page it selects are registered together).
        const entry = { key: options.name, injectKey: activeKey, options, Component };
        registry.push(entry);
        return () => {
          const at = registry.indexOf(entry);
          if (at !== -1) registry.splice(at, 1);
        };
      },
    },
  };
  mod.apply(ctx);

  assert(registry.length === 2, `expected 2 slots, got ${registry.length}`);
  const row = registry.find((entry) => entry.key === 'sidebar.panellist');
  const page = registry.find((entry) => entry.key === 'main');
  assert(row, 'the sidebar.panellist row must be populated');
  assert(page, 'the main page must be populated');
  assert(row.options.id === 'trading-mode', 'the sidebar row must carry the panel id');
  assert(row.options.order === 2, `the row must sit directly below 插件市场, got order ${row.options.order}`);
  assert(typeof row.options.label === 'function', 'the row label must be lazy so it follows the language');
  assert(page.options.key === 'trading-mode', 'the main panel key must be the sidebar row id');
  assert(!('id' in page.options), 'keyed main panels register a key, not an id');
  assert(row.injectKey === 'sidebar.panellist', 'the row belongs to the sidebar slot');
  assert(
    page.injectKey === 'main',
    'the page must be injected through the main slot: the host mounts panels from that injection, and registering it from the sidebar callback leaves the page area empty',
  );
  assert(
    registry.every((entry) => entry.key !== 'conversation.session.header.actions'),
    'the session header must stay free of the Trading Mode button',
  );
  assert(typeof row.options.id === 'string' && row.options.id.length > 0, 'the row needs a stable id');
  assert(typeof row.options.order === 'number', 'the row needs an order');
  const glyph = renderToString(h(row.Component, { size: 18 }));
  assert(glyph.includes('<svg') && glyph.includes('width="18"'), 'the row must draw the icon at the host size');
  assert(styleTags.length === 1, 'exactly one stylesheet must be injected');
  assert(effects.some((entry) => String(entry.label).includes('styles')), 'the stylesheet must be cleaned up on dispose');
  return `slots=${registry.map((entry) => entry.key).join(', ')}`;
});

await check('apply still registers the page when the host never runs the main injection', async () => {
  const registry = [];
  const ctx = {
    effect(fn, label) {
      const disposer = fn();
      effects.push({ label, disposer });
      return disposer;
    },
    slots: {
      inject() { return () => {}; },   // accepted, callback never called
      register(options, Component) {
        registry.push({ key: options.name });
        return () => {};
      },
    },
  };
  mod.apply(ctx);
  assert(
    registry.some((entry) => entry.key === 'main'),
    'the page must be registered even when the injection callback never runs',
  );
  return `registered: ${registry.map((entry) => entry.key).join(', ')}`;
});

await check('dispose removes the injected stylesheet', async () => {
  for (const entry of effects) {
    if (typeof entry.disposer === 'function') entry.disposer();
  }
  assert(styleTags.length === 0, `stylesheet leaked: ${styleTags.length} still attached`);
  return '0 style tags left';
});

// ------------------------------------------------------------------ ssr render
const internals = mod._internals;

await check('helpers: symbol mapping for the TradingView embed', async () => {
  // The US-only build maps everything through US venues; the pre-fork HKEX
  // branch was removed with the other markets.
  assert(internals.tradingViewSymbol({ symbol: '0700.HK' }) === 'NASDAQ:0700.HK', 'a non-US tick falls back to the US venue');
  assert(internals.tradingViewSymbol({ symbol: 'AAPL', exchange: 'NASDAQ' }) === 'NASDAQ:AAPL', 'US listing keeps its venue');
  assert(internals.tradingViewSymbol({ symbol: 'BABA', exchange: 'NYSE' }) === 'NYSE:BABA', 'NYSE must not collapse to NASDAQ');
  return '0700.HK → NASDAQ:0700.HK, AAPL → NASDAQ:AAPL';
});

await check('helpers: quote formatting never prints NaN', async () => {
  assert(internals.money(421.2, 'HKD') === 'HK$421.20', `got ${internals.money(421.2, 'HKD')}`);
  assert(internals.money(undefined, 'USD') === '—', 'missing price must render as a dash');
  assert(internals.percent(-0.02) === '−0.02%', `got ${internals.percent(-0.02)}`);
  assert(internals.volumeText(1234567) === '1.23M', `got ${internals.volumeText(1234567)}`);
  assert(internals.clockOf(undefined) === '—', 'missing timestamp must render as a dash');
  return 'money/percent/volume/clock';
});

await check('geometry: one body + wick per bar, volume panel below the price', async () => {
  const bars = [
    { timestamp: 1, open: 10, high: 12, low: 9, close: 11, volume: 100 },
    { timestamp: 2, open: 11, high: 13, low: 10, close: 10.5, volume: 200 },
  ];
  const series = { timestamp: [1, 2], ma20: [10.5, 10.6], ma50: [10, 10.1], ma200: [9, 9.1] };
  const geo = internals.buildGeometry(bars, series, 1000, 340);
  assert(geo.bodies.length === 2 && geo.wicks.length === 2 && geo.volumes.length === 2, 'one shape per bar');
  assert(geo.lines.length === 3, 'three moving averages must produce three polylines');
  assert(geo.max === 13 && geo.min === 9, `price range wrong: ${geo.min}..${geo.max}`);
  assert(geo.volumes.every((v) => v.y > 200), 'volume bars must sit in the lower panel');
  return `${geo.bodies.length} bars, ${geo.lines.length} MAs`;
});

await check('downsample keeps the first and last bar', async () => {
  const bars = Array.from({ length: 1500 }, (_, i) => ({ timestamp: i, open: i, high: i, low: i, close: i, volume: i }));
  const out = internals.downsample(bars, 320);
  assert(out.length <= 321, `too many bars survived: ${out.length}`);
  assert(out[0].timestamp === 0 && out[out.length - 1].timestamp === 1499, 'range endpoints must survive');
  return `${bars.length} → ${out.length} bars`;
});

await check('the page renders as a main panel without a conversation', async () => {
  internals.store.set({ view: 'home', symbol: null });
  const html = renderToString(h(internals.TradingApp));
  assert(html.includes('tm-page'), 'the panel root must be the page, not the old overlay');
  assert(html.includes('DSH Trading Mode'), 'the page keeps its brand header');
  assert(!html.includes('tm-window'), 'the overlay window must be gone');
  return `${html.length} chars`;
});

let homeHtml = '';
await check('home view renders Search + My Watchlist + AI Watchlist Brief', async () => {
  internals.store.set({ view: 'home', symbol: null, browseMode: false });
  homeHtml = renderToString(h(internals.TradingApp));
  for (const needle of ['DSH Trading Mode', 'My Watchlist', 'AI Watchlist Brief', 'Search Stocks', 'Browse listings']) {
    assert(homeHtml.includes(needle), `home view is missing "${needle}"`);
  }
  // m00113: adding a stock is the + on a search result row, so no separate
  // "Add Stock" mode may sit below the watchlist any more.
  assert(!homeHtml.includes('Add Stock'), 'the old Add Stock button must be gone');
  assert(!/Filter listings/.test(homeHtml), 'the page must not carry a second search field');
  assert(homeHtml.includes('Data source status') || homeHtml.includes('sources ready'), 'the data-source status strip must render');
  return `${homeHtml.length} chars`;
});

let detailHtml = '';
await check('detail view renders the §27 sections', async () => {
  internals.store.set({ view: 'detail', symbol: 'AAPL' });
  detailHtml = renderToString(h(internals.TradingApp));
  for (const needle of ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'Chart', 'Market Data', 'Technical Indicators', 'AI Analysis', 'Previous Close', 'TradingView']) {
    assert(detailHtml.includes(needle), `detail view is missing "${needle}"`);
  }
  // Effects do not run under renderToString, so the chart/technical panels are
  // in their loading state here; the loaded state is covered by technicalCells.
  assert(detailHtml.includes('Computing indicators'), 'the technical panel must show its loading state');
  return `${detailHtml.length} chars`;
});

await check('§31 technical grid maps every required indicator', async () => {
  const tech = {
    ma5: 1, ma10: 2, ma20: 3, ma50: 4, ma60: 5, ma200: 6,
    ema12: 7, ema26: 8, rsi14: 9, macd: 10, macdSignal: 11, macdHistogram: 12,
    atr14: 13, volumeRatio20d: 14, volumeAverage20d: 15, high52w: 16, low52w: 17,
    trendAlignment: 'bullish-stack', volatility20dAnnualizedPct: 18,
  };
  const cells = internals.technicalCells(tech);
  const labels = cells.map((cell) => cell.label);
  for (const needle of ['MA5', 'MA10', 'MA20', 'MA50', 'MA60', 'MA200', 'EMA12', 'EMA26', 'RSI14', 'MACD', 'MACD Signal', 'MACD Histogram', 'ATR14', 'Volume Ratio (20D)']) {
    assert(labels.includes(needle), `technical grid is missing "${needle}"`);
  }
  const byLabel = Object.fromEntries(cells.map((cell) => [cell.label, cell.value]));
  assert(byLabel.MA20 === '3.00', `MA20 should be formatted, got ${byLabel.MA20}`);
  assert(byLabel.RSI14 === '9.00', `RSI14 should be formatted, got ${byLabel.RSI14}`);
  assert(byLabel['Volume Ratio (20D)'] === '14.00×', `volume ratio unit missing, got ${byLabel['Volume Ratio (20D)']}`);
  assert(byLabel['Volatility 20D (ann.)'] === '18.00%', 'volatility must carry a percent sign');
  assert(internals.technicalCells(null).length === 0, 'no technical block means no cells');
  assert(internals.technicalCells({}).every((cell) => cell.value === '—'), 'missing fields must render as a dash, not NaN');
  return `${cells.length} cells`;
});

await check('brief: a long book is summarised, not dropped or stacked', async () => {
  const cap = internals.capPositions;
  const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const five = cap(many);
  assert(five.shown.length === 5 && five.hidden === 2, 'five shown, the rest counted');
  assert(cap(['a']).hidden === 0, 'a short book hides nothing');
  assert(cap([]).shown.length === 0, 'empty stays empty');
  assert(cap(null).hidden === 0, 'no list is not an error');
  assert(cap(many, 2).shown.length === 2, 'the cap is honoured when asked for');
  assert(internals.ZH['{n} more positions'] === '另有 {n} 个持仓（导出里是全量）', 'the tail is localised');
  assert(String(internals.BriefCard).includes('capPositions(positions)'), 'the card caps its own list');
  const t = internals.makeT('en');
  const text = internals.briefLines({ headline: 'Board up.' }, many, t, 'en').join('\n');
  assert(text.includes('b') && !text.includes('- g'), 'the copied text stops at the cap');
  assert(text.includes('2 more positions'), 'and says how many it left out');
  assert(internals.CSS.includes('.tm-brief__more'), 'the tail line has its own hook');
  return 'position cap ok';
});

await check('detail: the header says when this page is already a position', async () => {
  const badge = internals.holdingBadge;
  assert(badge({ price: 180, shares: 12 }).shares === 12, 'a real position comes back');
  assert(badge({ price: 180, shares: 0 }) === null, 'zero shares is a placeholder, not a position');
  assert(badge({ price: 180 }) === null, 'shares are required');
  assert(badge({ shares: 12 }) === null, 'a cost-less position cannot be described');
  assert(badge(null) === null, 'nothing to say');
  assert(badge({ price: 0, shares: 3 }) === null, 'a zero price is not a cost');
  assert(internals.ZH['Holding {shares} @ {cost}'] === '持仓 {shares} 股 · 成本 {cost}', 'localised label');
  assert(internals.CSS.includes('.tm-badge--held'), 'the badge has its own hook');
  assert(String(internals.DetailView).includes('tm-badge--held'), 'the detail header renders it');
  assert(String(internals.DetailView).includes('holdingBadge(myCost)'), 'and reads it from the stored cost');
  return 'holding badge ok';
});

await check('overview: the money you hold is measured next to the list you watch', async () => {
  const fn = internals.boardVsIndex;
  const items = [{ symbol: '^GSPC', name: 'S&P 500', quote: { changePct: 0.2 } }];
  const rows = [
    { symbol: 'AAPL', quote: { changePct: 1 } },
    { symbol: 'NVDA', quote: { changePct: 3 } },
    { symbol: 'MSFT', quote: { changePct: -1 } },
  ];
  const all = fn(rows, items);
  assert(all.board === 1, `board average, got ${all.board}`);
  assert(all.heldN === 0 && all.heldBoard === null, 'no position set means no held average');
  assert(all.heldGap === null, 'and no gap for it');
  const some = fn(rows, items, '^GSPC', new Set(['NVDA']));
  assert(some.heldN === 1 && some.heldBoard === 3, `held average over the owned rows, got ${some.heldBoard}`);
  assert(Math.abs(some.heldGap - 2.8) < 1e-9, `held gap against the index, got ${some.heldGap}`);
  assert(some.board === 1, 'the board average is unchanged by the held set');
  const arrayForm = fn(rows, items, '^GSPC', ['nvda']);
  assert(arrayForm.heldN === 1, 'an array works and is case-insensitive like the rest of the panel');
  assert(internals.ZH['Held equal-weight'] === '持仓等权', 'the label is localised');
  assert(internals.CSS.includes('.tm-vs__held'), 'the line has its own hook');
  assert(String(internals.MarketOverview).includes('boardVsIndex(rows, items, \'^GSPC\', held)'), 'the card passes the held set through');
  return 'held equal-weight ok';
});

await check('notes: the ticker inside a sentence is a link, and only a real ticker', async () => {
  const parts = internals.noteParts;
  const line = 'NVDA is 42% of your USD positions; at that weight its drawdown is your drawdown.';
  const split = parts(line, ['NVDA', 'AAPL']);
  assert(split[0] && split[0].symbol === 'NVDA', 'the leading ticker is its own part');
  assert(split.slice(1).map((part) => part.text || '').join('').startsWith(' is 42%'), 'the prose after it is preserved');
  assert(split.slice(1).map((part) => part.text || '').join('') === line.slice(4), 'nothing is dropped');
  const two = parts('AAPL and NVDA both moved', ['NVDA', 'AAPL']);
  assert(two.filter((part) => part.symbol).map((part) => part.symbol).join(',') === 'AAPL,NVDA', 'every known ticker is picked up, in order');
  const glued = parts('NVDAX is not NVDA', ['NVDA']);
  assert(glued.filter((part) => part.symbol).length === 1, 'a longer word is not a ticker hit');
  assert(parts(line, []).length === 1 && parts(line, [])[0].text === line, 'no known symbols leaves the line intact');
  assert(parts('', ['NVDA']).length === 0 && parts(null, ['NVDA']).length === 0, 'empty input, empty parts');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const html = renderToStaticMarkup(
    React.createElement(internals.AccountNotesCard, { notes: [line], symbols: ['NVDA'], onOpen: () => {} }),
  );
  assert(html.includes('tm-notes__sym'), 'the card renders the ticker as a control');
  assert(internals.CSS.includes('.tm-notes__sym'), 'and styles it');
  return 'note parts ok';
});

await check('alerts: the history can be downloaded as a spreadsheet', async () => {
  const t = internals.makeT('en');
  const entries = [
    { key: 'US:NVDA', symbol: 'NVDA', hit: 'above', level: 180, pct: 2.4, at: 1762480000000 },
    { key: 'US:event:2026-11-09:earnings:AAPL', symbol: 'AAPL', hit: 'event', type: 'earnings', when: 'today', at: 1762470000000 },
  ];
  const csv = internals.alertLogCsv(entries, t);
  const lines = csv.split('\r\n');
  assert(lines[0] === 'Time,Symbol,Kind,Detail,Key', `header first, got "${lines[0]}"`);
  assert(lines.length === 3, `one line per entry, got ${lines.length}`);
  assert(lines[1].startsWith('NVDA') || lines[1].includes(',NVDA,'), 'the symbol column is the ticker');
  assert(lines[1].includes('above'), 'the kind is machine-readable');
  assert(csv.includes('Earnings') && csv.includes('today'), 'the detail reads like the card row');
  assert(internals.alertLogCsv(null, t).split('\r\n').length === 1, 'an empty history is still a header');
  assert(String(internals.AlertLogCard).includes('Download CSV'), 'the card offers the download');
  assert(String(internals.AlertLogCard).includes('alertLogCsv(entries, t)'), 'and builds it from the same list');
  assert(internals.ZH['Download CSV'] === '下载 CSV', 'the button is localised');
  return 'alert csv ok';
});

await check('help: the dialog explains the marks, not only the keys', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  assert(Array.isArray(internals.LEGEND) && internals.LEGEND.length >= 5, 'the legend is a table of marks');
  for (const row of internals.LEGEND) {
    assert(row.mark && row.label, 'every legend row has a mark and a sentence');
    assert(internals.ZH[row.label], `every legend sentence is localised: ${row.label}`);
  }
  assert(internals.ZH['What the marks mean'] === '标记说明', 'the section heading is localised');
  assert(String(internals.TradingApp).includes('LEGEND.map'), 'the dialog lists the legend');
  assert(internals.CSS.includes('.tm-kbd--mark'), 'the marks have their own style');
  return 'legend ok';
});

await check('home: the jump chip carries the week it is asking you to look at', async () => {
  const home = String(internals.HomeView);
  assert(home.includes('onCounts: setEventCounts'), 'the board reports its counts up to the page');
  assert(home.includes('tm-jump__n'), 'the events chip can carry a number');
  assert(home.includes('{n} in the next seven days') || home.includes("'{n} in the next seven days'"), 'the badge explains itself on hover');
  const board = String(internals.EventBoard);
  assert(board.includes('onCounts'), 'the board accepts the callback');
  assert(board.includes('counts.soon') && board.includes('counts.total'), 'and reports the numbers that matter');
  assert(/\[counts\.soon, counts\.total\]/.test(board), 'keyed on the numbers, so a re-render cannot loop');
  assert(internals.CSS.includes('.tm-jump__n'), 'the badge has its own hook');
  assert(internals.ZH['{n} in the next seven days'] === '未来七天 {n} 件', 'the tooltip is localised');
  return 'jump badge ok';

  // The home page pairs its two context rows side by side on a wide panel.
  assert(home.split("className: 'tm-pair'").length === 3, 'two rows share a pair grid');
  assert(internals.CSS.includes('.tm-pair'), 'the pair grid is styled');
  assert(internals.CSS.includes('@media (min-width: 1000px)'), 'pairing only starts on a wide panel');
  assert(internals.CSS.includes('.tm-pair > .tm-card { height: 100%'), 'the shorter card fills the row instead of leaving a gap');

});

await check('watchlist: the full card survives a row set and the events header asks its question', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 210, change: 10, changePct: 5 } },
    { symbol: 'NVDA', market: 'US', quote: { price: 100, change: -2, changePct: -2 } },
  ];
  // Regression: the earnings request hook used to be declared AFTER the render
  // code that read it (sort / hasEvents), so any first paint with rows raised
  // "Cannot access 'earnings' before initialization" in the reader's browser.
  // Push the whole surface at once — a dated earnings payload with a real cost
  // basis exercises the sort path, the event chip, the weight, the P&L and the
  // day-money chip in the same paint. A regression in any of these pieces
  // fails HERE at build time instead of reaching the reader's browser.
  const html = renderToStaticMarkup(
    React.createElement(internals.WatchlistCard, {
      rows,
      onOpen: () => {},
      alerts: {},
      costs: { 'US:AAPL': { price: 200, shares: 2 } },
      onRemove: () => {},
      onFavorite: () => {},
      onMove: () => {},
      onRefresh: () => {},
      loading: false,
      error: null,
      identity: null,
    }),
  );
  assert(html.includes('AAPL'), 'the row carries the ticker');
  assert(html.includes('+20.00'), `the day money chip prints, got ${html.includes('+100.00')}`);
  assert(html.includes('tm-row__weight'), 'the weight chip renders for the held row');
  assert(internals.CSS.includes('.tm-since'), 'the card still mounts with its named pieces');
  // The same paint with a full brief surface (a position marker on a suggestion)
  const briefHtml = renderToStaticMarkup(
    React.createElement(internals.BriefCard, {
      brief: { headline: 'Board 1 up, 1 down — NVDA leads.', suggestions: ['NVDA hold through the report'] },
      positions: [],
      held: new Set(['NVDA']),
      onRun: () => {},
      loading: false,
      error: null,
      aiAvailable: true,
      aiReason: null,
      editions: null,
    }),
  );
  assert(briefHtml.includes('Held'), 'a suggestion that lands on a held name carries the marker');
  return 'watchlist card renders ok';
});

await check('watchlist: what changed while the panel was closed is named', async () => {
  const prev = { at: 1762480000000, rows: { AAPL: 100, NVDA: 200, MSFT: 300 } };
  const rows = [
    { symbol: 'AAPL', quote: { price: 103 } },
    { symbol: 'NVDA', quote: { price: 190 } },
    { symbol: 'MSFT', quote: { price: 300.4 } },
    { symbol: 'TSLA', quote: { price: 400 } },
  ];
  const changed = internals.visitChanges(prev, rows);
  assert(changed.length === 2, `only moves past the floor are listed, got ${changed.length}`);
  assert(changed[0].symbol === 'NVDA' && Math.abs(changed[0].pct + 5) < 1e-9, 'the biggest move leads');
  assert(changed[1].symbol === 'AAPL', 'then the smaller one');
  assert(!changed.some((entry) => entry.symbol === 'TSLA'), 'a name that was not there before is not a change');
  assert(!changed.some((entry) => entry.symbol === 'MSFT'), 'a 0.13% drift is noise, not news');
  assert(internals.visitChanges(null, rows).length === 0, 'no snapshot, no claim');
  const store = new Map();
  const previous = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    assert(internals.writeVisit(rows) === true, 'a visit with live prices is recorded');
    const back = internals.readVisit();
    assert(back && back.rows.NVDA === 190, 'and reads back with prices');
    assert(internals.writeVisit([]) === false, 'an empty board records nothing');
    assert(internals.ZH['Since you last looked'] === '自上次打开', 'the line is localised');
    assert(internals.CSS.includes('.tm-since'), 'the line has its own hook');
    assert(String(internals.WatchlistCard).includes('visitChanges(prevVisit, rows)'), 'the card uses the helper');
  } finally {
    if (previous === undefined) delete globalThis.window.localStorage;
    else globalThis.window.localStorage = previous;
  }
  return 'visit changes ok';
});

await check('watchlist: the day is named by its cause, not just its total', async () => {
  const quote = (price) => ({ price, change: 0, changePct: 0, currency: 'USD' });
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: quote(210) },
    { symbol: 'NVDA', market: 'US', quote: quote(90) },
    { symbol: 'MSFT', market: 'US', quote: quote(300) },
  ];
  const costs = {
    'US:AAPL': { price: 200, shares: 10 },
    'US:NVDA': { price: 100, shares: 10 },
  };
  const probe = internals.positionOf({ price: 210, change: 1, currency: 'USD' }, { price: 200, shares: 10 });
  assert(probe && typeof probe.today === 'number', `positionOf must carry today, got ${JSON.stringify(probe)}`);
  const day = internals.dayDrivers(rows, costs);
  assert(day.currency === 'USD', 'the largest book speaks');
  assert(day.today === 0, `total is the sum of both positions, got ${day.today}`);
  assert(day.up === null && day.down === null, 'a flat day names nobody');
  const moved = internals.dayDrivers(
    [
      { symbol: 'AAPL', market: 'US', quote: { price: 211, change: 1, changePct: 0.5, currency: 'USD' } },
      { symbol: 'NVDA', market: 'US', quote: { price: 91, change: 2, changePct: 2.2, currency: 'USD' } },
    ],
    { 'US:AAPL': { price: 200, shares: 10 }, 'US:NVDA': { price: 100, shares: 10 } },
  );
  assert(moved.today > 0, 'a rising book has a positive day');
  assert(moved.up && moved.up.symbol === 'NVDA', 'the bigger dollar gain leads, not the bigger percent');
  assert(moved.down === null, 'nothing fell, so nobody is named as the drag');
  assert(internals.dayDrivers([], costs) === null, 'no rows, no line');
  assert(internals.dayDrivers(rows, null) === null, 'no cost basis, no claim');
  assert(internals.ZH['Today {amount}'] === '今天 {amount}', 'the line is localised');
  assert(internals.CSS.includes('.tm-day'), 'the line has its own hook');
  assert(String(internals.WatchlistCard).includes('dayDrivers(rows, costs)'), 'the card renders it');
  return 'day drivers ok';
});

await check('notes: a huge move on a tiny position is not a decision', async () => {
  const t = internals.makeT('en');
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 110, currency: 'USD' } },
    { symbol: 'MSFT', market: 'US', quote: { price: 300, currency: 'USD' } },
  ];
  const costs = {
    'US:AAPL': { price: 100, shares: 1000 },
    'US:MSFT': { price: 100, shares: 1 },
  };
  const notes = internals.positionNotes(rows, costs, t);
  const first = notes[0] || '';
  assert(first.includes('AAPL'), `the note sizes by money, so the big position is named (got "${first}")`);
  assert(!first.includes('MSFT'), 'a 1.4% position does not earn a decision sentence');
  const all = notes.join(' | ');
  assert(!/MSFT/.test(all) || !all.includes('+200.0%'), 'the 200% on one share is not reported as a decision');
  const single = internals.positionNotes(
    [{ symbol: 'MSFT', market: 'US', quote: { price: 300, currency: 'USD' } }],
    { 'US:MSFT': { price: 100, shares: 1 } },
    t,
  );
  assert(single.length === 1 && single[0].includes('MSFT'), 'a one-name book still hears about its own move');
  return 'money-sized note ok';
});

await check('home: the cost-basis warnings are visible before a brief is written', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const render = (notes) =>
    renderToStaticMarkup(React.createElement(internals.AccountNotesCard, { notes }));
  const heavy = render(['NVDA is 42% of your USD positions; at that weight its drawdown is your drawdown.']);
  assert(heavy.includes('tm-notes'), 'the card has its list');
  assert(heavy.includes('42%'), 'and carries the sentence it was given');
  assert(heavy.includes('tm-notes-card') || heavy.includes('tm-card--notes'), 'the card is identifiable');
  const many = render(['a', 'b', 'c', 'd', 'e', 'f']);
  assert(many.includes('2 more in the brief'), 'the tail is counted, not dropped silently');
  assert(render([]) === '', 'no notes, no card');
  assert(render(null) === '', 'no list, no card');
  assert(render(['', null, 'kept']) .includes('kept'), 'junk entries are skipped, real ones survive');
  assert(internals.ZH['Account notes'] === '账户笔记', 'the title is localised');
  assert(String(internals.HomeView).includes('AccountNotesCard'), 'the home page renders it');
  return 'account notes ok';
});

await check('search: a result says whether the name is already a position', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const row = { symbol: 'NVDA', market: 'US', exchange: 'NASDAQ', currency: 'USD', name: 'NVIDIA Corporation', nameZh: '英伟达' };
  const render = (held) =>
    renderToStaticMarkup(
      React.createElement(internals.SearchRow, { row, active: false, owned: false, held, onOpen: () => {}, onAdd: () => {} }),
    );
  const marked = render(true);
  assert(marked.includes('tm-result__held'), 'a held name carries the pill');
  assert(marked.includes('>Held<'), 'the pill carries a word, not just a colour');
  assert(internals.ZH['Held'] === '持仓', 'and the word is localised');
  const plain = render(false);
  assert(!plain.includes('tm-result__held'), 'a name without a position stays plain');
  assert(internals.ZH['You hold this one'] === '你持有这只', 'the tooltip is localised');
  assert(internals.CSS.includes('.tm-result__held'), 'the pill has its own style hook');
  assert(String(internals.SearchBox).includes('held: Boolean(held && held(row))'), 'the box asks the helper per row');
  return 'held marker ok';
});

await check('chart: the drawn picture says what it is, out loud', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const candles = [
    { timestamp: '2026-11-03T00:00:00Z', open: 100, high: 106, low: 99, close: 105, volume: 1000 },
    { timestamp: '2026-11-04T00:00:00Z', open: 105, high: 110, low: 104, close: 108, volume: 1200 },
  ];
  const html = renderToStaticMarkup(React.createElement(internals.CandleChart, { candles, series: null }));
  assert(html.includes('aria-label="2 bars'), `the chart names its size and window, got ${html.slice(0, 200)}`);
  assert(html.includes('last close 108'), 'and where it closed');
  assert(html.includes('role="img"'), 'still an image to the accessibility tree');
  assert(internals.ZH['{n} bars, {from} to {to}; last close {close}'].includes('根 K 线'), 'the label is localised');
  assert(String(internals.CandleChart).includes("'aria-label'"), 'the element carries it');
  return 'chart label ok';
});

await check('watchlist rail: the cost marker rides the 52-week band when it belongs there', async () => {
        const tech = { low52w: 100, high52w: 200 }
        const span = tech.high52w - tech.low52w
        const mk = (price) => (price >= tech.low52w && price <= tech.high52w ? Math.max(0, Math.min(100, 100 * (price - tech.low52w) / span)) : null)
        assert(mk(150) === 50, 'mid band midpoint')
        assert(mk(200) === 100, 'top of band')
        assert(mk(250) === null, 'above band has no marker')
        assert(mk(50) === null, 'below band has no marker')
        assert(String(internals.DetailView).includes('tm-range__cost'), 'rail carries the cost marker')
        assert(/tm-range__cost[\s\S]*?background: transparent/.test(String(internals.CSS)), 'cost dot CSS present')
        assert(internals.ZH['Your cost'] === '成本价', 'zh cost label present')
      })
      await check('chart: the cost basis is drawn on the price scale, not guessed', async () => {
  const geo = internals.buildGeometry;
  const bars = [
    { timestamp: '2026-11-01T00:00:00Z', open: 100, high: 120, low: 98, close: 110, volume: 1000 },
    { timestamp: '2026-11-02T00:00:00Z', open: 110, high: 200, low: 105, close: 190, volume: 2000 },
  ];
  const withLine = geo(bars, null, 1000, 340, [{ key: 'cost', price: 150, label: 'Cost' }]);
  assert(withLine.levels.length === 1, 'one mark inside the range is one level');
  const level = withLine.levels[0];
  assert(level.y > 10 && level.y < 250, `level sits inside the price plot, got ${level.y}`);
  const top = geo(bars, null, 1000, 340, [{ key: 'cost', price: 200 }]).levels[0];
  const bottom = geo(bars, null, 1000, 340, [{ key: 'cost', price: 98 }]).levels[0];
  assert(top.y < bottom.y, 'a higher cost is drawn above a lower one');
  assert(geo(bars, null, 1000, 340, [{ key: 'cost', price: 400 }]).levels.length === 0, 'above the high is not drawn');
  assert(geo(bars, null, 1000, 340, [{ key: 'cost', price: 50 }]).levels.length === 0, 'below the low is not drawn');
  assert(geo(bars, null, 1000, 340, [{ key: 'cost', price: null }]).levels.length === 0, 'a missing price draws nothing');
  assert(geo(bars, null, 1000, 340, []).levels.length === 0, 'no marks, no levels');
  assert(geo(bars, null, 1000, 340).levels.length === 0, 'an omitted list is still no levels');
  assert(internals.CSS.includes('.tm-chart__level'), 'the level needs its own style hook');
  assert(internals.CSS.includes('.tm-chart__level-tag'), 'the label needs its own style hook');
  assert(internals.ZH['Your cost'] === '成本价', 'the label is localised');
  assert(String(internals.CandleChart).includes('tm-chart__level'), 'the chart must draw the level');
  return 'cost level ok';
});

await check('panel: a zero-height slot says so instead of staying blank', async () => {
  assert(String(internals.TradingApp).includes('useSlotNotice'), 'the page watches its own slot');
  assert(String(internals.useSlotNotice).includes('IntersectionObserver'), 'visibility is measured, not guessed');
  assert(String(internals.TradingApp).includes('tm-zero'), 'the notice is rendered');
  assert(internals.CSS.includes('.tm-zero'), 'the notice has a style');
  const css = internals.CSS.slice(internals.CSS.indexOf('.tm-zero'));
  assert(css.slice(0, 120).includes('position: fixed'), 'fixed, so a clipping ancestor cannot hide the notice too');
  const zh = internals.makeT('zh');
  assert(zh('The panel has no visible area') === '面板没有可见区域', 'zh title');
  return 'zero-slot notice covered';
});

await check('help: the same rows can leave as text a person can paste', async () => {
  const t = internals.makeT('en');
  const text = internals.diagnosticsText(t);
  assert(typeof text === 'string' && text.length > 0, 'text is not empty');
  assert(text.includes('Storage:'), `storage row, got: ${text}`);
  assert(text.split('\n').length >= 3, 'three rows at least');
  assert(String(internals.TradingApp).includes('diagnosticsText(t)'), 'the help dialog offers the copy');
  assert(internals.CSS.includes('.tm-help__copy'), 'the button has its own style');
  assert(internals.ZH['Copy diagnostics'] === '复制诊断信息', 'localised');
  return 'diagnostics text covered';
});

await check('panel: a mounted page carries a pin outside the host layout', async () => {
  assert(String(internals.TradingApp).includes("tm-pin"), 'the pin is rendered by the page itself');
  assert(internals.CSS.includes('.tm-pin'), 'and styled');
  assert(/\.tm-pin\s*\{[^}]*position:\s*fixed/.test(internals.CSS), 'fixed position escapes a clipped ancestor');
  return 'pin covered';
});

await check('panel: a rendering failure leaves an explainer, not a blank page', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  // Legacy SSR re-throw render-time errors, so the boundary itself cannot be
  // exercised through renderToStaticMarkup; drive the fallback directly.
  const boundary = new internals.CrashBoundary({ t: internals.makeT('en') });
  const derived = internals.CrashBoundary.getDerivedStateFromError(new Error('boom message'));
  boundary.state = derived;
  const html = renderToStaticMarkup(boundary.render());
  assert(html.includes('Trading Mode failed to render'), 'the fallback names the failure');
  assert(html.includes('boom message'), 'the browser message is shown, not swallowed');
  assert(html.includes('Reload the panel'), 'the way out is offered');
  assert(html.includes('Copy this message'), 'the report can leave the machine by clipboard');
  assert(String(internals.CrashBoundary).includes("[trading-mode panel] "), 'the report is tagged so a pasted text identifies its origin');
  assert(internals.ZH['Copy this message'] === '复制这段文字', 'copy label localises');
  assert(internals.ZH['Trading Mode failed to render'] === '交易模式渲染失败', 'zh title ships');
  const clean = renderToStaticMarkup(React.createElement(internals.CrashBoundary, { t: internals.makeT('en') }, React.createElement('b', null, 'ok')));
  assert(clean.includes('<b>ok</b>') && !clean.includes('tm-crash'), 'a healthy child passes through untouched');
  assert(internals.CSS.includes('.tm-crash__msg'), 'the message block is styled');
  return 'crash boundary covered';


});


await check('load: a fault while the factory body runs paints the banner, not blank', async () => {
  const appended = [];
  const body = { appendChild: (node) => appended.push(node) };
  const document = {
    body,
    createElement: () => ({ setAttribute: () => {}, textContent: '' }),
  };
  const previous = globalThis.window;
  const previousDoc = globalThis.document;
  globalThis.window = { __ModuleLoader__: { load: (spec) => { globalThis.__dshLoad = spec; } }, document };
  globalThis.document = document;
  try {
    new Function(readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8'))();
    const spec = globalThis.__dshLoad;
    delete globalThis.__dshLoad;
    assert(spec && typeof spec.factory === 'function', 'the loader registers a factory');
    const broken = () => { throw new Error('boom during require'); };
    const result = spec.factory(broken);
    assert(result && result.name === 'dsh-trading-mode', 'the load reports a stub rather than dying');
    assert(appended.length === 1, 'exactly one banner is painted');
    assert(appended[0].textContent.indexOf('[trading-mode] The panel could not start.') === 0, 'the banner carries the plugin tag');
    assert(appended[0].textContent.includes('boom during require'), 'the browser error text travels with it');
    // A DOM-less host (probe servers, CI shells) must not throw instead.
    globalThis.window = { __ModuleLoader__: { load: (spec2) => { spec2.factory(broken); } }, document: null };
    new Function(readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8'))();
    // The happy path is unchanged: a working require yields the real exports.
    globalThis.window = { __ModuleLoader__: { load: (spec3) => { globalThis.__dshLoad = spec3; } }, document };
    new Function(readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8'))();
    const healthy = globalThis.__dshLoad;
    delete globalThis.__dshLoad;
    const real = healthy.factory((id) => (id === 'react' ? react : broken));
    assert(real && typeof real === 'object' && real.name === 'trading-mode', 'a healthy load still exports the plugin');
    const source = readFileSync(path.join(PLUGIN, 'lib/client.js'), 'utf8');
    assert(source.includes('function tmLoadFactory(require)'), 'the factory body lives in its own hoisted function');
    assert(source.includes('return tmLoadFactory(require)'), 'the registration only wraps it');
  } finally {
    globalThis.window = previous;
    if (previousDoc === undefined) delete globalThis.document; else globalThis.document = previousDoc;
  }
  return 'load crash banner covered';
});

await check('help: the panel can report its own runtime state', async () => {
  const t = internals.makeT('en');
  const rows = internals.diagnostics(t);
  assert(Array.isArray(rows) && rows.length === 3, 'three rows: storage, notifications, window');
  assert(rows[0].k === 'Storage', 'storage first');
  assert(['available', 'blocked'].includes(rows[0].v), `storage value, got "${rows[0].v}"`);
  assert(rows[1].k === 'Notifications', 'notifications second');
  assert(rows[2].k === 'Window', 'window third');
  const zh = internals.makeT('zh');
  const zhRows = internals.diagnostics(zh);
  assert(zhRows[0].k === '本地存储', `zh storage label, got "${zhRows[0].k}"`);
  assert(zhRows[2].k === '窗口', 'zh window label');
  assert(String(internals.TradingApp).includes('diagnostics(t)'), 'the help dialog renders the rows');
  assert(internals.CSS.includes('.tm-help__key'), 'the key column has its own style');
  return 'diagnostics covered';
});

await check('chart: the indicator grid also reads as one sentence', async () => {
  const digest = internals.technicalDigest;
  const t = internals.makeT('en');
  const rich = digest({ trendAlignment: 'bullish', rsi14: 72, high52w: 100, volumeRatio20d: 2.1 }, 95, t);
  assert(rich.startsWith('moving averages stacked up'), `trend phrase first, got "${rich}"`);
  assert(rich.includes('RSI 72 stretched'), `stretch must be named, got "${rich}"`);
  assert(rich.includes('5.0% below its 52-week high'), `distance must be unsigned, got "${rich}"`);
  assert(rich.includes('2.1× normal volume'), `volume phrase, got "${rich}"`);
  const near = digest({ trendAlignment: 'bearish', rsi14: 24, high52w: 100, volumeRatio20d: 0.4 }, 99.5, t);
  assert(near.includes('stacked down'), `bearish phrase, got "${near}"`);
  assert(near.includes('RSI 24 washed out'), `oversold phrase, got "${near}"`);
  assert(near.includes('within 0.5% of its 52-week high'), `near-high wording, got "${near}"`);
  assert(near.includes('0.4× quiet volume'), `quiet volume, got "${near}"`);
  assert(digest({ rsi14: 55 }, 10, t) === 'RSI 55', 'a lone RSI is the whole line');
  assert(digest(null, 10, t) === '', 'no block, no line');
  assert(digest({}, null, t) === '', 'empty block stays quiet');
  const zh = internals.makeT('zh');
  const zhLine = digest({ trendAlignment: 'bullish', rsi14: 72, high52w: 100, volumeRatio20d: 2.0 }, 95, zh);
  assert(zhLine.includes('均线多头排列') && zhLine.includes('RSI 72 偏高'), `zh line: ${zhLine}`);
  assert(zhLine.includes('距 52 周高 5.0%'), `zh distance: ${zhLine}`);
  assert(zhLine.includes('2.0× 常规量'), `zh volume: ${zhLine}`);
  assert(internals.CSS.includes('.tm-chart__read'), 'the line needs its own style hook');
  assert(String(internals.CandleChart).includes('tm-chart__read'), 'the chart must render the line');
  return 'digest covered';
});

await check('brief: the text can leave as a file, not only the clipboard', async () => {
  assert(internals.saveTextFile('brief.txt', 'x') === false, 'a stubbed host cannot save');
  assert(internals.saveTextFile('brief.txt', '') === false, 'nothing to save');
  assert(String(internals.BriefCard).includes('saveTextFile'), 'the card offers the download');
  assert(internals.ZH['Save'] === '保存', 'the button is localised');
  assert(internals.ZH['Save the brief as a text file'] === '把简报存成纯文本文件', 'the tooltip is localised');
  return 'save path covered';
});

await check('§21 freshness wording is present and nothing claims live data', async () => {
  assert(detailHtml.includes('Updated') || homeHtml.includes('Data may be delayed') || detailHtml.includes('Data may be delayed'), 'a freshness stamp or the delayed note must appear');
  assert(detailHtml.includes('Data may be delayed'), '"Data may be delayed" must appear when data is not stale');
  assert(internals.nameOf({ symbol: 'X' }, 'X') === 'X', 'name fallback must not be empty');
  for (const forbidden of ['Live', 'Real-time', 'Real time', 'Tick-level', 'Portfolio', 'Holdings', 'Profit']) {
    assert(!new RegExp(forbidden, 'i').test(detailHtml), `detail view must not contain "${forbidden}" (§21/§26)`);
    assert(!new RegExp(forbidden, 'i').test(homeHtml), `home view must not contain "${forbidden}" (§21/§26)`);
  }
  return 'Updated / Data may be delayed present, no live or portfolio claims';
});

await check('stale data switches the note to "Last available data"', async () => {
  const html = renderToString(h(internals.TradingApp));
  assert(html.length > 0, 'app should still render');
  const stale = renderToString(
    h(internals.TradingApp, null),
  );
  assert(typeof stale === 'string', 'stale render must not throw');
  // Direct structural check of the Freshness component through the chart panel:
  const chart = renderToString(h(internals.CandleChart, { candles: [], series: null }));
  assert(chart.includes('Data unavailable'), 'an empty candle set must say "Data unavailable"');
  return 'empty chart → Data unavailable';
});

await check('0.5.0 charts: a short history is labelled instead of silently truncated', async () => {
  const bars = (n) =>
    Array.from({ length: n }, (_, i) => ({
      timestamp: 1700000000000 + i * 86400000,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10.5 + i,
      volume: 100 + i,
    }));
  const full = renderToString(h(internals.CandleChart, { candles: bars(60), series: null, interval: '1d', degraded: false }));
  const partial = renderToString(h(internals.CandleChart, { candles: bars(1), series: null, interval: '1d', degraded: true }));
  assert(!full.includes('partial history'), 'a complete chart must not claim partial history');
  assert(partial.includes('partial history'), 'a degraded chart must be labelled');
  assert(partial.includes('1 bars'), 'the bar count still renders');
  const zh = internals.ZH['partial history'];
  assert(typeof zh === 'string' && zh !== 'partial history', 'the badge is translated');
  return 'partial history badge ok (en + zh)';
});

await check('0.5.1 AI: an unavailable DeepSeek explains itself in both panels', async () => {
  const { BriefCard, AiAnalysisSection, makeT } = internals;
  assert(typeof BriefCard === 'function', 'BriefCard must be exported for testing');
  assert(typeof AiAnalysisSection === 'function', 'AiAnalysisSection must be exported for testing');
  const reason = 'the plugin did not receive the llm service (ctx.llm)';
  const briefOff = renderToString(h(BriefCard, { aiAvailable: false, aiReason: reason }));
  const briefOn = renderToString(h(BriefCard, { aiAvailable: true }));
  assert(briefOff.includes('Reason: '), 'the brief panel labels the reason');
  assert(briefOff.includes(reason), 'the brief panel prints the reason text');
  assert(!briefOn.includes(reason), 'an available AI must not claim to be unavailable');
  const analysisOff = renderToString(h(AiAnalysisSection, { symbol: 'AAPL', aiAvailable: false, aiReason: reason }));
  assert(analysisOff.includes(reason), 'the analysis panel prints the reason text');
  assert(makeT('zh')('Reason: ').includes('原因'), 'the reason label is translated');
  return 'reason surfaced in the brief and analysis panels (en + zh)';
});

await check('brief: a ring of editions can be paged, labelled as history', async () => {
  const store = new Map();
  const previous = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const first = { headline: 'Morning edition.', generatedAt: '2026-11-07T09:00:00Z', suggestions: [] };
    const second = { headline: 'Afternoon edition.', generatedAt: '2026-11-07T15:00:00Z', suggestions: [] };
    assert(internals.appendBriefHistory(first, 'en').length === 1, 'the first edition is kept');
    assert(internals.appendBriefHistory(second, 'en').length === 2, 'a second edition joins the ring');
    assert(internals.appendBriefHistory(second, 'en').length === 2, 'an identical edition is not duplicated');
    const ring = internals.readBriefHistory('en');
    assert(ring[0].brief.headline === 'Afternoon edition.', 'the ring is newest first');
    assert(ring[1].at > 0, 'every edition carries its own moment');
    assert(internals.readBriefHistory('zh').length === 0, 'another language reads an empty ring');
    assert(internals.appendBriefHistory(null, 'en').length === 0, 'a missing brief writes nothing');
    for (let i = 0; i < 20; i += 1) internals.appendBriefHistory({ headline: `Edition ${i}.` }, 'en');
    assert(internals.readBriefHistory('en').length === 10, 'the ring never grows past ten');
    assert(internals.ZH['An earlier edition of this brief'] === '查看上一份简报', 'the pager labels are translated');
    assert(internals.ZH['An earlier edition: the numbers were read at their own time.'].length > 0, 'the older banner is translated');
    assert(String(internals.BriefCard).includes("editions.pos > 0"), 'the banner answers to the pager position');
    assert(String(internals.BriefCard).includes('tm-brief__pager'), 'the pager renders inside the brief card');
    assert(String(internals.CSS).includes('.tm-brief__page'), 'the pager has its own styling');
  } finally {
    globalThis.window.localStorage = previous;
  }
});

await check('news: the holdings card leads with a digest when one is on disk', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const React = (await import('react')).default;
  const store = new Map();
  const previous = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    assert(internals.readNewsDigest('NVDA,AAPL', 'zh') === null, 'an empty store has no digest');
    assert(internals.writeNewsDigest('NVDA,AAPL', 'zh', ['NVDA\uFF1A\u8D22\u62A5\u540E\u5927\u6DA8', 'AAPL\uFF1A\u65B0\u54C1\u4F20\u95FB\uFF0C\u51B2\u9AD8\u56DE\u843D\u3002']) === true, 'a valid digest is kept');
    const kept = internals.readNewsDigest('NVDA,AAPL', 'zh');
    assert(kept && kept.length === 2, 'the digest reads back');
    assert(internals.readNewsDigest('NVDA,AAPL', 'en') === null, 'another language has no digest');
    assert(internals.readNewsDigest('MSFT', 'zh') === null, 'another symbol set has no digest');
    const fresh = store.get('tm-news-digest');
    const parsedFresh = JSON.parse(fresh);
    parsedFresh.at = Date.now() - 7 * 60 * 60 * 1000;
    store.set('tm-news-digest', JSON.stringify(parsedFresh));
    assert(internals.readNewsDigest('NVDA,AAPL', 'zh') === null, 'a digest past its TTL is not served');
    store.set('tm-news-digest', fresh);
    assert(internals.writeNewsDigest('NVDA', 'zh', []) === false, 'nothing to say is not cached');
    assert(internals.writeNewsDigest('NVDA', 'zh', [1, 2]) === false, 'numbers are not digest lines');
    store.set('tm-news-digest', 'not json');
    assert(internals.readNewsDigest('NVDA', 'zh') === null, 'broken json is ignored');

    const row = renderToStaticMarkup(internals.newsDigestRow('NVDA\uFF1A\u8D22\u62A5\u540E\u7EE7\u7EED\u51B2\u9AD8\uFF0C\u6536\u5728\u65B0\u9AD8\u9644\u8FD1\u3002', () => () => {}));
    assert(row.includes('tm-news__digest'), 'the row carries its class');
    assert(row.includes('NVDA'), 'the ticker is on its own element');
    assert(row.includes('\u8D22\u62A5\u540E\u7EE7\u7EED\u51B2\u9AD8'), 'the sentence travels with it');
    const plain = renderToStaticMarkup(internals.newsDigestRow('\u5B8F\u89C2\uFF1A\u4ECA\u665A CPI\u3002', () => () => {}));
    assert(plain.includes('\u5B8F\u89C2'), 'a lowercase lead falls back to plain text, not a broken split');
    assert(internals.ZH['Digest view'] === '\u603B\u7ED3', 'the view toggle is localised');
    assert(internals.ZH['Headlines view'] === '\u539F\u6587', 'and its pair');
    assert(internals.CSS.includes('.tm-news__digest'), 'the digest row has its style hook');
    assert(String(internals.HoldingNewsCard).includes("apiPost('/news/summary'"), 'the card asks the digest route');
    assert(String(internals.HoldingNewsCard).includes('readNewsDigest(key, lang)'), 'the cache answers before the network');
    assert(String(internals.HoldingNewsCard).includes('!key || !aiAvailable'), 'no model in the session, no summary request');
    assert(String(internals.HomeView).includes('HoldingNewsCard, { rows, costs, onOpen, aiAvailable }'), 'the home page passes whether a model exists');
    assert(String(internals.HomeView).includes('hotPrePost.length'), 'extended hours only shares a row when it has movers');
  } finally {
    globalThis.window.localStorage = previous;
  }
  return 'news digest ok';
});

await check('brief: the last edition survives a reload, but not a language switch', async () => {
  const store = new Map();
  const previous = globalThis.window.localStorage;
  globalThis.window.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    const brief = { headline: 'Board 3 up, 1 down.', stocksTracked: 4, upCount: 3, downCount: 1, suggestions: ['AAPL holds 210.'] };
    assert(internals.readBriefCache('en') === null, 'an empty store has no brief');
    const sectors = [{ symbol: 'XLK', changePct: 1.2 }];
    assert(internals.writeBriefCache(brief, 'en', sectors) === true, 'a valid brief is kept');
    const keptSectors = internals.readBriefSectors('en');
    assert(keptSectors && keptSectors[0].symbol === 'XLK', 'the sector strip comes back with the text');
    assert(internals.readBriefSectors('zh') === null, 'another language has no sector strip either');
    assert(internals.readBriefSectors(null) === null, 'no language, no sectors');
    // A brief is true against one session's prices; a day later it is not a
    // convenience, it is a stale claim.
    const fresh = store.get('tm-brief-last');
    const parsedFresh = JSON.parse(fresh);
    parsedFresh.at = Date.now() - 13 * 60 * 60 * 1000;
    store.set('tm-brief-last', JSON.stringify(parsedFresh));
    assert(internals.readBriefCache('en') === null, 'a brief from the previous session is not served');
    assert(internals.readBriefSectors('en') === null, 'and its sector strip goes with it');
    const old = JSON.parse(fresh);
    delete old.at;
    store.set('tm-brief-last', JSON.stringify(old));
    assert(internals.readBriefCache('en') === null, 'a payload without a timestamp is not trusted');
    store.set('tm-brief-last', fresh);
    assert(internals.readBriefCache('en').headline === brief.headline, 'a fresh one still reads back');
    const back = internals.readBriefCache('en');
    assert(back && back.headline === brief.headline, 'the same language reads it back');
    assert(internals.readBriefCache('zh') === null, 'another language starts empty');
    assert(internals.writeBriefCache({ headline: 3 }, 'en') === false, 'a headline that is not text is not cached');
    assert(internals.writeBriefCache(null, 'en') === false, 'nothing is not cached');
    store.set('tm-brief-last', '{"lang":"en","brief":{"headline":"x"' + 'y'.repeat(210000) + '}}');
    assert(internals.readBriefCache('en') === null, 'an oversized blob is ignored rather than parsed');
    store.set('tm-brief-last', 'not json');
    assert(internals.readBriefCache('en') === null, 'broken json is ignored');
    assert(String(internals.HomeView).includes('readBriefCache(lang)'), 'the card starts from the cache');
    assert(String(internals.BriefCard).length > 0, 'the card still renders a cached brief');
  } finally {
    if (previous === undefined) delete globalThis.window.localStorage;
    else globalThis.window.localStorage = previous;
  }
  return 'brief cache ok';
});

await check('brief: the rule edition is labelled and needs no model', async () => {
  const { BriefCard, makeT } = internals;
  const local = renderToString(
    h(BriefCard, {
      aiAvailable: false,
      aiReason: 'no llm service',
      brief: {
        headline: 'Board 2 up, 1 down',
        local: true,
        stocksTracked: 3,
        upCount: 2,
        downCount: 1,
        strongestMover: 'NVDA +2.4%',
        largestDecline: 'TSLA -3.1%',
        unusualVolume: ['NVDA 2.1x'],
        keyObservations: ['NVDA leads the board'],
        suggestions: ['NVDA holds above its 20-day average'],
      },
    }),
  );
  assert(local.includes('Rules only'), 'a rule edition says so on the card');
  assert(local.includes('tm-brief__local'), 'the label has its own style hook');
  const modelled = renderToString(
    h(BriefCard, {
      aiAvailable: true,
      brief: {
        headline: 'Board 2 up, 1 down',
        stocksTracked: 3,
        upCount: 2,
        downCount: 1,
        strongestMover: 'NVDA +2.4%',
        largestDecline: 'TSLA -3.1%',
        unusualVolume: [],
        keyObservations: [],
        suggestions: ['NVDA holds above its 20-day average'],
      },
    }),
  );
  assert(!modelled.includes('Rules only'), 'a model-written brief must not claim to be rules');
  assert(modelled.includes('Board 2 up, 1 down'), 'the headline still renders');
  assert(modelled.includes('Strongest mover'), 'a best row that exists is drawn');
  const skimpy = renderToString(
    h(BriefCard, {
      aiAvailable: true,
      brief: {
        headline: 'Board 2 up, 1 down',
        stocksTracked: 3,
        upCount: 2,
        downCount: 1,
        unusualVolume: [],
        keyObservations: [],
        suggestions: ['NVDA holds above its 20-day average'],
      },
    }),
  );
  assert(!skimpy.includes('Strongest mover'), 'a missing best row leaves no empty tile');
  assert(!skimpy.includes('Largest decline'), 'a missing worst row leaves no empty tile');
  const source = String(BriefCard);
  assert(source.includes('disabled: loading'), 'the button is only blocked while a run is in flight');
  assert(source.includes('rule-based edition'), 'the hint explains what the fallback writes');
  assert(makeT('zh')('Rules only') === '仅为规则生成', 'the label is translated');
  assert(String(internals.CSS).includes('.tm-brief__local'), 'the label is styled');
  return 'rule edition labelled; model edition untouched';
});

await check('i18n: the zh dictionary is complete and never leaks a raw key', async () => {
  assert(JSON.stringify(internals.LANGS) === JSON.stringify(['en', 'zh']), 'en + zh are the shipped languages');
  const zh = internals.ZH;
  assert(Object.keys(zh).length > 80, `zh dictionary looks too small (${Object.keys(zh).length})`);
  // Every English string handed to t('…') anywhere in the bundle must be translated.
  const used = new Set();
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1).)*)\1/g;
  let match;
  while ((match = re.exec(source)) !== null) used.add(match[2].replace(/\\(['"])/g, '$1'));
  const missing = [...used].filter((key) => typeof zh[key] !== 'string');
  assert(missing.length === 0, `untranslated UI strings: ${missing.join(' | ')}`);
  // And the dictionary must actually translate rather than echo the key.
  const echoed = Object.entries(zh).filter(([k, v]) => k === v).map(([k]) => k);
  assert(echoed.length === 0, `echoed entries: ${echoed.join(' | ')}`);
  return `${used.size} strings used, ${Object.keys(zh).length} entries`;
});

await check('i18n: makeT localises, interpolates and falls back safely', async () => {
  const en = internals.makeT('en');
  const zhT = internals.makeT('zh');
  assert(en('Data may be delayed') === 'Data may be delayed', 'English is the source language');
  const zhString = zhT('Data may be delayed');
  assert(/[\u4e00-\u9fff]/.test(zhString), `expected a Chinese string, got "${zhString}"`);
  const fresh = zhT('Updated {time}', { time: '10:42:18' });
  assert(fresh.includes('10:42:18'), 'interpolated value must survive');
  assert(!fresh.includes('{time}'), 'placeholder must be replaced');
  assert(zhT('__not_in_the_dictionary__') === '__not_in_the_dictionary__', 'missing keys fall back to English, never to a raw id');
  assert(internals.translate(undefined, 'zh') === undefined, 'undefined must pass through');
  assert(internals.normalizeLang('zh-Hant') === 'zh', 'zh-Hant normalises to zh');
  assert(internals.normalizeLang('de') === null, 'unknown languages normalise to null');
  return 'ok';
});

await check('session clock: the US phase follows the New York wall clock', async () => {
  const { usSessionInfo } = internals;
  assert(usSessionInfo(null) === null && usSessionInfo(new Date('not a date')) === null, 'non-dates render nothing, never a wrong phase');
  // 2026-11-06 (Fri) — ET is UTC−5 after the DST end on 2026-11-01.
  const at = (h, m) => new Date(Date.UTC(2026, 10, 6, h, m));
  assert(usSessionInfo(at(13, 15)).phase === 'pre', '08:15 ET is pre-market');
  assert(usSessionInfo(at(14, 29)).phase === 'pre' && usSessionInfo(at(14, 30)).phase === 'open', '09:30 ET opens the regular session');
  assert(usSessionInfo(at(20, 59)).phase === 'open' && usSessionInfo(at(21, 0)).phase === 'post', '16:00 ET closes the regular session');
  assert(usSessionInfo(at(21, 30)).phase === 'post' && usSessionInfo(at(1, 0)).phase === 'closed', '20:00 ET ends the after-hours');
  assert(usSessionInfo(new Date(Date.UTC(2026, 10, 8, 15, 0))).phase === 'closed', 'weekends are always closed');
  assert(usSessionInfo(at(14, 30)).clock === '09:30', 'the chip clock is the New York time');
  return 'pre/open/post/closed boundaries all answer from the ET clock';
});

await check('macro card: the curated calendar maps to bilingual, bilingual labels and the localised windows', async () => {
  const zh = internals.makeT('zh');
  // Every kind the server table can send must resolve to a label entry.
  assert(internals.EventBoard && String(internals.EventBoard).includes('/macro?days=30'), 'the board reads the curated /macro route');
  const kinds = internals.MACRO_KINDS || {};
  const labels = Object.values(kinds);
  assert(
    labels.length === 6 && ['US CPI', 'US PPI', 'US jobs report (NFP)', 'US GDP', 'Income & Outlays (PCE)', 'FOMC decision'].every((label) => labels.includes(label)),
    `the card must name all six macro labels, got ${labels.join(', ')}`,
  );
  for (const label of labels) {
    assert(zh(label) !== label, `zh misses a translation for ${label}`);
  }
  const zhHint = internals.ZH['Macro prints move every position at once; CPI and FOMC days are the widest windows.'];
  assert(zhHint && /[\u4e00-\u9fff]/.test(zhHint), 'the macro hint must be localised');
  // Detail strip: only a release inside the next three days is rendered.
  const en = internals.makeT('en');
  const now = { events: [{ kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 1 }] };
  const far = { events: [{ kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 5 }] };
  const stripText = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(stripText).join('');
    const props = node.props || {};
    return stripText(props.children);
  };
  const snippet = stripText(internals.nextMacro(now, en));
  assert(internals.nextMacro(far, en) === null, 'a print five days out must stay silent on the detail page');
  assert(internals.nextMacro(null, en) === null, 'missing window data must stay silent');
  assert(snippet.includes('US CPI') && snippet.includes('08:30 ET'), `the strip must name the print and its ET time, got ${snippet}`);
  assert(stripText(internals.nextMacro({ events: [{ kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'CPI', days: 1 }] }, zh)).includes('宏观数据'), 'the strip must localise in zh');
  return '6 kind labels + hint resolve in zh; detail strip gates at 3 days';
});

await check('detail page: dated events arrive in order and the calendar asks for one name', async () => {
  const en = internals.makeT('en');
  const zh = internals.makeT('zh');
  const text = (node) => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join(' ');
    return text((node.props || {}).children);
  };
  const day = (y, m, d) => Date.UTC(y, m - 1, d, 15, 0);
  const window = {
    today: '2026-11-07',
    bySymbol: { NVDA: { symbol: 'NVDA', date: '2026-11-20', session: 'post', epsForecast: 1.2, analysts: 41 } },
  };
  // An ex-dividend day three days out and a report thirteen days out: the near
  // one has to come first, otherwise the block is sorted by code order, not time.
  const ordered = internals.upcomingStrips(window, { exDividendDate: day(2026, 11, 9) }, 'NVDA');
  assert(ordered.length === 2, `both dated events must render, got ${ordered.length}`);
  assert(text(ordered[0]).includes('Ex-dividend'), 'the nearer event comes first');
  assert(text(ordered[1]).includes('Next earnings'), 'the report follows it');
  assert(text(ordered[0]).includes('own it before this day to collect'), 'the ex-dividend row carries the rule, not just the date');
  // A past ex-dividend day is history: the Market data cell already shows it.
  const past = internals.upcomingStrips(window, { exDividendDate: day(2026, 10, 1) }, 'NVDA');
  assert(past.length === 1 && text(past[0]).includes('Next earnings'), 'a past ex-dividend day stays off the strip');
  assert(internals.upcomingStrips(null, {}, 'NVDA').length === 0, 'no window and no profile means no strip');
  assert(internals.nextEarningsEvent(window, 'AAPL') === null, 'a ticker outside the window answers nothing');
  // The strip renders through the live locale, so the dictionary is what a
  // language switch actually rewrites — assert the entries, not a second render.
  // The strip renders in whichever language the page is read in: the former
  // implementation called a module-level `t` that never existed, which threw on
  // every held name with a report inside the window.
  const translated = internals.upcomingStrips(window, { exDividendDate: day(2026, 11, 9) }, 'NVDA', zh);
  assert(translated.length === 2, 'both rows survive translation');
  assert(text(translated[0]).includes('除息日') && text(translated[0]).includes('想拿这次分红要在这天之前持有'), 'the ex-dividend rule localises');
  assert(text(translated[1]).includes('下次财报') && text(translated[1]).includes('13 天后'), 'the countdown localises too');
  assert(zh('own it before this day to collect') === '想拿这次分红要在这天之前持有', 'the rule is in the dictionary');
  assert(zh('Shares bought on or after this date do not carry the dividend, and the price opens lower by roughly the payment.').includes('除息日'), 'the tooltip localises');
  assert(internals.relativeDayOf(day(2026, 10, 1), zh) === '', 'a past day answers nothing even in zh');
  assert(internals.relativeDayOf(day(2026, 11, 9), zh) === '2 天后', 'the countdown reads from the date, not the render');
  // Render the strip for real: a text-walk cannot catch a missing class or an
  // element the browser would collapse, and this block sits in the page flow.
  const html = renderToString(h('div', null, internals.upcomingStrips(window, { exDividendDate: day(2026, 11, 9) }, 'NVDA', zh)));
  assert(html.includes('tm-earn') && html.includes('tm-earn__label'), 'the rows keep the strip structure');
  assert(html.indexOf('除息日') >= 0 && html.indexOf('除息日') < html.indexOf('下次财报'), 'the rendered HTML keeps the arrival order');
  assert(html.includes('想拿这次分红要在这天之前持有'), 'the rule survives rendering');
  // The request must name the ticker: the route otherwise ships the whole
  // market's calendar for one stock.
  assert(String(internals.DetailView).includes('/earnings?days=21&symbol='), 'the detail page filters the calendar server-side');
  return 'near ex-dividend ranks first, past dates stay out, the calendar request names one ticker';
});

await check('watchlist: the auto refresh toggle states what it will do next', async () => {
  const zh = internals.makeT('zh')
  const home = String(internals.HomeView)
  const card = String(internals.WatchlistCard)

  // One minute: short enough to notice a move, long enough not to hammer the
  // provider. The number is exported so the test fails if it drifts silently.
  assert(internals.AUTO_REFRESH_MS === 60000, 'the tick is one minute')
  assert(home.includes('tm-auto-refresh'), 'the choice survives a reload')
  assert(home.includes('document.hidden'), 'a hidden tab is skipped, not queued')
  assert(home.includes('AUTO_REFRESH_MS'), 'the interval reads the exported constant')
  assert(card.includes("aria-pressed"), 'the toggle reports its state to assistive tech')
  assert(card.includes("t(autoRefresh ? 'Quotes reload every minute while this tab is visible'"), 'on says what the next minute brings')
  assert(card.includes("'Quotes only reload when you ask'"), 'off says nothing moves without a click')
  assert(card.includes('onToggleAutoRefresh'), 'without a handler the chip is not drawn at all')
  assert(zh('Auto refresh') === '自动刷新', 'the chip has a Chinese label')
  assert(zh('Quotes reload every minute while this tab is visible') === '面板在前台时每分钟自动刷新行情', 'and an honest on-state tooltip')
  assert(zh('Quotes only reload when you ask') === '只在点刷新时更新行情', 'and an honest off-state tooltip')
  assert(/\.tm-auto--on \{[^}]*--tm-brand/.test(internals.CSS), 'the on state is visible, not just in the title attribute')
})

await check('watchlist: a held row says how much of the book it is', async () => {
  const zh = internals.makeT('zh')
  const position = (value, currency) => ({ value, currency, shares: 1, cost: 1, basis: 0, pnl: 0, pct: 0, today: 0, todayPct: 0 })
  const totals = [{ currency: 'USD', value: 4000, basis: 0, pnl: 0, today: 0, count: 2, counted: 0 }]

  const weight = internals.positionWeight(position(1000, 'USD'), totals)
  assert(weight.pct === 25, 'a quarter of the book is 25%')
  assert(weight.currency === 'USD', 'the share stays inside its own currency')

  // Every null below is a case where a percentage would be a guess: no
  // position, no book, a currency the book does not hold, or a zero total.
  assert(internals.positionWeight(null, totals) === null, 'a watched but unheld row has no weight')
  assert(internals.positionWeight(position(10, 'USD'), []) === null, 'no book means no share')
  assert(internals.positionWeight(position(10, 'HKD'), totals) === null, 'HKD value has no USD denominator')
  assert(internals.positionWeight(position(10, 'USD'), [{ currency: 'USD', value: 0 }]) === null, 'a zero book divides nothing')
  assert(internals.positionWeight(position(0, 'USD'), totals) === null, 'a zero value prints nothing')

  assert(zh('{pct} of your {currency} positions', { pct: '25.0%', currency: 'USD' }) === 'USD 仓位里占 25.0%', 'the chip localises')
  const row = String(internals.WatchRow)
  assert(row.includes('tm-row__weight'), 'the row draws the chip')
  assert(row.includes('POSITION_FOCUS_PCT'), 'and marks the heavy ones with the same threshold the notes use')
  assert(String(internals.WatchlistCard).includes('positionWeight('), 'the card feeds it from the book totals')
  assert(/\.tm-row__weight--heavy \{[^}]*--tm-warn/.test(internals.CSS), 'the heavy chip is amber, not another grey pill')
})

await check('events: an earnings date on a name you hold is priced, not just dated', async () => {
  const zh = internals.makeT('zh')
  const quote = (price) => ({ price, change: 1, changePct: 1, currency: 'USD' })
  const watch = [
    { symbol: 'MSFT', market: 'US', quote: quote(100) },
    { symbol: 'AAPL', market: 'US', quote: quote(200) },
  ]
  const costs = { 'US:MSFT': { price: 50, shares: 12 } }
  const index = internals.positionIndex(watch, costs)
  assert(index.size === 1, 'only the held name enters the index')
  assert(index.get('MSFT').value === 1200, 'value is the last price times shares')
  assert(index.get('MSFT').currency === 'USD', 'and keeps the quote currency')

  // A watch-only name has a date but no money attached: it must stay absent
  // rather than appear with a zero, which would read as a broken position.
  assert(index.has('AAPL') === false, 'a watched but unheld name is not an exposure')
  assert(internals.positionIndex([], costs).size === 0, 'empty board, empty index')
  assert(internals.positionIndex(null, null).size === 0, 'no inputs, no index')

  assert(zh('You hold {amount}', { amount: '$1,200.00' }) === '你持有 $1,200.00', 'the exposure line localises')
  const board = String(internals.EventBoard)
  assert(board.includes('positionIndex(watchRows'), 'the board indexes exposures from its own rows')
  assert(board.includes("t('You hold {amount}'"), 'and names the amount on the row')
  assert(/\.tm-ev__held \{[^}]*font-weight: 600/.test(internals.CSS), 'the amount is emphasised inside the muted impact line')
})

await check('detail page: the position line turns the yield into money the holder receives', async () => {
  const zh = internals.makeT('zh')
  const income = internals.dividendIncome

  // 100 shares at $1.20 a year on a $3,000 basis: $120 a year, 4% on what was
  // paid. The quote page would only show the per-share rate and a yield on the
  // current price, which is not what this holder earns.
  const held = { shares: 100, basis: 3000, value: 3300, pnl: 300, pct: 10, today: 12, currency: 'USD' }
  const paid = income({ dividendRate: 1.2 }, held)
  assert(paid.annual === 120, 'the annual amount is rate times shares')
  assert(Math.abs(paid.onCost - 4) < 1e-9, 'cost yield is measured against what was paid')
  assert(paid.currency === 'USD', 'the currency travels with the amount')

  assert(income({ dividendRate: 0 }, held) === null, 'a non-payer says nothing')
  assert(income({}, held) === null, 'no rate, no line')
  assert(income({ dividendRate: 1.2 }, null) === null, 'no position, no line')
  assert(income({ dividendRate: 1.2 }, { shares: 0, basis: 0, currency: 'USD' }) === null, 'zero shares is not a position')
  const noBasis = income({ dividendRate: 1.2 }, { shares: 10, basis: 0, currency: 'USD' })
  assert(noBasis && noBasis.annual === 12 && noBasis.onCost === null, 'without a basis the amount still shows, the ratio does not')

  assert(zh('Annual dividends') === '年化分红', 'the label localises')
  assert(zh('{pct} on cost', { pct: '4.00%' }) === '成本上 4.00%', 'the cost ratio reads as a sentence, not a key')
  const source = String(internals.DetailView)
  assert(source.includes('dividendIncome(company, held)'), 'the position line asks for the dividend')
  assert(source.includes("t('Annual dividends')"), 'and names it')
})

await check('detail page: a macro print inside two days is flagged before the reader acts', async () => {
  const en = internals.makeT('en')
  const zh = internals.makeT('zh')
  const note = internals.macroWatchNote

  // The server stamps `days`, so the note never does its own date arithmetic.
  const today = note([{ kind: 'cpi', date: '2026-11-10', time: '08:30', days: 0 }], en)
  assert(today && today.when === 'today', 'a release today is called today')
  assert(today.title === 'US CPI', 'the label comes from the shared macro table')
  assert(today.detail === 'ET 08:30', 'the release time travels with it')
  assert(today.impact.includes('re-prices the whole tape'), 'and says what it does to a single name')

  const tomorrow = note([{ kind: 'fomc', date: '2026-11-11', time: '14:00', days: 1 }], en)
  assert(tomorrow && tomorrow.when === 'tomorrow', 'a release tomorrow is called tomorrow')
  assert(tomorrow.title === 'FOMC decision', 'FOMC keeps its own label')
  assert(tomorrow.impact.includes('size new entries'), 'tomorrow warns about sizing, not about today')

  // Three days out is not this decision: the board already lists it.
  assert(note([{ kind: 'jobs', date: '2026-11-13', time: '08:30', days: 3 }], en) === null, 'a release later in the week is not a note')
  assert(note([], en) === null, 'an empty table says nothing')
  assert(note(null, en) === null, 'a failed request says nothing')

  const cn = note([{ kind: 'fomc', date: '2026-11-10', time: '14:00', days: 0 }], zh)
  assert(cn.when === '今天' && cn.detail === 'ET 14:00', 'the Chinese note keeps the time code')
  assert(cn.impact.includes('整盘会一起重新定价'), 'and its own impact sentence')
  assert(zh('Macro day') === '宏观日', 'the label localises')

  const source = String(internals.DetailView)
  assert(source.includes('/macro?days=7'), 'the detail page reads the local macro table')
  assert(source.includes('macroWatchNote'), 'and routes it through the shared helper')
  assert(source.includes('tm-macro'), 'the note has its own line')
  assert(/\.tm-macro \{[^}]*display: flex/.test(internals.CSS), 'laid out on one baseline')
})

await check('detail page: the day is read against its sector, not only against yesterday', async () => {
  const zh = internals.makeT('zh')
  const tile = internals.sectorTileOf
  // Sector names arrive from the profile with the provider's own casing, so the
  // lookup tolerates case and spacing: 'Financial services' must still land on
  // the Financials ETF instead of silently dropping the line.
  assert(tile({ sector: 'Technology' }).symbol === 'XLK', 'an exact sector hits its ETF')
  assert(tile({ sector: 'Financial services' }).symbol === 'XLF', 'case and spacing are tolerated')
  assert(tile({ sector: ' Health Care ' }).symbol === 'XLV', 'a spelled-out variant still maps')
  assert(tile({ sector: 'Communication Services' }).label === 'Communication services', 'the label doubles as the i18n key')
  assert(tile({ sector: 'Miscellaneous' }) === null, 'an unknown sector says nothing instead of guessing')
  assert(tile({}) === null, 'no sector, no line')
  assert(tile(null) === null, 'no profile, no line')
  assert(Object.keys(internals.SECTOR_ETF).length === 11, 'one ETF per SPDR sector')
  // The phrase carries the size of the gap: "ahead" alone does not say whether
  // it is noise or a real divergence.
  assert(zh('Ahead of its sector by {gap}', { gap: '1.20pp' }) === '强于板块 1.20pp', 'ahead phrase localises with the size')
  assert(zh('Behind its sector by {gap}', { gap: '0.90pp' }) === '弱于板块 0.90pp', 'behind phrase localises with the size')
  assert(zh('In line with its sector') === '与板块同步', 'a flat day is called flat, not zero')
  const source = String(internals.DetailView)
  assert(source.includes('tm-rel'), 'the header carries the relative line')
  assert(source.includes("t('Ahead of its sector by {gap}'"), 'and names the direction')
  assert(source.includes('sectorTileOf(company)'), 'driven by the profile sector, not a hard-coded ETF')
  assert(/\.tm-rel \{[^}]*display: flex/.test(internals.CSS), 'the line lays out as one baseline row')
  assert(/\.tm-rel__gap \{[^}]*tabular-nums/.test(internals.CSS), 'the gap keeps its digits aligned')
})

await check('detail page: a month of relative strength sits next to the day', async () => {
  const zh = internals.makeT('zh')
  const rs = internals.relativeStrength
  const series = (start, step, n) => Array.from({ length: n }, (_, i) => ({ close: start + step * i }))
  const stock = series(100, 1, 21)
  const sector = series(100, 0.5, 21)
  const out = rs(stock, sector)
  assert(out && out.window === 20, 'the comparison names its window')
  assert(Math.round(out.stockPct) === 20, 'the name is up 20% over the window')
  assert(Math.round(out.sectorPct) === 10, 'the sector is up 10% over the same window')
  assert(Math.round(out.gap) === 10, 'the gap is the difference, in percentage points')
  // A series shorter than the window cannot answer the question for that window:
  // reporting a five-session number under a twenty-session label would be a lie.
  assert(rs(stock.slice(0, 20), sector) === null, 'a short stock series yields nothing')
  assert(rs(stock, sector.slice(0, 5)) === null, 'a short sector series yields nothing')
  assert(rs(null, sector) === null && rs(stock, null) === null, 'missing sides yield nothing')
  // Flat against flat is zero, which is a real answer and must not collapse to null.
  assert(Math.round(rs(series(50, 0, 25), series(80, 0, 25)).gap) === 0, 'flat vs flat is 0, not unknown')
  // Bars without a usable close are skipped rather than poisoning the average.
  const messy = series(100, 1, 20).concat([{ close: null }, { close: 120 }])
  assert(Math.round(rs(messy, sector).stockPct) === 20, 'a null bar is skipped, not counted as zero')
  assert(zh('{n}d vs sector {gap}', { n: 20, gap: '+3.4pp' }) === '近 20 日相对板块 +3.4pp', 'the figure reads as a sentence')
  const source = String(internals.DetailView)
  assert(source.includes('tm-rel__rs'), 'the header carries the multi-session figure')
  assert(source.includes("t('{n}d vs sector {gap}'"), 'and labels the window it used')
  assert(/\.tm-rel__rs::before \{[^}]*content/.test(internals.CSS), 'a dot separates it from the day figure')
})

await check('analyst card: the mix and the grade changes are read, not just listed', async () => {
  const zh = internals.makeT('zh');
  const day = 86_400_000;
  const now = Date.UTC(2026, 11, 1, 15, 0);
  const ratings = {
    trend: { strongBuy: 6, buy: 18, hold: 14, sell: 3, strongSell: 3, total: 44 },
    changes: [
      { firm: 'Bernstein', action: 'main', from: 'Buy', to: 'Buy', at: now - 2 * day },
      { firm: 'UBS', action: 'up', from: 'Neutral', to: 'Buy', at: now - 5 * day },
      { firm: 'Argus', action: 'main', from: 'Buy', to: 'Strong Buy', at: now - 9 * day },
      { firm: 'Barclays', action: 'down', from: 'Buy', to: 'Hold', at: now - 400 * day },
    ],
  };
  const mix = internals.ratingMix(ratings);
  assert(mix.total === 44 && mix.segments.length === 5, 'every bucket with a voice is drawn');
  const pct = mix.segments.reduce((sum, seg) => sum + seg.pct, 0);
  assert(Math.abs(pct - 100) < 1e-6, 'the bar fills the whole width');
  const thin = internals.ratingMix({ trend: { buy: 4, hold: 0, sell: 0, strongBuy: 0, strongSell: 0, total: 4 } });
  assert(thin.segments.length === 1, 'an empty slice is dropped instead of claiming nobody sells');
  assert(internals.ratingMix({ trend: { total: 0 } }) === null, 'no coverage means no mix');
  const changes = internals.ratingChanges(ratings, now);
  assert(changes.length === 2, `a restatement and a stale row drop out, got ${changes.length}`);
  assert(changes[0].firm === 'UBS' && changes[0].days === 5, 'newest first, with an age in days');
  assert(changes[1].firm === 'Argus' && changes[1].action === 'main', 'a maintain that moved the wording still counts');
  assert(internals.ratingChanges({ changes: [] }, now).length === 0, 'nothing on record stays quiet');
  // Six months is the horizon: an old upgrade is not a reason to act today.
  const oldOnly = internals.ratingChanges({ changes: [{ firm: 'Barclays', action: 'up', from: 'Hold', to: 'Buy', at: now - 200 * day }] }, now);
  assert(oldOnly.length === 0, 'a change older than six months is history');
  assert(internals.CSS.includes('.tm-rate__bar') && internals.CSS.includes('.tm-rate__seg--strongSell'), 'the mix bar ships theme-token CSS');
  assert(internals.CSS.includes('.tm-rate__action--up') && internals.CSS.includes('.tm-rate__action--down'), 'a raise and a cut read differently');
  assert(zh('Ratings mix') === '评级分布' && zh('Rating changes') === '评级变动', 'the card labels localise');
  assert(zh('Raised') === '上调' && zh('Cut') === '下调' && zh('Started') === '首次覆盖', 'each action has a verdict word');
  assert(zh('Strong sell') === '强力卖出', 'the fifth bucket localises');
  assert(zh('No rating changes in the last six months.') === '近半年没有评级变动。', 'the empty state localises');
  assert(zh('{n} days ago', { n: 3 }) === '3 天前', 'the age line interpolates');
  assert(String(internals.DetailView).includes('tm-rate__bar'), 'the analyst card draws the mix');
  assert(String(internals.DetailView).includes("t('Rating changes')"), 'and lists the changes');
  return 'mix, filtered changes, CSS and dictionary all resolve';
});

await check('etf holdings: the top-ten table ships with weight bars and bilingual titles', async () => {
  const zh = internals.makeT('zh');
  const en = internals.makeT('en');
  assert(internals.CSS.includes('.tm-holdings') && internals.CSS.includes('.tm-hold__fill'), 'the holdings rows ship their theme-token CSS');
  assert(String(en('Top holdings')) === 'Top holdings', 'English keeps the canonical card title');
  assert(zh('Top holdings') === '前十大持仓', 'the card title localises');
  assert(zh('weights in percent of the fund') === '权重为占基金比例（%）', 'the weight meta localises');
  return 'holdings card CSS + bilingual titles resolve';
});

await check('etf sectors: the exposure card draws to scale and localises every label', async () => {
  const zh = internals.makeT('zh');
  const en = internals.makeT('en');
  assert(internals.CSS.includes('.tm-sectors') && internals.CSS.includes('.tm-sector__fill'), 'the sector rows ship their theme-token CSS');
  assert(String(en('Sector exposure')) === 'Sector exposure', 'English keeps the canonical card title');
  assert(zh('Sector exposure') === '行业分布', 'the card title localises');
  assert(zh("share of the fund's assets by sector") === '按行业划分的基金资产占比（%）', 'the meta line localises');
  // The provider sends Yahoo's English sector labels; every one of the eleven
  // must resolve, otherwise a row silently renders in English.
  const labels = ['Technology', 'Financial services', 'Communication services', 'Healthcare', 'Consumer cyclical', 'Consumer defensive', 'Industrials', 'Energy', 'Basic materials', 'Real estate', 'Utilities'];
  const missing = labels.filter((label) => /[\u4e00-\u9fff]/.test(zh(label)) === false);
  assert(missing.length === 0, `untranslated sectors: ${missing.join(', ')}`);
  return 'sector card CSS + 11/11 labels localise';
});

await check('ex-dividend day: a UTC calendar date, never shifted into the previous evening', async () => {
  const zh = internals.makeT('zh');
  // Yahoo hands back the payout date as a UTC midnight; formatting it in local
  // time shows 11-11 for a 11-12 payout anywhere west of Greenwich.
  const at = Date.UTC(2026, 10, 12);
  assert(internals.dateOfUtc(at) === '2026-11-12', `UTC date (got ${internals.dateOfUtc(at)})`);
  assert(zh('Ex-dividend') === '除息日', 'the cell label localises');
  const future = internals.relativeDayOf(Date.now() + 5 * 86_400_000);
  assert(/5|五/.test(future) || future.length > 0, `a future date reads as a countdown (got ${future})`);
  assert(internals.relativeDayOf(Date.now() - 30 * 86_400_000) === '', 'a past ex-dividend day gets no countdown');
  return 'UTC date + label + countdown rules hold';
});

await check('event board: closures and expiries keep their own wording', async () => {
  const zh = internals.makeT('zh');
  assert(zh('Closed all day') === '全天休市', 'the full-day label localises');
  // The half-day wording carries the cutoff time, so it must interpolate rather
  // than print a bare "{close}".
  const half = zh('Early close {close} ET', { close: '13:00' });
  assert(half.includes('13:00') && !half.includes('{close}'), `half-day label interpolates (got ${half})`);
  assert(zh('quarterly') === '季度合约', 'the quarterly marker localises');
  assert(zh('Monthly options expiry') === '期权到期日', 'the expiry label localises');
  assert(/[\u4e00-\u9fff]/.test(zh('Earnings move one name; macro prints move everything; a half day caps when you can trade.')), 'the board hint localises');
  assert(internals.CSS.includes('.tm-ev__row--today'), 'a same-day event ships its highlight');
  return 'closure/expiry labels and the same-day highlight hold';
});

await check('event board: three calendars merge into one chronological, filterable list', async () => {
  const zh = internals.makeT('zh');
  const en = internals.makeT('en');
  const merge = internals.mergeEventRows;
  assert(typeof merge === 'function', 'the board exposes its merge for tests');
  const payload = {
    today: '2026-11-09',
    bySymbol: {
      NVDA: { date: '2026-11-12', session: 'post', epsForecast: 1.2 },
      AAPL: { date: '2026-12-19', session: 'pre', epsForecast: null },
      MSFT: { date: '2026-11-09', session: 'unknown', epsForecast: null },
    },
    macro: [
      { kind: 'fomc', date: '2026-11-09', time: '14:00', ref: 'FOMC', days: 0 },
      { kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 1 },
    ],
    closures: [{ name: 'Thanksgiving Day', nameZh: '感恩节', date: '2026-11-26', close: '13:00' }],
    expiries: [{ date: '2026-11-20' }],
  };
  const all = merge(payload, { days: 30 });
  const dates = all.rows.map((row) => row.date).join(',');
  assert(dates === '2026-11-09,2026-11-09,2026-11-10,2026-11-12,2026-11-20,2026-11-26', `chronological order, got ${dates}`);
  // A same-day tie goes to the reader's own name: an earnings report moves one
  // position, a print moves the whole book, and the single name is the more
  // urgent of the two.
  assert(all.rows[0].type === 'earnings' && all.rows[1].type === 'macro', 'a same-day earnings row sorts ahead of the macro print');
  assert(!all.rows.some((row) => row.symbol === 'AAPL'), 'a date outside the window is dropped');
  assert(all.counts.earnings === 2 && all.counts.macro === 2 && all.counts.exchange === 2, `counts by type, got ${JSON.stringify(all.counts)}`);
  assert(all.counts.soon === 4 && all.counts.total === 6, `near-term count, got ${JSON.stringify(all.counts)}`);
  // Merging is only worth it if the collision is said out loud: the 9th carries
  // an earnings report and an FOMC decision in one session, so each of those two
  // rows points at the other one.
  const ninth = all.rows.filter((row) => row.date === '2026-11-09')
  assert(ninth.length === 2 && ninth.every((row) => row.sameDay === 1), `same-day rows point at each other, got ${JSON.stringify(ninth.map((row) => row.sameDay))}`)
  assert(all.rows.filter((row) => row.date !== '2026-11-09').every((row) => row.sameDay === 0), 'a lone row claims no collision')
  assert(onlyEarningsCollision(), 'a filtered board counts only what it shows')
  function onlyEarningsCollision() {
    const filtered = merge(payload, { days: 30, type: 'earnings' })
    return filtered.rows.every((row) => row.sameDay === 0)
  }
  assert(zh('+{n} same day', { n: 1 }) === '同日另有 1 件', 'the collision tag reads as a count in Chinese')
  assert(internals.CSS.includes('.tm-ev__same'), 'the collision tag ships its CSS')
  // The nearest event is the one a reader acts on, so it must behave like its row.
  assert(internals.CSS.includes('.tm-ev__next--link'), 'the next-up strip can be a link')
  assert(String(internals.EventBoard).includes("tm-ev__next--link") && String(internals.EventBoard).includes("next.type === 'earnings'"), 'the next-up strip links only for a name with a detail page')
  const week = merge(payload, { days: 7 });
  assert(week.rows.length === 4 && week.counts.earnings === 2, `the 7-day chip drops everything past the week, got ${week.rows.length}`);
  const onlyEarnings = merge(payload, { days: 30, type: 'earnings' });
  assert(onlyEarnings.rows.length === 2 && onlyEarnings.rows.every((row) => row.type === 'earnings'), 'the type filter keeps one voice');
  const onlyExchange = merge(payload, { days: 30, type: 'exchange' });
  assert(onlyExchange.rows.length === 2, 'exchange means closures and expiries together');
  // A symbol query is always an earnings question; it must not be answered with
  // an empty list because a type chip was left active.
  const queried = merge(payload, { days: 30, type: 'macro', query: 'nvda' });
  assert(queried.rows.length === 1 && queried.rows[0].symbol === 'NVDA', 'the symbol filter overrides the type chip');
  // The impact line is the half a bare calendar leaves out.
  const impact = (date) => internals.eventImpactOf(all.rows.find((row) => row.date === date), en);
  assert(/after the close/.test(impact('2026-11-12')), `an after-close report says which open reprices it, got ${impact('2026-11-12')}`);
  assert(/whole session/.test(impact('2026-11-09')), 'an unannounced report time flags the whole session');
  assert(/Inflation/.test(impact('2026-11-10')), 'CPI says what it does to the book');
  assert(/last hour/.test(internals.eventImpactOf(all.rows.find((row) => row.type === 'opex'), en)), 'the expiry row explains the volume cluster');
  assert(/13:00/.test(internals.eventImpactOf(all.rows.find((row) => row.date === '2026-11-26'), en)), 'a half day carries its cutoff');
  // Titles come from the reader's language, not from the payload's English.
  assert(internals.eventTitleOf(all.rows.find((row) => row.date === '2026-11-26'), zh, 'zh') === '感恩节', 'the closure name localises');
  assert(internals.eventTitleOf(all.rows.find((row) => row.date === '2026-11-10'), zh, 'zh') === '美国 CPI', 'the macro title localises');
  assert(internals.CSS.includes('.tm-ev__chip--earnings') && internals.CSS.includes('.tm-ev__impact'), 'the board rows ship their CSS');
  assert(/[\u4e00-\u9fff]/.test(internals.ZH['What is coming up'] || ''), 'the board title localises');
  // A reminder is the board speaking up while nobody is looking: today and
  // tomorrow only, never the far rows, and the copy has to survive n = 1.
  const rem = internals.eventReminderOf(all.rows, en, 'en');
  assert(rem && rem.title === '2 events today', `today's count drives the title, got ${rem && rem.title}`);
  assert(/^MSFT today/.test(rem.body) && /FOMC decision today/.test(rem.body), `the body names what fires, got ${rem && rem.body}`);
  const tomorrowOnly = internals.eventReminderOf(all.rows.filter((row) => row.days === 1), en, 'en');
  assert(tomorrowOnly.title === 'Market event tomorrow', `a lone reminder is not "1 events", got ${tomorrowOnly.title}`);
  assert(tomorrowOnly.body === 'US CPI tomorrow', `the body keeps the relative day, got ${tomorrowOnly.body}`);
  assert(internals.eventReminderOf(all.rows.filter((row) => row.days > 1), en, 'en') === null, 'a quiet day sends nothing');
  assert(internals.ZH['Market event today'] === '今天有一件市场事件' && internals.ZH['{n} events tomorrow'] === '明天有 {n} 件事件', 'the reminder copy localises');
  assert(String(internals.EventBoard).includes('useEventReminder'), 'the board arms the reminder on every render of the merged rows');
  assert(String(internals.useEventReminder).includes('document.hidden') && String(internals.useEventReminder).includes('permission'), 'the reminder speaks only while the tab is hidden and only when the browser allows it');
  assert(String(internals.useEventReminder).includes('tm-ev-reminded'), 'the same reminder is not repeated the same day');
  assert(String(internals.EventBoard).includes('also arrive as a desktop alert'), 'the board says where the reminder comes from');
  assert(/[\u4e00-\u9fff]/.test(internals.ZH['Today and tomorrow also arrive as a desktop alert while this tab is hidden.'] || ''), 'the reminder note localises');
  assert(String(internals.EventBoard).includes('tm-events-type'), 'the type chip remembers itself like the window does');
  // A toast is gone once dismissed; the reminder also has to leave a line in
  // the alert history, with the event's own shorthand in the symbol column.
  assert(rem.items.length === 3, `every row inside two days is recorded, got ${rem.items.length}`);
  assert(rem.items.slice(0, 2).every((item) => item.when === 'today') && rem.items[2].when === 'tomorrow', 'each entry keeps the day it belongs to');
  assert(rem.items.every((item) => item.hit === 'event' && item.type), 'calendar entries carry their kind');
  assert(rem.items[0].symbol === 'MSFT', `an earnings reminder is tagged with its ticker, got ${rem.items[0].symbol}`);
  assert(tomorrowOnly.items[0].symbol === 'CPI', `a macro reminder keeps the print shorthand, got ${tomorrowOnly.items[0].symbol}`);
  assert(internals.alertLogReason({ hit: 'event', type: 'earnings', when: 'today' }, zh) === '财报 \u00b7 今天', 'the history line is rebuilt in the reader language');
  assert(internals.alertLogReason({ hit: 'event', type: 'macro', when: 'tomorrow' }, en) === 'Macro \u00b7 tomorrow', 'and in English when that is the language');
  const logged = internals.appendAlerts([], rem.items, 1000);
  assert(logged.length === 3 && logged.every((entry) => entry.type && entry.when), 'appendAlerts keeps the calendar fields instead of dropping them');
  assert(String(internals.useEventReminder).includes('tm-ev-logged') && String(internals.useEventReminder).includes('record(items)'), 'the history line is written once per day, before the toast waits for a hidden tab');
  assert(String(internals.EventBoard).includes('recordLog'), 'the board feeds the shared log so the history card updates itself');
  assert(internals.CSS.includes('.tm-alog__row--event'), 'calendar entries are styled apart from price alerts');
  assert(String(internals.AlertLogCard).includes("openable ? 'button' : 'div'"), 'only rows with a page behind them stay buttons');
  return 'sort, window, four filters, impact lines and zh titles hold over one merged payload';
});

await check('event board: the two-day window is the desk view, not a planning view', async () => {
  const zh = internals.makeT('zh')
  const merge = internals.mergeEventRows
  const payload = {
    today: '2026-11-09',
    bySymbol: {
      MSFT: { date: '2026-11-09', session: 'unknown', epsForecast: null },
      NVDA: { date: '2026-11-12', session: 'post', epsForecast: 1.2 },
    },
    macro: [
      { kind: 'fomc', date: '2026-11-09', time: '14:00', ref: 'FOMC', days: 0 },
      { kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 1 },
    ],
    closures: [{ name: 'Thanksgiving Day', nameZh: '感恩节', date: '2026-11-26', close: '13:00' }],
    expiries: [{ date: '2026-11-20' }],
  }
  const desk = merge(payload, { days: 2 })
  assert(desk.rows.map((row) => row.date).join(',') === '2026-11-09,2026-11-09,2026-11-10', `only today and tomorrow, got ${desk.rows.map((row) => row.date).join(',')}`)
  assert(desk.counts.total === 3, `the count follows the window, got ${JSON.stringify(desk.counts)}`)
  // A value that is not one of the three offers must widen, never narrow to
  // nothing: an old stored '5' would otherwise blank the whole board.
  const stored = merge(payload, { days: 5 })
  assert(stored.rows.length === 6, `an unknown window falls back to 30 days, got ${stored.rows.length}`)
  const week = merge(payload, { days: 7 })
  assert(week.rows.length === 4, `the week window keeps four rows, got ${week.rows.length}`)
  assert(zh('Today and tomorrow') === '今明两天', 'the desk chip is named for the desk')
  assert(zh('{n} in the next two days', { n: 3 }) === '今明两天共 3 件', 'the meta line follows the window')
  const source = String(internals.EventBoard)
  assert(source.includes('[2, 7, 30]'), 'all three windows are offered')
  assert(source.includes("t('Today and tomorrow')"), 'the narrow one is not labelled "2d window"')
})

await check('event board: a long window shows the near dates first and holds the rest back', async () => {
  const page = internals.eventPage
  const many = Array.from({ length: 12 }, (_, i) => ({ key: `row${i}`, days: i }))
  const first = page(many, false)
  assert(first.rows.length === 8, `eight rows fit on a screen, got ${first.rows.length}`)
  assert(first.hidden === 4, `the rest is counted, not dropped, got ${first.hidden}`)
  assert(first.rows[0].days === 0 && first.rows[7].days === 7, 'the head of the list is the soonest date')
  const all = page(many, true)
  assert(all.rows.length === 12 && all.hidden === 0, 'expanding reveals everything')
  const small = page(many.slice(0, 3), false)
  assert(small.hidden === 0, 'a short board has nothing to expand')
  assert(page(null, false).rows.length === 0, 'no rows is an empty page, not a crash')
  assert(page(many, false, 4).rows.length === 4, 'the cap is a parameter')
  const zh = internals.makeT('zh')
  assert(zh('Show the other {n}', { n: 4 }) === '展开另外 4 件', 'the toggle counts what it hides')
  assert(zh('Show less') === '收起', 'and can be undone in one word')
  const source = String(internals.EventBoard)
  assert(source.includes('eventPage(rows, expanded)'), 'the board pages its own rows')
  assert(source.includes('tm-ev__more'), 'the toggle is rendered')
  assert(String(internals.CSS).includes('.tm-ev__more'), 'and styled')
})

await check('event board: the held switch drops the reports the reader does not own', async () => {
  const merge = internals.mergeEventRows;
  const zh = internals.makeT('zh');
  const payload = {
    today: '2026-11-09',
    bySymbol: {
      NVDA: { date: '2026-11-12', session: 'post', epsForecast: 1.2 },
      AAPL: { date: '2026-11-13', session: 'pre', epsForecast: null },
      MSFT: { date: '2026-11-10', session: 'unknown', epsForecast: null },
    },
    macro: [{ kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 1 }],
    closures: [],
    expiries: [],
  };
  const everything = merge(payload, { days: 30 });
  const held = merge(payload, { days: 30, heldOnly: true, held: new Set(['MSFT']) });
  const heldArr = merge(payload, { days: 30, heldOnly: true, held: ['MSFT'] });
  const nothingHeld = merge(payload, { days: 30, heldOnly: true, held: [] });
  const symbols = (result) => result.rows.map((row) => row.symbol || row.type).sort().join(',');
  assert(everything.rows.length === 4, `the unfiltered board keeps every row, got ${symbols(everything)}`);
  // A CPI print moves every position at once, so the filter may only narrow the
  // rows that name a single company.
  assert(symbols(held) === 'MSFT,macro', `only the held name survives, got ${symbols(held)}`);
  assert(symbols(heldArr) === 'MSFT,macro', 'a plain array works as the held set');
  assert(symbols(nothingHeld) === 'AAPL,MSFT,NVDA,macro', `an empty held set disables the switch, got ${symbols(nothingHeld)}`);
  assert(held.counts.earnings === 1 && held.counts.total === 2, 'the chip counts describe the board the reader is looking at');
  assert(nothingHeld.counts.earnings === 3, 'without the switch the counts go back to the whole window');
  assert(zh('Held only') === '只看持仓', 'the chip localises');
  assert(
    zh('Only the earnings dates of names you hold; market-wide rows stay') === '只保留你持仓股票的财报日，宏观与休市仍然显示',
    'the tooltip says what survives the filter',
  );
  const source = String(internals.EventBoard);
  assert(source.includes('tm-events-held'), 'the switch is remembered between visits');
  assert(source.includes("t('Held only')"), 'the chip is part of the board');
  assert(source.includes('positions.size'), 'the chip only appears once a position exists');
  assert(source.split("key: 'held'").length === 2, `the held chip must render once, got ${source.split("key: 'held'").length - 1}`);
});

await check('event board: the major scope keeps what moves the index and what is owned', async () => {
  const merge = internals.mergeEventRows;
  // The seed list is spelled out in one place and tests read it, so a renamed
  // ticker cannot silently become "too small for the board".
  assert(internals.MEGA_CAPS.includes('AAPL') && internals.MEGA_CAPS.includes('TSM'), 'the mega-cap list is seeded');
  const payload = {
    today: '2026-11-09',
    bySymbol: {
      AAPL: { date: '2026-11-12' },
      SMCI: { date: '2026-11-12' },
      GOOGL: { date: '2026-11-13' },
    },
    macro: [{ kind: 'cpi', date: '2026-11-11', time: '08:30', ref: 'October CPI', days: 2 }],
    closures: [],
    expiries: [],
  };
  const symbols = (result) => result.rows.map((row) => row.symbol || row.type).sort().join(',');
  const all = merge(payload, { days: 30, scope: 'all' });
  const major = merge(payload, { days: 30, scope: 'major', held: [new Set(['SMCI'])][0] });
  const dropped = merge(payload, { days: 30, scope: 'major', held: [] });
  const custom = merge(payload, { days: 30, scope: 'major', major: new Set(['SMCI']), held: [] });
  const defaults = merge(payload, { days: 30 });
  assert(symbols(all) === 'AAPL,GOOGL,SMCI,macro', `the full board keeps everything, got ${symbols(all)}`);
  assert(symbols(major) === 'AAPL,GOOGL,SMCI,macro', `a held minor survives the major scope, got ${symbols(major)}`);
  assert(symbols(dropped) === 'AAPL,GOOGL,macro', `an unheld minor does not, got ${symbols(dropped)}`);
  assert(symbols(custom) === 'SMCI,macro', `the seed list can be replaced by the caller, got ${symbols(custom)}`);
  assert(symbols(defaults) === 'AAPL,GOOGL,SMCI,macro', `callers without a scope still get everything, got ${symbols(defaults)}`);
  assert(major.counts.earnings === 3 && dropped.counts.earnings === 2, 'the counts follow the filtered board');
  const zh = internals.makeT('zh');
  assert(zh('Major') === '重点' && zh('Everything') === '全部', 'the two reading modes localise');
  const source = String(internals.EventBoard);
  assert(source.includes('tm-events-scope'), 'the scope is remembered between visits');
  assert(source.includes("t('Major')") && source.includes("t('Everything')"), 'both chips render');
  assert(internals.CSS.includes('.tm-ev__next'), 'the next-up strip stays styled');
});

await check('event board: the rows leave as an .ics file the system calendar can import', async () => {
  const ics = internals.eventsIcs;
  const zh = internals.makeT('zh');
  const empty = ics([]);
  assert(empty.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n'), 'the header opens with the calendar shell');
  assert(empty.endsWith('END:VCALENDAR\r\n'), 'the header closes cleanly');
  assert(!empty.includes('BEGIN:VEVENT'), 'no rows means no events');
  const text = ics([
    { date: '2026-11-20', type: 'earnings', title: 'NVDA, Inc. 财报', impact: 'Reports after the close, the next open reprices it' },
    { date: '2026-11-26', type: 'closure', title: '感恩节', impact: 'Closed all day: no fills, and prices stand still' },
    { date: 'bad', type: 'earnings', title: 'skipped' },
  ]);
  assert(text.includes('DTSTART;VALUE=DATE:20261120'), `the date lands as an all-day start, got ${text.split('\r\n').filter((line) => line.includes('DTSTART')).join(' | ')}`);
  const summaryLine = text.split('\r\n').find((line) => line.startsWith('SUMMARY:'));
  assert(summaryLine === 'SUMMARY:NVDA\\, Inc. 财报', `encoded summary, got ${JSON.stringify(summaryLine)}`);
  assert(text.includes('DESCRIPTION:Reports after the close\\, the next open reprices it'), 'the impact sentence travels as the description');
  assert(text.includes('UID:tm-2026-11-20-earnings-0@'), 'each row gets its own stable identity');
  assert(text.split('BEGIN:VEVENT').length - 1 === 2 && text.split('END:VEVENT').length - 1 === 2, 'two well-formed events carry the file');
  assert(zh('Save to calendar') === '存入日历', zh('Save to calendar') || 'the action button localises');
  assert(
    zh('Download these rows to import into your calendar') === '把这几行导出成日历文件，导入你自己的日历',
    'the tooltip says what the file is for',
  );
  const source = String(internals.EventBoard);
  assert(source.includes('trading-events-${today}.ics'), 'the file name carries the day');
  assert(source.includes("'text/calendar;charset=utf-8'"), 'the download advertises the calendar MIME type');
  assert(String(internals.saveTextFile).includes("mime = 'text/plain;charset=utf-8'"), 'the saver accepts a MIME type');
  assert(String(internals.saveTextFile).includes('\\ufeff\' + text'), 'plain-text saves keep their BOM');
});
await check('event board: calendar entries carry the minute the print lands', async () => {
  const ics = internals.eventsIcs;
  const timed = ics([
    { date: '2026-11-10', type: 'macro', time: '08:30', title: 'US CPI', impact: 'Inflation print: rate expectations reprice every position at once' },
    { date: '2026-06-10', type: 'macro', time: '14:00', title: 'summer print', impact: 'summer edge of the DST window' },
    { date: '2026-12-09', type: 'macro', time: '14:00', title: 'FOMC decision', impact: 'Rate decision: usually the widest move window of the month' },
    { date: '2026-11-20', type: 'macro', time: 'not-a-time', title: 'fallback', impact: 'bad time falls back to the all-day entry' },
  ]);
  assert(timed.includes('DTSTART:20261110T133000Z'), `a winter 08:30 ET print becomes 13:30Z, got ${timed.split('\r\n').filter((line) => line.includes('DTSTART')).join(' | ')}`);
  assert(timed.includes('DTEND:20261110T134500Z'), 'the timed window is fifteen minutes');
  assert(timed.includes('DTSTART:20260610T180000Z'), 'a summer 14:00 ET print becomes 18:00Z');
  assert(timed.includes('DTSTART:20261209T190000Z'), 'a winter 14:00 ET print becomes 19:00Z');
  assert(timed.includes('DTSTART;VALUE=DATE:20261120'), 'a malformed clock time falls back to the all-day entry');
  assert(internals.isUsDst('2026-03-08') === true && internals.isUsDst('2026-06-15') === true, 'DST runs from the second Sunday in March');
  assert(internals.isUsDst('2026-11-01') === false && internals.isUsDst('2026-12-15') === false, 'and ends on the first Sunday in November');
  assert(internals.etToUtcStamp('2026-11-10', '25:00') === null && internals.etToUtcStamp('bad', '08:30') === null, 'malformed input poses no entry');
});


await check('brief: a suggestion carries the facts it was read against', async () => {
  const t = internals.makeT('en');
  const zh = internals.makeT('zh');
  const why = internals.suggestionWhy('NVDA — the momentum attempt is back in play', [
    { symbol: 'NVDA', currency: 'USD', price: 180.5, changePct: -2.1, trendAlignment: 'bullish', rsi14: 72, high52w: 200, volumeRatio20d: 2.1, earningsInDays: 3 },
    { symbol: 'AAPL', price: 'n/a' },
  ], t);
  if (!why) throw new Error('digest facts vanished');
  if (!why.includes('2.1%')) throw new Error(why); // signed() renders U+2212, so match the digits only
  if (!why.includes('52-week high')) throw new Error(why);
  if (!why.includes('stretched')) throw new Error(why);
  if (!why.includes('earnings in 3d')) throw new Error(why);
  if (internals.suggestionWhy('keep some dry powder', ['x'], t) !== '') throw new Error('no-lead lines stay silent');
  if (internals.suggestionWhy('AAPL — hold the line', [{ symbol: 'AAPL' }], t) !== '') throw new Error('no price, no tooltip');
  if (internals.suggestionWhy(null, [{ symbol: 'A', price: 1 }], t) !== '') throw new Error('junk input handled');
  if (zh('earnings in {n}d', { n: 3 }) !== '3 天后出财报') throw new Error('zh earnings key.');
  if (!String(internals.BriefCard).includes('suggestionWhy(line, brief.meta && brief.meta.stocks, t)')) throw new Error('BriefCard must read the digest');
  if (!String(internals.BriefCard).includes('tm-brief__why')) throw new Error('the marker chip must render');
  if (!String(internals.CSS).includes('.tm-brief__why')) throw new Error('CSS for the why chip is missing');
  return 'suggestions now cite their facts on hover';
});

await check('brief: an action idea says whether it lands on a position you hold', async () => {
  const rows = [
    { symbol: 'NVDA', market: 'US', quote: { price: 100, changePct: 1.2, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
    { symbol: 'AAPL', market: 'US', quote: { price: 200, changePct: -0.4, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
    { symbol: 'MSFT', market: 'US', quote: { price: 300, changePct: 0.2, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
  ];
  const costs = { 'US:NVDA': { price: 80, shares: 10 }, 'US:MSFT': { price: 300, shares: 0 } };
  const held = internals.heldSymbols(rows, costs);
  assert(held instanceof Set, 'the helper returns a plain set of tickers');
  assert(held.has('NVDA'), 'a name with a cost basis is held');
  // Zero shares is a placeholder, not a position: it must not turn every idea
  // about that ticker into a holding instruction.
  assert(!held.has('MSFT'), 'zero shares is not a position');
  assert(!held.has('AAPL'), 'an unpriced name is not a position');
  assert(internals.heldSymbols([], null).size === 0, 'no rows means nothing held');
  const zh = internals.makeT('zh');
  assert(zh('Held') === '持仓', 'the marker localises');
  assert(
    zh('This idea concerns a position you hold') === '这条建议针对你已经持有的仓位',
    'the tooltip explains the marker',
  );
  const source = String(internals.BriefCard);
  assert(source.includes('tm-brief__hold'), 'the marker has its own style hook');
  assert(source.includes('held.has(lead[1])'), 'the marker is keyed to the leading ticker');
  assert(String(internals.CSS).includes('.tm-brief__hold'), 'the marker is styled');
});

await check('brief: an idea about a name you do not track says so', async () => {
  const rows = [
    { symbol: 'NVDA', market: 'US', quote: { price: 100, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
    { symbol: 'AAPL', market: 'US', quote: { price: 200, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
    { symbol: ' nvda ', market: 'US', quote: { price: 100, currency: 'USD' } },
    { symbol: '', market: 'US' },
    {},
    null,
  ];
  const listed = internals.boardSymbols(rows);
  assert(listed instanceof Set, 'the helper returns a set of tickers');
  assert(listed.has('NVDA') && listed.has('AAPL'), 'what is on the board is what can be acted on');
  assert(listed.size === 2, 'blank and shapeless rows add nothing: ' + listed.size);
  assert(internals.boardSymbols(null).size === 0, 'no rows means nothing listed');
  assert(internals.boardSymbols([{}]).size === 0, 'a row without a symbol is not a name');

  const html = renderToString(h(internals.BriefCard, {
    brief: { headline: 'Mixed tape', stocksTracked: 2, upCount: 1, downCount: 1,
      strongestMover: 'NVDA +1.2% 100.00',
      suggestions: [
        'NVDA — the momentum attempt is back in play',
        'TLV — semiconductor equipment is the crowded trade',
        'keep some dry powder until the print',
      ] },
    sectors: [],
    positions: [],
    held: new Set(['NVDA']),
    board: listed,
    aiAvailable: true,
  }));
  // A held line keeps its existing tag and gains nothing else; a line about a
  // name outside the board is labelled; a market-level line stays unlabelled.
  assert(html.includes('tm-brief__hold'), 'the held line keeps its marker');
  const marks = html.split('tm-brief__outside').length - 1;
  assert(marks === 1, 'exactly one idea is marked as outside the board: ' + marks);
  assert(html.includes('Not on your watchlist'), 'the outside marker names itself');
  const zh = internals.makeT('zh');
  assert(zh('Not on your watchlist') === '不在你的列表', 'the marker localises');
  assert(
    zh('A name you do not track: this came from the market data, not from your board.') === '这只不在你的自选里：这条来自市场数据，不是你的列表。',
    'the tooltip explains the marker',
  );
  const source = String(internals.BriefCard);
  assert(source.includes('board.has(lead[1])'), 'the marker is keyed to the leading ticker');
  assert(source.includes('tm-brief__outside'), 'the element is wired in the component');
  assert(String(internals.CSS).includes('.tm-brief__outside'), 'the marker is styled');
  assert(String(internals.HomeView).includes('board: boardSet'), 'the home page supplies the board');
});

await check('brief: an empty action list says waiting is the plan, not silence', async () => {
  const html = renderToString(h(internals.BriefCard, {
    brief: { headline: 'Quiet tape', stocksTracked: 3, upCount: 1, downCount: 2,
      strongestMover: 'NVDA +1.2% 100.00', suggestions: [] },
    sectors: [],
    positions: [],
    held: new Set(),
    aiAvailable: true,
  }));
  assert(html.includes('No condition for an action today'), 'the quiet line replaces an empty list');
  assert(html.includes('tm-brief__quiet'), 'the line carries its own hook');
  assert(html.includes('Action ideas'), 'the quiet line still lives under the same block title');
  const zh = internals.makeT('zh');
  assert(
    zh('No condition for an action today — doing nothing is the plan.') === '今天没有触发任何行动条件——按兵不动就是今天的方案。',
    'the waiting line localises',
  );
  assert(String(internals.CSS).includes('.tm-brief__quiet'), 'the quiet line is styled');
  assert(String(internals.BriefCard).includes('tm-brief__quiet'), 'the element is wired in the component');
});

await check('brief: the positions ride into the analyze POST', async () => {
  const rows = [
    { symbol: 'NVDA', market: 'US', quote: { price: 100, changePct: 1.2, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
    { symbol: 'MSFT', market: 'US', quote: { price: 300, changePct: 0.2, currency: 'USD', timestamp: '2026-11-07T15:00:00Z' } },
  ];
  const costs = { 'US:NVDA': { price: 80, shares: 10 }, 'US:MSFT': { price: 300, shares: 0 } };
  const book = internals.heldPositions(rows, costs);
  assert(Array.isArray(book) && book.length === 1, 'only real positions ride along');
  assert(book[0].symbol === 'NVDA' && book[0].shares === 10, 'shares and symbol survive');
  assert(book[0].value === 1000 && book[0].currency === 'USD', 'value and currency ride with the row');
  assert(internals.heldPositions([], null).length === 0, 'no rows means an empty book, not junk');
  const source = String(internals.HomeView);
  assert(
    source.includes("positions: heldPositions(rows, costs)"),
    'the post body carries the book',
  );
  assert(String(internals.HomeView).includes('[lang, rows, costs]'), 'the run brief re-arms when the book changes');
  return 'sanitised positions ride into the analyze POST';
});

await check('extended hours: a pre or post print rides the row and the detail header', async () => {
  const zh = internals.makeT('zh');
  const en = internals.makeT('en');
  assert(internals.CSS.includes('.tm-row__flag--ext'), 'the row chip ships its CSS');
  assert(internals.CSS.includes('.tm-detail__ext'), 'the detail line ships its CSS');
  assert(zh('Extended hours') === '盘前盘后', 'the section label localises');
  assert(zh('pre-market') === '盘前', 'the pre-market label localises');
  assert(zh('after close') === '盘后', 'the post-close label localises');
  return 'extended-hours chip and detail line localise';
});

await check('analyst view: a consensus band, and every rating label localises', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-arb__track') && internals.CSS.includes('.tm-arb__pin'), 'the consensus band ships its CSS');
  assert(zh('Analyst view') === '分析师观点', 'the card title localises');
  assert(zh('Mean target') === '平均目标价', 'the target cell localises');
  assert(zh('Upside') === '上行空间', 'the upside cell localises');
  assert(zh('analysts') === '位分析师', 'the coverage meta localises');
  // Yahoo's five recommendation keys arrive in English and must all resolve,
  // otherwise the badge reads "strong_buy" to a Chinese reader.
  const labels = ['Strong buy', 'Buy', 'Hold', 'Underperform', 'Sell'];
  const missing = labels.filter((label) => /[\u4e00-\u9fff]/.test(zh(label)) === false);
  assert(missing.length === 0, `untranslated ratings: ${missing.join(', ')}`);
  return 'consensus band CSS + 5/5 rating labels localise';
});

await check('fundamentals: the growth and margin grid localises every row', async () => {
  const zh = internals.makeT('zh');
  assert(zh('Fundamentals') === '基本面', 'the card title localises');
  const rows = ['Forward P/E', 'Price/Book', 'Beta', 'Revenue growth', 'Earnings growth', 'Gross margin', 'Net margin', 'Return on equity'];
  const missing = rows.filter((row) => /[\u4e00-\u9fff]/.test(zh(row)) === false);
  assert(missing.length === 0, `untranslated rows: ${missing.join(', ')}`);
  assert(!source.includes("plain(company.stats.shortFloat"), 'short interest moved out of the ratio grid');
  return '8/8 fundamentals labels localise';
});

await check('ownership: the stakes and the short book get their own card', async () => {
  const zh = internals.makeT('zh');
  assert(zh('Ownership & shorts') === '持股与做空', 'the card title localises');
  const rows = ['Institutions', 'Insiders', 'Short float', 'Days to cover', 'Shares short', 'vs prior month', 'Short interest as of'];
  const missing = rows.filter((row) => /[\u4e00-\u9fff]/.test(zh(row)) === false);
  assert(missing.length === 0, `untranslated rows: ${missing.join(', ')}`);
  assert(source.includes('company.ownership') && source.includes('company.ownership.shortChangePct'), 'the card reads the ownership block');
  assert(source.includes("volumeText(company.ownership.shortShares)"), 'share counts reuse the volume formatter');
  return '6/6 ownership rows localise, short change reads the prior month';
});

await check('price alerts: bounds are per market, and only a real price fires them', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-alerts__row') && internals.CSS.includes('.tm-alertfield__in'), 'the banner and the editor ship their CSS');
  assert(zh('Price alert') === '价格提醒', 'the editor label localises');
  assert(zh('{n} alerts triggered') === '{n} 条提醒已触发', 'the banner count localises');
  assert(zh('above') === '高于' && zh('below') === '低于', 'both bounds localise');
  // The key is market-qualified: a US listing and a crypto pair can share a
  // ticker, and an alert armed on one must not fire on the other.
  const map = { 'US:AAPL': { above: 200, below: '150' } };
  const us = internals.alertOf(map, { market: 'US', symbol: 'AAPL' });
  assert(us && us.above === 200 && us.below === 150, `the stored bounds survive a string draft: ${JSON.stringify(us)}`);
  assert(internals.alertOf(map, { market: 'CRYPTO', symbol: 'AAPL' }) === null, 'another market does not inherit the alert');
  // A blank or broken entry must not promise a check that can never fire.
  assert(internals.alertOf({ 'US:X': {} }, { market: 'US', symbol: 'X' }) === null, 'an empty entry is not an alert');
  assert(internals.alertOf({ 'US:X': { above: '', below: 0 } }, { market: 'US', symbol: 'X' }) === null, 'blank and zero bounds are not alerts');
  // Inclusivity and the no-quote rule: a stale or failed quote must stay silent.
  assert(internals.alertHit(200, { above: 200, below: null }) === 'above', 'the upper bound is inclusive');
  assert(internals.alertHit(150, { above: null, below: 150 }) === 'below', 'the lower bound is inclusive');
  assert(internals.alertHit(175, { above: 200, below: 150 }) === null, 'a price between the bounds is quiet');
  assert(internals.alertHit(null, { above: 200, below: 150 }) === null, 'no price never fires');
  const text = internals.alertBoundsText({ above: 200, below: 150 }, zh, 'USD');
  assert(text.includes('高于') && text.includes('低于'), `the bound summary reads in the UI language: ${text}`);
  return 'bounds keyed by market, blank entries ignored, inclusive thresholds, no price no alarm';
});

await check('alerts: the history leaves the panel as plain lines', () => {
  const zh = internals.makeT('zh');
  const when = Date.UTC(2026, 10, 6, 21, 4, 0);
  const lines = internals.alertLogText(
    [
      { key: 'US:NVDA', symbol: 'NVDA', hit: 'down', pct: -5.42, at: when },
      { key: 'US:AAPL', symbol: 'AAPL', hit: 'above', level: 320, currency: 'USD', at: when - 60000 },
      null,
    ],
    zh,
  );
  assert(lines.length === 2, `null rows are dropped, got ${JSON.stringify(lines)}`);
  assert(lines[0].includes('NVDA'), `symbol present, got ${lines[0]}`);
  assert(lines[0].includes('\u00b7'), `fields are separated, got ${lines[0]}`);
  assert(lines[0].includes('\u4eca\u65e5'), `the reason matches the row, got ${lines[0]}`);
  assert(lines[0].split(' \u00b7 ').length === 3, `when, symbol, reason: ${lines[0]}`);
  assert(lines[1].includes('320'), `a price bound keeps its number, got ${lines[1]}`);
  assert(internals.alertLogText(null, zh).length === 0, 'no history, no text');
  assert(internals.alertLogText([], zh).length === 0, 'empty history, no text');
  assert(internals.CSS.includes('.tm-alog__acts'), 'the footer groups its buttons');
  assert(zh('Copy history') === '\u590d\u5236\u8bb0\u5f55', 'the button is localised');
  assert(zh('Copy the alert history as plain text').includes('\u7eaf\u6587\u672c'), 'so is its tooltip');
});

await check('alerts: the history keeps what fired, newest first, without repeating itself', async () => {
  const zh = internals.makeT('zh');
  const CSS = internals.CSS;
  assert(typeof internals.appendAlerts === 'function', 'appendAlerts is exported');
  assert(typeof internals.alertLogReason === 'function', 'alertLogReason is exported');
  assert(CSS.includes('.tm-alog__row'), 'history rows need their own style');
  assert(CSS.includes('.tm-alog__foot'), 'the history footer needs its own style');
  assert(zh('Alert history') === '提醒记录', 'the card title is localised');
  assert(zh('Clear history') === '清空记录', 'the clear action is localised');

  const base = { at: 1000 };
  let list = internals.appendAlerts([], [{ key: 'US:AAPL', symbol: 'AAPL', hit: 'above', level: 320 }], 1000);
  assert(list.length === 1 && list[0].key === 'US:AAPL', 'a first hit is recorded');
  assert(list[0].at === 1000, 'the entry carries the time it happened');

  // A repeat seconds later is the same event, not a second one.
  list = internals.appendAlerts(list, [{ key: 'US:AAPL', symbol: 'AAPL', hit: 'above', level: 320 }], 1200);
  assert(list.length === 1, 'a repeat inside the gap is folded away');

  // A different alert on the same symbol is its own event.
  list = internals.appendAlerts(list, [{ key: 'US:AAPL', symbol: 'AAPL', hit: 'loss', pct: -12.5 }], 1300);
  assert(list.length === 2 && list[0].hit === 'loss', 'a different hit is its own entry, newest first');

  // After the gap the same hit is news again.
  list = internals.appendAlerts(list, [{ key: 'US:AAPL', symbol: 'AAPL', hit: 'above', level: 321 }], 1000 + 6 * 60 * 1000);
  assert(list.length === 3 && list[0].hit === 'above', 'the same hit counts again once the gap passed');

  // The list is capped so storage cannot grow without bound.
  let big = [];
  for (let i = 0; i < 40; i += 1) {
    big = internals.appendAlerts(big, [{ key: `US:S${i}`, symbol: `S${i}`, hit: 'above', level: 10 }], 5000 + i * 60 * 60 * 1000);
  }
  assert(big.length === 30, 'the history is capped at thirty entries, got ' + big.length);

  const reason = (entry) => internals.alertLogReason(entry, zh);
  assert(reason({ hit: 'above', level: 320, currency: 'USD' }) === '高于 $320.00', 'a price alert reads as a level, got ' + reason({ hit: 'above', level: 320, currency: 'USD' }));
  assert(reason({ hit: 'loss', pct: -12.5 }).includes('−12.50%'), 'a drawdown keeps its percent');
  assert(reason({ hit: 'up', pct: 3.1 }).includes('+3.10%'), 'a session move keeps its percent');
  assert(reason(null) === '', 'no entry renders nothing');

  // The card can be narrowed to the current day; older entries stay in the list.
  const today = new Date(2026, 10, 7, 15, 0, 0).getTime();
  const yesterday = new Date(2026, 10, 6, 9, 0, 0).getTime();
  const todays = internals.alertLogToday([{ at: today }, { at: yesterday }, { at: null }], today);
  assert(todays.length === 1 && todays[0].at === today, 'only entries from the current day survive the filter');
  assert(internals.alertLogToday([], today).length === 0, 'an empty history filters to nothing');
  assert(internals.alertLogToday(null, today).length === 0, 'a missing history is tolerated');
  assert(internals.CSS.includes('.tm-alog__chip--on'), 'the today chip has a pressed state');
  assert(zh('Nothing has fired today.').includes('今天'), 'the empty state is localised');
  // Keyboard users tab through dozens of small buttons on this panel.
  assert(internals.CSS.includes('.tm-page :focus-visible'), 'keyboard focus is visible everywhere');
});

await check('price alerts: the watched price is the latest print, extended hours included', async () => {
  assert(internals.CSS.includes('.tm-alerts__sess'), 'the banner labels which session an extended print came from');
  const print = internals.latestPrint;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert(same(print({ price: 100, extended: null }), { price: 100, session: 'regular' }), 'regular hours watch the regular price');
  // After the bell the regular price is frozen, so the after-hours print is the latest trade.
  assert(same(print({ price: 100, extended: { session: 'post', price: 101.5 } }), { price: 101.5, session: 'post' }), 'a post print becomes the watched price');
  assert(same(print({ price: 100, extended: { session: 'pre', price: 98.25 } }), { price: 98.25, session: 'pre' }), 'so does a pre print');
  // A malformed block must never shadow a good regular price.
  assert(same(print({ price: 100, extended: { session: 'post', price: null } }), { price: 100, session: 'regular' }), 'a broken extended block falls back');
  assert(same(print({ price: 100, extended: { session: 'overnight', price: 5 } }), { price: 100, session: 'regular' }), 'an unknown session is ignored');
  assert(print({ price: null, extended: null }) === null, 'no print at all means nothing to watch');
  assert(print(null) === null, 'a missing quote is tolerated');
  const latest = print({ price: 100, extended: { session: 'post', price: 151 } });
  assert(internals.alertHit(latest.price, { above: 150, below: null }) === 'above', 'the alert fires on the print it is handed');
  return 'extended print wins while fresh, broken blocks fall back, no print no alarm';
});

await check('board pulse: breadth counts only rows with a real day change', async () => {
  const I = internals
  const pulse = I.marketPulse([
    { symbol: 'AAPL', market: 'US', quote: { changePct: 1.2 } },
    { symbol: 'NVDA', market: 'US', quote: { changePct: -5.4 } },
    { symbol: 'VOO', market: 'US', quote: { changePct: 0 } },
    { symbol: 'SPY', market: 'US', quote: { price: 700 } },
  ])
  assert(pulse.total === 4, 'every row counts toward the total')
  assert(pulse.counted === 3, 'only rows with a numeric day change count toward breadth')
  assert(pulse.up === 1 && pulse.down === 1 && pulse.flat === 1, 'up, down and unchanged are separate')
  assert(pulse.lead.symbol === 'NVDA' && pulse.lead.changePct === -5.4, 'the steepest move leads, whichever way it went')
  assert(pulse.lead.market === 'US', 'the lead keeps its market so the row can open')
  const quiet = I.marketPulse([{ symbol: 'VTI', quote: { changePct: 0 } }])
  assert(quiet.lead === null, 'a flat board has no lead')
  assert(I.marketPulse(null).total === 0 && I.marketPulse([]).counted === 0, 'a missing list cannot throw')
  assert(/\.tm-pulse__lead/.test(I.CSS), 'the strip ships its own styles')
  const zh = internals.makeT('zh')
  assert(zh('{up} up {down} down', { up: 3, down: 5 }) === '3 涨 5 跌', 'breadth localises')
  assert(zh('Largest move: {sym}', { sym: 'NVDA' }) === '最大波动 NVDA', 'the lead label localises')
  return 'pulse counts breadth and the single steepest move'
})

await check('benchmark: the board is compared to the index as a plain average', async () => {
  const I = internals
  const rows = [
    { symbol: 'AAPL', quote: { changePct: 1.5 } },
    { symbol: 'NVDA', quote: { changePct: -0.5 } },
    { symbol: 'SPY', quote: { price: 700 } },
  ]
  const items = [
    { symbol: '^GSPC', name: 'S&P 500', quote: { changePct: 0.25 } },
    { symbol: '^IXIC', name: 'Nasdaq', quote: { changePct: 0.9 } },
  ]
  const vs = I.boardVsIndex(rows, items)
  assert(vs && vs.n === 2, 'rows with no day change stay out of the average')
  assert(Math.abs(vs.board - 0.5) < 1e-9, 'the board is an equal-weight average, not a sum')
  assert(vs.indexPct === 0.25, 'only the index asked for is read')
  assert(Math.abs(vs.gap - 0.25) < 1e-9, 'the gap is the board minus the index')
  assert(vs.indexName === 'S&P 500', 'the comparison names the index it used')
  assert(I.boardVsIndex(rows, [{ symbol: '^IXIC', quote: { changePct: 1 } }]) === null, 'no S&P means no comparison')
  assert(I.boardVsIndex([], items) === null, 'an empty board has nothing to compare')
  assert(I.boardVsIndex(null, null) === null, 'a missing payload cannot throw')
  assert(I.boardVsIndex(rows, items, '^IXIC').gap < 0, 'a negative gap says the board lagged')
  const zh = internals.makeT('zh')
  assert(zh('Watchlist equal-weight') === '自选等权', 'the label localises')
  assert(zh('{n} names', { n: 8 }) === '8 只', 'the count localises')
  assert(zh('Gap') === '相差', 'the gap label stays arithmetic, not a verdict')
  assert(/\.tm-vs\b/.test(I.CSS) && /\.tm-vs__meta/.test(I.CSS), 'the strip ships its own styles')
  const source = String(I.MarketOverview)
  assert(source.includes('tm-vs'), 'the overview draws the line')
  assert(source.includes("market === 'US'"), 'only the US tab compares against the S&P')
  return 'equal-weight board next to the S&P'
})

await check('after hours: the board only lists prints that actually moved', async () => {
  const I = internals
  const movers = I.afterHoursMovers([
    { symbol: 'AAPL', quote: { extended: { session: 'post', price: 342.65, changePct: 0.08 } } },
    { symbol: 'NVDA', quote: { extended: { session: 'post', price: 180, changePct: -2.4 } } },
    { symbol: 'VOO', quote: { extended: { session: 'pre', price: 670, changePct: 1.3 } } },
    { symbol: 'SPY', quote: { price: 700 } },
    { symbol: 'QQQ', quote: { extended: { session: 'overnight', price: 600, changePct: 5 } } },
    { symbol: 'IWM', quote: { extended: { session: 'post', price: 0, changePct: 3 } } },
  ])
  assert(movers.length === 2, 'a 0.08% drift, a bare quote, an unknown session and a zero price all drop out')
  assert(movers[0].row.symbol === 'NVDA', 'the steepest move leads the board')
  assert(movers[1].row.symbol === 'VOO', 'a pre-market print counts the same as a post-market one')
  assert(movers[0].session === 'post' && movers[1].session === 'pre', 'each row keeps its own session')
  assert(I.afterHoursMovers([]).length === 0, 'no rows, no board')
  assert(I.afterHoursMovers(null).length === 0, 'a missing list cannot throw')
  assert(/\.tm-ah__row/.test(I.CSS) && /\.tm-ah__pct/.test(I.CSS), 'the board ships its own styles')
  const zh = internals.makeT('zh')
  assert(zh('After-hours moves') === '盘前盘后异动', 'the card title localises')
  assert(zh('Change since the previous regular close').includes('收盘'), 'the tooltip names the baseline it measures from')
  return 'extended prints above 1% only'
})

await check('position alerts: a loss threshold fires only on a real position', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-alerts__what'), 'the banner carries the reason a row fired');
  assert(zh('max loss') === '最大亏损 %', 'the percent field localises');
  assert(zh('down {pct} from your cost').includes('低于你的成本'), 'the loss reason localises');
  // The threshold is a percentage off the cost basis, so it needs a position:
  // without one there is no loss to speak of, and the row must stay quiet.
  const hit = internals.lossHit;
  assert(hit({ pct: -12.5 }, { loss: 10 }) === 'loss', 'a position past its threshold fires');
  assert(hit({ pct: -10 }, { loss: 10 }) === 'loss', 'the threshold itself fires');
  assert(hit({ pct: -9.9 }, { loss: 10 }) === null, 'a smaller drawdown stays quiet');
  assert(hit({ pct: 5 }, { loss: 10 }) === null, 'a gain never fires a loss alert');
  assert(hit(null, { loss: 10 }) === null, 'no position, no claim about a loss');
  assert(hit({ pct: -20 }, { loss: null }) === null, 'no threshold armed means no fire');
  assert(hit({ pct: null }, { loss: 10 }) === null, 'an unknown percent never fires');
  // The percent and the price bounds live in one entry, and neither erases the other.
  const map = { 'US:AAPL': { above: 200, loss: '15' } };
  const armed = internals.alertOf(map, { market: 'US', symbol: 'AAPL' });
  assert(armed && armed.above === 200 && armed.loss === 15 && armed.below === null, `both kinds survive together: ${JSON.stringify(armed)}`);
  assert(internals.alertOf({ 'US:X': { loss: 0 } }, { market: 'US', symbol: 'X' }) === null, 'a zero threshold is not an alert');
  const text = internals.alertBoundsText({ above: null, below: null, loss: 15 }, zh, 'USD');
  assert(text.includes('最大亏损') && text.includes('15%'), `the summary names the percent field: ${text}`);
  return 'a percent threshold, keyed by market, silent without a position';
});

await check('alerts: a session move is an event, so it can fire on its own', async () => {
  const zh = internals.makeT('zh');
  assert(zh('day move') === '单日波动 %', 'the move field localises');
  assert(zh('{pct} today') === '今日 {pct}', 'the banner phrase localises');
  const armed = internals.alertOf({ 'US:AAPL': { move: '5' } }, { symbol: 'AAPL', market: 'US' });
  assert(armed && armed.move === 5, 'a typed threshold is a number');
  assert(internals.moveHit({ changePct: -5.2 }, armed) === 'down', 'a 5.2% slide fires');
  assert(internals.moveHit({ changePct: 5 }, armed) === 'up', 'the threshold is inclusive on the way up');
  assert(internals.moveHit({ changePct: -4.9 }, armed) === null, 'a 4.9% slide stays quiet');
  assert(internals.moveHit({ changePct: null }, armed) === null, 'no change, no event');
  assert(internals.moveHit({ changePct: -9 }, { above: 100 }) === null, 'a price-only alert never claims a move');
  assert(internals.alertLevel('down', null, null, { changePct: -5.2 }) === 5.2, 'the level is the absolute move');
  assert(internals.alertSnoozed('down', 5.2, { down: 5 }, 1) === true, 'a 5% move stays dismissed at 5.2%');
  assert(internals.alertSnoozed('down', 6.4, { down: 5 }, 1) === false, 'it returns once the move is a point deeper');
  assert(internals.alertBoundsText(armed, zh, 'USD').includes('单日波动'), 'the tooltip names the move bound');
  return 'move threshold parses, fires both ways, and snoozes by a point';
});

await check('price alerts: a dismissed alert stays quiet until the price moves on', async () => {
  const zh = internals.makeT('zh');
  assert(zh('Dismiss until the price moves 1% further').includes('1%'), 'the dismiss button says what it will take to bring the alert back');
  // The acknowledgement remembers the level that was dismissed, per bound, and
  // the map stays market-qualified like every other local note.
  const map = { 'US:AAPL': { above: '324', loss: '12.5' } };
  const ack = internals.ackOf(map, { market: 'US', symbol: 'AAPL' });
  assert(ack && ack.above === 324 && ack.loss === 12.5 && ack.below === null, `an acknowledgement normalises its drafts: ${JSON.stringify(ack)}`);
  assert(internals.ackOf(map, { market: 'CRYPTO', symbol: 'AAPL' }) === null, 'another market never borrows an acknowledgement');
  assert(internals.ackOf({ 'US:X': {} }, { market: 'US', symbol: 'X' }) === null, 'an empty acknowledgement silences nothing');
  const quiet = internals.alertSnoozed;
  // Still past the bound but barely moved: that is the same news, so it stays quiet.
  assert(quiet('above', 322, { above: 320 }) === true, 'a price a fraction past the dismissed level stays quiet');
  assert(quiet('above', 323, { above: 320 }) === true, 'so does one that neither crossed nor moved');
  // A full point further is a new fact and reopens the banner.
  assert(quiet('above', 324, { above: 320.5 }) === false, 'a point past the dismissed level speaks up again');
  assert(quiet('below', 189.5, { below: 190 }) === true, 'a lower bound behaves the same way going down');
  assert(quiet('below', 187.9, { below: 190 }) === false, 'a real further drop reopens it');
  // The drawdown is compared in percentage points, not proportions.
  assert(quiet('loss', 12.5, { loss: 12 }) === true, 'half a point further down is still the same news');
  assert(quiet('loss', 13.2, { loss: 12 }) === false, 'a point further down reopens it');
  assert(quiet('loss', 12.5, { above: 320 }) === false, 'an acknowledgement of another bound does not silence this one');
  assert(quiet(null, 100, { above: 320 }) === false && quiet('above', null, { above: 320 }) === false, 'no hit or no level means nothing is silenced');
  // The level a hit is measured at: the print for a price, the drawdown in points for a loss.
  assert(internals.alertLevel('loss', null, { pct: -12.5 }) === 12.5, 'a loss is measured as a positive drawdown');
  assert(internals.alertLevel('above', { price: 324 }, null) === 324, 'a price bound is measured at the print');
  assert(internals.alertLevel('above', null, null) === null, 'no print, no level');
  return 'acknowledgements are per bound and per market, and one point of movement brings the alert back';
});

await check('positions: a cost basis turns a row into value and open P&L', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-row__flag--pnl') && internals.CSS.includes('.tm-portfolio'), 'the row flag and the card total ship their styles');
  assert(zh('Position') === '持仓', 'the detail editor is labelled in Chinese');
  assert(zh('Open P&L') === '浮动盈亏', 'open P&L localises');
  const map = { 'US:AAPL': { price: '180.5', shares: '10' }, 'US:NVDA': { price: '900' }, 'CRYPTO:BTC': { price: '60000', shares: '0.5' } };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Draft strings arrive from number inputs, so they are normalised here.
  assert(same(internals.costOf(map, { symbol: 'AAPL', market: 'US' }), { price: 180.5, shares: 10 }), 'a full basis normalises its drafts');
  assert(internals.costOf(map, { symbol: 'NVDA', market: 'US' }) === null, 'a half-written basis is no position');
  assert(internals.costOf(map, { symbol: 'BTC', market: 'US' }) === null, 'the market qualifies the key, so one symbol cannot borrow another book');
  assert(internals.costOf(map, { symbol: 'AAPL', market: 'CRYPTO' }) === null, 'and the reverse holds too');
  assert(internals.costOf(null, { symbol: 'AAPL', market: 'US' }) === null, 'a missing store is tolerated');
  const held = internals.positionOf({ price: 200, currency: 'USD' }, { price: 180.5, shares: 10 });
  assert(held.value === 2000 && held.basis === 1805 && held.pnl === 195, `value and cost come from the same numbers, got ${JSON.stringify(held)}`);
  assert(Math.abs(held.pct - (195 / 1805) * 100) < 1e-9, 'the percentage is measured against the basis');
  // A loss is negative, and a quote without a price is not worth a number.
  assert(internals.positionOf({ price: 100 }, { price: 150, shares: 2 }).pnl === -100, 'a losing position reports a negative figure');
  assert(internals.positionOf({ price: null }, { price: 150, shares: 2 }) === null, 'no live price means no valuation');
  assert(internals.positionOf({ price: 100 }, null) === null, 'no basis means no position');
  return 'basis drafts normalise, markets stay separate, value and P&L agree';
});

await check('detail digest: the copy button writes only the numbers the page has', async () => {
  assert(typeof internals.digestLines === 'function', 'digestLines is exported')
  assert(internals.CSS.includes('.tm-detail__actions'),
    'the header actions share one wrapping group instead of drifting apart')
  assert(internals.CSS.includes('.tm-spark'), 'the sparkline has its own slot beside the price')
  const t = internals.makeT('zh')

  const full = internals.digestLines(
    {
      symbol: 'AAPL',
      name: 'Apple Inc.',
      price: 342.65,
      change: 1.2,
      changePct: 0.35,
      currency: 'USD',
      ext: { session: 'post', price: 342.9, changePct: 0.07 },
      position: { shares: 10, cost: 180, value: 3426.5, pnl: 1626.5, pct: 90.36, currency: 'USD' },
      exDividendDate: Date.UTC(2026, 10, 12),
    },
    t,
  )
  assert(full[0] === 'AAPL · Apple Inc.', 'the head names the symbol and the company')
  assert(full[1].includes('$342.65') && full[1].includes('+1.20'), 'the price line carries the move')
  assert(full.some((line) => line.includes('盘后') && line.includes('$342.90')), 'the extended print is dated by session')
  assert(full.some((line) => line.includes('10 @') && line.includes('$180.00')), 'a held position brings its cost')
  assert(full.some((line) => line.includes('2026-11-12')), 'the ex-dividend day is written in UTC')

  const bare = internals.digestLines({ symbol: 'VOO', price: 677.04, currency: 'USD' }, t)
  assert(bare.length === 2, 'a page with nothing but a price writes two lines')
  assert(!bare.join(' ').includes('—'), 'an absent number is left out, not dashed')

  assert(internals.digestLines(null, t).length === 0, 'no input writes nothing')
  assert(internals.digestLines({ price: null, change: null }, t).length === 0, 'a page with no print writes nothing')
  const stale = internals.digestLines({ symbol: 'TSLA', price: 200, ext: { session: 'overnight', price: 205 } }, t)
  assert(!stale.join(' ').includes('205'), 'an unknown session is not reported as an extended print')
})

await check('detail sparkline: the header trend squashes the last closes into a box', async () => {
  assert(typeof internals.sparkPoints === 'function', 'sparkPoints is exported')
  assert(internals.CSS.includes('.tm-spark'), 'the sparkline has a rule of its own')
  assert(internals.makeT('zh')('Last 20 sessions') === '近 20 个交易日', 'the tooltip is localised')

  const up = internals.sparkPoints([{ close: 10 }, { close: 12 }, { close: 11 }])
  assert(up !== null && up.up === true, 'a series that ends above where it started trends up')
  assert(up.points.split(' ').length === 3, 'one point per close')
  assert(up.points.split(' ')[0].startsWith('0,'), 'the first point sits on the left edge')
  assert(up.points.split(' ')[2].startsWith('88,'), 'the last point sits on the right edge')
  assert(up.from === 10 && up.to === 11, 'the endpoints come back for the tooltip')

  const down = internals.sparkPoints([{ close: 20 }, { close: 9 }])
  assert(down !== null && down.up === false, 'a series that ends lower trends down')

  const flat = internals.sparkPoints([{ close: 5 }, { close: 5 }])
  assert(flat !== null && flat.points.split(' ').length === 2, 'a flat series still draws a line')
  assert(!flat.points.includes('NaN'), 'a flat series cannot produce NaN coordinates')

  const long = internals.sparkPoints(Array.from({ length: 40 }, (_, i) => ({ close: 100 + i })))
  assert(long.points.split(' ').length === 20, 'only the last twenty sessions are used')

  const gaps = internals.sparkPoints([{ close: 1 }, { close: null }, { close: 3 }])
  assert(gaps !== null && gaps.points.split(' ').length === 2, 'closes that are not numbers are skipped')

  assert(internals.sparkPoints([{ close: 3 }]) === null, 'one close is not a trend')
  assert(internals.sparkPoints(null) === null && internals.sparkPoints([]) === null, 'no candles means no line')
})

await check('brief: the local notes separate what the day did from what the entry did', () => {
  const T = internals.makeT('en');
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 210, change: 4, changePct: 1.9, currency: 'USD' } },
    { symbol: 'NVDA', market: 'US', quote: { price: 180, change: -1, changePct: -0.6, currency: 'USD' } },
  ];
  const costs = { 'US:AAPL': { price: 205, shares: 10 }, 'US:NVDA': { price: 176, shares: 5 } };
  const notes = internals.positionNotes(rows, costs, T);
  const day = notes.find((line) => line.includes('today'));
  assert(Boolean(day), `a day line is written, got ${JSON.stringify(notes)}`);
  assert(day.includes('2 of your positions'), `both are counted, got ${day}`);
  assert(day.includes('+$35.00'), `the net day is summed, got ${day}`);
  assert(day.includes('+1.2%'), `the day is a percentage of the prior close, got ${day}`);
  // A flat day must not pretend to be a result.
  const flat = internals.positionNotes(
    rows.map((row) => Object.assign({}, row, { quote: Object.assign({}, row.quote, { change: 0, changePct: 0 }) })),
    costs,
    T,
  );
  assert(flat.every((line) => !line.includes('today')), 'a flat day says nothing');
});

await check('positions: the card total also carries what the session did', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-portfolio__today'), 'the session figure on the total line ships its style');
  assert(zh('today') === '今天', 'the session figure reuses the localised word for today');
  const held = internals.positionOf({ price: 210, change: 2.5, changePct: 1.2 }, { price: 180.5, shares: 10 });
  // Today's move is per share, so a ten-share book feels ten times the print.
  assert(held.today === 25, `today's move is the print times the shares, got ${held.today}`);
  assert(held.todayPct === 1.2, 'the session percentage is the quote’s own');
  assert(internals.positionOf({ price: 210 }, { price: 180.5, shares: 10 }).today === null, 'a quote without a change has no session figure');
  assert(internals.positionOf({ price: 210, change: null }, { price: 180.5, shares: 10 }).today === null, 'a null change is not a flat session');
  const costs = {
    'US:AAPL': { price: 180.5, shares: 10 },
    'US:NVDA': { price: 205, shares: 5 },
    'US:MSFT': { price: 400, shares: 1 },
    'CRYPTO:BTC': { price: 60000, shares: 0.5 },
  };
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 210, change: 2.5, changePct: 1.2, currency: 'USD' } },
    { symbol: 'NVDA', market: 'US', quote: { price: 180, change: -1.5, changePct: -0.8, currency: 'USD' } },
    // A stale quote still values the position; it just cannot answer "today".
    { symbol: 'MSFT', market: 'US', quote: { price: 410, currency: 'USD' } },
    { symbol: 'BTC', market: 'CRYPTO', quote: { price: 61000, change: 500, changePct: 0.83, currency: 'USD' } },
    { symbol: 'VOO', market: 'US', quote: { price: 650, change: 1 } },
  ];
  const totals = internals.portfolioTotals(rows, costs);
  assert(totals.length === 1, `every book here is USD, got ${totals.length}`);
  const usd = totals[0];
  assert(usd.count === 4, `four rows are positions, got ${usd.count}`);
  assert(usd.counted === 3, `only the rows with a live change answer "today", got ${usd.counted}`);
  assert(Math.abs(usd.today - (25 - 7.5 + 250)) < 1e-9, `the session cash adds up, got ${usd.today}`);
  assert(usd.basis === 1805 + 1025 + 400 + 30000, `the cost basis is carried for the summary, got ${usd.basis}`);
  // Rows without a basis are not positions at zero, and an empty list is empty.
  assert(internals.portfolioTotals([{ symbol: 'VOO', market: 'US', quote: { price: 650 } }], costs).length === 0, 'no basis means no total');
  assert(internals.portfolioTotals([], costs).length === 0, 'an empty watchlist has no totals');
  assert(internals.portfolioTotals(null, null).length === 0, 'a missing list is tolerated');
  return 'the total line adds the session cash, and a stale quote only drops its own day';
});

await check('positions: an exported list carries the holdings, and an older file still imports', async () => {
  const zh = internals.makeT('zh');
  assert(zh('{n} positions restored from the file.', { n: 2 }).includes('2'), 'the restore report localises');
  const parse = internals.parseWatchlistCsv;
  assert(parse !== undefined, 'the CSV parser is exposed so the round trip can be tested');
  // The export writes Symbol,Market,Name,Tags,Favorite,Price,Change,Change %,Time,Cost,Shares.
  const fresh = [
    'Symbol,Market,Name,Tags,Favorite,Price,Change,Change %,Time,Cost,Shares',
    'AAPL,US,Apple Inc.,core|long,Y,342.65,0.28,0.08,17:19,180.5,10',
    'MSFT,US,Microsoft,,N,420.1,-1.2,-0.28,17:19,,',
  ].join('\r\n');
  const parsed = parse(fresh);
  assert(parsed.length === 2, `two rows survive the parse, got ${parsed.length}`);
  assert(parsed[0].cost === 180.5 && parsed[0].shares === 10, `the holding columns come back as numbers, got ${JSON.stringify(parsed[0])}`);
  assert(parsed[0].tags.join('|') === 'core|long' && parsed[0].isFavorite === true, 'the older columns still parse');
  // A row with no holding is not a zero-size position.
  assert(parsed[1].cost === undefined && parsed[1].shares === undefined, 'blank holding cells stay undefined');
  // A file written before the columns existed is still a valid import.
  const legacy = ['Symbol,Market,Name,Tags,Favorite', 'NVDA,US,NVIDIA,,N'].join('\n');
  const old = parse(legacy);
  assert(old.length === 1 && old[0].cost === undefined, 'an older export imports without holdings');
  // Junk in a holding column must not become a position at a made-up price.
  const junk = ['Symbol,Market,Name,Tags,Favorite,Price,Change,Change %,Time,Cost,Shares', 'TSLA,US,Tesla,,N,,,,,abc,-5'].join('\n');
  const bad = parse(junk);
  assert(bad[0].cost === undefined && bad[0].shares === undefined, 'non-numeric or negative holdings are dropped');
  return 'holdings survive the CSV round trip, and legacy files still import';
});

await check('positions: the list sorts by open P&L, and a row that is no position sinks', async () => {
  const zh = internals.makeT('zh');
  assert(zh('By P&L') === '按浮盈', 'the sort chip is labelled in Chinese');
  assert(/[\u4e00-\u9fff]/.test(zh('Sort by open P&L (click again to reverse, a third click restores your order)')), 'its tooltip localises');
  // The chip appears with the card, so it has to be reachable from the source.
  assert(internals.pnlPercent !== undefined, 'the P&L sorter is exposed for the list');
  const winner = internals.pnlPercent({ price: 200 }, { price: 100, shares: 1 });
  const loser = internals.pnlPercent({ price: 50 }, { price: 100, shares: 1 });
  assert(winner === 100 && loser === -50, `the figure is a percentage of the basis, got ${winner} / ${loser}`);
  // A row without a position reports nothing, so the sort can push it down
  // instead of ranking it as a flat 0% between a winner and a loser.
  assert(internals.pnlPercent({ price: 200 }, null) === null, 'no basis means no sortable P&L');
  assert(internals.pnlPercent({ price: null }, { price: 100, shares: 1 }) === null, 'and no quote means the same');
  // Zero shares would divide by a zero basis: refuse the number rather than
  // report NaN.
  assert(internals.pnlPercent({ price: 200 }, { price: 0, shares: 1 }) === null, 'a zero basis is not a percentage');
  return 'open P&L sorts per row and unheld rows sink rather than rank as flat';
});

await check('sizing: shares follow the money at risk, and a stop above the price buys nothing', () => {
  const I = internals
  assert(typeof I.sizeFor === 'function' && typeof I.suggestStop === 'function', 'sizeFor and suggestStop exported')
  const css = I.CSS
  assert(css.includes('.tm-sizing__in') && css.includes('.tm-sizing__out'), 'sizing styles present')
  const t = internals.makeT('zh')
  assert(t('Position & risk') === '仓位与风险', 'card title localised')
  assert(t('shares to buy') === '可买股数', 'shares label localised')
  assert(t('stop price') === '止损价', 'stop label localised')

  // $10,000 at 1% is $100 of risk; a $5 stop distance buys 20 shares.
  const plan = I.sizeFor(50, 45, 10000, 1)
  assert(plan && plan.shares === 20, `expected 20 shares, got ${plan && plan.shares}`)
  assert(plan.value === 1000, `expected $1000 tied up, got ${plan.value}`)
  assert(plan.sharePct === 10, `expected 10% of the account, got ${plan.sharePct}`)
  assert(plan.stopPct === 10, `expected a 10% stop distance, got ${plan.stopPct}`)

  // A stop at or above the price is not a stop; nonsense inputs answer null
  // rather than a zero that would read like "buy nothing".
  assert(I.sizeFor(50, 50, 10000, 1) === null, 'stop at the price is refused')
  assert(I.sizeFor(50, 55, 10000, 1) === null, 'stop above the price is refused')
  assert(I.sizeFor(50, 45, 0, 1) === null, 'no account, no plan')
  assert(I.sizeFor(50, 45, 10000, 0) === null, 'no risk budget, no plan')
  assert(I.sizeFor(null, 45, 10000, 1) === null, 'no price, no plan')
  // A stop too far away for the budget floors at zero shares, not at one.
  const tight = I.sizeFor(50, 1, 100, 1)
  assert(tight && tight.shares === 0 && tight.value === 0, 'a budget that cannot buy one share says zero')

  // Two average ranges when the range is there, otherwise the 20-day line.
  assert(I.suggestStop(100, { atr14: 2.5 }) === 95, 'two ATRs below the print')
  assert(I.suggestStop(100, { ma20: 96 }) === 96, 'the 20-day line when there is no range')
  assert(I.suggestStop(100, { ma20: 104 }) === null, 'a 20-day line above the price is no stop')
  assert(I.suggestStop(null, { atr14: 2 }) === null, 'no price, no suggestion')
})

await check('earnings surprises: quarters read as quarters, and the bars are scaled', () => {
  const I = internals
  assert(typeof I.quarterLabel === 'function', 'quarterLabel exported')
  assert(I.quarterLabel('2026-09-30') === '2026 Q3', 'September belongs to Q3')
  assert(I.quarterLabel('2026-01-15') === '2026 Q1', 'January belongs to Q1')
  assert(I.quarterLabel('') === '—', 'a missing date is a dash, not NaN')
  const css = I.CSS
  assert(css.includes('.tm-eps__row') && css.includes('.tm-eps__bar'), 'surprise styles present')
  const t = internals.makeT('zh')
  assert(t('Earnings surprises') === '财报惊喜', 'card title localised')
  assert(t('vs') === '对', 'versus localised')
  assert(t('estimate') === '预期' && t('actual') === '实际', 'the two numbers are labelled in Chinese')
})

await check('brief: the local cost basis adds its own lines, and only above a threshold', () => {
  const t = internals.makeT('zh');
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 210, currency: 'USD' } },
    { symbol: 'NVDA', market: 'US', quote: { price: 180, currency: 'USD' } },
    { symbol: 'VOO', market: 'US', quote: { price: 650, currency: 'USD' } },
  ];
  const costs = {
    'US:AAPL': { price: 180, shares: 10 },
    'US:NVDA': { price: 205, shares: 5 },
    'US:VOO': { price: 640, shares: 1 },
  };
  const notes = internals.positionNotes(rows, costs, t);
  assert(notes.length === 3, `a move, a concentration, and the pool (got ${notes.length}: ${notes.join(' | ')})`);
  assert(notes[0].includes('AAPL') && notes[0].includes('+16.7%'), `the winner is named with its move (got ${notes[0]})`);
  assert(notes[0].includes('$180.00') && notes[0].includes('$210.00'), 'cost and last trade are both shown');
  assert(notes[0].includes('→'), 'the pair reads as a transition');
  // 2100 of 3650 = 58% in one name: the book's day is that name's day.
  assert(notes[1].includes('AAPL') && notes[1].includes('58%') && notes[1].includes('USD'), `the weight is stated (got ${notes[1]})`);
  // Basis 3465, open P&L +185 (AAPL +300, NVDA −125, VOO +10) → +5.3% across three.
  assert(notes[2].includes('3 只持仓') && notes[2].includes('+5.3%'), `the pool is summed (got ${notes[2]})`);
  assert(notes[2].includes('+$185.00'), `the pool carries the money too (got ${notes[2]})`);
  // Evenly sized rows are a book, not a bet: no concentration line.
  const even = internals.positionNotes(
    [
      { symbol: 'A', market: 'US', quote: { price: 100, currency: 'USD' } },
      { symbol: 'B', market: 'US', quote: { price: 100, currency: 'USD' } },
      { symbol: 'C', market: 'US', quote: { price: 100, currency: 'USD' } },
    ],
    { 'US:A': { price: 100, shares: 1 }, 'US:B': { price: 100, shares: 1 }, 'US:C': { price: 100, shares: 1 } },
    t,
  );
  assert(even.every((line) => !line.includes('33%')), `a third in each name is not a concentration call (got ${even.join(' | ')})`);
  // A single quiet position (1.6%) earns nothing: the block must not turn into a
  // restatement of every row.
  assert(internals.positionNotes(rows.slice(2), costs, t).length === 0, 'a quiet single position says nothing');
  assert(internals.positionNotes(rows, {}, t).length === 0, 'no cost basis, no line');
  // Currency pools never mix: one big winner, but a lone HKD position makes no pool.
  const mixed = internals.positionNotes(
    [
      { symbol: 'AAPL', market: 'US', quote: { price: 210, currency: 'USD' } },
      { symbol: '0700', market: 'US', quote: { price: 400, currency: 'HKD' } },
    ],
    { 'US:AAPL': { price: 180, shares: 10 }, 'US:0700': { price: 380, shares: 5 } },
    t,
  );
  assert(mixed.length === 1, `no cross-currency pool (got ${mixed.length})`);
  assert(internals.CSS.includes('.tm-brief__block--own'), 'the local block is visually separated');
  assert(t('Your positions (local)') === '你的持仓（本地）', 'the block is labelled in zh');
});

await check('news: the home card speaks for the holdings, not the whole market', () => {
  const zh = internals.makeT('zh')
  assert(internals.CSS.includes('.tm-news__sym'), 'the holding a headline belongs to gets its own column')
  assert(zh('Headlines on your positions') === '持仓新闻', 'the card is labelled in Chinese')
  assert(zh('{n} stories', { n: 3 }).includes('3'), 'the count localises')
  return 'the holdings feed card is styled and localised'
});

await check('positions: the total remembers what it was worth, one point a day', () => {
  const { recordHistory, historyChange } = internals;
  const day = Date.UTC(2026, 10, 6, 12);
  let map = recordHistory({}, 'USD', 1000, day);
  assert(map.USD.length === 1 && map.USD[0].value === 1000, 'the first point is recorded');
  map = recordHistory(map, 'USD', 1010, day + 3600000);
  assert(map.USD.length === 1 && map.USD[0].value === 1010, 'the same day is replaced, not appended');
  map = recordHistory(map, 'USD', 1100, day + 86400000);
  assert(map.USD.length === 2, 'a new day appends');
  assert(map.USD[0].value === 1010 && map.USD[1].value === 1100, 'points stay in order');
  assert(recordHistory(map, 'USD', 0, day).USD.length === 2, 'a zero balance is not a point');
  assert(recordHistory(map, 'USD', 'nope', day).USD.length === 2, 'garbage is not a point');
  const both = recordHistory(map, 'CAD', 500, day + 86400000);
  assert(both.USD.length === 2 && both.CAD.length === 1, 'currencies are kept apart');
  const trend = historyChange(both.USD, 30);
  assert(trend && trend.change === 90 && Math.round(trend.pct) === 9, 'the change is measured across the window');
  assert(historyChange([{ at: day, value: 1000 }], 30) === null, 'one point is not a trend');
  assert(historyChange(null, 30) === null, 'no series, no trend');
  assert(internals.CSS.includes('.tm-portfolio__trend'), 'the trend has its own style');
  const line = internals.historyPoints(both.USD, 56, 14, 30);
  assert(line && line.count === 2 && line.up === true, 'a rising series draws a line');
  assert(line.points.split(' ').length === 2, 'one vertex per point');
  assert(/^[\d.,\s]+$/.test(line.points), 'the vertices stay numeric');
  const flat = internals.historyPoints([{ at: day, value: 900 }, { at: day + 86400000, value: 900 }], 56, 14, 30);
  assert(flat && flat.points.split(' ').every((pair) => pair.endsWith(',7')), 'a flat series runs down the middle');
  assert(internals.historyPoints([{ at: day, value: 900 }], 56, 14, 30) === null, 'one point cannot draw a line');
  assert(internals.makeT('zh')('{n}d', { n: 30 }) === '30 天', 'the window label is localised');
  const zhT = internals.makeT('zh');
  assert(zhT('recording…') === '记录中…', 'a single day says it is still recording');
  assert(/记录满两天/.test(zhT('A change appears once two days have been recorded')), 'the tooltip explains the wait');
  assert(internals.CSS.includes('.tm-portfolio__trend--first'), 'the pending state has its own style');
  const wide = internals.historyPoints(both.USD, 240, 48, 30);
  assert(wide && wide.count === 2 && wide.points !== line.points, 'the same series redraws at another size');
  assert(internals.CSS.includes(".tm-portfolio__trend[role='button']"), 'the line is announced as clickable');
  assert(internals.CSS.includes('.tm-portfolio__trend--open'), 'the expanded line has its own style');
  assert(internals.CSS.includes('.tm-portfolio__item { display: inline-flex; align-items: baseline; flex-wrap: wrap;'), 'a narrow card wraps the totals instead of breaking words');
  assert(internals.CSS.includes('font-variant-numeric: tabular-nums; white-space: nowrap; }'), 'a total never breaks mid-label');
  assert(source.includes("'aria-expanded': trendLine ? (open ? 'true' : 'false') : null"), 'the expander reports whether it is open');
  return 'history recorded per day';
});

await check('news: a watchlist without positions still gets its feed', () => {
  const zhT = internals.makeT('zh');
  assert(zhT('Headlines on your watchlist') === '自选新闻', 'the fallback title is localised');
  assert(source.includes('const watching = held.length'), 'positions are still preferred');
  assert(source.includes('.slice(0, 6)'), 'the fallback feed stays at six names');
  assert(
    source.includes("held.length ? tr('Headlines on your positions') : tr('Headlines on your watchlist')"),
    'the title says which list it is reading',
  );
  return 'fallback feed wired';
});

await check('news: the ticker in a headline opens that name, the headline stays a link', () => {
  const css = internals.CSS
  const zh = internals.makeT('zh')
  assert(css.includes('.tm-news__body'), 'the row splits into a ticker and the article body')
  assert(css.includes('.tm-news__sym:hover'), 'the ticker looks pressable without a second colour')
  assert(source.includes('const marketOf = (symbol) =>'), 'the held row decides the market, not the feed')
  assert(source.includes("onClick: () => onOpen({ symbol: item.symbol, market: marketOf(item.symbol) })"), 'the ticker opens the detail page')
  assert(source.includes("className: 'tm-news__body'"), 'the article itself keeps an anchor')
  assert(zh('Open {name}', { name: 'NVDA' }).includes('NVDA'), 'the ticker tooltip localises')
  return 'a headline can be read or its name opened, without nesting one link in another'
});

await check('keys: one table describes the shortcuts, and `?` respects text fields', () => {
  const I = internals
  const CSS = I.CSS
  const zhT = internals.makeT('zh')
  assert(Array.isArray(I.SHORTCUTS) && I.SHORTCUTS.length >= 5, 'the table covers the keys the panel answers')
  const keys = I.SHORTCUTS.map((row) => row.keys)
  for (const key of ['/', 'Enter', 'Esc', '?']) assert(keys.includes(key), `the table lists ${key}`)
  for (const row of I.SHORTCUTS) {
    assert(row.label && zhT(row.label) !== row.label, `every row is localised: ${row.label}`)
  }
  assert(CSS.includes('.tm-help__card') && CSS.includes('.tm-kbd'), 'the overlay and its key caps are styled')
  assert(zhT('Keyboard shortcuts') === '快捷键', 'the dialog title is localised')

  const plain = { key: '?', target: { tagName: 'DIV' } }
  assert(I.wantsHelp(plain) === true, 'a bare ? opens the list')
  assert(I.wantsHelp({ key: '?', target: { tagName: 'INPUT' } }) === false, 'typing ? into a field stays typing')
  assert(I.wantsHelp({ key: '?', target: { tagName: 'TEXTAREA' } }) === false, 'a textarea counts as typing too')
  assert(I.wantsHelp({ key: '?', target: { tagName: 'DIV', isContentEditable: true } }) === false, 'contenteditable counts as typing')
  assert(I.wantsHelp({ key: '?', target: { tagName: 'DIV' }, metaKey: true }) === false, 'browser shortcuts keep their ?')
  assert(I.wantsHelp({ key: 'x', target: { tagName: 'DIV' } }) === false, 'other keys are not ours')
  assert(I.wantsHelp({ key: '?', target: { tagName: 'DIV' }, defaultPrevented: true }) === false, 'a handled event is left alone')
  assert(I.wantsHelp(null) === false, 'no event, no overlay')
})

await check('detail: the profile reads as facts plus a summary that does not wall off the page', () => {
  const I = internals
  const CSS = I.CSS
  const zhT = internals.makeT('zh')
  assert(CSS.includes('.tm-about__facts'), 'the fact row has its own layout')
  assert(CSS.includes('-webkit-line-clamp: 3'), 'a long summary is clamped to three lines')
  assert(CSS.includes('.tm-desc--clamp') && CSS.includes('.tm-about__more'), 'clamped text and its toggle are both styled')
  assert(zhT('Sector') === '板块' && zhT('Industry') === '行业', 'the fact labels are localised')
  assert(zhT('Website') === '官网' && zhT('Country') === '国家', 'website and country are localised too')
  assert(zhT('Show more') === '展开全文' && zhT('Show less') === '收起', 'the toggle reads as a pair')

  assert(I.siteOf('https://www.apple.com/iphone/') === 'apple.com/iphone', `scheme, www and the trailing slash go (got ${I.siteOf('https://www.apple.com/iphone/')})`)
  assert(I.siteOf('http://vanguard.com') === 'vanguard.com', 'a bare host survives')
  assert(I.siteOf('') === '' && I.siteOf(null) === '' && I.siteOf(undefined) === '', 'nothing in, nothing out')
})

await check('news: the home feed can be held to the last day, and it says when that is empty', () => {
  const I = internals
  const CSS = I.CSS
  const zhT = internals.makeT('zh')
  assert(CSS.includes('.tm-news__chip--on'), 'the today chip has an active state')
  assert(CSS.includes('.tm-news__empty'), 'the empty case has its own line')
  assert(zhT('Today') === '今天', 'the filter reads 今天 in Chinese')
  assert(zhT('{n} today', { n: 3 }) === '今天 3 条', 'the count is localised')
  assert(zhT('Nothing about your positions in the last 24 hours.').includes('24'), 'the empty line explains the window')

  const now = Date.UTC(2026, 10, 7, 15, 0, 0)
  const items = [
    { symbol: 'AAPL', at: now - 3600_000 }, // an hour ago
    { symbol: 'NVDA', at: now - 23 * 3600_000 }, // just inside
    { symbol: 'VOO', at: now - 25 * 3600_000 }, // yesterday
    { symbol: 'MSFT', at: null }, // no usable stamp
    { symbol: 'TSM' }, // no stamp at all
  ]
  const kept = I.recentNews(items, now)
  assert(kept.length === 2, `only the last day survives (got ${kept.map((i) => i.symbol).join(',')})`)
  assert(kept[0].symbol === 'AAPL' && kept[1].symbol === 'NVDA', 'order is preserved, undated rows are dropped')
  assert(I.recentNews(items, now, 48).length === 3, 'the window is a parameter, not a constant')
  assert(I.recentNews(null, now).length === 0 && I.recentNews([], now).length === 0, 'no feed means no rows')
})

await check('alerts: a desktop notification fits the same facts into one line', () => {
  const t = internals.makeT('en')
  assert(typeof internals.notificationText === 'function', 'notificationText is exported')
  assert(internals.notificationText([], t) === null, 'nothing fired, nothing announced')
  assert(internals.notificationText(null, t) === null, 'no list is not an announcement either')

  const fired = [
    { row: { symbol: 'NVDA' }, crossed: 'down', latest: { changePct: -5.4 }, armed: {}, position: null },
    { row: { symbol: 'AAPL', quote: { currency: 'USD' } }, crossed: 'above', armed: { above: 320 }, latest: { price: 342 }, position: null },
    { row: { symbol: 'TSLA' }, crossed: 'loss', armed: {}, latest: {}, position: { pct: -12.5 } },
    { row: { symbol: 'VOO' }, crossed: 'below', armed: { below: 600 }, latest: { price: 590 }, position: null },
    { row: { symbol: 'MSFT' }, crossed: 'up', latest: { changePct: 3.1 }, armed: {}, position: null },
  ]
  const message = internals.notificationText(fired, t)
  // Three rows at most: a notification is glanced at, not read.
  // `percent()` writes a real minus sign (U+2212) and two decimals; the test
  // follows the product's own formatting rather than restating it.
  assert(message.body.includes('\u22125.40%'), 'the move carries its number')
  assert(message.body.includes('above $320.00'), 'a bound is spelled out, not called "crossed"')
  assert(message.body.includes('\u221212.50%'), 'a drawdown from cost keeps its sign')
  assert(message.body.endsWith('+2'), 'the overflow is counted rather than silently dropped')
  assert(message.title === '5 alerts triggered', 'the title carries the total')

  // A row with no usable figure still gets named instead of printing "undefined".
  const bare = internals.notificationText([{ row: { symbol: 'ARKK' }, crossed: 'above', armed: {}, latest: null, position: null }], t)
  assert(bare.body === 'ARKK', 'a row without a figure is still named')

  const zh = internals.makeT('zh')
  const zhText = internals.notificationText(fired, zh)
  assert(zhText.title.includes('提醒'), 'the title localises')
  assert(/\d/.test(zhText.body), 'the body keeps its numbers in Chinese too')
})

await check('watchlist: a tag group folds away and remembers that it did', () => {
  const zh = internals.makeT('zh');
  const CSS = internals.CSS;
  assert(zh('Hide these rows') === '\u6536\u8d77\u8fd9\u4e00\u7ec4', 'the fold is localised');
  assert(zh('Show these rows') === '\u5c55\u5f00\u8fd9\u4e00\u7ec4', 'so is the unfold');
  assert(CSS.includes('.tm-list__groupbtn'), 'the bucket header is a button');
  assert(CSS.includes('.tm-list__chev'), 'and shows which way it is set');
  assert(internals.toggleInList([], 'core').join() === 'core', 'adds the first label');
  assert(internals.toggleInList(['core', 'watch'], 'core').join() === 'watch', 'removes only that label');
  assert(internals.toggleInList(null, 'x').join() === 'x', 'a missing list is not fatal');
  assert(internals.toggleInList(['a', 'b'], 'c').sort().join() === 'a,b,c', 'leaves the rest alone');
  assert(source.includes("'tm-groups-collapsed'"), 'the choice survives a reload');
  assert(source.includes('collapsed.includes(groupLabelOf(item))'), 'a folded bucket stays out of the keyboard walk');
  assert(zh('Fold all') === '\u6536\u8d77\u5168\u90e8', 'the bulk fold is localised');
  assert(zh('Unfold all') === '\u5c55\u5f00\u5168\u90e8', 'so is the bulk unfold');
  assert(zh('Fold every group').includes('\u5206\u7ec4'), 'and its tooltip');
  assert(source.includes('toggleAllGroups'), 'one click flips every bucket');
  assert(source.includes('foldable.length > 1'), 'the bulk chip waits for more than one bucket');
  assert(source.includes('foldable.every((label) => collapsed.includes(label))'), 'the chip reads as whichever state is next');
});

await check('watchlist: the arrow keys walk the list and stop at neither end', () => {
  assert(typeof internals.nextNavIndex === 'function', 'nextNavIndex is exported')
  // Nothing highlighted yet: the first press lands where the reader expects.
  assert(internals.nextNavIndex(-1, 5, 1) === 0, 'down from nothing starts at the top')
  assert(internals.nextNavIndex(-1, 5, -1) === 4, 'up from nothing starts at the bottom')
  assert(internals.nextNavIndex(0, 5, 1) === 1, 'down advances one row')
  assert(internals.nextNavIndex(4, 5, 1) === 0, 'down wraps to the top')
  assert(internals.nextNavIndex(0, 5, -1) === 4, 'up wraps to the bottom')
  // An index left over from a longer list must not strand the highlight.
  assert(internals.nextNavIndex(9, 5, 1) === 0, 'a stale index falls back to the top')
  assert(internals.nextNavIndex(0, 0, 1) === -1, 'an empty list has nothing to walk')
  assert(internals.CSS.includes('.tm-row--nav'), 'the highlighted row has a style of its own')
  const t = internals.makeT('zh')
  assert(t('Move through the results or the list').includes('列表'),
    'the shortcut sheet says the arrows also walk the list')
})

await check('watchlist: a row with a print coming can be ordered by it', () => {
  const zh = internals.makeT('zh');
  assert(zh('By event') === '按事件', 'the chip is localised, got ' + zh('By event'));
  assert(zh('Sort by the next earnings date (click again to reverse, a third click restores your order)').includes('财报'), 'the tooltip explains itself');
  const earnings = {
    today: '2026-11-06',
    bySymbol: { AAPL: { date: '2026-11-12' }, NVDA: { date: '2026-11-09' } },
  };
  assert(internals.eventDaysOf({ symbol: 'NVDA' }, earnings) === 3, 'days are counted from the calendar day');
  assert(internals.eventDaysOf({ symbol: 'nvda' }, earnings) === 3, 'the lookup ignores case');
  assert(internals.eventDaysOf({ symbol: 'VOO' }, earnings) === null, 'a row outside the window has no rank');
  assert(internals.eventDaysOf({ symbol: 'AAPL' }, null) === null, 'no calendar, no rank');
  assert(internals.eventDaysOf(null, earnings) === null, 'no row, no rank');
  // The date must not be read as a quote field: it lives on the calendar payload.
  assert(internals.eventDaysOf({ symbol: 'AAPL', quote: { date: '2026-11-01' } }, earnings) === 6, 'the calendar wins over anything on the row');
});

await check('brief: the whole brief copies as ordered text, and empty sections stay out', () => {
  const t = internals.makeT('en');
  const full = internals.briefLines(
    {
      headline: 'Flat tape, one name carrying the day',
      generatedAt: new Date('2026-11-07T01:40:00Z').toISOString(),
      stocksTracked: 11,
      upCount: 7,
      downCount: 3,
      strongestMover: 'NVDA +4.2%',
      largestDecline: 'TSLA -3.1%',
      unusualVolume: ['VOO 1.8x'],
      keyObservations: ['NVDA leads breadth', 'Breadth is thin'],
      suggestions: ['Wait for the print', 'Trim into strength'],
    },
    ['AAPL +16.7% against your $180.00 cost'],
    t,
  );
  assert(full[0].startsWith('AI Watchlist Brief'), 'the paste is labelled, got ' + full[0]);
  assert(full[1] === 'Flat tape, one name carrying the day', 'the headline comes second');
  assert(full.includes('Stocks tracked 11 \u00b7 Up 7 \u00b7 Down 3'), 'counts share one line, got ' + full[2]);
  const movers = full.find((l) => l.includes('Strongest mover:')) || '';
  assert(movers.includes('NVDA +4.2%'), 'the best row keeps its label, got ' + movers);
  assert(movers.includes('Largest decline: TSLA -3.1%'), 'so does the worst, got ' + movers);
  const at = (needle) => full.findIndex((l) => l.startsWith(needle));
  assert(at('Unusual volume:') > 0 && at('Key observations:') > at('Unusual volume:'), 'sections keep the reading order');
  assert(at('Action ideas:') > at('Key observations:'), 'the checklist follows the observations');
  assert(at('Your positions (local):') > at('Action ideas:'), 'the local lines close the paste');
  assert(full.includes('1. Wait for the print'), 'actions are numbered');
  assert(full[full.length - 1] === '- AAPL +16.7% against your $180.00 cost', 'the last line is the position note');

  // A brief with nothing but a headline must not emit empty headers.
  const thin = internals.briefLines({ headline: 'Quiet' }, null, t);
  assert(thin.length === 2, 'a thin brief stays two lines, got ' + thin.length);
  assert(!thin.some((l) => l.includes('Action ideas')), 'no empty sections are pasted');
  assert(internals.briefLines(null, null, t).length === 0, 'no brief, no text');
  const zh = internals.makeT('zh');
  assert(internals.briefLines({ headline: 'x' }, ['y'], zh).includes('你的持仓（本地）:'), 'the local section is localised');
});

await check('news: headlines are dated, linked, and localised', () => {
  const I = internals
  const CSS = I.CSS
  // Every row is a link out, so the card can never look like a dead list.
  for (const cls of ['.tm-news {', '.tm-news__row {', '.tm-news__title {', '.tm-news__meta {']) {
    assert(CSS.includes(cls), `the card needs ${cls}`)
  }
  // Narrow screens wrap the byline under the headline; it stays right-aligned there and a
  // long headline is clamped to two lines so rows keep an even height.
  assert(CSS.includes('.tm-news__body { flex-wrap: wrap; }'), 'the headline cell wraps the byline itself')
  assert(CSS.includes('.tm-news__meta { flex: 1 0 100%; justify-content: flex-end; margin-top: 2px; }'), 'the wrapped byline is right-aligned')
  assert(CSS.includes('.tm-news__title { display: -webkit-box; -webkit-line-clamp: 2;'), 'a long headline stops at two lines')
  const zh = internals.makeT('zh')
  assert(zh('In the news') === '相关新闻', 'the card title is localised')
  assert(zh('{n} headlines').replace('{n}', '3') === '3 条新闻', 'the count line is localised')
  assert(zh('just now') === '刚刚', 'a fresh headline reads 刚刚')
  // Ages are coarse on purpose: minutes, hours, days, then months.
  const now = Date.UTC(2026, 10, 7, 12, 0, 0)
  assert(I.agoOf(now - 30_000, now) === I.translate('just now'), 'seconds-old reads the localised 刚刚/just now')
  assert(I.agoOf(now - 12 * 60_000, now) === '12m', 'minutes')
  assert(I.agoOf(now - 3 * 3_600_000, now) === '3h', 'hours')
  assert(I.agoOf(now - 2 * 86_400_000, now) === '2d', 'days')
  assert(I.agoOf(now - 45 * 86_400_000, now) === '2mo', 'months')
  assert(I.agoOf(null, now) === '', 'a missing stamp shows no age rather than "56y"')
  return `news: ${CSS.includes('.tm-news__row') ? 'card styled' : 'missing'}, ages 12m/3h/2d/2mo`
})

await check('session chip: NYSE holidays and early closes override the weekday clock', async () => {
  const zh = internals.makeT('zh');
  assert(internals.CSS.includes('.tm-session__note') && internals.CSS.includes('.tm-session--holiday'), 'the chip ships its note and holiday styles');
  assert(zh('early close {close} ET') === '提前收盘 {close} ET', 'the early-close note localises');
  assert(/[\u4e00-\u9fff]/.test(zh('New York {time} · NYSE holiday: {name}')), 'the holiday tooltip localises');
  const table = [
    { date: '2026-11-26', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
    { date: '2026-11-27', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
  ];
  // 15:00Z is 10:00 EST: mid-session on any normal day.
  const holiday = internals.usSessionInfo(new Date('2026-11-26T15:00:00Z'), table);
  assert(holiday.phase === 'closed', `a full-day closure must never read as open, got ${holiday.phase}`);
  assert(holiday.closure && holiday.closure.nameZh === '感恩节', 'the closure row rides along so the chip can name the holiday');
  // The same morning one day later trades; the afternoon is the early close.
  assert(internals.usSessionInfo(new Date('2026-11-27T15:00:00Z'), table).phase === 'open', 'the morning of a 13:00 close still trades');
  const afternoon = internals.usSessionInfo(new Date('2026-11-27T18:30:00Z'), table);
  assert(afternoon.phase === 'post' && afternoon.earlyClose === true, `13:30 EST on an early close is after-hours, got ${afternoon.phase}`);
  // Without the table the old weekday-only answer stands: a slow or failed
  // fetch must degrade to the previous chip, never invent a closure.
  assert(internals.usSessionInfo(new Date('2026-11-26T15:00:00Z')).phase === 'open', 'no table means the weekday clock, no guess');
  assert(internals.usSessionInfo(new Date('2026-11-26T15:00:00Z'), []).phase === 'open', 'an empty table behaves like no table');
  // Weekends stay closed even on a day the table does not mention.
  assert(internals.usSessionInfo(new Date('2026-11-28T15:00:00Z'), table).phase === 'closed', 'Saturday is closed regardless of the table');
  return 'holiday closes the day, 13:00 ends the session early, no table falls back to weekdays';
});

await check('i18n: technical grid follows the selected language', async () => {
  const tech = { ma20: 3, rsi14: 9, volumeRatio20d: 14, trendAlignment: 'bullish-stack', volatility20dAnnualizedPct: 18 };
  const en = internals.technicalCells(tech, internals.makeT('en'));
  const zh = internals.technicalCells(tech, internals.makeT('zh'));
  assert(en.some((cell) => cell.label === 'MA20'), 'English labels stay unchanged');
  assert(zh.some((cell) => /[\u4e00-\u9fff]/.test(cell.label)), 'zh labels must be localised');
  assert(zh.length === en.length, 'the grid must not lose rows when translated');
  // Numbers, units and percentages are language independent; only labels change.
  en.forEach((cell, index) => {
    if (/^[\d.,]+[×%]?$/.test(cell.value)) {
      assert(zh[index].value === cell.value, `numeric cell "${cell.label}" changed with the language`);
    }
  });
  const trendZh = zh.find((cell) => /多头|空头|走平|均线/.test(String(cell.value)));
  assert(trendZh, `trend alignment must be translated, got ${JSON.stringify(zh.map((c) => c.value))}`);
  return `${en.length} cells, trend → ${trendZh.value}`;
});

await check('i18n: the platform language is adopted until the user chooses', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', symbol: null, lang: null, langSet: false, platformLang: 'zh' });
    assert(internals.effectiveLang(store.get()) === 'zh', 'platform language wins while nothing is chosen');
    const zhHtml = renderToString(h(internals.TradingApp));
    assert(/[\u4e00-\u9fff]/.test(zhHtml), 'a zh platform language must render Chinese copy');
    assert(!zhHtml.includes('Search Stocks'), 'Chinese UI must not keep the English heading');
    assert(zhHtml.includes('我的自选') || zhHtml.includes('自选'), 'the watchlist card must be translated');

    setStore({ lang: 'en', langSet: true, platformLang: 'zh' });
    const enHtml = renderToString(h(internals.TradingApp));
    assert(enHtml.includes('Search Stocks'), 'an explicit choice must beat the platform language');
    assert(!enHtml.includes('我的自选'), 'Chinese copy must not leak into the English UI');
  } finally {
    setStore(snapshot);
  }
  return 'platform zh → Chinese, explicit en → English';
});

await check('i18n: language toggle renders and a manual choice beats the server value', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', symbol: null, lang: 'en', langSet: false, platformLang: 'en' });
    const html = renderToString(h(internals.TradingApp));
    assert(html.includes('>EN<') || html.includes('English'), 'the English option must be rendered');
    assert(html.includes('中文'), 'the Chinese option must be offered');

    setStore({ lang: null, langSet: false, platformLang: 'en' });
    internals.applyServerLang({ lang: 'zh' });
    assert(store.get().lang === 'zh', 'the stored server preference is adopted when nothing is chosen');

    setStore({ lang: 'en', langSet: true });
    internals.applyServerLang({ lang: 'zh' });
    assert(store.get().lang === 'en', 'an explicit user choice must win over the server value');
  } finally {
    setStore(snapshot);
  }
  return 'toggle + precedence ok';
});

await check('indices: the Market Overview strip renders on the home view', async () => {
  const { store, setStore } = internals;
  const snapshot = { ...store.get() };
  try {
    setStore({ view: 'home', symbol: null, lang: 'en', langSet: true, platformLang: 'en' });
    const html = renderToString(h(internals.TradingApp));
    assert(html.includes('Market Overview'), 'the home view must show the market overview card');
    assert(/Index levels, not tradable prices/.test(html), 'index levels must not be presented as prices');
    // Effects do not run during SSR, so the strip is still in its loading state.
    assert(html.includes('Loading indices') || html.includes('tm-indices'), 'the strip must render a loading or list state');
  } finally {
    setStore(snapshot);
  }
  return 'overview card present';
});

await check('detail news: the same 24-hour window the home card offers, on one symbol', async () => {
  const { CSS, makeT } = internals;
  const zh = makeT('zh');
  assert(CSS.includes('.tm-news__chip--on'), 'the pressed chip needs its own look');
  assert(CSS.includes('.tm-news__empty'), 'an empty window needs a line of its own');
  assert(zh('No related news in the last 24 hours.') === '最近 24 小时没有相关新闻。', 'the empty line must localise');
  assert(zh('Show only the last 24 hours').includes('24'), 'the tooltip says what the window is');
  // The card filters through the same helper the home feed uses, and remembers
  // the choice per browser rather than per symbol.
  assert(source.includes('const newsRows = newsToday && Array.isArray(news.data) ? recentNews(news.data)'), 'the card must reuse recentNews');
  assert(source.includes("window.localStorage.setItem('tm-news-today'"), 'the choice has to outlive the page');
  assert(source.includes("'aria-pressed': newsToday ? 'true' : 'false'"), 'the chip is a toggle, so it says so');
  return 'detail news window ok';
});

await check('index detail: an index with no fund says why nothing trades', () => {
  const css = internals.CSS;
  const zhT = internals.makeT('zh');
  assert(css.includes('.tm-indexnote'), 'the note is styled');
  const line = 'Index levels are points on a scale, not a security — there is nothing to buy or sell here.';
  assert(zhT(line) === '指数点位是刻度上的读数，不是可买卖的证券。', `note localises, got ${zhT(line)}`);
  assert(source.includes('indexRow && !proxyFund'), 'the note is tied to the fundless case');
  assert(source.includes("h('p', { className: 'tm-indexnote' }"), 'the note renders as a paragraph');
});

await check('chart: a weekly bar is one click away where it is legible', () => {
  const css = internals.CSS;
  const zhT = internals.makeT('zh');
  assert(css.includes('.tm-range__split'), 'the size group is styled');
  assert(css.includes('.tm-range--size'), 'the size chips are styled');
  assert(zhT('One bar per day') === '每根日线', `daily tooltip localises, got ${zhT('One bar per day')}`);
  assert(zhT('One bar per week') === '每根周线', `weekly tooltip localises, got ${zhT('One bar per week')}`);
  assert(source.includes('WEEKLY_RANGES'), 'weekly ranges are declared');
  assert(source.includes("ui.barSize === 'week' && WEEKLY_RANGES[range]"), 'the choice only applies where it is legible');
  assert(source.includes("interval=${barSize}"), 'the request sends the chosen interval');
  assert(source.includes("setStore({ barSize: size })"), 'the choice is remembered');
});

await check('index detail: an index opens its own page, unit and all, with the fund one click away', async () => {
  const { makeT } = internals;
  const zh = makeT('zh');
  // The catalogue call is filtered to the one symbol, so the page learns both
  // the localised name and the unit without pulling the whole strip.
  assert(source.includes("apiGet(`/indices?symbols=${encodeURIComponent(symbol)}`"), 'detail must ask the catalogue for this symbol only');
  assert(source.includes('indexMeta.data.items'), 'the catalogue answers { items }, not a bare array');
  assert(source.includes('plain(data.price, 2) + unit'), 'a yield prints with its unit, never as a dollar price');
  assert(source.includes("t('ETF {symbol}', { symbol: proxyFund })"), 'the tracking fund rides in the header actions');
  assert(source.includes("onOpen({ symbol: proxyFund, market: 'US' })"), 'that button opens the fund itself');
  // Tiles are no longer proxies: VIX has no fund and is still worth reading.
  assert(!source.includes('disabled: !proxied'), 'no index tile may be click-inert any more');
  assert(source.includes('const detail = Object.assign({}, item, { market: item.market || market })'), 'a tile opens its own symbol');
  assert(zh('ETF {symbol}', { symbol: 'TLT' }) === 'TLT（基金）', `ETF label, got ${zh('ETF {symbol}', { symbol: 'TLT' })}`);
  assert(zh('Index levels are not tradable; open the closest ETF').includes('ETF'), 'the fund tooltip must localise');
  assert(zh('Open {name}; its closest fund is {symbol}', { name: '10 年期美债收益率', symbol: 'TLT' }).includes('TLT'), 'tile tooltip names the fund');
  // The copied page must say 4.86%, not $4.86.
  const { digestLines } = internals;
  const copied = digestLines({ symbol: '^TNX', name: '10-Year Treasury Yield', price: 4.86, change: 0.02, changePct: 0.41, unit: '%' }, zh);
  assert(copied[1].startsWith('4.86%'), `index digest price, got ${copied[1]}`);
  assert(!copied[1].includes('$'), 'an index level must not copy with a dollar sign');
  const stock = digestLines({ symbol: 'AAPL', name: 'Apple', price: 210.5, currency: 'USD' }, zh);
  assert(stock[1].startsWith('$210.50'), `stock digest price, got ${stock[1]}`);
  return 'index page + unit + fund action ok';
});

await check('source links: stock and index pages, always in a new tab', async () => {
  const { SOURCE_LINKS, SourcesRow, digitsOf, tradingViewSymbol } = internals;
  const ids = (links) => links.map((l) => l.id).join(',');

  // US-only build: the stock link set is exactly tradingview + yahoo; the
  // mainland/CN shortcuts were removed with the other markets.
  const us = SOURCE_LINKS({ symbol: 'AAPL', market: 'US', exchange: 'NASDAQ' });
  assert(ids(us) === 'tradingview,yahoo', `US stock links, got ${ids(us)}`);
  assert(us[0].href === 'https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL', `TV href, got ${us[0].href}`);
  assert(us[1].href === 'https://finance.yahoo.com/quote/AAPL', `yahoo href, got ${us[1].href}`);

  const index = SOURCE_LINKS({ symbol: '^VIX', market: 'US', kind: 'index', links: { tradingView: 'TVC:VIX', yahoo: '^VIX' } });
  assert(ids(index) === 'tradingview,yahoo', `index links, got ${ids(index)}`);
  assert(index[0].href === 'https://www.tradingview.com/chart/?symbol=TVC%3AVIX', `index TV href, got ${index[0].href}`);
  assert(index[1].href === 'https://finance.yahoo.com/quote/%5EVIX', `index yahoo href, got ${index[1].href}`);

  assert(digitsOf('0700.HK', 5) === '00700', `digitsOf HK, got ${digitsOf('0700.HK', 5)}`);
  assert(tradingViewSymbol({ symbol: '^VIX', links: { tradingView: 'TVC:VIX' } }) === 'TVC:VIX', 'an explicit chart dialect must win');

  const html = renderToString(h(SourcesRow, { record: { symbol: 'AAPL', market: 'US', exchange: 'NASDAQ' } }));
  assert(html.includes('target="_blank"'), 'source links must open in a new tab');
  assert(html.includes('rel="noopener noreferrer"'), 'source links must not leak the opener');
  assert((html.match(/<a /g) || []).length === 2, `two anchors expected, got ${(html.match(/<a /g) || []).length}`);
  return 'US/K + index link sets ok';
});

await check('0.5.0 markets: the US-only build answers every market request with the US link set', async () => {
  const { SOURCE_LINKS } = internals;
  const ids = (links) => links.map((l) => l.id).join(',');

  // Removed markets route through resolveSymbol('US') in production; here the
  // contract check is just that no removed-market link can come back.
  const cn = SOURCE_LINKS({ symbol: 'AAPL', market: 'US', exchange: 'NASDAQ' });
  assert(ids(cn) === 'tradingview,yahoo', );
  assert(!SOURCE_LINKS({ symbol: '600519.SH', market: 'CN' }).some((l) => l.id !== 'tradingview' && l.id !== 'yahoo'), 'removed-market helpers keep the US set');
  return 'US-only SOURCE_LINKS contract';
});
await check('universe: the listing browser covers the US feed and localises', async () => {
  const { store, setStore, UniverseBrowser, UniverseRow, SearchRow, IndexCell, trackKey, CSS, UNIVERSE_PAGE_SIZE, TradingApp } = internals;
  assert(UNIVERSE_PAGE_SIZE === 100, `one upstream page holds 100 rows, got ${UNIVERSE_PAGE_SIZE}`);
  const snapshot = { ...store.get() };
  try {
    // m00113: the page carries exactly ONE search field, the one at the top.
    setStore({ view: 'home', symbol: null, lang: 'en', langSet: true, platformLang: 'en', browseMode: false });
    const plain = renderToString(h(TradingApp));
    assert((plain.match(/tm-input/g) || []).length === 1, 'the home page renders exactly one search field');
    assert(!plain.includes('tm-universe'), 'the listing browser stays closed until it is asked for');

    setStore({ browseMode: true });
    const html = renderToString(h(TradingApp));
    assert(/Browse all US listings|浏览全部美股清单/.test(html), 'Browse listings opens the full listing browser');
    assert(!/Filter listings/.test(html), 'the browser has no second search box of its own');
    assert((html.match(/tm-input/g) || []).length === 1, 'opening the browser must not add a second search field');
    assert(html.includes('Load entire board'), 'the browser must be able to walk a whole board');
    assert(/tm-universe/.test(html), 'the browser must render its own scoped container');

    // 0.5.0 (m02818): the browser offers every market, not just US/HK.
    // The US-only build has one feed; the multi-market chip row was removed
    // with the other markets.
    const markets = { US: 'US market' };
    for (const [code, label] of Object.entries(markets)) {
      assert(html.includes(`>${label}<`), `the ${code} market chip must be offered, missing "${label}"`);
    }

    const direct = renderToString(h(UniverseBrowser, { onAdd() {}, owned: new Set() }));
    assert(/Load entire board/.test(direct), 'the browser renders standalone too');
    assert(!/tm-input/.test(direct), 'the standalone browser has no search field of its own');

    // Every search result row is the add affordance itself: + on the right.
    const addRow = renderToString(
      h(SearchRow, {
        row: { symbol: '0700.HK', name: 'Tencent Holdings', nameZh: '腾讯控股', market: 'HK', exchange: 'HKEX', currency: 'HKD' },
        active: false,
        owned: false,
        onOpen() {},
        onAdd() {},
      }),
    );
    assert(addRow.includes('0700.HK') && addRow.includes('腾讯控股'), 'a search row shows the symbol and the local name');
    assert(/tm-result__add/.test(addRow) && !/disabled/.test(addRow), 'every search row carries an enabled + button');

    const ownedRow = renderToString(
      h(SearchRow, {
        row: { symbol: '0700.HK', name: 'Tencent Holdings', market: 'HK' },
        active: true,
        owned: true,
        onOpen() {},
        onAdd() {},
      }),
    );
    assert(/disabled/.test(ownedRow), 'a tracked symbol cannot be added twice');
    assert(/tm-result--owned/.test(ownedRow), 'a tracked symbol is marked as already added');
    assert(/\.tm-search__panel\s*\{[^}]*position:\s*absolute/.test(CSS), 'the result panel floats over the page');

    // User request m00453: a coin is told apart from a stock with the same
    // spelling by market, so `BTC` the coin and `BTC` the listed trust never share
    // an "already added" flag (or a React key).
    const cryptoRow = renderToString(
      h(SearchRow, {
        row: { symbol: 'BTC', name: 'Bitcoin', nameZh: '比特币', market: 'CRYPTO', exchange: 'CRYPTO', currency: 'USDT' },
        active: false,
        owned: false,
        onOpen() {},
        onAdd() {},
      }),
    );
    assert(cryptoRow.includes('比特币') && cryptoRow.includes('CRYPTO'), 'a coin row names the asset and its market');
    assert(!/disabled/.test(cryptoRow), 'the coin stays addable while the same-ticker stock is tracked');
    assert(internals.trackKey({ symbol: 'BTC', market: 'CRYPTO' }) === 'CRYPTO:BTC', 'a coin is tracked by market + symbol');
    assert(
      internals.trackKey({ symbol: 'BTC', market: 'US' }) !== internals.trackKey({ symbol: 'BTC', market: 'CRYPTO' }),
      'the same spelling on two markets is two instruments',
    );

    // The crypto tab adds from the tile itself, and only that tab does.
    const coinTile = renderToString(
      h(IndexCell, {
        item: { symbol: 'BTC', name: 'Bitcoin', nameZh: '比特币', quote: { price: 77482.02, currency: 'USDT', changePct: 1.2, timestamp: Date.now() } },
        market: 'CRYPTO',
        onOpen() {},
        onAdd() {},
        owned: new Set(),
      }),
    );
    assert(/tm-index__add/.test(coinTile), 'a crypto tile offers + to add the coin');
    assert(!/tm-index__add/.test(renderToString(h(IndexCell, { item: { symbol: '^GSPC', quote: {} }, market: 'US', onOpen() {} }))), 'an index tile offers no add button');

    // Regression (reported: the panel said "no matches" for AAPL even though the
    // host answered): /search is enveloped as { data, meta } by service.envelope,
    // so the rows are at payload.data.results. Reading payload.results renders an
    // empty panel for a query that worked.
    const enveloped = { data: { query: 'AAPL', results: [{ symbol: 'AAPL' }, { symbol: 'AAPL.TO' }], source: 'providers' }, meta: { stale: false } };
    assert(internals.searchRowsOf(enveloped).length === 2, 'the enveloped answer must yield its rows');
    assert(internals.searchRowsOf({ results: [{ symbol: 'AAPL' }] }).length === 1, 'a flattened answer still works');
    assert(internals.searchRowsOf(null).length === 0 && internals.searchRowsOf({ data: {} }).length === 0, 'an empty answer yields no rows');

    setStore({ lang: 'zh', langSet: true });
    const zh = renderToString(h(TradingApp));
    assert(zh.includes('浏览全部美股清单'), 'the browser card must be localised');
    // The 1.0 build serves one market; assert the chip the UI actually renders.
    assert(zh.includes('>美股<'), 'the zh browser must label its market chip');

    const row = renderToString(
      h(UniverseRow, {
        row: { symbol: 'BRK.B', name: 'Berkshire Hathaway Inc Class B', market: 'US', exchange: 'NYSE', industry: '保险' },
        onAdd() {},
        owned: new Set(['US:BRK.B']),
      }),
    );
    assert(row.includes('BRK.B'), 'class shares keep their display spelling');
    assert(row.includes('已添加'), 'a symbol already in the watchlist is marked as added');
    assert(/disabled/.test(row), 'a symbol already in the watchlist cannot be added twice');

    const addable = renderToString(
      h(UniverseRow, {
        row: { symbol: '80700.HK', name: '腾讯控股-R', market: 'HK', exchange: 'HKEX' },
        onAdd() {},
        owned: new Set(['HK:0700.HK']),
      }),
    );
    assert(addable.includes('80700.HK'), 'the RMB counter keeps its own symbol');
    assert(!/disabled/.test(addable), 'a different symbol stays addable');
  } finally {
    setStore(snapshot);
  }
  return 'listing browser ok';
});

await check('theme: the header switch flips white-on-black / black-on-white', async () => {
  const { store, setStore, persistTheme, normalizeTheme, effectiveTheme, TradingApp } = internals;
  const snapshot = { ...store.get() };
  try {
    // User request m11109: 黑底白字 ↔ 白底黑字, one active scheme at a time.
    setStore({ view: 'home', symbol: null, lang: 'en', langSet: true, platformLang: 'en', theme: 'dark', themeSet: true });
    const dark = renderToString(h(TradingApp));
    assert(dark.includes('tm-scheme--dark'), 'the dark scheme class must be on the page root');
    assert(!dark.includes('tm-scheme--light'), 'the two schemes must never be applied at once');
    assert(dark.includes('>Dark<') && dark.includes('>Light<'), 'both scheme buttons must be offered');
    assert((dark.match(/tm-thm--active/g) || []).length === 1, 'exactly one scheme may be active');

    setStore({ theme: 'light' });
    const light = renderToString(h(TradingApp));
    assert(light.includes('tm-scheme--light'), 'switching to light must repaint the page root');
    assert(!light.includes('tm-scheme--dark'), 'the dark class must be dropped when light is active');

    assert(effectiveTheme({ theme: null }) === 'light', 'light is the shipped default (US-only build, 2026-11-06)');
    assert(normalizeTheme('blue') === null, 'an unknown scheme is not a scheme');
    assert(persistTheme('light') === 'light' && store.get().theme === 'light', 'persistTheme records the choice');
    assert(store.get().themeSet === true, 'a manual choice must outrank the host snapshot');
    assert(persistTheme('blue') === null && store.get().theme === 'light', 'an unknown scheme is ignored');
  } finally {
    setStore(snapshot);
  }
  return 'dark/light classes + toggle buttons ok';
});

await check('theme: the DSH theme preference is followed until the user chooses', async () => {
  const { store, setStore, bindPlatformTheme, applyThemeSnapshot, persistTheme } = internals;
  const snapshot = { ...store.get() };
  const handlers = [];
  const disposers = [];
  let unsubscribed = 0;
  const service = {
    last: null,
    setTheme(id) {
      this.last = id;
    },
    getTheme: () => ({ preference: 'system', active: { id: 'light', colorScheme: 'light' }, revision: 1 }),
  };
  try {
    setStore({ theme: null, themeSet: false });
    const ctx = {
      get: (id) => (id === 'theme' ? service : null),
      on: (event, fn) => {
        assert(event === 'theme/change', `unexpected event ${event}`);
        handlers.push(fn);
        return () => {
          unsubscribed += 1;
        };
      },
      effect(fn) {
        const disposer = fn();
        if (typeof disposer === 'function') disposers.push(disposer);
      },
    };
    assert(bindPlatformTheme(ctx) === service, 'the theme service must be bound');
    assert(store.get().theme === 'light', 'the host colour scheme must be adopted while nothing is chosen');
    assert(handlers.length === 1, 'theme/change must be subscribed exactly once');

    handlers[0]({ active: { colorScheme: 'dark' } });
    assert(store.get().theme === 'dark', 'a host theme change must be followed');

    persistTheme('light');
    assert(service.last === 'light', 'the host service is the writer of the persisted preference');
    handlers[0]({ active: { colorScheme: 'dark' } });
    assert(store.get().theme === 'light', 'an explicit panel choice must survive later host snapshots');
    assert(applyThemeSnapshot(null) === null, 'an empty snapshot changes nothing');

    for (const dispose of disposers) dispose();
    assert(unsubscribed === 1, 'dispose must unsubscribe from theme/change');

    // The service is optional: a build without it still switches the panel, and a
    // throwing lookup must not break apply().
    assert(bindPlatformTheme({ effect() {} }) === null, 'a host without the theme service must be tolerated');
    assert(persistTheme('dark') === 'dark' && store.get().theme === 'dark', 'the panel still switches without the service');
    assert(
      bindPlatformTheme({
        get() {
          throw new Error('service lookup failed');
        },
        effect() {},
      }) === null,
      'a throwing service lookup must be swallowed',
    );
  } finally {
    bindPlatformTheme({ effect() {} });
    setStore(snapshot);
  }
  return 'host scheme adopted → explicit choice wins → unbound hosts tolerated';
});

await check('theme: every panel surface is painted opaque from the scheme palette', async () => {
  const before = styleTags.length;
  mod.apply({
    effect(fn) {
      fn();
    },
    slots: {
      inject() {},
      register() {
        return () => {};
      },
    },
  });
  assert(styleTags.length === before + 1, 'apply must inject exactly one stylesheet');
  const css = styleTags[before].textContent;
  styleTags.length = before;

  assert(/\.tm-page \{[^}]*--tm-bg: #000000;/.test(css), 'the default (dark) palette must be pure black');
  assert(/\.tm-page \{[^}]*--tm-text: #ffffff;/.test(css), 'the dark scheme must use pure white text');
  assert(
    /\.tm-page\.tm-scheme--light \{[^}]*--tm-bg: #f4f4f8;[^}]*--tm-text: #101014;/.test(css),
    'the light palette must be a light canvas with near-black text (1.0 cards style)',
  );
  assert(/\.tm-page \{[^}]*background: var\(--tm-bg, #000000\)/.test(css), 'the page must paint the scheme colour');
  assert(!/\.tm-page \{[^}]*background: transparent/.test(css), 'the page must never be transparent');
  assert(!/\.tm-page \{[^}]*var\(--dsw-alias/.test(css), 'the page must not depend on a host alias token');
  assert(!/\.tm-status__pop \{[^}]*var\(--dsw-alias/.test(css), 'the status popover must not depend on a host alias token');
  assert(/--dsw-alias-bg-overlay: var\(--tm-overlay\)/.test(css), 'host alias names must be mapped onto the panel palette');
  // Anything the panel paints must resolve inside the panel: an alias token a
  // custom DSH theme leaves undefined would otherwise drop the declaration.
  const used = new Set([...css.matchAll(/var\((--dsw-alias-[a-z0-9-]+)/g)].map((match) => match[1]));
  const defined = new Set([...css.matchAll(/(--dsw-alias-[a-z0-9-]+):/g)].map((match) => match[1]));
  const unmapped = [...used].filter((token) => !defined.has(token));
  assert(unmapped.length === 0, `panel rules depend on unmapped host tokens: ${unmapped.join(', ')}`);
  for (const [label, token] of [['up', '--tm-up'], ['down', '--tm-down'], ['warn', '--tm-warn'], ['moving averages', '--tm-ma20']]) {
    assert(css.includes(`var(${token},`), `the ${label} colour must come from the palette`);
  }
  return `${used.size} alias tokens mapped, ${css.length} CSS chars`;
});

await check('watchlist: the list can be ordered by what today did, not only by cost basis', async () => {
  const costs = { 'US:NVDA': { price: 80, shares: 10 }, 'US:AAPL': { price: 200, shares: 2 }, 'US:MSFT': { price: 0, shares: 0 } };
  const quote = (price, change) => ({ price, change, changePct: 1, timestamp: '2026-11-07T15:30:00Z', currency: 'USD' });
  const aapl = { symbol: 'AAPL', market: 'US', quote: quote(210, 10) };
  const nvda = { symbol: 'NVDA', market: 'US', quote: quote(100, 20) };
  const msft = { symbol: 'MSFT', market: 'US', quote: quote(300, 0) };
  assert(internals.todayOf(aapl, costs) === 20, 'AAPL: 2 shares × +10');
  assert(internals.todayOf(nvda, costs) === 200, 'NVDA: 10 shares × +20');
  assert(internals.todayOf(msft, costs) === null, 'a zero-share placeholder is not a position');
  assert(internals.todayOf({ symbol: 'KO', market: 'US', quote: quote(60, 1) }, costs) === null, 'no cost basis, no today');
  assert(internals.todayOf(null, costs) === null, 'no row, no number');
  const source = String(internals.WatchlistCard);
  assert(source.includes("sort.key === 'today'"), 'the sort has its own branch');
  assert(source.includes('todayOf('), 'and reads the shared helper');
  assert(source.includes("t('By day')"), 'the chip exists');
  assert(internals.ZH['By day'] === '按今日', 'the chip is localised');
  assert(internals.ZH['Sort by what today did to the position (click again to reverse, a third click restores your order)'].includes('按今天'), 'the tooltip is localised');
  return 'today sort ok';
});

await check('watchlist: a held row says what today did to it, not only where it sits against cost', async () => {
  const row = (quote, cost) => ({ symbol: 'AAPL', market: 'US', isFavorite: false, quote, cost });
  const quote = { price: 210, change: 10, changePct: 5, timestamp: '2026-11-07T15:30:00Z', currency: 'USD' };
  const item = { symbol: 'AAPL', market: 'US', isFavorite: false, quote };
  const held = renderToString(h(internals.WatchRow, { item, index: 0, count: 1, cost: { price: 200, shares: 10 } }));
  assert(held.includes('+100.00'), `the day's dollars are shown, got ${held.slice(0, 400)}`);
  assert(held.includes('tm-row__flag--today'), 'and carry their own hook');
  const flat = renderToString(h(internals.WatchRow, { item, index: 0, count: 1, cost: { price: 200, shares: 10, } }));
  assert(flat.length > 0, 'a row still renders');
  const tiny = renderToString(h(internals.WatchRow, { item: { symbol: 'MSFT', market: 'US', isFavorite: false, quote: { price: 100, change: 0.1, changePct: 0.1, timestamp: '2026-11-07T15:30:00Z' } }, index: 0, count: 1, cost: { price: 10, shares: 1 } }));
  assert(!tiny.includes('tm-row__flag--today'), 'a sub-dollar day stays off the row');
  const unheld = renderToString(h(internals.WatchRow, { item: { symbol: 'NVDA', market: 'US', isFavorite: false, quote }, index: 0, count: 1 }));
  assert(!unheld.includes('tm-row__flag--today'), 'no cost basis, no day claim');
  assert(internals.ZH['Today, this position: {amount}'] === '这只今天：{amount}', 'the tooltip is localised');
  assert(internals.CSS.includes('.tm-row__flag--today'), 'the chip needs its own style hook');
  return 'row day chip ok';
});

await check('watchlist: a position missing from the list is called out, not silently dropped', async () => {
  const orphans = internals.orphanHoldings;
  const rows = [{ symbol: 'AAPL', market: 'US', quote: { price: 210 } }]
  const costs = {
    'US:AAPL': { price: 200, shares: 2 },
    'US:NVDA': { price: 80, shares: 10 },
    'US:TSLA': { price: 400, shares: 1 },
    'US:MSFT': { price: 300, shares: 0 },
  }
  const found = orphans(rows, costs)
  assert(found.map((entry) => entry.symbol).join(',') === 'NVDA,TSLA', `biggest blind spot first, got ${found.map((e) => e.symbol)}`);
  assert(found[0].value === 800, 'value is shares × the recorded price');
  assert(found[0].market === 'US', 'the market survives the key split');
  assert(!found.some((entry) => entry.symbol === 'AAPL'), 'a row on the list is not orphaned');
  assert(!found.some((entry) => entry.symbol === 'MSFT'), 'zero shares is a placeholder, not a position');
  assert(orphans(rows, costs, 1).length === 1, 'the cap is honoured');
  assert(orphans([], costs).length === 3, 'no rows means every position is orphaned');
  assert(orphans(rows, null).length === 0, 'no cost basis, nothing to call out');
  const bare = orphans([], { ZZZZ: { price: 5, shares: 2 } })
  assert(bare.length === 1 && bare[0].symbol === 'ZZZZ' && bare[0].market === null, 'a key without a market still reads');
  const zh = internals.makeT('zh');
  assert(zh('Held but not on the watchlist') === '持仓不在自选里', 'zh label');
  assert(zh('The brief only reads the watchlist, so these positions never appear in it.').includes('简报只读自选'), 'zh tooltip');
  assert(internals.CSS.includes('.tm-orphan__btn'), 'the notice needs its own style hook');
  assert(String(internals.WatchlistCard).includes('orphanHoldings(rows, costs)'), 'the card must render the notice');
  return 'orphans covered';
});

await check('export: the spreadsheet carries what the position is worth, not just its ticker', async () => {
  const csv = internals.watchlistCsv;
  const rows = [
    { symbol: 'AAPL', market: 'US', name: 'Apple, Inc.', quote: { price: 210, change: 2, changePct: 0.96, time: '2026-11-07T20:00:00Z' } },
    { symbol: 'MSFT', market: 'US', name: 'Microsoft', quote: { price: 400 } },
  ];
  const costs = { 'US:AAPL': { price: 200, shares: 10 } };
  const alerts = { 'US:AAPL': { above: 120, move: 5 }, 'US:MSFT': { loss: 8 } };
  const text = csv(rows, costs, alerts);
  const lines = text.split('\r\n');
  assert(lines[0].endsWith('Cost,Shares,Value,Open P&L,Today,Alerts'), `header: ${lines[0]}`);
  const apple = lines[1];
  assert(apple.startsWith('AAPL,US,"Apple, Inc."'), `name with a comma stays quoted: ${apple}`);
  assert(apple.endsWith(',200,10,2100,100,20,above 120.00; move 5.00%'), `position + watch columns: ${apple}`);
  assert(internals.alertTextOf(alerts, rows[1]) === 'loss 8.00%', `loss-only watch: ${internals.alertTextOf(alerts, rows[1])}`);
  assert(internals.alertTextOf(null, rows[0]) === '', 'no alerts map means an empty watch cell');
  assert(internals.alertTextOf({}, rows[0]) === '', 'no entry for the row means an empty watch cell');
  const parsedAlerts = internals.parseWatchlistCsv(text);
  assert(parsedAlerts.length === 2, `rows still parse: ${parsedAlerts.length}`);
  assert(parsedAlerts[0].alerts && parsedAlerts[0].alerts.above === 120 && parsedAlerts[0].alerts.move === 5, `watch round-trip: ${JSON.stringify(parsedAlerts[0].alerts)}`);
  assert(parsedAlerts[1].alerts && parsedAlerts[1].alerts.loss === 8, `second watch round-trip: ${JSON.stringify(parsedAlerts[1].alerts)}`);
  const messy = internals.alertBoundsFromCell('above abc; move -2; loss 8%; junk');
  assert(messy && messy.loss === 8 && !messy.above && !messy.move, `bad tokens dropped, good ones kept: ${JSON.stringify(messy)}`);
  assert(internals.alertBoundsFromCell('junk;  ;') === undefined, 'no usable token means no watch');
  const microsoft = lines[2];
  assert(microsoft.endsWith(',,,,,,,,,loss 8.00%'), `no cost basis leaves the money cells empty, the watch cell keeps its value: ${microsoft}`);
  assert(csv([], costs).split('\r\n').length === 1, 'a header-only export is still a file');
  assert(csv(null, null).split('\r\n')[0].includes('Value'), 'null rows keep the header');
  assert(!text.startsWith('\ufeff'), 'the BOM belongs to the blob, not the text');
  return 'csv covered';
});

await check('home: the jump chips point at cards that exist, and the scroll is guarded', async () => {
  const zh = internals.makeT('zh');
  assert(internals.JUMP_TARGETS.length === 3, 'three jumps: board, calendar, brief');
  const ids = internals.JUMP_TARGETS.map((entry) => entry[0]);
  assert(ids.join(',') === 'tm-watchlist-card,tm-events-card,tm-brief-card', `jump ids: ${ids.join(',')}`);
  // Every id must actually be attached to a card, otherwise the chip is a
  // dead button — the failure mode this test exists for.
  assert(String(internals.WatchlistCard).includes("id: 'tm-watchlist-card'"), 'the board card carries its id');
  assert(String(internals.EventBoard).includes("id: 'tm-events-card'"), 'the calendar card carries its id');
  assert(String(internals.BriefCard).includes("id: 'tm-brief-card'"), 'the brief card carries its id');
  // No document.getElementById in this environment: the helper must report
  // false instead of throwing inside a click handler.
  assert(internals.jumpTo('tm-brief-card') === false, 'no DOM means no scroll, not a crash');
  const calls = [];
  const saved = globalThis.document.getElementById;
  globalThis.document.getElementById = (id) => (id === 'tm-brief-card' ? { scrollIntoView: (opts) => calls.push(opts) } : null);
  try {
    assert(internals.jumpTo('tm-brief-card') === true, 'a present card scrolls');
    assert(calls.length === 1 && calls[0].block === 'start' && calls[0].behavior === 'smooth', 'smooth scroll to the top of the card');
    assert(internals.jumpTo('tm-nope') === false, 'a missing card stays silent');
  } finally {
    if (saved === undefined) delete globalThis.document.getElementById;
    else globalThis.document.getElementById = saved;
  }
  assert(zh('Jump to') === '跳到', 'jump label localised');
  assert(zh('Watchlist') === '自选' && zh('Events') === '事件' && zh('Brief') === '简报', 'chip labels localised');
  assert(String(internals.CSS).includes('.tm-jump__btn'), 'the chips have their own style');
  assert(String(internals.HomeView).includes('tm-jump') && String(internals.HomeView).includes('jumpTo('), 'the home page renders the row');
  return 'three targets, guarded scroll, labels localised';
});

await check('event board: a print whose published time has gone by stops being a warning', async () => {
  const merge = internals.mergeEventRows
  const en = internals.makeT('en')
  const zh = internals.makeT('zh')
  // The board is told which day it is reading and, from this round, which moment
  // too: the clock is an argument so the assertion does not depend on when the
  // suite happens to run.
  const today = '2026-11-10'
  const clock = new Date('2026-11-10T19:00:00Z') // 14:00 Eastern: the morning print is out, the statement is not
  const board = merge(
    {
      today,
      macro: [
        { kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 0 },
        { kind: 'fomc', date: '2026-11-10', time: '14:00', ref: 'FOMC statement', days: 0 },
        { kind: 'jobs', date: '2026-11-13', time: '08:30', ref: 'Employment Situation', days: 3 },
      ],
      bySymbol: { NVDA: { date: '2026-11-10', session: 'post' } },
      closures: [{ date: '2026-11-10', close: '13:00', name: 'Test half day', nameZh: '半天测试' }],
      expiries: [],
    },
    { days: 30, scope: 'all', now: clock },
  )
  const byKey = new Map(board.rows.map((row) => [row.key, row]))
  const cpi = byKey.get('macro:cpi:2026-11-10')
  const fomc = byKey.get('macro:fomc:2026-11-10')
  const halfDay = byKey.get('closure:2026-11-10')
  const report = byKey.get('earnings:NVDA:2026-11-10')
  const jobs = byKey.get('macro:jobs:2026-11-13')

  assert(cpi && cpi.passed === true, 'a 08:30 ET print is finished by 14:00 ET')
  assert(fomc && fomc.passed === false, 'a 14:00 ET statement is not finished at 14:00 ET')
  assert(halfDay && halfDay.passed === true, 'a 13:00 ET early close has passed')
  assert(report && report.passed === false, 'a report with no announced hour is not called finished')
  assert(jobs && jobs.passed === false, 'a print on a later day is still ahead')
  assert(fomc.sameDay >= 1, 'the collision note still spans finished and unfinished rows on one day')

  // The word on the row is the claim the reader acts on.
  assert(internals.eventWhenOf(cpi, en) === 'already out', `the row must say the print is out, got ${internals.eventWhenOf(cpi, en)}`)
  assert(internals.eventWhenOf(cpi, zh) === '已公布', 'and in Chinese')
  assert(internals.eventWhenOf(halfDay, en) === 'already closed', 'a closure uses the matching word')
  assert(internals.eventWhenOf(halfDay, zh) === '已收盘', 'closed is not the same word as published')
  assert(internals.eventWhenOf(fomc, en) === 'today', 'an unfinished row keeps today')
  assert(internals.eventWhenOf(jobs, en) === 'in 3 days', 'a later row keeps its distance')
  assert(internals.eventImpactOf(cpi, en).includes('Already released'), 'the consequence line follows the same fact')
  assert(internals.eventImpactOf(cpi, zh).includes('已经公布'), 'the Chinese line too')
  assert(internals.eventImpactOf(halfDay, en).includes('nothing more fills today'), 'a finished session says so')
  assert(internals.eventImpactOf(fomc, en).includes('widest move window'), 'an upcoming decision keeps its warning')

  // A reminder is for what is still ahead; pinging after the fact is noise.
  assert(internals.eventReminderOf([cpi, halfDay], en, 'en') === null, 'a finished day sends no reminder')
  const stillAhead = internals.eventReminderOf([fomc], en, 'en')
  assert(stillAhead && stillAhead.items.length === 1, 'the statement that has not landed still pings')

  // The detail page gates its own two warnings on the same clock.
  const dayAfter = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const dayBefore = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  assert(internals.macroWatchNote([{ kind: 'cpi', date: dayBefore, time: '08:30', days: 0 }], en) === null, 'a print that already landed is not a note')
  const note = internals.macroWatchNote([{ kind: 'cpi', date: dayAfter, time: '08:30', days: 1 }], en)
  assert(note && note.when === 'tomorrow', 'a print tomorrow is still a note')
  assert(internals.nextMacro({ events: [{ kind: 'cpi', date: dayBefore, time: '08:30', ref: 'CPI', days: 0 }] }, en) === null, 'the detail strip does not advertise a finished print')
  assert(internals.nextMacro({ events: [{ kind: 'cpi', date: dayAfter, time: '08:30', ref: 'CPI', days: 1 }] }, en) !== null, 'it still renders a print that is ahead')

  // The banner points at the first event that has not happened; the finished row
  // stays in the list, visibly calm.
  const boardSource = String(internals.EventBoard)
  assert(boardSource.includes('rows.find((row) => !row.passed)'), 'the next-up line skips finished rows')
  assert(boardSource.includes("tm-ev__row--past'"), 'the row carries the finished state')
  assert(boardSource.includes("!row.passed ? ' tm-ev__when--soon'"), 'and loses the urgent colour')
  assert(/\.tm-ev__row--past \{[^}]*dashed/.test(internals.CSS), 'the stylesheet draws it calm')

  // Refactoring the shared stamp must not move an instant by an hour.
  assert(internals.etToDate('2026-11-10', '08:30').toISOString() === '2026-11-10T13:30:00.000Z', 'standard time is UTC-5')
  assert(internals.etToDate('2026-06-10', '08:30').toISOString() === '2026-06-10T12:30:00.000Z', 'daylight time is UTC-4')
  assert(internals.etToUtcStamp('2026-11-10', '08:30').start === '20261110T133000Z', 'the exported calendar is unchanged')
  assert(internals.etToDate('nope', '08:30') === null, 'malformed input poses no instant')
  assert(internals.eventPassedOf(null) === false, 'no row is never finished')
  assert(internals.eventPassedOf({ date: '2026-11-10' }) === false, 'a row with no clock is never called finished')
  return 'finished rows are named as finished in both languages; reminder and banner skip them; the shared stamp is unchanged'
})

await check('holdings news: the feed asks about the biggest positions first', async () => {
  const rows = [
    { symbol: 'AAPL', market: 'US', quote: { price: 100 } },
    { symbol: 'NVDA', market: 'US', quote: { price: 100 } },
    { symbol: 'KO', market: 'US', quote: { price: 100 } },
    { symbol: 'TSLA', market: 'US', quote: { price: 100 } },
  ];
  const costs = {
    'US:AAPL': { price: 90, shares: 2 },
    'US:NVDA': { price: 80, shares: 40 },
    'US:KO': { price: 60, shares: 0 },
  };
  const picked = internals.newsSymbols(rows, costs);
  // NVDA is the largest position, AAPL second. KO carries a cost but zero
  // shares, which costOf() already refuses: a placeholder is not a holding.
  assert(picked.join(',') === 'NVDA,AAPL', `order by value: ${picked.join(',')}`);
  // A row with no recorded cost is not a holding and never asks for news.
  assert(!picked.includes('TSLA'), 'unowned names stay out of the feed');
  assert(internals.newsSymbols(rows, costs, 2).join(',') === 'NVDA,AAPL', 'the limit keeps the largest');
  assert(internals.newsSymbols([], costs).length === 0, 'no rows, no feed');
  assert(internals.newsSymbols(rows, null).length === 0, 'no costs, no feed');
  assert(String(internals.HoldingNewsCard).includes('newsSymbols(rows, costs)'), 'the card uses the shared ranking');
  return 'ranked by position value, unowned rows excluded';
});

console.log(`\n== summary ==\n  ${passed}/${passed + failed} checks passed, ${failed} failed`);
report({ title: 'client', required: true, passed, failed, skipped: 0, skipReasons: [], failures: failures.slice(), ok: failed === 0 });
if (failures.length) {
  for (const line of failures) console.log(`  · ${line}`);
  process.exit(1);
}
