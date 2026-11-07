/**
 * dsh-trading-mode / lib/client.js
 *
 * 客户端半侧。必须是一个「普通副作用脚本」：加载时调用
 * window.__ModuleLoader__.load({ id, factory })，factory 通过 require 取模块。
 * 不能有顶层 ESM export/import（react 由 factory 的 require 取得）。
 *
 * 注册内容：
 *   - 左侧栏「Trading Mode」入口 → 侧栏面板行（sidebar.panellist）+ 主面板（main）
 *   - 不注册会话标题栏按钮，也不使用浮层：左侧栏是唯一入口
 *
 * 应用结构（策划案 §25/§27）：
 *   Home  = Search Stocks（唯一搜索框，悬浮结果层 + 每行 + 加入自选）+ My Watchlist（价格/涨跌%）
 *           + [ 浏览上市清单 ]（按需展开）+ AI Watchlist Brief
 *   Detail= 公司名/symbol/交易所/价格/涨跌幅/Updated + 区间切换 + K 线 + Market Data
 *           + Technical Indicators + AI Analysis + Ask DeepSeek + TradingView（保留原功能）
 *
 * 所有行情一律来自 /api/trading（§50：前端不直连任何数据源，不解析第三方字段）。
 * 行情新鲜度只说 "Updated …" / "Data may be delayed" / "Last available data"，
 * 绝不宣称 Live / Real-time（§21）。
 *
 * 语言：英文是源语言，字典以「英文字面量」为 key，缺翻译时回落到英文而不是裸露 key。
 * 默认跟随 DSH 的 locale（ctx.get('locale')），也可在面板右上角手动切换 EN / 中文；
 * 手动选择通过 PATCH /api/trading/settings 持久化，并同时决定 AI 分析输出语言。
 */

window.__ModuleLoader__.load({
  id: 'dsh-trading-mode',
  factory: (require) => {
    const react = require('react')
    const { createElement: h, useState, useEffect, useMemo, useRef, useCallback } = react

    // ------------------------------------------------------------------ config
    const API_BASE = '/api/trading'
    const RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y']
    const RANGE_LABEL = { '1d': '1D', '5d': '5D', '1mo': '1M', '3mo': '3M', '6mo': '6M', '1y': '1Y', '5y': '5Y' }
    // Range → bar interval. Sent explicitly so the server never has to guess.
    const RANGE_INTERVAL = { '1d': '5m', '5d': '30m', '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d', '5y': '1wk' }
    const DISCLAIMER_FALLBACK =
      'This is not financial advice. Trading Mode only restates and interprets the market data supplied by configured data providers. Market data may be delayed.'

    const ICON = {
      chart: ['M3 3v18h18', 'M7 14l3-4 4 3 6-7'],
      search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-3.5-3.5'],
      star: ['M12 3l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9L12 3z'],
      close: ['M6 6l12 12', 'M18 6L6 18'],
      back: ['M15 18l-6-6 6-6'],
      plus: ['M12 5v14', 'M5 12h14'],
      refresh: ['M20 11a8 8 0 1 0-2.3 5.7', 'M20 5v6h-6'],
      grip: ['M9 6h.01', 'M15 6h.01', 'M9 12h.01', 'M15 12h.01', 'M9 18h.01', 'M15 18h.01'],
      trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
      up: ['M12 19V5', 'M6 11l6-6 6 6'],
      down: ['M12 5v14', 'M6 13l6 6 6-6'],
      globe: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z'],
      external: ['M14 4h6v6', 'M20 4l-9 9', 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5'],
      list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
      download: ['M12 4v11', 'M7 11l5 5 5-5', 'M4 20h16'],
      calendar: ['M5 5h14v15H5z', 'M5 10h14', 'M9 3v4', 'M15 3v4'],
    }

    function Icon({ name, size }) {
      const paths = ICON[name] || ICON.chart
      return h(
        'svg',
        {
          width: size || 15,
          height: size || 15,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        paths.map((d, i) => h('path', { key: i, d })),
      )
    }

    // -------------------------------------------------------------------- i18n
    /** Languages the panel can switch between. */
    const LANGS = ['en', 'zh']
    const LANG_LABEL = { en: 'English', zh: '中文（简体）' }
    const LANG_SHORT = { en: 'EN', zh: '中文' }

    /**
     * Panel colour schemes (user request m11109): the window is either
     * white-on-black (`dark`) or black-on-white (`light`), and every surface it
     * paints is opaque, so the conversation behind it can never show through.
     * `dark`/`light` are also the DSH theme service's built-in ids, which is why
     * the switch doubles as the surrounding interface's theme switch.
     */
    const THEME_SCHEMES = ['dark', 'light']

    /** Normalise any locale id (`en`, `en-US`, `zh`, `zh-CN`, `zh_Hant`) to a shipped language. */
    function normalizeLang(value) {
      if (typeof value !== 'string') return null
      const primary = value.trim().toLowerCase().replace(/_/g, '-').split('-')[0]
      if (primary === 'zh') return 'zh'
      if (primary === 'en') return 'en'
      return null
    }

    /**
     * Simplified-Chinese dictionary. English is the source language, so the key
     * IS the English sentence: the code stays readable and an untranslated
     * string degrades to English instead of to a raw key.
     * `{name}` placeholders are substituted by the translate function.
     */
    const ZH = {
      'Loading…': '加载中…',
      'Retry': '重试',
      'Refresh': '刷新',
      'Refresh quotes': '刷新行情',
      'Back': '返回',
      'Walk the watchlist with ←/→ · Esc goes back': '←/→ 看上一只/下一只 · Esc 返回',
      'Close': '关闭',
      'Language': '语言',
      'Follow the DSH interface language': '跟随 DSH 界面语言',
      'Fundamentals (SEC EDGAR)': '财务数据（SEC EDGAR）',
      'as filed': '申报于',
      'annual': '年报',
      'quarter': '季报',
      'Source: SEC EDGAR company facts. Each row is the latest period of one kind — annual or quarterly — and the percentage is that same period a year earlier.': '数据来源：SEC EDGAR company facts。每行取同类期间（年报或季报）的最新一期，百分比为去年同期。',
      'Revenue': '营业收入',
      'Gross profit': '毛利润',
      'Operating income': '营业利润',
      'Net income': '净利润',
      'EPS (diluted)': '每股收益（摊薄）',
      'Total assets': '总资产',
      'Total liabilities': '总负债',
      'Shareholders’ equity': '股东权益',
      'Cash & equivalents': '现金及等价物',
      'Shares outstanding': '流通股本',
      'Next earnings': '下次财报',
      'pre-market': '盘前',
      'after close': '盘后',
      'time not announced': '时间未定',
      'EPS est.': '预期 EPS',
      'in {n} days': '{n} 天后',
      'today': '今天',
      'tomorrow': '明天',
      '{n} analysts': '{n} 位分析师',
      'earnings {n}d': '财报 {n}天',
      'Data unavailable': '暂无数据',
      'Unavailable.': '暂无数据。',
      'loading bars…': '正在加载 K 线…',
      'searching…': '搜索中…',
      'Computing indicators…': '正在计算指标…',
      'Updated {time}': '更新于 {time}',
      'Data may be delayed': '数据可能延迟',
      'Last available data': '最后可用数据',
      'Symbol': '代码',
      'Name': '名称',
      'Price': '价格',
      'Change': '涨跌额',
      'Change %': '涨跌幅',
      'Time': '时间',
      'Too many requests; the panel is protecting the upstream data sources.': '请求过于频繁；面板正在保护上游数据源。',
      'Try again in about {n} seconds.': '请在约 {n} 秒后重试。',
      'Not enough history for reliable indicators: only {n} daily bars are available (need {m}).':
        '历史数据不足，技术指标不可靠：仅有 {n} 根日 K 线（需要 {m} 根）。',
      'Limited history: {n} daily bars — long-term indicators (MA200, 52-week levels, 1-year change) are not reported.':
        '历史数据有限：仅 {n} 根日 K 线，长期指标（MA200、52 周高低点、一年涨跌幅）不提供。',
      'This analysis is based on the last available data, not a live quote.': '本简报基于最后可用数据，并非实时行情。',
      'This analysis is based on delayed data.': '本简报基于延迟数据。',
      'The age of the data behind this analysis could not be established.': '无法确认本简报所用数据的时间，请以行情卡片上的时间戳为准。',
      'This deployment has no host security fence, so the panel refuses to answer rather than serve an unverifiable caller.':
        '当前部署缺少宿主安全围栏，面板拒绝应答，以免向无法验证来源的调用方提供数据。',
      'This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.':
        '当前 DSH profile 没有可信的用户身份，因此自选与偏好设置为不可用；行情数据仍可使用。',
      'This request did not pass the DSH host/origin check.': '该请求未通过 DSH 的 Host/Origin 校验。',
      'No authenticated DSH browser session for this request.': '该请求没有已认证的 DSH 浏览器会话。',
      'Source: {source}': '数据源：{source}',
      'cached': '缓存',
      'High {value}': '最高 {value}',
      'Low {value}': '最低 {value}',
      '{count} bars': '{count} 根 K 线',
      'partial history': '历史数据不完整',
      'The feed returned fewer bars than this range asks for; no reachable source publishes the rest.': '数据源返回的 K 线少于该区间应有的数量，当前可访问的来源没有更多历史。',
      'Interval {interval}': '周期 {interval}',
      'Last close {value}': '最新收盘 {value}',
      'Search Stocks — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988': '搜索股票 — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988',
      'No matching stock found.': '没有找到匹配的股票。',
      'Open {symbol}': '查看 {symbol}',
      'Recent': '最近',
      'Clear recent searches': '清除最近记录',
      'Clear': '清空',
      'Copy': '复制',
      'Copied': '已复制',
      'Copy the suggestions as text': '把全部建议复制成文字（可贴到备忘录）',
      'Tap a symbol to preview it; the plus adds it to your watchlist': '点代码先看看这只股票；加号把它加入自选',
  'Add to watchlist': '加入自选',
      'Clear the search': '清空搜索',
      '{count} matches — click a row to open it, + adds it to the watchlist': '{count} 条匹配 — 点击行查看详情，点 + 加入自选',
      'Browse listings': '浏览上市清单',
    'Favorites': '收藏',
    'Watchlist heat': '自选热度',
    'Sector thermometer': '板块温度计',
    'Eleven SPDR sector ETFs, one day change': '十一只行业 ETF 的当日涨跌',
    'Sector quotes unavailable': '板块行情暂不可用',
    // 1.1 tags: labels the user gives rows themselves ("核心仓"/"观察").
    'All': '全部',
    'Tags': '标签',
    'Add a tag (press Enter)': '加标签（回车确认）',
    'Remove this tag': '移除这个标签',
    'Show favourites only (click again to see everything)': '只看收藏（再点一次看全部）',
    'No favourites yet. Tap the star on a row to pin it here.': '还没有收藏——点任意一行后面的星标，收藏的会显示在这里。',
    'Nothing matches the current filters.': '当前筛选条件下没有匹配的行。',
      'Browse every listing on every market': '浏览所有市场的全部上市清单',
  'All coins': '全部币种',
      'Mark as favourite': '标记为关注',
      'Move up': '上移',
      'Move down': '下移',
      'Remove from watchlist': '从自选中移除',
      'My Watchlist': '我的自选',
      'Loading watchlist…': '正在加载自选…',
      'Your watchlist is empty. Use Search Stocks or the starter list below to add a stock.':
        '自选为空。用上面的搜索框或下面的初始清单添加股票。',
      'Starter list': '初始清单',
      'AI Watchlist Brief': 'AI 自选简报',
      'View Full Analysis': '查看完整分析',
      // Kept for pages still running the previous bundle, where the header
      // button existed; the card itself no longer renders that button.
      'Generate Brief': '生成简报',
      'Analysing…': '分析中…',
      'DeepSeek is not available in this DSH session, so the brief cannot be generated. Market data above is unaffected.':
        '当前 DSH 会话中 DeepSeek 不可用，因此无法生成简报。上方行情数据不受影响。',
      'DeepSeek is reading your watchlist…': 'DeepSeek 正在阅读你的自选…',
      'Stocks tracked': '跟踪股票数',
      'Up': '上涨',
      'Down': '下跌',
      'Strongest mover': '涨幅最大',
      'Largest decline': '跌幅最大',
      'Unusual volume': '异动放量',
      'Key observations': '关键观察',
      'Action ideas': '行动建议',
      'Event reminders': '事件提醒',
      '{n} events in the next {days} days': '未来 {days} 天 · {n} 件',
      '{n}d window': '近 {n} 天',
      'Board context': '板块语境',
      'This week': '本周',
      'Next week': '下周',
      'Later': '更晚',
      'Group the list by tag (strongest change first; click again to restore your order)': '按标签分组（组内涨幅大者排前；再点一次恢复你的顺序）',
      'By tag': '分组',
      'Export CSV': '导出 CSV',
      'Download the watchlist as a CSV file (opens directly in Excel)': '把自选下载为 CSV 文件（Excel 可直接打开）',
      'Import': '导入',
      'Restore rows from a previous export (CSV or JSON)': '用之前导出的文件恢复自选（CSV 或 JSON）',
      'Import a JSON export to restore the list': '用导出的 JSON 文件恢复自选',
      'The file holds no restorable rows.': '文件里没有可恢复的自选行。',
      'Restoring the list…': '正在恢复自选…',
      '{n} rows restored.': '已恢复 {n} 行。',
      '{n} rows could not be resolved:': '{n} 行无法解析：',
      'Ungrouped': '未分组',
      'Filter by symbol': '按代码过滤（可选）',
      'Filter the list by tag {tag}': '只看「{tag}」（再点上面的「全部」看回来）',
      'earnings today': '财报今天',
      'earnings tomorrow': '财报明天',
      'No earnings on the watchlist within the window.': '未来窗口内自选没有财报。',
      'Earnings dates change hold and entry decisions; check them again the day before.': '财报日期会改变持仓与买入决定，前一晚再核对一次。',
      'Strongest mover: ': '涨幅最大：',
      'Largest decline: ': '跌幅最大：',
      'Unusual volume: ': '异常成交量：',
      'These are watchlist stocks, not portfolio holdings. Not financial advice.': '这些是自选股，不代表你的持仓。不构成投资建议。',
      'Generate a brief: what moved, where each stock stands, and which levels to watch next.':
        '生成简报：看谁在动、各自处在什么技术位置，以及接下来该盯住哪些价位。',
      'Data source status': '数据源状态',
      '{ready}/{total} sources ready': '{ready}/{total} 个数据源可用',
      'cache: {cache} · watchlist: {watchlist} · AI: {ai}': '缓存：{cache} · 自选：{watchlist} · AI：{ai}',
      'ready': '就绪',
      'unavailable': '不可用',
      'ok {ok} / fail {fail}': '成功 {ok} / 失败 {fail}',
      ' · cooling {seconds}s': ' · 冷却 {seconds}s',
      'Chains': '数据源链路',
      'AI Analysis': 'AI 分析',
      'Ask DeepSeek': '询问 DeepSeek',
      'DeepSeek is not available in this DSH session.': '当前 DSH 会话中 DeepSeek 不可用。',
      'Reason: ': '原因：',
      'Optional question — context (price, candles, indicators, timestamp) is attached automatically':
        '可选提问 —— 系统会自动附加上下文（价格、K 线、指标、时间戳）',
      'DeepSeek is analysing {symbol}…': 'DeepSeek 正在分析 {symbol}…',
      'Trend · short term': '趋势 · 短期',
      'Trend · medium term': '趋势 · 中期',
      'Trend · long term': '趋势 · 长期',
      'Momentum': '动能',
      'Volume': '成交量',
      'Support': '支撑位',
      'Resistance': '压力位',
      'Risk Factors': '风险因素',
      'Key Observations': '关键观察',
      'Ask DeepSeek for a structured read of the trend, momentum, volume, support/resistance and risk of this stock. Values are supplied by the system; DeepSeek never fetches market data.':
        '让 DeepSeek 按结构解读该股的趋势、动能、成交量、支撑/压力与风险。所有数值由系统提供，DeepSeek 不抓取行情数据。',
      'No summary was returned.': '未返回摘要。',
      'Chart': '图表',
      'TradingView (external embed)': 'TradingView（外部嵌入）',
      "Embedded third-party chart. Values shown here are TradingView's own and are not used by Trading Mode analytics.":
        '嵌入式第三方图表。此处显示的数值来自 TradingView，不参与 Trading Mode 的分析。',
      'Market Data': '行情数据',
      'Open': '开盘',
      'High': '最高',
      'Low': '最低',
      'Previous Close': '昨收',
      'Timestamp': '时间戳',
      'Data source': '数据源',
      'Freshness': '数据状态',
      'Market cap': '市值',
      'Exchange': '交易所',
      'P/E': '市盈率',
      'Technical Indicators': '技术指标',
      'Reference levels (system-computed)': '参考价位（系统计算）',
      'Market data providers: {chains}': '行情数据源：{chains}',
      'Home': '首页',
      'Market research only — no order routing, no brokerage connection. Market data may be delayed.':
        '仅用于市场研究 —— 不接券商、不下单。行情数据可能延迟。',
      'AI output is generated from system-supplied structured data; it is not financial advice.':
        'AI 结论基于系统提供的结构化数据生成，不构成投资建议。',
      'Trading Mode': '交易模式',
      // Market Overview strip + external source links (m01395)
      'Market Overview': '市场指数',
      'Index levels, not tradable prices': '指数点位，不可直接交易',
      'Loading indices…': '正在加载指数…',
      'Data unavailable for {symbols}': '{symbols} 暂无数据',
      'Data source pages': '数据来源页面',
      'Open {name} in a new tab': '在新标签页打开 {name}',
      'Open {name}': '打开 {name}',
      'Index levels are not tradable; open the closest ETF ({symbol})': '指数点位不可交易；打开最接近的 ETF（{symbol}）',
      'Generated {time}': '生成于 {time}',
      // §31 technical grid
      'MACD Signal': 'MACD 信号线',
      'MACD Histogram': 'MACD 柱',
      'Volume Ratio (20D)': '量比（20 日）',
      'Trend alignment': '均线排列',
      '52W High': '52 周最高',
      '52W Low': '52 周最低',
      'Distance to 52W High': '距 52 周高点的百分比（现价 ÷ 高点 − 1）',
      'Distance to 52W Low': '距 52 周低点的百分比（现价 ÷ 低点 − 1）',
      'Where the price sits inside the 52-week range': '现价在 52 周区间中的位置（0%=低点，100%=高点）',
      'Sort by this column (click again to reverse, a third click restores your order)': '按这一列排序（再点一次反向，第三次点击恢复自选顺序）',
      'Code': '代码',
      'Avg volume 20D': '20 日均量',
      'Volatility 20D (ann.)': '20 日波动率（年化）',
      '20-day simple moving average': '20 日简单移动平均线',
      'Relative Strength Index, 14 periods': '相对强弱指标（14 周期）',
      'Average True Range, 14 periods': '平均真实波幅（14 周期）',
      // server-computed trendAlignment vocabulary
      'bullish-stack': '多头排列',
      'bearish-stack': '空头排列',
      'short-term-above-medium': '短期在中期均线之上',
      'short-term-below-medium': '短期在中期均线之下',
      'flat': '走平',
      'insufficient-history': '历史数据不足',
      // full US/HK listing browser (m01842)
      'Browse all US listings': '浏览全部美股清单',
      'Everything listed on NASDAQ, NYSE and AMEX': '涵盖 NASDAQ、NYSE 与 AMEX 全部上市标的',
      'Market': '市场',
      'Board': '板块',
      'US market': '美股',
      'HK market': '港股',
      'CN market': 'A股',
      'JP market': '日股',
      'Crypto': '加密货币',
      'Spot prices, 24/7 market': '现货价格，7×24 小时交易',
      'Loading crypto prices…': '正在加载加密货币行情…',
      'Board fully loaded': '该板块已全量载入',
      'Board not fully loaded yet': '该板块尚未全量载入',
      'loading…': '加载中…',
      '{loaded} listings loaded · {board} page {page} of {pages} · {total} listed': '已载入 {loaded} 条 · {board} 第 {page} / {pages} 页 · 共 {total} 只',
      'Prev': '上一页',
      'Next': '下一页',
      'Load entire board': '载入整个板块',
      'Loading the whole board…': '正在载入整个板块…',
      'The listing feed is temporarily unavailable. Use the search box above — it covers the whole market — or press Load entire board to retry.': '上市清单数据源暂时不可用。可直接使用上方的搜索框（覆盖全市场），或稍后点「载入整个板块」重试。',
      'Loading listings…': '正在载入列表…',
      'Already in your watchlist': '已在自选列表中',
      'Added': '已添加',
      'Add': '添加',
      'Theme': '主题',
      'Dark theme': '深色主题（黑底白字）',
      'Light theme': '浅色主题（白底黑字）',
      'Dark': '深色',
      'Light': '浅色',
    }

    /** Translate one English source string; unknown strings fall back to English. */
    function translate(text, lang) {
      if (lang === 'zh' && Object.prototype.hasOwnProperty.call(ZH, text)) return ZH[text]
      return text
    }

    /** Bound translator: `t('Updated {time}', { time: '10:42:18' })`. */
    function makeT(lang) {
      const target = LANGS.indexOf(lang) >= 0 ? lang : 'en'
      return function t(text, vars) {
        let out = translate(text, target)
        if (vars) {
          out = out.replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined || vars[key] === null ? match : String(vars[key])))
        }
        return out
      }
    }

    // ------------------------------------------------------------------- store
    function createStore(initial) {
      let state = initial
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          const next = typeof patch === 'function' ? patch(state) : patch
          state = Object.assign({}, state, next)
          listeners.forEach((fn) => fn())
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
      }
    }

    // 跨 slot 组件共享的状态（侧栏行与主面板共享同一份状态）。
    // lang      = 用户在本面板里显式选择的语言（null = 跟随平台）
    // langSet   = 本次会话是否已由用户手动选择（避免被服务端旧值覆盖）
    // platformLang = DSH locale / 浏览器语言的归一化结果
    // theme     = 面板配色，'dark'（黑底白字）| 'light'（白底黑字）
    // themeSet  = 本次会话是否已由用户在面板里手动选择（避免被宿主主题快照覆盖）
    const store = createStore({
      view: 'home',
      symbol: null,
      range: '6mo',
      tv: false,
      browseMode: false,
      lang: null,
      langSet: false,
      platformLang: 'en',
      theme: null,
      themeSet: false,
    })
    const setStore = (patch) => store.set(patch)

    function useStore() {
      const [, force] = useState(0)
      useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return store.get()
    }

    /** Effective UI language: explicit choice → platform locale → English. */
    function effectiveLang(ui) {
      return normalizeLang(ui && ui.lang) || normalizeLang(ui && ui.platformLang) || 'en'
    }

    /** Normalise `dark`/`light`; anything else (including null) means "not chosen". */
    function normalizeTheme(value) {
      return THEME_SCHEMES.indexOf(value) >= 0 ? value : null
    }

    /**
     * Effective panel scheme: the choice made here (or the host scheme adopted
     * while nothing was chosen) → light. Light is the shipped default since the
     * user asked for the panel to open light (2026-11-06); dark stays a one-click
     * option in the header and its palette is still declared by `.tm-scheme--dark`.
     */
    function effectiveTheme(ui) {
      return normalizeTheme(ui && ui.theme) || 'light'
    }

    // The DSH theme service (`ctx.get('theme')`), when this build exposes one.
    let hostTheme = null

    /**
     * Adopt a DSH theme snapshot — but never override a scheme the user picked
     * in this panel (that choice is what produced the host preference anyway).
     */
    function applyThemeSnapshot(snapshot) {
      const scheme = normalizeTheme(snapshot && snapshot.active && snapshot.active.colorScheme)
      if (!scheme) return null
      if (!store.get().themeSet) setStore({ theme: scheme })
      return scheme
    }

    /**
     * Follow the DSH theme unless the user picked a scheme here. The service is
     * optional: without it the panel still switches, it just does not mirror the
     * surrounding interface. `theme/change` is the only continuous sync point
     * (it also fires when the OS scheme flips while the host preference is
     * `system`).
     */
    function bindPlatformTheme(ctx) {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get('theme') : null
        // Authoritative: re-binding without a service un-binds the previous one.
        hostTheme = service && typeof service.getTheme === 'function' ? service : null
        if (!hostTheme) return null
        try {
          applyThemeSnapshot(hostTheme.getTheme())
        } catch (_) {
          /* no snapshot yet — the stylesheet default still applies */
        }
        if (typeof ctx.on === 'function') {
          const off = ctx.on('theme/change', (snapshot) => applyThemeSnapshot(snapshot))
          ctx.effect(
            () => () => {
              try {
                if (typeof off === 'function') off()
              } catch (_) {
                /* the service is already gone */
              }
            },
            'dsh-trading-mode: theme',
          )
        }
        return service
      } catch (_) {
        return null
      }
    }

    /**
     * Switch the panel scheme. The DSH theme service is the only writer of the
     * stored preference (it persists through the host settings scope), so the
     * choice survives a reload; without the service it lasts for this session.
     */
    function persistTheme(scheme) {
      const next = normalizeTheme(scheme)
      if (!next) return null
      setStore({ theme: next, themeSet: true })
      try {
        if (hostTheme && typeof hostTheme.setTheme === 'function') hostTheme.setTheme(next)
      } catch (_) {
        /* unregistered scheme or no settings scope — the panel still switches */
      }
      return next
    }

    /** Subscribe to the store and get the bound translator for the active language. */
    function useT() {
      const ui = useStore()
      return { ui, lang: effectiveLang(ui), t: makeT(effectiveLang(ui)) }
    }

    /**
     * Adopt the language persisted on the host — but never override a choice the
     * user made in this session (that choice is what produced the stored value).
     */
    function applyServerLang(settings) {
      const lang = settings ? normalizeLang(settings.lang) : null
      if (lang && !store.get().langSet) setStore({ lang })
      return lang
    }

    /** Persist the language choice (best effort: the UI switches either way). */
    function persistLang(lang) {
      const next = normalizeLang(lang)
      if (!next) return
      setStore({ lang: next, langSet: true })
      request('/settings', { method: 'PATCH', body: { lang: next } }).catch(() => {})
    }

    // -------------------------------------------------------------- formatting
    const CURRENCY_SIGN = { USD: '$', HKD: 'HK$', CNY: '¥', JPY: '¥' }

    /**
     * Market vocabulary (0.5.0, user request m02818).
     *
     * `CRYPTO` is a market like any other: the server resolves `BTC` only when it
     * is told the market (bare `BTC` is also a plausible US ticker), so every
     * navigation and request carries the market along with the symbol.
     */
    // This fork covers US equities and ETFs only (see docs/SCOPE.md). Trimming
    // the list to one entry is what removes the HK / CN / JP / crypto chips from
    // the universe browser and the index strip; the provider layer on the server
    // side is narrowed in a separate change.
    const MARKET_ORDER = ['US']
    const MARKET_LABEL_KEY = {
      US: 'US market',
      HK: 'HK market',
      CN: 'CN market',
      JP: 'JP market',
      CRYPTO: 'Crypto',
    }

    /** Fallback market of a symbol whose record carried none. */
    function marketOfSymbol(symbol) {
      const raw = String(symbol == null ? '' : symbol).toUpperCase()
      if (/\.HK$/.test(raw)) return 'HK'
      if (/\.(SH|SZ|BJ)$/.test(raw)) return 'CN'
      if (/\.T$/.test(raw)) return 'JP'
      return 'US'
    }

    function isNum(value) {
      return typeof value === 'number' && Number.isFinite(value)
    }

    /**
     * Watchlist identity: market + symbol.
     *
     * A bare crypto base and an exchange ticker can share their spelling — `BTC`
     * is also a NYSE-listed trust and `SUI` a US REIT — so "already in the
     * watchlist" must never be decided on the symbol alone, or adding the coin
     * would mark the stock as added too.
     */
    function trackKey(record) {      if (!record || !record.symbol) return ':'
      return `${record.market || ''}:${record.symbol}`
    }

    function digitsFor(value) {
      if (!isNum(value)) return 2
      const abs = Math.abs(value)
      if (abs >= 1) return 2
      if (abs === 0) return 2
      // Sub-dollar assets (crypto especially) need enough decimals to be readable.
      if (abs >= 0.1) return 3
      return Math.min(8, Math.max(4, Math.ceil(-Math.log10(abs)) + 3))
    }

    function money(value, currency) {
      if (!isNum(value)) return '—'
      const sign = CURRENCY_SIGN[currency] || ''
      return `${sign}${value.toFixed(digitsFor(value))}`
    }

    function plain(value, digits) {
      if (!isNum(value)) return '—'
      return value.toFixed(typeof digits === 'number' ? digits : digitsFor(value))
    }

    function signed(value, digits) {
      if (!isNum(value)) return '—'
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(typeof digits === 'number' ? digits : digitsFor(value))}`
    }

    function percent(value) {
      if (!isNum(value)) return '—'
      return `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2)}%`
    }

    function volumeText(value) {
      if (!isNum(value)) return '—'
      const abs = Math.abs(value)
      if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
      if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}K`
      return String(Math.round(value))
    }

    /**
     * Compact money for figures that would otherwise be fourteen characters
     * wide: SEC revenue and balance-sheet lines are in the hundred-billions.
     */
    function compactMoney(value, currency) {
      if (!isNum(value)) return '—'
      const sign = CURRENCY_SIGN[currency] || ''
      const abs = Math.abs(value)
      if (abs >= 1e12) return `${sign}${(value / 1e12).toFixed(2)}T`
      if (abs >= 1e9) return `${sign}${(value / 1e9).toFixed(2)}B`
      if (abs >= 1e6) return `${sign}${(value / 1e6).toFixed(2)}M`
      if (abs >= 1e3) return `${sign}${(value / 1e3).toFixed(1)}K`
      return `${sign}${value.toFixed(2)}`
    }

    function clockOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    function dateTimeOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function dateOf(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    }

    function epochOf(value) {
      if (isNum(value)) return value > 1e12 ? value : value > 1e9 ? value * 1000 : null
      if (typeof value === 'string' && value) {
        const parsed = Date.parse(value)
        return Number.isFinite(parsed) ? parsed : null
      }
      return null
    }

    function nameOf(record, fallback) {
      if (!record) return fallback || '—'
      return record.name || record.nameZh || record.symbol || fallback || '—'
    }

    function trendClass(value) {
      if (!isNum(value)) return ''
      return value > 0 ? 'tm-up' : value < 0 ? 'tm-down' : 'tm-flat'
    }

    function toneOf(price, previousClose) {
      if (!isNum(price) || !isNum(previousClose) || price === previousClose) return ''
      return price > previousClose ? 'tm-up' : 'tm-down'
    }

    // -------------------------------------------------------------------- http
    async function request(path, options) {
      const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {})
      if (opts.body !== undefined && typeof opts.body !== 'string') {
        opts.body = JSON.stringify(opts.body)
        opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers)
      }
      opts.headers = Object.assign({ accept: 'application/json' }, opts.headers)
      const response = await fetch(API_BASE + path, opts)
      let payload = null
      try {
        payload = await response.json()
      } catch (_) {
        payload = null
      }
      if (!response.ok || !payload || payload.ok === false) {
        const info = (payload && payload.error) || {}
        const error = new Error(info.message || `request failed with status ${response.status}`)
        error.code = info.code || `HTTP_${response.status}`
        error.status = response.status
        // 0.7.0: surface the server's own retry hint so the panel can say "wait N s".
        const headerRetry = response.headers && typeof response.headers.get === 'function' ? Number(response.headers.get('retry-after')) : NaN
        error.retryAfterMs = info.retryAfterMs || (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry * 1000 : null)
        throw error
      }
      return payload.value
    }

    const apiGet = (path, signal) => request(path, { signal })
    const apiPost = (path, body, signal) => request(path, { method: 'POST', body: body || {}, signal })

    function useAsync(loader, deps, options) {
      const opts = options || {}
      const [state, setState] = useState({ loading: Boolean(opts.immediate !== false), error: null, data: null })
      const [nonce, setNonce] = useState(0)
      const reload = useCallback(() => setNonce((n) => n + 1), [])
      useEffect(() => {
        let alive = true
        const controller = new AbortController()
        setState((prev) => ({ loading: true, error: null, data: prev.data }))
        Promise.resolve()
          .then(() => loader(controller.signal))
          .then((data) => {
            if (alive) setState({ loading: false, error: null, data })
          })
          .catch((error) => {
            if (alive && error && error.name !== 'AbortError') setState({ loading: false, error, data: null })
          })
        return () => {
          alive = false
          controller.abort()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps.concat([nonce]))
      return Object.assign({ reload }, state)
    }

    // ------------------------------------------------------------------- atoms
    function Spinner({ label }) {
      const { t } = useT()
      return h('div', { className: 'tm-spinner' }, h('span', { className: 'tm-spinner__dot' }), h('span', null, label || t('Loading…')))
    }

    function ErrorNote({ error, onRetry }) {
      const { t } = useT()
      if (!error) return null
      const rateLimited = error.code === 'RATE_LIMITED'
      const waitSeconds = error.retryAfterMs ? Math.max(1, Math.ceil(error.retryAfterMs / 1000)) : null
      // 0.8.0 (round-3 P0-b/P1⑦): say plainly why a whole panel is refused
      // instead of leaking the raw host message at the user.
      const explanation = (() => {
        if (rateLimited)
          return (
            t('Too many requests; the panel is protecting the upstream data sources.') +
            (waitSeconds ? ' ' + t('Try again in about {n} seconds.').replace('{n}', String(waitSeconds)) : '')
          )
        if (error.code === 'HOST_SECURITY_UNAVAILABLE')
          return t('This deployment has no host security fence, so the panel refuses to answer rather than serve an unverifiable caller.')
        if (error.code === 'NO_IDENTITY')
          return t('This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.')
        if (error.code === 'FORBIDDEN') return t('This request did not pass the DSH host/origin check.')
        if (error.code === 'UNAUTHENTICATED') return t('No authenticated DSH browser session for this request.')
        return error.message || String(error)
      })()
      return h(
        'div',
        { className: 'tm-error' },
        h('div', { className: 'tm-error__msg' }, h('strong', null, (error.code || 'ERROR') + ' '), explanation),
        onRetry ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: onRetry }, t('Retry')) : null,
      )
    }

    function Empty({ children }) {
      return h('div', { className: 'tm-empty' }, children)
    }

    function Card({ title, right, children, className, id }) {
      return h(
        'section',
        { className: 'tm-card' + (className ? ' ' + className : ''), id },
        title ? h('header', { className: 'tm-card__head' }, h('h3', { className: 'tm-card__title' }, title), right || null) : null,
        h('div', { className: 'tm-card__body' }, children),
      )
    }

    function Cell({ label, value, tone, title }) {
      return h(
        'div',
        { className: 'tm-cell', title: title || undefined },
        h('span', { className: 'tm-cell__k' }, label),
        h('span', { className: 'tm-cell__v' + (tone ? ' ' + tone : '') }, value),
      )
    }

    /** EN / 中文 switch. Lives in the panel header. */
    function LangToggle() {
      const ui = useStore()
      const active = effectiveLang(ui)
      const { t } = useT()
      return h(
        'div',
        { className: 'tm-langs', role: 'group', 'aria-label': t('Language'), title: t('Language') },
        LANGS.map((lang) =>
          h(
            'button',
            {
              key: lang,
              className: 'tm-lang' + (lang === active ? ' tm-lang--active' : ''),
              title: LANG_LABEL[lang] || lang,
              'aria-pressed': lang === active,
              onClick: () => persistLang(lang),
            },
            LANG_SHORT[lang] || lang.toUpperCase(),
          ),
        ),
      )
    }

    /**
     * White-on-black / black-on-white switch. Lives in the panel header next to
     * the language switch; the visible label stays short, the tooltip spells the
     * scheme out.
     */
    function ThemeToggle() {
      const { ui, t } = useT()
      const active = effectiveTheme(ui)
      return h(
        'div',
        { className: 'tm-themes', role: 'group', 'aria-label': t('Theme'), title: t('Theme') },
        THEME_SCHEMES.map((scheme) =>
          h(
            'button',
            {
              key: scheme,
              className: 'tm-thm' + (scheme === active ? ' tm-thm--active' : ''),
              title: scheme === 'dark' ? t('Dark theme') : t('Light theme'),
              'aria-pressed': scheme === active,
              onClick: () => persistTheme(scheme),
            },
            scheme === 'dark' ? t('Dark') : t('Light'),
          ),
        ),
      )
    }

    /**
     * §21: always show the provider timestamp, never claim the data is live.
     * "Last available data" only when we are knowingly serving something stale.
     */
    function Freshness({ meta, data, compact }) {
      const { t } = useT()
      const stale = Boolean((meta && meta.stale) || (data && data.stale))
      const timestamp = (meta && meta.timestamp) || (data && data.timestamp)
      return h(
        'div',
        { className: 'tm-fresh' + (stale ? ' tm-fresh--stale' : '') + (compact ? ' tm-fresh--compact' : '') },
        h('span', { className: 'tm-fresh__time' }, t('Updated {time}', { time: clockOf(timestamp) })),
        h('span', { className: 'tm-fresh__note' }, stale ? t('Last available data') : t('Data may be delayed')),
        data && data.source ? h('span', { className: 'tm-fresh__src' }, t('Source: {source}', { source: data.source })) : null,
        stale && meta && meta.staleReason ? h('span', { className: 'tm-fresh__why', title: meta.staleReason }, t('cached')) : null,
      )
    }

    // ---------------------------------------------------------------- charting
    function downsample(bars, max) {
      if (!Array.isArray(bars)) return []
      if (bars.length <= max) return bars
      const step = Math.ceil(bars.length / max)
      const out = []
      for (let i = 0; i < bars.length; i += step) out.push(bars[i])
      if (out[out.length - 1] !== bars[bars.length - 1]) out.push(bars[bars.length - 1])
      return out
    }

    function buildGeometry(bars, series, width, height) {
      const highs = bars.map((b) => b.high).filter(isNum)
      const lows = bars.map((b) => b.low).filter(isNum)
      const max = highs.length ? Math.max.apply(null, highs) : 0
      const min = lows.length ? Math.min.apply(null, lows) : 0
      const span = max - min || Math.max(max * 0.01, 1)
      const padTop = 10
      const padBottom = 6
      const priceH = height * 0.72 - padTop - padBottom
      const volumeTop = height * 0.74
      const volumeH = height - volumeTop - 14
      const slot = width / bars.length
      const bodyW = Math.max(1, Math.min(slot * 0.62, 14))
      const yOf = (price) => padTop + (1 - (price - min) / span) * priceH
      const volumeMax = Math.max.apply(null, bars.map((b) => (isNum(b.volume) ? b.volume : 0)).concat([1]))
      const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => padTop + t * priceH)
      const wicks = []
      const bodies = []
      const volumes = []
      bars.forEach((bar, i) => {
        const x = i * slot + slot / 2
        const up = (bar.close ?? 0) >= (bar.open ?? 0)
        wicks.push({ key: 'w' + i, x1: x, x2: x, y1: yOf(bar.high), y2: yOf(bar.low), up })
        const openY = yOf(bar.open)
        const closeY = yOf(bar.close)
        bodies.push({ key: 'b' + i, x: x - bodyW / 2, y: Math.min(openY, closeY), w: bodyW, h: Math.max(1, Math.abs(closeY - openY)), up })
        const volume = isNum(bar.volume) ? bar.volume : 0
        const barH = Math.max(0.5, (volume / volumeMax) * volumeH)
        volumes.push({ key: 'v' + i, x: x - bodyW / 2, y: volumeTop + (volumeH - barH), w: bodyW, h: barH, up })
      })
      const lines = []
      if (series && Array.isArray(series.timestamp)) {
        const lookup = { ma20: new Map(), ma50: new Map(), ma200: new Map() }
        series.timestamp.forEach((ts, i) => {
          ;['ma20', 'ma50', 'ma200'].forEach((key) => {
            const value = series[key] && series[key][i]
            if (isNum(value)) lookup[key].set(epochOf(ts), value)
          })
        })
        ;['ma20', 'ma50', 'ma200'].forEach((key) => {
          const points = []
          bars.forEach((bar, i) => {
            const value = lookup[key].get(epochOf(bar.timestamp))
            if (isNum(value)) points.push(`${(i * slot + slot / 2).toFixed(1)},${yOf(value).toFixed(1)}`)
          })
          if (points.length > 1) lines.push({ key, points: points.join(' ') })
        })
      }
      return { grid, wicks, bodies, volumes, lines, min, max, first: bars[0], last: bars[bars.length - 1] }
    }

    function CandleChart({ candles, series, interval, degraded }) {
      const { t } = useT()
      const bars = useMemo(() => downsample(candles || [], 320), [candles])
      const geo = useMemo(() => buildGeometry(bars, series, 1000, 340), [bars, series])
      if (!bars.length) return h(Empty, null, t('Data unavailable'))
      return h(
        'div',
        { className: 'tm-chart' },
        h(
          'svg',
          { className: 'tm-chart__svg', viewBox: '0 0 1000 340', preserveAspectRatio: 'none', role: 'img' },
          geo.grid.map((y, i) => h('line', { key: 'g' + i, className: 'tm-chart__grid', x1: 0, x2: 1000, y1: y, y2: y })),
          geo.volumes.map((v) => h('rect', { key: v.key, className: 'tm-chart__vol' + (v.up ? ' tm-chart__vol--up' : ''), x: v.x, y: v.y, width: v.w, height: v.h })),
          geo.wicks.map((w) => h('line', { key: w.key, className: 'tm-chart__wick' + (w.up ? ' tm-up-stroke' : ' tm-down-stroke'), x1: w.x1, x2: w.x2, y1: w.y1, y2: w.y2 })),
          geo.bodies.map((b) => h('rect', { key: b.key, className: 'tm-chart__body' + (b.up ? ' tm-up-fill' : ' tm-down-fill'), x: b.x, y: b.y, width: b.w, height: b.h })),
          geo.lines.map((l) => h('polyline', { key: l.key, className: 'tm-chart__ma tm-chart__ma--' + l.key, points: l.points, fill: 'none' })),
        ),
        h(
          'div',
          { className: 'tm-chart__legend' },
          h('span', null, t('High {value}', { value: plain(geo.max) })),
          h('span', null, t('Low {value}', { value: plain(geo.min) })),
          h('span', null, t('{count} bars', { count: bars.length })),
          degraded
            ? h(
                'span',
                {
                  className: 'tm-chart__partial',
                  title: t('The feed returned fewer bars than this range asks for; no reachable source publishes the rest.'),
                },
                t('partial history'),
              )
            : null,
          interval ? h('span', null, t('Interval {interval}', { interval })) : null,
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma20' }, 'MA20'),
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma50' }, 'MA50'),
          h('span', { className: 'tm-chart__ma-key tm-chart__ma-key--ma200' }, 'MA200'),
        ),
        h(
          'div',
          { className: 'tm-chart__footer' },
          h('span', null, `${dateOf(geo.first && geo.first.timestamp)} → ${dateOf(geo.last && geo.last.timestamp)}`),
          h('span', null, t('Last close {value}', { value: plain(geo.last && geo.last.close) })),
        ),
      )
    }

    // ------------------------------------------------------------------ search
    /**
     * Rows of a `/search` answer.
     *
     * Every host route is wrapped by `service.envelope()` as `{ data, meta }`, and
     * the search payload itself is `{ query, market, results, source }` — so the
     * rows live at `payload.data.results`. Reading `payload.results` (the mistake
     * that kept this panel empty) silently yields `undefined` and renders "no
     * matches" for a query the host answered perfectly. Accept the flattened
     * shape as well, so the panel still works if the envelope ever changes.
     */
    function searchRowsOf(payload) {
      const inner = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload
      return inner && Array.isArray(inner.results) ? inner.results : []
    }

    /**
     * 1.1: the search index only knows names and codes, but the owner's own
     * rows also answer to their group tags ("核心仓", "watch") and to their
     * Chinese aliases. Matching the local rows first costs nothing and makes
     * "typing 核心" a real way to reach the tagged positions.
     */
    function localMatches(rows, text) {
      const needle = String(text || '').trim().toLowerCase()
      if (!needle) return []
      return (Array.isArray(rows) ? rows : [])
        .filter((row) => {
          const tags = Array.isArray(row && row.tags) ? row.tags : []
          const hay = [row && row.symbol, row && row.name, row && row.nameZh].concat(tags).filter(Boolean).join(' ').toLowerCase()
          return hay.includes(needle)
        })
        .slice(0, 6)
        .map((row) => ({ symbol: row.symbol, market: row.market || 'US', name: row.name || row.nameZh || '' }))
    }

    /**
     * The one and only search surface, and it stays at the top of the page.
     *
     * A code (`0700`, `600519.SH`), an English name (`Apple`, `NVIDIA`) or a
     * Chinese name (`苹果`, `腾讯`) is answered by `/search`, which the host runs
     * across every enabled market — US, HK, CN, JP and crypto — and returns
     * relevance-ranked. Matches open in a floating panel that overlays the page
     * instead of pushing the watchlist down, and every row ends in a `+` that adds
     * that symbol to the watchlist. Adding is therefore never a separate mode,
     * and no second search box further down the page can disagree with this one.
     */
    // 1.1: search history persistence mirrors the sort key rules — a private
    // localStorage slot, capped at 8, and every access wrapped because file://
    // contexts deny storage outright.
    const RECENT_KEY = 'tm-search-recent'
    const readRecent = () => {
      try {
        const raw = window.localStorage.getItem(RECENT_KEY)
        const list = raw ? JSON.parse(raw) : null
        return Array.isArray(list) ? list.filter((item) => item && typeof item.symbol === 'string').slice(0, 8) : []
      } catch (_) {
        return []
      }
    }

    function SearchBox({ onOpen, onAdd, owned, rows, autoFocus }) {
      const { t } = useT()
      const [query, setQuery] = useState('')
      const [results, setResults] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(false)
      const [active, setActive] = useState(-1)
      const [composing, setComposing] = useState(false)
      const [added, setAdded] = useState(() => new Set())
      // 1.1: last-opened picks live in localStorage, so the next session opens
      // with them on tap — the fastest path back to the usual suspects.
      const [recent, setRecent] = useState(() => readRecent())
      const boxRef = useRef(null)
      const inputRef = useRef(null)

      const text = query.trim()
      // A symbol counts as tracked when the host bootstrap says so, or as soon as
      // this panel added it (before the reload lands). The key is market + symbol:
      // `BTC` the coin and `BTC` the listed trust are different instruments.
      const isOwned = (row) => {
        const key = trackKey(row)
        return Boolean((owned && typeof owned.has === 'function' && owned.has(key)) || added.has(key))
      }

      useEffect(() => {
        if (autoFocus && inputRef.current) {
          try {
            inputRef.current.focus()
          } catch (_) {}
        }
      }, [autoFocus])

      useEffect(() => {
        if (text.length < 1) {
          setResults([])
          setError(null)
          setLoading(false)
          setActive(-1)
          return undefined
        }
        // A Chinese/Japanese IME composes pinyin/romaji in the field first;
        // searching those intermediate letters would only flash junk, so wait for
        // the committed characters.
        if (composing) return undefined
        const controller = new AbortController()
        const timer = setTimeout(() => {
          setLoading(true)
          apiGet(`/search?q=${encodeURIComponent(text)}`, controller.signal)
            .then((value) => {
              // Owner rows answered by tag or alias go first; the directory
              // results follow without duplicates.
              const local = localMatches(rows, text)
              const byKey = new Set(local.map(trackKey))
              const remote = searchRowsOf(value).filter((row) => !byKey.has(trackKey(row)))
              setResults(local.concat(remote))
              setError(null)
              setActive(-1)
              setOpen(true)
            })
            .catch((err) => {
              if (err && err.name !== 'AbortError') {
                setError(err)
                setOpen(true)
              }
            })
            .then(() => setLoading(false))
        }, 260)
        return () => {
          clearTimeout(timer)
          controller.abort()
        }
      }, [text, composing])

      // Clicking anywhere outside the box closes the panel without touching the
      // query, so the same search can be resumed by focusing the field again.
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = boxRef.current
          if (node && typeof node.contains === 'function' && node.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open])

      const remember = (row) => {
        if (!row || !row.symbol) return
        const entry = { symbol: String(row.symbol), market: row.market || 'US', name: row.name || row.nameZh || '' }
        setRecent((previous) => {
          const key = trackKey(row)
          const rest = previous.filter((item) => trackKey(item) !== key)
          const next = [entry, ...rest].slice(0, 8)
          try {
            window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
          } catch (_) {}
          return next
        })
      }

      const forget = () => {
        setRecent([])
        try {
          window.localStorage.removeItem(RECENT_KEY)
        } catch (_) {}
      }

      const add = (row) => {
        if (!onAdd || !row || !row.symbol || isOwned(row)) return
        const key = trackKey(row)
        setAdded((previous) => {
          const next = new Set(previous)
          next.add(key)
          return next
        })
        onAdd(row)
      }

      const clear = () => {
        setQuery('')
        setResults([])
        setError(null)
        setOpen(false)
        setActive(-1)
        if (inputRef.current) {
          try {
            inputRef.current.focus()
          } catch (_) {}
        }
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          setOpen(false)
          setActive(-1)
          return
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          if (!results.length) return
          event.preventDefault()
          setOpen(true)
          setActive((index) =>
            event.key === 'ArrowDown' ? Math.min(index + 1, results.length - 1) : Math.max(index - 1, -1),
          )
          return
        }
        if (event.key === 'Enter') {
          // With an empty field the panel shows recents instead of results:
          // Enter then re-opens the newest pick rather than doing nothing.
          if (text.length < 1 && recent.length) {
            event.preventDefault()
            const item = recent[0]
            remember(item)
            if (onOpen) onOpen({ symbol: item.symbol, market: item.market })
            return
          }
          // A stale highlight must never swallow Enter: clamp to the current
          // result set so the pick lands on a row that actually exists.
          const pick = results[active >= 0 && active < results.length ? active : 0]
          if (pick) {
            event.preventDefault()
            remember(pick)
            if (onOpen) onOpen(pick)
          }
        }
      }

      const showPanel = open && (text.length >= 1 || recent.length > 0)

      // The empty field is the natural place to offer the usual suspects: the
      // panel opens with the recent picks (and their clear button) instead of
      // doing nothing until a character lands.

      // `/` from anywhere outside a text control jumps the caret into stock
      // search; Escape inside the field collapses the panel and clears nothing
      // the user would miss. A convenience only — mouse use stays unchanged.
      useEffect(() => {
        const onKey = (event) => {
          const node = event.target
          const tag = (node && node.tagName) || ''
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (node && node.isContentEditable)) return
          if (event.key !== '/') return
          event.preventDefault()
          try {
            if (inputRef.current) {
              inputRef.current.focus()
              if (typeof inputRef.current.select === 'function') inputRef.current.select()
            }
          } catch (_) {}
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

      return h(
        'div',
        { className: 'tm-search', ref: boxRef },
        h(
          'div',
          { className: 'tm-search__field' },
          h(Icon, { name: 'search' }),
          h('input', {
            ref: inputRef,
            className: 'tm-input',
            value: query,
            placeholder: t('Search Stocks — AAPL / Apple / 苹果 / NVIDIA / 腾讯 / 0700 / 9988'),
            spellCheck: false,
            autoComplete: 'off',
            'aria-autocomplete': 'list',
            'aria-expanded': showPanel ? 'true' : 'false',
            onKeyDown: (event) => {
              if (event.key !== 'Escape') return
              if (query) {
                setQuery('')
                setActive(-1)
              }
              setOpen(false)
              if (inputRef.current) inputRef.current.blur()
            },
            onChange: (event) => {
              setQuery(event.target.value)
              setActive(-1)
              setOpen(true)
            },
            onFocus: () => {
              if (text.length >= 1 || recent.length) setOpen(true)
            },
            onKeyDown,
            onCompositionStart: () => setComposing(true),
            onCompositionEnd: (event) => {
              setComposing(false)
              setQuery(event.target.value)
              setOpen(true)
            },
          }),
          loading ? h('span', { className: 'tm-search__hint' }, t('searching…')) : null,
          text.length >= 1
            ? h('button', { className: 'tm-iconbtn', title: t('Clear the search'), onClick: clear }, h(Icon, { name: 'close' }))
            : null,
        ),
        showPanel
          ? h(
              'div',
              { className: 'tm-search__panel' },
              error ? h(ErrorNote, { error }) : null,
              // 1.1: recent picks greet an empty field — one tap back to the
              // usual suspects, nearest first, with a one-click way to forget.
              text.length < 1 && recent.length
                ? h(
                    'div',
                    { className: 'tm-search__recent', role: 'list' },
                    h('span', { className: 'tm-search__note' }, t('Recent')),
                    recent.map((item) =>
                      h(
                        'button',
                        {
                          key: trackKey(item),
                          className: 'tm-search__recent-chip',
                          title: t('Open {symbol}', { symbol: item.symbol }),
                          onClick: () => {
                            setOpen(false)
                            if (onOpen) onOpen({ symbol: item.symbol, market: item.market })
                          },
                        },
                        item.symbol,
                        item.name ? h('small', null, item.name) : null,
                        // One-tap follow-through: something you opened but never
                        // added is exactly what usually belongs on the list. The
                        // button is a sibling span so the chip stays one click.
                        onAdd && !isOwned(item)
                          ? h(
                              'span',
                              {
                                className: 'tm-search__recent-add',
                                role: 'button',
                                title: t('Add to watchlist'),
                                onClick: (event) => {
                                  event.stopPropagation()
                                  add(item)
                                },
                              },
                              '+',
                            )
                          : null,
                      ),
                    ),
                    h('button', { className: 'tm-search__recent-clear', title: t('Clear recent searches'), onClick: forget }, t('Clear')),
                  )
                : null,
              results.length
                ? h(
                    'div',
                    { className: 'tm-search__note' },
                    t('{count} matches — click a row to open it, + adds it to the watchlist', {
                      count: String(results.length),
                    }),
                  )
                : null,
              results.length
                ? h(
                    'ul',
                    { className: 'tm-results', role: 'listbox' },
                    results.map((row, index) =>
                      h(SearchRow, {
                        key: trackKey(row) || `row-${index}`,
                        row,
                        active: index === active,
                        owned: isOwned(row),
                        onOpen: (chosen) => {
                          setOpen(false)
                          remember(chosen)
                          if (onOpen) onOpen(chosen)
                        },
                        onAdd: add,
                      }),
                    ),
                  )
                : loading
                  ? h('div', { className: 'tm-hint tm-search__empty' }, t('searching…'))
                  : error
                    ? null
                    : h('div', { className: 'tm-hint tm-search__empty' }, t('No matching stock found.')),
            )
          : null,
      )
    }

    /**
     * One line of the search panel: identity on the left (clicking it opens the
     * detail view) and the `+` button on the right that adds that symbol to the
     * watchlist. A tracked symbol shows a star instead and cannot be added twice,
     * which is also the feedback that the click landed.
     */
    function SearchRow({ row, active, owned, onOpen, onAdd }) {
      const { t } = useT()
      const meta = [row.market, row.exchange, row.currency].filter(Boolean).join(' · ')
      const local = row.nameZh && row.name && row.nameZh !== row.name ? ` · ${row.nameZh}` : ''
      const title = owned ? t('Already in your watchlist') : t('Add to watchlist')
      return h(
        'li',
        {
          className: 'tm-result' + (active ? ' tm-result--active' : '') + (owned ? ' tm-result--owned' : ''),
          role: 'option',
          'aria-selected': active ? 'true' : 'false',
        },
        h(
          'button',
          { className: 'tm-result__main', onClick: () => onOpen(row) },
          h('span', { className: 'tm-result__sym' }, row.symbol),
          h('span', { className: 'tm-result__name' }, nameOf(row) + local),
          // Owner rows reach the panel by their tags, so echoing the same pills
          // here makes "核心仓" results self-explanatory.
          Array.isArray(row.tags) && row.tags.length
            ? h('span', { className: 'tm-result__tags' }, row.tags.slice(0, 2).map((tag) => h('span', { className: 'tm-row__tag' }, tag)))
            : null,
          h('span', { className: 'tm-result__meta' }, meta),
        ),
        h(
          'button',
          {
            className: 'tm-result__add' + (owned ? ' tm-result__add--on' : ''),
            disabled: owned,
            title,
            'aria-label': title,
            onClick: () => onAdd(row),
          },
          h(Icon, { name: owned ? 'star' : 'plus' }),
        ),
      )
    }

    // --------------------------------------------------------------- watchlist
    function WatchRow({ item, onOpen, onRemove, onFavorite, onMove, index, count, quoteMode, earnings, onTag }) {
      const { t } = useT()
      const quote = item.quote
      const change = quote ? (isNum(quote.changePct) ? quote.changePct : null) : null
      // 0.8.3 UI: one line per row. The per-row "updated / may be delayed / source"
      // sentence repeated the same three facts on every row, which is what made the
      // list feel crowded; only a stale row now carries a compact badge.
      const stale = Boolean((item.quoteMeta && item.quoteMeta.stale) || (quote && quote.stale))
      // Earnings inside the next week are the one calendar fact that changes a
      // buy decision, so the row carries it as a badge instead of hiding it in
      // the detail view.
      const earn = earnings && earnings.bySymbol ? earnings.bySymbol[String(item.symbol).toUpperCase()] : null
      const earnDays = earn ? daysBetween(earn.date, earnings.today || earn.date) : null
      const earnSoon = earnDays !== null && earnDays >= 0 && earnDays <= 7
      return h(
        'li',
        { className: 'tm-row' },
        h(
          'div',
          { className: 'tm-row__main', role: 'button', tabIndex: 0, onClick: () => onOpen(item) },
          h('span', { className: 'tm-row__sym' }, item.symbol),
          h('span', { className: 'tm-row__name', title: nameOf(item, item.symbol) }, nameOf(item, item.symbol) + (item.nameZh && item.name && item.nameZh !== item.name ? ` · ${item.nameZh}` : '')),
          (item.tags || []).map((tag) =>
            h(
              'button',
              {
                className: 'tm-row__tag' + (onTag ? ' tm-row__tag--go' : ''),
                key: tag,
                title: t('Filter the list by tag {tag}', { tag }),
                onClick: onTag ? (event) => { event.stopPropagation(); onTag(tag) } : undefined,
              },
              tag,
            ),
          ),
          stale ? h('span', { className: 'tm-row__flag', title: (item.quoteMeta && item.quoteMeta.staleReason) || t('Last available data') }, t('cached')) : null,
          earnSoon
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__flag--earn',
                  title: `${t('Next earnings')} ${earn.date} · ${sessionLabel(earn.session, t)}${earn.epsForecast == null ? '' : ` · ${t('EPS est.')} ${money(earn.epsForecast, 'USD')}`}`,
                },
                t('earnings {n}d', { n: earnDays }),
              )
            : null,
          item.error ? h('span', { className: 'tm-row__err' }, item.error.code || 'error') : null,
        ),
        h(
          'div',
          { className: 'tm-row__quote' },
          h('span', { className: 'tm-row__price' }, quote ? money(quote.price, quote.currency) : '—'),
          h('span', { className: 'tm-row__chg ' + trendClass(change) }, quote ? signed(quote.change, 2) : '—'),
          h('span', { className: 'tm-row__pct ' + trendClass(change) }, quote ? percent(change) : ''),
          h('span', { className: 'tm-row__ts' }, quote ? clockOf(quote.timestamp) : '—'),
        ),
        h(
          'div',
          { className: 'tm-row__tools' },
          h(
            'button',
            { className: 'tm-iconbtn' + (item.isFavorite ? ' tm-iconbtn--on' : ''), title: t('Mark as favourite'), onClick: () => onFavorite(item.symbol, !item.isFavorite) },
            h(Icon, { name: 'star' }),
          ),
          h('button', { className: 'tm-iconbtn' + (onMove && index > 0 ? '' : ' tm-iconbtn--ghost'), title: t('Move up'), tabIndex: onMove && index > 0 ? 0 : -1, onClick: () => onMove && onMove(index, index - 1) }, h(Icon, { name: 'up' })),
          h('button', { className: 'tm-iconbtn' + (onMove && index < count - 1 ? '' : ' tm-iconbtn--ghost'), title: t('Move down'), tabIndex: onMove && index < count - 1 ? 0 : -1, onClick: () => onMove && onMove(index, index + 1) }, h(Icon, { name: 'down' })),
          h('button', { className: 'tm-iconbtn', title: t('Remove from watchlist'), onClick: () => onRemove(item.symbol) }, h(Icon, { name: 'trash' })),
        ),
      )
    }

    /**
     * 1.1: parse the CSV the watchlist card exports (RFC 4180 quotes) back
     * into import items. Quote/price columns are ignored — the server calls
     * resolveSymbol and the panel re-attaches live data itself.
     */
    function parseWatchlistCsv(text) {
      const rows = []
      let field = ''
      let row = []
      let inQuotes = false
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i]
        if (inQuotes) {
          if (ch === '"') {
            if (text[i + 1] === '"') { field += '"'; i += 1 } else inQuotes = false
          } else field += ch
        } else if (ch === '"') {
          inQuotes = true
        } else if (ch === ',') {
          row.push(field); field = ''
        } else if (ch === '\n' || ch === '\r') {
          if (ch === '\r' && text[i + 1] === '\n') i += 1
          row.push(field); field = ''
          if (row.some((cell) => cell.trim().length)) rows.push(row)
          row = []
        } else field += ch
      }
      if (field.length || row.length) { row.push(field); if (row.some((cell) => cell.trim().length)) rows.push(row) }
      if (!rows.length) return []
      // 1.1: headers are matched case-insensitively and the favourite column
      // accepts the spellings spreadsheets keep producing (TRUE/yes/1/是),
      // so a hand-edited CSV still round-trips instead of dying on casing.
      const header = rows[0].map((cell) => cell.trim())
      const wanted = ['Symbol', 'Market', 'Name', 'Tags', 'Favorite']
      if (header.slice(0, 5).join('|').toLowerCase() !== wanted.join('|').toLowerCase()) {
        // Not our CSV dialect — return empty so the caller reports the file as
        // unreadable instead of importing garbage.
        return []
      }
      const truthy = (cell) => /^(true|1|yes|y|是)$/i.test((cell || '').trim()) ? true : undefined
      return rows.slice(1).map((cells) => ({
        symbol: (cells[0] || '').trim(),
        market: (cells[1] || '').trim() || undefined,
        name: (cells[2] || '').trim() || undefined,
        tags: (cells[3] || '').trim() ? (cells[3] || '').split('|').map((tag) => tag.trim()).filter(Boolean) : undefined,
        isFavorite: /^y$/i.test((cells[4] || '').trim()) ? true : truthy(cells[4]),
      })).filter((item) => item.symbol)
    }

    function WatchlistCard({ rows, onOpen, onRemove, onFavorite, onMove, onRefresh, loading, error, browseMode, onToggleBrowse, identity }) {
      const { t } = useT()
      // Display-only sorting: the saved watchlist order (up/down tools) is never
      // rewritten. Clicking a quote header cycles desc → asc → back to custom.
      // The pick survives reloads through localStorage: a column someone chose
      // deliberately should not evaporate on the next refresh. Reads are wrapped
      // because WebKit throws when localStorage is disabled on file:// pages.
      const [sort, setSort] = useState(() => {
        // React's lazy initializer: runs exactly once on the first mount.
        let stored = null
        try {
          stored = JSON.parse(window.localStorage.getItem('tm-watchlist-sort') || 'null')
        } catch (error) {
          stored = null
        }
        return stored && typeof stored.key === 'string' && (stored.dir === -1 || stored.dir === 1) ? { key: stored.key, dir: stored.dir } : null
      })
      useEffect(() => {
        try {
          if (sort) window.localStorage.setItem('tm-watchlist-sort', JSON.stringify(sort))
          else window.localStorage.removeItem('tm-watchlist-sort')
        } catch (error) {
          // private mode / disabled storage: sorting still works this session
        }
      }, [sort])
      const toggleSort = (key) =>
        setSort((prev) => (!prev || prev.key !== key ? { key, dir: -1 } : prev.dir === -1 ? { key, dir: 1 } : null))
      // Favourites-first stays display-only as well: the chip narrows the list
      // to starred rows, which shares the sort's "moves disabled while filtered"
      // rule, so the saved order is never rewritten from a narrowed view.
      const [starOnly, setStarOnly] = useState(false)
      // 1.1: tags from the store narrow the list too; like favourites this is
      // display-only, so moves stay disabled while a filter is on.
      const [tagFilter, setTagFilter] = useState('')
      // 1.1: group the list by the rows' first tag (ungrouped last). Display-only
      // again: with grouping on, saved ordering no longer matches the visual
      // order, so moves are disabled exactly as in filtered/sorted views.
      const [grouped, setGrouped] = useState(false)
      const tagPool = []
      // 1.1: chips carry their counts so the labels answer "how many" without
      // switching views first.
      const favouritesCount = rows.filter((row) => Boolean(row.isFavorite)).length
      const tagCounts = new Map()
      for (const row of rows) {
        if (!Array.isArray(row.tags)) continue
        for (const tag of row.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
          if (!tagPool.includes(tag)) tagPool.push(tag)
        }
      }
      let viewRows = sort
        ? rows
            .slice()
            .sort((a, b) => {
              // Symbol sort reads the row's own ticker, not a quote field: the
              // code column has meaning even for a row without a live quote.
              if (sort.key === 'symbol') return String(a.symbol).localeCompare(String(b.symbol)) * sort.dir
              const qa = a.quote
              const qb = b.quote
              const va = qa && isNum(qa[sort.key]) ? qa[sort.key] : null
              const vb = qb && isNum(qb[sort.key]) ? qb[sort.key] : null
              if (va === null && vb === null) return 0
              if (va === null) return 1 // rows without a live quote sink to the bottom
              if (vb === null) return -1
              return (va - vb) * sort.dir
            })
        : rows
      if (starOnly) viewRows = viewRows.filter((row) => Boolean(row.isFavorite))
      if (tagFilter) viewRows = viewRows.filter((row) => Array.isArray(row.tags) && row.tags.includes(tagFilter))
      const sortHeader = (key, label) =>
        h(
          'button',
          {
            className: 'tm-row__sort' + (sort && sort.key === key ? ' tm-row__sort--on' : ''),
            onClick: () => toggleSort(key),
            title: t('Sort by this column (click again to reverse, a third click restores your order)'),
          },
          label,
          sort && sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : '',
        )
      // One request covers the whole list: the host caches each calendar date for
      // six hours, so a refresh costs nothing upstream.
      const earnings = useAsync((signal) => apiGet('/earnings?days=14', signal), [])
      // 0.8.0: never pretend a watchlist was stored when the deployment has no
      // trustworthy per-user identity (the API refuses those writes with 503).
      const noIdentity = Boolean(identity && identity.storesPerUserData === false)
      // 1.1: a JSON export made elsewhere (or a CSV written by the same file
      // this card exports) can restore the whole list in one click. Parsing is
      // client-side; the server route resolves each row and reports failures.
      const fileRef = useRef(null)
      const [importing, setImporting] = useState(false)
      const [importError, setImportError] = useState(null)
      const [importReport, setImportReport] = useState(null)
      const onImportFile = (event) => {
        const file = event.target.files && event.target.files[0]
        event.target.value = ''
        if (!file) return
        setImporting(true)
        setImportError(null)
        setImportReport(null)
        ;(async () => {
          let text = await file.text()
          let entries = null
          try {
            const parsed = JSON.parse(text)
            entries = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.items) ? parsed.items : null
          } catch (_) {
            entries = parseWatchlistCsv(text)
          }
          if (!entries || !entries.length) throw new Error(t('The file holds no restorable rows.'))
          // 1.1: the route reports what it managed to resolve, so the panel can
          // say "restored" and name any row the directory could not map.
          const report = await apiPost('/watchlist/import', { items: entries })
          const value = report && typeof report === 'object' ? report : {}
          const restored = value.added != null ? value.added : Math.max(0, entries.length)
          const rejected = Array.isArray(value.failed) ? value.failed : []
          setImportReport({ restored, rejected })
          if (onRefresh) onRefresh()
        })()
          .catch((err) => setImportError(err))
          .then(() => setImporting(false))
      }
      return h(
        Card,
        {
          title: t('My Watchlist'),
          className: 'tm-card--watchlist',
          right: h(
            'div',
            { className: 'tm-card__tools' },
            h('button', { className: 'tm-btn tm-btn--ghost', onClick: onRefresh, title: t('Refresh quotes') }, h(Icon, { name: 'refresh' }), t('Refresh')),
            h(
              'button',
              {
                className: 'tm-btn' + (browseMode ? ' tm-btn--active' : ''),
                onClick: onToggleBrowse,
                title: t('Browse every listing on every market'),
              },
              h(Icon, { name: 'list' }),
              t('Browse listings'),
            ),
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost' + (starOnly ? ' tm-btn--active' : ''),
                onClick: () => setStarOnly(!starOnly),
                title: t('Show favourites only (click again to see everything)'),
              },
              h(Icon, { name: 'star' }),
              // 1.1: the count answers "how much on this list is pinned" before
              // switching display modes; 0 keeps the plain label (no fake data).
              favouritesCount ? `${t('Favorites')} · ${favouritesCount}` : t('Favorites'),
            ),
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost' + (grouped ? ' tm-btn--active' : ''),
                onClick: () => setGrouped(!grouped),
                title: t('Group the list by tag (strongest change first; click again to restore your order)'),
              },
              h(Icon, { name: 'grip' }),
              t('By tag'),
            ),
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost',
                // 1.1: the saved list leaves the plugin as a spreadsheet-ready
                // file — BOM first so Excel opens UTF-8 Chinese names directly.
                onClick: () => {
                  const cell = (value) => {
                    const text = String(value == null ? '' : value)
                    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
                  }
                  const lines = ['Symbol,Market,Name,Tags,Favorite,Price,Change,Change %,Time']
                  for (const row of rows) {
                    const quote = row.quote || {}
                    lines.push(
                      [
                        row.symbol,
                        row.market || 'US',
                        row.name || row.nameZh || '',
                        Array.isArray(row.tags) ? row.tags.join('|') : '',
                        row.isFavorite ? 'Y' : 'N',
                        isNum(quote.price) ? String(quote.price) : '',
                        isNum(quote.change) ? String(quote.change) : '',
                        isNum(quote.changePct) ? String(quote.changePct) : '',
                        quote.time || '',
                      ]
                        .map(cell)
                        .join(','),
                    )
                  }
                  const blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const anchor = document.createElement('a')
                  anchor.href = url
                  anchor.download = `watchlist-${new Date().toISOString().slice(0, 10)}.csv`
                  document.body.appendChild(anchor)
                  anchor.click()
                  anchor.remove()
                  URL.revokeObjectURL(url)
                },
                title: t('Download the watchlist as a CSV file (opens directly in Excel)'),
              },
              h(Icon, { name: 'download' }),
              t('Export CSV'),
            ),
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost',
                onClick: () => {
                  if (fileRef.current) fileRef.current.click()
                },
                disabled: importing,
                title: t('Restore rows from a previous export (CSV or JSON)'),
              },
              h(Icon, { name: 'download' }),
              t('Import'),
            ),
          ),
        },
        error ? h(ErrorNote, { error, onRetry: onRefresh }) : null,
        importError ? h('div', { className: 'tm-note tm-note--warn' }, String(importError.message || importError)) : null,
        importReport
          ? h(
              'div',
              { className: 'tm-note tm-note--ok' },
              t('{n} rows restored.', { n: importReport.restored }),
              importReport.rejected.length
                ? ' ' + t('{n} rows could not be resolved:', { n: importReport.rejected.length }) + ' ' + importReport.rejected.slice(0, 8).map((row) => row.symbol || '?').join(', ')
                : null,
            )
          : null,
        importing ? h(Spinner, { label: t('Restoring the list…') }) : null,
        h('input', { ref: fileRef, type: 'file', accept: '.csv,.json,application/json,text/csv', onChange: onImportFile, className: 'tm-file-input', 'aria-hidden': 'true', tabIndex: -1, style: { display: 'none' } }),
        noIdentity
          ? h(
              'div',
              { className: 'tm-note tm-note--warn' },
              t('This DSH profile has no trustworthy per-user identity, so the watchlist and preferences are unavailable. Market data still works.'),
            )
          : null,
        loading && !rows.length ? h(Spinner, { label: t('Loading watchlist…') }) : null,
        rows.length && tagPool.length
          ? h(
              'div',
              { className: 'tm-tagrow' },
              h('button', { className: 'tm-chip' + (tagFilter ? '' : ' tm-chip--active'), onClick: () => setTagFilter('') }, `${t('All')} · ${rows.length}`),
              tagPool.map((tag) =>
                h('button', { key: tag, className: 'tm-chip' + (tagFilter === tag ? ' tm-chip--active' : ''), onClick: () => setTagFilter(tagFilter === tag ? '' : tag) }, `${tag} · ${tagCounts.get(tag)}`),
              ),
            )
          : null,
        rows.length
          ? h(
              'div',
              { className: 'tm-row tm-row--head' },
              h(
                'div',
                { className: 'tm-row__main' },
                h('span', { className: 'tm-row__sym' }, t('Symbol')),
                h('span', { className: 'tm-row__name' }, t('Name')),
              ),
              h(
                'div',
                { className: 'tm-row__quote' },
                sortHeader('symbol', t('Code')),
                sortHeader('price', t('Price')),
                sortHeader('change', t('Change')),
                sortHeader('changePct', t('Change %')),
                h('span', null, t('Time')),
              ),
              h('div', { className: 'tm-row__tools' }),
            )
          : null,
        rows.length
          ? h(
              'ul',
              { className: 'tm-list' },
              (() => {
                const filteredEmpty = rows.length > 0 && viewRows.length === 0
                // Grouping inserts a quiet label before each tag bucket and
                // disables moves (the stored order no longer matches the view).
                // 1.1: inside a bucket the day's movers lead — quotes missing
                // for a row sink within the bucket, stored order unchanged.
                const groupOn = grouped && !sort && !starOnly && !tagFilter
                const groupRows = groupOn
                  ? viewRows.slice().sort((a, b) => {
                      const qa = a.quote && isNum(a.quote.changePct) ? a.quote.changePct : null
                      const qb = b.quote && isNum(b.quote.changePct) ? b.quote.changePct : null
                      if (qa === null && qb === null) return 0
                      if (qa === null) return 1
                      if (qb === null) return -1
                      return qb - qa
                    })
                  : viewRows
                const entries = []
                let lastLabel = null
                // 1.1: the bucket header carries its size ("核心仓 · 4") — set
                // before the loop, not run inside it.
                const counts = new Map()
                if (groupOn) {
                  for (const item of groupRows) {
                    const label = Array.isArray(item.tags) && item.tags.length ? item.tags[0] : t('Ungrouped')
                    counts.set(label, (counts.get(label) || 0) + 1)
                  }
                }
                groupRows.forEach((item, index) => {
                  if (groupOn) {
                    const label = Array.isArray(item.tags) && item.tags.length ? item.tags[0] : t('Ungrouped')
                    if (label !== lastLabel) {
                      entries.push(h('li', { key: `group:${label}`, className: 'tm-list__group', 'aria-hidden': 'true' }, `${label} · ${counts.get(label)}`))
                    }
                    lastLabel = label
                  }
                  entries.push(
                    h(WatchRow, {
                      key: item.symbol,
                      earnings: earnings.data,
                      item,
                      index,
                      count: groupRows.length,
                      onOpen,
                      onRemove,
                      onFavorite,
                      onTag: setTagFilter,
                      onMove: sort || starOnly || tagFilter || groupOn ? null : onMove,
                    }),
                  )
                })
                return filteredEmpty ? [h(Empty, null, t('Nothing matches the current filters.'))] : entries
              })(),
            )
          : rows.length
            ? h(Empty, null, t('No favourites yet. Tap the star on a row to pin it here.'))
            : h(Empty, null, t('Your watchlist is empty. Use Search Stocks or the starter list below to add a stock.')),
      )
    }

    function StarterPool({ recommendations, onAdd, onOpen }) {
      const { t } = useT()
      if (!recommendations || !recommendations.ALL || !recommendations.ALL.length) return null
      return h(
        Card,
        {
          title: t('Starter list'),
          right: h('span', { className: 'tm-hint tm-hint--tiny' }, t('Tap a symbol to preview it; the plus adds it to your watchlist')),
        },
        h(
          'div',
          { className: 'tm-chips' },
          recommendations.ALL.flatMap((symbol) => [
            // The symbol itself previews the stock; the plus still adds it —
            // but the empty state means the user has nothing to lose by looking.
            h('button', {
              key: symbol,
              className: 'tm-chip',
              title: t('Open {symbol}', { symbol }),
              onClick: () => onOpen && onOpen({ symbol }),
            }, symbol),
            h('button', {
              key: `${symbol}+`,
              className: 'tm-chip tm-chip--add',
              title: t('Add to watchlist'),
              onClick: () => onAdd({ symbol }),
            }, '+'),
          ]),
        ),
      )
    }

    // -------------------------------------------------- browse the whole market
    const UNIVERSE_PAGE_SIZE = 100

    /**
     * Browsing, not searching. The page has exactly one search box (the one at the
     * top); this card is the directory of what is listed on the covered venues,
     * walked board by board, for discovering a stock whose name is not known yet.
     * It therefore carries no filter field of its own.
     */
    function UniverseBrowser({ onAdd, onOpen, owned, initialMarket }) {
      const { t } = useT()
      const [market, setMarket] = useState(MARKET_ORDER.includes(initialMarket) ? initialMarket : 'US')
      const [board, setBoard] = useState(null)
      const [page, setPage] = useState(1)
      const [boards, setBoards] = useState([])
      const [status, setStatus] = useState(null)
      const [result, setResult] = useState(null)
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        setLoading(true)
        const qs = `?market=${market}${board ? `&board=${encodeURIComponent(board)}` : ''}&page=${page}&size=${UNIVERSE_PAGE_SIZE}`
        apiGet(`/universe${qs}`, controller.signal)
          .then((value) => {
            if (cancelled || !value) return
            setResult(value)
            if (Array.isArray(value.boards) && value.boards.length) setBoards(value.boards)
            if (value.status) setStatus(value.status)
            setError(null)
          })
          .catch((err) => {
            if (!cancelled && err && err.name !== 'AbortError') setError(err)
          })
          .then(() => {
            if (!cancelled) setLoading(false)
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [market, board, page])

      const walkBoard = useCallback(() => {
        setBusy(true)
        setError(null)
        apiPost('/universe', { market, board })
          .then((value) => {
            if (value && value.status) setStatus(value.status)
          })
          .catch((err) => setError(err))
          .then(() => setBusy(false))
      }, [market, board])

      // A background walk reports progress through the status block only.
      const running = Boolean(status && status.refreshing)
      useEffect(() => {
        if (!running) return undefined
        const timer = setInterval(() => {
          apiGet(`/universe?market=${market}&page=1&size=1`)
            .then((value) => {
              if (value && value.status) setStatus(value.status)
            })
            .catch(() => {})
        }, 4000)
        return () => clearInterval(timer)
      }, [running, market])

      const rows = (result && result.rows) || []
      const pages = result && isNum(result.pages) ? result.pages : null
      const shown = pages ? Math.min(page, pages) : page
      // A feed without a published row count (the HK fallback list) pages until a
      // short page arrives, so "next" is offered while the page came back full.
      const pageSize = (result && isNum(result.size) && result.size) || UNIVERSE_PAGE_SIZE
      const canNext = pages ? shown < pages : rows.length >= pageSize
      const boardRows = boards.filter((b) => b.market === market)
      const loaded = status && status.counts ? status.counts[market] || 0 : 0
      const activeBoard = board || (boardRows[0] && boardRows[0].id) || null
      const boardMeta = boardRows.find((b) => b.id === activeBoard) || null

      return h(
        'div',
        { className: 'tm-universe' },
        h(
          'div',
          { className: 'tm-universe__bar' },
          h(
            'div',
            { className: 'tm-chips', role: 'group', 'aria-label': t('Market') },
            MARKET_ORDER.map((m) =>
              h(
                'button',
                {
                  key: m,
                  className: 'tm-chip' + (market === m ? ' tm-chip--active' : ''),
                  onClick: () => {
                    setMarket(m)
                    setBoard(null)
                    setPage(1)
                  },
                },
                t(MARKET_LABEL_KEY[m]),
              ),
            ),
          ),
          boardRows.length
            ? h(
                'div',
                { className: 'tm-chips', role: 'group', 'aria-label': t('Board') },
                boardRows.map((b) =>
                  h(
                    'button',
                    {
                      key: b.id,
                      className: 'tm-chip' + (activeBoard === b.id ? ' tm-chip--active' : ''),
                      title: b.complete ? t('Board fully loaded') : t('Board not fully loaded yet'),
                      onClick: () => {
                        setBoard(b.id)
                        setPage(1)
                      },
                    },
                    b.id + (b.total ? ` · ${b.total}` : ''),
                  ),
                ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'tm-universe__tools' },
          h(
            'span',
            { className: 'tm-hint tm-hint--tiny' },
            t('{loaded} listings loaded · {board} page {page} of {pages} · {total} listed', {
              loaded: String(loaded),
              board: activeBoard || '—',
              page: String(shown),
              pages: String(pages || '—'),
              total: String((boardMeta && boardMeta.total) || (result && result.total) || '—'),
            }),
          ),
          h(
            'div',
            { className: 'tm-card__tools' },
            shown > 1 ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => setPage(Math.max(1, shown - 1)) }, h(Icon, { name: 'up' }), t('Prev')) : null,
            canNext ? h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => setPage(shown + 1) }, t('Next'), h(Icon, { name: 'down' })) : null,
            h('button', { className: 'tm-btn', onClick: walkBoard, disabled: busy || running }, h(Icon, { name: 'download' }), running ? t('Loading the whole board…') : t('Load entire board')),
          ),
        ),
        error ? h(ErrorNote, { error, onRetry: walkBoard }) : null,
        error && !rows.length
          ? h('div', { className: 'tm-hint' }, t('The listing feed is temporarily unavailable. Use the search box above — it covers the whole market — or press Load entire board to retry.'))
          : null,
        loading && !rows.length ? h(Spinner, { label: t('Loading listings…') }) : null,
        rows.length
          ? h(
              'ul',
              { className: 'tm-universe__list' },
              // A sticky head keeps the column meaning visible while paging
              // through a 100-row board; aria-hidden mirrors the watchlist head.
              h(
                'li',
                { className: 'tm-universe__row tm-universe__row--head', 'aria-hidden': 'true' },
                h('span', { className: 'tm-universe__sym' }, t('Code')),
                h('span', { className: 'tm-universe__name' }, t('Name')),
                h('span', { className: 'tm-universe__meta' }, t('Exchange')),
              ),
              rows.map((row) => h(UniverseRow, { key: row.symbol, row, onAdd, onOpen, owned })),
            )
          : null,
      )
    }

    function UniverseRow({ row, onAdd, onOpen, owned }) {
      const { t } = useT()
      const has = Boolean(owned && typeof owned.has === 'function' && owned.has(trackKey(row)))
      return h(
        'li',
        { className: 'tm-universe__row' },
        // The symbol doubles as the shortcut into the detail view — add it or
        // look at its chart, both start from the same browse list.
        onOpen
          ? h('button', { className: 'tm-universe__sym', type: 'button', title: t('Open {symbol}', { symbol: row.symbol }), onClick: () => onOpen({ symbol: row.symbol, market: row.market }) }, row.symbol)
          : h('span', { className: 'tm-universe__sym' }, row.symbol),
        h('span', { className: 'tm-universe__name' }, nameOf(row, row.symbol) + (row.nameZh && row.name && row.nameZh !== row.name ? ` · ${row.nameZh}` : '')),
        h('span', { className: 'tm-universe__meta' }, [row.market, row.exchange, row.industry && row.industry !== '-' ? row.industry : null].filter(Boolean).join(' · ')),
        h(
          'button',
          {
            className: 'tm-btn tm-btn--ghost',
            disabled: has,
            title: has ? t('Already in your watchlist') : t('Add to watchlist'),
            onClick: () => onAdd(row),
          },
          h(Icon, { name: has ? 'star' : 'plus' }),
          has ? t('Added') : t('Add'),
        ),
      )
    }

    /** Splits "AAPL 342.37 微跌…" into a bold ticker + the rest, so a wall of
     *  observation lines can be scanned by symbol instead of read as prose. */
    function observationNodes(line, key, onOpen) {
      const m = /^([A-Z][A-Z0-9.\-]{0,6})\b\s*/.exec(line)
      if (!m) return line
      // With an `onOpen` the leading ticker doubles as the shortcut into that
      // symbol's detail view — read the suggestion, click the code, look at
      // the chart. Without one it stays the plain bold chip.
      const ticker = onOpen
        ? h('button', { key: key + '-s', className: 'tm-brief__sym tm-brief__sym--go', type: 'button', onClick: () => onOpen({ symbol: m[1], market: 'US' }) }, m[1])
        : h('span', { key: key + '-s', className: 'tm-brief__sym' }, m[1])
      return [ticker, line.slice(m[0].length)]
    }

    function MoverTile({ label, text, tone }) {
      return h(
        'div',
        { className: 'tm-brief__mover' },
        h('span', { className: 'tm-brief__mover-k' }, label),
        h('span', { className: 'tm-brief__mover-v' + (tone ? ' ' + tone : '') }, text),
      )
    }

    /** `2026-11-06T…` → `20:19` (or `11/09 20:19` on an earlier day), local clock. */
    function briefWhen(iso) {
      const time = Date.parse(String(iso || ''))
      if (!Number.isFinite(time)) return null
      const d = new Date(time)
      const two = (n) => String(n).padStart(2, '0')
      const hm = `${two(d.getHours())}:${two(d.getMinutes())}`
      return d.toDateString() === new Date().toDateString() ? hm : `${two(d.getMonth() + 1)}/${two(d.getDate())} ${hm}`
    }

    function BriefCard({ brief, sectors, onRun, loading, error, aiAvailable, aiReason, onOpen }) {
      const [copied, setCopied] = useState(false)
      const { t, lang } = useT()
      return h(
        Card,
        {
          title: t('AI Watchlist Brief'),
          id: 'tm-brief-card',
          right: h(
            'div',
            { className: 'tm-card__tools' },
            h('button', { className: 'tm-btn', onClick: onRun, disabled: loading || !aiAvailable }, loading ? t('Analysing…') : t('Generate Brief')),
          ),
        },
        !aiAvailable
          ? h(
              'div',
              { className: 'tm-hint' },
              t('DeepSeek is not available in this DSH session, so the brief cannot be generated. Market data above is unaffected.'),
              aiReason ? h('div', { className: 'tm-hint__why' }, t('Reason: ') + aiReason) : null,
            )
          : null,
        error ? h(ErrorNote, { error, onRetry: onRun }) : null,
        // 1.1: a skeleton mirrors the finished card's shape (headline bar,
        // three stat cells, two list lines), so the panel never jumps when the
        // answer lands. The spinner text stays for assistive tech.
        loading
          ? h(
              'div',
              { className: 'tm-skeleton', role: 'status', 'aria-label': t('DeepSeek is reading your watchlist…') },
              h('div', { className: 'tm-skeleton__bar tm-skeleton__bar--wide' }),
              h('div', { className: 'tm-skeleton__stats' }, h('span'), h('span'), h('span')),
              h('div', { className: 'tm-skeleton__bar' }),
              h('div', { className: 'tm-skeleton__bar tm-skeleton__bar--dim' }),
            )
          : null,
        brief
          ? h(
              'div',
              { className: 'tm-brief' },
              h('p', { className: 'tm-brief__headline' }, brief.headline),
              // A brief whose numbers are hours old reads differently; the stamp
              // sits right under the headline so the age is never guessed.
              brief.generatedAt && briefWhen(brief.generatedAt)
                ? h('p', { className: 'tm-brief__when' }, t('Generated {time}', { time: briefWhen(brief.generatedAt) }))
                : null,
              // 1.1: the board the model read (server-echoed); purely a colour
              // line — no claim is made about any single holding's trend.
              Array.isArray(sectors) && sectors.length
                ? h('p', { className: 'tm-brief__when tm-brief__sectors' },
                  t('Board context'),
                  '：',
                  sectors.slice(0, 6).map((sector, index) => h(
                    'span',
                    { key: sector.symbol || index, className: trendClass(sector.changePct) },
                    `${lang === 'zh' && sector.zh ? sector.zh : sector.symbol} ${(sector.changePct > 0 ? '+' : '')}${Number(sector.changePct).toFixed(1)}%`
                  )).reduce((all, span, index) => (index ? all.concat(' · ', span) : all.concat(span)), []),
                )
                : null,
              h(
                'div',
                { className: 'tm-brief__stats' },
                h(Cell, { label: t('Stocks tracked'), value: String(brief.stocksTracked) }),
                h(Cell, { label: t('Up'), value: String(brief.upCount), tone: 'tm-up' }),
                h(Cell, { label: t('Down'), value: String(brief.downCount), tone: 'tm-down' }),
              ),
              h(
                'div',
                { className: 'tm-brief__movers' },
                h(MoverTile, { label: t('Strongest mover'), text: brief.strongestMover, tone: 'tm-up' }),
                h(MoverTile, { label: t('Largest decline'), text: brief.largestDecline, tone: 'tm-down' }),
              ),
              brief.unusualVolume.length
                ? h(
                    'section',
                    { className: 'tm-brief__block' },
                    h('h4', { className: 'tm-brief__label' }, t('Unusual volume')),
                    h('p', { className: 'tm-brief__text' }, brief.unusualVolume.join(' · ')),
                  )
                : null,
              brief.keyObservations.length
                ? h(
                    'section',
                    { className: 'tm-brief__block' },
                    h('h4', { className: 'tm-brief__label' }, t('Key observations')),
                    h(
                      'ul',
                      { className: 'tm-brief__list' },
                      brief.keyObservations.map((line, i) => h('li', { key: i }, observationNodes(line, String(i), onOpen))),
                    ),
                  )
                : null,
              (brief.suggestions || []).length
                ? h(
                    'section',
                    { className: 'tm-brief__block tm-brief__block--actions' },
                    h(
                      'h4',
                      { className: 'tm-brief__label' },
                      t('Action ideas'),
                      // One click turns the numbered list into shareable text;
                      // failures stay silent because copying is a convenience,
                      // not an action the list depends on.
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'tm-brief__copy',
                          title: t('Copy the suggestions as text'),
                          onClick: () => {
                            if (!Array.isArray(brief.suggestions) || !brief.suggestions.length) return
                            navigator.clipboard?.writeText(
                              [
                                // Paste keeps a bit of context so a checklist read
                                // without the panel still knows when it was written.
                                `${t('Action ideas')} · ${brief.generatedAt && briefWhen(brief.generatedAt) ? t('Generated {time}', { time: briefWhen(brief.generatedAt) }) : ''}`.trim(),
                                ...brief.suggestions.map((line, i) => `${i + 1}. ${line}`),
                              ].join('\n'),
                            ).then(() => {
                              setCopied(true)
                              setTimeout(() => setCopied(false), 1500)
                            }).catch(() => {})
                          },
                        },
                        copied ? t('Copied') : t('Copy'),
                      ),
                    ),
                    h(
                      'ol',
                      { className: 'tm-brief__actions' },
                      brief.suggestions.map((line, i) =>
                        h(
                          'li',
                          { key: i },
                          h('span', { key: 'n', className: 'tm-brief__n' }, String(i + 1)),
                          h('span', { key: 't', className: 'tm-brief__action-text' }, observationNodes(line, 'a' + i, onOpen)),
                        ),
                      ),
                    ),
                  )
                : null,
              h('p', { className: 'tm-disclaimer' }, t('These are watchlist stocks, not portfolio holdings. Not financial advice.')),
            )
          : h('div', { className: 'tm-hint' }, t('Generate a brief: what moved, where each stock stands, and which levels to watch next.')),
      )
    }

    // ------------------------------------------------------------------ status
    function StatusStrip({ status, ai, watchlistBackend, cacheBackend }) {
      const { t } = useT()
      const [open, setOpen] = useState(false)
      const providers = (status && status.providers) || []
      const healthy = providers.filter((p) => p.healthy).length
      const active = providers.filter((p) => p.healthy).map((p) => p.id)
      const chains = (status && status.chains) || {}
      // Row 2 of the header is a single line: count pill on the left, this
      // summary right-aligned and ellipsised. The full string stays one hover
      // away (title) and is repeated inside the popover, so nothing is lost.
      const aiLabel = (() => {
        // ai.route is {provider, model} (or null) — interpolating it directly
        // printed "[object Object]".
        if (!ai) return '—'
        if (!ai.available) return t('unavailable')
        const route = ai.route
        if (!route) return t('ready')
        if (typeof route === 'string') return route
        const parts = [route.provider, route.model].filter(Boolean)
        return parts.length ? parts.join(' / ') : t('ready')
      })()
      const metaText = t('cache: {cache} · watchlist: {watchlist} · AI: {ai}', {
        cache: cacheBackend || '—',
        watchlist: watchlistBackend || '—',
        ai: aiLabel,
      })
      return h(
        'div',
        { className: 'tm-status' },
        h(
          'button',
          { className: 'tm-status__pill', onClick: () => setOpen(!open), title: t('Data source status') },
          h('span', { className: 'tm-dot' + (healthy ? ' tm-dot--ok' : ' tm-dot--bad') }),
          t('{ready}/{total} sources ready', { ready: healthy, total: providers.length }),
        ),
        h('span', { className: 'tm-status__meta', title: metaText }, metaText),
        open
          ? h(
              'div',
              { className: 'tm-status__pop' },
              active.length ? h('div', { className: 'tm-status__chain' }, active.join(' → ')) : null,
              providers.map((p) =>
                h(
                  'div',
                  { key: p.id, className: 'tm-status__row' },
                  h('span', { className: 'tm-dot' + (p.healthy ? ' tm-dot--ok' : ' tm-dot--bad') }),
                  h('span', { className: 'tm-status__name' }, `${p.label || p.id} (${p.id})`),
                  h(
                    'span',
                    { className: 'tm-status__stats' },
                    t('ok {ok} / fail {fail}', { ok: p.successes, fail: p.failures }) +
                      (p.cooldownRemainingMs ? t(' · cooling {seconds}s', { seconds: Math.round(p.cooldownRemainingMs / 1000) }) : ''),
                  ),
                  p.lastError ? h('span', { className: 'tm-status__err' }, p.lastError) : null,
                ),
              ),
              h(
                'div',
                { className: 'tm-status__row' },
                h('span', { className: 'tm-status__name' }, t('Chains')),
                h(
                  'span',
                  { className: 'tm-status__stats tm-status__chains' },
                  Object.keys(chains).map((k) => `${k}: ${(chains[k] || {}).primary || '—'}`).join(' · ') || '—',
                ),
              ),
              h('div', { className: 'tm-status__foot' }, metaText),
            )
          : null,
      )
    }

    // ------------------------------------------------------------------ detail
    function AiAnalysisSection({ symbol, analysis, loading, error, onRun, aiAvailable, aiReason, question, setQuestion, dataQuality }) {
      const { t } = useT()
      // 0.8.0: the grades are fresh / delayed / stale / historical / unknown —
      // `fresh` means "recent", it is never presented as a live quote, and any
      // other grade has to be labelled right above the prose.
      const recencyNote = (() => {
        const grade = dataQuality && dataQuality.grade
        if (!grade || grade === 'fresh') return null
        if (grade === 'delayed') return t('This analysis is based on delayed data.')
        if (grade === 'unknown') return t('The age of the data behind this analysis could not be established.')
        return t('This analysis is based on the last available data, not a live quote.')
      })()
      return h(
        Card,
        {
          title: t('AI Analysis'),
          right: h(
            'div',
            { className: 'tm-card__tools' },
            h('button', { className: 'tm-btn', onClick: onRun, disabled: loading || !aiAvailable }, loading ? t('Analysing…') : t('Ask DeepSeek')),
          ),
        },
        !aiAvailable
          ? h(
              'div',
              { className: 'tm-hint' },
              t('DeepSeek is not available in this DSH session.'),
              aiReason ? h('div', { className: 'tm-hint__why' }, t('Reason: ') + aiReason) : null,
            )
          : null,
        h(
          'div',
          { className: 'tm-ask' },
          h('input', {
            className: 'tm-input',
            value: question,
            placeholder: t('Optional question — context (price, candles, indicators, timestamp) is attached automatically'),
            onChange: (event) => setQuestion(event.target.value),
          }),
        ),
        error ? h(ErrorNote, { error, onRetry: onRun }) : null,
        recencyNote ? h('div', { className: 'tm-note tm-note--warn' }, recencyNote) : null,
        loading ? h(Spinner, { label: t('DeepSeek is analysing {symbol}…', { symbol }) }) : null,
        analysis
          ? h(
              'div',
              { className: 'tm-ai' },
              h('p', { className: 'tm-ai__summary' }, analysis.summary),
              h(
                'div',
                { className: 'tm-grid' },
                h(Cell, { label: t('Trend · short term'), value: analysis.trend.shortTerm }),
                h(Cell, { label: t('Trend · medium term'), value: analysis.trend.mediumTerm }),
                h(Cell, { label: t('Trend · long term'), value: analysis.trend.longTerm }),
                h(Cell, { label: t('Momentum'), value: analysis.momentum }),
                h(Cell, { label: t('Volume'), value: analysis.volume }),
              ),
              h('h4', { className: 'tm-ai__h' }, t('Support')),
              analysis.supportLevels.length ? h('div', { className: 'tm-levels' }, analysis.supportLevels.map((v, i) => h('span', { key: i, className: 'tm-level tm-level--sup' }, plain(v)))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Resistance')),
              analysis.resistanceLevels.length ? h('div', { className: 'tm-levels' }, analysis.resistanceLevels.map((v, i) => h('span', { key: i, className: 'tm-level tm-level--res' }, plain(v)))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Risk Factors')),
              analysis.riskFactors.length ? h('ul', { className: 'tm-list tm-list--plain' }, analysis.riskFactors.map((line, i) => h('li', { key: i }, line))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
              h('h4', { className: 'tm-ai__h' }, t('Key Observations')),
              analysis.keyObservations.length ? h('ul', { className: 'tm-list tm-list--plain' }, analysis.keyObservations.map((line, i) => h('li', { key: i }, line))) : h('p', { className: 'tm-hint' }, t('Unavailable.')),
            )
          : h('div', { className: 'tm-hint' }, t('Ask DeepSeek for a structured read of the trend, momentum, volume, support/resistance and risk of this stock. Values are supplied by the system; DeepSeek never fetches market data.')),
      )
    }

    /**
     * §27/§31 technical grid, as label/value pairs. Kept as a pure function so
     * the field mapping can be tested without a browser or a live provider.
     * @param {any} tech the §31 technical block
     * @param {(text: string) => string} [t] translator (defaults to English)
     */
    function technicalCells(tech, t, price) {
      if (!tech) return []
      const tr = typeof t === 'function' ? t : makeT('en')
      // A live price turns the 52-week extremes into actionable distance: how
      // far above/below the current price sits, not just where the band is.
      const tail = (label) => (isNum(price) && isNum(label) && label > 0 ? ` · ${percent(price / label - 1)}` : '')
      return [
        { label: 'MA20', value: plain(tech.ma20), title: tr('20-day simple moving average') },
        { label: 'MA50', value: plain(tech.ma50) },
        { label: 'MA200', value: plain(tech.ma200) },
        { label: 'RSI14', value: plain(tech.rsi14, 2), title: tr('Relative Strength Index, 14 periods') },
        { label: 'MACD', value: plain(tech.macd, 3) },
        { label: tr('MACD Signal'), value: plain(tech.macdSignal, 3) },
        { label: tr('MACD Histogram'), value: plain(tech.macdHistogram, 3) },
        { label: 'ATR14', value: plain(tech.atr14, 3), title: tr('Average True Range, 14 periods') },
        { label: tr('Volume Ratio (20D)'), value: isNum(tech.volumeRatio20d) ? plain(tech.volumeRatio20d, 2) + '×' : '—' },
        { label: tr('Trend alignment'), value: tr(tech.trendAlignment || '—') },
        { label: tr('52W High'), value: isNum(tech.high52w) ? plain(tech.high52w) + tail(tech.high52w) : '—', title: tr('Distance to 52W High') },
        { label: tr('52W Low'), value: isNum(tech.low52w) ? plain(tech.low52w) + tail(tech.low52w) : '—', title: tr('Distance to 52W Low') },
        { label: 'MA5', value: plain(tech.ma5) },
        { label: 'MA10', value: plain(tech.ma10) },
        { label: 'MA60', value: plain(tech.ma60) },
        { label: 'EMA12', value: plain(tech.ema12) },
        { label: 'EMA26', value: plain(tech.ema26) },
        { label: tr('Avg volume 20D'), value: volumeText(tech.volumeAverage20d) },
        { label: tr('Volatility 20D (ann.)'), value: isNum(tech.volatility20dAnnualizedPct) ? plain(tech.volatility20dAnnualizedPct, 2) + '%' : '—' },
      ]
    }

    /** Whole days from `from` to `date` (`YYYY-MM-DD`); null when unparseable. */
    function daysBetween(date, from) {
      const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)
      const b = Date.parse(`${String(date).slice(0, 10)}T00:00:00Z`)
      if (!Number.isFinite(a) || !Number.isFinite(b)) return null
      return Math.round((b - a) / 86400000)
    }

    /** `2026-11-09` → `11/09`, the compact form used next to a price. */
    function monthDay(date) {
      const parts = String(date || '').slice(0, 10).split('-')
      return parts.length === 3 ? `${parts[1]}/${parts[2]}` : String(date || '')
    }

    function sessionLabel(session, t) {
      if (session === 'pre') return t('pre-market')
      if (session === 'post') return t('after close')
      return t('time not announced')
    }

    /** `2026-11-09` → `Mon` / `周一`, shown next to a compact date. */
    function weekdayLabel(date, lang) {
      const parsed = Date.parse(`${String(date || '').slice(0, 10)}T00:00:00Z`)
      if (!Number.isFinite(parsed)) return ''
      return new Date(parsed).toLocaleDateString(lang === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', timeZone: 'UTC' })
    }

    /**
     * "Next earnings" strip for the detail view. The calendar endpoint answers a
     * window of dates, so the symbol is looked up in `bySymbol`; a miss renders
     * nothing rather than an empty card.
     */
    function nextEarnings(windowData, symbol) {
      const event = windowData && windowData.bySymbol ? windowData.bySymbol[String(symbol).toUpperCase()] : null
      if (!event) return null
      const days = daysBetween(event.date, windowData.today || event.date)
      const when = days === null ? '' : days <= 0 ? t('today') : days === 1 ? t('tomorrow') : t('in {n} days', { n: days })
      const soon = days !== null && days >= 0 && days <= 7
      return h(
        'div',
        { className: 'tm-earn' + (soon ? ' tm-earn--soon' : '') },
        h('span', { className: 'tm-earn__label' }, t('Next earnings')),
        h('span', { className: 'tm-earn__date' }, `${monthDay(event.date)} ${sessionLabel(event.session, t)}`),
        when ? h('span', { className: 'tm-earn__when' }, when) : null,
        event.epsForecast == null ? null : h('span', { className: 'tm-earn__eps' }, `${t('EPS est.')} ${money(event.epsForecast, 'USD')}${event.analysts ? ` · ${t('{n} analysts', { n: event.analysts })}` : ''}`),
      )
    }

    function DetailView({ symbol, market, onBack, onOpen, aiAvailable, aiReason }) {
      const { ui, lang, t } = useT()
      const range = ui.range || '6mo'
      const [tv, setTv] = useState(ui.tv)
      const [analysis, setAnalysis] = useState(null)
      const [analysisError, setAnalysisError] = useState(null)
      const [analysisMeta, setAnalysisMeta] = useState(null)
      const [analysing, setAnalysing] = useState(false)
      const [question, setQuestion] = useState('')

      // Search → detail is the fastest way to reach a new symbol, so the detail
      // head carries its own add/remove toggle. State reads from the same list
      // endpoint the home cards use — the button mirrors what is stored, and a
      // flip reloads it, so two open windows agree.
      const tracked = useAsync((signal) => apiGet('/watchlist', signal), [])
      const trackedRows = (tracked.data && tracked.data.items) || []
      const owned = trackedRows.some((row) => row.symbol === symbol)
      const [watchBusy, setWatchBusy] = useState(false)
      const toggleWatch = () => {
        if (watchBusy) return
        setWatchBusy(true)
        const call = owned
          ? request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'DELETE' })
          : apiPost('/watchlist', { symbol, market: hint })
        call
          .then(() => tracked.reload())
          .catch(() => {}) // a failed add leaves the toggle unchanged; bands keep their own error notes
          .finally(() => setWatchBusy(false))
      }

      // 1.1: tags label the saved row ("核心仓"/"观察"). Editing mirrors the
      // add/remove flow: one PATCH replaces the whole set, then the list is
      // reloaded so an open card and the detail editor agree.
      const trackedRow = trackedRows.find((row) => row.symbol === symbol) || null
      const [tagDraft, setTagDraft] = useState('')
      const [tagsBusy, setTagsBusy] = useState(false)
      const currentTags = trackedRow && Array.isArray(trackedRow.tags) ? trackedRow.tags : []
      // 1.1: typing matches the vocabulary the owner already uses on other rows
      // (native datalist — no extra request, no positioning code). The row being
      // edited never suggests its own current labels.
      const knownTags = useMemo(() => {
        const used = new Set(currentTags)
        const seen = []
        for (const row of trackedRows) {
          for (const tag of Array.isArray(row.tags) ? row.tags : []) {
            if (typeof tag === 'string' && tag.trim() && !used.has(tag) && !seen.includes(tag)) seen.push(tag)
          }
        }
        return seen.slice(0, 12)
      }, [trackedRows, currentTags.join('|')])
      const commitTags = (next) => {
        if (tagsBusy) return
        setTagsBusy(true)
        setTagDraft('')
        request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'PATCH', body: { tags: next } })
          .then(() => tracked.reload())
          .catch(() => {})
          .finally(() => setTagsBusy(false))
      }

      // The market is a *resolution hint*: a bare `BTC` is also a plausible US
      // ticker, so the server must be told which book the symbol came from.
      const hint = market || marketOfSymbol(symbol)
      const qs = `?market=${encodeURIComponent(hint)}`
      const quote = useAsync((signal) => apiGet(`/quote/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      const profile = useAsync((signal) => apiGet(`/profile/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      // SEC EDGAR (US only, keyless). The route answers with an empty metric list
      // for tickers that file no XBRL company facts, so a failure here is only
      // ever a transport problem.
      const fundamentals = useAsync((signal) => apiGet(`/fundamentals/${encodeURIComponent(symbol)}`, signal), [symbol])
      const earnings = useAsync((signal) => apiGet('/earnings?days=21', signal), [symbol])
      const chart = useAsync(
        (signal) =>
          apiGet(
            `/candles/${encodeURIComponent(symbol)}?range=${range}&interval=${RANGE_INTERVAL[range] || '1d'}&market=${encodeURIComponent(hint)}`,
            signal,
          ),
        [symbol, range, hint],
      )

      useEffect(() => {
        setTv(ui.tv)
      }, [ui.tv])
      useEffect(() => {
        setAnalysis(null)
        setAnalysisError(null)
      }, [symbol, lang])
      // Escape is the keyboard exit from the detail view. It must ignore
      // keystrokes that a control already claimed (a text field, a composition
      // session) and never fire while the AI panel is busy being typed into.
      useEffect(() => {
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          const node = event.target
          const tag = (node && node.tagName) || ''
          if (event.defaultPrevented || (node && node.isContentEditable)) return
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
          if (typeof onBack === 'function') {
            event.preventDefault()
            onBack()
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onBack])

      // ←/→ walks the watchlist in stored order (wrapping both ends), so the
      // detail view doubles as a tile-by-tile scan of the holdings. Same guard
      // as Escape: fields, editable nodes and claimed events stay untouched.
      const detailedRows = trackedRows.map((row) => row.symbol)
      useEffect(() => {
        if (detailedRows.length < 2) return undefined
        const onWalk = (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          const node = event.target
          const tag = (node && node.tagName) || ''
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (node && node.isContentEditable)) return
          const index = detailedRows.indexOf(symbol)
          if (index < 0 || typeof onOpen !== 'function') return
          event.preventDefault()
          const next = detailedRows[(index + (event.key === 'ArrowRight' ? 1 : -1) + detailedRows.length) % detailedRows.length]
          const row = trackedRows.find((entry) => entry.symbol === next) || null
          onOpen({ symbol: next, market: (row && row.market) || market || null })
        }
        window.addEventListener('keydown', onWalk)
        return () => window.removeEventListener('keydown', onWalk)
      }, [detailedRows.join('|'), symbol, onOpen, market])

      const data = quote.data
      const company = profile.data || {}
      const title = quote.loading && !data ? symbol : nameOf(Object.assign({}, company, data, { symbol }), symbol)
      const technical = chart.data && chart.data.technical
      const tech = technical && technical.technical
      const levels = (technical && technical.levels) || null
      const bars = (chart.data && chart.data.data && chart.data.data.candles) || []
      const chartMeta = chart.data && chart.data.meta
      // 0.7.0: how much history the indicator block rests on.
      const quality = (chart.data && chart.data.technicalMeta && chart.data.technicalMeta.quality) || (technical && technical.quality) || null

      const runAnalysis = useCallback(() => {
        setAnalysing(true)
        setAnalysisError(null)
        apiPost(`/analyze/${encodeURIComponent(symbol)}`, { lang, market: hint, question: question.trim() || undefined })
          .then((value) => {
            // The route answers { symbol, analysis, meta }; tolerate a flattened
            // payload too so a future server change cannot blank the section.
            const result = value && value.analysis ? value.analysis : value && value.summary !== undefined ? value : null
            // 0.7.0: keep the recency verdict so the panel can label the answer.
            setAnalysisMeta(value && value.meta ? value.meta : null)
            setAnalysis(
              result || {
                summary: t('No summary was returned.'),
                trend: { shortTerm: t('Unavailable.'), mediumTerm: t('Unavailable.'), longTerm: t('Unavailable.') },
                momentum: t('Unavailable.'),
                volume: t('Unavailable.'),
                supportLevels: [],
                resistanceLevels: [],
                riskFactors: [],
                keyObservations: [],
              },
            )
          })
          .catch((error) => setAnalysisError(error))
          .then(() => setAnalysing(false))
      }, [symbol, question, lang, t])

      return h(
        'div',
        { className: 'tm-detail' },
        h(
          'div',
          { className: 'tm-detail__head' },
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: onBack }, h(Icon, { name: 'back' }), t('Back')),
          // Keyboard-only affordance hint. Touch devices get none of these
          // shortcuts, so the hint hides itself on them (hover:none in CSS).
          detailedRows.length >= 2
            ? h(
                'span',
                { className: 'tm-detail__keys', title: t('Walk the watchlist with ←/→ · Esc goes back') },
                h('span', { className: 'tm-detail__kbd' }, '←'),
                h('span', { className: 'tm-detail__kbd' }, '→'),
                h('span', { className: 'tm-detail__kbd' }, 'Esc'),
              )
            : null,
          h(
            'div',
            { className: 'tm-detail__id' },
            h('h2', { className: 'tm-detail__title' }, title),
            h(
              'div',
              { className: 'tm-detail__sub' },
              h('span', { className: 'tm-badge' }, symbol),
              company.exchange || (data && data.exchange) ? h('span', null, company.exchange || data.exchange) : null,
              h('span', null, (data && data.currency) || company.currency || ''),
              company.industry ? h('span', null, company.industry) : null,
            ),
          ),
          h(
            'div',
            { className: 'tm-detail__price' },
            h('span', { className: 'tm-detail__last ' + toneOf(data && data.price, data && data.previousClose) }, data ? money(data.price, data.currency) : '—'),
            h('span', { className: 'tm-detail__chg ' + trendClass(data && data.changePct) }, data ? `${signed(data.change, 2)}  ${percent(data.changePct)}` : t('Data unavailable')),
            h(Freshness, { data }),
          ),
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => { quote.reload(); profile.reload(); chart.reload() } }, h(Icon, { name: 'refresh' }), t('Refresh')),
          h(
            'button',
            {
              className: 'tm-btn' + (owned ? '' : ' tm-btn--active'),
              title: owned ? t('Remove from watchlist') : t('Add to watchlist'),
              disabled: watchBusy || !tracked.data,
              onClick: toggleWatch,
            },
            h(Icon, { name: 'star' }),
            owned ? t('Remove from watchlist') : t('Add to watchlist'),
          ),
          h('button', { className: 'tm-btn' + (tv ? ' tm-btn--active' : ''), onClick: () => { const next = !tv; setTv(next); setStore({ tv: next }) } }, 'TradingView'),
        ),
        h(SourcesRow, {
          record: Object.assign({}, company, data || {}, {
            symbol,
            market: (data && data.market) || company.market,
            exchange: company.exchange || (data && data.exchange),
          }),
        }),
        quote.error ? h(ErrorNote, { error: quote.error, onRetry: quote.reload }) : null,
        owned
          ? h(
              'div',
              { className: 'tm-detail__tags' },
              h('span', { className: 'tm-detail__tags-k' }, t('Tags')),
              currentTags.map((tag) =>
                h(
                  'span',
                  { className: 'tm-detail__tag', key: tag },
                  tag,
                  h(
                    'button',
                    { className: 'tm-detail__tag-x', title: t('Remove this tag'), tabIndex: tagsBusy ? -1 : 0, disabled: tagsBusy, onClick: () => commitTags(currentTags.filter((entry) => entry !== tag)) },
                    '×',
                  ),
                ),
              ),
              h('input', {
                className: 'tm-detail__tag-add',
                list: 'tm-tag-suggestions',
                value: tagDraft,
                placeholder: t('Add a tag (press Enter)'),
                disabled: tagsBusy || currentTags.length >= 8,
                onChange: (event) => setTagDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter' && tagDraft.trim()) commitTags([...currentTags, tagDraft.trim()])
                },
              }),
              h(
                'datalist',
                { id: 'tm-tag-suggestions' },
                knownTags.map((tag) => h('option', { key: tag, value: tag })),
              ),
            )
          : null,

        h(
          'div',
          { className: 'tm-ranges' },
          RANGES.map((key) =>
            h(
              'button',
              { key, className: 'tm-range' + (key === range ? ' tm-range--active' : ''), onClick: () => setStore({ range: key }) },
              RANGE_LABEL[key],
            ),
          ),
          chart.loading ? h('span', { className: 'tm-search__hint' }, t('loading bars…')) : null,
        ),
        h(Card, { title: t('Chart') }, chart.error ? h(ErrorNote, { error: chart.error, onRetry: chart.reload }) : null, h(CandleChart, { candles: bars, series: technical && technical.series, interval: chart.data && chart.data.data && chart.data.data.interval, degraded: Boolean(chartMeta && chartMeta.degraded) }), chartMeta ? h(Freshness, { meta: chartMeta, compact: true }) : null),
        nextEarnings(earnings.data, symbol),

        fundamentals.data && fundamentals.data.metrics.length
          ? h(
              Card,
              {
                title: t('Fundamentals (SEC EDGAR)'),
                right: fundamentals.data.filed
                  ? h('span', { className: 'tm-card__meta' }, `${t('as filed')} ${fundamentals.data.filed}${fundamentals.data.form ? ` · ${fundamentals.data.form}` : ''}`)
                  : null,
              },
              h(
                'div',
                { className: 'tm-fund' },
                fundamentals.data.metrics.map((metric) =>
                  h(
                    'div',
                    {
                      key: metric.key,
                      className: 'tm-fund__row',
                      title: `${metric.concept} · ${metric.period.end}${metric.period.form ? ` · ${metric.period.form}` : ''}${metric.annual ? ` · ${t('annual')}` : ` · ${t('quarter')}`}`,
                    },
                    h('span', { className: 'tm-fund__label' }, t(metric.label)),
                    h('span', { className: 'tm-fund__value' }, metric.unit === 'shares' ? volumeText(metric.value) : compactMoney(metric.value, 'USD')),
                    metric.yoy == null ? h('span', { className: 'tm-fund__yoy' }, '') : h('span', { className: 'tm-fund__yoy ' + trendClass(metric.yoy * 100) }, percent(metric.yoy * 100)),
                  ),
                ),
              ),
              h('div', { className: 'tm-fund__note' }, t('Source: SEC EDGAR company facts. Each row is the latest period of one kind — annual or quarterly — and the percentage is that same period a year earlier.')),
            )
          : fundamentals.error
            ? h(Card, { title: t('Fundamentals (SEC EDGAR)') }, h(ErrorNote, { error: fundamentals.error, onRetry: fundamentals.reload }))
            : null,

        tv
          ? h(
              Card,
              { title: t('TradingView (external embed)') },
              h('div', { className: 'tm-hint' }, t("Embedded third-party chart. Values shown here are TradingView's own and are not used by Trading Mode analytics.")),
              h('iframe', {
                className: 'tm-frame',
                src: `https://s.tradingview.com/widgetembed/?symbol=${encodeURIComponent(tradingViewSymbol(Object.assign({ symbol }, data, company)))}&interval=60&theme=light&style=1&hidesidetoolbar=0&locale=${lang}`,
                title: 'TradingView',
                allowFullScreen: true,
              }),
            )
          : null,

        h(
          'div',
          { className: 'tm-columns' },
          h(
            Card,
            { title: t('Market Data') },
            h(
              'div',
              { className: 'tm-grid' },
              h(Cell, { label: t('Open'), value: money(data && data.open, data && data.currency) }),
              h(Cell, { label: t('High'), value: money(data && data.high, data && data.currency) }),
              h(Cell, { label: t('Low'), value: money(data && data.low, data && data.currency) }),
              h(Cell, { label: t('Previous Close'), value: money(data && data.previousClose, data && data.currency) }),
              h(Cell, { label: t('Volume'), value: volumeText(data && data.volume) }),
              h(Cell, { label: t('Timestamp'), value: data ? dateTimeOf(data.timestamp) : '—' }),
              h(Cell, { label: t('Data source'), value: (data && data.source) || '—' }),
              h(Cell, { label: t('Freshness'), value: data ? ((quote.data && quote.data.stale) ? t('Last available data') : t('Data may be delayed')) : '—' }),
              company.marketCap ? h(Cell, { label: t('Market cap'), value: volumeText(company.marketCap), title: String(company.marketCap) }) : null,
              isNum(company.peRatio) ? h(Cell, { label: t('P/E'), value: plain(company.peRatio, 2) }) : null,
            ),
            company.description ? h('p', { className: 'tm-desc' }, company.description) : null,
          ),
          h(
            Card,
            { title: t('Technical Indicators') },
            quality && !quality.sufficient
              ? h(
                  'div',
                  { className: 'tm-note tm-note--warn' },
                  t('Not enough history for reliable indicators: only {n} daily bars are available (need {m}).').replace('{n}', String(quality.bars)).replace('{m}', String(quality.required)),
                )
              : quality && quality.grade && quality.grade !== 'full'
                ? h(
                    'div',
                    { className: 'tm-note' },
                    t('Limited history: {n} daily bars — long-term indicators (MA200, 52-week levels, 1-year change) are not reported.').replace('{n}', String(quality.bars)),
                  )
                : null,
            tech
              ? h(
                  'div',
                  { className: 'tm-grid' + (quality && !quality.sufficient ? ' tm-grid--muted' : '') },
                  technicalCells(tech, t, data.price).map((cell) => h(Cell, { key: cell.label, label: cell.label, value: cell.value, title: cell.title })),
                  // 1.1: a 4px position rail under the level numbers. Percent
                  // math stays presentation-only (the 52w cells keep the raw
                  // values), the bar simply shows where today's price sits
                  // inside the low…high band.
                  isNum(data.price) && isNum(tech.low52w) && isNum(tech.high52w) && tech.high52w > tech.low52w
                    ? (() => {
                        const span = tech.high52w - tech.low52w
                        const at = Math.max(0, Math.min(100, 100 * (data.price - tech.low52w) / span))
                        return h(
                          'div',
                          { className: 'tm-range', title: `${t('Where the price sits inside the 52-week range')}: ${Math.round(at)}%` },
                          h('span', { className: 'tm-range__track' },
                            h('span', { className: 'tm-range__fill' + (at >= 95 ? ' tm-range__fill--hot' : at <= 5 ? ' tm-range__fill--cold' : ''), style: { left: `${at}%` } }),
                          ),
                          h('span', { className: 'tm-range__lo' }, plain(tech.low52w)),
                          h('span', { className: 'tm-range__hi' }, plain(tech.high52w)),
                        )
                      })()
                    : null,
                )
              : chart.loading
                ? h(Spinner, { label: t('Computing indicators…') })
                : h(Empty, null, t('Data unavailable')),
            levels && (levels.support || levels.resistance)
              ? h(
                  'div',
                  { className: 'tm-levels-block' },
                  h('span', { className: 'tm-levels-block__k' }, t('Reference levels (system-computed)')),
                  h(
                    'div',
                    { className: 'tm-levels' },
                    (levels.support || []).slice(0, 3).map((v, i) => h('span', { key: 's' + i, className: 'tm-level tm-level--sup' }, plain(v))),
                    (levels.resistance || []).slice(0, 3).map((v, i) => h('span', { key: 'r' + i, className: 'tm-level tm-level--res' }, plain(v))),
                  ),
                )
              : null,
          ),
        ),

        h(AiAnalysisSection, {
          symbol,
          analysis,
          loading: analysing,
          error: analysisError,
          onRun: runAnalysis,
          aiAvailable,
          aiReason,
          question,
          setQuestion,
          dataQuality: (analysisMeta && analysisMeta.dataQuality) || null,
        }),
        h('p', { className: 'tm-disclaimer' }, DISCLAIMER_FALLBACK),
      )
    }

    /** `600519.SH` → `SSE`/`SZSE`/`BSE`; falls back to the record's exchange. */
    function cnVenue(record) {
      const symbol = String((record && record.symbol) || '').toUpperCase()
      const suffix = symbol.includes('.') ? symbol.split('.').pop() : ''
      if (suffix === 'SH') return 'SSE'
      if (suffix === 'SZ') return 'SZSE'
      if (suffix === 'BJ') return 'BSE'
      const exchange = String((record && record.exchange) || '').toUpperCase()
      if (exchange.includes('SSE') || exchange.includes('SHANGHAI')) return 'SSE'
      if (exchange.includes('SZSE') || exchange.includes('SHENZHEN')) return 'SZSE'
      if (exchange.includes('BSE') || exchange.includes('BEIJING')) return 'BSE'
      return 'SSE'
    }

    /** Eastmoney/Tencent/Sina dialect prefix of a mainland listing. */
    function cnPrefix(record) {
      const venue = cnVenue(record)
      return venue === 'SZSE' ? 'sz' : venue === 'BSE' ? 'bj' : 'sh'
    }

    function tradingViewSymbol(record) {
      const symbol = String((record && record.symbol) || '')
      const links = (record && record.links) || {}
      // Indices (and anything else the server already resolved) arrive with an
      // explicit chart dialect such as `TVC:VIX`, `NASDAQ:IXIC`, `HKEX:700`.
      if (links.tradingView) return String(links.tradingView)
      const exchange = String((record && record.exchange) || '').toUpperCase()
      const venue = exchange.includes('NASDAQ') ? 'NASDAQ' : exchange.includes('NYSE') ? 'NYSE' : exchange.includes('AMEX') ? 'AMEX' : 'NASDAQ'
      return venue + ':' + symbol
    }

    /** Zero-padded digit code of a symbol (`0700.HK` → `00700`). */
    function digitsOf(symbol, width) {
      const raw = String(symbol == null ? '' : symbol)
        .replace(/\.HK$/i, '')
        .replace(/\D/g, '')
      const value = parseInt(raw, 10)
      return isFinite(value) ? String(value).padStart(width, '0') : raw
    }

    /**
     * External "data source" pages (user request m01395).
     *
     * These are ordinary public web pages the user opens in a browser tab. Nothing
     * here is scraped: §8 forbids TradingView scraping, reverse-engineered
     * sockets and front-end calls to the market-data providers — it does not
     * forbid linking to a public quote page. We deliberately never embed these
     * pages as a data feed.
     *
     * Both pages answer 200 in a browser for US tickers and indices; they are
     * linked, never fetched.
     */
    /** The spelling Yahoo's quote page expects (identical for US tickers). */
    function yahooSymbol(record) {
      return String((record && record.symbol) || '')
    }

    function SOURCE_LINKS(record) {
      const symbol = String((record && record.symbol) || '').trim()
      if (!symbol) return []
      const links = (record && record.links) || {}
      // This build lists US equities and ETFs only, so the two pages that always
      // have a US listing — TradingView and Yahoo Finance — are the whole set.
      // They are ordinary public pages the user opens in a tab; nothing here is
      // scraped (§8 forbids embedding them as a feed, not linking to them).
      const out = [
        {
          id: 'tradingview',
          label: 'TradingView',
          href: 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(links.tradingView || tradingViewSymbol(record)),
        },
      ]
      const yahoo = links.yahoo || yahooSymbol(record)
      if (yahoo) {
        out.push({
          id: 'yahoo',
          label: 'Yahoo Finance',
          href: 'https://finance.yahoo.com/quote/' + encodeURIComponent(yahoo),
        })
      }
      return out
    }

    /** A row of "open the source page" links (§8-safe: links only, never scraping). */
    function SourcesRow({ record, label, compact }) {
      const { t } = useT()
      const links = SOURCE_LINKS(record)
      if (!links.length) return null
      return h(
        'div',
        { className: compact ? 'tm-sources tm-sources--compact' : 'tm-sources' },
        h('span', { className: 'tm-sources__label' }, label === undefined ? t('Data source pages') : label),
        links.map((link) =>
          h(
            'a',
            {
              key: link.id,
              className: 'tm-source',
              href: link.href,
              target: '_blank',
              rel: 'noopener noreferrer',
              title: t('Open {name} in a new tab', { name: link.label }),
            },
            link.label,
            h(Icon, { name: 'external', size: 12 }),
          ),
        ),
      )
    }

    /**
     * Market Overview strip (user request m01395, extended in 0.5.0 by m02818):
     * headline indices per market — VIX, Nasdaq Composite/100, S&P 500, Dow,
     * Hang Seng, HSCEI, Hang Seng TECH, plus the mainland and Tokyo benchmarks —
     * and, on its own tab, the crypto spotlight ranked by market cap.
     * Index levels are points, never presented as a tradable price (§21/§26);
     * crypto levels are spot prices and are labelled as such.
     */
    function MarketOverview({ onOpen, onAdd, owned, onBrowse }) {
      const { t } = useT()
      const [market, setMarket] = useState('US')
      const state = useAsync((signal) => apiGet(`/indices?market=${market}`, signal), [market])
      const data = state.data || {}
      const items = data.items || []
      const unavailable = data.unavailable || []
      const crypto = market === 'CRYPTO'

      return h(
        'section',
        { className: 'tm-card tm-card--overview' },
        h(
          'div',
          { className: 'tm-card__head' },
          h('h3', { className: 'tm-card__title' }, h(Icon, { name: 'globe', size: 14 }), crypto ? t('Crypto') : t('Market Overview')),
          h('span', { className: 'tm-card__meta' }, crypto ? t('Spot prices, 24/7 market') : t('Index levels, not tradable prices')),
          // The tiles are only the largest coins; the directory behind them holds
          // every coin CoinLore ranks, so the crypto tab offers the full list.
          crypto && onBrowse
            ? h(
                'button',
                { className: 'tm-btn tm-btn--ghost', onClick: () => onBrowse('CRYPTO') },
                h(Icon, { name: 'list', size: 13 }),
                t('All coins'),
              )
            : null,
          h('button', { className: 'tm-btn tm-btn--ghost', onClick: () => state.reload() }, h(Icon, { name: 'refresh' }), t('Refresh')),
        ),
        h(
          'div',
          { className: 'tm-chips', role: 'group', 'aria-label': t('Market') },
          MARKET_ORDER.map((m) =>
            h(
              'button',
              {
                key: m,
                className: 'tm-chip' + (market === m ? ' tm-chip--active' : ''),
                onClick: () => setMarket(m),
              },
              t(MARKET_LABEL_KEY[m]),
            ),
          ),
        ),
        state.loading && !items.length ? h(Spinner, { label: crypto ? t('Loading crypto prices…') : t('Loading indices…') }) : null,
        state.error ? h(ErrorNote, { error: state.error, onRetry: state.reload }) : null,
        items.length
          ? h(
              'div',
              { className: 'tm-indices' },
              items.map((item) =>
                h(IndexCell, { key: trackKey(Object.assign({}, item, { market: item.market || market })), item, onOpen, market, onAdd, owned }),
              ),
            )
          : null,
        unavailable.length
          ? h(
              'p',
              { className: 'tm-hint tm-hint--tiny' },
              t('Data unavailable for {symbols}', { symbols: unavailable.map((row) => row.symbol).join(', ') }),
            )
          : null,
      )
    }

    /** Index levels are not tradable; the detail view opens the closest listed ETF proxy instead. */
    const PROXY_ETF = {
      '^IXIC': 'QQQ',
      '^NDX': 'QQQ',
      '^GSPC': 'SPY',
      '^DJI': 'DIA',
      '^SOX': 'SMH',
      '^RUT': 'IWM',
      // ^VIX deliberately absent: no sensible spot proxy.
    }

    function IndexCell({ item, onOpen, market, onAdd, owned }) {
      const { lang, t } = useT()
      const quote = item.quote || {}
      const meta = item.meta || {}
      const name = lang === 'zh' ? item.nameZh || item.name : item.name
      const stale = Boolean(meta.stale || quote.stale)
      const crypto = market === 'CRYPTO'
      const record = Object.assign({}, item, { market: item.market || market })
      const tracked = Boolean(owned && typeof owned.has === 'function' && owned.has(trackKey(record)))
      // Index levels are not tradable, so the tile's main click opens the
      // closest listed proxy instead of a quote the detail view cannot load.
      // VIX has no sensible spot proxy and stays click-inert.
      const proxied = PROXY_ETF[String(item.symbol).toUpperCase()] || null
      const detail = proxied ? { symbol: proxied, market: 'US' } : Object.assign({}, item, { market: item.market || market })
      return h(
        'div',
        { className: 'tm-index' },
        h(
          'button',
          {
            className: 'tm-index__main',
            disabled: !proxied && market !== 'CRYPTO',
            onClick: () => onOpen(detail),
            title: proxied
              ? t('Index levels are not tradable; open the closest ETF ({symbol})', { symbol: proxied })
              : t('Open {name}', { name }),
          },
          h('span', { className: 'tm-index__name' }, name),
          h('span', { className: 'tm-index__symbol' }, item.symbol),
          h(
            'span',
            { className: 'tm-index__value' },
            crypto ? money(quote.price, quote.currency) : plain(quote.price, 2),
          ),
          h(
            'span',
            { className: 'tm-index__chg ' + trendClass(quote.changePct) },
            quote.changePct === undefined || quote.changePct === null
              ? '—'
              : `${signed(quote.change, 2)}  ${percent(quote.changePct)}`,
          ),
          h(
            'span',
            { className: 'tm-index__when' + (stale ? ' tm-index__stale' : '') },
            stale ? t('Last available data') : clockOf(quote.timestamp),
          ),
        ),
        h(
          'div',
          { className: 'tm-index__meta' },
          h(SourcesRow, {
            record: Object.assign({}, item, { market: quote.market || item.market || market }),
            compact: true,
            label: '',
          }),
          // A coin is only useful once it is on the watchlist, so the crypto tab
          // adds from the tile itself instead of sending the user back to search.
          crypto && onAdd
            ? h(
                'button',
                {
                  className: 'tm-index__add' + (tracked ? ' tm-index__add--on' : ''),
                  disabled: tracked,
                  title: tracked ? t('Already in your watchlist') : t('Add to watchlist'),
                  'aria-label': tracked ? t('Already in your watchlist') : t('Add to watchlist'),
                  onClick: () => (tracked ? undefined : onAdd(record)),
                },
                h(Icon, { name: tracked ? 'star' : 'plus', size: 12 }),
                tracked ? t('Added') : t('Add'),
              )
            : null,
        ),
      )
    }

    // -------------------------------------------------------------- home / app
    /**
     * 1.0.x event strip (goal: 大事件预警提醒). One row per date: which watchlist
     * symbol reports, when, in which session and with which EPS forecast — the
     * facts that change a hold/buy decision, lifted from the same host dataset
     * the rows already use (no new provider, no new secrets). Errors stay
     * silent: the watchlist card reports host problems already.
     */
    /**
     * 1.1: one glance line — every tracked symbol as a pill sorted from the
     * biggest gain to the biggest loss. Pure presentational reshuffle of rows
     * the card list already carries, so it costs no request and stays in sync
     * with the same quotes. Hidden when nothing quotable (fresh empty list).
     */
    /** Sector thermometer: eleven SPDR industry ETFs, one day change. */
    const SECTOR_TILES = [
      ['XLK', '科技'],
      ['XLC', '通信'],
      ['XLY', '可选消费'],
      ['XLP', '必需消费'],
      ['XLE', '能源'],
      ['XLF', '金融'],
      ['XLV', '医疗健康'],
      ['XLI', '工业'],
      ['XLU', '公用事业'],
      ['XLB', '原材料'],
      ['XLRE', '房地产'],
    ]

    function SectorHeatCard({ onOpen }) {
      const { t } = useT()
      const sectors = useAsync((signal) => apiGet('/quotes?symbols=' + SECTOR_TILES.map((tile) => tile[0]).join(','), signal), [])
      if (!sectors.data && sectors.loading) return null
      const quotes = Array.isArray(sectors.data) ? sectors.data : []
      const bySymbol = new Map(quotes.map((quote) => [quote.data ? quote.symbol : quote.symbol.toUpperCase(), quote]))
      const rows = SECTOR_TILES.map(([symbol, label]) => {
        const quote = bySymbol.get(symbol)
        return { symbol, label, quote: quote || null }
      }).filter((row) => row.quote && isNum(row.quote.data && row.quote.data.changePct))
      if (!rows.length && sectors.error) return null
      return h(
        Card,
        { title: t('Sector thermometer'), right: h('span', { className: 'tm-card__meta' }, t('Eleven SPDR sector ETFs, one day change')) },
        h(
          'div',
          { className: 'tm-card__body' },
          h(
            'div',
            { className: 'tm-sect' },
            rows.sort((a, b) => b.quote.data.changePct - a.quote.data.changePct).map((row) =>
              h(
                'button',
                {
                  key: row.symbol,
                  className: 'tm-sect__tile ' + trendClass(row.quote.data.changePct),
                  title: `${row.label} ${row.symbol} · ${percent(row.quote.data.changePct)}`,
                  onClick: () => onOpen({ symbol: row.symbol, market: 'US' }),
                },
                h('span', { className: 'tm-sect__name' }, row.label),
                h('span', { className: 'tm-sect__sym' }, row.symbol),
                h('span', { className: 'tm-sect__pct' }, percent(row.quote.data.changePct)),
              ),
            ),
          ),
          rows.length ? null : h('div', { className: 'tm-hint' }, t('Sector quotes unavailable')),
        ),
      )
    }

    function HeatStrip({ rows, onOpen }) {
      const { t } = useT()
      const heat = rows
        .filter((row) => row.quote && isNum(row.quote.changePct) && row.quote.changePct !== 0)
        .sort((a, b) => b.quote.changePct - a.quote.changePct)
      if (heat.length < 3) return null
      return h(
        'div',
        { className: 'tm-heat' },
        h('span', { className: 'tm-heat__k' }, t('Watchlist heat')),
        heat.map((row) =>
          h(
            'button',
            {
              key: row.symbol,
              className: 'tm-heat__chip ' + trendClass(row.quote.changePct),
              title: `${nameOf(row, row.symbol)} · ${percent(row.quote.changePct)}`,
              onClick: () => onOpen(row),
            },
            row.symbol,
            ' ',
            h('span', { className: 'tm-heat__pct' }, percent(row.quote.changePct)),
          ),
        ),
      )
    }

    function EarningsDueCard({ onOpen }) {
      const { t, lang } = useT()
      // The window choice sticks across refreshes, same contract as the
      // watchlist sort: a bad or missing value just falls back to 30.
      const [days, setDays] = useState(() => {
        try {
          const stored = Number(window.localStorage.getItem('tm-events-window'))
          return stored === 7 || stored === 30 ? stored : 30
        } catch {
          return 30
        }
      })
      useEffect(() => {
        try {
          window.localStorage.setItem('tm-events-window', String(days))
        } catch {
          /* file:// sandboxes deny storage; the chip must still toggle */
        }
      }, [days])
      const [query, setQuery] = useState('')
      const earnings = useAsync((signal) => apiGet('/earnings?days=30', signal), [])
      if (earnings.error) return null
      const bySymbol = (earnings.data && earnings.data.bySymbol) || {}
      const today = (earnings.data && earnings.data.today) || new Date().toISOString().slice(0, 10)
      const needle = query.trim().toUpperCase()
      const events = Object.entries(bySymbol)
        .map(([symbol, event]) => ({ symbol, date: event.date, session: event.session, epsForecast: event.epsForecast, days: daysBetween(event.date, today) }))
        .filter((event) => event.days !== null && event.days >= 0 && event.days <= 30)
        .filter((event) => event.days <= days)
        .filter((event) => !needle || event.symbol.toUpperCase().includes(needle))
        .sort((a, b) => a.days - b.days)
      const soon = events.filter((event) => event.days <= 7).length
      return h(
        Card,
        {
          title: [Icon({ name: 'calendar', size: 14 }), t('Event reminders')],
          className: 'tm-card--earnings-due',
        },
        earnings.loading
          ? h(Spinner)
          : events.length
            ? h(
                'div',
                { className: 'tm-events' },
                h('div', { className: 'tm-events__controls' }, [
                  h('div', { key: 'chips', className: 'tm-events__chips' }, [7, 30].map((option) =>
                    h(
                      'button',
                      { key: option, type: 'button', className: 'tm-chip' + (days === option ? ' tm-chip--active' : ''), onClick: () => setDays(option) },
                      t('{n}d window', { n: option }),
                    ),
                  )),
                  h('input', {
                    key: 'filter',
                    className: 'tm-events__filter',
                    type: 'search',
                    value: query,
                    placeholder: t('Filter by symbol'),
                    spellCheck: false,
                    onChange: (event) => setQuery(String(event.target.value || '')),
                  }),
                  h('span', { key: 'count', className: 'tm-events__meta', 'aria-hidden': 'true' }, t('{n} events in the next {days} days', { n: soon || events.length, days })),
                ]),
                h(
                  'div',
                  { className: 'tm-events__list' },
                  // 1.1: when the window spreads across weeks, a quiet bucket
                  // header keeps "which print lands when" readable at a glance.
                  // One bucket only (≤7d chip) renders flat exactly as before.
                  (() => {
                    const shown = events.slice(0, 12)
                    const bucketOf = (event) => (event.days <= 7 ? 0 : event.days <= 14 ? 1 : 2)
                    const spread = shown.length > 3 && new Set(shown.map(bucketOf)).size > 1
                    const labels = [t('This week'), t('Next week'), t('Later')]
                    const rows = []
                    let lastBucket = -1
                    for (const event of shown) {
                      const bucket = bucketOf(event)
                      if (spread && bucket !== lastBucket) {
                        rows.push(h('div', { key: `bucket:${bucket}`, className: 'tm-events__group', 'aria-hidden': 'true' }, labels[bucket]))
                      }
                      lastBucket = bucket
                      rows.push(
                    h(
                      'button',
                      {
                        key: `${event.symbol}:${event.date}`,
                        type: 'button',
                        className: 'tm-events__row' + (event.days <= 7 ? ' tm-events__row--soon' : '') + (event.days === 0 ? ' tm-events__row--today' : ''),
                        title: `${event.symbol} · ${event.date}${event.epsForecast == null ? '' : ` · ${t('EPS est.')} ${money(event.epsForecast, 'USD')}`}`,
                        onClick: () => onOpen && onOpen({ symbol: event.symbol, market: 'US' }),
                      },
                      h('span', { className: 'tm-events__sym' }, event.symbol),
                      h('span', { className: 'tm-events__date' }, `${monthDay(event.date)} · ${weekdayLabel(event.date, lang)}`),
                      event.days <= 7 ? h('span', { className: 'tm-events__session' }, sessionLabel(event.session, t)) : null,
                      event.epsForecast != null ? h('span', { className: 'tm-events__eps' }, `${t('EPS est.')} ${money(event.epsForecast, 'USD')}`) : null,
                      h('span', { className: 'tm-events__days' + (event.days <= 7 ? ' tm-events__days--soon' : '') }, event.days === 0 ? t('earnings today') : event.days === 1 ? t('earnings tomorrow') : t('earnings {n}d', { n: event.days })),
                      ),
                    )
                    }
                    return rows
                  })(),
                ),
                h('div', { className: 'tm-events__hint' }, t('Earnings dates change hold and entry decisions; check them again the day before.')),
              )
            : h('div', { className: 'tm-hint' }, t('No earnings on the watchlist within the window.')),
      )
    }
    function HomeView({ onOpen }) {
      const { ui, lang, t } = useT()
      const [brief, setBrief] = useState(null)
      // 1.1: the day's sector board the brief was read against (echoed in the
      // route's meta); shown under the headline so the reader sees the context.
      const [briefSectors, setBriefSectors] = useState(null)
      // Which market the listing browser opens on. The crypto tab points it at
      // CRYPTO so "全部币种" lands on the coin directory instead of the US one.
      // The last viewed market is restored on load and written on every change,
      // same localStorage contract as the watchlist sort.
      const [browseMarket, setBrowseMarket] = useState(() => {
        try {
          const stored = String(window.localStorage.getItem('tm-browse-market') || '')
          return stored === 'US' || stored === 'CRYPTO' ? stored : 'US'
        } catch {
          return 'US'
        }
      })
      const [briefError, setBriefError] = useState(null)
      const [briefLoading, setBriefLoading] = useState(false)
      const bootstrap = useAsync((signal) => apiGet('/bootstrap', signal), [])

      const data = bootstrap.data || {}
      const rows = data.items || []
      const aiAvailable = Boolean(data.ai && data.ai.available)
      const aiReason = (data.ai && data.ai.reason) || null
      const owned = useMemo(() => new Set(rows.map((row) => trackKey(row))), [rows])

      const reload = useCallback(() => bootstrap.reload(), [bootstrap])

      // The host keeps the language preference, so a fresh browser (or another
      // machine) opens the panel in the language the user last chose.
      useEffect(() => {
        if (bootstrap.data && bootstrap.data.settings) applyServerLang(bootstrap.data.settings)
      }, [bootstrap.data])

      // Duplicate the sort/events-window contract for the listing browser: the
      // market the user browsed last is where the browser reopens.
      useEffect(() => {
        try {
          window.localStorage.setItem('tm-browse-market', browseMarket)
        } catch {
          /* storage may be denied; the tab still works, it just forgets */
        }
      }, [browseMarket])

      const addSymbol = useCallback(
        (record) => {
          const symbol = typeof record === 'string' ? record : record && record.symbol
          if (!symbol) return
          apiPost('/watchlist', { symbol, market: record && record.market })
            .then(() => {
              // The search panel and the listing browser both stay open, so a
              // batch can be added; the host reload turns the row into "Added".
              reload()
            })
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const removeSymbol = useCallback(
        (symbol) => {
          request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'DELETE' })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const favourite = useCallback(
        (symbol, isFavorite) => {
          request(`${'/watchlist/'}${encodeURIComponent(symbol)}`, { method: 'PATCH', body: { isFavorite } })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [reload],
      )

      const move = useCallback(
        (from, to) => {
          const symbols = rows.map((row) => row.symbol)
          if (to < 0 || to >= symbols.length) return
          const next = symbols.slice()
          const [moved] = next.splice(from, 1)
          next.splice(to, 0, moved)
          request('/watchlist/order', { method: 'PATCH', body: { symbols: next } })
            .then(() => reload())
            .catch((error) => setBriefError(error))
        },
        [rows, reload],
      )

      const runBrief = useCallback(() => {
        setBriefLoading(true)
        setBriefError(null)
        apiPost('/watchlist/analyze', { lang })
          .then((value) => {
            // The route answers { brief, meta }; tolerate a flattened payload too.
            setBrief(value && value.brief ? value.brief : value && value.headline !== undefined ? value : null)
            setBriefSectors(value && value.meta && Array.isArray(value.meta.sectors) ? value.meta.sectors : null)
            // The brief card sits below the watchlist; after generating, bring
            // the fresh answer into view instead of leaving the reader at the
            // button they pressed. The skeleton is already feedback, so the
            // scroll only fires once the answer lands.
            const card = document.getElementById('tm-brief-card')
            if (card && card.scrollIntoView) card.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          })
          .catch((error) => setBriefError(error))
          .then(() => setBriefLoading(false))
      }, [lang])

      return h(
        'div',
        { className: 'tm-home' },
        h(SearchBox, { onOpen, onAdd: addSymbol, owned, rows }),
        h(ErrorNote, { error: bootstrap.error, onRetry: reload }),
        h(EarningsDueCard, { onOpen }),
        h(HeatStrip, { rows, onOpen }),
        h(SectorHeatCard, { onOpen }),
        h(WatchlistCard, {
          rows,
          loading: bootstrap.loading,
          error: null,
          onOpen,
          onRemove: removeSymbol,
          onFavorite: favourite,
          onMove: move,
          onRefresh: reload,
          browseMode: ui.browseMode,
          onToggleBrowse: () => setStore({ browseMode: !ui.browseMode }),
          identity: data.identity || null,
        }),
        h(MarketOverview, {
          onOpen,
          onAdd: addSymbol,
          owned,
          onBrowse: (target) => {
            setBrowseMarket(target || 'US')
            setStore({ browseMode: true })
          },
        }),
        ui.browseMode
          ? h(
              Card,
              {
                title: t('Browse all US listings'),
                right: h('span', { className: 'tm-hint tm-hint--tiny' }, t('Everything listed on NASDAQ, NYSE and AMEX')),
              },
              h(UniverseBrowser, { onAdd: addSymbol, onOpen, owned, initialMarket: browseMarket }),
            )
          : null,
        rows.length ? null : h(StarterPool, { recommendations: data.recommendations, onAdd: addSymbol, onOpen }),
        h(BriefCard, {
          brief,
          sectors: briefSectors,
          onRun: runBrief,
          loading: briefLoading,
          error: briefError,
          aiAvailable,
          aiReason,
          onOpen,
        }),
        h('p', { className: 'tm-hint tm-hint--tiny' }, t('Market data providers: {chains}', {
          // One readable line per market ("US: yahoo · HK: yahoo · …"); the raw
          // chains payload used to be dumped here as JSON, which read as garbage.
          chains: Object.keys((data.status && data.status.chains) || {})
            .map((k) => `${k}: ${(((data.status.chains || {})[k] || {}).primary) || '—'}`)
            .join(' · '),
        })),
      )
    }

    /**
     * The Trading Mode main panel. The host mounts this when the sidebar row with
     * the same id is selected, so the page is reachable before any conversation
     * exists — the sidebar row, not the session header, is now the primary entry.
     */
    function TradingApp() {
      const { ui, t } = useT()
      const [statusForAi, setStatusForAi] = useState(null)

      useEffect(() => {
        if (statusForAi) return undefined
        let alive = true
        apiGet('/status')
          .then((value) => {
            if (!alive) return
            setStatusForAi(value)
            if (value && value.settings) applyServerLang(value.settings)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [statusForAi])

      const aiAvailable = Boolean(statusForAi && statusForAi.ai && statusForAi.ai.available)
      const aiReason = (statusForAi && statusForAi.ai && statusForAi.ai.reason) || null

      // Every card hands this the same shape ({symbol, market}), so the detail
      // step can be reused by the keyboard navigation inside the detail view too.
      const openDetail = (target) => {
        const record = typeof target === 'string' ? { symbol: target } : target || {}
        if (!record.symbol) return
        setStore({ view: 'detail', symbol: record.symbol, symbolMarket: record.market || null })
      }

      return h(
        'section',
        { className: 'tm-page tm-scheme--' + effectiveTheme(ui), role: 'region', 'aria-label': 'DSH Trading Mode' },
        h(
          'header',
          { className: 'tm-header' },
          h('span', { className: 'tm-header__brand' }, h(Icon, { name: 'chart' }), 'DSH Trading Mode'),
          h(
            'nav',
            { className: 'tm-tabs' },
            h('button', { className: 'tm-tab' + (ui.view === 'home' ? ' tm-tab--active' : ''), onClick: () => setStore({ view: 'home' }) }, t('Home')),
            ui.symbol
              ? h('button', { className: 'tm-tab' + (ui.view === 'detail' ? ' tm-tab--active' : ''), onClick: () => setStore({ view: 'detail' }) }, ui.symbol)
              : null,
          ),
          h(StatusStrip, {
            // The /status payload is already flat (providers/chains sit at the top
            // level), so pass the payload itself — reading `.status` yielded
            // undefined and the strip rendered "0/0 sources ready".
            status: statusForAi || null,
            ai: statusForAi && statusForAi.ai,
            watchlistBackend: statusForAi && statusForAi.watchlist && statusForAi.watchlist.backend,
            cacheBackend: statusForAi && statusForAi.config && statusForAi.config.cacheBackend,
          }),
          h('div', { className: 'tm-header__tail' }, h(ThemeToggle), h(LangToggle)),
        ),
        h(
          'div',
          { className: 'tm-body' },
          ui.view === 'detail' && ui.symbol
            ? h(DetailView, { symbol: ui.symbol, market: ui.symbolMarket || null, onBack: () => setStore({ view: 'home' }), aiAvailable, aiReason, onOpen: openDetail })
            : h(HomeView, { onOpen: openDetail }),
        ),
        h(
          'footer',
          { className: 'tm-footer' },
          h('span', null, t('Market research only — no order routing, no brokerage connection. Market data may be delayed.')),
          h('span', null, t('AI output is generated from system-supplied structured data; it is not financial advice.')),
        ),
      )
    }

    // The sidebar row and its main panel share this id: the host sidebar resolves
    // the row's id to the panel key it selects. Order 2 keeps the row directly
    // below the shipped 插件市场 row (order 1) and above 自动化任务 (order 10), so
    // it stays visible without scrolling even when the window is short.
    const PANEL_ID = 'trading-mode'
    const SIDEBAR_ORDER = 2

    /** Sidebar row glyph; the host passes the size its navigation uses. */
    function TradingNavIcon({ size }) {
      return h(Icon, { name: 'chart', size: typeof size === 'number' && size > 0 ? size : 16 })
    }

    // -------------------------------------------------------------------- css
    const CSS = `
      /* Theme (user request m11109). The panel paints every surface from its OWN
         opaque palette instead of the host alias tokens: a custom DSH theme (or
         a portal mounted outside the themed subtree) can leave
         \`--dsw-alias-bg-overlay\` undefined, and \`var(--token, fallback)\` is
         then invalid at computed-value time — the declaration loses the property
         entirely, so the panel turns transparent instead of falling back.
         Literal colours cannot fail that way, which is what keeps the panel
         opaque. \`.tm-scheme--dark\` = white on black (default),
         \`.tm-scheme--light\` = black on white. */
      .tm-page { --tm-bg: #000000; --tm-surface: #0c0c0f; --tm-surface-2: #191920; --tm-overlay: #111116; --tm-text: #ffffff; --tm-text-dim: #b6b6c2; --tm-border-1: #26262e; --tm-border-2: #3a3a46; --tm-brand: #4b8bf5; --tm-up: #35c98a; --tm-down: #ff6b5e; --tm-up-ink: #6fd0a0; --tm-down-ink: #eba294; --tm-up-soft: rgba(53,201,138,.16); --tm-down-soft: rgba(255,107,94,.16); --tm-warn: #e3b341; --tm-err: #e0836f; --tm-ma20: #e0b64a; --tm-ma50: #5aa7e0; --tm-ma200: #b07de0; --tm-vol: rgba(120,130,150,.28); --tm-vol-up: rgba(53,201,138,.35); --tm-tile: #1a1a21; --tm-hover: rgba(255,255,255,.055); --tm-shadow: 0 1px 2px rgba(0,0,0,.45); --tm-shadow-pop: 0 18px 44px rgba(0,0,0,.6); --tm-focus: rgba(75,139,245,.22); --tm-btn-bg: #1b1b22; }
      .tm-page.tm-scheme--light { --tm-bg: #f4f4f8; --tm-surface: #ffffff; --tm-surface-2: #e8e8ef; --tm-overlay: #ffffff; --tm-text: #101014; --tm-text-dim: #55555f; --tm-border-1: #e1e1e8; --tm-border-2: #c5c5d0; --tm-brand: #2563eb; --tm-up: #0f7a4d; --tm-down: #c02a1e; --tm-up-ink: #0b5c3a; --tm-down-ink: #9c2519; --tm-up-soft: rgba(15,122,77,.12); --tm-down-soft: rgba(192,42,30,.12); --tm-warn: #8a6400; --tm-err: #b02a1c; --tm-ma20: #9a7b00; --tm-ma50: #1f6fb2; --tm-ma200: #7a45b5; --tm-vol: rgba(90,100,120,.22); --tm-vol-up: rgba(15,122,77,.28); --tm-tile: #f6f6f9; --tm-hover: rgba(16,16,20,.05); --tm-shadow: 0 1px 2px rgba(16,16,20,.05), 0 2px 8px rgba(16,16,20,.04); --tm-shadow-pop: 0 18px 40px rgba(16,16,20,.14), 0 2px 8px rgba(16,16,20,.05); --tm-focus: rgba(37,99,235,.13); --tm-btn-bg: #ffffff; }
      /* Point the host alias names at the panel palette so every rule below
         follows the scheme without a second set of values. */
      .tm-page { --dsw-alias-bg-base: var(--tm-bg); --dsw-alias-bg-layer-1: var(--tm-surface); --dsw-alias-bg-layer-2: var(--tm-surface-2); --dsw-alias-bg-overlay: var(--tm-overlay); --dsw-alias-label-primary: var(--tm-text); --dsw-alias-label-secondary: var(--tm-text-dim); --dsw-alias-border-l1: var(--tm-border-1); --dsw-alias-border-l2: var(--tm-border-2); --dsw-alias-brand-primary: var(--tm-brand); --dsw-alias-brand: var(--tm-brand); --dsw-alias-layer-1: var(--tm-surface); --dsw-alias-layer-2: var(--tm-surface-2); --dsw-alias-text-muted: var(--tm-text-dim); --dsw-alias-state-warn-primary: var(--tm-warn); }

      .tm-themes { display: inline-flex; border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 999px; overflow: hidden; }
      .tm-thm { border: 0; background: transparent; color: var(--tm-text-dim, #b6b6c2); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; line-height: 1.6; }
      .tm-thm + .tm-thm { border-left: 1px solid var(--tm-border-1, #26262e); }
      .tm-thm:hover { background: var(--tm-hover, #191920); color: var(--tm-text, #ffffff); }
      .tm-thm--active { background: var(--tm-brand, #4b8bf5); color: #fff; }

      .tm-page { box-sizing: border-box; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--tm-bg, #000000); color: var(--tm-text, #ffffff); }
      .tm-header { position: relative; z-index: 40; flex: 0 0 auto; display: grid; grid-template-columns: auto 1fr auto; grid-template-areas: 'brand tabs tail' 'status status status'; align-items: center; gap: 8px 12px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #262626); background: var(--dsw-alias-bg-layer-1, #161616); }
      .tm-header__brand { grid-area: brand; display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 13px; white-space: nowrap; }
      .tm-header__tail { grid-area: tail; display: flex; align-items: center; gap: 8px; justify-self: end; }
      .tm-tabs { grid-area: tabs; display: flex; flex-wrap: wrap; gap: 4px; }
      .tm-tab { border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
      .tm-tab:hover { background: var(--tm-hover, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-tab--active { background: var(--tm-tile, #1a1a21); color: var(--dsw-alias-label-primary, #eee); border-color: var(--tm-border-1, #333); }
      .tm-body { flex: 1 1 auto; min-height: 0; width: 100%; max-width: 1180px; margin: 0 auto; box-sizing: border-box; overflow: auto; padding: 18px 20px 30px; display: flex; flex-direction: column; gap: 14px; }
      .tm-footer { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; padding: 7px 14px; border-top: 1px solid var(--dsw-alias-border-l1, #262626); font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); background: var(--dsw-alias-bg-layer-1, #161616); }

      .tm-langs { display: inline-flex; border: 1px solid var(--dsw-alias-border-l2, #343434); border-radius: 999px; overflow: hidden; }
      .tm-lang { border: 0; background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; line-height: 1.6; }
      .tm-lang + .tm-lang { border-left: 1px solid var(--dsw-alias-border-l1, #2b2b2b); }
      .tm-lang:hover { background: var(--tm-hover, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-lang--active { background: var(--dsw-alias-brand-primary, #4b8bf5); color: #fff; }

      .tm-card { border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #171717); box-shadow: var(--tm-shadow, 0 1px 2px rgba(0,0,0,.28)); }
      .tm-card__head { display: flex; align-items: center; gap: 8px; min-height: 40px; box-sizing: border-box; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #242424); }
      .tm-card__title { margin: 0; display: inline-flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
      .tm-card__title svg { flex: 0 0 auto; }
      .tm-card__tools { display: flex; gap: 6px; margin-left: auto; }
      .tm-card__meta { margin-left: auto; }
      .tm-card__body { padding: 12px 14px; }
      .tm-card--watchlist .tm-card__body { padding: 8px 8px 10px; }
      .tm-card__meta { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      /* HomeView stacks every section; without this the cards butt together
         (the .tm-body gap only applies to its single child). */
      .tm-home { display: flex; flex-direction: column; gap: 14px; }

      .tm-indices { display: grid; grid-template-columns: repeat(auto-fit, minmax(172px, 1fr)); gap: 8px; padding: 10px 14px 14px; align-items: stretch; }
      .tm-index { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1, #262626); border-radius: 10px; background: var(--tm-tile, #1c1c1c); }
      .tm-index__main { display: grid; grid-template-columns: 1fr auto; grid-template-areas: 'name name' 'value chg' 'symbol when'; align-items: baseline; column-gap: 8px; row-gap: 2px; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .tm-index__name { grid-area: name; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-index__symbol { grid-area: symbol; font-size: 10px; letter-spacing: .02em; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-index__value { grid-area: value; font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .tm-index__chg { grid-area: chg; font-size: 11.5px; text-align: right; font-variant-numeric: tabular-nums; }
      .tm-index__when { grid-area: when; text-align: right; font-size: 10px; color: var(--dsw-alias-label-secondary, #8f8f8f); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .tm-index__meta { margin-top: auto; display: flex; align-items: flex-start; gap: 8px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1, #262626); font-size: 10px; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-index__meta .tm-sources { flex: 1 1 auto; justify-content: flex-start; gap: 4px 10px; flex-wrap: wrap; }
      .tm-index__meta .tm-sources__label { display: none; }
      .tm-index__meta .tm-source { padding: 0; border: 0; border-radius: 0; font-size: 10px; gap: 2px; white-space: nowrap; }
      .tm-index__meta .tm-source svg { display: none; }
      .tm-index__meta .tm-source:hover { border: 0; text-decoration: underline; }
      .tm-index__stale { color: var(--dsw-alias-state-warn-primary, #e3b341); }
.tm-index__add { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; padding: 1px 6px; font-size: 10px; line-height: 1.5; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1, #333); background: transparent; color: var(--dsw-alias-label-secondary, #8f8f8f); cursor: pointer; }
.tm-index__add:hover:not(:disabled) { color: var(--dsw-alias-brand-primary, #4c8dff); border-color: var(--dsw-alias-brand-primary, #4c8dff); }
.tm-index__add--on:disabled { color: var(--dsw-alias-state-warn-primary, #e3b341); border-color: transparent; cursor: default; opacity: .9; }
      /* 1.0.x event strip (goal: 大事件预警): one date per row, whole week tinted. */
      .tm-events { display: flex; flex-direction: column; gap: 6px; }
      .tm-events__meta { display: flex; align-items: baseline; gap: 8px; }
      .tm-events__title { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-events__list { display: flex; flex-direction: column; gap: 4px; }
      .tm-events__group { margin: 6px 0 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-events__group:first-child { margin-top: 0; }
      .tm-list__group { display: block; padding: 8px 8px 2px; margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-list__group:first-child { padding-top: 2px; }
      .tm-events__row { display: flex; align-items: baseline; gap: 10px; width: 100%; padding: 6px 8px; border: 1px solid var(--dsw-alias-border-l1, #262626); border-radius: 8px; background: var(--tm-tile, #1d1d1d); font: inherit; text-align: left; cursor: pointer; }
      .tm-events__row:hover { background: var(--tm-hover, rgba(255,255,255,.08)); border-color: var(--dsw-alias-border-l2, #3a3a3a); }
      .tm-events__row--today { border-color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-events__row--today .tm-events__days--soon { color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-events__date { min-width: 96px; white-space: nowrap; }
      .tm-events__controls { display: flex; align-items: center; gap: 8px; justify-content: space-between; margin-bottom: 6px; }
      .tm-events__filter { width: 148px; padding: 4px 9px; border: 1px solid var(--tm-border-1); border-radius: 8px; background: var(--tm-tile); color: var(--tm-fg); font: inherit; font-size: 12px; outline: none; }
      .tm-events__filter::placeholder { color: var(--tm-muted); }
      .tm-events__filter:focus { border-color: var(--tm-brand); box-shadow: 0 0 0 3px var(--tm-focus); }
      .tm-events__chips { display: inline-flex; gap: 6px; }
      .tm-events__controls .tm-events__meta { margin: 0; }
      .tm-events__row--soon { border-color: #c9a227; background: rgba(201, 162, 39, .08); }
      .tm-events__sym { font-weight: 600; font-size: 12.5px; }
      .tm-events__date { font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11.5px; }
      .tm-events__session, .tm-events__eps { color: var(--dsw-alias-label-secondary, #9a9a9a); font-size: 11.5px; margin-right: 8px; }
      .tm-events__days { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-events__days--soon { color: #c9a227; font-weight: 600; }
      .tm-events__hint { margin: 2px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      /* Next-earnings strip: a single line under the chart, tinted when close. */
      .tm-earn { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 10px; background: var(--tm-tile, rgba(0,0,0,0)); font-size: 12px; }
      .tm-earn--soon { border-color: #c9a227; background: rgba(201, 162, 39, 0.08); }
      .tm-earn__label { font-size: 11px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-earn__date { font-weight: 600; font-variant-numeric: tabular-nums; }
      .tm-earn__when { color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-earn__eps { margin-left: auto; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9a9a9a); font-variant-numeric: tabular-nums; }
      .tm-row__flag--earn { color: #b8862f; border-color: rgba(201, 162, 39, 0.45); }

      /* SEC fundamentals: two dense columns of label / value / year-ago growth. */
      .tm-fund { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 26px; }
      .tm-fund__row { display: grid; grid-template-columns: minmax(0, 1fr) auto 72px; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--dsw-alias-border-l1, #2a2a2a); }
      .tm-fund__row:last-child, .tm-fund__row:nth-last-child(2):nth-child(odd) { border-bottom: none; }
      .tm-fund__label { font-size: 12px; color: var(--dsw-alias-label-secondary, #9a9a9a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-fund__value { font-size: 13px; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; }
      .tm-fund__yoy { font-size: 11.5px; text-align: right; font-variant-numeric: tabular-nums; }
      .tm-fund__note { margin-top: 10px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #7f7f7f); }
      @media (max-width: 820px) { .tm-fund { grid-template-columns: minmax(0, 1fr); } }
      .tm-sources { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
      .tm-sources__label { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-source { display: inline-flex; align-items: center; gap: 3px; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l2, #343434); border-radius: 999px; font-size: 11px; color: var(--dsw-alias-label-secondary, #b0b0b0); text-decoration: none; }
      .tm-source:hover { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }

      .tm-btn { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--tm-border-1, #3a3a3a); background: var(--tm-btn-bg, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer; }
      .tm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-btn:disabled { opacity: .5; cursor: not-allowed; }
      .tm-btn--ghost { background: transparent; border-color: transparent; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-btn--ghost:hover { background: var(--tm-hover, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-btn--active { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 6px; border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary, #8f8f8f); cursor: pointer; }
      .tm-iconbtn:hover { background: var(--tm-hover, #222); color: var(--dsw-alias-label-primary, #eee); }
      .tm-iconbtn--on { color: var(--tm-warn, #e3b341); }
      .tm-iconbtn--ghost { visibility: hidden; pointer-events: none; }

      /* The one search box, and its floating result panel: the panel is an
         overlay, so opening a search never pushes the watchlist down. */
      .tm-search { position: relative; z-index: 30; }
      .tm-search__field { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #171717); color: var(--dsw-alias-label-secondary, #999); }
      .tm-search__field:focus-within { border-color: var(--tm-brand, #4b8bf5); box-shadow: 0 0 0 3px var(--tm-focus, rgba(75,139,245,.22)); }
      .tm-input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 13px; }
      .tm-search__hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #888); }
      .tm-search__panel { position: absolute; top: calc(100% + 6px); left: 0; right: 0; z-index: 40; max-height: min(56vh, 430px); overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #171717); box-shadow: var(--tm-shadow-pop, 0 16px 34px rgba(0, 0, 0, .5)); }
      .tm-search__note { padding: 6px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); border-bottom: 1px solid var(--dsw-alias-border-l1, #222); }
      .tm-search__empty { padding: 9px 10px; margin: 0; }
      /* 1.1: the empty-field panel greets with the last picked symbols. */
      .tm-search__recent { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px 2px; }
      .tm-search__recent .tm-search__note { margin: 0; padding: 0; border: 0; background: none; }
      .tm-search__recent-chip { display: inline-flex; align-items: baseline; gap: 5px; padding: 3px 9px; border: 1px solid var(--tm-border-1); border-radius: 999px; background: var(--tm-tile); font-size: 12px; color: var(--tm-text); cursor: pointer; }
      .tm-search__recent-chip small { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--tm-muted); }
      .tm-search__recent-chip:hover { border-color: var(--tm-brand); color: var(--tm-brand); }
      .tm-search__recent-add { padding: 0 4px; border-radius: 5px; font-size: 12px; font-weight: 600; color: var(--tm-muted); }
      .tm-search__recent-add:hover { color: var(--tm-brand); }
      .tm-search__recent-clear { margin-left: auto; padding: 2px 7px; border: 0; border-radius: 6px; background: none; font-size: 11px; color: var(--tm-muted); cursor: pointer; }
      .tm-search__recent-clear:hover { color: var(--tm-text); background: var(--tm-hover); }
      .tm-results { list-style: none; margin: 0; padding: 0; }
      .tm-result { display: flex; align-items: stretch; border-bottom: 1px solid var(--dsw-alias-border-l1, #222); }
      .tm-result:last-child { border-bottom: 0; }
      .tm-result:hover, .tm-result--active { background: var(--tm-hover, #202020); }
      .tm-result--owned { opacity: .72; }
      .tm-result__main { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; text-align: left; border: 0; background: transparent; color: inherit; font: inherit; padding: 7px 10px; cursor: pointer; }
      .tm-result__sym { font-weight: 600; font-size: 12.5px; min-width: 82px; }
      .tm-result__name { font-size: 12.5px; color: var(--dsw-alias-label-primary, #ddd); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-result__tags { display: inline-flex; flex: 0 0 auto; gap: 4px; margin-left: 2px; }
      .tm-result__meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); white-space: nowrap; padding-left: 8px; }
      .tm-result__add { flex: 0 0 36px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-left: 1px solid var(--dsw-alias-border-l1, #222); background: transparent; color: var(--dsw-alias-label-secondary, #8f8f8f); cursor: pointer; }
      .tm-result__add:hover:not(:disabled) { color: var(--dsw-alias-brand-primary, #4b8bf5); background: var(--tm-hover, #262626); }
      .tm-result__add:disabled { cursor: default; color: var(--tm-warn, #e3b341); }

      .tm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .tm-list--plain { gap: 4px; padding-left: 4px; }
      .tm-list--plain li { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-row { display: flex; align-items: center; gap: 10px; padding: 8px 8px; border-radius: 8px; }
      .tm-row:hover { background: var(--tm-hover, #1d1d1d); }
      .tm-row__main { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 10px; cursor: pointer; }
      .tm-row__sym { flex: 0 0 74px; font-weight: 600; font-size: 12.5px; }
      .tm-row__name { flex: 0 1 auto; min-width: 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #8f8f8f); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-row__flag { flex: 0 0 auto; font-size: 10px; line-height: 1.6; padding: 0 5px; border-radius: 999px; border: 1px solid var(--dsw-alias-state-warn-primary, #e3b341); color: var(--dsw-alias-state-warn-primary, #e3b341); }
      .tm-row__err { flex: 0 0 auto; font-size: 11px; color: var(--tm-err, #e0836f); }
      .tm-row__quote { flex: 0 0 auto; display: grid; grid-template-columns: 92px 74px 62px 50px; column-gap: 12px; align-items: baseline; justify-items: end; }
      .tm-row__price { font-size: 13.5px; font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; }
      .tm-row__chg { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
      .tm-row__pct { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; }
      .tm-row__ts { font-size: 11px; color: var(--dsw-alias-label-secondary, #7f7f7f); font-variant-numeric: tabular-nums; text-align: right; }
      .tm-row__tools { flex: 0 0 102px; display: flex; gap: 2px; justify-content: flex-end; }
      .tm-row--head { padding: 0 8px 6px; cursor: default; }
      .tm-row--head:hover { background: transparent; }
      .tm-row__sort { appearance: none; background: none; border: 0; margin: 0; padding: 0; font: inherit; color: inherit; cursor: pointer; letter-spacing: inherit; pointer-events: auto; }
      .tm-row__sort:hover { color: var(--tm-brand, currentColor); text-decoration: underline dotted; }
      .tm-row__sort--on { color: var(--tm-brand, currentColor); font-weight: 600; }
      .tm-row--head .tm-row__sym, .tm-row--head .tm-row__name, .tm-row--head .tm-row__quote { font-size: 10.5px; font-weight: 500; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-row--head .tm-row__sym { flex: 0 0 74px; }
      @media (max-width: 1130px) {
        /* Five index tiles on one row leave ~186px per tile: the third source
           link no longer fits beside the other two, so drop it instead of
           wrapping a lone word onto a second line. */
        .tm-index__meta .tm-source:last-child { display: none; }
      }
      @media (max-width: 820px) {
        .tm-row__quote { grid-template-columns: 84px 66px 58px; }
        .tm-row__ts, .tm-row--head .tm-row__quote > span:last-child { display: none; }
        .tm-row__tools { flex: 0 0 auto; }
        /* The events card packs chips + filter + count on one baseline row; on a
           narrow phone that row overflows, so it wraps and the filter grows. */
        .tm-events__controls { flex-wrap: wrap; row-gap: 6px; }
        .tm-events__filter { flex: 1 1 140px; width: auto; }
        .tm-events__row { flex-wrap: wrap; row-gap: 2px; }
        .tm-events__session { display: none; }
        /* Tag pills ride inside the fixed-width name column; past 620px the
           card-top filter chips already carry the grouping, so the pills drop
           instead of squeezing the name into a sliver. */
        @media (max-width: 620px) { .tm-row__tag { display: none; } }
      }

      .tm-detail { display: flex; flex-direction: column; gap: 12px; }
      .tm-detail__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .tm-detail__id { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
      .tm-detail__title { margin: 0; font-size: 17px; }
      .tm-detail__sub { display: flex; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #999); flex-wrap: wrap; }
      /* Keyboard affordances in the detail head. Touch devices never get the
         keys, so @media (hover:none) drops the hint entirely. */
      .tm-detail__keys { display: inline-flex; gap: 4px; margin-left: 2px; }
      .tm-detail__kbd { min-width: 18px; padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 5px; background: var(--tm-tile, transparent); font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #999); text-align: center; }
      @media (hover: none) { .tm-detail__keys { display: none; } }
      .tm-badge { border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
      .tm-detail__price { display: flex; flex-direction: column; gap: 2px; margin-left: auto; }
      .tm-detail__last { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .tm-detail__chg { font-size: 12.5px; font-variant-numeric: tabular-nums; }

      .tm-ranges { display: flex; gap: 4px; }
      .tm-range { border: 1px solid var(--dsw-alias-border-l2, #333); background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 999px; cursor: pointer; }
      .tm-range:hover { color: var(--dsw-alias-label-primary, #eee); }
      .tm-range--active { background: var(--dsw-alias-brand-primary, #4b8bf5); border-color: transparent; color: #fff; }

      .tm-chart { display: flex; flex-direction: column; gap: 4px; }
      .tm-chart__svg { width: 100%; height: 340px; display: block; }
      .tm-chart__grid { stroke: var(--dsw-alias-border-l1, #2a2a2a); stroke-width: 1; vector-effect: non-scaling-stroke; }
      .tm-chart__wick { stroke-width: 1; vector-effect: non-scaling-stroke; }
      .tm-chart__body { stroke: none; }
      .tm-up-stroke { stroke: var(--tm-up, #35c98a); } .tm-down-stroke { stroke: var(--tm-down, #ff6b5e); }
      .tm-up-fill { fill: var(--tm-up, #35c98a); } .tm-down-fill { fill: var(--tm-down, #ff6b5e); }
      .tm-chart__vol { fill: var(--tm-vol, rgba(120,130,150,.28)); }
      .tm-chart__vol--up { fill: var(--tm-vol-up, rgba(53,201,138,.35)); }
      .tm-chart__ma { stroke-width: 1.4; vector-effect: non-scaling-stroke; }
      .tm-chart__ma--ma20 { stroke: var(--tm-ma20, #e0b64a); } .tm-chart__ma--ma50 { stroke: var(--tm-ma50, #5aa7e0); } .tm-chart__ma--ma200 { stroke: var(--tm-ma200, #b07de0); }
      .tm-chart__legend, .tm-chart__footer { display: flex; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8c8c8c); flex-wrap: wrap; }
      .tm-chart__ma-key--ma20 { color: var(--tm-ma20, #e0b64a); } .tm-chart__ma-key--ma50 { color: var(--tm-ma50, #5aa7e0); } .tm-chart__ma-key--ma200 { color: var(--tm-ma200, #b07de0); }

      .tm-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 900px) { .tm-columns { grid-template-columns: 1fr; } }
      .tm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; }
      .tm-cell { display: flex; flex-direction: column; gap: 1px; }
      .tm-cell__k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-cell__v { font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .tm-desc { margin: 8px 0 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #a5a5a5); }
      .tm-up { color: var(--tm-up, #35c98a); } .tm-down { color: var(--tm-down, #ff6b5e); } .tm-flat { color: inherit; }

      .tm-fresh { display: flex; gap: 8px; align-items: center; font-size: 11px; color: var(--dsw-alias-label-secondary, #8f8f8f); flex-wrap: wrap; }
      .tm-fresh--compact { font-size: 10.5px; }
      .tm-fresh--stale .tm-fresh__time { color: var(--tm-warn, #e3b341); }
      .tm-fresh__note { opacity: .85; }
      .tm-fresh__why { border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 999px; padding: 0 6px; }
      .tm-chart__partial { border: 1px solid var(--tm-warn, #e3b341); color: var(--tm-warn, #e3b341); border-radius: 999px; padding: 0 6px; cursor: help; }
      .tm-note { margin: 6px 0; font-size: 11.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #a5a5a5); }
      .tm-note--warn { border-left: 2px solid var(--tm-warn, #e3b341); padding-left: 8px; color: var(--tm-warn, #e3b341); }
      .tm-note--ok { border-left: 2px solid var(--tm-up, #35c98a); padding-left: 8px; color: var(--tm-up, #35c98a); }
      .tm-grid--muted { opacity: .6; }
    .tm-hint__why { margin-top: 4px; opacity: .8; font-size: 12px; }

      .tm-ai { display: flex; flex-direction: column; gap: 8px; }
      .tm-ai__summary { margin: 0; font-size: 13px; line-height: 1.55; }
      .tm-ai__h { margin: 6px 0 2px; font-size: 12px; color: var(--dsw-alias-label-secondary, #9a9a9a); text-transform: uppercase; letter-spacing: .05em; }
      .tm-ask { margin: 0; display: flex; }
      .tm-ask .tm-input { border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 8px; padding: 6px 9px; background: var(--tm-tile, #1c1c1c); }
      .tm-levels { display: flex; gap: 6px; flex-wrap: wrap; }
      .tm-level { border-radius: 6px; padding: 1px 7px; font-size: 12px; font-variant-numeric: tabular-nums; }
      .tm-level--sup { background: var(--tm-up-soft, rgba(53,201,138,.16)); color: var(--tm-up-ink, #6fd0a0); }
      .tm-level--res { background: var(--tm-down-soft, rgba(255,107,94,.16)); color: var(--tm-down-ink, #eba294); }
      .tm-levels-block { margin-top: 10px; }
      /* 1.1: 52-week position rail under the level cells. */
      .tm-range { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; margin-top: 2px; }
      .tm-range__track { position: relative; flex: 1; height: 4px; border-radius: 999px; background: color-mix(in srgb, var(--tm-brand) 18%, transparent); }
      .tm-range__fill { position: absolute; top: 50%; width: 9px; height: 9px; border-radius: 999px; background: var(--tm-brand); transform: translate(-50%, -50%); box-shadow: 0 0 0 2px var(--tm-surface); }
      .tm-range__fill--hot { background: var(--tm-up); }
      .tm-range__fill--cold { background: var(--tm-down); }
      .tm-range__lo, .tm-range__hi { font-size: 10px; color: var(--tm-muted); font-variant-numeric: tabular-nums; }
      .tm-levels-block__k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); display: block; margin-bottom: 4px; }
      .tm-brief { display: flex; flex-direction: column; gap: 18px; }
      .tm-brief__headline { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.55; }
      .tm-brief__when { margin: 0; font-size: 11px; color: var(--tm-muted); font-variant-numeric: tabular-nums; }
      .tm-brief__sectors { font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; }
      .tm-brief__sectors > span:first-child { color: var(--tm-muted); }
      .tm-brief__sectors > span[class] { white-space: nowrap; }
      /* 1.1: loading skeleton for the brief card — same tile language, no
         spinner flash, and the layout is already correct before data lands. */
      .tm-skeleton { display: flex; flex-direction: column; gap: 10px; padding: 2px 0 4px; }
      .tm-skeleton__bar { height: 12px; border-radius: 6px; background: var(--tm-tile); animation: tm-pulse 1.4s ease-in-out infinite; }
      .tm-skeleton__bar--wide { width: 72%; height: 14px; }
      .tm-skeleton__bar--dim { opacity: 0.55; width: 55%; }
      .tm-skeleton__stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .tm-skeleton__stats span { height: 42px; border-radius: 9px; background: var(--tm-tile); animation: tm-pulse 1.4s ease-in-out infinite; }
      .tm-skeleton__stats span:nth-child(2) { animation-delay: 0.12s; }
      .tm-skeleton__stats span:nth-child(3) { animation-delay: 0.24s; }
      @keyframes tm-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }
      @media (prefers-reduced-motion: reduce) { .tm-skeleton__bar, .tm-skeleton__stats span { animation: none; } }
      .tm-brief__stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .tm-brief__stats .tm-cell { padding: 10px 12px; border-radius: 10px; background: var(--tm-tile, #1d1d1d); gap: 2px; }
      .tm-brief__stats .tm-cell__v { font-size: 17px; font-weight: 600; line-height: 1.2; }
      .tm-brief__movers { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .tm-brief__mover { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--tm-tile, #1d1d1d); }
      .tm-brief__mover-k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-brief__mover-v { font-size: 12.5px; line-height: 1.5; }
      .tm-brief__block { display: flex; flex-direction: column; gap: 8px; }
      .tm-brief__label { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-brief__text { margin: 0; font-size: 12.5px; line-height: 1.7; }
      .tm-brief__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
      .tm-brief__list li { position: relative; padding-left: 14px; font-size: 12.5px; line-height: 1.7; }
      .tm-brief__list li::before { content: ''; position: absolute; left: 2px; top: 0.62em; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.32; }
      .tm-brief__sym { font-weight: 600; margin-right: 3px; }
      .tm-brief__sym--go { font: inherit; color: var(--tm-brand); background: var(--tm-tile); border: none; border-radius: 5px; padding: 1px 5px; cursor: pointer; }
      .tm-brief__sym--go:hover { background: var(--tm-hover); }
      .tm-brief__block--actions .tm-brief__label { color: var(--dsw-alias-brand-primary, #4c8dff); }
      .tm-brief__actions { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
      .tm-brief__actions li { display: flex; gap: 8px; align-items: flex-start; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l1, #262626); border-radius: 9px; background: var(--tm-tile, #1d1d1d); font-size: 12.5px; line-height: 1.6; }
      .tm-brief__n { flex: 0 0 16px; height: 16px; margin-top: 1px; border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 5px; background: var(--tm-btn-bg, #1b1b22); display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8f8f8f); font-variant-numeric: tabular-nums; }
      .tm-brief__action-text { flex: 1 1 auto; min-width: 0; }
      .tm-brief p { margin: 0; font-size: 12.5px; line-height: 1.5; }

      .tm-status { grid-area: status; display: flex; align-items: center; gap: 10px; min-width: 0; position: relative; }
      .tm-status__pill { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dsw-alias-border-l1, #2f2f2f); background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 999px; cursor: pointer; white-space: nowrap; }
      .tm-status__active { opacity: .7; }
      .tm-status__meta { flex: 1 1 auto; min-width: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #7f7f7f); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tm-status__chain { font-size: 11px; color: var(--dsw-alias-label-secondary, #8f8f8f); padding: 2px 4px 6px; margin-bottom: 2px; border-bottom: 1px solid var(--dsw-alias-border-l1, #2f2f2f); word-break: break-word; }
      .tm-status__chains { white-space: normal; word-break: break-word; }
      .tm-status__foot { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #7f7f7f); padding: 6px 4px 2px; margin-top: 2px; border-top: 1px solid var(--dsw-alias-border-l1, #2f2f2f); word-break: break-word; }
      .tm-status__pop { position: absolute; top: calc(100% + 6px); left: 0; right: auto; z-index: 60; width: 380px; padding: 8px; border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 9px; background: var(--tm-overlay, #111116); box-shadow: var(--tm-shadow-pop, 0 18px 40px rgba(0,0,0,.14)); display: flex; flex-direction: column; gap: 4px; }
      .tm-status__row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
      .tm-status__name { font-weight: 600; }
      .tm-status__stats { color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-status__err { color: var(--tm-err, #e0836f); margin-left: auto; max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tm-text-dim, #777); display: inline-block; }
      .tm-dot--ok { background: var(--tm-up, #35c98a); } .tm-dot--bad { background: var(--tm-down, #ff6b5e); }

      .tm-chips { display: flex; gap: 6px; flex-wrap: wrap; }
      .tm-chip { border: 1px solid var(--dsw-alias-border-l2, #333); background: transparent; color: var(--dsw-alias-label-primary, #ddd); font: inherit; font-size: 12px; padding: 2px 9px; border-radius: 999px; cursor: pointer; }
      .tm-chip--add { min-width: 22px; padding: 2px 7px; font-weight: 600; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-chip--add:hover { color: var(--dsw-alias-brand, #4b8bf5); border-color: var(--dsw-alias-border-l2, #3a3a46); background: var(--tm-hover, rgba(16,16,20,.05)); }
      .tm-chip:hover { border-color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-chip--active { border-color: var(--dsw-alias-brand-primary, #4b8bf5); color: var(--dsw-alias-brand-primary, #4b8bf5); }
      /* 1.1 tags: row labels + the card's filter chips + the detail editor. */
      .tm-row__tag { font-size: 10.5px; line-height: 1; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-layer-2, var(--tm-tile)); color: var(--dsw-alias-text-muted); white-space: nowrap; }
      .tm-row__tag--go { font: inherit; cursor: pointer; }
      .tm-row__tag--go:hover { color: var(--dsw-alias-brand, #4b8bf5); border-color: var(--dsw-alias-border-l1); }
      .tm-tagrow { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 0 8px; }      .tm-detail__tags { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 2px 0 10px; }
      .tm-detail__tags-k { font-size: 11px; color: var(--dsw-alias-text-muted); }
      .tm-detail__tag { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; padding: 2px 4px 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-layer-2, var(--tm-tile)); }
      .tm-detail__tag-x { border: 0; background: none; color: var(--dsw-alias-text-muted); font-size: 12px; line-height: 1; padding: 2px 4px; border-radius: 999px; cursor: pointer; }
      .tm-detail__tag-x:hover { color: var(--dsw-alias-brand-primary, #4b8bf5); }
      .tm-detail__tag-add { width: 120px; padding: 2px 9px; font-size: 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-layer-1, transparent); color: inherit; }
      .tm-detail__tag-add:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4b8bf5); box-shadow: 0 0 0 3px var(--tm-focus); }
      /* 1.1 heat strip: the whole watchlist's day at a glance. */
      .tm-brief__copy { margin-left: 8px; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 999px; background: none; font-size: 10.5px; color: var(--dsw-alias-label-secondary, #8a8a8a); cursor: pointer; }
      .tm-brief__copy:hover { color: var(--tm-brand); border-color: var(--tm-brand); }
      .tm-heat { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 2px; }
      .tm-sect { display: flex; flex-wrap: wrap; gap: 6px; }
      .tm-sect__tile { display: inline-flex; align-items: baseline; gap: 5px; font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--tm-border-1); background: var(--tm-tile); cursor: pointer; font-variant-numeric: tabular-nums; }
      .tm-sect__tile:hover { filter: brightness(0.94); border-color: var(--tm-border-2); }
      .tm-sect__name { color: var(--tm-text); }
      .tm-sect__sym { color: var(--tm-text-dim, var(--dsw-alias-text-muted)); font-weight: 400; }
      .tm-sect__pct { font-weight: 400; }
      .tm-heat__k { font-size: 11px; color: var(--dsw-alias-text-muted); margin-right: 2px; }
      .tm-heat__chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; border: 1px solid currentColor; background: var(--dsw-alias-layer-1, transparent); cursor: pointer; font-variant-numeric: tabular-nums; }
      .tm-heat__chip.hover:hover, .tm-heat__chip:hover { filter: brightness(0.92); }
      .tm-heat__pct { font-weight: 400; }
      .tm-card--overview > .tm-chips { padding: 10px 14px 0; }
      .tm-universe { display: flex; flex-direction: column; gap: 10px; }
      .tm-universe__bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
      .tm-universe__tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
      .tm-universe__list { list-style: none; margin: 0; padding: 0; max-height: 360px; overflow-y: auto; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 9px; }
      .tm-universe__row { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto auto; gap: 10px; align-items: center; padding: 5px 10px; border-bottom: 1px solid var(--dsw-alias-border-l1, #2a2a2a); }
      .tm-universe__row--head { position: sticky; top: 0; z-index: 1; background: var(--tm-surface, transparent); cursor: default; }
      .tm-universe__row--head span { font-size: 10.5px; font-weight: 500; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-universe__row:last-child { border-bottom: none; }
      .tm-universe__row:hover { background: var(--tm-hover, #1d1d1d); }
      .tm-universe__sym { font-weight: 600; font-variant-numeric: tabular-nums; }
      button.tm-universe__sym { appearance: none; background: none; border: none; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; }
      button.tm-universe__sym:hover { color: var(--dsw-alias-brand, #4b8bf5); }
      .tm-universe__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-universe__meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8f8f8f); white-space: nowrap; }
      /* The TradingView embed is a third-party page with its own light chrome:
         it stays white in both schemes on purpose. */
      .tm-frame { width: 100%; height: 460px; border: 1px solid var(--dsw-alias-border-l1, #2a2a2a); border-radius: 8px; background: #fff; }
      .tm-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #8f8f8f); line-height: 1.5; }
      .tm-hint--tiny { font-size: 10.5px; opacity: .75; word-break: break-word; }
      .tm-empty { padding: 14px; text-align: center; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-error { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--tm-down, #ff6b5e); background: var(--tm-down-soft, rgba(255,107,94,.16)); border-radius: 8px; font-size: 12px; }
      .tm-error__msg { flex: 1; }
      .tm-spinner { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary, #8f8f8f); padding: 6px 0; }
      .tm-spinner__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4b8bf5); animation: dsh-trading-mode-pulse 1.1s ease-in-out infinite; }
      @keyframes dsh-trading-mode-pulse { 0%,100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.1); } }
      .tm-disclaimer { margin: 4px 0 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #858585); }
      .tm-body::-webkit-scrollbar, .tm-search__panel::-webkit-scrollbar, .tm-universe__list::-webkit-scrollbar { width: 10px; height: 10px; }
      .tm-body::-webkit-scrollbar-thumb, .tm-search__panel::-webkit-scrollbar-thumb, .tm-universe__list::-webkit-scrollbar-thumb { background: var(--tm-border-2, #3a3a46); background-clip: padding-box; border: 3px solid transparent; border-radius: 999px; }
      .tm-body::-webkit-scrollbar-thumb:hover, .tm-search__panel::-webkit-scrollbar-thumb:hover, .tm-universe__list::-webkit-scrollbar-thumb:hover { background: var(--tm-text-dim, #b6b6c2); background-clip: padding-box; border: 3px solid transparent; }
      .tm-body::-webkit-scrollbar-track, .tm-search__panel::-webkit-scrollbar-track, .tm-universe__list::-webkit-scrollbar-track { background: transparent; }
    `

    // -------------------------------------------------------------------- apply
    const module = { exports: {} }

    const name = 'trading-mode'
    const inject = ['slots']

    /**
     * Follow the DSH interface language unless the user picked one here.
     * `ctx.get('locale')` is an optional client service — when this build does
     * not expose it the panel stays switchable and defaults to the browser
     * language.
     */
    function bindPlatformLocale(ctx) {
      let browserLang = 'en'
      try {
        if (typeof navigator !== 'undefined' && navigator.language) browserLang = normalizeLang(navigator.language) || 'en'
      } catch (_) {
        /* no navigator (tests) */
      }
      setStore({ platformLang: browserLang })
      try {
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : null
        if (!locale || typeof locale.getLocale !== 'function') return null
        const read = () => normalizeLang((locale.getLocale() || {}).active) || 'en'
        setStore({ platformLang: read() })
        if (typeof locale.subscribe === 'function') {
          const unsubscribe = locale.subscribe(() => setStore({ platformLang: read() }))
          ctx.effect(
            () => () => {
              try {
                if (typeof unsubscribe === 'function') unsubscribe()
              } catch (_) {
                /* the service is already gone */
              }
            },
            'dsh-trading-mode: locale',
          )
        }
        return locale
      } catch (_) {
        return null
      }
    }

    function apply(ctx) {
      bindPlatformLocale(ctx)
      bindPlatformTheme(ctx)

      // 注入一次 <style> 到页面；卸载时移除。
      const styleTag = document.createElement('style')
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
      ctx.effect(() => () => {
        if (styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
      }, 'dsh-trading-mode: styles')

      // 注意：slot 注册的第二参是「组件」，会被 jsx(Comp, ...) 渲染。
      // 必须传元素 () => h(Component)，不要 () => Component()——
      // 后者把带 hooks 的组件当普通函数直接调用，hooks 会绑错 fiber。
      // `ctx.slots.inject(slot, cb)` takes a plain callback that returns the
      // registration's disposer — the same shape the shipped third-party
      // plugins use, and the only one that works whether the host consumes a
      // callback or an effect generator.
      // The page is a `main` panel, and the sidebar row addresses it by the same
      // id — that is the host's own contract ("each list id addresses the
      // matching main panel"). Register the pair together so a host without
      // sidebar panels can never keep a page that no row can select.
      ctx.slots.inject('sidebar.panellist', () => {
        const offPanel = ctx.slots.register({ name: 'main', key: PANEL_ID }, () => h(TradingApp))
        const offRow = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: SIDEBAR_ORDER,
            // The sidebar resolves labels lazily, so the row follows the panel
            // language after the user switches it.
            label: () => translate('Trading Mode', effectiveLang(store.get())),
          },
          (owner) => h(TradingNavIcon, { size: owner && owner.size }),
        )
        return () => {
          if (typeof offPanel === 'function') offPanel()
          if (typeof offRow === 'function') offRow()
        }
      })
    }

    // `_internals` is a test hook only — the DSH client module loader reads
    // apply/inject/name and ignores everything else.
    module.exports = {
      apply,
      inject,
      name,
      _internals: {
        store,
        setStore,
        ZH,
        LANGS,
        makeT,
        translate,
        normalizeLang,
        effectiveLang,
        applyServerLang,
        persistLang,
        THEME_SCHEMES,
        normalizeTheme,
        effectiveTheme,
        applyThemeSnapshot,
        bindPlatformTheme,
        persistTheme,
        ThemeToggle,
        TradingApp,
        TradingNavIcon,
        PANEL_ID,
        SIDEBAR_ORDER,
        LangToggle,
        HomeView,
        DetailView,
        BriefCard,
        AiAnalysisSection,
        SearchBox,
        SearchRow,
        searchRowsOf,
        trackKey,
        CSS,
        CandleChart,
        MarketOverview,
        IndexCell,
        SourcesRow,
        SOURCE_LINKS,
        UniverseBrowser,
        UniverseRow,
        UNIVERSE_PAGE_SIZE,
        MARKET_ORDER,
        MARKET_LABEL_KEY,
        marketOfSymbol,
        cnVenue,
        cnPrefix,
        yahooSymbol,
        digitsOf,
        buildGeometry,
        downsample,
        tradingViewSymbol,
        technicalCells,
        money,
        percent,
        volumeText,
        clockOf,
        nameOf,
      },
    }
    return module.exports
  },
})
