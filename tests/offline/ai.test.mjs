/**
 * AI layer contract (0.5.1, unchanged by the 0.6.0 publication work).
 *
 * Drives TradingAi against a fake host llm service that implements only the
 * published StreamChunk protocol — no DSH package, no network. This is the test
 * that would have caught the original "AI_UNAVAILABLE" regression.
 *
 *   node tests/offline/ai.test.mjs   (or: npm run test:ai)
 */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';

import {
  BRIEF_STYLE_DIRECTIVE,
  ChunkAssembler,
  RECENCY_DIRECTIVE,
  STOCK_SYSTEM_PROMPT,
  TradingAi,
  ageMsOf,
  buildBriefInput,
  buildStockInput,
  buildUserMessage,
  derivedSuggestions,
  normalizeBrief,
  qualityFor,
  recencyOf,
} from '../../lib/trading/ai.js';

let passed = 0;
const failures = [];

/** Report this suite's result to the offline runner (0.7.0 P0-3); best effort. */
function report() {
  const target = process.env.DSH_TEST_RESULT_FILE;
  if (!target) return;
  try {
    appendFileSync(
      target,
      `${JSON.stringify({ title: 'ai', required: true, passed, failed: failures.length, skipped: 0, skipReasons: [], failures: failures.map((f) => `${f.title}: ${f.message}`), ok: failures.length === 0 })}\n`,
      'utf8',
    );
  } catch {
    /* reporting must never break the suite */
  }
}

async function check(title, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${title}`);
  } catch (err) {
    failures.push({ title, message: err && err.message });
    console.log(`FAIL  ${title}\n      ${err && err.message}`);
  }
}

/** A minimal but contract-faithful fake of the host `llm` service. */
function fakeLlm(script) {
  const calls = [];
  return {
    calls,
    listProviders: () => script.providers || [],
    listModels: async (provider) => (script.modelsByProvider || {})[provider] || [],
    stream(options) {
      calls.push(options);
      const chunks = typeof script.run === 'function' ? script.run(options, calls.length) : script.chunks || [];
      return (async function* gen() {
        for (const chunk of chunks) yield chunk;
      })();
    },
  };
}

const textStream = (text, finish = { kind: 'stop' }) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: text.slice(0, 12) },
  { type: 'text-delta', index: 0, text: text.slice(12) },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'usage', usage: { inputTokens: 12, outputTokens: 34 } },
  { type: 'finish', reason: finish },
];

/** Mirrors what DSH's agent-default-model reports on this machine. */
const defaultModel = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) };

const ANALYSIS = JSON.stringify({
  summary: 'Trend is constructive.',
  trend: { shortTerm: 'up', mediumTerm: 'flat', longTerm: 'up' },
  momentum: 'rising',
  volume: 'average',
  supportLevels: [100],
  resistanceLevels: [120],
  riskFactors: ['valuation'],
  keyObservations: ['ma20 above ma50'],
});

const SNAPSHOT = {
  symbol: 'AAPL',
  market: 'US',
  asOf: Date.now(),
  quote: { price: 200, change: 1, changePct: 0.5, currency: 'USD', source: 'eastmoney', timestamp: Date.now() },
  profile: { name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD' },
  technical: {
    technical: { rsi14: 55, ma20: 195 },
    bars: 120,
    interval: '1d',
    unavailable: [],
    // The pivots the plugin computed: the only prices a level may be quoted from.
    levels: {
      support: [{ price: 100, touches: 3, lastTimestamp: 0 }],
      resistance: [{ price: 120, touches: 2, lastTimestamp: 0 }],
    },
  },
  candles: [],
};

async function main() {
  await check('the request envelope matches RequestUserInput (no id, no source)', () => {
    const message = buildUserMessage('hello');
    assert.deepEqual(message, { role: 'user', content: [{ type: 'text', text: 'hello' }] });
    assert.ok(!('source' in message), 'source must not be attached to a request message');
    assert.ok(!('id' in message), 'id must not be attached to a request message');
  });

  await check('the chunk assembler keeps text, drops reasoning and honours block-end/usage', () => {
    const assembler = new ChunkAssembler();
    assembler.push({ type: 'block-start', index: 0, blockType: 'text' });
    assembler.push({ type: 'reasoning-delta', index: 1, text: 'thinking…' });
    assembler.push({ type: 'text-delta', index: 0, text: '{"a":' });
    assembler.push({ type: 'text-delta', index: 0, text: '1}' });
    assembler.push({ type: 'block-end', index: 0, block: { type: 'text', text: '{"a":1}' } });
    assembler.push({ type: 'usage', usage: { outputTokens: 5 } });
    assembler.push({ type: 'finish', reason: { kind: 'stop' } });
    assert.equal(assembler.text(), '{"a":1}');
    assert.ok(!assembler.text().includes('thinking'), 'reasoning must never leak into the answer');
    assert.equal(assembler.usage.outputTokens, 5);
    assert.equal(assembler.finishReason().kind, 'stop');
  });

  await check('the chunk assembler infers stop from text when no finish chunk arrives', () => {
    const assembler = new ChunkAssembler();
    assembler.push({ type: 'text-delta', index: 0, text: '{"ok":true}' });
    assert.equal(assembler.finishReason().kind, 'stop');
    const empty = new ChunkAssembler();
    assert.equal(empty.finishReason().kind, 'error');
  });

  await check('askJson drives the public stream contract end to end', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const { value, meta } = await ai.askJson('system', 'payload');
    assert.equal(value.summary, 'Trend is constructive.');
    assert.equal(meta.provider, 'deepseek-official');
    assert.equal(meta.model, 'deepseek-flash');
    assert.equal(meta.attempt, 1);
    assert.equal(meta.usage.outputTokens, 34);
    const call = llm.calls[0];
    assert.equal(call.provider, 'deepseek-official');
    assert.equal(call.model, 'deepseek-flash');
    assert.equal(call.system, 'system');
    assert.equal(call.maxTokens, 2400);
    assert.equal(call.messages.length, 1);
    assert.equal(call.messages[0].role, 'user');
    assert.equal(call.messages[0].content[0].text, 'payload');
    assert.ok(!('source' in call.messages[0]), 'the host rejects a source on request messages');
    assert.ok(call.signal, 'a timeout signal must be passed to the host');
  });

  await check('analyzeStock normalises the model output and stamps its provenance', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const { analysis, meta } = await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    assert.equal(analysis.summary, 'Trend is constructive.');
    assert.deepEqual(analysis.supportLevels, [100]);
    assert.equal(meta.symbol, 'AAPL');
    assert.equal(meta.provider, 'deepseek-official');
    assert.ok(meta.disclaimer, 'the disclaimer must be attached');
    assert.ok(!/Simplified Chinese/.test(llm.calls[0].system), 'English runs must not carry the localisation directive');
  });

  await check('invented price levels are dropped and reported (0.8.2 regression)', async () => {
    const invented = JSON.stringify({
      ...JSON.parse(ANALYSIS),
      supportLevels: [12345, 100],
      resistanceLevels: [55],
    });
    const llm = fakeLlm({ chunks: textStream(invented) });
    const ai = new TradingAi({ llm, defaultModel });
    const { analysis } = await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    assert.deepEqual(analysis.supportLevels, [100], 'only the measured pivot may survive');
    assert.deepEqual(analysis.rejectedLevels.support, [12345], 'the invented support price must be reported, not shown');
    assert.deepEqual(analysis.resistanceLevels, [], 'a resistance price nobody measured must not be published');
    assert.deepEqual(analysis.rejectedLevels.resistance, [55]);
  });

  await check('watchlist brief counts come from the input, not the model (0.8.2 regression)', async () => {
    const brief = JSON.stringify({
      headline: 'ok',
      stocksTracked: 999,
      upCount: -5,
      downCount: 7,
      strongestMover: 'TSLA',
      largestDecline: 'NVDA',
      unusualVolume: [],
      keyObservations: [],
    });
    const llm = fakeLlm({ chunks: textStream(brief) });
    const ai = new TradingAi({ llm, defaultModel });
    const { brief: value } = await ai.watchlistBrief(
      {
        asOf: Date.now(),
        stocks: [
          { symbol: 'AAPL', market: 'US', quote: { price: 200, change: 1, changePct: 0.5, currency: 'USD' } },
          { symbol: '0700.HK', market: 'HK', quote: { price: 400, change: -2, changePct: -0.5, currency: 'HKD' } },
        ],
      },
      { lang: 'en' },
    );
    assert.equal(value.stocksTracked, 2, 'the tracked count must be counted, not read from the answer');
    assert.equal(value.upCount, 1, 'one row is up, whatever the model claimed');
    assert.equal(value.downCount, 1);
    assert.match(String(value.strongestMover), /AAPL/, 'a mover must be a stock that exists in the input');
    assert.match(String(value.largestDecline), /0700\.HK/);
    assert.ok(!/TSLA|NVDA/.test(JSON.stringify(value)), 'invented tickers must not survive');
  });

  await check('watchlistBrief sends the localisation directive and counts stocks', async () => {
    const brief = JSON.stringify({
      headline: '科技股走弱',
      stocksTracked: 2,
      upCount: 1,
      downCount: 1,
      strongestMover: 'AAPL',
      largestDecline: '0700.HK',
      unusualVolume: [],
      keyObservations: ['成交温和'],
    });
    const llm = fakeLlm({ chunks: textStream(brief) });
    const ai = new TradingAi({ llm, defaultModel });
    const { brief: value, meta } = await ai.watchlistBrief(
      {
        asOf: Date.now(),
        stocks: [
          { symbol: 'AAPL', market: 'US', quote: { price: 200, change: 1, changePct: 0.5, currency: 'USD' } },
          { symbol: '0700.HK', market: 'HK', quote: { price: 400, change: -2, changePct: -0.5, currency: 'HKD' } },
        ],
      },
      { lang: 'zh' },
    );
    assert.equal(value.headline, '科技股走弱');
    assert.equal(meta.stocksTracked, 2);
    assert.equal(meta.lang, 'zh');
    assert.ok(/Simplified Chinese/.test(llm.calls[0].system), 'zh runs must carry the localisation directive');
  });

  await check('brief action ideas: model text passes through, otherwise measured levels fill in (0.9.x)', () => {
    const input = {
      stocks: [
        { symbol: 'AAPL', price: 99.5, changePct: 0.4, high52w: 100, low52w: 70, volumeRatio20d: 2.1, rsi14: 74 },
        { symbol: 'MSFT', price: 300, changePct: -0.6, high52w: 340, low52w: 298, volumeRatio20d: 1.1, rsi14: 41 },
      ],
    };
    const fromModel = normalizeBrief({ headline: 'x', suggestions: ['AAPL 突破 100 需要放量', 'MSFT 308 是最近的失效位'] }, input, 'zh');
    assert.equal(fromModel.suggestions.length, 2, 'model-written ideas pass through untouched');
    const derived = normalizeBrief({ headline: 'x' }, input, 'zh');
    assert.ok(derived.suggestions.length >= 3, 'a brief without model ideas still carries measured ones');
    assert.ok(derived.suggestions.some((line) => /AAPL/.test(line) && /100\.00/.test(line)), 'the 52w-high case prints the measured high');
    assert.ok(derived.suggestions.some((line) => /AAPL/.test(line) && /20 日均量/.test(line)), 'the volume case names the measured ratio');
    assert.ok(!/do your own research|guarantee/i.test(derived.suggestions.join(' ')), 'no generic filler, no promises');
    const kept = normalizeBrief({ headline: 'x', suggestions: ['  ', 42, 'AAPL 103 失守则回踩 MA20'] }, input, 'en');
    assert.deepEqual(kept.suggestions, ['AAPL 103 失守则回踩 MA20'], 'junk suggestion strings are dropped, not rendered');
    return 'brief suggestions pass through, fall back to measured levels, junk filtered';
  });

  await check('a late-bound llm service starts unavailable and becomes usable (0.5.0 regression)', async () => {
    let service = null;
    const ai = new TradingAi({ llm: () => service, defaultModel: () => defaultModel });
    assert.equal(ai.available, false, 'the plugin must degrade instead of throwing when llm is not there yet');
    assert.match(ai.unavailableReason(), /ctx\.get\("llm"\)/);
    service = fakeLlm({ chunks: textStream(ANALYSIS) });
    assert.equal(ai.available, true, 'the service must be re-read on every call');
    const { value } = await ai.askJson('system', 'payload');
    assert.equal(value.summary, 'Trend is constructive.');
  });

  await check('a missing llm service fails once with AI_UNAVAILABLE, not three retries', async () => {
    const ai = new TradingAi({ llm: null, defaultModel });
    await assert.rejects(
      () => ai.askJson('system', 'payload'),
      (err) => err.code === 'AI_UNAVAILABLE' && /LLM runtime is not available/.test(err.message) && err.retryable === false,
    );
  });

  await check('provider discovery awaits listModels and prefers a DeepSeek model', async () => {
    const llm = fakeLlm({
      providers: [{ id: 'openai' }, { id: 'deepseek-official' }],
      modelsByProvider: { openai: ['gpt-4o'], 'deepseek-official': ['deepseek-chat', 'deepseek-reasoner'] },
      chunks: textStream(ANALYSIS),
    });
    const ai = new TradingAi({ llm, defaultModel: null });
    assert.equal(ai.resolveRouteSync(), null);
    const route = await ai.resolveRoute();
    assert.deepEqual(route, { provider: 'deepseek-official', model: 'deepseek-chat' });
    assert.equal(ai.available, true);
  });

  await check('the default-model selection is read tolerantly (provider/model aliases)', () => {
    const ai = new TradingAi({ llm: null, defaultModel: { currentSelection: () => ({ providerId: 'deepseek-official', modelId: 'deepseek-flash' }) } });
    assert.deepEqual(ai.resolveRouteSync(), { provider: 'deepseek-official', model: 'deepseek-flash' });
    const partial = new TradingAi({ llm: null, defaultModel: { currentSelection: () => ({ provider: 'deepseek-official' }) } });
    assert.equal(partial.resolveRouteSync(), null, 'an incomplete selection must fall through to discovery');
    const throwing = new TradingAi({ llm: null, defaultModel: { currentSelection: () => { throw new Error('no profile'); } } });
    assert.equal(throwing.resolveRouteSync(), null, 'a throwing selection must not break status()');
  });

  await check('a retryable provider failure is retried and the second attempt wins', async () => {
    const llm = fakeLlm({
      run: (_options, callIndex) =>
        callIndex === 1
          ? [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream 500' } } }]
          : textStream(ANALYSIS),
    });
    const ai = new TradingAi({ llm, defaultModel });
    const { value, meta } = await ai.askJson('system', 'payload', { attempts: 2, timeoutMs: 5000 });
    assert.equal(value.summary, 'Trend is constructive.');
    assert.equal(meta.attempt, 2);
    assert.equal(llm.calls.length, 2);
  });

  await check('terminal finish reasons map to actionable errors', async () => {
    const cases = [
      [{ kind: 'max-tokens' }, /token cap/],
      [{ kind: 'aborted', failure: { message: 'user cancelled' } }, /aborted/],
      [{ kind: 'error', failure: { message: 'boom', code: 'AUTH' } }, /boom/],
    ];
    for (const [finish, pattern] of cases) {
      const llm = fakeLlm({ chunks: [{ type: 'finish', reason: finish }] });
      const ai = new TradingAi({ llm, defaultModel });
      await assert.rejects(
        () => ai.askJson('system', 'payload', { attempts: 1, timeoutMs: 5000 }),
        (err) => err.code === 'AI_UNAVAILABLE' && pattern.test(err.message),
        `expected ${JSON.stringify(finish)} to fail with ${pattern}`,
      );
    }
  });

  await check('a stream that yields nothing is an empty response, not a JSON crash', async () => {
    const llm = fakeLlm({ chunks: [{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'finish', reason: { kind: 'stop' } }] });
    const ai = new TradingAi({ llm, defaultModel });
    await assert.rejects(
      () => ai.askJson('system', 'payload', { attempts: 1, timeoutMs: 5000 }),
      (err) => err.code === 'AI_UNAVAILABLE' && /no text/.test(err.message),
    );
  });

  await check('status() reports availability, route and the blocking reason', async () => {
    const ready = new TradingAi({ llm: fakeLlm({ chunks: textStream(ANALYSIS) }), defaultModel });
    const status = ready.status();
    assert.equal(status.available, true);
    assert.equal(status.reason, null);
    assert.deepEqual(status.route, { provider: 'deepseek-official', model: 'deepseek-flash' });
    assert.equal(status.maxTokens, 2400);
    const blocked = new TradingAi({ llm: null, defaultModel: null });
    assert.equal(blocked.status().available, false);
    assert.ok(blocked.status().reason);
  });

  // ---- 0.7.0 P1-4: a delayed snapshot must never be described as live ----

  await check('ageMsOf reads seconds and milliseconds alike and rejects junk', () => {
    const now = 1_700_000_000_000;
    assert.equal(ageMsOf(now / 1000, now), 0, 'seconds must be normalised');
    assert.equal(ageMsOf(now - 5_000, now), 5_000);
    assert.equal(ageMsOf(null, now), null);
    assert.equal(ageMsOf('not-a-date', now), null);
    assert.equal(ageMsOf(0, now), null);  });

  await check('recencyOf grades fresh, delayed, stale and historical, and says unknown', () => {
    const now = Date.now();
    const at = (msAgo) => recencyOf(now - msAgo, {});
    assert.equal(at(60_000).grade, 'fresh');
    assert.equal(at(10 * 60_000).grade, 'delayed');
    assert.equal(at(2 * 3_600_000).grade, 'stale');
    assert.equal(at(2 * 24 * 3_600_000).grade, 'historical');
    assert.equal(recencyOf(null, {}).grade, 'unknown');
    assert.equal(at(60_000).ageSeconds, 60);
    const flagged = recencyOf(now, { stale: true, staleReason: 'upstream closed', marketOpen: false });
    assert.equal(flagged.grade, 'fresh', 'the grade is about age');
    assert.equal(flagged.stale, true, 'the stale flag is carried separately');
    assert.equal(flagged.staleReason, 'upstream closed');
    assert.equal(flagged.marketSessionOpen, false);
    return 'fresh/delayed/stale/historical/unknown all graded';
  });

  await check('qualityFor never claims live data it cannot vouch for', () => {
    const fresh = qualityFor({ grade: 'fresh', ageSeconds: 12, stale: false });
    assert.match(fresh.qualification, /recent/i);
    assert.ok(!/real[- ]time snapshot|is real-time/i.test(fresh.qualification));
    assert.equal(fresh.historyGrade, null);
    const stale = qualityFor(
      { grade: 'stale', ageSeconds: 7200, stale: true, staleReason: 'cache' },
      { quality: { grade: 'partial' }, bars: 120 },
    );
    assert.match(stale.qualification, /not a current quote/i);
    assert.equal(stale.historyGrade, 'partial', 'the indicator grade travels with the answer');
    assert.equal(stale.historyBars, 120);
    const unknown = qualityFor(null, null);
    assert.equal(unknown.grade, 'unknown');
    assert.match(unknown.qualification, /do not describe the numbers as current/i);
    return 'qualification text is conservative in every grade';
  });

  await check('the recency directive is appended to the system prompt without rewriting the spec rules', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    const system = llm.calls[0].system;
    assert.ok(system.includes(STOCK_SYSTEM_PROMPT), 'the specified stock prompt must stay verbatim');
    assert.ok(system.includes(RECENCY_DIRECTIVE.trim()), 'the recency rules must be appended');
    assert.ok(/never describe/i.test(system) || /do not describe/i.test(system), 'the directive must forbid live wording');
  });

  await check('analyzeStock stamps dataQuality from the snapshot age', async () => {
    const llm = fakeLlm({ chunks: textStream(ANALYSIS) });
    const ai = new TradingAi({ llm, defaultModel });
    const fresh = await ai.analyzeStock(SNAPSHOT, { lang: 'en' });
    assert.equal(fresh.meta.dataQuality.grade, 'fresh');
    assert.equal(fresh.meta.dataQuality.historyGrade, null, 'no technical quality block on this snapshot');
    const old = await ai.analyzeStock(
      { ...SNAPSHOT, asOf: Date.now() - 3 * 86_400_000, stale: true },
      { lang: 'en' },
    );
    assert.equal(old.meta.dataQuality.grade, 'historical');
    assert.equal(old.meta.dataQuality.stale, true);
    assert.match(old.meta.dataQuality.qualification, /previous session|historical/i);
    return `fresh=${fresh.meta.dataQuality.grade}, old=${old.meta.dataQuality.grade}`;
  });

  await check('buildStockInput carries dataRecency and the indicator quality', () => {
    const input = buildStockInput({
      ...SNAPSHOT,
      technical: { technical: { rsi14: 55 }, bars: 70, interval: '1d', unavailable: [], quality: { grade: 'partial', bars: 70 } },
    });
    assert.ok(input.data.dataRecency, 'the model must see how old the data is');
    assert.equal(input.data.dataRecency.grade, 'fresh');
    assert.equal(input.data.technical.quality.grade, 'partial');
    assert.equal(input.dataAvailability.historyGrade, 'partial');
    assert.ok(input.dataAvailability.quote);
    return 'dataRecency + technical.quality present';
  });

  await check('brief suggestions: an imminent earnings print outranks technical reads (1.0.x)', () => {
    const realised = buildBriefInput({
      stocks: [
        { symbol: 'AAPL', quote: { price: 342.37 } },
        { symbol: 'MSFT', quote: { price: 300 } },
      ],
      earnings: { today: '2026-11-06', bySymbol: { AAPL: { date: '2026-11-09', session: 'am' } } },
    });
    assert.deepEqual(realised.stocks[0], {
      ...realised.stocks[0],
      earningsDate: '2026-11-09',
      earningsSession: 'am',
      earningsInDays: 3,
    }, 'the mapped row carries the calendar date, session and a day count');
    assert.deepEqual(
      { earningsDate: realised.stocks[1].earningsDate, earningsInDays: realised.stocks[1].earningsInDays },
      { earningsDate: null, earningsInDays: null },
      'a stock outside the calendar stays null instead of zero',
    );
    assert.equal(realised.stocks[0].earningsInDays, 3, 'three calendar days between 11-06 and 11-09');
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(zh.some((line) => /AAPL/.test(line) && /出财报/.test(line)), 'zh idea mentions the print');
    assert.ok(zh[0].includes('AAPL'), 'earnings risk is the first derived idea, ahead of technicals');
    const en = derivedSuggestions(realised, 'en');
    assert.ok(en.some((line) => /AAPL/.test(line) && /in 3 days/.test(line)), 'en phrasing carries the day count');
    const past = derivedSuggestions({ stocks: [{ symbol: 'VTI', price: 400, changePct: 0.2, earningsInDays: -2 }] }, 'en');
    assert.ok(!past.some((line) => /VTI reports/.test(line)), 'a past Friday date must not surface as future risk');
    return 'earnings-soon idea rides the brief input and outranks the technical ladder';
  });

  await check('1.1: a drop into the print reads as re-pricing, not as a dip to buy', () => {
    const realised = buildBriefInput({
      stocks: [
        { symbol: 'NVDA', quote: { price: 180, changePct: -5.42 } },
        { symbol: 'AAPL', quote: { price: 270, changePct: -1.2 } },
      ],
      earnings: {
        today: '2026-11-06',
        bySymbol: { NVDA: { date: '2026-11-09', session: 'am' }, AAPL: { date: '2026-11-09', session: 'am' } },
      },
    });
    assert.equal(realised.stocks[0].changePct, -5.42, 'the day move rides the brief input');
    const en = derivedSuggestions(realised, 'en');
    assert.ok(
      en.some((line) => /NVDA/.test(line) && /5\.4% lower/.test(line) && /re-pricing/.test(line)),
      'a hard drop into the print gets its own line',
    );
    assert.ok(!en.some((line) => /NVDA reports earnings/.test(line)), 'and it replaces the plain print line');
    assert.ok(
      en.some((line) => /AAPL reports earnings/.test(line)),
      'a quiet name into the same print keeps the original wording',
    );
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(zh.some((line) => /NVDA/.test(line) && /跌 5\.4%/.test(line) && /重新定价/.test(line)), 'zh phrasing localises');
    const mild = derivedSuggestions(
      { stocks: [{ symbol: 'MSFT', price: 300, changePct: -2.4, earningsInDays: 2 }] },
      'en',
    );
    assert.ok(mild.some((line) => /MSFT reports earnings/.test(line)), 'below the threshold the plain line stays');
    const noMove = derivedSuggestions({ stocks: [{ symbol: 'VTI', price: 400, earningsInDays: 2 }] }, 'en');
    assert.ok(noMove.some((line) => /VTI reports earnings/.test(line)), 'a missing day change never fabricates a drop');
    return 'dip-into-print idea replaces the plain print line above the threshold';
  });

  await check('0.5.x: a market-wide macro print inside 7 days frames the whole brief', () => {
    const realised = buildBriefInput({
      stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }],
      macro: {
        today: '2026-11-06',
        events: [
          { kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI' },
          { kind: 'fomc', date: '2026-12-09', time: '14:00', ref: 'FOMC decision (SEP)' },
          { kind: 'jobs', date: '2026-10-02', time: '08:30', ref: 'September jobs report' },
        ],
      },
    });
    assert.deepEqual(
      realised.macroSoon,
      [{ kind: 'cpi', date: '2026-11-10', time: '08:30', ref: 'October CPI', days: 4 }],
      'only the print inside the 7-day window rides along; past and far rows drop out',
    );
    const en = derivedSuggestions(realised, 'en');
    assert.ok(
      en.some((line) => line.includes('October CPI') && line.includes('08:30 ET') && /in 4 days/.test(line)),
      'the en idea names the print, its ET time and the day count',
    );
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(
      zh.some((line) => line.includes('October CPI') && line.includes('08:30 ET') && line.includes('4 天后')),
      'the zh idea keeps the curated English ref but localises the framing',
    );
    const bare = derivedSuggestions(buildBriefInput({ stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }] }), 'en');
    assert.ok(bare.every((line) => !/ET\)/.test(line)), 'no macro idea without the calendar in the input');
    const stale = buildBriefInput({
      stocks: [],
      macro: { today: '2026-11-06', events: [{ kind: 'cpi', date: '2026-12-10', time: '08:30', ref: 'November CPI' }] },
    });
    assert.equal(stale.macroSoon, undefined, 'a print 30+ days out stays out of the model input');
    return 'macroSoon rides the brief input and ranks beside the breadth idea';
  });

  await check('1.1: a pre or post print steers the next open, so it earns its own idea', () => {
    const realised = buildBriefInput({
      stocks: [
        { symbol: 'NVDA', quote: { price: 188.2, changePct: -0.4, extended: { session: 'post', price: 182.9, changePct: -2.8, at: 1 } } },
        { symbol: 'AAPL', quote: { price: 342.37, changePct: 0.8, extended: { session: 'post', price: 343.6, changePct: 0.36, at: 1 } } },
        { symbol: 'VTI', quote: { price: 400, changePct: 0.2 } },
      ],
    });
    assert.deepEqual(realised.stocks[0].afterHours, { session: 'post', changePct: -2.8 }, 'the post print rides the input compactly');
    assert.equal(realised.stocks[1].afterHours.changePct, 0.36, 'a quiet after-hours move is carried, not filtered, at input time');
    assert.equal(realised.stocks[2].afterHours, undefined, 'a stock without an extended print carries nothing');
    const en = derivedSuggestions(realised, 'en');
    assert.ok(en.some((line) => line.includes('NVDA') && line.includes('-2.8%') && line.includes('after the bell')), 'the en idea names the move and its session');
    assert.ok(!en.some((line) => line.includes('+0.4%')), 'a sub-2% print does not take a line of its own');
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(zh.some((line) => line.includes('NVDA') && line.includes('盘后') && line.includes('-2.8%')), 'the zh idea localises the session');
    // A pre-market gap on the same symbol reads differently and still counts.
    const pre = derivedSuggestions(buildBriefInput({ stocks: [{ symbol: 'TSM', quote: { price: 300, extended: { session: 'pre', price: 312, changePct: 4, at: 1 } } }] }), 'en');
    assert.ok(pre.some((line) => line.includes('TSM') && line.includes('+4.0%') && line.includes('in the pre-market')), 'a pre-market print says so');
    // Malformed extended blocks must not invent a move.
    const junk = buildBriefInput({ stocks: [{ symbol: 'X', quote: { price: 10, extended: { session: 'overnight', changePct: 9 } } }] });
    assert.equal(junk.stocks[0].afterHours, undefined, 'an unknown session is dropped at input time');
    return 'post/pre prints above 2% become an action idea ahead of the technical ladder';
  });

  await check('1.1: a defensive tape frames every row before the row-level ideas', () => {
    const stocks = [{ symbol: 'AAPL', quote: { price: 210, changePct: -0.4 } }];
    const tape = [
      { symbol: '^GSPC', name: 'S&P 500', price: 6782.44, changePct: -1.62 },
      { symbol: '^VIX', name: 'VIX', price: 25.64, changePct: 3.1 },
    ];
    const realised = buildBriefInput({ stocks, tape });
    assert.equal(realised.tape.length, 2, 'both index rows ride along');
    assert.equal(realised.tape[0].changePct, -1.62, 'the day change is rounded, not dropped');
    const en = derivedSuggestions(realised, 'en');
    assert(en[0].includes('defensive'), `the tape leads, got ${en[0]}`);
    assert(en[0].includes('S&P 500 \u22121.6%'), `the move is signed, got ${en[0]}`);
    assert(en[0].includes('VIX 25.6'), `an elevated VIX is named, got ${en[0]}`);
    const zh = derivedSuggestions(realised, 'zh');
    assert(zh[0].includes('大盘偏弱'), `zh tone, got ${zh[0]}`);
    assert(zh[0].includes('VIX 25.6'), `zh VIX, got ${zh[0]}`);
    // A quiet session and a calm VIX say nothing at all.
    const flat = derivedSuggestions(buildBriefInput({ stocks, tape: [{ symbol: '^GSPC', changePct: 0.3 }] }), 'en');
    assert(flat.every((line) => !line.includes('The tape is')), 'a quiet tape is not a headline');
    const calm = derivedSuggestions(
      buildBriefInput({ stocks, tape: [{ symbol: '^GSPC', changePct: -1.2 }, { symbol: '^VIX', price: 15.2 }] }),
      'en',
    );
    assert(calm[0].includes('defensive') && !calm[0].includes('VIX'), `a calm VIX stays out, got ${calm[0]}`);
    const none = derivedSuggestions(buildBriefInput({ stocks }), 'en');
    assert(none.every((line) => !line.includes('The tape is')), 'no tape, no line');
  });

  await check('1.1: a shortened trading week takes the board-wide slot in the brief', () => {
    const realised = buildBriefInput({
      stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }],
      closures: {
        today: '2026-11-06',
        events: [
          { date: '2026-11-26', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
          { date: '2026-12-24', name: 'Christmas Day (observed)', nameZh: '圣诞节（观察日）', close: '13:00' },
          { date: '2026-11-27', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
        ],
      },
    });
    assert.equal(realised.closuresSoon, undefined, 'a closure 20 days out stays out of the model input');
    const near = buildBriefInput({
      stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }],
      closures: {
        today: '2026-11-22',
        events: [
          { date: '2026-11-26', name: 'Thanksgiving Day', nameZh: '感恩节', close: null },
          { date: '2026-11-27', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' },
        ],
      },
    });
    assert.deepEqual(
      near.closuresSoon.map((row) => `${row.date}:${row.days}:${row.close || 'closed'}`),
      ['2026-11-26:4:closed', '2026-11-27:5:13:00'],
      'both a full holiday and a half day inside the window ride along',
    );
    const en = derivedSuggestions(near, 'en');
    assert.ok(
      en.some((line) => line.includes('Thanksgiving Day') && line.includes('11-26') && line.includes('in 4 days') && /shut all day/.test(line)),
      'the en idea names the holiday and says nothing trades',
    );
    const zh = derivedSuggestions(near, 'zh');
    assert.ok(
      zh.some((line) => line.includes('感恩节') && line.includes('11-26') && line.includes('4 天后') && line.includes('全天休市')),
      'the zh idea localises the holiday name and the consequence',
    );
    const half = derivedSuggestions(buildBriefInput({
      stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }],
      closures: { today: '2026-11-24', events: [{ date: '2026-11-27', name: 'Day after Thanksgiving', nameZh: '感恩节次日', close: '13:00' }] },
    }), 'en');
    assert.ok(
      half.some((line) => line.includes('13:00 ET') && /before the cutoff/.test(line)),
      'a half day is about the cutoff, not a shut market',
    );
    const quiet = derivedSuggestions(buildBriefInput({ stocks: [{ symbol: 'VTI', quote: { price: 400, changePct: 0.2 } }] }), 'en');
    assert.ok(quiet.every((line) => !/NYSE|Exchange closure|休市/.test(line)), 'no closure idea without the calendar in the input');
    return 'closuresSoon rides the brief input and outranks the macro line';
  });

  await check('1.1: an expiry day still trades, so it warns about the hour rather than the day', () => {
    const base = { stocks: [{ symbol: 'AAPL', quote: { price: 210, changePct: 1 } }] };
    const far = buildBriefInput({
      ...base,
      closures: { today: '2026-11-13', events: [], expiries: [{ date: '2026-12-18', days: 35, quarterly: true }] },
    });
    assert.equal(far.opexSoon, undefined, 'an expiry a month out stays out of the model input');

    const near = buildBriefInput({
      ...base,
      closures: { today: '2026-11-13', events: [], expiries: [{ date: '2026-11-20', days: 7, quarterly: false, nameZh: '期权到期日' }] },
    });
    assert.deepEqual(near.opexSoon.map((row) => `${row.date}:${row.days}:${row.quarterly}`), ['2026-11-20:7:false']);

    const en = derivedSuggestions(near, 'en');
    assert.ok(
      en.some((line) => line.includes('2026-11-20') && line.includes('in 7 days') && /pin to round strikes/.test(line) && /before the last hour/.test(line)),
      'the en idea is about when in the day to trade, not whether the market is open',
    );
    const zh = derivedSuggestions(near, 'zh');
    assert.ok(
      zh.some((line) => line.includes('2026-11-20') && line.includes('7 天后') && line.includes('钉住') && line.includes('最后一小时')),
      'the zh idea says the same thing in the same order',
    );

    const quarterly = derivedSuggestions(buildBriefInput({
      ...base,
      closures: { today: '2026-12-14', events: [], expiries: [{ date: '2026-12-18', days: 4, quarterly: true }] },
    }), 'en');
    assert.ok(
      quarterly.some((line) => line.includes('quarter-end contracts')),
      'a quarterly expiry says so, because the hedging is larger',
    );

    const quiet = derivedSuggestions(buildBriefInput({ ...base, closures: { today: '2026-11-13', events: [] } }), 'en');
    assert.ok(quiet.every((line) => !/expire/i.test(line)), 'no expiry idea when the calendar carries none');
    return 'opexSoon rides the brief input and speaks about the session shape';
  });

  await check('0.5.x: a tag cluster earns a concentration note, quoted as intent', () => {
    const realised = buildBriefInput({
      stocks: [
        { symbol: 'NVDA', quote: { price: 500, changePct: 1.2 }, tags: ['芯片'] },
        { symbol: 'AMD', quote: { price: 200, changePct: -0.4 }, tags: ['芯片'] },
        { symbol: 'MU', quote: { price: 90, changePct: 0.8 }, tags: ['核心仓', '芯片'] },
        { symbol: 'V', quote: { price: 250, changePct: 0.1 }, tags: ['核心仓'] },
      ],
    });
    const en = derivedSuggestions(realised, 'en');
    assert.ok(
      en.some((line) => line.includes('3 of 4 watch rows') && line.includes('"芯片"') && line.includes('deliberate concentration')),
      'the en note counts the cluster and treats the tag as owner intent',
    );
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(
      zh.some((line) => line.includes('3 只带你的标签「芯片」') && line.includes('主题集中')),
      'the zh note localises the same count',
    );
    const sparse = derivedSuggestions(
      buildBriefInput({ stocks: [{ symbol: 'NVDA', quote: { price: 500 }, tags: ['芯片'] }] }),
      'en',
    );
    assert.ok(sparse.every((line) => !/carry your tag/.test(line)), 'no cluster note below three rows sharing a tag');
    const emptyTag = derivedSuggestions(
      buildBriefInput({
        stocks: [
          { symbol: 'NVDA', quote: { price: 500 }, tags: [null, '   '] },
          { symbol: 'AMD', quote: { price: 200 } },
          { symbol: 'MU', quote: { price: 90 } },
        ],
      }),
      'en',
    );
    assert.ok(emptyTag.every((line) => !/carry your tag/.test(line)), 'blank tag rows never count toward a cluster');
    return 'tag-cluster concentration idea rides beside the breadth line';
  });

  await check('0.5.x: a price stretched from its own MA20 earns a chase note', () => {
    const realised = buildBriefInput({
      stocks: [
        { symbol: 'NVDA', quote: { price: 500 }, technical: { technical: { ma20: 460 } } },
        { symbol: 'INTC', quote: { price: 40 }, technical: { technical: { ma20: 44 } } },
        { symbol: 'KO', quote: { price: 70 }, technical: { technical: { ma20: 69.5 } } },
      ],
    });
    const en = derivedSuggestions(realised, 'en');
    assert.ok(
      en.some((line) => line.startsWith('NVDA') && line.includes('8.7%') && line.includes('20-day average') && line.includes('460.00')),
      'the en stretch note quantifies the gap above the average',
    );
    assert.ok(
      en.some((line) => line.startsWith('INTC') && line.includes('9.1% below') && line.includes('not blind averaging down')),
      'the dislocation note fires on the downside and warns against averaging down',
    );
    assert.ok(!en.some((line) => line.startsWith('KO')), 'a row within 7% of its average earns no stretch note');
    const zh = derivedSuggestions(realised, 'zh');
    assert.ok(
      zh.some((line) => line.startsWith('NVDA') && line.includes('20 日均线') && line.includes('8.7%')),
      'the zh note localises the same read',
    );
    return 'MA20 stretch ideas ride the per-symbol ladder';
  });

  await check('buildBriefInput ages the whole brief by its oldest row', () => {
    const stocks = [
      { symbol: 'AAPL', quote: { timestamp: Date.now() }, stale: false },
      { symbol: 'MSFT', quote: { timestamp: Date.now() - 2 * 86_400_000 }, stale: true },
    ];
    const input = buildBriefInput({ stocks, asOf: Date.now() });
    assert.equal(input.dataRecency.grade, 'historical', 'one historical row ages the brief');
    assert.equal(input.dataRecency.staleStocks, 1, 'the count of cached rows is reported');
    assert.equal(input.dataRecency.stale, true, 'a cached row marks the brief stale');
    assert.equal(input.dataQuality.grade, 'historical');
    assert.match(input.dataQuality.qualification, /previous session|historical/i);
    return 'brief aged by oldest row';
  });

  await check('1.1: the brief input and directive carry the owner tags', () => {
    // Tags flow into the model input only when a row has them; the style
    // directive spells out how they may shape suggestions.
    const input = buildBriefInput({
      stocks: [
        { symbol: 'AAPL', quote: { timestamp: Date.now() }, tags: ['核心仓'] },
        { symbol: 'MSFT', quote: { timestamp: Date.now() } },
        { symbol: 'UBER', quote: { timestamp: Date.now() }, tags: [] },
      ],
      asOf: Date.now(),
    });
    const aapl = input.stocks.find((row) => row.symbol === 'AAPL');
    assert.deepEqual(aapl.tags, ['核心仓'], 'a tagged row keeps its labels');
    const msft = input.stocks.find((row) => row.symbol === 'MSFT');
    assert.equal('tags' in msft && msft.tags, undefined, 'an untagged row omits the key');
    const uber = input.stocks.find((row) => row.symbol === 'UBER');
    assert.equal('tags' in uber && uber.tags, undefined, 'an empty tag list omits the key too');
    assert.match(BRIEF_STYLE_DIRECTIVE, /tags: some rows carry/i, 'the directive explains intent vs data');
    assert.match(BRIEF_STYLE_DIRECTIVE, /never quote the label/i);
    return 'tags intent wired into the brief';
  });

  await check('1.1: the brief input ships the sector board as read-only context', () => {
    const input = buildBriefInput({
      stocks: [],
      earnings: null,
      sectors: [
        { symbol: 'XLK', en: 'Technology', zh: '科技', changePct: 1.104 },
        { symbol: 'XLE', en: 'Energy', zh: '能源', changePct: 'nope' },
        'junk',
        null,
      ],
    });
    assert.deepEqual(input.sectors, [{ symbol: 'XLK', en: 'Technology', zh: '科技', changePct: 1.1 }]);
    assert.equal('sectors' in buildBriefInput({ stocks: [] }) && buildBriefInput({ stocks: [] }).sectors, undefined);
    assert.match(BRIEF_STYLE_DIRECTIVE, /sectors: an optional read-only board backdrop/i);
    return 'sector context passes through only with a numeric day change';
  });

  console.log(`\n=== ${passed}/${passed + failures.length} checks passed, ${failures.length} failed ===`);
  report();
  if (failures.length) {
    for (const failure of failures) console.log(`  - ${failure.title}: ${failure.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  failures.push({ title: 'suite crashed', message: err && err.message });
  report();
  process.exit(1);
});
