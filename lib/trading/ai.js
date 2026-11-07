/**
 * DeepSeek analysis layer (spec §4, §34–§37, §40, §43, §53).
 *
 * Hard boundary (§4): this module never fetches market data. It receives an
 * already-computed, structured snapshot from MarketDataService and returns
 * natural-language interpretation. It is also never allowed to invent numbers —
 * the prompt forbids it and the output schema has no free-form price fields
 * other than levels the model must copy from the supplied support/resistance
 * candidates.
 */

import { AI_CONFIG, DISCLAIMER } from './config.js';
import { CODES, TradingError } from './errors.js';

/** Provider failure codes worth another attempt (mirrors dsh-llm-retry). */
const RETRYABLE = new Set(['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'AI_INVALID_OUTPUT']);

/** Spec §34 — reproduced as required, with the output contract appended. */
export const STOCK_SYSTEM_PROMPT = `You are the AI market analysis engine inside DSH Trading Mode. Analyze only the structured financial data provided by the system.

Rules you must follow:
1. Never invent market data.
2. Never invent prices, volume, technical indicators, company information or events.
3. Use only values provided in the input.
4. Clearly distinguish factual observations from interpretation.
5. If data is missing, state that it is unavailable.
6. Respect market data timestamps.
7. Do not describe delayed data as live market data.
8. Do not recalculate technical indicators when system-calculated values are supplied.
9. Explain technical concepts clearly.
10. Do not make guaranteed price predictions.
11. Do not present the output as financial advice.
12. Focus on: trend, momentum, volume, volatility, support, resistance, risk.

Return ONE JSON object and nothing else — no prose, no markdown, no code fences. The object must match exactly this shape:
{
  "summary": string,
  "trend": { "shortTerm": string, "mediumTerm": string, "longTerm": string },
  "momentum": string,
  "volume": string,
  "supportLevels": number[],
  "resistanceLevels": number[],
  "riskFactors": string[],
  "keyObservations": string[]
}
supportLevels and resistanceLevels must be copied from the "levels" block of the input (pivotSupport / pivotResistance / low52w / high52w / ma20 / ma50 / ma200). Use an empty array when the input has no usable level. Every number you write must appear in the input.`;

/** Spec §40 — reproduced as required, plus the output contract. */
export const BRIEF_SYSTEM_PROMPT = `You are generating a concise market brief for a user's stock watchlist. Use only supplied structured market data.

Identify:
1. Largest gainers
2. Largest decliners
3. Unusual volume
4. Important technical changes
5. Differences among watched companies
6. Stocks near important support or resistance

Do not assume the user owns these stocks. Refer to them as watchlist stocks. Do not provide guaranteed predictions. Keep the output concise and data-driven.

Also produce, for the UI header, a plain count of how many watchlist stocks were tracked and how many were up versus down.

Return ONE JSON object and nothing else — no prose, no markdown, no code fences. The object must match exactly this shape:
{
  "headline": string,
  "stocksTracked": number,
  "upCount": number,
  "downCount": number,
  "strongestMover": string,
  "largestDecline": string,
  "unusualVolume": string[],
  "keyObservations": string[]
}
Every symbol, price and percentage you mention must come from the input. Use an empty array for unusualVolume when nothing qualifies.`;

/**
 * Presentation rules for the watchlist brief (0.8.2 UI pass).
 *
 * Appended, never interleaved: the published spec fixes the system prompt and the
 * JSON contract byte-for-byte. This only shapes how the same fields read — fewer,
 * shorter observation lines, no duplicated recency boilerplate (the card renders
 * the timestamp itself), and a decision cue instead of an indicator dump.
 */
export const BRIEF_STYLE_DIRECTIVE = `

Presentation rules for this brief (every key above stays exactly as specified; one extra key is described below and is optional — omit it when the data supports nothing):
- keyObservations: at most 5 items, one short sentence each (aim for under 40 Chinese characters). Start every item with the ticker symbol.
- Do not restate data recency, "delayed data" or disclaimers inside keyObservations; the interface already shows the timestamp and the disclaimer separately.
- Prefer a decision cue over a number dump: name the level that matters and what would confirm a move, instead of listing every indicator value.
- unusualVolume: at most 3 items, each in the form "SYMBOL 1.75x", never a full sentence.
- suggestions: 3 to 5 items — the part the user can act on. Start each item with the ticker symbol when it is about one stock. Each item must state a concrete condition or next step: a level worth watching, what would confirm a move, or what would invalidate it. Forbid generic advice ("do your own research"), guaranteed predictions, price targets you did not derive from the input, and any position size or money amount.
- tags: some rows carry the owner's own group labels ("核心仓", "watch"). Treat them as intent, not as data: a tagged core position earns steadier, maintenance-flavoured suggestions, a watch row earns entry ideas. Never quote the label itself as a fact or a reason.
- sectors: an optional read-only board backdrop (industry ETF day changes). Use it only as colour for which market segment leaned which way today. It is never a row's own trend, never a basis to assert a stock-level level the input does not carry, and never quoted as one stock's percentage.`;

/**
 * Recency directive (0.7.0, plan item: no live-sounding wording on old data).
 * 0.8.0 (round-3 P1⑤) renamed the youngest grade `live` → `fresh`: this plugin
 * consumes public, unauthenticated endpoints and has no real-time entitlement, so
 * no grade may be described as live.
 *
 * The published spec fixes the two system prompts, so this is **appended**, not
 * interleaved: the original text above stays byte-for-byte intact.
 */
export const RECENCY_DIRECTIVE = `
Recency rules for this answer (the input carries dataRecency and dataQuality — trust them):
- grade "fresh": the numbers are recent, but they are still not a real-time feed; say the timestamp instead of promising a live price.
- grade "delayed": say explicitly that the data is delayed.
- grade "stale": say the data is the last available data, not current, and name its timestamp.
- grade "historical": the numbers are from a previous session; never present them as a current price.
- Never write "now", "today", "currently trading" or "live" whatever the grade.
- When stale is true, name which block (quote or candles) is stale and why.`;

/**
 * Localisation directive appended to the system prompt.
 *
 * The published spec fixes the system prompts and the JSON contract, so the
 * prompts themselves are never rewritten: only the natural-language strings
 * inside the answer change. Keys, codes, symbols and numbers stay exactly as the
 * schema requires, which keeps `normalizeAnalysis()` / `normalizeBrief()`
 * language-agnostic.
 *
 * @param {string|null|undefined} lang 'en' (default) or 'zh'
 * @returns {string} '' for English, otherwise the additive instruction
 */
export function languageDirective(lang) {
  if (lang !== 'zh') return '';
  return `

Localisation: write every human-readable string in the JSON values (summary, trend, momentum, volume, riskFactors, keyObservations, and for a brief: headline, strongestMover, largestDecline, unusualVolume, suggestions) in Simplified Chinese (简体中文). Keep every JSON key, ticker symbol, currency code, number, unit and percentage exactly as specified above — do not translate or reformat them.`;
}

/**
 * Assembles the host `llm.stream()` chunk sequence into text, per the public
 * `StreamChunk` contract.
 *
 * The plugin must NOT import `@deepseek-ai/dsh-llm`: that package is a host
 * dependency that lives inside the application bundle and is not installed into
 * the profile (`autoInstallPeers: false` + a `link:`-ed plugin has no
 * node_modules), so resolving it from plugin code always failed and every brief
 * died with AI_UNAVAILABLE. The chunk union is public API, so assembling it here
 * is both sufficient and strictly more robust than depending on host internals.
 *
 * Handled: block-start / text-delta / reasoning-delta / tool-call-delta /
 * block-end / usage / finish. Unknown types are ignored on purpose.
 */
export class ChunkAssembler {
  constructor() {
    /** @type {Map<number|string, any>} */
    this.blocks = new Map();
    /** @type {(number|string)[]} */
    this.order = [];
    this.current = null;
    this.usage = null;
    /** @type {{kind: string|null, failure: any, raw: any}} */
    this.finish = { kind: null, failure: null, raw: null };
    this.sawChunk = false;
  }

  /** @param {any} chunk */
  push(chunk) {
    if (!chunk || typeof chunk !== 'object') return this;
    this.sawChunk = true;
    switch (chunk.type) {
      case 'block-start': {
        const block = this.blockFor(chunk.index, chunk.blockType || 'text');
        block.type = chunk.blockType || block.type;
        break;
      }
      case 'text-delta': {
        this.blockFor(chunk.index, 'text').text += typeof chunk.text === 'string' ? chunk.text : '';
        break;
      }
      case 'reasoning-delta': {
        const block = this.blockFor(chunk.index, 'reasoning');
        block.type = 'reasoning';
        block.reasoning += typeof chunk.text === 'string' ? chunk.text : '';
        break;
      }
      case 'tool-call-delta': {
        const block = this.blockFor(chunk.index ?? chunk.id, 'tool-call');
        block.type = 'tool-call';
        block.name = chunk.name ?? block.name;
        block.arguments = `${block.arguments || ''}${chunk.argumentsDelta ?? ''}`;
        break;
      }
      case 'block-end': {
        const block = this.blockFor(chunk.index, chunk.block?.type || 'text');
        block.ended = true;
        if (chunk.block && typeof chunk.block === 'object') {
          if (typeof chunk.block.type === 'string') block.type = chunk.block.type;
          if (typeof chunk.block.text === 'string') block.text = chunk.block.text;
          if (typeof chunk.block.reasoning === 'string') block.reasoning = chunk.block.reasoning;
          block.final = chunk.block;
        }
        break;
      }
      case 'usage': {
        if (chunk.usage && typeof chunk.usage === 'object') this.usage = chunk.usage;
        break;
      }
      case 'finish': {
        const reason = chunk.reason;
        const kind = typeof reason === 'string' ? reason : reason?.kind ?? reason?.type ?? null;
        const failure = reason && typeof reason === 'object' ? reason.failure ?? null : null;
        this.finish = { kind, failure, raw: reason };
        break;
      }
      default:
        break;
    }
    return this;
  }

  blockFor(index, type) {
    const key = typeof index === 'number' || typeof index === 'string' ? index : this.current ?? 0;
    this.current = key;
    let block = this.blocks.get(key);
    if (!block) {
      block = { index: key, type, text: '', reasoning: '', ended: false };
      this.blocks.set(key, block);
      this.order.push(key);
    }
    return block;
  }

  /** Visible answer text: text blocks only, never reasoning or tool arguments. */
  text() {
    return this.order
      .map((key) => this.blocks.get(key))
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
      .map((block) => block.text)
      .join('');
  }

  /** The terminal finish reason, inferred when the stream ended without one. */
  finishReason() {
    if (this.finish.kind) return this.finish;
    if (this.text()) return { kind: 'stop', failure: null, raw: null };
    return { kind: 'error', failure: { message: 'the model stream ended without producing any text' }, raw: null };
  }
}

export class TradingAi {
  /**
   * @param {{llm?: any, defaultModel?: any, logger?: any, config?: any}} [opts]
   *   `llm` / `defaultModel` may be the service itself **or a getter**. Getters
   *   are preferred: the plugin is applied from `ready` and the services it
   *   needs may be registered afterwards, so binding them once at apply time
   *   could freeze them to `undefined`.
   */
  constructor(opts = {}) {
    this._llm = opts.llm || null;
    this._defaultModel = opts.defaultModel || null;
    this.logger = opts.logger || null;
    this.config = { ...AI_CONFIG, ...(opts.config || {}) };
    /** @type {'idle'|'ok'|'degraded'} */
    this.state = 'idle';
    this.lastError = null;
    this.calls = 0;
    this.failures = 0;
    this.lastRoute = null;
  }

  /** Late-bound host `llm` service (see the constructor note). */
  get llm() {
    return readService(this._llm);
  }

  /** Late-bound host `agentDefaultModel` service. */
  get defaultModel() {
    return readService(this._defaultModel);
  }

  get available() {
    const llm = this.llm;
    return Boolean(llm && typeof llm.stream === 'function');
  }

  /** Why the AI panel is unavailable — surfaced in `status()` for diagnosis. */
  unavailableReason() {
    if (!this._llm) return 'the plugin did not receive the llm service (ctx.llm)';
    const llm = this.llm;
    if (!llm) return 'ctx.get("llm") is not registered (is the dsh-llm plugin loaded?)';
    if (typeof llm.stream !== 'function') return 'the llm service exposes no stream() method';
    if (!this.resolveRouteSync()) return 'no DeepSeek model route is configured in DSH';
    return null;
  }

  /**
   * Synchronous part of route resolution: explicit overrides → plugin config →
   * DSH's current default model. Async provider discovery lives in
   * `resolveRoute()`.
   */
  resolveRouteSync(overrides = {}) {
    if (overrides.provider && overrides.model) return { provider: overrides.provider, model: overrides.model };
    if (this.config.provider && this.config.model) return { provider: this.config.provider, model: this.config.model };
    try {
      const model = this.defaultModel;
      const selection = model && typeof model.currentSelection === 'function' ? model.currentSelection() : null;
      // The host hands back a detached selection; accept both the documented
      // `{provider, model}` shape and a `{providerId, modelId}` alias so a host
      // rename degrades to the async discovery path instead of failing.
      if (selection) {
        const provider = selection.provider || selection.providerId;
        const id = selection.model || selection.modelId;
        if (provider && id) return { provider, model: id };
      }
    } catch (err) {
      this.logger?.debug?.(`ai: currentSelection() failed: ${err && err.message}`);
    }
    return null;
  }

  /**
   * The model route to use. Falls back to asking the llm service which provider
   * advertises a DeepSeek model; `listModels()` is asynchronous in the host
   * contract, so this method is async too.
   */
  async resolveRoute(overrides = {}) {
    const direct = this.resolveRouteSync(overrides);
    if (direct) return direct;
    const llm = this.llm;
    try {
      if (llm && typeof llm.listProviders === 'function') {
        const providers = (await llm.listProviders()) || [];
        for (const provider of providers) {
          const id = typeof provider === 'string' ? provider : provider?.id;
          if (!id) continue;
          let models = [];
          try {
            models = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
          } catch (err) {
            this.logger?.debug?.(`ai: listModels(${id}) failed: ${err && err.message}`);
          }
          const model = (models || []).map((m) => (typeof m === 'string' ? m : m?.id)).find((m) => m && /deepseek/i.test(m));
          if (model) return { provider: id, model };
        }
      }
    } catch (err) {
      this.logger?.debug?.(`ai: provider discovery failed: ${err && err.message}`);
    }
    return null;
  }

  /**
   * One structured DeepSeek call: `ctx.llm.stream()` → chunk assembly → JSON.
   * The DSH retry plugin does not cover direct plugin calls, so retry here.
   */
  async askJson(system, userText, opts = {}) {
    const llm = this.llm;
    if (!llm || typeof llm.stream !== 'function') {
      throw new TradingError(CODES.AI_UNAVAILABLE, `the DSH LLM runtime is not available to this plugin: ${this.unavailableReason() || 'no llm service'}`, { retryable: false });
    }
    const route = await this.resolveRoute(opts);
    if (!route) {
      throw new TradingError(
        CODES.AI_UNAVAILABLE,
        'no DeepSeek model route is configured in DSH (set a model in the GUI, or configure provider/model for the trading-mode plugin)',
        { retryable: false },
      );
    }
    this.lastRoute = route;

    const attempts = Math.max(1, opts.attempts ?? 3);
    const maxTokens = opts.maxTokens ?? this.config.maxTokens;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeoutMs = opts.timeoutMs ?? this.config.timeoutMs;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });
      const startedAt = Date.now();
      try {
        // Request messages must satisfy the host's `RequestUserInput` shape:
        // role + content only — no `id`, no `source` (both are `never` there).
        const assembler = new ChunkAssembler();
        const stream = await llm.stream({
          provider: route.provider,
          model: route.model,
          messages: [buildUserMessage(userText)],
          system,
          maxTokens,
          temperature: this.config.temperature,
          signal: controller.signal,
        });
        for await (const chunk of stream) assembler.push(chunk);

        const finish = assembler.finishReason();
        if (finish.kind === 'aborted') {
          throw Object.assign(new Error(`the model call was aborted: ${finish.failure?.message || 'timeout or cancellation'}`), { code: 'TIMEOUT', aborted: true });
        }
        if (finish.kind === 'error') {
          throw Object.assign(new Error(finish.failure?.message || 'the model reported an error'), { code: finish.failure?.code || 'SERVER' });
        }
        if (finish.kind === 'max-tokens') {
          throw Object.assign(new Error(`the model hit the ${maxTokens}-token cap before finishing its JSON; nothing usable was returned`), { code: 'AI_INVALID_OUTPUT' });
        }
        if (finish.kind !== 'stop') {
          throw Object.assign(new Error(`unusable finish reason: ${finish.kind}`), { code: 'AI_INVALID_OUTPUT' });
        }
        const text = assembler.text();
        if (!text.trim()) {
          throw Object.assign(new Error('the model returned no text'), { code: 'EMPTY_RESPONSE' });
        }
        const parsed = JSON.parse(repair(text));
        this.calls += 1;
        this.state = 'ok';
        this.lastError = null;
        return { value: parsed, meta: { provider: route.provider, model: route.model, attempt, elapsedMs: Date.now() - startedAt, usage: assembler.usage || null } };
      } catch (err) {
        lastError = err;
        const code = err?.code ?? err?.failure?.code;
        const retryable = !code || RETRYABLE.has(code);
        this.logger?.debug?.(`ai: attempt ${attempt}/${attempts} failed (${code || 'unknown'}: ${err && err.message})`);
        if (attempt >= attempts || !retryable) break;
        await sleep(500 * 2 ** (attempt - 1));
      } finally {
        clearTimeout(timer);
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    }
    this.failures += 1;
    this.state = 'degraded';
    this.lastError = lastError ? lastError.message : 'unknown failure';
    throw new TradingError(CODES.AI_UNAVAILABLE, `DeepSeek analysis failed: ${this.lastError}`, { cause: lastError, provider: route.provider });
  }

  /**
   * §37 single-stock analysis. `snapshot` is assembled by ApiRoutes from the
   * service — this function performs no I/O of its own.
   * @param {any} snapshot {symbol, quote, profile, technical, candles}
   */
  async analyzeStock(snapshot, opts = {}) {
    const input = buildStockInput(snapshot);
    const lang = opts.lang === 'zh' ? 'zh' : 'en';
    const { value, meta } = await this.askJson(STOCK_SYSTEM_PROMPT + RECENCY_DIRECTIVE + languageDirective(lang), JSON.stringify(input), opts);
    const analysis = normalizeAnalysis(value, input.data);
    return {
      analysis,
      meta: {
        ...meta,
        symbol: snapshot.symbol,
        dataAsOf: input.data.asOf,
        quoteSource: snapshot.quote?.source || null,
        dataStale: Boolean(snapshot.stale),
        dataQuality: qualityFor(input.data.dataRecency, input.data.technical),
        lang,
        disclaimer: DISCLAIMER,
      },
    };
  }

  /** §38–§40 watchlist brief. */
  async watchlistBrief(snapshot, opts = {}) {
    const input = buildBriefInput(snapshot);
    if (!input.stocks.length) {
      throw new TradingError(CODES.BAD_REQUEST, 'the watchlist is empty, so there is nothing to summarise');
    }
    const lang = opts.lang === 'zh' ? 'zh' : 'en';
    const { value, meta } = await this.askJson(BRIEF_SYSTEM_PROMPT + RECENCY_DIRECTIVE + languageDirective(lang) + BRIEF_STYLE_DIRECTIVE, JSON.stringify(input), opts);
    const brief = normalizeBrief(value, input, lang);
    return {
      brief,
      meta: {
        ...meta,
        stocksTracked: input.stocks.length,
        dataAsOf: input.asOf,
        dataQuality: qualityFor(input.dataRecency, null),
        lang,
        disclaimer: DISCLAIMER,
      },
    };
  }

  status() {
    return {
      available: this.available,
      state: this.state,
      reason: this.unavailableReason(),
      route: this.resolveRouteSync(),
      lastRoute: this.lastRoute,
      calls: this.calls,
      failures: this.failures,
      lastError: this.lastError,
      maxTokens: this.config.maxTokens,
      timeoutMs: this.config.timeoutMs,
    };
  }
}

// -------------------------------------------------------------------- shaping

/** Everything the model is allowed to see, and nothing else (§4/§16). */
export function buildStockInput(snapshot) {
  const { quote, profile, technical } = snapshot;
  const dataRecency = recencyOf(snapshot.asOf ?? quote?.timestamp, {
    stale: Boolean(snapshot.stale),
    staleReason: snapshot.staleReason ?? null,
    marketOpen: snapshot.marketOpen ?? null,
    dataAgeMs: snapshot.dataAgeMs,
  });
  return {
    instruction: 'Analyse this single stock using only the values below.',
    data: {
      symbol: snapshot.symbol,
      market: snapshot.market,
      company: {
        name: profile?.name || quote?.name || null,
        nameZh: profile?.nameZh || quote?.nameZh || null,
        exchange: profile?.exchange || quote?.exchange || null,
        currency: profile?.currency || quote?.currency || null,
        industry: profile?.industry || null,
        sector: profile?.sector || null,
        country: profile?.country || null,
        description: profile?.description ? truncate(profile.description, 900) : null,
      },
      quote: quote
        ? {
            price: quote.price,
            change: quote.change,
            changePct: quote.changePct,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            previousClose: quote.previousClose,
            volume: quote.volume,
            timestamp: isoOrNull(quote.timestamp),
            source: quote.source,
            delaySeconds: quote.delaySeconds,
            stale: Boolean(quote.stale),
          }
        : null,
      asOf: isoOrNull(snapshot.asOf),
      /** 0.7.0: the model must know how old the numbers are before it writes prose. */
      dataRecency,
      technical: technical
        ? {
            asOf: isoOrNull(technical.asOf),
            bars: technical.bars,
            interval: technical.interval,
            values: technical.technical,
            trendAlignment: technical.technical?.trendAlignment,
            unavailable: technical.unavailable,
            /** How much history backs the indicators (may be 'insufficient'). */
            quality: technical.quality ?? null,
          }
        : null,
      levels: technical?.levels || null,
      recentDailyCloses: recentCloses(snapshot.candles, 20),
      marketSessionOpen: snapshot.marketOpen ?? null,
    },
    dataAvailability: {
      quote: Boolean(quote),
      profile: Boolean(profile),
      technical: Boolean(technical?.technical),
      missingFields: technical?.unavailable || [],
      historyGrade: technical?.quality?.grade ?? null,
    },
  };
}

export function buildBriefInput(snapshot) {
  const stamps = (snapshot.stocks || []).map((entry) => entry.quote?.timestamp).filter((ts) => Number.isFinite(Number(ts)));
  const oldest = stamps.length ? Math.min(...stamps.map(Number)) : null;
  const staleStocks = (snapshot.stocks || []).filter((entry) => entry.stale).length;
  // Earnings dates ride along with the brief so action ideas can warn about a
  // print *before* the user sizes a position. The calendar is advisory: when
  // the host could not fetch it, every row simply stays null.
  const earnBySymbol = (snapshot.earnings && snapshot.earnings.bySymbol) || {};
  const earnToday = snapshot.earnings && snapshot.earnings.today ? String(snapshot.earnings.today).slice(0, 10) : null;
  const earningsFor = (symbol) => {
    const event = earnBySymbol[symbol];
    if (!event || !event.date) return { earningsDate: null, earningsSession: null, earningsInDays: null };
    const days = dayDiff(event.date, earnToday);
    return {
      earningsDate: String(event.date).slice(0, 10),
      earningsSession: event.session || null,
      earningsInDays: days === null || days < -30 ? null : days,
    };
  };
  const afterHoursOf = (entry) => {
    const ext = entry && entry.quote && entry.quote.extended;
    if (!ext || (ext.session !== 'pre' && ext.session !== 'post')) return undefined;
    const pct = Number(ext.changePct);
    if (!Number.isFinite(pct)) return undefined;
    return { session: ext.session, changePct: Math.round(pct * 100) / 100 };
  };
  // A brief is only as fresh as its *oldest* row: `snapshot.asOf` is the moment
  // the payload was assembled, so it must never upgrade a stale watchlist to
  // "live" — it is only a fallback when no row carries a timestamp.
  const dataRecency = recencyOf(oldest ?? snapshot.asOf, {
    stale: staleStocks > 0,
    staleReason: staleStocks ? `${staleStocks} of ${(snapshot.stocks || []).length} watchlist rows are cached` : null,
    marketOpen: null,
    dataAgeMs: null,
  });
  // 1.1: the day's sector board rides along as read-only context — colour for
  // which corner of the market the watchlist sits against. Never a substitute
  // for a row's own technicals, and rows without a numeric day change drop out.
  const sectors = Array.isArray(snapshot.sectors)
    ? snapshot.sectors
        .map((sector) => {
          if (!sector || typeof sector !== 'object' || typeof sector.symbol !== 'string') return null;
          const pct = Number(sector.changePct);
          if (!Number.isFinite(pct)) return null;
          return {
            symbol: sector.symbol,
            en: typeof sector.en === 'string' ? sector.en : null,
            zh: typeof sector.zh === 'string' ? sector.zh : null,
            changePct: Math.round(pct * 100) / 100,
          };
        })
        .filter(Boolean)
    : null;
  // 1.1: the index tape frames every row at once - a defensive S&P with a
  // 25-handle VIX changes what "buy the dip" means, and no single symbol can
  // say it. Rows without a numeric day change drop out; the whole block is
  // simply absent when the host could not read the indices.
  const tape = Array.isArray(snapshot.tape)
    ? snapshot.tape
        .map((row) => {
          if (!row || typeof row.symbol !== 'string') return null;
          const pct = Number(row.changePct);
          const price = Number(row.price);
          if (!Number.isFinite(pct)) return null;
          return {
            symbol: row.symbol.toUpperCase(),
            name: typeof row.name === 'string' ? row.name : null,
            price: Number.isFinite(price) && price > 0 ? Math.round(price * 100) / 100 : null,
            changePct: Math.round(pct * 100) / 100,
          };
        })
        .filter(Boolean)
    : null;
  // 0.5.x: market-wide macro prints inside the next 7 days ride along so the
  // action ideas can frame the whole board — a CPI or FOMC week is a risk no
  // single row carries. The macro table is a build-time constant, so this can
  // only be absent (host chose not to send it), never fail.
  const macroSoon = Array.isArray(snapshot.macro && snapshot.macro.events)
    ? snapshot.macro.events
        .map((event) => {
          if (!event || typeof event.date !== 'string') return null;
          const days = dayDiff(event.date, snapshot.macro.today);
          if (days === null || days < 0 || days > 7) return null;
          return {
            kind: typeof event.kind === 'string' ? event.kind : null,
            date: String(event.date).slice(0, 10),
            time: typeof event.time === 'string' && event.time ? event.time : null,
            ref: typeof event.ref === 'string' && event.ref ? event.ref : null,
            days,
          };
        })
        .filter(Boolean)
        .slice(0, 2)
    : null;
  // 1.1: the exchange calendar is also a build-time constant, and it answers a
  // different question than the macro lines above: not *what* moves prices but
  // *when an order can still be filled*. A 13:00 ET close or a full holiday
  // inside the week belongs in the action ideas even on a quiet tape.
  const closuresSoon = Array.isArray(snapshot.closures && snapshot.closures.events)
    ? snapshot.closures.events
        .map((row) => {
          if (!row || typeof row.date !== 'string') return null;
          const days = dayDiff(row.date, snapshot.closures.today);
          if (days === null || days < 0 || days > 7) return null;
          return {
            date: String(row.date).slice(0, 10),
            days,
            name: typeof row.name === 'string' && row.name ? row.name : null,
            nameZh: typeof row.nameZh === 'string' && row.nameZh ? row.nameZh : null,
            close: typeof row.close === 'string' && row.close ? row.close : null,
          };
        })
        .filter(Boolean)
        .slice(0, 2)
    : null;
  // 1.1: an expiry is a different kind of day than a closure — the market is
  // open, but the tape pins to round strikes while dealers hedge, so the advice
  // is about *when in the day* to trade rather than whether one can.
  const opexSoon = Array.isArray(snapshot.closures && snapshot.closures.expiries)
    ? snapshot.closures.expiries
        .map((row) => {
          if (!row || typeof row.date !== 'string') return null;
          const days = dayDiff(row.date, snapshot.closures.today);
          if (days === null || days < 0 || days > 7) return null;
          return {
            date: String(row.date).slice(0, 10),
            days,
            quarterly: row.quarterly === true,
            nameZh: typeof row.nameZh === 'string' && row.nameZh ? row.nameZh : null,
          };
        })
        .filter(Boolean)
        .slice(0, 1)
    : null;
  // 1.1: the street's target is only worth a sentence when it disagrees with
  // the print by a margin. Rows without both numbers are dropped, not guessed.
  const analystViews = Array.isArray(snapshot.analysts)
    ? snapshot.analysts
        .map((row) => {
          if (!row || typeof row.symbol !== 'string' || !row.symbol) return null;
          const target = finite(row.targetMean);
          const last = finite(row.price);
          if (target === null || target <= 0 || last === null || last <= 0) return null;
          return {
            symbol: row.symbol.toUpperCase(),
            targetMean: Math.round(target * 100) / 100,
            price: Math.round(last * 100) / 100,
            rating: typeof row.rating === 'string' && row.rating ? row.rating.slice(0, 40) : null,
            count: finite(row.count),
          };
        })
        .filter(Boolean)
        .slice(0, 3)
    : null;

  return {
    instruction: 'Summarise this watchlist using only the values below.',
    tape: tape && tape.length ? tape : undefined,
    analystViews: analystViews && analystViews.length ? analystViews : undefined,
    sectors: sectors && sectors.length ? sectors : undefined,
    macroSoon: macroSoon && macroSoon.length ? macroSoon : undefined,
    closuresSoon: closuresSoon && closuresSoon.length ? closuresSoon : undefined,
    opexSoon: opexSoon && opexSoon.length ? opexSoon : undefined,
    stocks: (snapshot.stocks || []).map((entry) => ({
      symbol: entry.symbol,
      name: entry.quote?.name || entry.quote?.nameZh || null,
      market: entry.market,
      // 1.1: the owner's own group labels ("核心仓"/"观察"). Intent, not data.
      tags: Array.isArray(entry.tags) && entry.tags.length ? entry.tags : undefined,
      currency: entry.quote?.currency || null,
      price: entry.quote?.price ?? null,
      // The pre/post print is the latest trade after 16:00, carried compactly so
      // an action idea can warn about a gap the closing price cannot show.
      afterHours: afterHoursOf(entry),
      change: entry.quote?.change ?? null,
      changePct: entry.quote?.changePct ?? null,
      volume: entry.quote?.volume ?? null,
      volumeRatio20d: entry.technical?.technical?.volumeRatio20d ?? null,
      rsi14: entry.technical?.technical?.rsi14 ?? null,
      macdHistogram: entry.technical?.technical?.macdHistogram ?? null,
      ma20: entry.technical?.technical?.ma20 ?? null,
      ma50: entry.technical?.technical?.ma50 ?? null,
      ma200: entry.technical?.technical?.ma200 ?? null,
      trendAlignment: entry.technical?.technical?.trendAlignment ?? null,
      high52w: entry.technical?.technical?.high52w ?? null,
      low52w: entry.technical?.technical?.low52w ?? null,
      ...earningsFor(entry.symbol),
      timestamp: isoOrNull(entry.quote?.timestamp),
      source: entry.quote?.source ?? null,
      stale: Boolean(entry.stale),
      unavailable: entry.technical?.unavailable || [],
      errors: entry.error ? [entry.error] : [],
    })),
    asOf: isoOrNull(snapshot.asOf),
    dataRecency: { ...dataRecency, staleStocks, totalStocks: (snapshot.stocks || []).length },
    dataQuality: qualityFor(dataRecency, null),
  };
}

/** Age of a provider timestamp in ms; timestamps arrive in seconds or ms. */
export function ageMsOf(asOf, now = Date.now()) {
  const ts = Number(asOf);
  if (!Number.isFinite(ts) || ts <= 0) return null;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return Math.max(0, now - ms);
}

/**
 * Turn "when was this measured" into a grade the prompt and the UI can use.
 * `ageMs` may be supplied when the caller already computed it.
 */
export function recencyOf(asOf, { stale = false, staleReason = null, marketOpen = null, dataAgeMs = null } = {}) {
  const ageMs = Number.isFinite(dataAgeMs) ? dataAgeMs : ageMsOf(asOf);
  const ageSeconds = ageMs === null ? null : Math.round(ageMs / 1000);
  let grade = 'unknown';
  if (ageMs !== null) {
    if (ageMs <= AI_CONFIG.freshMaxAgeMs) grade = 'fresh';
    else if (ageMs <= AI_CONFIG.staleWarnMs) grade = 'delayed';
    else if (ageMs <= AI_CONFIG.staleHistoricalMs) grade = 'stale';
    else grade = 'historical';
  }
  return {
    asOf: isoOrNull(asOf),
    ageSeconds,
    grade,
    stale: Boolean(stale),
    staleReason: staleReason || null,
    marketSessionOpen: marketOpen ?? null,
  };
}

/**
 * The compact quality verdict returned with an answer, so the client can label
 * it ("fresh" / "delayed" / "last available session") instead of implying the
 * numbers are real-time.
 */
export function qualityFor(dataRecency, technical) {
  const recency = dataRecency || { grade: 'unknown', ageSeconds: null, stale: false };
  const grade = recency.grade || 'unknown';
  const qualification =
    grade === 'fresh'
      ? 'Market data is recent; the timestamp is shown and the feed is not claimed to be real-time.'
      : grade === 'delayed'
        ? 'Market data is delayed; treat the numbers as indicative, not real-time.'
        : grade === 'stale'
          ? 'Market data is the last available snapshot, not a current quote.'
          : grade === 'historical'
            ? 'Market data is from a previous session and is shown as historical values.'
            : 'Data age could not be determined; do not describe the numbers as current.';
  return {
    grade,
    ageSeconds: recency.ageSeconds ?? null,
    stale: Boolean(recency.stale),
    staleReason: recency.staleReason || null,
    qualification,
    historyGrade: technical?.quality?.grade ?? null,
    historyBars: technical?.bars ?? null,
  };
}

/** §35 shape, coerced field by field — the model is never trusted blindly. */
export function normalizeAnalysis(raw, input) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const trend = src.trend && typeof src.trend === 'object' ? src.trend : {};
  const candidates = levelCandidates(input);
  const support = matchLevels(numbers(src.supportLevels), candidates);
  const resistance = matchLevels(numbers(src.resistanceLevels), candidates);
  return {
    summary: text(src.summary, 'No summary was returned.'),
    trend: {
      shortTerm: text(trend.shortTerm, 'Unavailable.'),
      mediumTerm: text(trend.mediumTerm, 'Unavailable.'),
      longTerm: text(trend.longTerm, 'Unavailable.'),
    },
    momentum: text(src.momentum, 'Unavailable.'),
    volume: text(src.volume, 'Unavailable.'),
    supportLevels: support.accepted,
    resistanceLevels: resistance.accepted,
    /** Level numbers the model produced that no input could support. */
    rejectedLevels: { support: support.rejected, resistance: resistance.rejected },
    riskFactors: strings(src.riskFactors),
    keyObservations: strings(src.keyObservations),
  };
}

/** A rounded quote or a level written as a percentage still names the level. */
export const LEVEL_TOLERANCE = 0.01;

/**
 * The only prices a level may be quoted from: the pivots computed from the
 * candle series plus the moving averages the prompt shows. `input` is the
 * `data` block of `buildStockInput`.
 * @returns {number[]}
 */
export function levelCandidates(input) {
  const data = input && typeof input === 'object' ? input : {};
  const levels = data.levels && typeof data.levels === 'object' ? data.levels : {};
  const values = data.technical && data.technical.values ? data.technical.values : {};
  const out = [];
  for (const group of [levels.support, levels.resistance]) {
    for (const entry of Array.isArray(group) ? group : []) {
      const price = typeof entry === 'number' ? entry : entry && entry.price;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) out.push(price);
    }
  }
  for (const key of ['ma20', 'ma50', 'ma200', 'high52w', 'low52w']) {
    const price = values[key];
    if (typeof price === 'number' && Number.isFinite(price) && price > 0) out.push(price);
  }
  return out;
}

/**
 * Keep only the numbers that match a system-computed candidate, snapped to the
 * candidate's own value; drop everything else instead of showing the user a
 * price the plugin never measured.
 * @param {number[]} values
 * @param {number[]} candidates
 * @returns {{accepted: number[], rejected: number[]}}
 */
export function matchLevels(values, candidates) {
  const accepted = [];
  const rejected = [];
  for (const value of values) {
    const match = candidates.find((candidate) => Math.abs(value - candidate) / candidate <= LEVEL_TOLERANCE);
    if (match === undefined) {
      rejected.push(value);
      continue;
    }
    const snapped = Math.round(match * 100) / 100;
    if (!accepted.includes(snapped)) accepted.push(snapped);
  }
  return { accepted: accepted.slice(0, 5), rejected };
}

export function normalizeBrief(raw, input, lang = 'en') {
  const src = raw && typeof raw === 'object' ? raw : {};
  const stocks = input.stocks;
  // §38 counts are arithmetic, not an opinion: they are computed here so the
  // model cannot report "999 tracked, -5 advancing" over a one-stock list.
  const upCount = stocks.filter((s) => typeof s.changePct === 'number' && s.changePct > 0).length;
  const downCount = stocks.filter((s) => typeof s.changePct === 'number' && s.changePct < 0).length;
  return {
    headline: text(src.headline, 'Market brief unavailable.'),
    // The panel stamps this next to the headline: a brief whose numbers are
    // hours old reads differently from a fresh one, so the clock is part of
    // the answer, not chrome.
    generatedAt: new Date().toISOString(),
    stocksTracked: stocks.length,
    upCount,
    downCount,
    strongestMover: moverText(src.strongestMover, stocks, 'up'),
    largestDecline: moverText(src.largestDecline, stocks, 'down'),
    unusualVolume: strings(src.unusualVolume),
    keyObservations: strings(src.keyObservations),
    // 0.9.x: the actionable part of the brief. Optional in the published
    // contract, so older answers and cached results simply fall back to the
    // numbers the plugin already computed (see derivedSuggestions).
    suggestions: briefSuggestions(src.suggestions, input, lang),
  };
}

/** Number of derived suggestions the brief shows when the model wrote none. */
const MAX_SUGGESTIONS = 5;

/**
 * How many board-wide lines may take a slot. The brief answers two different
 * questions — what the market is doing, and what a single row is doing — and
 * the wide lines are cheaper to write, so without a cap they crowd out every
 * per-symbol observation on a busy day (a defensive tape plus a print cluster
 * plus three targets fills all five slots on their own).
 */
const MAX_CONTEXT_LINES = 3;

/** How many separate observations one holding may contribute. Beyond two the
 *  brief turns into a report on a single name, which is not the job. */
const MAX_IDEAS_PER_SYMBOL = 2;

/** How far a pre/post print must move before it earns its own action line. */
const AFTER_HOURS_ALERT_PCT = 2;
/** How far the consensus target must sit from the last print to be worth a line. */
const ANALYST_GAP_PCT = 10;

/** How far a name must fall, with a print inside a week, to read as re-pricing. */
const EARNINGS_DIP_PCT = 4;

/**
 * Action ideas for the brief. The model writes them when the answer carries
 * them; when it does not (older prompt, empty list, non-string junk) a few are
 * derived from the same structured numbers, because a brief whose advice
 * section is empty has no use. Every printed figure comes from the input: no
 * target price, no position size, no invented level.
 *
 * @param {unknown} raw value of `suggestions` in the model answer
 * @param {{stocks?: any[]}} input normalised brief input
 * @param {'en'|'zh'} lang interface language, so derived text matches the panel
 * @returns {string[]}
 */
export function briefSuggestions(raw, input, lang = 'en') {
  const list = Array.isArray(raw) ? raw : strings(raw);
  const fromModel = list.filter((line) => typeof line === 'string' && line.trim().length > 0).slice(0, 5);
  if (fromModel.length) return fromModel;
  return derivedSuggestions(input, lang === 'zh' ? 'zh' : 'en');
}

/**
 * A brief written without a model. Quotes and calendars keep arriving when no
 * LLM is configured; only the prose was missing, and the card went blank. Every
 * line here is arithmetic over the same structured input the model would have
 * seen: counts, the two extremes, volume spikes, and the derived action ladder.
 * Nothing is projected that the input does not already contain, which is why
 * this can ship as a fallback rather than as a second opinion.
 *
 * @param {object} input the shape buildBriefInput returns (`stocks`, `asOf`, …)
 * @param {'en'|'zh'} lang interface language, so the fallback speaks the panel's
 * @returns {object} the same contract normalizeBrief produces, plus `local: true`
 */
export function localBrief(input, lang = 'en') {
  const L = lang === 'zh' ? 'zh' : 'en';
  const stocks = Array.isArray(input && input.stocks) ? input.stocks : [];
  const priced = stocks.filter((s) => finite(s.changePct) !== null);
  const upCount = priced.filter((s) => s.changePct > 0).length;
  const downCount = priced.filter((s) => s.changePct < 0).length;
  const lead = formatMover(pickMover(priced, 'up'));
  const lag = formatMover(pickMover(priced, 'down'));
  // The contract spells these two as strings, and "Unavailable." already says
  // what a missing side means, so nothing is faked to fill the slot.
  const unusualVolume = priced
    .filter((s) => finite(s.volumeRatio20d) !== null && s.volumeRatio20d >= 1.8)
    .sort((a, b) => b.volumeRatio20d - a.volumeRatio20d)
    .slice(0, 3)
    .map((s) => `${s.symbol} ${s.volumeRatio20d.toFixed(2).replace(/0$/, '')}x`);
  const hot = priced.filter((s) => finite(s.rsi14) !== null && s.rsi14 >= 70).length;
  const cold = priced.filter((s) => finite(s.rsi14) !== null && s.rsi14 <= 30).length;
  const reporting = stocks.filter((s) => finite(s.earningsInDays) !== null && s.earningsInDays >= 0 && s.earningsInDays <= 3).length;
  const keyObservations = [];
  if (priced.length) {
    keyObservations.push(
      L === 'zh'
        ? `自选 ${priced.length} 只：${upCount} 涨 ${downCount} 跌，最强 ${lead}，最弱 ${lag}。`
        : `${priced.length} names tracked: ${upCount} up, ${downCount} down; ${lead} leads, ${lag} is weakest.`,
    );
  }
  if (reporting) {
    keyObservations.push(
      L === 'zh' ? `${reporting} 只三天内出财报，同一类数字会一起决定它们。` : `${reporting} names report within three days — one kind of number decides them together.`,
    );
  }
  if (hot) {
    keyObservations.push(L === 'zh' ? `${hot} 只 RSI 在 70 以上，短期偏热。` : `${hot} names sit above RSI 70 — stretched short term.`);
  }
  if (cold) {
    keyObservations.push(L === 'zh' ? `${cold} 只 RSI 在 30 以下，属于超卖区。` : `${cold} names sit below RSI 30 — oversold territory.`);
  }
  const headline = priced.length
    ? L === 'zh'
      ? `自选 ${upCount} 涨 ${downCount} 跌，${lead} 领涨。`
      : `Board ${upCount} up, ${downCount} down — ${lead} leads.`
    : L === 'zh'
      ? '还没有可用于汇总的报价。'
      : 'No live quotes to summarise yet.';
  return {
    headline,
    generatedAt: new Date().toISOString(),
    stocksTracked: stocks.length,
    upCount,
    downCount,
    strongestMover: lead,
    largestDecline: lag,
    unusualVolume,
    keyObservations: keyObservations.slice(0, 5),
    suggestions: derivedSuggestions(input || {}, L),
    // The card says so next to the headline: a rule-written brief must never
    // read as if a model had weighed the tape.
    local: true,
  };
}

const SUGGESTION_TEXT = {
  en: {
    nearHigh: (s, gap) => `${s.symbol} is ${gap}% below its 52-week high ${price2(s.high52w)} — a breakout needs volume, otherwise read it as range resistance.`,
    nearLow: (s, gap) => `${s.symbol} is ${gap}% above its 52-week low ${price2(s.low52w)} — losing that level leaves no measured support underneath.`,
    volume: (s, ratio) => `${s.symbol} traded ${ratio}× its 20-day average volume — a volume spike only counts once price moves the same way.`,
    hot: (s, rsi) => `${s.symbol} RSI ${rsi} is stretched — waiting for a pullback beats chasing the last leg.`,
    cold: (s, rsi) => `${s.symbol} RSI ${rsi} is washed out — a bounce stays unconfirmed until price stabilises.`,
    earningsSoon: (s, days) => `${s.symbol} reports earnings ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} — place any add or trim before the print; a single-symbol gap is an event risk, not a trend signal.`,
    earningsDip: (s, pct, days) => `${s.symbol} is ${pct}% lower with earnings ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`} — a drop that size into a print is the market re-pricing it early, so wait for the number rather than averaging into the gap.`,
    afterHours: (s, pct, session) => `${s.symbol} moved ${pct}% ${session === 'pre' ? 'in the pre-market' : 'after the bell'} — the next open can gap, so a level measured off the closing print is only a reference until it trades.`,
    macroSoon: (m, label) => `${label} prints ${m.date}${m.time ? ` at ${m.time} ET` : ''} (${m.days === 0 ? 'today' : m.days === 1 ? 'tomorrow' : `in ${m.days} days`}) — a market-wide release moves every position at once, so finish any sizing before the number, not during it.`,
    tapeTone: (label, sp, vixText) => `The tape is ${label} (S&P 500 ${sp}${vixText}) — on a day like this a new entry deserves a smaller size than the quiet week before it suggested.`,
    analystGap: (s, pct, rating) =>
      `${s.symbol} sits ${pct} from the consensus target${rating ? ` (${rating})` : ''} — the street is pricing something the daily chart has not.`,
    earningsCluster: (count, names) => `${count} of your names report within three days (${names}) — one kind of number decides all of them, so treat this as one risk rather than ${count} separate bets.`,
    closureSoon: (c, label) => `${label} on ${c.date} (${c.days === 0 ? 'today' : c.days === 1 ? 'tomorrow' : `in ${c.days} days`}) — ${c.close ? `the NYSE closes early at ${c.close} ET, so place and confirm any order before the cutoff; the tape thins out afterwards` : 'the exchange is shut all day, so a planned add or trim waits for the next session'}.`,
    opexSoon: (o) => `Monthly options expire ${o.date} (${o.days === 0 ? 'today' : o.days === 1 ? 'tomorrow' : `in ${o.days} days`})${o.quarterly ? ', quarter-end contracts' : ''} — the tape tends to pin to round strikes that afternoon and thins out into the close, so work any size before the last hour rather than into it.`,
    cluster: (tag, count, total) => `${count} of ${total} watch rows carry your tag "${tag}" — that cluster is deliberate concentration, so weigh the whole group's combined size before any single-name add.`,
    stretchedUp: (s, gap) => `${s.symbol} is ${gap}% above its 20-day average ${price2(s.ma20)} — moves that stretched mean-revert eventually, so a pullback is the better add than the extension.`,
    stretchedDown: (s, gap) => `${s.symbol} is ${gap}% below its 20-day average ${price2(s.ma20)} — a dislocation this wide wants either confirmation on a retest or a stop reset, not blind averaging down.`,
    trendUp: (s) => `${s.symbol} runs a bullish MA stack — trend intact, so dips into the rising averages are the level to defend, not a signal to exit.`,
    trendDown: (s) => `${s.symbol} is under a bearish MA stack — rallies stay corrective until the averages flatten and turn.`,
    aboveMed: (s) => `${s.symbol} holds above its medium-term average — pullbacks toward that line are the level to watch, stronger than any single-day direction.`,
    belowMed: (s) => `${s.symbol} sits below its medium-term average — rallies toward that line mark the resistance to clear before a trend call.`,
    breadth: (up, down) => `Breadth ${up} up / ${down} down — one session does not set the trend, so check whether the next one follows through.`,
  },
  zh: {
    nearHigh: (s, gap) => `${s.symbol} 距 52 周高点 ${price2(s.high52w)} 还有 ${gap}%，突破要等量能确认，否则按区间上沿处理。`,
    nearLow: (s, gap) => `${s.symbol} 距 52 周低点 ${price2(s.low52w)} 仅 ${gap}%，一旦失守下方没有可参考的支撑。`,
    volume: (s, ratio) => `${s.symbol} 成交量为 20 日均量的 ${ratio} 倍，放量要价格同向走才算数。`,
    hot: (s, rsi) => `${s.symbol} RSI ${rsi} 已偏高，等回踩比追最后一段更稳。`,
    cold: (s, rsi) => `${s.symbol} RSI ${rsi} 偏低，企稳之前反弹都不算确认。`,
    earningsSoon: (s, days) => `${s.symbol}${days === 0 ? '今天' : days === 1 ? '明天' : `再有 ${days} 天`}出财报，加减仓的动作放在财报落地之前；个股跳空是事件风险，不是趋势信号。`,
    earningsDip: (s, pct, days) => `${s.symbol} 跌 ${pct}%，而${days === 0 ? '今天' : days === 1 ? '明天' : `再过 ${days} 天`}就出财报——跌到这个幅度更像是市场提前给财报重新定价，先等数字落地，别在跳空里摊低成本。`,
    afterHours: (s, pct, session) => `${s.symbol} ${session === 'pre' ? '盘前' : '盘后'} ${pct}%，次日开盘可能跳空——按收盘价算出来的价位，在它真正成交之前只能当参考。`,
    macroSoon: (m, label) => `${label} 将于 ${m.date}${m.time ? ` ${m.time} ET` : ''} 发布（${m.days === 0 ? '今天' : m.days === 1 ? '明天' : `${m.days} 天后`}）——大事件牵动整个组合，加减仓放在数据落地之前，不在盘中赌方向。`,
    tapeTone: (label, sp, vixText) => `大盘偏${label}（标普 500 ${sp}${vixText}）——这种日子里新仓该比前一周的平静更小一点。`,
    analystGap: (s, pct, rating) =>
      `${s.symbol} 距离一致目标价 ${pct}${rating ? `（评级：${rating}）` : ''}——卖方在给图上看不到的东西定价。`,
    earningsCluster: (count, names) => `${count} 只自选在三天内出财报（${names}）——它们由同一类数字决定，当成一份风险看，而不是 ${count} 个独立下注。`,
    closureSoon: (c, label) => `${label}（${c.date}，${c.days === 0 ? '今天' : c.days === 1 ? '明天' : `${c.days} 天后`}）——${c.close ? `纽交所 ${c.close} ET 提前收盘，下单要赶在截止之前，之后的盘口很薄` : '纽交所全天休市，原定的加减仓只能等下一个交易日'}。`,
    opexSoon: (o) => `月度期权 ${o.date} 到期（${o.days === 0 ? '今天' : o.days === 1 ? '明天' : `${o.days} 天后`}）${o.quarterly ? '，含季度合约' : ''}——当天收盘前价格容易在整数行权价附近被「钉住」、临近收盘成交变薄，要动的仓位别留到最后一小时。`,
    cluster: (tag, count, total) => `${total} 只自选里有 ${count} 只带你的标签「${tag}」——这是有意的主题集中，加仓前先权衡整个标签组的合计仓位，再决定单只是否加。`,
    stretchedUp: (s, gap) => `${s.symbol} 高于 20 日均线 ${price2(s.ma20)} 达 ${gap}%，拉离均线的行情终会回归——回踩是更好的介入点，不追延伸段。`,
    stretchedDown: (s, gap) => `${s.symbol} 低于 20 日均线 ${price2(s.ma20)} 达 ${gap}%，偏离幅度大到需要先看清——要么等回踩企稳确认，要么重估止损位，不盲目摊平。`,
    trendUp: (s) => `${s.symbol} 多头均线排列，趋势完好，回踩抬升的均线才是先要守住的位。`,
    trendDown: (s) => `${s.symbol} 空头均线排列，反弹先当修复对待，均线走平反转之前不做趋势单。`,
    aboveMed: (s) => `${s.symbol} 站在中期均线上方，回踩到该线是关键观察位，比单日方向更重要。`,
    belowMed: (s) => `${s.symbol} 处在中期均线下方，反弹到该线是压力位，收复前不谈反转。`,
    breadth: (up, down) => `自选 ${up} 涨 ${down} 跌，单日广度不改趋势，看下一个交易日是否延续。`,
  },
};

/** Localised names for macro kinds; the curated row's `ref` wins when present. */
const MACRO_LABELS = {
  en: { cpi: 'CPI', ppi: 'PPI', jobs: 'the jobs report', gdp: 'GDP', pce: 'PCE', fomc: 'the FOMC decision' },
  zh: { cpi: 'CPI', ppi: 'PPI', jobs: '非农就业报告', gdp: 'GDP', pce: 'PCE 通胀数据', fomc: 'FOMC 决议' },
};

export function derivedSuggestions(input, lang) {
  const L = SUGGESTION_TEXT[lang] || SUGGESTION_TEXT.en;
  const stocks = Array.isArray(input && input.stocks) ? input.stocks : [];
  const out = [];
  let context = 0;
  // Board-wide lines go through here so the ladder always keeps room for at
  // least one thing that is true about a specific holding.
  const pushContext = (line) => {
    if (context >= MAX_CONTEXT_LINES || out.length >= MAX_SUGGESTIONS) return;
    out.push(line);
    context += 1;
  };
  // 1.1: the tape is the widest context available, so it leads - a defensive
  // S&P changes what every level below it means. It only speaks when the move
  // is worth remarking on; a flat day says nothing rather than noise.
  const tape = Array.isArray(input && input.tape) ? input.tape : [];
  const spRow = tape.find((row) => row && row.symbol === '^GSPC');
  const vixRow = tape.find((row) => row && row.symbol === '^VIX');
  const spPct = spRow ? finite(spRow.changePct) : null;
  if (spPct !== null && Math.abs(spPct) >= 1) {
    const label = spPct < 0 ? (lang === 'zh' ? '弱' : 'defensive') : (lang === 'zh' ? '强' : 'firm');
    const vixPrice = vixRow ? finite(vixRow.price) : null;
    const vixText =
      vixPrice !== null && vixPrice >= 25 ? (lang === 'zh' ? `，VIX ${vixPrice.toFixed(1)}` : `, VIX ${vixPrice.toFixed(1)}`) : '';
    pushContext(L.tapeTone(label, `${spPct > 0 ? '+' : '\u2212'}${Math.abs(spPct).toFixed(1)}%`, vixText));
  }
  // 1.2: three prints in the same week is one risk, not three positions - the
  // ladder says so before it argues about any single name.
  const clustered = stocks.filter((stock) => {
    const days = stock ? finite(stock.earningsInDays) : null;
    return days !== null && days >= 0 && days <= 3;
  });
  if (clustered.length >= 3) {
    pushContext(L.earningsCluster(clustered.length, clustered.slice(0, 3).map((stock) => stock.symbol).join(', ')));
  }

  // 1.1: the street's target is a different kind of evidence from the levels
  // above - it is a claim about the next twelve months, not about this week.
  // Only gaps wide enough to change a decision are worth printing.
  const views = Array.isArray(input && input.analystViews) ? input.analystViews : [];
  for (const view of views) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const target = finite(view && view.targetMean);
    const last = finite(view && view.price);
    if (target === null || last === null || last <= 0) continue;
    const gap = ((target / last) - 1) * 100;
    if (Math.abs(gap) < ANALYST_GAP_PCT) continue;
    pushContext(L.analystGap(view, `${gap > 0 ? '+' : ''}${gap.toFixed(1)}%`, view.rating));
  }

  for (let index = 0; index < stocks.length; index += 1) {
    const s = stocks[index];
    if (out.length >= MAX_SUGGESTIONS) break;
    if (!s || typeof s.symbol !== 'string') continue;
    // Breadth first: a name only earns its second line when the slots left can
    // still cover every other name once. A stock can honestly be both near its
    // high and trading on double volume, but not at the price of the fourth
    // holding never being mentioned.
    const budget = MAX_SUGGESTIONS - out.length;
    const cap = budget > stocks.length - index ? MAX_IDEAS_PER_SYMBOL : 1;
    let said = 0;
    const say = (line) => {
      if (said >= cap || out.length >= MAX_SUGGESTIONS) return;
      out.push(line);
      said += 1;
    };
    const price = finite(s.price);
    const high = finite(s.high52w);
    const low = finite(s.low52w);
    const volumeRatio = finite(s.volumeRatio20d);
    const rsi = finite(s.rsi14);
    // An imminent print is the one risk a level cannot measure, so it outranks
    // every technical read: sizing decisions belong before the report.
    const earnIn = finite(s.earningsInDays);
    if (earnIn !== null && earnIn >= 0 && earnIn <= 7) {
      const dayMove = finite(s.changePct);
      // A name already down hard into the print is a different object from a
      // quiet one: the report is being priced before it lands, so the line
      // says "wait for the number" instead of "place the order before it".
      if (dayMove !== null && dayMove <= -EARNINGS_DIP_PCT) {
        say(L.earningsDip(s, Math.abs(dayMove).toFixed(1), earnIn));
      } else {
        say(L.earningsSoon(s, earnIn));
      }
    }
    // A post- or pre-market move is what the next open is already priced
    // against, and it outranks every level read for the same reason the print
    // does: a level measured off a frozen closing price is not where the market
    // will open.
    const after = s.afterHours;
    const afterPct = after ? finite(after.changePct) : null;
    if (afterPct !== null && Math.abs(afterPct) >= AFTER_HOURS_ALERT_PCT) {
      say(L.afterHours(s, `${afterPct > 0 ? '+' : ''}${afterPct.toFixed(1)}`, after.session));
    }
    // 1.0.x: the MA alignment the plugin computes (indicators.maAlignment) is a
    // structural read of the printed averages, so it is safe to surface.
    const alignment = typeof s.trendAlignment === 'string' ? s.trendAlignment : null;
    if (alignment === 'bullish-stack') {
      say(L.trendUp(s));
    } else if (alignment === 'bearish-stack') {
      say(L.trendDown(s));
    } else if (alignment === 'short-term-above-medium') {
      say(L.aboveMed(s));
    } else if (alignment === 'short-term-below-medium') {
      say(L.belowMed(s));
    }
    if (price !== null && high !== null && high > 0 && price >= high * 0.97) {
      say(L.nearHigh(s, (((high - price) / high) * 100).toFixed(1)));
    } else if (price !== null && low !== null && low > 0 && price <= low * 1.03) {
      say(L.nearLow(s, (((price - low) / low) * 100).toFixed(1)));
    }
    // 0.5.x: a price stretched far from its own 20-day average is the same
    // chase/dislocation decision the RSI read flags, measured on levels the
    // plugin already computed — worth its own line because the two CAN
    // disagree (an RSI 55 stock can still sit 9% above its average).
    const ma20 = finite(s.ma20);
    if (ma20 !== null && ma20 > 0 && price !== null) {
      if (price >= ma20 * 1.07) say(L.stretchedUp(s, (((price - ma20) / ma20) * 100).toFixed(1)));
      else if (price <= ma20 * 0.93) say(L.stretchedDown(s, (((ma20 - price) / ma20) * 100).toFixed(1)));
    }
    if (out.length >= MAX_SUGGESTIONS) break;
    if (volumeRatio !== null && volumeRatio >= 1.8) say(L.volume(s, volumeRatio.toFixed(2)));
    if (out.length >= MAX_SUGGESTIONS) break;
    if (rsi !== null && rsi >= 70) say(L.hot(s, rsi.toFixed(0)));
    else if (rsi !== null && rsi <= 30) say(L.cold(s, rsi.toFixed(0)));
  }
  const up = stocks.filter((s) => finite(s && s.changePct) > 0).length;
  const down = stocks.filter((s) => finite(s && s.changePct) < 0).length;
  // 1.1: a shortened week changes *when* an order can be filled, and that binds
  // harder than any print — a CPI you can still trade around, a 13:00 close you
  // cannot. So the closure line takes the board-wide slot ahead of the macro
  // one, and either can be dropped when the ladder is already full.
  const closure = Array.isArray(input && input.closuresSoon)
    ? input.closuresSoon.find((c) => c && c.days !== null && c.days >= 0 && c.days <= 7)
    : null;
  if (closure) {
    const label = (lang === 'zh' ? closure.nameZh || closure.name : closure.name) || (lang === 'zh' ? '交易所休市' : 'Exchange closure');
    pushContext(L.closureSoon(closure, label));
  }
  // 1.1: an expiry day is still tradeable, so it ranks below the closure (which
  // takes the day away entirely) but above the macro prints: it changes the
  // shape of the session a reader is about to trade in.
  const opex = Array.isArray(input && input.opexSoon) ? input.opexSoon[0] : null;
  if (opex) pushContext(L.opexSoon(opex));
  // 0.5.x: a macro print inside the week is board-wide risk no row carries,
  // so it sits beside the breadth line rather than inside the per-symbol
  // ladder. The curated row's `ref` (what exactly is released) reads better
  // than the machine kind.
  const macro = Array.isArray(input && input.macroSoon)
    ? input.macroSoon.find((m) => m && m.days !== null && m.days >= 0 && m.days <= 7)
    : null;
  if (macro) {
    const labels = MACRO_LABELS[lang] || MACRO_LABELS.en;
    const kind = labels && labels[macro.kind];
    const label = macro.ref || (typeof kind === 'string' ? kind : 'A macro release');
    pushContext(L.macroSoon(macro, label));
  }
  // 0.5.x: a tag cluster is the owner's *deliberate* concentration, so it
  // deserves a sizing note of its own — weigh the group before any single
  // name. Per the input directive the tag is quoted as intent, never as a
  // data claim about the market.
  const cluster = tagCluster(stocks, 3);
  if (cluster) pushContext(L.cluster(cluster.tag, cluster.count, stocks.length));
  if (stocks.length) pushContext(L.breadth(up, down));
  return out.slice(0, MAX_SUGGESTIONS);
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The most-shared owner tag with at least `min` rows (deterministic pick:
 * highest count, then lexicographic). Tags are the owner's own labels, so the
 * result is returned verbatim and callers present it as intent, not data.
 */
function tagCluster(stocks, min) {
  const counts = new Map();
  for (const s of stocks) {
    if (!Array.isArray(s && s.tags)) continue;
    for (const tag of s.tags) {
      if (typeof tag !== 'string' || !tag.trim()) continue;
      counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  let best = null;
  for (const [tag, count] of counts) {
    if (count < min) continue;
    if (!best || count > best.count || (count === best.count && tag < best.tag)) best = { tag, count };
  }
  return best;
}

function dayDiff(date, from) {
  if (!date || !from) return null;
  const a = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(a) && Number.isFinite(b) ? Math.round((a - b) / 86400000) : null;
}

function price2(value) {
  const n = finite(value);
  return n === null ? '—' : n.toFixed(2);
}

/** Accept a mover only when it names a row that is actually in the brief. */
function moverText(value, stocks, direction) {
  const phrase = text(value, '');
  if (phrase && mentionsStock(phrase, stocks)) return phrase;
  return formatMover(pickMover(stocks, direction));
}

function mentionsStock(phrase, stocks) {
  const haystack = phrase.toLowerCase();
  return stocks.some((stock) =>
    [stock.symbol, stock.name].some((name) => typeof name === 'string' && name.length > 0 && haystack.includes(name.toLowerCase())),
  );
}

/** The row with the largest gain (`up`) or decline (`down`), or null. */
function pickMover(stocks, direction) {
  let best = null;
  for (const stock of stocks) {
    const pct = stock.changePct;
    if (typeof pct !== 'number' || !Number.isFinite(pct)) continue;
    if (direction === 'up' ? pct <= 0 : pct >= 0) continue;
    if (!best || Math.abs(pct) > Math.abs(best.changePct)) best = stock;
  }
  return best;
}

function formatMover(stock) {
  if (!stock) return 'Unavailable.';
  return `${stock.symbol} ${stock.changePct > 0 ? '+' : ''}${stock.changePct.toFixed(2)}%`;
}

/** Strip markdown fences, then take the outermost JSON object (§ research). */
export function repair(text) {
  const raw = String(text ?? '').trim();
  const stripped = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  return start < 0 || end < start ? stripped : stripped.slice(start, end + 1);
}

/**
 * A user message in the shape the host accepts (`RequestUserInput`): role and
 * content only. `id` and `source` are declared `never` on the request side, so
 * the plugin must not attach its own provenance envelope here.
 */
export function buildUserMessage(text) {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** Resolve a service that may have been handed over directly or as a getter. */
function readService(value) {
  if (typeof value === 'function') {
    try {
      return value() || null;
    } catch {
      return null;
    }
  }
  return value || null;
}

function text(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value) && value.length) return value.map((v) => String(v)).join(' ');
  return fallback;
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : typeof entry === 'number' ? String(entry) : typeof entry === 'object' && entry ? text(entry.text ?? entry.description ?? entry.name, '') : ''))
    .filter((entry) => entry.length > 0);
}

function numbers(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
      if (entry && typeof entry === 'object' && typeof entry.level === 'number') return entry.level;
      const parsed = Number.parseFloat(String(entry));
      return Number.isFinite(parsed) ? parsed : null;
    })
    .filter((entry) => entry !== null);
}

function recentCloses(candles, count) {
  if (!Array.isArray(candles) || !candles.length) return [];
  return candles.slice(-count).map((c) => ({ timestamp: isoOrNull(c.timestamp), close: c.close, volume: c.volume ?? null }));
}

function isoOrNull(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function truncate(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
