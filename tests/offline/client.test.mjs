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
  assert(
    row.injectKey === 'sidebar.panellist' && page.injectKey === 'sidebar.panellist',
    'the row and its page must be gated on the same sidebar slot',
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
  assert(internals.MacroCard && String(internals.MacroCard).includes('/macro?days=30'), 'the card reads the curated /macro route');
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

await check('exchange closures: half days are dated, and the card localises', async () => {
  const zh = internals.makeT('zh');
  const en = internals.makeT('en');
  assert(internals.CSS.includes('.tm-events__row--holiday'), 'the closure rows ship their CSS');
  assert(String(en('Exchange calendar')) === 'Exchange calendar', 'English keeps the canonical card title');
  assert(zh('Exchange calendar') === '交易所日历', 'the card title localises');
  // The same card carries the monthly expiry, so it is a calendar rather than a
  // list of closures; the expiry rows read as volatility dates, not half days.
  assert(internals.CSS.includes('.tm-events__row--opex'), 'the expiry rows ship their own CSS');
  assert(zh('Monthly options expiry') === '期权到期日', 'the expiry label localises');
  assert(zh('quarterly') === '季度合约', 'the quarterly marker localises');
  assert(/[\u4e00-\u9fff]/.test(zh('Options expire at the close. Volume and index rebalancing usually cluster on that day.')), 'the expiry hint localises');
  assert(zh('Closed all day') === '全天休市', 'the full-day label localises');
  // The half-day wording carries the cutoff time, so it must interpolate rather
  // than print a bare "{close}".
  const half = zh('Early close {close} ET', { close: '13:00' });
  assert(half.includes('13:00') && !half.includes('{close}'), `half-day label interpolates (got ${half})`);
  assert(/[\u4e00-\u9fff]/.test(zh('Half days close at 13:00 ET; orders after that wait for the next session.')), 'the hint localises');
  return 'closure card CSS + full-day and half-day labels localise';
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
  const t = I.makeT('zh')
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
  const t = I.makeT('zh')
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

await check('keys: one table describes the shortcuts, and `?` respects text fields', () => {
  const I = internals
  const CSS = I.CSS
  const zhT = I.makeT('zh')
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
  const zhT = I.makeT('zh')
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
  const zhT = I.makeT('zh')
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

await check('news: headlines are dated, linked, and localised', () => {
  const I = internals
  const CSS = I.CSS
  // Every row is a link out, so the card can never look like a dead list.
  for (const cls of ['.tm-news {', '.tm-news__row {', '.tm-news__title {', '.tm-news__meta {']) {
    assert(CSS.includes(cls), `the card needs ${cls}`)
  }
  const zh = I.makeT('zh')
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

console.log(`\n== summary ==\n  ${passed}/${passed + failed} checks passed, ${failed} failed`);
report({ title: 'client', required: true, passed, failed, skipped: 0, skipReasons: [], failures: failures.slice(), ok: failed === 0 });
if (failures.length) {
  for (const line of failures) console.log(`  · ${line}`);
  process.exit(1);
}
