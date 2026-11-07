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
    // Ranges where a weekly bar reads better than a daily one. Intraday ranges
    // stay daily-only: a month of 5m bars is noise, not detail.
    const WEEKLY_RANGES = { '1mo': true, '3mo': true, '6mo': true, '1y': true }
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
      bell: ['M12 4a5 5 0 0 0-5 5c0 4-1.5 5.2-2 6h14c-.5-.8-2-2-2-6a5 5 0 0 0-5-5z', 'M10 19a2 2 0 0 0 4 0'],
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
      'Auto refresh': '自动刷新',
      'Quotes reload every minute while this tab is visible': '面板在前台时每分钟自动刷新行情',
      'Quotes only reload when you ask': '只在点刷新时更新行情',
      'Back': '返回',
      'Walk the watchlist with ←/→ · Esc goes back': '←/→ 看上一只/下一只 · Esc 返回',
      'Close': '关闭',
      'Language': '语言',
      'Follow the DSH interface language': '跟随 DSH 界面语言',
      'NYSE open': '纽市 · 开盘中',
      'NYSE closed': '纽市 · 已收盘',
      'New York {time} · NYSE holiday: {name}': '纽约 {time} · NYSE 休市：{name}',
      'New York {time} · early close at {close} ET: {name}': '纽约 {time} · {close} ET 提前收盘：{name}',
      'New York {time} · regular hours 09:30–16:00 ET; NYSE holidays and early closes included':
        '纽约 {time} · 常规时段 09:30–16:00 ET（含 NYSE 休市与 13:00 ET 提前收盘）',
      'early close {close} ET': '提前收盘 {close} ET',
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
      'A report lands all at once: the number, the guide and the reaction. The gap is usually decided after the close.': '财报一次把数字、指引和反应全砸下来，跳空多半在收盘后那一段决定。',
      'own it before this day to collect': '想拿这次分红要在这天之前持有',
      'pre-market': '盘前',
      'after close': '盘后',
      'Extended hours': '盘前盘后',
    Position: '持仓',
    cost: '成本价',
    shares: '股数',
    Cost: '成本',
    Value: '市值',
    'Open P&L': '浮动盈亏',
    'Save position': '保存持仓',
    'price paid': '买入价',
    'share count': '股数',
    '{n} positions': '{n} 只持仓',
    held: '持仓',
    'Local only — value and open P&L use the quote loaded above.':
      '仅存在本机——市值与浮盈用的是上面已加载的行情，不额外请求。',
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
      'The brief is over 30 minutes old; regenerate it before relying on the numbers.': '简报已超过 30 分钟；依赖数字前建议重新生成。',
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
      'DeepSeek is not available in this DSH session, so Generate Brief writes a rule-based edition: the same counts, movers, volume and derived action list, with no model in the loop.':
        '当前 DSH 会话中没有 DeepSeek，所以「生成简报」会用规则写一份：同样的计数、涨跌榜、成交量与推导出的行动建议，全程没有模型参与。',
      'Rules only': '仅为规则生成',
      'Written by the plugin from the same numbers; no model was involved.': '由插件按同一批数字算出，没有模型参与。',
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
      'By P&L': '按浮盈',
      'By event': '按事件',
    'One bar per day': '每根日线',
    'One bar per week': '每根周线',
      'Sort by the next earnings date (click again to reverse, a third click restores your order)': '按下次财报日排序（再点反序，第三次恢复你的顺序）',
      'Notify me': '提醒时通知我',
      'Send a desktop notification while this tab is in the background': '面板在后台时，把触发的提醒发成桌面通知',
      'Last 20 sessions': '近 20 个交易日',
      'Copy summary': '复制摘要',
      'Copy brief': '复制简报',
      'Copy the whole brief as text': '把整份简报复制成纯文本',
      'Copy this page as plain text': '把这一页复制成纯文本',
      'Change since the previous close, across these positions': '相对上一收盘的变动（这些持仓合计）',
      '{n}d': '{n} 天',
      'recording…': '记录中…',
      'A change appears once two days have been recorded': '记录满两天后才会显示变化',
      'Change over the last {n} days, recorded while this panel was open': '最近 {n} 天的变化（面板打开时记录的本地快照）',
      'Sort by open P&L (click again to reverse, a third click restores your order)': '按浮动盈亏排序（再点反序，第三次恢复你的顺序）',
      'Export CSV': '导出 CSV',
      'Download the watchlist as a CSV file (opens directly in Excel)': '把自选下载为 CSV 文件（Excel 可直接打开）',
      'Import': '导入',
      'Restore rows from a previous export (CSV or JSON)': '用之前导出的文件恢复自选（CSV 或 JSON）',
      'Import a JSON export to restore the list': '用导出的 JSON 文件恢复自选',
      'The file holds no restorable rows.': '文件里没有可恢复的自选行。',
      '{n} positions restored from the file.': '从文件里恢复了 {n} 只持仓。',
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
      'US macro releases': '美国宏观发布',
      'US CPI': '美国 CPI',
      'US PPI': '美国 PPI',
      'US jobs report (NFP)': '就业报告（非农）',
      'US GDP': '美国 GDP',
      'Income & Outlays (PCE)': '个人收支（含 PCE）',
      'FOMC decision': 'FOMC 决议',
      'Dates verified against the official calendars (BLS / Fed / BEA)': '发布时间经官方日历核实（BLS/美联储/BEA）',
      'release today': '今天发布',
      'release tomorrow': '明天发布',
      'release {n}d': '{n} 天后',
      'Macro prints move every position at once; CPI and FOMC days are the widest windows.': '宏观数据同时撬动全部持仓，CPI 与 FOMC 前后是大波动窗口。',
      'Exchange closures': '交易所休市',
      'Exchange calendar': '交易所日历',
      'Monthly options expiry': '期权到期日',
      quarterly: '季度合约',
      'Options expire at the close. Volume and index rebalancing usually cluster on that day.': '期权在收盘时到期，当天成交与指数调仓常集中在这里。',
      'Closed all day': '全天休市',
      'Early close {close} ET': '提前收盘 {close} ET',
      'Half days close at 13:00 ET; orders after that wait for the next session.': '提前收盘日为 13:00 ET 截止，之后的委托要等到下一个交易日。',
      'Macro print': '宏观数据',
      '{n} events today': '今天有 {n} 件事件',
      '{n} events tomorrow': '明天有 {n} 件事件',
      'Market event today': '今天有一件市场事件',
      'Market event tomorrow': '明天有一件市场事件',
      'Today and tomorrow also arrive as a desktop alert while this tab is hidden.': '今天和明天的事件，面板在后台时也会发桌面提醒。',
      '+{n} same day': '同日另有 {n} 件',
      'What is coming up': '接下来有什么事',
      'Next up': '下一个',
      'Show only {kind}': '只看「{kind}」',
      '{n} total · {soon} within 7 days': '共 {n} 件 · 7 天内 {soon} 件',
      'Today and tomorrow': '今明两天',
      '{n} in the next two days': '今明两天共 {n} 件',
      'Earnings': '财报',
      'Macro': '宏观',
      'Closed': '休市',
      'Expiry': '到期',
      'Third Friday': '每月第三个周五',
      'Reports before the open: the open reprices it': '盘前公布，开盘就会重新定价',
      'Reports after the close: the next open reprices it': '收盘后公布，次日开盘重新定价',
      'Time not announced: treat the whole session as exposed': '公布时间未定，当天全天都可能被重新定价',
      'Inflation print: rate expectations reprice every position at once': '通胀读数，利率预期一动，全部持仓同时重定价',
      'Rate decision: usually the widest move window of the month': '利率决议，通常是一个月里波动最大的窗口',
      'Jobs print: the first input for the next rate move': '就业数据，是下一步利率动作的第一手输入',
      'Pipeline inflation: reads like CPI in miniature': '上游通胀，方向同 CPI，幅度通常更小',
      'The Fed’s preferred inflation gauge, second only to CPI': '美联储最看重的通胀指标，分量仅次于 CPI',
      'Growth print: moves index exposure, rarely a single stock': '增长读数，动的是指数，很少只动一只股',
      'Macro print: moves every position at once': '宏观数据，同时撬动全部持仓',
      'Options expire at the close: volume clusters into the last hour': '期权收盘到期，成交量常挤在最后一小时',
      'Closes at {close} ET: later orders wait for the next session': '{close} ET 收盘，之后的委托要等到下一交易日',
      'Closed all day: no fills, and prices stand still': '全天休市，无法成交，价格也不动',
      'No watchlist earnings match that filter.': '没有匹配该筛选的自选财报。',
      'Nothing in the next {days} days for this filter.': '未来 {days} 天，这个筛选下没有事件。',
      'Earnings move one name; macro prints move everything; a half day caps when you can trade.': '财报只动一只，宏观数据同时动全部，提前收盘决定你当天还能不能下单。',
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
      'Dividend yield': '股息率',
      'Annual dividend': '年度股息',
      'Ex-dividend': '除息日',
      'Shares bought on or after this date do not carry the dividend, and the price opens lower by roughly the payment.': '除息日当天及之后买入的股份拿不到这次分红，开盘价会大致按分红金额下调。',
      'Analyst view': '分析师观点',
      analysts: '位分析师',
      'no coverage': '暂无券商覆盖',
      'No rating': '无评级',
      'Strong buy': '强烈买入',
      Buy: '买入',
      Hold: '持有',
      Underperform: '减持',
      Sell: '卖出',
      'Strong sell': '强力卖出',
      'Ratings mix': '评级分布',
      'Rating changes': '评级变动',
      Raised: '上调',
      Cut: '下调',
      Started: '首次覆盖',
      Reiterated: '重申',
      Restated: '维持',
      'No rating changes in the last six months.': '近半年没有评级变动。',
      '{n} days ago': '{n} 天前',
      'Mean target': '平均目标价',
      'Mean rating': '平均评级',
      Analysts: '分析师数',
      Upside: '上行空间',
      '1 = strong buy, 5 = sell': '1 = 强烈买入，5 = 卖出',
      Fundamentals: '基本面',
      'Forward P/E': '预期市盈率',
      'Price/Book': '市净率',
      Beta: 'Beta 系数',
      'Revenue growth': '营收同比',
      'Earnings growth': '利润同比',
      'Gross margin': '毛利率',
      'Net margin': '净利率',
      'Return on equity': '净资产收益率',
      'Short float': '做空比例',
      'Ownership & shorts': '持股与做空',
      Institutions: '机构持股',
      Insiders: '内部人持股',
      'Days to cover': '回补天数',
      'Shares short': '做空股数',
      'vs prior month': '较上月',
      'Short interest as of': '空头数据日期',
      'Price alert': '价格提醒',
      above: '高于',
      below: '低于',
      alert: '提醒',
      triggered: '已触发',
      'No bound': '未设置',
      'no bound': '未设置',
      'Save alert': '保存提醒',
      'Dismiss all': '全部忽略',
      Dismiss: '忽略',
      'Dismiss until the price moves 1% further': '忽略，直到价格再向同方向变动 1%',
      '{n} rows': '{n} 只自选',
      '{up} up {down} down': '{up} 涨 {down} 跌',
      '{n} unchanged': '{n} 平',
      'Largest move: {sym}': '最大波动 {sym}',
      'Watchlist equal-weight': '自选等权',
      'Held equal-weight': '持仓等权',
      'Holding {shares} @ {cost}': '持仓 {shares} 股 · 成本 {cost}',
      'A position: {shares} shares at a cost of {cost}': '这是一个持仓：{shares} 股，成本 {cost}',
      'The positions you hold, averaged the same way against the same index.': '你实际持有的那些仓位，用同样的等权方式与同一个指数比。',
      gap: '相差',
      '{n} names': '{n} 只',
      Gap: '相差',
      'Equal-weighted watchlist next to a 500-name index: a reference, not a like-for-like comparison.': '等权自选与 500 只指数不是同一种风险敞口，这里只做参照。',
      'Largest move on the board': '今天波动最大的自选',
      'After-hours moves': '盘前盘后异动',
      '{n} outside the session': '{n} 只在常规时段之外有成交',
      'Change since the previous regular close': '相对上一个常规收盘的变动',
      'These prints are outside regular hours; the next open can gap to them.': '这些成交发生在常规时段之外，次日开盘可能直接跳空到这里。',
      '{n} alerts triggered': '{n} 条提醒已触发',
      'Alert history': '提醒记录',
      'Event': '事件',
      'Jump to': '跳到',
      '{n} in the next seven days': '未来七天 {n} 件',
      'Watchlist': '自选',
      'Events': '事件',
      'Brief': '简报',
      '{n} entries': '{n} 条',
      'Kept on this device only, newest first.': '只保存在本机，最近的排在前面。',
      'Clear history': '清空记录',
      'Download CSV': '下载 CSV',
      'Download the history as a spreadsheet': '把提醒记录下载成表格',
      Today: '今天',
      'Show only what fired today': '只看今天触发的',
      'Nothing has fired today.': '今天还没有触发的提醒。',
      'Show these rows': '展开这一组',
      'Hide these rows': '收起这一组',
      'Fold all': '收起全部',
      'Unfold all': '展开全部',
      'Fold every group': '收起所有分组',
      'Unfold every group': '展开所有分组',
      'Copy history': '复制记录',
      'Copy the alert history as plain text': '把提醒记录复制成纯文本',
      'max loss': '最大亏损 %',
      'day move': '单日波动 %',
      '{pct} today': '今日 {pct}',
      'down {pct} from your cost': '低于你的成本 {pct}',
      'Local only — the quote you already load is what fires it.': '仅存在本机——用面板已加载的行情判断，不额外请求。',
      'Expense ratio': '费率',
      'Fund family': '基金公司',
      'Top holdings': '前十大持仓',
      'weights in percent of the fund': '权重为占基金比例（%）',
      'Sector exposure': '行业分布',
      'In the news': '相关新闻',
      'No related news in the last 24 hours.': '最近 24 小时没有相关新闻。',
      'Your positions (local)': '你的持仓（本地）',
      'Account notes': '账户笔记',
      'From your own cost basis, before any brief': '基于你本机的成本表，不必先生成简报',
      '{n} more in the brief': '简报里还有 {n} 条',
      '{n} more positions': '另有 {n} 个持仓（导出里是全量）',
      'computed from the cost basis on this device': '按本机记录的成本价计算',
      '{sym} is {pct} on your cost ({cost} -> {last}); a gain that size is worth a decision rather than a default hold.':
        '{sym} 相对你的成本 {pct}（{cost} → {last}）；涨到这个幅度，该主动决定是留还是减，而不是默认拿着。',
      '{sym} is {pct} on your cost ({cost} -> {last}); name the level where you would step out before the next print.':
        '{sym} 相对你的成本 {pct}（{cost} → {last}）；在下一次财报之前，把这个位置的退出价定下来。',
      '{n} positions are {pct} in total ({money}); the brief above speaks to the watchlist, these are your entries.':
        '{n} 只持仓合计 {pct}（{money}）；上面那份简报讲的是自选柜，这几行讲的是你自己的成本。',
      '{n} of your positions are {pct} today ({money}) — that is the session moving, not your entry price, and nothing here has to be settled before the close.':
        '{n} 只持仓今天合计 {pct}（{money}）——这是盘中的变动，不是你买入价的成绩，收盘前不必为此做决定。',
      '{sym} is {pct}% of your {currency} positions; at that weight its drawdown is your drawdown, so size any add against the book rather than the chart.': '{sym} 占你 {currency} 持仓的 {pct}%——这个权重下它的回撤就是你的回撤，加仓前先按整体仓位算，而不是只看图。',
      '{n} headlines': '{n} 条新闻',
      'just now': '刚刚',
      'Headlines on your positions': '持仓新闻',
      'Headlines on your watchlist': '自选新闻',
      '{n} stories': '{n} 条',
      Today: '今天',
      'Show only the last 24 hours': '只看最近 24 小时',
      '{n} today': '今天 {n} 条',
      'Nothing about your positions in the last 24 hours.': '最近 24 小时没有与你持仓相关的新闻。',
      'Keyboard shortcuts': '快捷键',
      'Keyboard shortcuts (?)': '快捷键（?）',
      'Jump to search': '跳到搜索',
      'Move through the results or the list': '在结果或列表里上下移动',
      'Open the highlighted symbol': '打开选中的标的',
      'Previous or next position (detail)': '上一个 / 下一个标的（详情页）',
      'Back to the list': '返回列表',
      'Show or hide this list': '打开或关闭这份清单',
      Sector: '板块',
      Industry: '行业',
      Country: '国家',
      Website: '官网',
      'Show more': '展开全文',
      'Show less': '收起',
      'Earnings surprises': '财报惊喜',
      quarters: '个季度',
      estimate: '预期',
      actual: '实际',
      vs: '对',
      'Surprise is the reported figure against the consensus for that quarter; a miss carries as much information as a beat.': '惊喜＝当季实际值与市场预期的差；没达到预期的信息量，和超预期一样大。',
      'Position & risk': '仓位与风险',
      'local only': '只在本机',
      'account size': '账户规模',
      'risk per trade (%)': '单笔风险 %',
      'stop price': '止损价',
      'shares to buy': '可买股数',
      'position value': '占用资金',
      'share of account': '占账户',
      'stop distance': '止损距离',
      'Type an account size and a stop below the price to size the trade.': '填上账户规模，并把止损设在现价之下，才会算出股数。',
      'Suggested stop: {price} — two average ranges below the last print.': '建议止损 {price}：在最新价下方留两个平均波幅。',
      'One entry, no adds: the number answers how many shares keep a stop-out inside the amount you set.': '假设一次建仓、不加仓：算的是「止损被打到时不超出你设的亏损额」能买多少股。',
      "share of the fund's assets by sector": '按行业划分的基金资产占比（%）',
      'Technology': '科技',
      'Financial services': '金融服务',
      'Communication services': '通信服务',
      'Healthcare': '医疗保健',
      'Consumer cyclical': '可选消费',
      'Consumer defensive': '必需消费',
      'Industrials': '工业',
      'Energy': '能源',
      'Basic materials': '基础材料',
      'Real estate': '房地产',
      'Ahead of its sector by {gap}': '强于板块 {gap}',
      'Behind its sector by {gap}': '弱于板块 {gap}',
      'In line with its sector': '与板块同步',
      '{n}d vs sector {gap}': '近 {n} 日相对板块 {gap}',
      'Price change over {n} sessions against the sector ETF over the same window.': '同一段时间内，个股与板块 ETF 的涨跌幅之差（{n} 个交易日）。',
      'Macro day': '宏观日',
      'You hold {amount}': '你持有 {amount}',
      'Held': '持仓',
      'This idea concerns a position you hold': '这条建议针对你已经持有的仓位',
      'Held only': '只看持仓',
      'Held but not on the watchlist': '持仓不在自选里',
      'Today {amount}': '今天 {amount}',
      'best {sym} {amount}': '最强 {sym} {amount}',
      'worst {sym} {amount}': '最弱 {sym} {amount}',
      'What the day did to the book, and which positions did it.': '今天对整本账的影响，以及是哪些仓位造成的。',
      'The brief only reads the watchlist, so these positions never appear in it.': '简报只读自选，这几只持仓不会出现在里面。',
      'Show the other {n}': '展开另外 {n} 件',
      'Show less': '收起',
      'Only the earnings dates of names you hold; market-wide rows stay': '只保留你持仓股票的财报日，宏观与休市仍然显示',
      'Only the earnings dates of names you hold; market-wide rows stay': '只保留你持仓股票的财报日，宏观与休市仍然显示',
      '{pct} of your {currency} positions': '{currency} 仓位里占 {pct}',
      'Annual dividends': '年化分红',
      '{pct} on cost': '成本上 {pct}',
      'Macro releases land on the index first and on single names second.': '宏观数据先砸指数，再传导到个股。',
      'A macro print today re-prices the whole tape: a clean chart setup can be run over by the index.': '今天有宏观数据：整盘会一起重新定价，再干净的形态也可能被指数带走。',
      'A macro print tomorrow can move every name at once; size new entries accordingly.': '明天有宏观数据：所有标的可能一起波动，新开仓按这个前提定大小。',
      'One sector ETF stands in for the group: the day move side by side, not a valuation call.': '用一个板块 ETF 代表整个行业，只把当天的涨跌并排比较，不做估值判断。',
      'Utilities': '公用事业',
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
      'Open {name}; its closest fund is {symbol}': '打开 {name}（对应基金：{symbol}）',
      'Index levels are not tradable; open the closest ETF': '指数点位不可直接交易，打开最接近的 ETF',
      'ETF {symbol}': '{symbol}（基金）',
      'Index levels are points on a scale, not a security — there is nothing to buy or sell here.': '指数点位是刻度上的读数，不是可买卖的证券。',
      'Index levels are not tradable; open the closest ETF ({symbol})': '指数点位不可交易；打开最接近的 ETF（{symbol}）',
      'Generated {time}': '生成于 {time}',
      // §31 technical grid
      'MACD Signal': 'MACD 信号线',
      'MACD Histogram': 'MACD 柱',
      'Volume Ratio (20D)': '量比（20 日）',
      'Trend alignment': '均线排列',
      'Your cost': '成本价',
      'Today, this position: {amount}': '这只今天：{amount}',
      'By day': '按今日',
      'You hold this one': '你持有这只',
      'Sort by what today did to the position (click again to reverse, a third click restores your order)': '按今天对持仓的影响排序（再点一次反向，第三次恢复你原来的顺序）',
      'moving averages stacked up': '均线多头排列',
      'stacked down': '均线空头排列',
      'averages tangled': '均线纠缠',
      'RSI {v} stretched': 'RSI {v} 偏高',
      'RSI {v} washed out': 'RSI {v} 超卖',
      'RSI {v}': 'RSI {v}（中性）',
      'within {pct} of its 52-week high': '贴着 52 周高（差 {pct}）',
      '{pct} below its 52-week high': '距 52 周高 {pct}',
      '{n} normal volume': '{n} 常规量',
      '{n} quiet volume': '{n} 缩量',
      'A summary of what the indicators say, not a recommendation.': '把指标翻成一句话，不是买卖建议。',
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

    // A profile URL is shown as its name, not as a query string: the scheme and
    // the www. carry no meaning for the reader, and a 200-character URL would
    // push the row apart.
    /** '2026-09-30' reads as '2026 Q3' — the fiscal quarter a report belongs to. */
    function quarterLabel(iso) {
      const text = typeof iso === 'string' ? iso : ''
      const year = text.slice(0, 4)
      const month = Number(text.slice(5, 7))
      if (!/^\d{4}$/.test(year) || !Number.isFinite(month) || month < 1 || month > 12) return text || '—'
      return `${year} Q${Math.ceil(month / 3)}`
    }

    function siteOf(url) {
      const text = String(url || '').trim()
      if (!text) return ''
      return text.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '')
    }

    // One place for every key the panel answers to: the overlay and the handlers
    // cannot drift apart if the table is the source the reader is shown.
    /**
     * Shares that keep a stop-out at or under the amount at risk. A stop above
     * the price, a zero account or a zero risk all answer null: sizing has no
     * meaning there, and a silent zero would read like "buy nothing".
     */
    function sizeFor(price, stop, account, riskPct) {
      if (!isNum(price) || !isNum(stop) || !isNum(account) || !isNum(riskPct)) return null
      if (price <= 0 || stop <= 0 || stop >= price || account <= 0 || riskPct <= 0) return null
      const perShare = price - stop
      const riskMoney = (account * riskPct) / 100
      const shares = Math.floor(riskMoney / perShare)
      const value = shares > 0 ? shares * price : 0
      return {
        shares: shares > 0 ? shares : 0,
        value,
        riskMoney,
        stopPct: ((price - stop) / price) * 100,
        sharePct: value > 0 ? (value / account) * 100 : 0,
      }
    }

    /** A stop a usable distance away: two average ranges, else the 20-day line. */
    function suggestStop(price, tech) {
      if (!isNum(price) || price <= 0) return null
      const atr = tech && isNum(tech.atr14) ? tech.atr14 : null
      if (atr && atr > 0) {
        const byAtr = price - 2 * atr
        if (byAtr > 0) return Math.round(byAtr * 100) / 100
      }
      const ma20 = tech && isNum(tech.ma20) ? tech.ma20 : null
      if (ma20 && ma20 > 0 && ma20 < price) return Math.round(ma20 * 100) / 100
      return null
    }

    // Arrow keys walk a list one row at a time and wrap around, so a short
    // list never traps the caret at an end. -1 means "nothing highlighted yet":
    // the first press lands on either end depending on the direction asked for.
    function nextNavIndex(current, length, delta) {
      if (!length || length < 1) return -1
      if (!isNum(current) || current < 0 || current >= length) return delta > 0 ? 0 : length - 1
      return (current + delta + length) % length
    }

    const SHORTCUTS = [
      { keys: '/', label: 'Jump to search' },
      { keys: '↑ ↓', label: 'Move through the results or the list' },
      { keys: 'Enter', label: 'Open the highlighted symbol' },
      { keys: '← →', label: 'Previous or next position (detail)' },
      { keys: 'Esc', label: 'Back to the list' },
      { keys: '?', label: 'Show or hide this list' },
    ]

    // `?` must not fire while the caret is in a field, and must not swallow the
    // browser shortcuts that also use it (Cmd+? on some layouts).
    function wantsHelp(event) {
      if (!event || event.defaultPrevented) return false
      if (event.altKey || event.ctrlKey || event.metaKey) return false
      if (event.key !== '?') return false
      const node = event.target
      const tag = (node && node.tagName) || ''
      return !(tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (node && node.isContentEditable))
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

    // Calendar dates that come from upstream (ex-dividend days) are UTC
    // midnights, not local instants: formatting them in local time shifts a
    // 2026-11-12 payout to 11-11 anywhere west of Greenwich.
    function dateOfUtc(value) {
      const ms = epochOf(value)
      if (!ms) return '—'
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    }

    // "today" / "tomorrow" / "in 5 days" for a future date, empty otherwise —
    // used for scheduled facts such as the ex-dividend day, which Yahoo may
    // already have moved into the past. Day boundaries are UTC for the same
    // reason as above.
    function relativeDayOf(value, translator) {
      const ms = epochOf(value)
      if (!ms) return ''
      // A page can be read in either language, so the caller's translator wins;
      // the bare string is the unbound English default.
      const tr = typeof translator === 'function' ? translator : (text, vars) => translate(text).replace(/\{(\w+)\}/g, (match, key) => (vars && vars[key] != null ? String(vars[key]) : match))
      const floorUtc = (t0) => Math.floor(t0 / 86_400_000) * 86_400_000
      const days = Math.round((floorUtc(ms) - floorUtc(Date.now())) / 86_400_000)
      if (days < 0) return ''
      if (days === 0) return tr('today')
      if (days === 1) return tr('tomorrow')
      return tr('in {n} days', { n: days })
    }

    /**
     * Compact age for a headline: 12m, 3h, 2d. Deliberately coarser than a
     * timestamp — a news card answers "how stale is this", not "when exactly",
     * and the exact time sits in the row's tooltip.
     */
    // The holdings feed answers "what happened"; the today filter answers "what
    // happened since I last looked". Rows without a usable stamp never qualify.
    function recentNews(items, now = Date.now(), hours = 24) {
      const floor = now - hours * 3600 * 1000
      return (items || []).filter((item) => isNum(item.at) && item.at >= floor)
    }

    function agoOf(value, now = Date.now()) {
      const ms = epochOf(value)
      if (!ms || !Number.isFinite(now)) return ''
      const minutes = Math.floor((now - ms) / 60_000)
      if (minutes < 1) return translate('just now')
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      const days = Math.round(hours / 24)
      return days < 30 ? `${days}d` : `${Math.round(days / 30)}mo`
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

    function buildGeometry(bars, series, width, height, marks) {
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
      // A horizontal mark is only drawn when the price is inside the window the
      // chart is showing: a cost line far outside the range would sit on the
      // frame and imply a scale the bars do not have.
      const levels = []
      for (const mark of Array.isArray(marks) ? marks : []) {
        if (!mark || !isNum(mark.price)) continue
        if (mark.price < min || mark.price > max) continue
        levels.push({ key: mark.key || String(mark.price), label: mark.label || '', price: mark.price, y: yOf(mark.price) })
      }
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
      return { grid, wicks, bodies, volumes, lines, levels, min, max, first: bars[0], last: bars[bars.length - 1] }
    }

    function CandleChart({ candles, series, interval, degraded, read, cost }) {
      const { t } = useT()
      const bars = useMemo(() => downsample(candles || [], 320), [candles])
      const marks = useMemo(
        () => (isNum(cost) ? [{ key: 'cost', price: cost, label: t('Your cost') }] : []),
        [cost],
      )
      const geo = useMemo(() => buildGeometry(bars, series, 1000, 340, marks), [bars, series, marks])
      if (!bars.length) return h(Empty, null, t('Data unavailable'))
      return h(
        'div',
        { className: 'tm-chart' },
        h(
          'svg',
          { className: 'tm-chart__svg', viewBox: '0 0 1000 340', preserveAspectRatio: 'none', role: 'img' },
          geo.grid.map((y, i) => h('line', { key: 'g' + i, className: 'tm-chart__grid', x1: 0, x2: 1000, y1: y, y2: y })),
          geo.levels.map((level) =>
            h(
              'g',
              { key: 'lv' + level.key },
              h('line', { className: 'tm-chart__level', x1: 0, x2: 1000, y1: level.y, y2: level.y }),
              h('text', { className: 'tm-chart__level-tag', x: 994, y: Math.max(11, level.y - 4), textAnchor: 'end' }, `${level.label} ${plain(level.price)}`),
            ),
          ),
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
        read
          ? h('div', { className: 'tm-chart__read', title: t('A summary of what the indicators say, not a recommendation.') }, read)
          : null,
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

    // 1.2: price alerts are a local note-to-self, not a server feature — the
    // panel already holds a live quote for every row, so checking a bound costs
    // no request. Both bounds are optional and independent: "tell me above X"
    // and "tell me under Y" are different intentions, and one alert can hold
    // both. Keys are market-qualified for the same reason the watchlist is.
    const ALERTS_KEY = 'tm-alerts'
    const boundOf = (value) => {
      const n = typeof value === 'number' ? value : Number.parseFloat(value)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    function readAlerts() {
      try {
        const raw = window.localStorage.getItem(ALERTS_KEY)
        const map = raw ? JSON.parse(raw) : null
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
      } catch (_) {
        return {}
      }
    }
    function writeAlerts(map) {
      try {
        window.localStorage.setItem(ALERTS_KEY, JSON.stringify(map))
      } catch (_) {
        /* storage denied: the alert still holds until the panel is reloaded */
      }
    }
    /**
     * The bounds one row carries, or null when nothing is armed. A half-written
     * entry (blank strings, NaN) collapses to null so neither the row flag nor
     * the banner promises a check that will never fire.
     */
    function alertOf(map, record) {
      if (!map || !record) return null
      const entry = map[trackKey(record)]
      if (!entry || typeof entry !== 'object') return null
      const above = boundOf(entry.above)
      const below = boundOf(entry.below)
      const loss = boundOf(entry.loss)
      const move = boundOf(entry.move)
      return above === null && below === null && loss === null && move === null ? null : { above, below, loss, move }
    }
    /**
     * Which armed bound the last price has crossed. `above` fires at or over the
     * upper bound, `below` at or under the lower one; a missing price never
     * fires, because a stale or failed quote must not raise a false alarm.
     */
    function alertHit(price, alert) {
      if (!isNum(price) || !alert) return null
      if (isNum(alert.above) && price >= alert.above) return 'above'
      if (isNum(alert.below) && price <= alert.below) return 'below'
      return null
    }
    /**
     * The same note-to-self in percent: "tell me when this holding is down N%
     * from what I paid". It needs a cost basis, so a row without one never
     * fires — no cost, no claim about a loss.
     */
    function lossHit(position, alert) {
      if (!position || !isNum(position.pct) || !alert || !isNum(alert.loss)) return null
      return position.pct <= -alert.loss ? 'loss' : null
    }
    /**
     * An event, not a level: "tell me when this one moves N% in a day". The
     * quote already carries the session change, so it costs no request, and a
     * missing change never fires.
     */
    function moveHit(quote, alert) {
      if (!quote || !alert || !isNum(alert.move) || !isNum(quote.changePct)) return null
      if (Math.abs(quote.changePct) < alert.move) return null
      return quote.changePct < 0 ? 'down' : 'up'
    }
    /** The armed bounds as one line of text, for tooltips and the banner. */
    function alertBoundsText(alert, t, currency) {
      if (!alert) return ''
      const parts = []
      if (isNum(alert.above)) parts.push(`${t('above')} ${money(alert.above, currency || 'USD')}`)
      if (isNum(alert.below)) parts.push(`${t('below')} ${money(alert.below, currency || 'USD')}`)
      if (isNum(alert.loss)) parts.push(`${t('max loss')} ${alert.loss}%`)
      if (isNum(alert.move)) parts.push(`${t('day move')} ${alert.move}%`)
      return parts.join(' · ')
    }
    /**
     * The most recent print on a symbol, and the session that produced it. After
     * the bell the regular price stops moving, so an alert armed for the next
     * session would sit silent all evening; the pre/post print is the latest
     * trade and it is already on the quote, so it is what an alert watches.
     */
    function latestPrint(quote) {
      if (!quote || typeof quote !== 'object') return null
      const ext = quote.extended
      if (ext && isNum(ext.price) && (ext.session === 'pre' || ext.session === 'post')) {
        return { price: ext.price, session: ext.session }
      }
      return isNum(quote.price) ? { price: quote.price, session: 'regular' } : null
    }

    /** How many sessions the detail header sparkline covers. */
    const SPARK_SESSIONS = 20

    /**
     * Point list for the header sparkline: the last N closes squashed into a
     * small viewBox. A flat series still gets a line through the middle, so the
     * header never reserves width for nothing; under two closes returns null.
     */
    function sparkPoints(candles, width = 88, height = 26, span = SPARK_SESSIONS) {
      const closes = (Array.isArray(candles) ? candles : [])
        .map((c) => (c && isNum(c.close) ? c.close : null))
        .filter((v) => v !== null)
        .slice(-span)
      if (closes.length < 2) return null
      const min = Math.min(...closes)
      const max = Math.max(...closes)
      const pad = 2
      const inner = height - pad * 2
      const stepX = width / (closes.length - 1)
      const points = closes
        .map((v, i) => {
          const x = +(i * stepX).toFixed(2)
          const y = max === min ? height / 2 : +(pad + inner - ((v - min) / (max - min)) * inner).toFixed(2)
          return `${x},${y}`
        })
        .join(' ')
      return { points, up: closes[closes.length - 1] >= closes[0], from: closes[0], to: closes[closes.length - 1] }
    }

    /**
     * The detail page as plain text, for a note or a chat. Lines are left out
     * rather than filled with dashes: a number the panel does not have is
     * simply absent, and "—" reads like something that was checked.
     */
    function digestLines(input, t) {
      const src = input && typeof input === 'object' ? input : {}
      const out = []
      const head = [src.symbol, src.name].filter(Boolean).join(' · ')
      if (head) out.push(head)
      // A yield copies as "4.86%", not "$4.86": the unit belongs to the level,
      // not to a currency the index does not trade in.
      const priceText = isNum(src.price)
        ? src.unit
          ? plain(src.price, 2) + String(src.unit)
          : money(src.price, src.currency)
        : null
      if (priceText) {
        const move = [
          isNum(src.change) ? signed(src.change, 2) : null,
          isNum(src.changePct) ? percent(src.changePct) : null,
        ]
          .filter(Boolean)
          .join(' ')
        out.push(move ? `${priceText}  ${move}` : priceText)
      }
      const ext = src.ext
      if (ext && isNum(ext.price) && (ext.session === 'pre' || ext.session === 'post')) {
        out.push(
          `${sessionLabel(ext.session, t)} ${money(ext.price, src.currency)}${isNum(ext.changePct) ? ` · ${percent(ext.changePct)}` : ''}`,
        )
      }
      const pos = src.position
      if (pos && isNum(pos.value)) {
        out.push(
          `${t('Position')} ${pos.shares} @ ${money(pos.cost, pos.currency)} · ${t('Value')} ${money(pos.value, pos.currency)}${isNum(pos.pnl) ? ` · ${t('Open P&L')} ${signed(pos.pnl, 2)}${isNum(pos.pct) ? ` (${percent(pos.pct)})` : ''}` : ''}`,
        )
      }
      if (isNum(src.exDividendDate)) out.push(`${t('Ex-dividend')} ${dateOfUtc(src.exDividendDate)}`)
      return out
    }

    /**
     * The whole brief as plain text, in the order it is read on screen. The
     * suggestion copy next to the list keeps the checklist alone; this one is
     * for pasting a complete picture — board, prints, ideas, and the local
     * cost-basis lines — into a note or a message.
     */
    /**
     * A book of twenty positions turns the brief's tail into a wall of text and
     * pushes the suggestions it was meant to support off the screen. Five is
     * the point where the list still reads as a summary; the rest is counted,
     * never silently dropped, and the full set stays in the CSV export.
     */
    const POSITION_LINES_MAX = 5

    function capPositions(positions, cap = POSITION_LINES_MAX) {
      const list = Array.isArray(positions) ? positions : []
      const limit = cap > 0 ? cap : POSITION_LINES_MAX
      return { shown: list.slice(0, limit), hidden: Math.max(0, list.length - limit) }
    }

    function briefLines(brief, positions, t, lang) {
      if (!brief || typeof brief !== 'object') return []
      const out = []
      const stamp = brief.generatedAt && briefWhen(brief.generatedAt)
      out.push(stamp ? `${t('AI Watchlist Brief')} · ${t('Generated {time}', { time: stamp })}` : t('AI Watchlist Brief'))
      if (brief.headline) out.push(String(brief.headline))

      const counts = []
      if (Number.isFinite(brief.stocksTracked)) counts.push(`${t('Stocks tracked')} ${brief.stocksTracked}`)
      if (Number.isFinite(brief.upCount)) counts.push(`${t('Up')} ${brief.upCount}`)
      if (Number.isFinite(brief.downCount)) counts.push(`${t('Down')} ${brief.downCount}`)
      if (counts.length) out.push(counts.join(' · '))

      const movers = []
      if (brief.strongestMover) movers.push(`${t('Strongest mover')}: ${brief.strongestMover}`)
      if (brief.largestDecline) movers.push(`${t('Largest decline')}: ${brief.largestDecline}`)
      if (movers.length) out.push(movers.join('　·　'))

      if (Array.isArray(brief.unusualVolume) && brief.unusualVolume.length) {
        out.push(`${t('Unusual volume')}:`)
        for (const line of brief.unusualVolume) out.push(`- ${line}`)
      }
      if (Array.isArray(brief.keyObservations) && brief.keyObservations.length) {
        out.push(`${t('Key observations')}:`)
        for (const line of brief.keyObservations) out.push(`- ${line}`)
      }
      if (Array.isArray(brief.suggestions) && brief.suggestions.length) {
        out.push(`${t('Action ideas')}:`)
        brief.suggestions.forEach((line, i) => out.push(`${i + 1}. ${line}`))
      }
      // The cost-basis lines are computed on this device and read as one more
      // section: a reader of the paste cannot tell them apart from the model's
      // text otherwise.
      if (Array.isArray(positions) && positions.length) {
        out.push(`${t('Your positions (local)')}:`)
        const capped = capPositions(positions)
        for (const line of capped.shown) out.push(`- ${line}`)
        if (capped.hidden) out.push(`- ${t('{n} more positions', { n: capped.hidden })}`)
      }
      return out
    }

    /**
     * How many days until the next earnings date loaded for this row, or null
     * when the calendar window does not reach it. The sort uses this so a row
     * with a print next week can float above rows that have nothing coming.
     */
    function eventDaysOf(row, earnings) {
      if (!row || !earnings || !earnings.bySymbol) return null
      const entry = earnings.bySymbol[String(row.symbol).toUpperCase()]
      if (!entry || !entry.date) return null
      const days = daysBetween(entry.date, earnings.today || entry.date)
      return Number.isFinite(days) ? days : null
    }

    /** How far an extended-hours print must move to earn a line on the board. */
    const AFTER_HOURS_BOARD_PCT = 1

    /** Breadth and the biggest single move across the loaded rows. */
    function marketPulse(rows) {
      const list = Array.isArray(rows) ? rows : []
      let up = 0
      let down = 0
      let flat = 0
      let lead = null
      let seen = 0
      for (const row of list) {
        const pct = row && row.quote && row.quote.changePct
        if (!isNum(pct)) continue
        seen += 1
        if (pct > 0) up += 1
        else if (pct < 0) down += 1
        else flat += 1
        if (pct !== 0 && (!lead || Math.abs(pct) > Math.abs(lead.changePct))) {
          lead = { symbol: row.symbol, market: row.market || null, changePct: pct }
        }
      }
      return { total: list.length, counted: seen, up, down, flat, lead }
    }

    /**
     * Equal-weighted watchlist against the broad tape. The board figure is a
     * plain average of the rows' day change — no market-cap weighting, because
     * the watchlist is the reader's own list, not an index. The gap is
     * arithmetic, not a verdict: eight names against five hundred is a
     * different risk profile, so the line reads "gap" and never "beating".
     */
    function boardVsIndex(rows, items, indexSymbol = '^GSPC', held) {
      const list = Array.isArray(rows) ? rows : []
      const source = held instanceof Set ? held : Array.isArray(held) ? held : []
      const owned = new Set([...source].map((sym) => String(sym || '').toUpperCase()))
      let sum = 0
      let n = 0
      let heldSum = 0
      let heldN = 0
      for (const row of list) {
        const pct = row && row.quote && row.quote.changePct
        if (!isNum(pct)) continue
        sum += pct
        n += 1
        // The list is the reader's own selection; the second average is the
        // part of it they actually own. The gap between the two says whether
        // the money sits in the better half, without claiming to know what the
        // better half is.
        if (owned.has(String(row.symbol || '').toUpperCase())) {
          heldSum += pct
          heldN += 1
        }
      }
      const pick = (Array.isArray(items) ? items : []).find((item) => {
        const pct = item && item.quote && item.quote.changePct
        return item && item.symbol === indexSymbol && isNum(pct)
      })
      if (!n || !pick) return null
      const board = sum / n
      const indexPct = pick.quote.changePct
      const heldBoard = heldN ? heldSum / heldN : null
      return {
        board,
        n,
        heldBoard,
        heldN,
        indexPct,
        indexSymbol,
        indexName: pick.nameZh || pick.name || indexSymbol,
        gap: board - indexPct,
        heldGap: heldBoard == null ? null : heldBoard - indexPct,
      }
    }

    /** Rows whose pre/post print moved at least `minPct`, steepest first. */
    function afterHoursMovers(rows, minPct = AFTER_HOURS_BOARD_PCT) {
      const out = []
      for (const row of rows || []) {
        const ext = row && row.quote && row.quote.extended
        if (!ext || (ext.session !== 'pre' && ext.session !== 'post')) continue
        if (!isNum(ext.changePct) || !isNum(ext.price) || ext.price <= 0) continue
        if (Math.abs(ext.changePct) < minPct) continue
        out.push({ row, session: ext.session, price: ext.price, changePct: ext.changePct, at: ext.at || null })
      }
      return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    }

    // One module-level cell plus a listener set: arming an alert on the detail
    // page marks the row and the banner without a reload, and two tabs converge
    // on whatever storage last wrote.
    let alertCache = null
    const alertListeners = new Set()
    function useAlerts() {
      const [alerts, setAlerts] = useState(() => {
        if (!alertCache) alertCache = readAlerts()
        return alertCache
      })
      useEffect(() => {
        const fn = (next) => setAlerts(next)
        alertListeners.add(fn)
        const fresh = readAlerts()
        if (JSON.stringify(fresh) !== JSON.stringify(alertCache)) {
          alertCache = fresh
          setAlerts(fresh)
        }
        return () => {
          alertListeners.delete(fn)
        }
      }, [])
      const update = useCallback((record, patch) => {
        const key = trackKey(record)
        const previous = (alertCache && alertCache[key]) || {}
        const merged = {
          above: patch && 'above' in patch ? boundOf(patch.above) : boundOf(previous.above),
          below: patch && 'below' in patch ? boundOf(patch.below) : boundOf(previous.below),
          loss: patch && 'loss' in patch ? boundOf(patch.loss) : boundOf(previous.loss),
        }
        const next = Object.assign({}, alertCache || {})
        if (merged.above === null && merged.below === null && merged.loss === null) delete next[key]
        else next[key] = merged
        alertCache = next
        writeAlerts(next)
        // A new bound is a new question: the old acknowledgement was an answer
        // about a different line and must not silence the fresh one.
        forgetAck(key)
        for (const fn of alertListeners) fn(next)
      }, [])
      return [alerts, update]
    }

    // 1.2: dismissing an alert has to mean something across reloads, or the same
    // banner returns every time the panel is opened and people stop reading it.
    // An acknowledgement remembers the print that was dismissed; the alert stays
    // quiet until the price moves a full point further in the same direction, so
    // "it is still over the line" is not news while "it kept going" is.
    const ACKS_KEY = 'tm-alert-acks'
    const ACK_MARGIN_PCT = 1
    function readAcks() {
      try {
        const raw = window.localStorage.getItem(ACKS_KEY)
        const map = raw ? JSON.parse(raw) : null
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
      } catch (_) {
        return {}
      }
    }
    function writeAcks(map) {
      try {
        window.localStorage.setItem(ACKS_KEY, JSON.stringify(map))
      } catch (_) {
        /* storage denied: the acknowledgement still holds for this page */
      }
    }
    /** The acknowledged levels one row carries, or null when it says nothing. */
    function ackOf(map, record) {
      if (!map || !record) return null
      const entry = map[trackKey(record)]
      if (!entry || typeof entry !== 'object') return null
      const above = boundOf(entry.above)
      const below = boundOf(entry.below)
      const loss = boundOf(entry.loss)
      const move = boundOf(entry.move)
      return above === null && below === null && loss === null && move === null ? null : { above, below, loss, move }
    }
    /**
     * Whether a crossed bound has already been seen at this level. `level` is the
     * price for a price bound and the absolute drawdown for a loss bound, so the
     * same margin reads as "another point" either way.
     */
    function alertSnoozed(hit, level, ack, margin = ACK_MARGIN_PCT) {
      if (!hit || !isNum(level) || !ack) return false
      const mark = ack[hit]
      if (!isNum(mark)) return false
      if (hit === 'above') return level < mark * (1 + margin / 100)
      if (hit === 'below') return level > mark * (1 - margin / 100)
      return level < mark + margin
    }
    /** The number a given hit is compared at: a price, or a drawdown in points. */
    function alertLevel(hit, latest, position, quote) {
      if (hit === 'loss') return position && isNum(position.pct) ? Math.abs(position.pct) : null
      if (hit === 'up' || hit === 'down') return quote && isNum(quote.changePct) ? Math.abs(quote.changePct) : null
      return latest && isNum(latest.price) ? latest.price : null
    }

    let ackCache = null
    const ackListeners = new Set()
    function forgetAck(key) {
      if (!ackCache || !ackCache[key]) return
      const next = Object.assign({}, ackCache)
      delete next[key]
      ackCache = next
      writeAcks(next)
      for (const fn of ackListeners) fn(next)
    }
    function useAcks() {
      const [acks, setAcks] = useState(() => {
        if (!ackCache) ackCache = readAcks()
        return ackCache
      })
      useEffect(() => {
        const fn = (next) => setAcks(next)
        ackListeners.add(fn)
        const fresh = readAcks()
        if (JSON.stringify(fresh) !== JSON.stringify(ackCache)) {
          ackCache = fresh
          setAcks(fresh)
        }
        return () => {
          ackListeners.delete(fn)
        }
      }, [])
      const mark = useCallback((record, hit, level) => {
        if (!hit || !isNum(level)) return
        const key = trackKey(record)
        const previous = (ackCache && ackCache[key]) || {}
        const next = Object.assign({}, ackCache || {})
        next[key] = Object.assign({}, previous, { [hit]: level })
        ackCache = next
        writeAcks(next)
        for (const fn of ackListeners) fn(next)
      }, [])
      const markAll = useCallback((entries) => {
        const next = Object.assign({}, ackCache || {})
        for (const entry of entries) {
          if (!entry || !entry.hit || !isNum(entry.level)) continue
          const key = trackKey(entry.record)
          next[key] = Object.assign({}, next[key] || {}, { [entry.hit]: entry.level })
        }
        ackCache = next
        writeAcks(next)
        for (const fn of ackListeners) fn(next)
      }, [])
      return [acks, mark, markAll]
    }

    // A log of what actually fired. The banner is transient and the
    // notification only helps if the browser allows it, so a user who was away
    // has no way to answer "did anything trigger while I was out". Written from
    // the same hit pass the banner already runs — no second scan, no request,
    // and it never leaves this device.
    const ALERT_LOG_KEY = 'tm-alert-log'
    const ALERT_LOG_MAX = 30
    const ALERT_LOG_GAP_MS = 5 * 60 * 1000
    function readAlertLog() {
      try {
        const raw = window.localStorage.getItem(ALERT_LOG_KEY)
        const list = raw ? JSON.parse(raw) : null
        return Array.isArray(list) ? list.filter((item) => item && typeof item.key === 'string' && item.hit) : []
      } catch (_) {
        return []
      }
    }
    function writeAlertLog(list) {
      try {
        window.localStorage.setItem(ALERT_LOG_KEY, JSON.stringify(list))
      } catch (_) {
        /* storage denied: the log lives for this page only */
      }
    }
    /**
     * Newest first, capped, and quiet about a repeat: the same alert firing
     * again a few seconds later is the same event, not a second one.
     */
    function appendAlerts(list, entries, now = Date.now()) {
      const next = Array.isArray(list) ? list.slice() : []
      for (const entry of entries || []) {
        if (!entry || !entry.key || !entry.hit) continue
        const head = next[0]
        if (head && head.key === entry.key && head.hit === entry.hit && now - head.at < ALERT_LOG_GAP_MS) continue
        next.unshift({
          key: entry.key,
          symbol: entry.symbol || entry.key.split(':').pop(),
          hit: entry.hit,
          level: isNum(entry.level) ? entry.level : null,
          pct: isNum(entry.pct) ? entry.pct : null,
          currency: entry.currency || 'USD',
          type: entry.type || null,
          when: entry.when || null,
          at: now,
        })
      }
      return next.slice(0, ALERT_LOG_MAX)
    }
    // The log keeps thirty entries, which can span days; "what fired today" is the
    // question people actually ask, so the same list is filterable by local day.
    function alertLogToday(entries, now = Date.now()) {
      if (!Array.isArray(entries) || !entries.length) return []
      const start = new Date(now)
      start.setHours(0, 0, 0, 0)
      const floor = start.getTime()
      return entries.filter((entry) => isNum(entry.at) && entry.at >= floor && entry.at <= now)
    }

    /** Collapsed group labels survive a reload; a bad value is not fatal. */
    const GROUPS_KEY = 'tm-groups-collapsed'
    function readCollapsedGroups() {
      try {
        const raw = window.localStorage.getItem(GROUPS_KEY)
        const list = raw ? JSON.parse(raw) : []
        return Array.isArray(list) ? list.filter((label) => typeof label === 'string') : []
      } catch (error) {
        return []
      }
    }
    function writeCollapsedGroups(labels) {
      try {
        window.localStorage.setItem(GROUPS_KEY, JSON.stringify(labels))
      } catch (error) {
        /* private mode: the fold still works for this page */
      }
    }
    /** Add or remove one label, leaving the rest in place. */
    function toggleInList(list, value) {
      const next = new Set(Array.isArray(list) ? list : [])
      if (next.has(value)) next.delete(value)
      else next.add(value)
      return Array.from(next)
    }

    /** The history as plain text, one line per entry, newest first. */
    function alertLogText(entries, t) {
      if (!Array.isArray(entries)) return [];
      return entries
        .filter((entry) => entry && typeof entry.symbol === 'string')
        .map((entry) => {
          const reason = alertLogReason(entry, t);
          const when = isNum(entry.at) ? clockOf(entry.at) : '';
          return [when, entry.symbol, reason].filter((part) => part !== '').join(' \u00b7 ');
        });
    }

    function alertLogReason(entry, t) {
      if (!entry) return ''
      // A calendar entry has no price to quote: the useful fact is which kind
      // of event it is and how soon, and both are rebuilt from stored codes at
      // render time so switching language rewrites the whole history.
      if (entry.hit === 'event') {
        const kind = t(EVENT_TYPE_CHIP[entry.type] || 'Event')
        return `${kind} \u00b7 ${t(entry.when === 'today' ? 'today' : 'tomorrow')}`
      }
      if (entry.hit === 'above' || entry.hit === 'below') return `${t(entry.hit)} ${money(entry.level, entry.currency)}`
      if (entry.hit === 'loss') return t('down {pct} from your cost', { pct: percent(entry.pct) })
      return t('{pct} today', { pct: percent(entry.pct) })
    }
    let alertLogCache = null
    const alertLogListeners = new Set()
    function useAlertLog() {
      const [entries, setEntries] = useState(() => {
        if (!alertLogCache) alertLogCache = readAlertLog()
        return alertLogCache
      })
      useEffect(() => {
        const fn = (next) => setEntries(next)
        alertLogListeners.add(fn)
        const fresh = readAlertLog()
        if (JSON.stringify(fresh) !== JSON.stringify(alertLogCache)) {
          alertLogCache = fresh
          setEntries(fresh)
        }
        return () => {
          alertLogListeners.delete(fn)
        }
      }, [])
      const record = useCallback((items) => {
        const next = appendAlerts(alertLogCache || [], items)
        alertLogCache = next
        writeAlertLog(next)
        for (const fn of alertLogListeners) fn(next)
      }, [])
      const clear = useCallback(() => {
        alertLogCache = []
        writeAlertLog([])
        for (const fn of alertLogListeners) fn([])
      }, [])
      return [entries, record, clear]
    }

    // 1.2: a cost basis is the same kind of local note-to-self as an alert —
    // nothing leaves the panel, every row already carries a live quote, so the
    // position value and the open P&L cost no request. Keys stay market-qualified,
    // so a coin and a ticker sharing a symbol never share a position.
    const COSTS_KEY = 'tm-costs'
    function readCosts() {
      try {
        const raw = window.localStorage.getItem(COSTS_KEY)
        const map = raw ? JSON.parse(raw) : null
        return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
      } catch (_) {
        return {}
      }
    }
    function writeCosts(map) {
      try {
        window.localStorage.setItem(COSTS_KEY, JSON.stringify(map))
      } catch (_) {
        /* storage denied: the basis still holds until the panel is reloaded */
      }
    }
    /**
     * Price paid and share count together, or nothing. Half a position is no
     * position: showing a value off a guessed share count would be worse than
     * showing none.
     */
    function costOf(map, record) {
      if (!map || !record) return null
      const entry = map[trackKey(record)]
      if (!entry || typeof entry !== 'object') return null
      const price = boundOf(entry.price)
      const shares = boundOf(entry.shares)
      return price === null || shares === null ? null : { price, shares }
    }
    /**
     * Value, cost and open P&L for one row at the last regular price. Kept in
     * one place so the watchlist total and the detail read-out cannot disagree
     * about the same arithmetic.
     */
    /**
     * What the dividend actually pays on this position, not what the quote page
     * says per share. A 0.6% yield is background noise on a $300 position and a
     * real income line on a $30,000 one, and the reader can only see which by
     * multiplying — so the panel multiplies for them. Cost yield (income over
     * what was paid) is the number that ages well: it rises when the stock
     * falls, which is the opposite of the headline yield.
     */
    function dividendIncome(profile, held) {
      const rate = profile && isNum(profile.dividendRate) ? profile.dividendRate : null
      const shares = held && isNum(held.shares) ? held.shares : null
      if (rate === null || shares === null || rate <= 0 || shares <= 0) return null
      const annual = rate * shares
      return { annual, onCost: held.basis > 0 ? (annual / held.basis) * 100 : null, currency: held.currency || 'USD' }
    }

    function positionOf(quote, cost) {
      if (!cost || !quote || !isNum(quote.price)) return null
      const value = quote.price * cost.shares
      const basis = cost.price * cost.shares
      const pnl = value - basis
      return {
        shares: cost.shares,
        cost: cost.price,
        value,
        basis,
        pnl,
        pct: basis > 0 ? (pnl / basis) * 100 : null,
        // Today's move in cash, which is the number a holder actually feels —
        // open P&L describes the whole position, this describes the session.
        today: isNum(quote.change) ? quote.change * cost.shares : null,
        todayPct: isNum(quote.changePct) ? quote.changePct : null,
        currency: quote.currency || 'USD',
      }
    }
    /**
     * The card's summary line, one bucket per currency. Currencies are never
     * converted — a made-up rate would be a number nobody can audit — and a
     * bucket only reports today's move once at least one row has one.
     */
    const HISTORY_KEY = 'tm-portfolio-history'
    const HISTORY_MAX_DAYS = 120
    const HISTORY_WINDOW_DAYS = 30
    function readHistory() {
      try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_KEY) || 'null')
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch (err) {
        return {}
      }
    }
    function writeHistory(map) {
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(map))
      } catch (err) {
        // private mode: the series simply will not survive a reload
      }
    }
    // One point per local day, replaced as the day goes on: an intraday curve of
    // a value we only sample when the panel is open would be a lie about time.
    function recordHistory(map, currency, value, at = Date.now()) {
      const key = String(currency || 'USD')
      if (!isNum(value) || value <= 0) return map
      const day = new Date(at)
      day.setHours(0, 0, 0, 0)
      const stamp = day.getTime()
      const list = Array.isArray(map[key]) ? map[key].slice() : []
      const last = list.length ? list[list.length - 1] : null
      if (last && last.at === stamp) list[list.length - 1] = { at: stamp, value }
      else list.push({ at: stamp, value })
      while (list.length > HISTORY_MAX_DAYS) list.shift()
      return Object.assign({}, map, { [key]: list })
    }
    // The same series as a line: the number says how much, the line says how it
    // got there - a straight rise and a round trip back to flat read alike.
    function historyPoints(list, width = 56, height = 14, days = HISTORY_WINDOW_DAYS) {
      const trend = historyChange(list, days)
      if (!trend) return null
      const points = (Array.isArray(list) ? list : []).filter((point) => point && isNum(point.value) && point.value > 0 && isNum(point.at))
      const floor = points[points.length - 1].at - days * 86400000
      const windowed = points.filter((point) => point.at >= floor)
      if (windowed.length < 2) return null
      const values = windowed.map((point) => point.value)
      const max = Math.max(...values)
      const min = Math.min(...values)
      const span = max - min
      const stroke = windowed
        .map((point, index) => {
          const x = windowed.length === 1 ? 0 : (index / (windowed.length - 1)) * width
          const y = span === 0 ? height / 2 : height - ((point.value - min) / span) * height
          return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`
        })
        .join(' ')
      return { points: stroke, up: windowed[windowed.length - 1].value >= windowed[0].value, count: windowed.length }
    }

    function historyChange(list, days = HISTORY_WINDOW_DAYS) {
      if (!Array.isArray(list)) return null
      const points = list.filter((point) => point && isNum(point.value) && point.value > 0 && isNum(point.at))
      if (points.length < 2) return null
      const end = points[points.length - 1]
      const floor = end.at - days * 86400000
      const first = points.filter((point) => point.at >= floor)[0] || points[0]
      if (!first || first.value <= 0 || first.at === end.at) return null
      const change = end.value - first.value
      return { days, from: first.value, to: end.value, change, pct: (change / first.value) * 100 }
    }

    function portfolioTotals(rows, costs) {
      const byCurrency = new Map()
      for (const row of rows || []) {
        const position = positionOf(row.quote, costOf(costs, row))
        if (!position) continue
        const bucket = byCurrency.get(position.currency) || { currency: position.currency, value: 0, basis: 0, pnl: 0, today: 0, counted: 0, count: 0 }
        bucket.value += position.value
        bucket.basis += position.basis
        bucket.pnl += position.pnl
        bucket.count += 1
        if (isNum(position.today)) {
          bucket.today += position.today
          bucket.counted += 1
        }
        byCurrency.set(position.currency, bucket)
      }
      return [...byCurrency.values()]
    }
    /**
     * The day in one line: how much money it made or lost, and which positions
     * did it. The totals line already carries the number; this one names the
     * cause, because "today -$240" invites a guess and "worst NVDA -$310" does
     * not. Only the currency with the largest book speaks — a second line in a
     * second currency would be two different questions.
     */
    function dayDrivers(rows, costs) {
      const byCurrency = new Map()
      for (const row of rows || []) {
        const position = positionOf(row.quote, costOf(costs, row))
        if (!position || !isNum(position.today)) continue
        const bucket = byCurrency.get(position.currency) || { currency: position.currency, value: 0, today: 0, rows: [] }
        bucket.value += position.value
        bucket.today += position.today
        bucket.rows.push({ symbol: String(row.symbol || '').toUpperCase(), today: position.today })
        byCurrency.set(position.currency, bucket)
      }
      const list = [...byCurrency.values()].filter((bucket) => bucket.value > 0)
      if (!list.length) return null
      const main = list.sort((a, b) => b.value - a.value)[0]
      const sorted = main.rows.slice().sort((a, b) => b.today - a.today)
      return {
        currency: main.currency,
        today: main.today,
        up: sorted.find((entry) => entry.today > 0) || null,
        down: sorted.slice().reverse().find((entry) => entry.today < 0) || null,
      }
    }
    /**
     * How much of the book one row is, in percent. Concentration is the risk a
     * reader cannot see from a price: eight names at 3% each behave nothing like
     * one at 25%, and the list is where the weights actually live.
     * Returns null when the row is not a position or the bucket is empty, so the
     * chip never prints a number it cannot back.
     */
    function positionWeight(position, totals) {
      if (!position || !Array.isArray(totals)) return null
      const bucket = totals.find((entry) => entry && entry.currency === position.currency)
      if (!bucket || !(bucket.value > 0)) return null
      const pct = (position.value / bucket.value) * 100
      return isNum(pct) && pct > 0 ? { pct, currency: position.currency } : null
    }

    /**
     * Open P&L as one number per row, for sorting only: `null` means "this row
     * is not a position", which the sort treats like a missing quote instead of
     * ranking it as a flat 0%.
     */
    function pnlPercent(quote, cost) {
      const position = positionOf(quote, cost)
      if (!position || !isNum(position.pct)) return null
      return position.pct
    }
    /**
     * Local, cost-basis reading of the watchlist for the brief.
     *
     * The brief itself is written server-side from quotes alone, so it cannot
     * see `tm-costs`; these lines are appended in the panel instead of shipping
     * the cost basis upstream. Only a move big enough to invite a decision gets
     * a line — a 1% drift is noise, and a list of six daily fluctuations is not
     * an action idea.
     */
    const POSITION_NOTE_PCT = 10
    const PORTFOLIO_NOTE_PCT = 3
    // A session move of 1% across the book is already a day worth naming;
    // the 3% gate above is for a position that has drifted, not for a day.
    const PORTFOLIO_DAY_PCT = 1
    /** Share of one currency's book that makes a single name the book. */
    const POSITION_FOCUS_PCT = 40
    function positionNotes(rows, costs, t) {
      const held = []
      for (const row of rows || []) {
        const position = positionOf(row.quote, costOf(costs, row))
        if (position && isNum(position.pct)) held.push({ row, position })
      }
      if (!held.length) return []
      const notes = []
      // Pool per currency first: adding dollars to yuan would invent an FX rate,
      // and the size of a note is measured against its own currency's book.
      // Pool per currency: adding dollars to yuan would invent an FX rate.
      const byCurrency = new Map()
      for (const { row, position } of held) {
        const bucket = byCurrency.get(position.currency) || { n: 0, pnl: 0, basis: 0, value: 0, today: 0, counted: 0, largest: null }
        bucket.n += 1
        bucket.pnl += position.pnl
        bucket.basis += position.basis
        bucket.value += position.value
        if (isNum(position.today)) {
          bucket.today += position.today
          bucket.counted += 1
        }
        if (!bucket.largest || position.value > bucket.largest.value) {
          bucket.largest = { symbol: row.symbol, value: position.value }
        }
        byCurrency.set(position.currency, bucket)
      }
      const bookOf = (currency) => {
        const bucket = byCurrency.get(currency)
        return bucket && bucket.value > 0 ? bucket.value : 0
      }
      // A 40% move on a $200 position is not a decision, it is rounding. The
      // note is sized by money: only positions that are at least a fiftieth of
      // their book earn a sentence about what to do with them.
      const notable = held.filter(({ position }) => {
        const book = bookOf(position.currency)
        return book > 0 && position.value >= book * 0.02
      })
      const biggest = notable.slice().sort((a, b) => Math.abs(b.position.pct) - Math.abs(a.position.pct))[0]
      if (biggest && Math.abs(biggest.position.pct) >= POSITION_NOTE_PCT) {
        const { row, position } = biggest
        notes.push(
          position.pct >= 0
            ? t('{sym} is {pct} on your cost ({cost} -> {last}); a gain that size is worth a decision rather than a default hold.', {
                sym: row.symbol,
                pct: `${position.pct > 0 ? '+' : ''}${position.pct.toFixed(1)}%`,
                cost: money(position.cost, position.currency),
                last: money(position.value / position.shares, position.currency),
              })
            : t('{sym} is {pct} on your cost ({cost} -> {last}); name the level where you would step out before the next print.', {
                sym: row.symbol,
                pct: `${position.pct.toFixed(1)}%`,
                cost: money(position.cost, position.currency),
                last: money(position.value / position.shares, position.currency),
              }),
        )
      }
      // Concentration is the risk a per-row read cannot show: two positions can
      // both be green while one of them decides the whole book's day.
      for (const [currency, bucket] of byCurrency) {
        if (bucket.n < 2 || !(bucket.value > 0) || !bucket.largest) continue
        const share = (bucket.largest.value / bucket.value) * 100
        if (share < POSITION_FOCUS_PCT) continue
        notes.push(
          t('{sym} is {pct}% of your {currency} positions; at that weight its drawdown is your drawdown, so size any add against the book rather than the chart.', {
            sym: bucket.largest.symbol,
            pct: share.toFixed(0),
            currency,
          }),
        )
      }
      for (const [currency, bucket] of byCurrency) {
        if (bucket.n < 2 || !(bucket.basis > 0)) continue
        const pct = (bucket.pnl / bucket.basis) * 100
        if (Math.abs(pct) < PORTFOLIO_NOTE_PCT) continue
        notes.push(
          t('{n} positions are {pct} in total ({money}); the brief above speaks to the watchlist, these are your entries.', {
            n: bucket.n,
            pct: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
            money: `${bucket.pnl >= 0 ? '+' : '-'}${money(Math.abs(bucket.pnl), currency)}`,
          }),
        )
      }
      // The day and the entry are different questions: mixing them into one
      // percentage makes a flat book look like a losing one.
      for (const [currency, bucket] of byCurrency) {
        if (bucket.counted < 2 || !(bucket.value - bucket.today > 0)) continue
        const pct = (bucket.today / (bucket.value - bucket.today)) * 100
        if (Math.abs(pct) < PORTFOLIO_DAY_PCT) continue
        notes.push(
          t('{n} of your positions are {pct} today ({money}) — that is the session moving, not your entry price, and nothing here has to be settled before the close.', {
            n: bucket.counted,
            pct: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
            money: `${bucket.today >= 0 ? '+' : '-'}${money(Math.abs(bucket.today), currency)}`,
          }),
        )
      }
      return notes
    }
    let costCache = null
    const costListeners = new Set()
    function useCosts() {
      const [costs, setCosts] = useState(() => {
        if (!costCache) costCache = readCosts()
        return costCache
      })
      useEffect(() => {
        const fn = (next) => setCosts(next)
        costListeners.add(fn)
        const fresh = readCosts()
        if (JSON.stringify(fresh) !== JSON.stringify(costCache)) {
          costCache = fresh
          setCosts(fresh)
        }
        return () => {
          costListeners.delete(fn)
        }
      }, [])
      const update = useCallback((record, patch) => {
        const key = trackKey(record)
        const previous = (costCache && costCache[key]) || {}
        const merged = {
          price: patch && 'price' in patch ? boundOf(patch.price) : boundOf(previous.price),
          shares: patch && 'shares' in patch ? boundOf(patch.shares) : boundOf(previous.shares),
        }
        const next = Object.assign({}, costCache || {})
        if (merged.price === null && merged.shares === null) delete next[key]
        else next[key] = merged
        costCache = next
        writeCosts(next)
        for (const fn of costListeners) fn(next)
      }, [])
      return [costs, update]
    }

    function SearchBox({ onOpen, onAdd, owned, held, rows, autoFocus }) {
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
                        held: Boolean(held && held(row)),
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
    function SearchRow({ row, active, owned, held, onOpen, onAdd }) {
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
          // "On the watchlist" and "actually held" are different states: the
          // star already answers the first, and a name bought outside the list
          // (or removed after buying) still deserves the second.
          held ? h('span', { className: 'tm-result__held', title: t('You hold this one') }, t('Held')) : null,
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
    function WatchRow({ item, onOpen, onRemove, onFavorite, onMove, index, count, quoteMode, earnings, onTag, alert, cost, weight, nav }) {
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
      // An armed price alert shows as a chip on the row, and turns amber once the
      // last price is on the wrong side of a bound — the list is where a breach
      // has to be visible, not a page the reader has to open to find out.
      const armed = alert || null
      const latest = latestPrint(quote)
      const crossed = alertHit(latest && latest.price, armed)
      // A pre/post print only matters while the venue is *in* that session, so
      // the provider stamps the session and this row simply mirrors it — no
      // guessing from the clock, which would disagree with the exchange.
      const ext = quote && quote.extended && isNum(quote.extended.price) ? quote.extended : null
      // A cost basis turns the row into a position: the flag carries the open
      // P&L in percent, the title the cash figure and the market value.
      const position = positionOf(quote, cost)
      // The chip also answers "am I down enough to care", which needs the cost
      // basis and so can only fire on a row that actually is a position.
      const lossCrossed = lossHit(position, armed)
      // A big single-session move is an event on its own, so it flags the row
      // the same way a crossed price bound does.
      const moveCrossed = moveHit(quote, armed)
      return h(
        'li',
        {
          className: 'tm-row' + (nav ? ' tm-row--nav' : ''),
          ref: nav
            ? (node) => { if (node && node.scrollIntoView) node.scrollIntoView({ block: 'nearest' }) }
            : undefined,
        },
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
          weight
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__weight' + (weight.pct >= POSITION_FOCUS_PCT ? ' tm-row__weight--heavy' : ''),
                  title: t('{pct} of your {currency} positions', { pct: percent(weight.pct), currency: weight.currency }),
                },
                percent(weight.pct),
              )
            : null,
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
          armed
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__flag--alert' + (crossed || lossCrossed || moveCrossed ? ' tm-row__flag--hit' : ''),
                  title: `${t('Price alert')} · ${alertBoundsText(armed, t, quote && quote.currency)}${crossed || lossCrossed || moveCrossed ? ` · ${t('triggered')}` : ''}`,
                },
                t('alert'),
              )
            : null,
          ext
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__flag--ext ' + trendClass(ext.changePct),
                  title: `${t('Extended hours')} · ${money(ext.price, quote && quote.currency)}${ext.at ? ` · ${clockOf(ext.at)}` : ''}`,
                },
                `${sessionLabel(ext.session, t)} ${percent(ext.changePct)}`.trim(),
              )
            : null,
          position
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__flag--pnl ' + trendClass(position.pct),
                  title: `${t('Cost')} ${money(position.cost, position.currency)} × ${position.shares} · ${t('Value')} ${money(position.value, position.currency)} · ${t('Open P&L')} ${signed(position.pnl, 2)}${position.pct === null ? '' : ` (${percent(position.pct)})`}`,
                },
                position.pct === null ? t('held') : percent(position.pct),
              )
            : null,
          // Open P&L is measured from the cost; this is measured from the last
          // close, and they answer different questions. A sub-dollar move is
          // noise on a list this dense, so it stays off.
          position && isNum(position.today) && Math.abs(position.today) >= 1
            ? h(
                'span',
                {
                  className: 'tm-row__flag tm-row__flag--today ' + trendClass(position.today),
                  title: t('Today, this position: {amount}', { amount: signed(position.today, 2) }),
                },
                signed(position.today, 2),
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
      // 1.1: the cost basis rides along in the file, because a backup that
      // restores the list but forgets the holdings silently loses the numbers
      // the P&L column depends on. Columns are found by name, so an export made
      // before they existed still imports.
      const columnOf = (name) => header.findIndex((cell) => cell.toLowerCase() === name)
      const costAt = columnOf('cost')
      const sharesAt = columnOf('shares')
      const numberAt = (cells, at) => {
        if (at < 0) return undefined
        const value = Number((cells[at] || '').trim())
        return Number.isFinite(value) && value > 0 ? value : undefined
      }
      return rows.slice(1).map((cells) => ({
        symbol: (cells[0] || '').trim(),
        market: (cells[1] || '').trim() || undefined,
        name: (cells[2] || '').trim() || undefined,
        tags: (cells[3] || '').trim() ? (cells[3] || '').split('|').map((tag) => tag.trim()).filter(Boolean) : undefined,
        isFavorite: /^y$/i.test((cells[4] || '').trim()) ? true : truthy(cells[4]),
        cost: numberAt(cells, costAt),
        shares: numberAt(cells, sharesAt),
      })).filter((item) => item.symbol)
    }

    /**
     * The saved list leaves the plugin as a spreadsheet-ready file. A row with
     * a cost basis also carries what the position is worth today, so the export
     * is a snapshot of the account rather than a bare ticker list; a row
     * without one leaves those three cells empty instead of writing zeros that
     * would read as a flat position.
     */
    /**
     * Today's money for one row, or null when it is not a position. Kept as a
     * helper so the sort and the row chip agree on what "today" means: measured
     * from the previous close on the shares actually held.
     */
    function todayOf(row, costs) {
      const position = positionOf(row && row.quote, costOf(costs, row))
      return position && isNum(position.today) ? position.today : null
    }

    function watchlistCsv(rows, costs) {
      const cell = (value) => {
        const text = String(value == null ? '' : value)
        return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
      }
      const lines = ['Symbol,Market,Name,Tags,Favorite,Price,Change,Change %,Time,Cost,Shares,Value,Open P&L,Today']
      for (const row of rows || []) {
        const quote = row.quote || {}
        const cost = costOf(costs, row)
        const position = positionOf(quote, cost)
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
            cost ? String(cost.price) : '',
            cost ? String(cost.shares) : '',
            position ? String(Math.round(position.value * 100) / 100) : '',
            position ? String(Math.round(position.pnl * 100) / 100) : '',
            position ? String(Math.round(position.today * 100) / 100) : '',
          ]
            .map(cell)
            .join(','),
        )
      }
      return lines.join('\r\n')
    }

    function WatchlistCard({ rows, onOpen, onRemove, onFavorite, onMove, onRefresh, loading, error, browseMode, onToggleBrowse, identity, alerts, costs, autoRefresh, onToggleAutoRefresh }) {
      const { t } = useT()
      // The import below replays the holdings it finds into this same store.
      const [, setCost] = useCosts()
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
      // A position total is only honest within one currency, so the header keeps
      // one line per currency that actually holds a position instead of
      // inventing an exchange rate between them.
      const totals = portfolioTotals(rows, costs)
      // The brief reads the watchlist; a position missing from the list is
      // missing from every suggestion, however large it is.
      const drivers = dayDrivers(rows, costs)
      const orphans = orphanHoldings(rows, costs)
      const [history, setHistory] = useState(() => readHistory())
      const [openSeries, setOpenSeries] = useState(null)
      // The series only grows while someone is looking at the panel, and the row
      // says so: a quiet gap is missing sampling, not a flat market.
      const historySig = totals.map((bucket) => `${bucket.currency}:${Math.round(bucket.value)}`).join('|')
      useEffect(() => {
        if (!totals.length) return
        const current = readHistory()
        let next = current
        for (const bucket of totals) next = recordHistory(next, bucket.currency, bucket.value)
        if (next === current) return
        writeHistory(next)
        setHistory(next)
      }, [historySig])
      let viewRows = sort
        ? rows
            .slice()
            .sort((a, b) => {
              // Symbol sort reads the row's own ticker, not a quote field: the
              // code column has meaning even for a row without a live quote.
              if (sort.key === 'symbol') return String(a.symbol).localeCompare(String(b.symbol)) * sort.dir
              // 1.1: open P&L is computed from the local cost basis instead of
              // being read off the quote, so it is resolved per row before the
              // comparison. A row without a position sinks exactly like a row
              // without a live quote — sorting must never invent a flat 0%.
              // Nothing scheduled is not "day zero": rows with no event in the
              // loaded window sink, the same way rows without a quote do.
              if (sort.key === 'event') {
                const va = eventDaysOf(a, earnings)
                const vb = eventDaysOf(b, earnings)
                if (va === null && vb === null) return 0
                if (va === null) return 1
                if (vb === null) return -1
                return (va - vb) * sort.dir
              }
              // Today's money sorts by what the session did to the position,
              // which is the question a morning glance asks; P&L answers the
              // other one (where the holding stands against its cost).
              if (sort.key === 'today') {
                const va = todayOf(a, costs)
                const vb = todayOf(b, costs)
                if (va === null && vb === null) return 0
                if (va === null) return 1
                if (vb === null) return -1
                return (va - vb) * sort.dir
              }
              if (sort.key === 'pnl') {
                const pa = positionOf(a.quote, costOf(costs, a))
                const pb = positionOf(b.quote, costOf(costs, b))
                const va = pa && isNum(pa.pct) ? pa.pct : null
                const vb = pb && isNum(pb.pct) ? pb.pct : null
                if (va === null && vb === null) return 0
                if (va === null) return 1
                if (vb === null) return -1
                return (va - vb) * sort.dir
              }
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
      const hasEvents = viewRows.some((row) => eventDaysOf(row, earnings) !== null)
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
      // Keyboard walking follows the order the list is actually drawn in, which
      // means it has to apply the same bucket re-sort; otherwise the highlight
      // and the row under it disagree once grouping is on.
      const groupOn = grouped && !sort && !starOnly && !tagFilter
      const groupLabelOf = (item) =>
        Array.isArray(item.tags) && item.tags.length ? item.tags[0] : t('Ungrouped')
      const [collapsed, setCollapsed] = useState(readCollapsedGroups)
      const foldable = groupOn ? Array.from(new Set(viewRows.map(groupLabelOf))) : []
      const allFolded = foldable.length > 0 && foldable.every((label) => collapsed.includes(label))
      const toggleAllGroups = () => {
        const next = allFolded ? [] : foldable
        writeCollapsedGroups(next)
        setCollapsed(next)
      }
      const toggleGroup = (label) => {
        setCollapsed((current) => {
          const next = toggleInList(current, label)
          writeCollapsedGroups(next)
          return next
        })
      }
      const navRows = groupOn
        ? viewRows.slice().sort((a, b) => {
            const qa = a.quote && isNum(a.quote.changePct) ? a.quote.changePct : null
            const qb = b.quote && isNum(b.quote.changePct) ? b.quote.changePct : null
            if (qa === null && qb === null) return 0
            if (qa === null) return 1
            if (qb === null) return -1
            return qb - qa
          }).filter((item) => !collapsed.includes(groupLabelOf(item)))
        : viewRows
      const [navIndex, setNavIndex] = useState(-1)
      const navRow = navIndex >= 0 && navIndex < navRows.length ? navRows[navIndex] : null
      useEffect(() => {
        function onKey(event) {
          if (!event || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
          const target = event.target
          const tag = target && target.tagName
          // The caret owns the arrow keys while someone is typing a price or a ticker.
          if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!navRows.length) return
            event.preventDefault()
            setNavIndex((current) => nextNavIndex(current, navRows.length, event.key === 'ArrowDown' ? 1 : -1))
            return
          }
          if (event.key === 'Enter' && navRow) {
            event.preventDefault()
            onOpen(navRow)
          }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [navRows, navRow, onOpen])
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
      // Asking for notification permission is only worth doing from a click, so
      // the chip below is the only place that triggers the browser prompt.
      const [notifyState, setNotifyState] = useState(() => (notificationsSupported() ? window.Notification.permission : 'unsupported'))
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
          // The route only restores rows, so the holding columns are not sent
          // to it — they are replayed into the local store below.
          const rowsForServer = entries.map((entry) => ({ symbol: entry.symbol, market: entry.market, name: entry.name, tags: entry.tags, isFavorite: entry.isFavorite }))
          const report = await apiPost('/watchlist/import', { items: rowsForServer })
          const value = report && typeof report === 'object' ? report : {}
          const restored = value.added != null ? value.added : Math.max(0, entries.length)
          const rejected = Array.isArray(value.failed) ? value.failed : []
          let positions = 0
          for (const entry of entries) {
            if (!entry || !entry.symbol) continue
            const price = boundOf(entry.cost)
            const shares = boundOf(entry.shares)
            if (price === null && shares === null) continue
            setCost({ symbol: entry.symbol, market: entry.market || 'US' }, { price, shares })
            positions += 1
          }
          setImportReport({ restored, rejected, positions })
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
          id: 'tm-watchlist-card',
          right: h(
            'div',
            { className: 'tm-card__tools' },
            // The toggle says what it does in both directions: on is a promise
            // about the next minute, off is a promise that nothing moves
            // without a click. Neither direction is a silent default.
            onToggleAutoRefresh
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost tm-auto' + (autoRefresh ? ' tm-auto--on' : ''),
                    onClick: onToggleAutoRefresh,
                    title: t(autoRefresh ? 'Quotes reload every minute while this tab is visible' : 'Quotes only reload when you ask'),
                    'aria-pressed': autoRefresh ? 'true' : 'false',
                  },
                  t('Auto refresh'),
                )
              : null,
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
            // Folding one bucket at a time is slow on a long list; the chip
            // flips every bucket at once and reads as whichever is next.
            foldable.length > 1
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost',
                    onClick: toggleAllGroups,
                    title: allFolded ? t('Unfold every group') : t('Fold every group'),
                  },
                  allFolded ? t('Unfold all') : t('Fold all'),
                )
              : null,
            // An earnings date is not a column, so it sorts from a chip too;
            // the chip only appears when something on the list has one.
            hasEvents
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost' + (sort && sort.key === 'event' ? ' tm-btn--active' : ''),
                    onClick: () => toggleSort('event'),
                    title: t('Sort by the next earnings date (click again to reverse, a third click restores your order)'),
                  },
                  h(Icon, { name: 'calendar' }),
                  t('By event'),
                )
              : null,
            // 1.1: open P&L comes from the local cost basis rather than from a
            // quote column, so it sorts from a chip instead of a table header;
            // the chip only appears once something on the list is a position.
            totals.length
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost' + (sort && sort.key === 'pnl' ? ' tm-btn--active' : ''),
                    onClick: () => toggleSort('pnl'),
                    title: t('Sort by open P&L (click again to reverse, a third click restores your order)'),
                  },
                  h(Icon, { name: 'chart' }),
                  t('By P&L'),
                )
              : null,
            totals.length
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost' + (sort && sort.key === 'today' ? ' tm-btn--active' : ''),
                    onClick: () => toggleSort('today'),
                    title: t('Sort by what today did to the position (click again to reverse, a third click restores your order)'),
                  },
                  h(Icon, { name: 'chart' }),
                  t('By day'),
                )
              : null,
            notifyState === 'default'
              ? h(
                  'button',
                  {
                    className: 'tm-btn tm-btn--ghost',
                    title: t('Send a desktop notification while this tab is in the background'),
                    onClick: () => {
                      const ask = window.Notification.requestPermission()
                      if (ask && typeof ask.then === 'function') ask.then((next) => setNotifyState(next))
                      else setNotifyState(window.Notification.permission)
                    },
                  },
                  h(Icon, { name: 'bell' }),
                  t('Notify me'),
                )
              : null,
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost',
                // 1.1: the saved list leaves the plugin as a spreadsheet-ready
                // file — BOM first so Excel opens UTF-8 Chinese names directly.
                onClick: () => {
                  const blob = new Blob(['\ufeff' + watchlistCsv(rows, costs)], { type: 'text/csv;charset=utf-8' })
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
              importReport.positions ? ' ' + t('{n} positions restored from the file.', { n: importReport.positions }) : '',
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
        drivers
          ? h(
              'div',
              { className: 'tm-day', title: t('What the day did to the book, and which positions did it.') },
              h('span', { className: 'tm-day__k' }, t('Today {amount}', { amount: signed(drivers.today, 2) })),
              drivers.up
                ? h('span', { className: 'tm-day__item' }, t('best {sym} {amount}', { sym: drivers.up.symbol, amount: signed(drivers.up.today, 2) }))
                : null,
              drivers.down
                ? h('span', { className: 'tm-day__item' }, t('worst {sym} {amount}', { sym: drivers.down.symbol, amount: signed(drivers.down.today, 2) }))
                : null,
            )
          : null,
        orphans.length
          ? h(
              'div',
              {
                className: 'tm-orphan',
                title: t('The brief only reads the watchlist, so these positions never appear in it.'),
              },
              h('span', { className: 'tm-orphan__k' }, t('Held but not on the watchlist')),
              orphans.map((entry) =>
                h(
                  'button',
                  {
                    key: entry.key,
                    type: 'button',
                    className: 'tm-orphan__btn',
                    onClick: () => onOpen({ symbol: entry.symbol, market: entry.market }),
                  },
                  entry.symbol,
                ),
              ),
            )
          : null,
        totals.length
          ? h(
              'div',
              { className: 'tm-portfolio' },
              totals.map((bucket) => {
                const trend = historyChange(history[bucket.currency])
                const trendLine = historyPoints(history[bucket.currency])
                return h(
                  'span',
                  { className: 'tm-portfolio__item' + (bucket.pnl === 0 ? '' : ' ' + trendClass(bucket.pnl)) },
                  h('span', { className: 'tm-portfolio__k' }, t('{n} positions', { n: bucket.count })),
                  h('span', { className: 'tm-portfolio__v' }, money(bucket.value, bucket.currency)),
                  h('span', { className: 'tm-portfolio__pnl' }, `${signed(bucket.pnl, 2)}${bucket.basis > 0 ? ` (${percent((bucket.pnl / bucket.basis) * 100)})` : ''}`),
                  bucket.counted
                    ? h(
                        'span',
                        { className: 'tm-portfolio__today' + (bucket.today === 0 ? '' : ' ' + trendClass(bucket.today)), title: t('Change since the previous close, across these positions') },
                        `${t('today')} ${signed(bucket.today, 2)}`,
                      )
                    : null,
                  trend
                    ? (() => {
                        const open = openSeries === bucket.currency;
                        const wide = open ? historyPoints(history[bucket.currency], 240, 48) : null;
                        const toggle = () => setOpenSeries(open ? null : bucket.currency);
                        return h(
                          'span',
                          {
                            className: 'tm-portfolio__trend' + (trend.change === 0 ? '' : ' ' + trendClass(trend.change)) + (open ? ' tm-portfolio__trend--open' : ''),
                            title: t('Change over the last {n} days, recorded while this panel was open', { n: trend.days }),
                            role: trendLine ? 'button' : null,
                            tabIndex: trendLine ? 0 : null,
                            'aria-expanded': trendLine ? (open ? 'true' : 'false') : null,
                            onClick: trendLine ? toggle : null,
                            onKeyDown: trendLine
                              ? (event) => {
                                  if (event.key !== 'Enter' && event.key !== ' ') return;
                                  event.preventDefault();
                                  toggle();
                                }
                              : null,
                          },
                          `${t('{n}d', { n: trend.days })} ${percent(trend.pct)}`,
                          trendLine
                            ? h(
                                'svg',
                                {
                                  viewBox: open ? '0 0 240 48' : '0 0 56 14',
                                  width: open ? 240 : 56,
                                  height: open ? 48 : 14,
                                  'aria-hidden': 'true',
                                  focusable: 'false',
                                },
                                h('polyline', { points: (wide || trendLine).points, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
                              )
                            : null,
                        );
                      })()
                    : !trend && Array.isArray(history[bucket.currency]) && history[bucket.currency].length === 1
                      ? h(
                          'span',
                          { className: 'tm-portfolio__trend tm-portfolio__trend--first', title: t('A change appears once two days have been recorded') },
                          t('recording…'),
                        )
                      : null,
                )
              }),
            )
          : null,
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
                const entries = []
                // 1.1: the bucket header carries its size ("核心仓 · 4") and, since
                // 1.2, folds the bucket away — a long watchlist should be able to
                // hide the half you are not looking at.
                const drawRow = (item, index) =>
                  h(WatchRow, {
                    key: item.symbol,
                    earnings: earnings.data,
                    alert: alertOf(alerts, item),
                    item,
                    index,
                    count: navRows.length,
                    onOpen,
                    onRemove,
                    onFavorite,
                    onTag: setTagFilter,
                    cost: costOf(costs, item),
                    weight: positionWeight(positionOf(item.quote, costOf(costs, item)), totals),
                    nav: navRow === item,
                    onMove: sort || starOnly || tagFilter || groupOn ? null : onMove,
                  })
                if (groupOn) {
                  const labels = []
                  for (const item of viewRows) {
                    const label = groupLabelOf(item)
                    if (!labels.includes(label)) labels.push(label)
                  }
                  for (const label of labels) {
                    const size = viewRows.filter((item) => groupLabelOf(item) === label).length
                    const closed = collapsed.includes(label)
                    entries.push(
                      h(
                        'li',
                        { key: `group:${label}`, className: 'tm-list__group' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'tm-list__groupbtn' + (closed ? ' tm-list__groupbtn--closed' : ''),
                            onClick: () => toggleGroup(label),
                            title: closed ? t('Show these rows') : t('Hide these rows'),
                            'aria-expanded': closed ? 'false' : 'true',
                          },
                          h('span', { className: 'tm-list__chev', 'aria-hidden': 'true' }, closed ? '\u25b8' : '\u25be'),
                          `${label} · ${size}`,
                        ),
                      ),
                    )
                    if (closed) continue
                    navRows.forEach((item, index) => {
                      if (groupLabelOf(item) === label) entries.push(drawRow(item, index))
                    })
                  }
                } else {
                  navRows.forEach((item, index) => entries.push(drawRow(item, index)))
                }
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

    function BriefCard({ brief, sectors, positions, held, onRun, loading, error, aiAvailable, aiReason, onOpen }) {
      const [copied, setCopied] = useState(false)
      const [copiedAll, setCopiedAll] = useState(false)
      const { t, lang } = useT()
      return h(
        Card,
        {
          title: t('AI Watchlist Brief'),
          id: 'tm-brief-card',
          right: h(
            'div',
            { className: 'tm-card__tools' },
            // The full brief is worth pasting somewhere; the per-section copy
            // below only carries the checklist. Silent on failure: copying is a
            // convenience, not something the card depends on.
            brief
              ? h('button', {
                className: 'tm-btn tm-btn--ghost',
                type: 'button',
                title: t('Copy the whole brief as text'),
                onClick: () => {
                  const lines = briefLines(brief, positions, t, lang)
                  if (!lines.length) return
                  navigator.clipboard?.writeText(lines.join('\n')).then(() => {
                    setCopiedAll(true)
                    setTimeout(() => setCopiedAll(false), 1500)
                  }).catch(() => {})
                },
              }, copiedAll ? t('Copied') : t('Copy brief'))
              : null,
            // The rule-written edition needs no model, so the button stays live without
            // one; only an in-flight request blocks it.
            h('button', { className: 'tm-btn', onClick: onRun, disabled: loading }, loading ? t('Analysing…') : t('Generate Brief')),
          ),
        },
        !aiAvailable
          ? h(
              'div',
              { className: 'tm-hint' },
              t('DeepSeek is not available in this DSH session, so Generate Brief writes a rule-based edition: the same counts, movers, volume and derived action list, with no model in the loop.'),
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
              // A brief the rules wrote must not read like a model's judgement:
              // the mark sits under the headline, before any number is read.
              brief.local
                ? h('p', {
                  className: 'tm-brief__local',
                  title: t('Written by the plugin from the same numbers; no model was involved.'),
                }, t('Rules only'))
                : null,
              // A brief whose numbers are hours old reads differently; the stamp
              // sits right under the headline so the age is never guessed.
              brief.generatedAt && briefWhen(brief.generatedAt)
                ? h('p', { className: 'tm-brief__when' },
                  t('Generated {time}', { time: briefWhen(brief.generatedAt) }),
                  // An old brief is still factual, but the numbers behind it
                  // have moved; the quiet hint points back at the button
                  // instead of silently aging in place.
                  Date.now() - Date.parse(brief.generatedAt) > 30 * 60 * 1000
                    ? h('span', { className: 'tm-brief__age' }, '　·　', t('The brief is over 30 minutes old; regenerate it before relying on the numbers.'))
                    : null,
                )
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
                      brief.suggestions.map((line, i) => {
                        // A line that opens with a ticker is about that name;
                        // saying whether it is already held turns "watch this"
                        // into "this one touches your account".
                        const lead = /^([A-Z][A-Z0-9.\-]{0,6})\b/.exec(line)
                        const owned = Boolean(lead && held instanceof Set && held.has(lead[1]))
                        return h(
                          'li',
                          { key: i },
                          h('span', { key: 'n', className: 'tm-brief__n' }, String(i + 1)),
                          owned
                            ? h('span', { key: 'h', className: 'tm-brief__hold', title: t('This idea concerns a position you hold') }, t('Held'))
                            : null,
                          h('span', { key: 't', className: 'tm-brief__action-text' }, observationNodes(line, 'a' + i, onOpen)),
                        )
                      }),
                    ),
                  )
                : null,
              (positions || []).length
                ? h(
                    'section',
                    { className: 'tm-brief__block tm-brief__block--own' },
                    h(
                      'h4',
                      { className: 'tm-brief__label' },
                      t('Your positions (local)'),
                      h('span', { className: 'tm-brief__own-note' }, t('computed from the cost basis on this device')),
                    ),
                    h(
                      'ul',
                      { className: 'tm-brief__list' },
                      capPositions(positions).shown.map((line, i) => h('li', { key: i }, observationNodes(line, 'own' + i, onOpen))),
                      capPositions(positions).hidden
                        ? h('li', { key: 'more', className: 'tm-brief__more' }, t('{n} more positions', { n: capPositions(positions).hidden }))
                        : null,
                    ),
                  )
                : null,
              h('p', { className: 'tm-disclaimer' }, t('These are watchlist stocks, not portfolio holdings. Not financial advice.')),
            )
          : h('div', { className: 'tm-hint' }, t('Generate a brief: what moved, where each stock stands, and which levels to watch next.')),
      )
    }

    // ------------------------------------------------------------------ status
    // ------------------------------------------------------------ session clock
    /**
     * US session phase from the wall clock in New York. The panel serves a
     * delayed research snapshot, so every card already stamps the print time —
     * the missing context is *which part of the trading day* those prints belong
     * to. Phases follow NYSE regular hours (09:30–16:00 ET) with the pre/post
     * windows some providers still publish into; weekends are closed.
     *
     * `closures` (optional) is the verified NYSE table from `GET /closures`: a
     * full-day row makes the day closed whatever the hour, and a row carrying a
     * `close` time (13:00 ET before Thanksgiving / Christmas) ends the regular
     * session early. Without the table the weekday-only answer stands, so a slow
     * or failed fetch degrades to the old chip instead of inventing a holiday.
     */
    function usSessionInfo(at, closures) {
      if (!(at instanceof Date) || Number.isNaN(at.getTime())) return null
      const parts = {}
      try {
        for (const p of new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York',
          hour12: false,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          weekday: 'short',
        }).formatToParts(at)) parts[p.type] = p.value
      } catch (_) {
        return null
      }
      // Some engines emit "24" for midnight under hour12:false — normalise it.
      const hourText = parts.hour === '24' ? '0' : parts.hour
      const clock = `${hourText.padStart(2, '0')}:${parts.minute}`
      const day = `${parts.year}-${parts.month}-${parts.day}`
      const list = Array.isArray(closures) ? closures : null
      const closure = list ? list.find((row) => row && row.date === day) || null : null
      if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return { phase: 'closed', clock, closure }
      // A published full-day closure: no hour of the day is open or pre-market.
      if (closure && !closure.close) return { phase: 'closed', clock, closure }
      const minutes = Number(hourText) * 60 + Number(parts.minute)
      const earlyText = closure && closure.close ? String(closure.close) : null
      const earlyCut = earlyText ? Number(earlyText.slice(0, 2)) * 60 + Number(earlyText.slice(3, 5) || 0) : null
      const closeAt = Number.isFinite(earlyCut) && earlyCut > 0 ? earlyCut : 16 * 60
      if (minutes < 4 * 60) return { phase: 'closed', clock, closure }
      if (minutes < 9 * 60 + 30) return { phase: 'pre', clock, closure }
      if (minutes < closeAt) return { phase: 'open', clock, closure }
      if (minutes < 20 * 60) return { phase: 'post', clock, closure, earlyClose: closeAt < 16 * 60 }
      return { phase: 'closed', clock, closure }
    }

    /**
     * A small chip in the header: `● US open 14:23`. Recomputed every 30 s;
     * the NYSE closure table (full-day holidays and 13:00 ET early closes) is
     * fetched once per mount, so the chip can read `NYSE closed · 感恩节`
     * instead of claiming a live tape on Thanksgiving. A runtime without Intl
     * timezone support renders nothing rather than guessing a wrong phase.
     */
    function MarketClock() {
      const { t, lang } = useT()
      const [now, setNow] = useState(null)
      const closures = useAsync((signal) => apiGet('/closures?days=400', signal), [])
      useEffect(() => {
        setNow(new Date())
        const id = setInterval(() => setNow(new Date()), 30000)
        return () => clearInterval(id)
      }, [])
      const table = closures.data && Array.isArray(closures.data.closures) ? closures.data.closures : null
      const info = usSessionInfo(now, table)
      if (!info) return null
      const label = info.phase === 'open' ? t('NYSE open') : info.phase === 'pre' ? t('pre-market') : info.phase === 'post' ? t('after close') : t('NYSE closed')
      const named = info.closure ? (lang === 'zh' ? info.closure.nameZh : info.closure.name) : null
      const holiday = Boolean(info.closure && !info.closure.close)
      const early = info.earlyClose && info.closure ? String(info.closure.close) : null
      const hint = holiday
        ? t('New York {time} · NYSE holiday: {name}', { time: info.clock, name: named })
        : early
          ? t('New York {time} · early close at {close} ET: {name}', { time: info.clock, close: early, name: named })
          : t('New York {time} · regular hours 09:30–16:00 ET; NYSE holidays and early closes included', { time: info.clock })
      return h(
        'span',
        {
          className: 'tm-session tm-session--' + info.phase + (holiday ? ' tm-session--holiday' : ''),
          title: hint,
        },
        h('span', { className: 'tm-session__dot' }),
        label,
        holiday && named ? h('span', { className: 'tm-session__note' }, named) : null,
        early ? h('span', { className: 'tm-session__note' }, t('early close {close} ET', { close: early })) : null,
        h('span', { className: 'tm-session__clock' }, info.clock),
      )
    }

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

    /**
     * The technical grid as one readable line. Nineteen cells answer "what are
     * the numbers"; this answers "so what do they add up to" without pretending
     * to be a call: trend, stretch, distance from the high, and volume, in the
     * order a reader would check them. Returns '' when the block is empty, so a
     * row of symbols nobody has indicators for stays quiet.
     * @param {any} tech the §31 technical block
     * @param {number} price the last price, for the distance to the high
     * @param {(text: string, vars?: object) => string} [t] translator
     */
    function technicalDigest(tech, price, t) {
      if (!tech) return ''
      const tr = typeof t === 'function' ? t : makeT('en')
      const parts = []
      if (tech.trendAlignment === 'bullish') parts.push(tr('moving averages stacked up'))
      else if (tech.trendAlignment === 'bearish') parts.push(tr('stacked down'))
      else if (tech.trendAlignment) parts.push(tr('averages tangled'))
      if (isNum(tech.rsi14)) {
        const rsi = plain(tech.rsi14, 0)
        if (tech.rsi14 >= 70) parts.push(tr('RSI {v} stretched', { v: rsi }))
        else if (tech.rsi14 <= 30) parts.push(tr('RSI {v} washed out', { v: rsi }))
        else parts.push(tr('RSI {v}', { v: rsi }))
      }
      if (isNum(price) && isNum(tech.high52w) && tech.high52w > 0) {
        const below = (tech.high52w - price) / tech.high52w
        // A distance is not a change: no leading plus, or the line reads like a
        // gain when the number is the amount still missing.
        const gap = plain(Math.max(below, 0) * 100, 1) + '%'
        if (below <= 0.02) parts.push(tr('within {pct} of its 52-week high', { pct: gap }))
        else parts.push(tr('{pct} below its 52-week high', { pct: gap }))
      }
      if (isNum(tech.volumeRatio20d)) {
        const ratio = plain(tech.volumeRatio20d, 1) + '×'
        if (tech.volumeRatio20d >= 1.8) parts.push(tr('{n} normal volume', { n: ratio }))
        else if (tech.volumeRatio20d <= 0.6) parts.push(tr('{n} quiet volume', { n: ratio }))
      }
      return parts.join(' · ')
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
    /** The next earnings event for one ticker, or null when the window has none. */
    function nextEarningsEvent(windowData, symbol) {
      const event = windowData && windowData.bySymbol ? windowData.bySymbol[String(symbol).toUpperCase()] : null
      if (!event) return null
      return { event, days: daysBetween(event.date, windowData.today || event.date) }
    }

    function nextEarnings(windowData, symbol, translator) {
      const found = nextEarningsEvent(windowData, symbol)
      if (!found) return null
      const tr = typeof translator === 'function' ? translator : makeT('en')
      const event = found.event
      const days = found.days
      const when = days === null ? '' : days <= 0 ? tr('today') : days === 1 ? tr('tomorrow') : tr('in {n} days', { n: days })
      const soon = days !== null && days >= 0 && days <= 7
      return h(
        'div',
        {
          className: 'tm-earn' + (soon ? ' tm-earn--soon' : ''),
          title: tr('A report lands all at once: the number, the guide and the reaction. The gap is usually decided after the close.'),
        },
        h('span', { className: 'tm-earn__label' }, tr('Next earnings')),
        h('span', { className: 'tm-earn__date' }, `${monthDay(event.date)} ${sessionLabel(event.session, tr)}`),
        when ? h('span', { className: 'tm-earn__when' }, when) : null,
        event.epsForecast == null ? null : h('span', { className: 'tm-earn__eps' }, `${tr('EPS est.')} ${money(event.epsForecast, 'USD')}${event.analysts ? ` · ${tr('{n} analysts', { n: event.analysts })}` : ''}`),
      )
    }

    /**
     * Ex-dividend countdown. The Market data cell already carries the date; what
     * a date cannot say is the rule that makes it actionable: shares bought on
     * or after that day do not carry the payment, and the price opens lower by
     * roughly it. Past dates stay silent — the cell still shows the history.
     */
    function nextExDividend(profile, translator) {
      const tr = typeof translator === 'function' ? translator : makeT('en')
      const at = profile && profile.exDividendDate
      if (!isNum(at)) return null
      const when = relativeDayOf(at, tr)
      if (!when) return null
      return h(
        'div',
        {
          className: 'tm-earn',
          title: tr('Shares bought on or after this date do not carry the dividend, and the price opens lower by roughly the payment.'),
        },
        h('span', { className: 'tm-earn__label' }, tr('Ex-dividend')),
        h('span', { className: 'tm-earn__date' }, dateOfUtc(at)),
        h('span', { className: 'tm-earn__when' }, when),
        h('span', { className: 'tm-earn__eps' }, tr('own it before this day to collect')),
      )
    }

    /**
     * The detail page answers "what happens to this name next", so the dated
     * events it knows are shown in the order they arrive — an ex-dividend
     * tomorrow outranks a report three weeks out — instead of the order the
     * code happens to call them in.
     */
    /**
     * The profile's sector, as the SPDR ETF that tracks it. A stock's day is
     * read against its group before it is read on its own: -1.2% is strength
     * when the group is down 2%, and weakness when the group is up 0.5%. The
     * label doubles as the i18n key (the dict already carries the sector
     * names used by the fund exposure table).
     */
    const SECTOR_ETF = {
      Technology: ['XLK', 'Technology'],
      'Communication Services': ['XLC', 'Communication services'],
      'Consumer Cyclical': ['XLY', 'Consumer cyclical'],
      'Consumer Defensive': ['XLP', 'Consumer defensive'],
      Energy: ['XLE', 'Energy'],
      'Financial Services': ['XLF', 'Financial services'],
      Healthcare: ['XLV', 'Healthcare'],
      Industrials: ['XLI', 'Industrials'],
      Utilities: ['XLU', 'Utilities'],
      'Basic Materials': ['XLB', 'Basic materials'],
      'Real Estate': ['XLRE', 'Real estate'],
    }

    /**
     * The detail page is reached from search as often as from the list, so it
     * has to answer "do I own this and at what price" without a trip back to
     * the watchlist. Zero shares is a placeholder, not a position.
     */
    function holdingBadge(cost) {
      if (!cost || !isNum(cost.shares) || cost.shares <= 0) return null
      if (!isNum(cost.price) || cost.price <= 0) return null
      return { shares: cost.shares, price: cost.price }
    }

    function sectorTileOf(profile) {
      const raw = profile && typeof profile.sector === 'string' ? profile.sector.trim() : ''
      if (!raw) return null
      const direct = SECTOR_ETF[raw]
      if (direct) return { symbol: direct[0], label: direct[1] }
      // The provider is not strict about case or spacing ("Financial services").
      const norm = raw.toLowerCase().replace(/[^a-z]/g, '')
      for (const [key, value] of Object.entries(SECTOR_ETF)) {
        if (key.toLowerCase().replace(/[^a-z]/g, '') === norm) return { symbol: value[0], label: value[1] }
      }
      return null
    }

    /**
     * Twenty sessions of a name against its sector. One day answers "what
     * happened"; the same window answers "is this name being bought inside a
     * moving group, or sold inside a falling one" — the difference between a
     * dip and a breakdown. Returns null unless BOTH series cover the window, so
     * a short chart never prints a comparison it cannot back.
     */
    function relativeStrength(stockBars, sectorBars, window = 20) {
      const closesOf = (bars) =>
        (Array.isArray(bars) ? bars : [])
          .map((bar) => (bar && isNum(bar.close) ? bar.close : null))
          .filter((close) => close !== null)
      const stock = closesOf(stockBars)
      const sector = closesOf(sectorBars)
      if (stock.length <= window || sector.length <= window) return null
      const pctOf = (series) => {
        const first = series[series.length - 1 - window]
        if (!(first > 0)) return null
        return ((series[series.length - 1] - first) / first) * 100
      }
      const stockPct = pctOf(stock)
      const sectorPct = pctOf(sector)
      if (!isNum(stockPct) || !isNum(sectorPct)) return null
      return { window, stockPct, sectorPct, gap: stockPct - sectorPct }
    }

    function upcomingStrips(windowData, profile, symbol, translator) {
      const rows = []
      const found = nextEarningsEvent(windowData, symbol)
      if (found) rows.push({ days: found.days == null ? 9999 : found.days, node: nextEarnings(windowData, symbol, translator) })
      const exDiv = nextExDividend(profile, translator)
      if (exDiv) {
        const ms = epochOf(profile.exDividendDate)
        const days = ms ? Math.round((Math.floor(ms / 86_400_000) - Math.floor(Date.now() / 86_400_000))) : 9999
        rows.push({ days, node: exDiv })
      }
      rows.sort((a, b) => a.days - b.days)
      return rows.map((row) => row.node)
    }

    /**
     * Rating mix as proportional segments. Zero buckets are dropped rather than
     * drawn at zero width: an empty "sell" slice reads as "nobody sells", which
     * is a different claim from "nobody covers".
     */
    function ratingMix(ratings) {
      const trend = ratings && ratings.trend
      if (!trend || !isNum(trend.total) || trend.total <= 0) return null
      const buckets = [
        ['strongBuy', 'Strong buy'],
        ['buy', 'Buy'],
        ['hold', 'Hold'],
        ['sell', 'Sell'],
        ['strongSell', 'Strong sell'],
      ]
      const segments = buckets
        .map(([key, label]) => ({ key, label, count: isNum(trend[key]) ? trend[key] : 0 }))
        .filter((row) => row.count > 0)
        .map((row) => ({ ...row, pct: (row.count / trend.total) * 100 }))
      return segments.length ? { total: trend.total, segments } : null
    }

    /**
     * Grade changes worth reading. A "maintain" that kept the same grade is a
     * restatement — the firm re-signed its own number — so it stays out unless
     * the wording itself moved ("Buy" → "Strong Buy" is a real change even when
     * the action field says maintain). Old records age out after six months.
     */
    function ratingChanges(ratings, now) {
      const list = ratings && Array.isArray(ratings.changes) ? ratings.changes : []
      const at = isNum(now) ? now : Date.now()
      return list
        .filter((row) => row && row.firm && isNum(row.at))
        .filter((row) => row.action !== 'main' || (row.from && row.to && row.from !== row.to))
        .filter((row) => at - row.at <= 180 * 86_400_000)
        .sort((left, right) => right.at - left.at)
        .slice(0, 4)
        .map((row) => ({ ...row, days: Math.max(0, Math.round((at - row.at) / 86_400_000)) }))
    }

    /**
     * "Macro print" strip for the detail view. Only the releases inside the
     * next three days are worth a position-timing warning (the home card owns
     * the wider window); otherwise nothing renders, exactly like nextEarnings.
     */
    function nextMacro(windowData, translate) {
      const events = (windowData && windowData.events) || []
      const release = events.find((event) => event.days != null && event.days >= 0 && event.days <= 3)
      if (!release) return null
      const when = release.days === 0 ? translate('today') : release.days === 1 ? translate('tomorrow') : translate('in {n} days', { n: release.days })
      return h(
        'div',
        { className: 'tm-earn tm-earn--soon' },
        h('span', { className: 'tm-earn__label' }, translate('Macro print')),
        h('span', { className: 'tm-earn__date' }, `${translate(MACRO_KINDS[release.kind] || release.kind)} · ${monthDay(release.date)} · ${release.time} ET`),
        when ? h('span', { className: 'tm-earn__when' }, when) : null,
        release.ref ? h('span', { className: 'tm-earn__eps' }, release.ref) : null,
      )
    }

    function DetailView({ symbol, market, onBack, onOpen, aiAvailable, aiReason }) {
      const { ui, lang, t } = useT()
      const range = ui.range || '6mo'
      // Weekly bars only where they are legible; every other range keeps the
      // interval its range implies.
      const barSize = ui.barSize === 'week' && WEEKLY_RANGES[range] ? '1wk' : RANGE_INTERVAL[range] || '1d'
      const [tv, setTv] = useState(ui.tv)
      const [analysis, setAnalysis] = useState(null)
      const [analysisError, setAnalysisError] = useState(null)
      const [analysisMeta, setAnalysisMeta] = useState(null)
      const [analysing, setAnalysing] = useState(false)
      const [question, setQuestion] = useState('')

      // Index symbols leave the equity quote path: they carry a catalogue entry
      // with a localised name and, for rates, a unit ("4.86%" is a yield, not a
      // price). One filtered catalogue call answers that from any entry point --
      // a tile, a watchlist row, a search hit or a cross-link.
      const indexish = /^\^/.test(symbol) || /^DX-Y\.NYB$/i.test(symbol)
      const indexMeta = useAsync(
        (signal) => (indexish ? apiGet(`/indices?symbols=${encodeURIComponent(symbol)}`, signal) : Promise.resolve(null)),
        [symbol],
      )
      const indexRow = (() => {
        const list = indexMeta.data && Array.isArray(indexMeta.data.items) ? indexMeta.data.items : []
        return list.find((row) => String(row.symbol).toUpperCase() === symbol.toUpperCase()) || null
      })()
      const unit = indexRow && indexRow.unit ? String(indexRow.unit) : ''
      const indexName = indexRow ? (lang === 'zh' ? indexRow.nameZh || indexRow.name : indexRow.name) : null
      const proxyFund = PROXY_ETF[String(symbol).toUpperCase()] || null

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
      // 1.2: the alert editor keeps both bounds as text drafts — a half-typed
      // number must not be coerced into a live bound on every keystroke. The
      // drafts follow the symbol and the stored alert, so ←/→ navigation lands
      // on the next name's own bounds instead of carrying the previous one over.
      const [alerts, setAlert] = useAlerts()
      const myAlert = alertOf(alerts, { symbol, market: hint })
      const storedKey = `${myAlert && myAlert.above != null ? myAlert.above : ''}|${myAlert && myAlert.below != null ? myAlert.below : ''}|${myAlert && myAlert.loss != null ? myAlert.loss : ''}|${myAlert && myAlert.move != null ? myAlert.move : ''}`
      const [alertAbove, setAlertAbove] = useState(() => (myAlert && myAlert.above != null ? String(myAlert.above) : ''))
      const [alertBelow, setAlertBelow] = useState(() => (myAlert && myAlert.below != null ? String(myAlert.below) : ''))
      const [alertLoss, setAlertLoss] = useState(() => (myAlert && myAlert.loss != null ? String(myAlert.loss) : ''))
      const [alertMove, setAlertMove] = useState(() => (myAlert && myAlert.move != null ? String(myAlert.move) : ''))
      useEffect(() => {
        setAlertAbove(myAlert && myAlert.above != null ? String(myAlert.above) : '')
        setAlertBelow(myAlert && myAlert.below != null ? String(myAlert.below) : '')
        setAlertLoss(myAlert && myAlert.loss != null ? String(myAlert.loss) : '')
        setAlertMove(myAlert && myAlert.move != null ? String(myAlert.move) : '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [symbol, storedKey])
      // 1.2: the cost basis is the same kind of local note-to-self. Its drafts
      // follow the symbol too, so ←/→ never carries one position onto the next.
      const [costs, setCost] = useCosts()
      const myCost = costOf(costs, { symbol, market: hint })
      const costKey = `${myCost ? myCost.price : ''}|${myCost ? myCost.shares : ''}`
      const [costPrice, setCostPrice] = useState(() => (myCost ? String(myCost.price) : ''))
      const [costShares, setCostShares] = useState(() => (myCost ? String(myCost.shares) : ''))
      useEffect(() => {
        setCostPrice(myCost ? String(myCost.price) : '')
        setCostShares(myCost ? String(myCost.shares) : '')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [symbol, costKey])
      const qs = `?market=${encodeURIComponent(hint)}`
      const quote = useAsync((signal) => apiGet(`/quote/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      const profile = useAsync((signal) => apiGet(`/profile/${encodeURIComponent(symbol)}${qs}`, signal), [symbol, hint])
      // SEC EDGAR (US only, keyless). The route answers with an empty metric list
      // for tickers that file no XBRL company facts, so a failure here is only
      // ever a transport problem.
      const fundamentals = useAsync((signal) => apiGet(`/fundamentals/${encodeURIComponent(symbol)}`, signal), [symbol])
      const earnings = useAsync((signal) => apiGet(`/earnings?days=21&symbol=${encodeURIComponent(symbol)}`, signal), [symbol])
      // Market-wide prints: the strip only answers when something lands within
      // three days, so a 3-day window is all the card ever needs.
      const macroSoon = useAsync((signal) => apiGet('/macro?days=3', signal), [symbol])
      // Headlines are context, not a number: an empty list just hides the card.
      const [newsToday, setNewsToday] = useState(() => {
        try {
          return window.localStorage.getItem('tm-news-today') === '1'
        } catch (err) {
          return false
        }
      })
      const toggleNewsToday = () =>
        setNewsToday((on) => {
          const next = !on
          try {
            window.localStorage.setItem('tm-news-today', next ? '1' : '0')
          } catch (err) {
            // Private mode: the filter still works, it just forgets.
          }
          return next
        })
      const news = useAsync((signal) => apiGet(`/news/${encodeURIComponent(symbol)}${qs}&limit=6`, signal), [symbol, hint])
      const newsRows = newsToday && Array.isArray(news.data) ? recentNews(news.data) : (Array.isArray(news.data) ? news.data : [])
      const chart = useAsync(
        (signal) =>
          apiGet(
            `/candles/${encodeURIComponent(symbol)}?range=${range}&interval=${barSize}&market=${encodeURIComponent(hint)}`,
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
      // Same rule as the watchlist row: mirror the provider's session stamp
      // rather than infer one from the wall clock.
      const ext = data && data.extended && isNum(data.extended.price) ? data.extended : null

      const company = profile.data || {}
      // One sector ETF stands in for the group. Fetched only when the profile
      // names a sector we can map, so a fund or an unmapped industry costs
      // nothing and the line simply does not appear.
      const sectorTile = sectorTileOf(company)
      const sectorRow = useAsync(
        (signal) => (sectorTile ? apiGet(`/quotes?symbols=${sectorTile.symbol}`, signal) : Promise.resolve(null)),
        [symbol, sectorTile ? sectorTile.symbol : ''],
      )
      // The day line compares today; this series answers the same question over
      // a month, so the two can disagree and the reader sees both.
      const sectorSeries = useAsync(
        (signal) => (sectorTile ? apiGet(`/candles/${encodeURIComponent(sectorTile.symbol)}?range=6mo&interval=1d&market=US`, signal) : Promise.resolve(null)),
        [symbol, sectorTile ? sectorTile.symbol : ''],
      )
      const sectorQuote = Array.isArray(sectorRow.data) ? sectorRow.data[0] : null
      const sectorPct = sectorQuote && sectorQuote.data && isNum(sectorQuote.data.changePct) ? sectorQuote.data.changePct : null
      const sectorGap = sectorPct !== null && isNum(data && data.changePct) ? data.changePct - sectorPct : null
      // The macro table is a local file served by the host: this call costs no
      // upstream request, so the note can be available on every detail page.
      const macro = useAsync((signal) => apiGet('/macro?days=7', signal), [])
      const macroNote = macroWatchNote(macro.data, t)
      const [aboutOpen, setAboutOpen] = useState(false)
      const [digestCopied, setDigestCopied] = useState(false)
      // Whether the summary actually overflows is a question only the laid-out
      // box can answer: the same paragraph fits in three lines on a wide window
      // and needs ten on a narrow one. Measure it instead of guessing from the
      // character count, so the toggle never appears without something to open.
      const [aboutClamped, setAboutClamped] = useState(false)
      const aboutRef = useRef(null)
      useEffect(() => {
        setAboutOpen(false)
      }, [symbol, hint])
      useEffect(() => {
        if (aboutOpen) return
        const node = aboutRef.current
        if (!node) {
          setAboutClamped(false)
          return
        }
        setAboutClamped(node.scrollHeight - node.clientHeight > 1)
      }, [aboutOpen, symbol, hint, profile.data])

      // Sell-side consensus is a range, not a point: the card draws where the
      // mean and the current price sit inside the analysts' low–high band.
      const analysts = company.analysts || null
      const ratingLabel = (key) => {
        const label = { strong_buy: 'Strong buy', buy: 'Buy', hold: 'Hold', underperform: 'Underperform', sell: 'Sell' }[key]
        return label ? t(label) : key ? t(key) : t('No rating')
      }
      const signedPct = (value, digits = 1) => `${value > 0 ? '+' : ''}${plain(value, digits)}%`
      const title =
        quote.loading && !data
          ? symbol
          : indexName || nameOf(Object.assign({}, company, data, { symbol }), symbol)
      const technical = chart.data && chart.data.technical
      const tech = technical && technical.technical
      const levels = (technical && technical.levels) || null
      const bars = (chart.data && chart.data.data && chart.data.data.candles) || []
      // Same window, two series: the name's own bars are already loaded and the
      // sector ETF's came with the day line, so this comparison is free.
      const relStrength = relativeStrength(bars, sectorSeries.data && sectorSeries.data.data && sectorSeries.data.data.candles)
      const spark = sparkPoints(bars)
      // Sizing is arithmetic on numbers already on screen: the price, the stop,
      // and the two figures the user types. Nothing here leaves the device.
      const [sizing, setSizing] = useState(() => {
        try {
          const raw = window.localStorage.getItem('tm-sizing')
          const parsed = raw ? JSON.parse(raw) : null
          if (parsed && typeof parsed === 'object') {
            return {
              account: String(parsed.account == null ? '' : parsed.account),
              risk: String(parsed.risk == null ? '1' : parsed.risk),
              stop: String(parsed.stop == null ? '' : parsed.stop),
            }
          }
        } catch (error) {}
        return { account: '', risk: '1', stop: '' }
      })
      useEffect(() => {
        try {
          window.localStorage.setItem('tm-sizing', JSON.stringify(sizing))
        } catch (error) {}
      }, [sizing.account, sizing.risk, sizing.stop])
      const sizingPrice = quote.data && isNum(quote.data.price) ? quote.data.price : null
      const sizingTech = tech || null
      const sizingSuggested = suggestStop(sizingPrice, sizingTech)
      const sizingTyped = Number(sizing.stop)
      const sizingStop = isNum(sizingTyped) && sizingTyped > 0 ? sizingTyped : sizingSuggested
      const sizingPlan = sizeFor(sizingPrice, sizingStop, Number(sizing.account), Number(sizing.risk))
      const sizingCurrency = (quote.data && quote.data.currency) || 'USD'
      const epsRows = Array.isArray(company.earningsSurprises) ? company.earningsSurprises : []
      const epsScale = epsRows.reduce((max, row) => (isNum(row.surprisePct) ? Math.max(max, Math.abs(row.surprisePct)) : max), 0) || 1
      const epsBarWidth = (value, scale) => {
        if (!isNum(value) || !(scale > 0)) return '0%'
        const share = Math.max(4, Math.min(100, (Math.abs(value) / scale) * 100))
        return `${Math.round(share)}%`
      }
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
              holdingBadge(myCost)
                ? h(
                    'span',
                    {
                      className: 'tm-badge tm-badge--held',
                      title: t('A position: {shares} shares at a cost of {cost}'),
                    },
                    t('Holding {shares} @ {cost}', {
                      shares: plain(holdingBadge(myCost).shares, 0),
                      cost: money(holdingBadge(myCost).price, (data && data.currency) || company.currency || 'USD'),
                    }),
                  )
                : null,
            ),
            sectorTile && sectorPct !== null
              ? h(
                  'div',
                  {
                    className: 'tm-rel',
                    title: t('One sector ETF stands in for the group: the day move side by side, not a valuation call.'),
                  },
                  h('span', { className: 'tm-rel__k' }, t('Sector')),
                  h('span', { className: 'tm-rel__name' }, `${t(sectorTile.label)} · ${sectorTile.symbol}`),
                  h('span', { className: 'tm-rel__v ' + trendClass(sectorPct) }, percent(sectorPct)),
                  sectorGap === null
                    ? null
                    : Math.abs(sectorGap) < 0.05
                      ? h('span', { className: 'tm-rel__gap' }, t('In line with its sector'))
                      : h(
                          'span',
                          { className: 'tm-rel__gap ' + trendClass(sectorGap) },
                          sectorGap > 0
                            ? t('Ahead of its sector by {gap}', { gap: `${plain(Math.abs(sectorGap), 2)}pp` })
                            : t('Behind its sector by {gap}', { gap: `${plain(Math.abs(sectorGap), 2)}pp` }),
                        ),
                  // One day is a print; twenty sessions is a trend. Both sit on
                  // the same line so a name that fell today but led its group
                  // for a month reads as what it is.
                  relStrength === null
                    ? null
                    : h(
                        'span',
                        {
                          className: 'tm-rel__rs ' + trendClass(relStrength.gap),
                          title: t('Price change over {n} sessions against the sector ETF over the same window.', { n: relStrength.window }),
                        },
                        t('{n}d vs sector {gap}', {
                          n: relStrength.window,
                          gap: `${relStrength.gap > 0 ? '+' : ''}${plain(relStrength.gap, 1)}pp`,
                        }),
                      ),
                )
              : null,
            macroNote
              ? h(
                  'div',
                  {
                    className: 'tm-macro',
                    title: t('Macro releases land on the index first and on single names second.'),
                  },
                  h('span', { className: 'tm-macro__k' }, t('Macro day')),
                  h('span', { className: 'tm-macro__name' }, `${macroNote.title} · ${macroNote.when}`),
                  macroNote.detail ? h('span', { className: 'tm-macro__when' }, macroNote.detail) : null,
                  h('span', { className: 'tm-macro__impact' }, macroNote.impact),
                )
              : null,
          ),
          h(
            'div',
            { className: 'tm-detail__price' },
            h(
              'span',
              { className: 'tm-detail__last ' + toneOf(data && data.price, data && data.previousClose) },
              data ? (unit ? plain(data.price, 2) + unit : money(data.price, data.currency)) : '—',
            ),
            h('span', { className: 'tm-detail__chg ' + trendClass(data && data.changePct) }, data ? `${signed(data.change, 2)}  ${percent(data.changePct)}` : t('Data unavailable')),
            ext
              ? h(
                  'span',
                  { className: 'tm-detail__ext ' + trendClass(ext.changePct), title: t('Extended hours') },
                  `${sessionLabel(ext.session, t)} ${money(ext.price, data && data.currency)} · ${percent(ext.changePct)}${ext.at ? ` · ${clockOf(ext.at)}` : ''}`,
                )
              : null,
            spark
              ? h(
                  'span',
                  { className: 'tm-spark ' + (spark.up ? 'tm-up' : 'tm-down'), title: t('Last 20 sessions') },
                  h(
                    'svg',
                    { viewBox: '0 0 88 26', width: 88, height: 26, 'aria-hidden': 'true', focusable: 'false' },
                    h('polyline', {
                      points: spark.points,
                      fill: 'none',
                      stroke: 'currentColor',
                      'stroke-width': 1.5,
                      'stroke-linejoin': 'round',
                      'stroke-linecap': 'round',
                    }),
                  ),
                )
              : null,
            h(Freshness, { data }),
          ),
          h(
            'div',
            { className: 'tm-detail__actions' },
          proxyFund
            ? h(
                'button',
                {
                  className: 'tm-btn tm-btn--ghost',
                  title: t('Index levels are not tradable; open the closest ETF'),
                  onClick: () => onOpen({ symbol: proxyFund, market: 'US' }),
                },
                h(Icon, { name: 'chart' }),
                t('ETF {symbol}', { symbol: proxyFund }),
              )
            : null,
          h(
            'button',
            {
              className: 'tm-btn tm-btn--ghost',
              title: t('Copy this page as plain text'),
              onClick: () => {
                const lines = digestLines(
                  {
                    symbol,
                    name: company.name,
                    price: data && data.price,
                    unit,

                    change: data && data.change,
                    changePct: data && data.changePct,
                    currency: (data && data.currency) || company.currency,
                    ext,
                    position: positionOf(data, myCost),
                    exDividendDate: company.exDividendDate,
                  },
                  t,
                )
                if (!lines.length) return
                // Copying is a convenience: a blocked clipboard stays silent.
                navigator.clipboard?.writeText(lines.join('\n')).then(() => {
                  setDigestCopied(true)
                  setTimeout(() => setDigestCopied(false), 1500)
                }).catch(() => {})
              },
            },
            digestCopied ? t('Copied') : t('Copy summary'),
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
          h('button', { className: 'tm-btn' + (tv ? ' tm-btn--active' : ''), onClick: () => { const next = !tv; setTv(next); setStore({ tv: next }) } }, 'TradingView'),          ),
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
          { className: 'tm-detail__alerts' },
          h('span', { className: 'tm-detail__tags-k' }, t('Price alert')),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('above')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              step: '0.01',
              inputMode: 'decimal',
              value: alertAbove,
              placeholder: t('no bound'),
              onChange: (event) => setAlertAbove(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('below')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              step: '0.01',
              inputMode: 'decimal',
              value: alertBelow,
              placeholder: t('no bound'),
              onChange: (event) => setAlertBelow(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('max loss')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              max: '100',
              step: '1',
              inputMode: 'decimal',
              value: alertLoss,
              placeholder: t('no bound'),
              onChange: (event) => setAlertLoss(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('day move')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              max: '100',
              step: '0.5',
              inputMode: 'decimal',
              value: alertMove,
              placeholder: t('no bound'),
              onChange: (event) => setAlertMove(event.target.value),
            }),
          ),
          h(
            'button',
            {
              className: 'tm-btn tm-btn--ghost',
              onClick: () => setAlert({ symbol, market: hint }, { above: alertAbove, below: alertBelow, loss: alertLoss, move: alertMove }),
            },
            t('Save alert'),
          ),
          myAlert
            ? h(
                'button',
                {
                  className: 'tm-btn tm-btn--ghost',
                  onClick: () => {
                    setAlert({ symbol, market: hint }, { above: null, below: null, loss: null, move: null })
                    setAlertAbove('')
                    setAlertBelow('')
                    setAlertLoss('')
                    setAlertMove('')
                  },
                },
                t('Clear'),
              )
            : null,
          myAlert
            ? (() => {
                const hit = alertHit(latestPrint(data) && latestPrint(data).price, myAlert) || lossHit(positionOf(data, myCost), myAlert) || moveHit(data, myAlert)
                return h(
                  'span',
                  { className: 'tm-alertstate' + (hit ? ' tm-alertstate--hit' : '') },
                  hit ? t('triggered') : alertBoundsText(myAlert, t, (data && data.currency) || company.currency),
                )
              })()
            : h('span', { className: 'tm-alertstate' }, t('Local only — the quote you already load is what fires it.')),
        ),

        h(
          'div',
          { className: 'tm-detail__alerts' },
          h('span', { className: 'tm-detail__tags-k' }, t('Position')),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('cost')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              step: '0.01',
              inputMode: 'decimal',
              value: costPrice,
              placeholder: t('price paid'),
              onChange: (event) => setCostPrice(event.target.value),
            }),
          ),
          h(
            'label',
            { className: 'tm-alertfield' },
            h('span', { className: 'tm-alertfield__k' }, t('shares')),
            h('input', {
              className: 'tm-alertfield__in',
              type: 'number',
              min: '0',
              step: 'any',
              inputMode: 'decimal',
              value: costShares,
              placeholder: t('share count'),
              onChange: (event) => setCostShares(event.target.value),
            }),
          ),
          h(
            'button',
            {
              className: 'tm-btn tm-btn--ghost',
              onClick: () => setCost({ symbol, market: hint }, { price: costPrice, shares: costShares }),
            },
            t('Save position'),
          ),
          myCost
            ? h(
                'button',
                {
                  className: 'tm-btn tm-btn--ghost',
                  onClick: () => {
                    setCost({ symbol, market: hint }, { price: null, shares: null })
                    setCostPrice('')
                    setCostShares('')
                  },
                },
                t('Clear'),
              )
            : null,
          (() => {
            const held = positionOf(data, myCost)
            if (!held) return h('span', { className: 'tm-alertstate' }, t('Local only — value and open P&L use the quote loaded above.'))
            return h(
              'span',
              { className: 'tm-alertstate' + (held.pnl === 0 ? '' : ' ' + trendClass(held.pnl)) },
              `${t('Value')} ${money(held.value, held.currency)} · ${t('Open P&L')} ${signed(held.pnl, 2)}${held.pct === null ? '' : ` (${percent(held.pct)})`}${isNum(held.today) ? ` · ${t('today')} ${signed(held.today, 2)}` : ''} · ${t('Cost')} ${money(held.basis, held.currency)}${(() => {
                const income = dividendIncome(company, held)
                if (!income) return ''
                return ` · ${t('Annual dividends')} ${money(income.annual, income.currency)}${income.onCost === null ? '' : ` (${t('{pct} on cost', { pct: percent(income.onCost) })})`}`
              })()}`,
            )
          })(),
        ),

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
          WEEKLY_RANGES[range]
            ? h(
                'span',
                { className: 'tm-range__split' },
                ['day', 'week'].map((size) =>
                  h(
                    'button',
                    {
                      key: size,
                      className:
                        'tm-range tm-range--size' +
                        ((ui.barSize === 'week' ? 'week' : 'day') === size ? ' tm-range--active' : ''),
                      title: size === 'week' ? t('One bar per week') : t('One bar per day'),
                      onClick: () => setStore({ barSize: size }),
                    },
                    size === 'week' ? 'W' : 'D',
                  ),
                ),
              )
            : null,
          chart.loading ? h('span', { className: 'tm-search__hint' }, t('loading bars…')) : null,
        ),
        indexRow && !proxyFund
          ? h('p', { className: 'tm-indexnote' }, t('Index levels are points on a scale, not a security — there is nothing to buy or sell here.'))
          : null,
        h(Card, { title: t('Chart') }, chart.error ? h(ErrorNote, { error: chart.error, onRetry: chart.reload }) : null, h(CandleChart, { candles: bars, series: technical && technical.series, interval: chart.data && chart.data.data && chart.data.data.interval, degraded: Boolean(chartMeta && chartMeta.degraded), read: technicalDigest(tech, data && data.price, t), cost: myCost && isNum(myCost.price) ? myCost.price : null }), chartMeta ? h(Freshness, { meta: chartMeta, compact: true }) : null),
        h(
          Card,
          { title: t('Position & risk'), right: h('span', { className: 'tm-card__meta' }, t('local only')) },
          h(
            'div',
            { className: 'tm-sizing' },
            h(
              'label',
              { className: 'tm-sizing__field' },
              h('span', { className: 'tm-sizing__k' }, t('account size')),
              h('input', { className: 'tm-sizing__in', type: 'number', min: 0, step: 100, value: sizing.account, placeholder: '10000', onChange: (event) => setSizing({ ...sizing, account: event.target.value }) }),
            ),
            h(
              'label',
              { className: 'tm-sizing__field' },
              h('span', { className: 'tm-sizing__k' }, t('risk per trade (%)')),
              h('input', { className: 'tm-sizing__in', type: 'number', min: 0, max: 100, step: 0.25, value: sizing.risk, placeholder: '1', onChange: (event) => setSizing({ ...sizing, risk: event.target.value }) }),
            ),
            h(
              'label',
              { className: 'tm-sizing__field' },
              h('span', { className: 'tm-sizing__k' }, t('stop price')),
              h('input', { className: 'tm-sizing__in', type: 'number', min: 0, step: 0.01, value: sizing.stop, placeholder: sizingSuggested ? String(sizingSuggested) : '—', onChange: (event) => setSizing({ ...sizing, stop: event.target.value }) }),
            ),
          ),
          sizingPlan
            ? h(
                'div',
                { className: 'tm-sizing__out' },
                h('div', { className: 'tm-sizing__cell' }, h('span', { className: 'tm-sizing__k' }, t('shares to buy')), h('span', { className: 'tm-sizing__v' }, String(sizingPlan.shares))),
                h('div', { className: 'tm-sizing__cell' }, h('span', { className: 'tm-sizing__k' }, t('position value')), h('span', { className: 'tm-sizing__v' }, money(sizingPlan.value, sizingCurrency))),
                h('div', { className: 'tm-sizing__cell' }, h('span', { className: 'tm-sizing__k' }, t('share of account')), h('span', { className: 'tm-sizing__v' }, percent(sizingPlan.sharePct))),
                h('div', { className: 'tm-sizing__cell' }, h('span', { className: 'tm-sizing__k' }, t('stop distance')), h('span', { className: 'tm-sizing__v' }, percent(sizingPlan.stopPct))),
              )
            : h('div', { className: 'tm-hint' }, t('Type an account size and a stop below the price to size the trade.')),
          sizingSuggested && !sizing.stop
            ? h('div', { className: 'tm-sizing__note' }, t('Suggested stop: {price} — two average ranges below the last print.', { price: money(sizingSuggested, sizingCurrency) }))
            : null,
          h('div', { className: 'tm-fund__note' }, t('One entry, no adds: the number answers how many shares keep a stop-out inside the amount you set.')),
        ),
        ...upcomingStrips(earnings.data, company, symbol, t),
        nextMacro(macroSoon.data, t),

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
              isNum(company.dividendYield) ? h(Cell, { label: t('Dividend yield'), value: `${plain(company.dividendYield, 2)}%` }) : null,
              isNum(company.dividendRate) ? h(Cell, { label: t('Annual dividend'), value: money(company.dividendRate, company.currency || 'USD') }) : null,
              isNum(company.exDividendDate)
                ? h(Cell, {
                    label: t('Ex-dividend'),
                    value: (() => {
                      const day = dateOfUtc(company.exDividendDate)
                      const when = relativeDayOf(company.exDividendDate, t)
                      return when ? `${day} · ${when}` : day
                    })(),
                  })
                : null,
              isNum(company.expenseRatio) ? h(Cell, { label: t('Expense ratio'), value: `${plain(company.expenseRatio, 2)}%` }) : null,
              company.fundFamily ? h(Cell, { label: t('Fund family'), value: company.fundFamily }) : null,
            ),
            (() => {
              const about = String(company.description || '').trim()
              const facts = [
                company.sector ? [t('Sector'), company.sector] : null,
                company.industry ? [t('Industry'), company.industry] : null,
                company.country ? [t('Country'), company.country] : null,
              ].filter(Boolean)
              const site = siteOf(company.website)
              if (!facts.length && !site && !about) return null
              return h(
                'div',
                { className: 'tm-about' },
                facts.length || site
                  ? h(
                      'div',
                      { className: 'tm-about__facts' },
                      facts.map((pair) =>
                        h(
                          'span',
                          { className: 'tm-about__fact', key: pair[0] },
                          h('span', { className: 'tm-about__k' }, pair[0]),
                          pair[1],
                        ),
                      ),
                      site
                        ? h(
                            'span',
                            { className: 'tm-about__fact' },
                            h('span', { className: 'tm-about__k' }, t('Website')),
                            h(
                              'a',
                              {
                                className: 'tm-about__link',
                                href: company.website,
                                target: '_blank',
                                rel: 'noopener noreferrer',
                              },
                              site,
                            ),
                          )
                        : null,
                    )
                  : null,
                about
                  ? h(
                      'p',
                      {
                        ref: aboutRef,
                        className: 'tm-desc' + (aboutOpen ? ' tm-desc--open' : ' tm-desc--clamp'),
                      },
                      about,
                    )
                  : null,
                aboutClamped || aboutOpen
                  ? h(
                      'button',
                      {
                        type: 'button',
                        className: 'tm-about__more',
                        onClick: () => setAboutOpen(!aboutOpen),
                      },
                      t(aboutOpen ? 'Show less' : 'Show more'),
                    )
                  : null,
              )
            })(),
          ),
          company.holdings && company.holdings.length
            ? h(
                Card,
                {
                  title: t('Top holdings'),
                  right: h('span', { className: 'tm-card__meta' }, t('weights in percent of the fund')),
                },
                h(
                  'div',
                  { className: 'tm-holdings' },
                  (() => {
                    const max = Math.max(...company.holdings.map((item) => item.weight || 0), 0.0001)
                    return company.holdings.map((item) => {
                      const bar = `${Math.max(3, Math.round(100 * (item.weight || 0) / max))}%`
                      const meta = `${item.name}${item.symbol ? ` · ${item.symbol}` : ''} · ${plain(item.weight || 0, 2)}%`
                      return h(
                        item.symbol && onOpen ? 'button' : 'div',
                        {
                          key: item.symbol || item.name,
                          ...(item.symbol && onOpen
                            ? { type: 'button', className: 'tm-hold tm-hold--link', title: meta, onClick: () => onOpen({ symbol: item.symbol, market: 'US' }) }
                            : { className: 'tm-hold' }),
                        },
                        item.symbol ? h('span', { className: 'tm-hold__sym' }, item.symbol) : null,
                        h('span', { className: 'tm-hold__name' }, item.name),
                        h('span', { className: 'tm-hold__bar', 'aria-hidden': 'true' }, h('span', { className: 'tm-hold__fill', style: `width:${bar}` })),
                        h('span', { className: 'tm-hold__w' }, item.weight == null ? '—' : `${plain(item.weight, 2)}%`),
                      )
                    })
                  })(),
                ),
              )
            : null,
          company.sectors && company.sectors.length
            ? h(
                Card,
                {
                  title: t('Sector exposure'),
                  right: h('span', { className: 'tm-card__meta' }, t("share of the fund's assets by sector")),
                },
                h(
                  'div',
                  { className: 'tm-sectors' },
                  company.sectors.map((item) =>
                    h(
                      'div',
                      { key: item.key || item.name, className: 'tm-sector', title: `${t(item.name)} · ${plain(item.weight, 2)}%` },
                      h('span', { className: 'tm-sector__name' }, t(item.name)),
                      // Sectors are shares of one whole, so the bar is drawn to
                      // scale rather than rescaled to the largest slice — a 40%
                      // tech weight should look like 40% of the fund.
                      h('span', { className: 'tm-sector__bar', 'aria-hidden': 'true' }, h('span', { className: 'tm-sector__fill', style: `width:${Math.max(1.5, Math.min(100, item.weight))}%` })),
                      h('span', { className: 'tm-sector__w' }, `${plain(item.weight, 2)}%`),
                    ),
                  ),
                ),
              )
            : null,
          news.data && Array.isArray(news.data) && news.data.length
            ? h(
                Card,
                {
                  title: t('In the news'),
                  right: h(
                    'span',
                    { className: 'tm-news__filter' },
                    h(
                      'button',
                      {
                        className: 'tm-news__chip' + (newsToday ? ' tm-news__chip--on' : ''),
                        onClick: () => toggleNewsToday(),
                        title: t('Show only the last 24 hours'),
                        'aria-pressed': newsToday ? 'true' : 'false',
                      },
                      t('Today'),
                    ),
                    t(newsToday ? '{n} today' : '{n} headlines').replace('{n}', String(newsRows.length)),
                  ),
                },
                h(
                  'div',
                  { className: 'tm-news' },
                  newsRows.length === 0
                    ? h('p', { className: 'tm-news__empty' }, t('No related news in the last 24 hours.'))
                    : null,
                  newsRows.map((item) =>
                    h(
                      'a',
                      {
                        key: item.id || item.link,
                        className: 'tm-news__row',
                        href: item.link,
                        target: '_blank',
                        rel: 'noopener noreferrer',
                        title: item.publisher ? `${item.publisher} · ${new Date(item.at || Date.now()).toISOString().slice(0, 16).replace('T', ' ')} UTC` : undefined,
                      },
                      h('span', { className: 'tm-news__title' }, item.title),
                      h(
                        'span',
                        { className: 'tm-news__meta' },
                        item.publisher ? h('span', { className: 'tm-news__pub' }, item.publisher) : null,
                        h('span', { className: 'tm-news__age' }, agoOf(item.at)),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          epsRows.length
            ? h(
                Card,
                { title: t('Earnings surprises'), right: h('span', { className: 'tm-card__meta' }, `${epsRows.length} ${t('quarters')}`) },
                h(
                  'div',
                  { className: 'tm-eps' },
                  epsRows.map((row) =>
                    h(
                      'div',
                      { key: row.quarter, className: 'tm-eps__row', title: `${row.quarter} · ${t('estimate')} ${plain(row.estimate)} · ${t('actual')} ${plain(row.actual)}` },
                      h('span', { className: 'tm-eps__q' }, quarterLabel(row.quarter)),
                      h('span', { className: 'tm-eps__nums' }, `${plain(row.actual)} ${t('vs')} ${plain(row.estimate)}`),
                      h('span', { className: 'tm-eps__bar' }, h('span', { className: 'tm-eps__fill ' + trendClass(row.surprisePct), style: { width: epsBarWidth(row.surprisePct, epsScale) } })),
                      h('span', { className: 'tm-eps__pct ' + trendClass(row.surprisePct) }, isNum(row.surprisePct) ? `${row.surprisePct > 0 ? '+' : ''}${plain(row.surprisePct, 2)}%` : '—'),
                    ),
                  ),
                ),
                h('div', { className: 'tm-fund__note' }, t('Surprise is the reported figure against the consensus for that quarter; a miss carries as much information as a beat.')),
              )
            : null,
          analysts && (analysts.count || isNum(analysts.targetMean))
            ? h(
                Card,
                {
                  title: t('Analyst view'),
                  right: h(
                    'span',
                    { className: 'tm-card__meta' },
                    analysts.count ? `${analysts.count} ${t('analysts')}${analysts.ratingMean ? ` · ${plain(analysts.ratingMean, 2)}/5` : ''}` : t('no coverage'),
                  ),
                },
                h(
                  'div',
                  { className: 'tm-arb' },
                  h('span', { className: 'tm-arb__cap' }, ratingLabel(analysts.rating)),
                  (() => {
                    const lo = analysts.targetLow
                    const hi = analysts.targetHigh
                    if (!isNum(lo) || !isNum(hi) || hi <= lo) return h('span', { className: 'tm-arb__track tm-arb__track--flat' })
                    const at = (value) => Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100))
                    const price = isNum(data && data.price) ? data.price : null
                    return h(
                      'span',
                      { className: 'tm-arb__track', 'aria-hidden': 'true' },
                      isNum(analysts.targetMean) ? h('span', { className: 'tm-arb__mean', style: { left: `${at(analysts.targetMean)}%` }, title: `${t('Mean target')} ${money(analysts.targetMean, company.currency || 'USD')}` }) : null,
                      price == null
                        ? null
                        : h('span', {
                            className: 'tm-arb__pin' + (price > hi || price < lo ? ' tm-arb__pin--out' : ''),
                            style: { left: `${at(price)}%` },
                            title: `${t('Price')} ${money(price, company.currency || 'USD')}`,
                          }),
                    )
                  })(),
                  h('span', { className: 'tm-arb__ends' }, isNum(analysts.targetLow) && isNum(analysts.targetHigh) ? `${money(analysts.targetLow, company.currency || 'USD')} – ${money(analysts.targetHigh, company.currency || 'USD')}` : ''),
                ),
                h(
                  'div',
                  { className: 'tm-grid' },
                  isNum(analysts.targetMean) ? h(Cell, { label: t('Mean target'), value: money(analysts.targetMean, company.currency || 'USD') }) : null,
                  isNum(analysts.targetMean) && isNum(data && data.price) && data.price > 0
                    ? h(Cell, {
                        label: t('Upside'),
                        value: h('span', { className: analysts.targetMean >= data.price ? 'tm-up' : 'tm-down' }, signedPct((analysts.targetMean / data.price - 1) * 100)),
                      })
                    : null,
                  isNum(analysts.ratingMean) ? h(Cell, { label: t('Mean rating'), value: `${plain(analysts.ratingMean, 2)} / 5` }) : null,
                  analysts.count ? h(Cell, { label: t('Analysts'), value: String(analysts.count) }) : null,
                ),
                (() => {
                  const mix = ratingMix(company.ratings)
                  const changes = ratingChanges(company.ratings, Date.now())
                  if (!mix && !changes.length) return null
                  const ACTION_LABEL = { up: 'Raised', down: 'Cut', init: 'Started', reit: 'Reiterated', main: 'Restated' }
                  return h(
                    'div',
                    { className: 'tm-rate' },
                    mix
                      ? h(
                          'div',
                          { className: 'tm-rate__mix' },
                          h(
                            'div',
                            {
                              className: 'tm-rate__bar',
                              role: 'img',
                              'aria-label': `${t('Ratings mix')}: ${mix.segments.map((seg) => `${t(seg.label)} ${seg.count}`).join(', ')}`,
                            },
                            mix.segments.map((seg) =>
                              h('span', { key: seg.key, className: `tm-rate__seg tm-rate__seg--${seg.key}`, style: { width: `${seg.pct}%` }, title: `${t(seg.label)} ${seg.count}` }),
                            ),
                          ),
                          h(
                            'div',
                            { className: 'tm-rate__legend' },
                            mix.segments.map((seg) => h('span', { key: seg.key, className: 'tm-rate__key' }, `${t(seg.label)} ${seg.count}`)),
                          ),
                        )
                      : null,
                    changes.length
                      ? h(
                          'div',
                          { className: 'tm-rate__list' },
                          h('div', { className: 'tm-rate__head' }, t('Rating changes')),
                          changes.map((row) =>
                            h(
                              'div',
                              { key: `${row.firm}:${row.at}`, className: 'tm-rate__row', title: `${row.firm} · ${row.days === 0 ? t('today') : t('{n} days ago', { n: row.days })}` },
                              h('span', { className: 'tm-rate__when' }, monthDay(new Date(row.at).toISOString())),
                              h('span', { className: 'tm-rate__firm' }, row.firm),
                              h('span', { className: `tm-rate__action tm-rate__action--${row.action === 'main' ? 'reit' : row.action}` }, t(ACTION_LABEL[row.action] || 'Restated')),
                              h('span', { className: 'tm-rate__grade' }, row.from && row.to ? `${row.from} → ${row.to}` : row.to || ''),
                            ),
                          ),
                        )
                      : h('div', { className: 'tm-fund__note' }, t('No rating changes in the last six months.')),
                  )
                })(),
              )
            : null,
          company.stats
            ? h(
                Card,
                { title: t('Fundamentals') },
                h(
                  'div',
                  { className: 'tm-grid' },
                  isNum(company.stats.forwardPe) ? h(Cell, { label: t('Forward P/E'), value: plain(company.stats.forwardPe, 2) }) : null,
                  isNum(company.stats.priceToBook) ? h(Cell, { label: t('Price/Book'), value: plain(company.stats.priceToBook, 2) }) : null,
                  isNum(company.stats.beta) ? h(Cell, { label: t('Beta'), value: plain(company.stats.beta, 2) }) : null,
                  isNum(company.stats.revenueGrowth) ? h(Cell, { label: t('Revenue growth'), value: signedPct(company.stats.revenueGrowth) }) : null,
                  isNum(company.stats.earningsGrowth) ? h(Cell, { label: t('Earnings growth'), value: signedPct(company.stats.earningsGrowth) }) : null,
                  isNum(company.stats.grossMargin) ? h(Cell, { label: t('Gross margin'), value: `${plain(company.stats.grossMargin, 2)}%` }) : null,
                  isNum(company.stats.netMargin) ? h(Cell, { label: t('Net margin'), value: `${plain(company.stats.netMargin, 2)}%` }) : null,
                  isNum(company.stats.returnOnEquity) ? h(Cell, { label: t('Return on equity'), value: `${plain(company.stats.returnOnEquity, 2)}%` }) : null,
                ),
              )
            : null,
          company.ownership
            ? h(
                Card,
                { title: t('Ownership & shorts') },
                h(
                  'div',
                  { className: 'tm-grid' },
                  isNum(company.ownership.institutions) ? h(Cell, { label: t('Institutions'), value: `${plain(company.ownership.institutions, 2)}%` }) : null,
                  isNum(company.ownership.insiders) ? h(Cell, { label: t('Insiders'), value: `${plain(company.ownership.insiders, 2)}%` }) : null,
                  isNum(company.ownership.shortFloat) ? h(Cell, { label: t('Short float'), value: `${plain(company.ownership.shortFloat, 2)}%` }) : null,
                  isNum(company.ownership.shortDays) ? h(Cell, { label: t('Days to cover'), value: plain(company.ownership.shortDays, 2) }) : null,
                  isNum(company.ownership.shortShares)
                    ? h(Cell, {
                        label: t('Shares short'),
                        value: volumeText(company.ownership.shortShares) + (isNum(company.ownership.shortChangePct) ? ` (${signedPct(company.ownership.shortChangePct)} ${t('vs prior month')})` : ''),
                      })
                    : null,
                  company.ownership.shortAsOf ? h(Cell, { label: t('Short interest as of'), value: company.ownership.shortAsOf }) : null,
                ),
              )
            : null,
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
    function MarketOverview({ onOpen, onAdd, owned, onBrowse, rows, held }) {
      const { t, lang } = useT()
      const [market, setMarket] = useState('US')
      const state = useAsync((signal) => apiGet(`/indices?market=${market}`, signal), [market])
      const data = state.data || {}
      const items = data.items || []
      // The comparison belongs to the US tab only: the index behind the gap is
      // the S&P, and a crypto board has no comparable benchmark here.
      const vs = market === 'US' ? boardVsIndex(rows, items, '^GSPC', held) : null
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
        vs
          ? h(
              'div',
              {
                className: 'tm-vs',
                title: t('Equal-weighted watchlist next to a 500-name index: a reference, not a like-for-like comparison.'),
              },
              h(
                'span',
                null,
                t('Watchlist equal-weight'),
                ' ',
                h('b', { className: trendClass(vs.board) }, percent(vs.board)),
                ' ',
                h('span', { className: 'tm-vs__meta' }, t('{n} names', { n: vs.n })),
              ),
              h('span', { className: 'tm-vs__sep' }, '·'),
              h('span', null, vs.indexName, ' ', h('b', { className: trendClass(vs.indexPct) }, percent(vs.indexPct))),
              h('span', { className: 'tm-vs__sep' }, '·'),
              h('span', null, t('Gap'), ' ', h('b', { className: trendClass(vs.gap) }, `${signed(vs.gap, 2)}pp`)),
              vs.heldN ? h('span', { className: 'tm-vs__sep' }, '·') : null,
              vs.heldN
                ? h(
                    'span',
                    {
                      className: 'tm-vs__held',
                      title: t('The positions you hold, averaged the same way against the same index.'),
                    },
                    t('Held equal-weight'),
                    ' ',
                    h('b', { className: trendClass(vs.heldBoard) }, percent(vs.heldBoard)),
                    ' ',
                    h('span', { className: 'tm-vs__meta' }, t('{n} names', { n: vs.heldN })),
                    ' ',
                    t('gap'),
                    ' ',
                    h('b', { className: trendClass(vs.heldGap) }, `${signed(vs.heldGap, 2)}pp`),
                  )
                : null,
            )
          : null,
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

    /** Index levels are not tradable; each one names the listed fund that tracks it, offered inside the page. */
    const PROXY_ETF = {
      '^IXIC': 'QQQ',
      '^NDX': 'QQQ',
      '^GSPC': 'SPY',
      '^DJI': 'DIA',
      '^SOX': 'SMH',
      '^RUT': 'IWM',
      // Rates and the dollar trade through funds, not as spot product lines.
      '^TNX': 'TLT',
      'DX-Y.NYB': 'UUP',
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
      // Every tile opens its own page: an index has a chart and a catalogue
      // entry, and VIX needs no proxy to be worth reading. The closest fund is
      // offered inside that page for the symbols that have one.
      const proxied = PROXY_ETF[String(item.symbol).toUpperCase()] || null
      const detail = Object.assign({}, item, { market: item.market || market })
      return h(
        'div',
        { className: 'tm-index' },
        h(
          'button',
          {
            className: 'tm-index__main',
            onClick: () => onOpen(detail),
            title: proxied
              ? t('Open {name}; its closest fund is {symbol}', { name, symbol: proxied })
              : t('Open {name}', { name }),
          },
          h('span', { className: 'tm-index__name' }, name),
          h('span', { className: 'tm-index__symbol' }, item.symbol),
          h(
            'span',
            { className: 'tm-index__value' },
            // A yield is not a price: ^TNX prints 4.86, and without the unit the
            // tile reads as if the index had a dollar level.
            crypto ? money(quote.price, quote.currency) : plain(quote.price, 2) + (item.unit || ''),
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

    /**
     * 1.1: headlines that touch what the reader actually holds.
     *
     * The symbol list comes from the local cost basis, so the card answers "what
     * happened to my positions" instead of "what is in the news". The server
     * merges the per-symbol caches behind one request, and a symbol it cannot
     * reach simply does not appear here.
     */
    /**
     * Which tickers the news feed should ask about, biggest position first.
     * The card used to take the first six cost-bearing rows in watchlist order,
     * so a 2% position could crowd out a 30% one just by sitting higher in the
     * list. Names with a recorded cost but no shares still count (the reader
     * flagged them as owned), they just sort last because their weight is zero.
     */
    function newsSymbols(rows, costs, limit = 6) {
      const picked = []
      const seen = new Set()
      for (const row of rows || []) {
        if (!row || !row.symbol) continue
        if (!costOf(costs, row)) continue
        const symbol = String(row.symbol).toUpperCase()
        if (seen.has(symbol)) continue
        seen.add(symbol)
        const position = positionOf(row.quote, costOf(costs, row))
        picked.push({ symbol: row.symbol, value: position && isNum(position.value) ? position.value : 0 })
      }
      picked.sort((a, b) => b.value - a.value)
      return picked.slice(0, limit).map((entry) => entry.symbol)
    }

    function HoldingNewsCard({ rows, costs, onOpen }) {
      const { t: tr } = useT()
      const [onlyToday, setOnlyToday] = useState(() => {
        try {
          return localStorage.getItem('tm-hnews-today') === '1'
        } catch (err) {
          return false
        }
      })
      const flipWindow = () => {
        const next = !onlyToday
        setOnlyToday(next)
        try {
          localStorage.setItem('tm-hnews-today', next ? '1' : '0')
        } catch (err) {
          // private mode: the choice just will not survive a reload
        }
      }
      const held = newsSymbols(rows, costs)
      const marketOf = (symbol) => {
        const hit = (rows || []).find((row) => String(row.symbol).toUpperCase() === String(symbol).toUpperCase())
        return (hit && hit.market) || 'US'
      }
      // Positions first. A watchlist nobody has recorded a cost basis for still
      // deserves a feed: the card used to vanish for exactly that reader.
      const watching = held.length
        ? held
        : (rows || [])
            .map((row) => row && row.symbol)
            .filter((symbol, index, all) => symbol && all.indexOf(symbol) === index)
            .slice(0, 6)
      const key = watching.join(',')
      const feed = useAsync(
        (signal) => (key ? apiGet(`/news?symbols=${encodeURIComponent(key)}&limit=8`, signal) : Promise.resolve({ data: [] })),
        [key],
      )
      if (!key) return null
      const items = (feed.data && feed.data.data) || []
      const recent = recentNews(items, Date.now())
      const shown = onlyToday ? recent : items
      if (!feed.loading && !items.length) return null
      return h(
        Card,
        {
          title: [
            Icon({ name: 'list', size: 14 }),
            held.length ? tr('Headlines on your positions') : tr('Headlines on your watchlist'),
          ],
          right: feed.loading
            ? null
            : h(
                'span',
                { className: 'tm-news__filter' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'tm-news__chip' + (onlyToday ? ' tm-news__chip--on' : ''),
                    onClick: flipWindow,
                    title: tr('Show only the last 24 hours'),
                  },
                  tr('Today'),
                ),
                h(
                  'span',
                  { className: 'tm-card__meta' },
                  onlyToday ? tr('{n} today', { n: shown.length }) : tr('{n} stories', { n: items.length }),
                ),
              ),
          className: 'tm-card--own-news',
        },
        feed.loading
          ? h(Spinner)
          : h(
              'div',
              { className: 'tm-news' },
              onlyToday && !shown.length
                ? h('p', { className: 'tm-news__empty' }, tr('Nothing about your positions in the last 24 hours.'))
                : null,
              shown.map((item) =>
                h(
                  'div',
                  { key: item.id || item.link, className: 'tm-news__row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'tm-news__sym',
                      title: tr('Open {name}', { name: item.symbol }),
                      onClick: () => onOpen({ symbol: item.symbol, market: marketOf(item.symbol) }),
                    },
                    item.symbol,
                  ),
                  h(
                    'a',
                    {
                      className: 'tm-news__body',
                      href: item.link,
                      target: '_blank',
                      rel: 'noopener noreferrer',
                      title: item.publisher || null,
                    },
                    h('span', { className: 'tm-news__title' }, item.title),
                    h(
                      'span',
                      { className: 'tm-news__meta' },
                      item.publisher ? h('span', { className: 'tm-news__pub' }, item.publisher) : null,
                      h('span', { className: 'tm-news__age' }, agoOf(item.at)),
                    ),
                  ),
                ),
              ),
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

    /**
     * 1.2: the one place a price alert surfaces without opening a row. It lists
     * only rows whose last price is on the wrong side of an armed bound and that
     * have not already been acknowledged at this level — a warning that cannot be
     * cleared is a warning people learn to ignore, and one that clears forever is
     * a warning that misses the second leg. Dismissal is remembered per bound, and
     * the alert returns once the price moves a full point further.
     */
    function PulseStrip({ rows, onOpen }) {
      const { t } = useT()
      const pulse = marketPulse(rows)
      if (!pulse.total) return null
      return h(
        'div',
        { className: 'tm-pulse' },
        h('span', { className: 'tm-pulse__item' }, t('{n} rows', { n: pulse.total })),
        pulse.counted
          ? h('span', { className: 'tm-pulse__item' }, t('{up} up {down} down', { up: pulse.up, down: pulse.down }))
          : null,
        pulse.counted && pulse.flat
          ? h('span', { className: 'tm-pulse__item' }, t('{n} unchanged', { n: pulse.flat }))
          : null,
        pulse.lead
          ? h(
              'button',
              {
                className: 'tm-pulse__lead',
                onClick: () => onOpen && onOpen({ symbol: pulse.lead.symbol, market: pulse.lead.market }),
                title: t('Largest move on the board'),
              },
              t('Largest move: {sym}', { sym: pulse.lead.symbol }),
              h('span', { className: `tm-pulse__pct ${trendClass(pulse.lead.changePct)}` }, percent(pulse.lead.changePct)),
            )
          : null,
      )
    }

    function AfterHoursCard({ rows, onOpen }) {
      const { t } = useT()
      const movers = afterHoursMovers(rows)
      if (!movers.length) return null
      const top = movers.slice(0, 5)
      return h(
        Card,
        { title: t('After-hours moves'), right: t('{n} outside the session', { n: movers.length }) },
        h(
          'div',
          { className: 'tm-ah' },
          ...top.map((move) =>
            h(
              'button',
              {
                key: `${move.row.symbol}:${move.session}`,
                className: 'tm-ah__row',
                onClick: () => onOpen && onOpen(move.row),
                title: t('Change since the previous regular close'),
              },
              h('span', { className: 'tm-ah__sym' }, move.row.symbol),
              h('span', { className: 'tm-ah__sess' }, sessionLabel(move.session, t)),
              h('span', { className: 'tm-ah__last' }, money(move.price, (move.row.quote && move.row.quote.currency) || 'USD')),
              h('span', { className: `tm-ah__pct ${trendClass(move.changePct)}` }, percent(move.changePct)),
            ),
          ),
        ),
        h('p', { className: 'tm-ah__note' }, t('These prints are outside regular hours; the next open can gap to them.')),
      )
    }

    // A desktop notification only has one line, so the reason has to survive
    // without the row around it: symbol first, then the fact that fired.
    function alertReasonLine(crossed, armed, latest, position, t, currency) {
      if (crossed === 'loss') return t('down {pct} from your cost', { pct: percent(position && position.pct) })
      if (crossed === 'up' || crossed === 'down') return t('{pct} today', { pct: percent(latest && latest.changePct) })
      // The currency comes from the row: a bound printed without its sign reads
      // as a different number on a non-dollar venue.
      if (crossed === 'above' && armed && isNum(armed.above)) return `${t('above')} ${money(armed.above, currency)}`
      if (crossed === 'below' && armed && isNum(armed.below)) return `${t('below')} ${money(armed.below, currency)}`
      return ''
    }

    // Returns what the browser notification would say, or null when there is
    // nothing to announce. Kept pure so the wording is testable without a
    // browser: three rows at most, because a notification is glanced at, not read.
    function notificationText(fired, t) {
      if (!Array.isArray(fired) || !fired.length) return null
      const lines = fired.slice(0, 3).map((item) => {
        const currency = item.row.quote && item.row.quote.currency
        const reason = alertReasonLine(item.crossed, item.armed, item.latest, item.position, t, currency)
        return reason ? `${item.row.symbol} ${reason}` : String(item.row.symbol)
      })
      if (fired.length > 3) lines.push('+' + String(fired.length - 3))
      return { title: t('{n} alerts triggered', { n: fired.length }), body: lines.join(' · ') }
    }

    // Remounting the banner (a filter change, say) must not re-announce a hit
    // that was already delivered: one signature, one notification.
    let notifiedSignature = ''

    function notificationsSupported() {
      return typeof window !== 'undefined' && typeof window.Notification === 'function'
    }

    /**
     * The history is already a list of facts with a timestamp; a spreadsheet is
     * how someone keeps a record across weeks, and the copy button cannot do
     * that. Reasons are written in the reader's language, same as the copy.
     */
    function alertLogCsv(entries, t) {
      const list = Array.isArray(entries) ? entries : []
      const cell = (value) => {
        const text = value === null || value === undefined ? '' : String(value)
        return /[" ,\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text
      }
      const lines = ['Time,Symbol,Kind,Detail,Key']
      for (const entry of list) {
        if (!entry) continue
        const kind = entry.hit === 'event' ? 'event' : entry.hit === 'loss' ? 'loss' : entry.hit || ''
        lines.push([clockOf(entry.at), entry.symbol || '', kind, alertLogReason(entry, t), entry.key || ''].map(cell).join(','))
      }
      return lines.join('\r\n')
    }

    function AlertLogCard({ entries, onOpen, onClear }) {
      const [copied, setCopied] = useState(false);
      const { t } = useT()
      const [todayOnly, setTodayOnly] = useState(false)
      if (!entries || !entries.length) return null
      const pool = todayOnly ? alertLogToday(entries) : entries
      const shown = pool.slice(0, 6)
      const count = todayOnly ? t('{n} today', { n: pool.length }) : t('{n} entries', { n: entries.length })
      return h(
        Card,
        {
          title: [h(Icon, { name: 'bell', size: 14 }), t('Alert history')],
          right: h(
            'div',
            { className: 'tm-alog__filter' },
            h(
              'button',
              {
                className: 'tm-alog__chip' + (todayOnly ? ' tm-alog__chip--on' : ''),
                'aria-pressed': todayOnly ? 'true' : 'false',
                title: t('Show only what fired today'),
                onClick: () => setTodayOnly((on) => !on),
              },
              t('Today'),
            ),
            h('span', null, count),
          ),
        },
        h(
          'div',
          { className: 'tm-alog' },
          shown.length
            ? shown.map((entry) => {
              // Only an earnings reminder has a page to open; a macro print or
              // a holiday has a symbol column but no ticker behind it.
              const openable = !(entry.hit === 'event' && entry.type !== 'earnings')
              const box = {
                key: `${entry.key}:${entry.at}`,
                className: 'tm-alog__row' + (entry.hit === 'event' ? ' tm-alog__row--event' : ''),
                title: `${clockOf(entry.at)} \u00b7 ${alertLogReason(entry, t)}`,
              }
              if (openable) {
                box.onClick = () => {
                  const cut = entry.key.indexOf(':')
                  onOpen({ symbol: entry.symbol, market: cut > 0 ? entry.key.slice(0, cut) : null })
                }
              }
              return h(
                openable ? 'button' : 'div',
                box,
                h('span', { className: 'tm-alog__sym' }, entry.symbol),
                h('span', { className: 'tm-alog__what' }, alertLogReason(entry, t)),
                h('span', { className: 'tm-alog__when' }, clockOf(entry.at)),
              )
            })
            : h('p', { className: 'tm-alog__empty' }, t('Nothing has fired today.')),
        ),
        h(
          'div',
          { className: 'tm-alog__foot' },
          h('span', null, t('Kept on this device only, newest first.')),
          h(
            'span',
            { className: 'tm-alog__acts' },
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost',
                title: t('Copy the alert history as plain text'),
                onClick: () => {
                  const text = alertLogText(entries, t).join('\n');
                  Promise.resolve(navigator.clipboard && navigator.clipboard.writeText(text))
                    .then(() => {
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    })
                    .catch(() => {});
                },
              },
              copied ? t('Copied') : t('Copy history'),
            ),
            h(
              'button',
              {
                className: 'tm-btn tm-btn--ghost',
                title: t('Download the history as a spreadsheet'),
                onClick: () => {
                  const blob = new Blob(['\ufeff' + alertLogCsv(entries, t)], { type: 'text/csv;charset=utf-8' })
                  const url = URL.createObjectURL(blob)
                  const link = document.createElement('a')
                  link.href = url
                  link.download = `alerts-${new Date().toISOString().slice(0, 10)}.csv`
                  document.body.appendChild(link)
                  link.click()
                  link.remove()
                  window.setTimeout(() => URL.revokeObjectURL(url), 0)
                },
              },
              t('Download CSV'),
            ),
            h('button', { className: 'tm-btn tm-btn--ghost', onClick: onClear }, t('Clear history')),
          ),
        ),
      )
    }

    function AlertsBanner({ rows, alerts, costs, onOpen }) {
      const { t } = useT()
      const [acks, ack, ackAll] = useAcks()
      const [, recordLog] = useAlertLog()
      const fired = []
      for (const row of rows) {
        const armed = alertOf(alerts, row)
        const latest = latestPrint(row.quote)
        const position = positionOf(row.quote, costOf(costs, row))
        const crossed = alertHit(latest && latest.price, armed) || lossHit(position, armed) || moveHit(row.quote, armed)
        if (!crossed) continue
        const level = alertLevel(crossed, latest, position, row.quote)
        if (alertSnoozed(crossed, level, ackOf(acks, row))) continue
        fired.push({ row, armed, crossed, latest, position, level })
      }
      // A browser notification closes the loop the panel cannot: the alert is
      // only useful if it reaches someone who is not looking at the tab. Sent
      // once per distinct set of hits, and only while the tab is in the back.
      const sig = fired.map((item) => `${trackKey(item.row)}:${item.crossed}`).join('|')
      useEffect(() => {
        if (!sig || !notificationsSupported()) return
        if (window.Notification.permission !== 'granted') return
        if (!document.hidden) return
        const message = notificationText(fired, t)
        if (!message || sig === notifiedSignature) return
        notifiedSignature = sig
        try {
          new window.Notification(message.title, { body: message.body, tag: 'tm-alerts', renotify: false })
        } catch (error) {
          // Some browsers refuse construction outside a service worker; a missed
          // notification must never break the banner itself.
        }
      }, [sig])
      // The log is what survives the banner: dismissed, scrolled away, or the
      // tab was in the back when it happened.
      useEffect(() => {
        if (!sig) return
        recordLog(
          fired.map((item) => ({
            key: trackKey(item.row),
            symbol: item.row.symbol,
            hit: item.crossed,
            level: item.level,
            pct: item.crossed === 'up' || item.crossed === 'down' ? item.row.quote && item.row.quote.changePct : item.position ? item.position.pct : null,
            currency: (item.row.quote && item.row.quote.currency) || 'USD',
          })),
        )
      }, [sig])
      if (!fired.length) return null
      const currency = (row) => (row.quote && row.quote.currency) || 'USD'
      return h(
        'div',
        { className: 'tm-alerts' },
        h(
          'div',
          { className: 'tm-alerts__head' },
          h('span', { className: 'tm-alerts__title' }, t('{n} alerts triggered', { n: fired.length })),
          h(
            'button',
            {
              className: 'tm-btn tm-btn--ghost',
              onClick: () => ackAll(fired.map((item) => ({ record: item.row, hit: item.crossed, level: item.level }))),
            },
            t('Dismiss all'),
          ),
        ),
        fired.map(({ row, armed, crossed, latest, position, level }) =>
          h(
            'div',
            {
              key: trackKey(row),
              className: 'tm-alerts__row' + (crossed === 'above' ? ' tm-alerts__row--up' : ' tm-alerts__row--down'),
            },
            h(
              'button',
              { className: 'tm-alerts__main', onClick: () => onOpen(row) },
              h('span', { className: 'tm-alerts__sym' }, row.symbol),
              h(
                'span',
                { className: 'tm-alerts__last' },
                latest ? money(latest.price, currency(row)) : '—',
                latest && latest.session !== 'regular'
                  ? h('span', { className: 'tm-alerts__sess' }, sessionLabel(latest.session, t))
                  : null,
              ),
              h(
                'span',
                { className: 'tm-alerts__what' },
                crossed === 'loss'
                  ? t('down {pct} from your cost', { pct: position && position.pct !== null ? percent(position.pct) : '' })
                  : crossed === 'up' || crossed === 'down'
                    ? t('{pct} today', { pct: percent(row.quote && row.quote.changePct) })
                    : `${crossed === 'above' ? t('above') : t('below')} ${money(crossed === 'above' ? armed.above : armed.below, currency(row))}`,
              ),
            ),
            h(
              'button',
              {
                className: 'tm-iconbtn tm-iconbtn--ghost',
                title: t('Dismiss until the price moves 1% further'),
                onClick: () => ack(row, crossed, level),
              },
              '×',
            ),
          ),
        ),
      )
    }

    /**
     * Macro release labels: the calendar stores a kind, the reader wants the
     * name they already know.
     */
    const MACRO_KINDS = {
      cpi: 'US CPI',
      ppi: 'US PPI',
      jobs: 'US jobs report (NFP)',
      gdp: 'US GDP',
      pce: 'Income & Outlays (PCE)',
      fomc: 'FOMC decision',
    }

    /**
     * The event board: everything dated that will move a US book in the coming
     * weeks — earnings, macro prints, exchange closures and monthly expiries —
     * in one chronological list instead of three cards the reader has to
     * interleave by hand.
     *
     * The three sources answer different questions, but they feed one decision:
     * how much room is there between now and the next thing that moves this
     * position. Kept in three stacks the colliding weeks are invisible — an
     * earnings date landing the day after CPI is a different risk from either
     * event alone. One sorted list shows the collision, while the type filter
     * still lets each voice be read on its own.
     *
     * Every row also carries a plain-language consequence: a date answers
     * "when", and "so what" is the half a bare calendar leaves out.
     */
    const EVENT_TYPE_ORDER = ['earnings', 'macro', 'opex', 'closure']
    const EVENT_TYPE_CHIP = { earnings: 'Earnings', macro: 'Macro', closure: 'Closed', opex: 'Expiry' }

    /** Name of a merged row, in the reader's language. */
    function eventTitleOf(row, t, lang) {
      if (row.type === 'earnings') return row.symbol
      if (row.type === 'macro') return t(MACRO_KINDS[row.kind] || row.kind)
      if (row.type === 'opex') return t('Monthly options expiry')
      return lang === 'zh' ? row.nameZh || row.name : row.name
    }

    /** The one secondary fact a row shows without repeating its impact line. */
    function eventDetailOf(row, t) {
      if (row.type === 'earnings') {
        return row.epsForecast == null ? t('time not announced') : `${t('EPS est.')} ${money(row.epsForecast, 'USD')}`
      }
      if (row.type === 'macro') return row.time ? `ET ${row.time}${row.ref ? ` · ${row.ref}` : ''}` : row.ref || null
      if (row.type === 'opex') return t('Third Friday')
      const closure = row.close ? t('Early close {close} ET', { close: row.close }) : t('Closed all day')
      return row.quarterly ? `${closure} · ${t('quarterly')}` : closure
    }

    /** "today" / "tomorrow" / "in 5 days" — the shortest honest distance. */
    function eventWhenOf(row, t) {
      if (row.days === 0) return t('today')
      if (row.days === 1) return t('tomorrow')
      return t('in {n} days', { n: row.days })
    }

    /**
     * One consequence per row, phrased as what happens to the book rather than
     * as a restatement of the indicator's name.
     */
    function eventImpactOf(row, t) {
      if (row.type === 'earnings') {
        if (row.session === 'pre') return t('Reports before the open: the open reprices it')
        if (row.session === 'post') return t('Reports after the close: the next open reprices it')
        return t('Time not announced: treat the whole session as exposed')
      }
      if (row.type === 'macro') {
        if (row.kind === 'cpi') return t('Inflation print: rate expectations reprice every position at once')
        if (row.kind === 'fomc') return t('Rate decision: usually the widest move window of the month')
        if (row.kind === 'jobs') return t('Jobs print: the first input for the next rate move')
        if (row.kind === 'ppi') return t('Pipeline inflation: reads like CPI in miniature')
        if (row.kind === 'pce') return t('The Fed’s preferred inflation gauge, second only to CPI')
        if (row.kind === 'gdp') return t('Growth print: moves index exposure, rarely a single stock')
        return t('Macro print: moves every position at once')
      }
      if (row.type === 'opex') return t('Options expire at the close: volume clusters into the last hour')
      if (row.close) return t('Closes at {close} ET: later orders wait for the next session', { close: row.close })
      return t('Closed all day: no fills, and prices stand still')
    }

    // The board already answers "what is coming up" for anyone looking at it.
    // A reminder earns its interruption only when the tab is hidden, so this
    // reuses the merged rows (never disagreeing with the screen) and covers the
    // two days where a decision actually has to change: today and tomorrow.
    /** A short tag for the history column: a ticker when there is one, the
     *  print's shorthand otherwise, so the 64px column never clips a sentence. */
    function eventReminderSymbolOf(row, t) {
      if (row.type === 'earnings') return row.symbol
      if (row.type === 'macro') return String(row.kind || 'MACRO').toUpperCase()
      return row.type === 'opex' ? t('Expiry') : t('Closed')
    }
    function eventReminderOf(rows, t, lang) {
      const soon = rows.filter((row) => row.days === 0 || row.days === 1)
      if (!soon.length) return null
      const todayCount = soon.filter((row) => row.days === 0).length
      // A single event is the common case; "1 events" would read like a bug.
      const title = todayCount
        ? todayCount > 1
          ? t('{n} events today', { n: todayCount })
          : t('Market event today')
        : soon.length > 1
          ? t('{n} events tomorrow', { n: soon.length })
          : t('Market event tomorrow')
      const lines = soon
        .slice(0, 3)
        .map((row) => `${eventTitleOf(row, t, lang)} ${eventWhenOf(row, t)}`)
      const body = lines.join(' · ') + (soon.length > 3 ? ` +${soon.length - 3}` : '')
      // The same reminder also leaves a line in the alert history: a message
      // that only exists as an OS toast is gone the moment it is dismissed,
      // and 'why did I get pinged at 7am' deserves an answer on the panel.
      const items = soon.map((row) => ({
        key: `US:event:${row.date}:${row.type}:${row.symbol || row.kind || row.type}`,
        symbol: eventReminderSymbolOf(row, t),
        hit: 'event',
        type: row.type,
        when: row.days === 0 ? 'today' : 'tomorrow',
      }))
      return { title, body, items }
    }

    function useEventReminder(reminder, today, record) {
      // Keyed on the text itself rather than the object: the rows are
      // recomputed freely, but an identical message must not fire twice on the
      // same day, and tomorrow's message must get through.
      const title = reminder ? reminder.title : ''
      const body = reminder ? reminder.body : ''
      const items = reminder ? reminder.items : null
      // Two signatures on purpose: the history line is written whenever the
      // board learns of the event, but the OS toast still waits for a hidden
      // tab, so opening the panel at noon must not swallow the evening ping.
      useEffect(() => {
        if (!title) return
        const signature = `${today}|${title}|${body}`
        try {
          if (window.localStorage.getItem('tm-ev-logged') === signature) return
          window.localStorage.setItem('tm-ev-logged', signature)
        } catch (_) {
          /* storage denied: one duplicate beats a missing record */
        }
        if (typeof record === 'function' && items && items.length) record(items)
      }, [title, body, today])
      useEffect(() => {
        if (!title || !notificationsSupported()) return
        if (window.Notification.permission !== 'granted') return
        if (!document.hidden) return
        const signature = `${today}|${title}|${body}`
        try {
          if (window.localStorage.getItem('tm-ev-reminded') === signature) return
          window.localStorage.setItem('tm-ev-reminded', signature)
        } catch {
          /* storage denied: announcing once more is better than silence */
        }
        try {
          new window.Notification(title, { body, tag: 'tm-events' })
        } catch {
          /* some hosts refuse the constructor; the board still lists the rows */
        }
      }, [title, body, today])
    }

    /**
     * Merge the three calendar payloads into one sorted list.
     *
     * `payload` carries the three route answers (`bySymbol`, macro `events`,
     * `closures`, `expiries`) plus the `today` they agree on. `options` carries
     * the display window, the type filter and the symbol filter. Counts are
     * computed before filtering so the type chips can advertise what each one
     * would reveal.
     */
    /**
     * A macro print inside the next two days changes how a single name trades:
     * the whole tape re-prices at once, so a clean setup can be run over by the
     * index. The detail page says so before the reader acts, and says nothing
     * on ordinary days. The server stamps `days` on each release, so no client
     * date arithmetic (and no timezone guess) is involved.
     */
    function macroWatchNote(rows, translator) {
      const t = typeof translator === 'function' ? translator : makeT('en')
      const near = (rows || []).find((row) => row && (row.days === 0 || row.days === 1))
      if (!near) return null
      return {
        when: near.days === 0 ? t('today') : t('tomorrow'),
        title: MACRO_KINDS[near.kind] || t('Macro'),
        detail: near.time ? `ET ${near.time}` : '',
        impact:
          near.days === 0
            ? t('A macro print today re-prices the whole tape: a clean chart setup can be run over by the index.')
            : t('A macro print tomorrow can move every name at once; size new entries accordingly.'),
      }
    }

    function mergeEventRows(payload, options) {
      const input = payload || {}
      const opts = options || {}
      // Two days is the "do I trade today" window; 7 and 30 are planning
      // windows. Anything else falls back to the widest, never to silent 0.
      const days = opts.days === 2 || opts.days === 7 ? opts.days : 30
      const today = String(input.today || new Date().toISOString().slice(0, 10)).slice(0, 10)
      const type = EVENT_TYPE_ORDER.includes(opts.type) || opts.type === 'exchange' ? opts.type : 'all'
      const needle = String(opts.query || '').trim().toUpperCase()
      const limit = Number.isFinite(opts.limit) ? opts.limit : 20
      // "Held only" narrows one thing: a report on a name the reader does not
      // own is information, not a deadline. Market-wide rows stay, because a
      // CPI print lands on every position whether or not it has a ticker.
      const held = opts.held instanceof Set ? opts.held : new Set(Array.isArray(opts.held) ? opts.held : [])
      const heldOnly = Boolean(opts.heldOnly) && held.size > 0
      const all = []

      const distanceOf = (date) => {
        const distance = daysBetween(date, today)
        return distance !== null && distance >= 0 && distance <= days ? distance : null
      }

      for (const [symbol, event] of Object.entries(input.bySymbol || {})) {
        if (!event || !event.date) continue
        const distance = distanceOf(event.date)
        if (distance === null) continue
        all.push({
          key: `earnings:${symbol}:${event.date}`,
          type: 'earnings',
          date: event.date,
          days: distance,
          symbol,
          session: event.session || 'unknown',
          epsForecast: event.epsForecast == null ? null : event.epsForecast,
        })
      }
      for (const release of input.macro || []) {
        if (!release || !release.date) continue
        const distance = distanceOf(release.date)
        if (distance === null) continue
        all.push({
          key: `macro:${release.kind}:${release.date}`,
          type: 'macro',
          date: release.date,
          days: distance,
          kind: release.kind,
          time: release.time || null,
          ref: release.ref || null,
        })
      }
      for (const row of input.closures || []) {
        if (!row || !row.date) continue
        const distance = distanceOf(row.date)
        if (distance === null) continue
        all.push({
          key: `closure:${row.date}`,
          type: 'closure',
          date: row.date,
          days: distance,
          close: row.close || null,
          name: row.name,
          nameZh: row.nameZh || null,
          quarterly: Boolean(row.quarterly),
        })
      }
      for (const row of input.expiries || []) {
        if (!row || !row.date) continue
        const distance = distanceOf(row.date)
        if (distance === null) continue
        all.push({ key: `opex:${row.date}`, type: 'opex', date: row.date, days: distance })
      }

      all.sort(
        (a, b) =>
          a.days - b.days ||
          EVENT_TYPE_ORDER.indexOf(a.type) - EVENT_TYPE_ORDER.indexOf(b.type) ||
          a.date.localeCompare(b.date) ||
          a.key.localeCompare(b.key),
      )

      const counts = { earnings: 0, macro: 0, exchange: 0, soon: 0, total: all.length }
      for (const row of all) {
        counts[row.type === 'closure' || row.type === 'opex' ? 'exchange' : row.type] += 1
        if (row.days <= 7) counts.soon += 1
      }

      // A symbol query only ever means "this name's earnings"; the type chips
      // are cleared by the control that sets it, so the two never fight.
      let rows = all
      if (needle) rows = rows.filter((row) => row.type === 'earnings' && row.symbol.toUpperCase().includes(needle))
      else if (type === 'exchange') rows = rows.filter((row) => row.type === 'closure' || row.type === 'opex')
      else if (type !== 'all') rows = rows.filter((row) => row.type === type)
      // Held-only narrows earnings only; macro and exchange rows stay because
      // they land on every position whether or not it has a ticker.
      if (heldOnly) rows = rows.filter((row) => row.type !== 'earnings' || held.has(row.symbol))


      // A merged board only earns its keep if a collision is stated: an earnings
      // print that lands on a CPI morning is one session with two repricing
      // events, not two rows to read in sequence. Counted over the rows that are
      // actually shown, so a filter can never point at something off-screen.
      const visible = rows.slice(0, limit)
      const perDay = new Map()
      for (const row of visible) perDay.set(row.date, (perDay.get(row.date) || 0) + 1)
      for (const row of visible) row.sameDay = (perDay.get(row.date) || 1) - 1

      return { rows: visible, counts, today }
    }

    /**
     * Which watchlist names are actually positions. The brief's action ideas
     * are written server-side from quotes, so the model cannot know whether a
     * line lands on money the reader already has; the panel can, and a
     * suggestion about a holding is a different instruction from one about a
     * name on the list.
     */
    function heldSymbols(rows, costs) {
      const held = new Set()
      for (const row of rows || []) {
        const position = positionOf(row.quote, costOf(costs, row))
        if (position && typeof row.symbol === 'string') held.add(row.symbol.toUpperCase())
      }
      return held
    }

    /**
     * Positions the brief will never mention. The brief reads the watchlist, so
     * a holding that was removed from the list — or bought and never added — is
     * invisible to every action idea written about this account. The cost store
     * still knows, which is why the check lives here rather than server-side:
     * no cost basis is ever sent upstream. Zero shares is a placeholder, not a
     * position, and a row that IS on the list is not orphaned.
     */
    function orphanHoldings(rows, costs, limit = 6) {
      const known = new Set()
      for (const row of rows || []) known.add(trackKey(row))
      const out = []
      for (const [key, entry] of Object.entries(costs || {})) {
        if (!entry || !isNum(entry.shares) || entry.shares <= 0) continue
        if (!isNum(entry.price) || entry.price <= 0) continue
        if (known.has(key)) continue
        const cut = key.indexOf(':')
        const market = cut > 0 ? key.slice(0, cut) : null
        const symbol = cut > 0 ? key.slice(cut + 1) : key
        if (!symbol) continue
        out.push({ key, symbol, market, value: entry.shares * entry.price })
      }
      out.sort((a, b) => b.value - a.value)
      return out.slice(0, limit)
    }

    /**
     * The window shows what is coming; this says what it costs the reader. An
     * earnings date on a name you hold is not the same event as one on a name
     * you watch, and the difference is invisible until the two are put together.
     * Built once per board render, keyed by symbol.
     */
    function positionIndex(rows, costs) {
      const index = new Map()
      for (const row of rows || []) {
        const position = positionOf(row.quote, costOf(costs, row))
        if (position) index.set(row.symbol, position)
      }
      return index
    }

    /**
     * A board is read from the top: the next few dates decide today, the rest is
     * planning. Eight rows is roughly one screen, so the tail waits behind a
     * click instead of pushing the footer off the page.
     */
    function eventPage(rows, expanded, cap = 8) {
      const list = Array.isArray(rows) ? rows : []
      const shown = expanded ? list : list.slice(0, cap)
      return { rows: shown, hidden: list.length - shown.length }
    }

    function EventBoard({ onOpen, rows: watchRows, costs, onCounts }) {
      const { t, lang } = useT()
      // The window choice sticks across refreshes, same contract as the
      // watchlist sort: a bad or missing value just falls back to 30.
      const [days, setDays] = useState(() => {
        try {
          const stored = Number(window.localStorage.getItem('tm-events-window'))
          return stored === 2 || stored === 7 || stored === 30 ? stored : 30
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
      // The type chip sticks the same way the window does: a reader who only
      // cares about macro should not have to re-pick it on every reload, and a
      // stale value that no longer exists falls back to the full board.
      const [type, setType] = useState(() => {
        try {
          const stored = window.localStorage.getItem('tm-events-type')
          return stored === 'earnings' || stored === 'macro' || stored === 'exchange' ? stored : 'all'
        } catch {
          return 'all'
        }
      })
      useEffect(() => {
        try {
          window.localStorage.setItem('tm-events-type', type)
        } catch {
          /* storage denied: the chip still filters this session */
        }
      }, [type])
      const [query, setQuery] = useState('')
      // The held filter persists like the two chips above; it is meaningless
      // until a position exists, so the chip only appears when one does.
      const [expanded, setExpanded] = useState(false)
      const [heldOnly, setHeldOnly] = useState(() => {
        try {
          return window.localStorage.getItem('tm-events-held') === '1'
        } catch {
          return false
        }
      })
      useEffect(() => {
        try {
          window.localStorage.setItem('tm-events-held', heldOnly ? '1' : '0')
        } catch {
          /* storage denied: the chip still filters this session */
        }
      }, [heldOnly])
      // Three routes, one board. A single failing source still contributes the
      // other two; the card hides only when every source came back empty.
      const earnings = useAsync((signal) => apiGet('/earnings?days=30', signal), [])
      const macro = useAsync((signal) => apiGet('/macro?days=30', signal), [])
      const calendar = useAsync((signal) => apiGet('/closures?days=45', signal), [])
      const loading = earnings.loading || macro.loading || calendar.loading
      const today =
        (earnings.data && earnings.data.today) ||
        (calendar.data && calendar.data.today) ||
        new Date().toISOString().slice(0, 10)
      const positions = useMemo(() => positionIndex(watchRows, costs), [watchRows, costs])
      const merged = useMemo(
        () =>
          mergeEventRows(
            {
              bySymbol: (earnings.data && earnings.data.bySymbol) || {},
              macro: (macro.data && macro.data.events) || [],
              closures: (calendar.data && calendar.data.closures) || [],
              expiries: (calendar.data && calendar.data.expiries) || [],
              today,
            },
            { days, type, query, heldOnly, held: positions.keys() },
          ),
        [earnings.data, macro.data, calendar.data, days, type, query, heldOnly, positions, today],
      )
      const rows = merged.rows
      const counts = merged.counts
      // The jump bar sits above the board and cannot read its state, so the
      // count that matters (how much is coming within a week) is reported up.
      // Keyed on the numbers, not the object, so a re-render cannot loop.
      useEffect(() => {
        if (typeof onCounts === 'function') onCounts({ soon: counts.soon, total: counts.total })
      }, [counts.soon, counts.total])
      const [, recordLog] = useAlertLog()
      useEventReminder(eventReminderOf(rows, t, lang), today, recordLog)
      if (!loading && !counts.total) return null

      const chips = [
        ['all', t('All'), counts.total],
        ['earnings', t('Earnings'), counts.earnings],
        ['macro', t('Macro'), counts.macro],
        ['exchange', t('Exchange'), counts.exchange],
      ]
      const next = rows.length ? rows[0] : null
      return h(
        Card,
        {
          title: [Icon({ name: 'calendar', size: 14 }), t('What is coming up')],
          className: 'tm-card--events',
          id: 'tm-events-card',
        },
        loading
          ? h(Spinner)
          : h(
              'div',
              { className: 'tm-ev' },
              next
                ? h(
                    // The nearest event is the one a reader is most likely to act
                    // on, so it behaves like its row: an earnings line opens the
                    // name, a macro line stays static because it has no detail page.
                    next.type === 'earnings' && onOpen ? 'button' : 'div',
                    next.type === 'earnings' && onOpen
                      ? {
                          className: 'tm-ev__next tm-ev__next--link',
                          type: 'button',
                          onClick: () => onOpen({ symbol: next.symbol, market: 'US' }),
                        }
                      : { className: 'tm-ev__next' },
                    h('span', { className: 'tm-ev__nextlabel' }, t('Next up')),
                    h(
                      'span',
                      { className: 'tm-ev__nextbody' },
                      `${eventTitleOf(next, t, lang)} · ${eventWhenOf(next, t)}`,
                    ),
                    h('span', { className: 'tm-ev__nexthint' }, eventImpactOf(next, t)),
                  )
                : null,
              h(
                'div',
                { className: 'tm-ev__controls' },
                h(
                  'div',
                  { key: 'types', className: 'tm-ev__chips' },
                  chips.map(([key, label, count]) =>
                    h(
                      'button',
                      {
                        key,
                        type: 'button',
                        className: 'tm-chip' + (type === key && !query.trim() ? ' tm-chip--active' : ''),
                        title: t('Show only {kind}', { kind: label }),
                        onClick: () => {
                          setType(key)
                          setQuery('')
                        },
                      },
                      `${label}${count ? ` ${count}` : ''}`,
                    ),
                  ),
                ),
                h(
                  'div',
                  { key: 'windows', className: 'tm-ev__chips tm-ev__chips--right' },
                  positions.size
                    ? h(
                        'button',
                        {
                          key: 'held',
                          type: 'button',
                          className: 'tm-chip' + (heldOnly ? ' tm-chip--active' : ''),
                          title: t('Only the earnings dates of names you hold; market-wide rows stay'),
                          onClick: () => setHeldOnly(!heldOnly),
                        },
                        t('Held only'),
                      )
                    : null,
                  positions.size
                    ? h(
                        'button',
                        {
                          key: 'held',
                          type: 'button',
                          className: 'tm-chip' + (heldOnly ? ' tm-chip--active' : ''),
                          title: t('Only the earnings dates of names you hold; market-wide rows stay'),
                          'aria-pressed': heldOnly,
                          onClick: () => setHeldOnly(!heldOnly),
                        },
                        t('Held only'),
                      )
                    : null,
                  [2, 7, 30].map((option) =>
                    h(
                      'button',
                      {
                        key: option,
                        type: 'button',
                        className: 'tm-chip' + (days === option ? ' tm-chip--active' : ''),
                        onClick: () => setDays(option),
                      },
                      // "2 days" is not a planning window, it is today's desk.
                      option === 2 ? t('Today and tomorrow') : t('{n}d window', { n: option }),
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'tm-ev__controls' },
                h('input', {
                  key: 'filter',
                  className: 'tm-ev__filter',
                  type: 'search',
                  value: query,
                  placeholder: t('Filter by symbol'),
                  spellCheck: false,
                  onChange: (event) => setQuery(String(event.target.value || '')),
                }),
                h(
                  'span',
                  { key: 'count', className: 'tm-ev__meta' },
                  days === 2
                    ? t('{n} in the next two days', { n: counts.total })
                    : t('{n} total · {soon} within 7 days', { n: counts.total, soon: counts.soon }),
                ),
              ),
              rows.length
                ? h(
                    'div',
                    { className: 'tm-ev__list' },
                    // Quiet week headers keep "which print lands when" readable
                    // when the window spans weeks; a single bucket stays flat.
                    (() => {
                      const page = eventPage(rows, expanded)
                      const shown = page.rows
                      const bucketOf = (row) => (row.days <= 7 ? 0 : row.days <= 14 ? 1 : 2)
                      const spread = shown.length > 3 && new Set(shown.map(bucketOf)).size > 1
                      const labels = [t('This week'), t('Next week'), t('Later')]
                      const list = []
                      let lastBucket = -1
                      for (const row of shown) {
                        const bucket = bucketOf(row)
                        if (spread && bucket !== lastBucket) {
                          list.push(
                            h('div', { key: `bucket:${bucket}`, className: 'tm-ev__group', 'aria-hidden': 'true' }, labels[bucket]),
                          )
                        }
                        lastBucket = bucket
                        const detail = eventDetailOf(row, t)
                        const props = {
                          key: row.key,
                          className:
                            'tm-ev__row tm-ev__row--' +
                            (row.type === 'closure' || row.type === 'opex' ? 'exchange' : row.type) +
                            (row.days <= 7 ? ' tm-ev__row--soon' : '') +
                            (row.days === 0 ? ' tm-ev__row--today' : ''),
                          title: [
                            eventTitleOf(row, t, lang),
                            detail,
                            row.sameDay ? t('+{n} same day', { n: row.sameDay }) : null,
                            eventImpactOf(row, t),
                          ]
                            .filter(Boolean)
                            .join(' · '),
                        }
                        if (row.type === 'earnings' && onOpen) {
                          props.type = 'button'
                          props.onClick = () => onOpen({ symbol: row.symbol, market: 'US' })
                        }
                        list.push(
                          h(
                            props.type ? 'button' : 'div',
                            props,
                            h(
                              'span',
                              { className: 'tm-ev__top' },
                              h('span', { className: 'tm-ev__date' }, `${monthDay(row.date)} · ${weekdayLabel(row.date, lang)}`),
                              h('span', { className: 'tm-ev__chip tm-ev__chip--' + row.type }, t(EVENT_TYPE_CHIP[row.type])),
                              h('span', { className: 'tm-ev__name' }, eventTitleOf(row, t, lang)),
                              detail ? h('span', { className: 'tm-ev__detail' }, detail) : null,
                              row.sameDay
                                ? h('span', { className: 'tm-ev__same' }, t('+{n} same day', { n: row.sameDay }))
                                : null,
                              h(
                                'span',
                                { className: 'tm-ev__when' + (row.days <= 7 ? ' tm-ev__when--soon' : '') },
                                eventWhenOf(row, t),
                              ),
                            ),
                            h(
                              'span',
                              { className: 'tm-ev__impact' },
                              eventImpactOf(row, t),
                              positions.has(row.symbol)
                                ? h(
                                    'b',
                                    { className: 'tm-ev__held' },
                                    ` · ${t('You hold {amount}', { amount: money(positions.get(row.symbol).value, positions.get(row.symbol).currency) })}`,
                                  )
                                : null,
                            ),
                          ),
                        )
                      }
                      if (page.hidden > 0 || expanded) {
                        list.push(
                          h(
                            'button',
                            { key: 'more', type: 'button', className: 'tm-ev__more', onClick: () => setExpanded(!expanded) },
                            expanded ? t('Show less') : t('Show the other {n}', { n: page.hidden }),
                          ),
                        )
                      }
                      return list
                    })(),
                  )
                : h(
                    'div',
                    { className: 'tm-hint' },
                    query.trim()
                      ? t('No watchlist earnings match that filter.')
                      : t('Nothing in the next {days} days for this filter.', { days }),
                  ),
              h(
                'div',
                { className: 'tm-ev__hint' },
                t('Earnings move one name; macro prints move everything; a half day caps when you can trade.'),
              ),
              counts.macro
                ? h(
                    'div',
                    { className: 'tm-ev__hint' },
                    t('Dates verified against the official calendars (BLS / Fed / BEA)'),
                  )
                : null,
              // Saying where the reminder comes from is what makes it findable:
              // the permission is granted elsewhere, so the board owns the news.
              notificationsSupported() && window.Notification.permission === 'granted'
                ? h(
                    'div',
                    { className: 'tm-ev__hint' },
                    t('Today and tomorrow also arrive as a desktop alert while this tab is hidden.'),
                  )
                : null,
            ),
      )
    }

    // Quotes only move when something asks for them, and this panel usually sits
    // open in a sidebar for hours. One minute is short enough to notice a move
    // and long enough not to hammer the provider; the tick skips hidden tabs.
    const AUTO_REFRESH_MS = 60000

    // The home page is one long column: search, pulse, alerts, the calendar,
    // heat, news, the board, the overview, the brief. These three are the cards
    // a reader opens the panel for, and scrolling to them by hand is the most
    // repeated gesture in the whole panel.
    const JUMP_TARGETS = [
      ['tm-watchlist-card', 'Watchlist'],
      ['tm-events-card', 'Events'],
      ['tm-brief-card', 'Brief'],
    ]
    /**
     * Scrolls a card into view by id. Returns false when the card is not on the
     * page (an empty board renders the starter pool instead), so the caller can
     * stay silent rather than throwing inside a click handler.
     */
    function jumpTo(id) {
      if (typeof document === 'undefined' || !id || typeof document.getElementById !== 'function') return false
      const node = document.getElementById(id)
      if (!node || typeof node.scrollIntoView !== 'function') return false
      node.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return true
    }

    // The brief costs a model call (or a full data round trip for the rule
    // edition), and the panel is opened and closed all day. The last one is
    // kept locally, in the language it was written in: an English paragraph
    // served to a Chinese reader is worse than no brief at all, so a language
    // switch starts from empty.
    const BRIEF_CACHE_KEY = 'tm-brief-last'
    const BRIEF_CACHE_MAX = 200 * 1024
    // A brief is written against one session's prices. Served a day later it is
    // not a convenience but a false statement, so the cache is allowed to live
    // about one trading day and then expires into an empty card.
    const BRIEF_CACHE_TTL = 12 * 60 * 60 * 1000

    function briefStorage() {
      try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
      } catch (error) {
        return null
      }
    }

    function readBriefCache(lang) {
      const store = briefStorage()
      if (!store || typeof lang !== 'string') return null
      try {
        const raw = store.getItem(BRIEF_CACHE_KEY)
        if (!raw || raw.length > BRIEF_CACHE_MAX) return null
        const parsed = JSON.parse(raw)
        if (!parsed || parsed.lang !== lang) return null
        if (!isNum(parsed.at) || Date.now() - parsed.at > BRIEF_CACHE_TTL) return null
        const brief = parsed.brief
        if (!brief || typeof brief.headline !== 'string') return null
        return brief
      } catch (error) {
        return null
      }
    }

    // The sector strip belongs to the same run as the paragraph: restoring the
    // text without it would leave a card that looks complete but is missing the
    // context that justified the text.
    function readBriefSectors(lang) {
      const store = briefStorage()
      if (!store || typeof lang !== 'string') return null
      try {
        const raw = store.getItem(BRIEF_CACHE_KEY)
        if (!raw || raw.length > BRIEF_CACHE_MAX) return null
        const parsed = JSON.parse(raw)
        if (!parsed || parsed.lang !== lang) return null
        if (!isNum(parsed.at) || Date.now() - parsed.at > BRIEF_CACHE_TTL) return null
        if (!Array.isArray(parsed.sectors) || !parsed.sectors.length) return null
        return parsed.sectors
      } catch (error) {
        return null
      }
    }

    function writeBriefCache(brief, lang, sectors) {
      const store = briefStorage()
      if (!store || !brief || typeof brief.headline !== 'string' || typeof lang !== 'string') return false
      try {
        const kept = Array.isArray(sectors) && sectors.length ? sectors : null
        const payload = JSON.stringify({ lang, brief, sectors: kept, at: Date.now() })
        if (payload.length > BRIEF_CACHE_MAX) return false
        store.setItem(BRIEF_CACHE_KEY, payload)
        return true
      } catch (error) {
        return false
      }
    }

    /**
     * The concentration and drift sentences used to exist only inside a
     * generated brief, so a reader who never pressed the button never learned
     * that one name was 42% of the book. They are local arithmetic, and they
     * are shown as soon as there is a cost basis — the brief may then repeat
     * them, which is fine: a warning that appears twice is still one warning.
     */
    function noteParts(line, symbols) {
      const text = typeof line === 'string' ? line : ''
      const known = Array.isArray(symbols) ? symbols.filter((sym) => typeof sym === 'string' && sym) : []
      if (!text || !known.length) return text ? [{ text }] : []
      // Longest first so "GOOGL" is tried before a hypothetical "GOOG", and the
      // boundaries keep "NVDAX" from matching "NVDA".
      const ordered = known.slice().sort((a, b) => b.length - a.length).map((sym) => sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      const pattern = new RegExp('\\b(' + ordered.join('|') + ')\\b', 'g')
      const parts = []
      let last = 0
      let match = pattern.exec(text)
      while (match) {
        if (match.index > last) parts.push({ text: text.slice(last, match.index) })
        parts.push({ symbol: match[0] })
        last = match.index + match[0].length
        match = pattern.exec(text)
      }
      if (last < text.length) parts.push({ text: text.slice(last) })
      return parts
    }

    function AccountNotesCard({ notes, onOpen, symbols }) {
      const { t } = useT()
      const list = Array.isArray(notes) ? notes.filter((line) => typeof line === 'string' && line) : []
      if (!list.length) return null
      const shown = list.slice(0, 4)
      return h(
        Card,
        {
          title: t('Account notes'),
          right: h('span', { className: 'tm-hint tm-hint--tiny' }, t('From your own cost basis, before any brief')),
          className: 'tm-card--notes',
          id: 'tm-notes-card',
        },
        h(
          'ul',
          { className: 'tm-notes' },
          shown.map((line, i) =>
            h(
              'li',
              { key: 'n' + i, className: 'tm-notes__row' },
              noteParts(line, symbols).map((part, j) =>
                part.symbol
                  ? h(
                      'button',
                      {
                        key: 'p' + j,
                        type: 'button',
                        className: 'tm-notes__sym',
                        onClick: () => onOpen && onOpen({ symbol: part.symbol, market: 'US' }),
                      },
                      part.symbol,
                    )
                  : h('span', { key: 'p' + j }, part.text),
              ),
            ),
          ),
        ),
        list.length > shown.length
          ? h('p', { className: 'tm-notes__more' }, t('{n} more in the brief', { n: list.length - shown.length }))
          : null,
      )
    }

    function HomeView({ onOpen }) {
      const { ui, lang, t } = useT()
      const [alertLog, , clearLog] = useAlertLog()
      const [brief, setBrief] = useState(() => readBriefCache(lang))
      // 1.1: the day's sector board the brief was read against (echoed in the
      // route's meta); shown under the headline so the reader sees the context.
      const [briefSectors, setBriefSectors] = useState(() => readBriefSectors(lang))
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
      // Armed price alerts (localStorage). Read once per page, shared with the
      // detail view through the module-level cell in useAlerts.
      const [alerts] = useAlerts()
      const [costs] = useCosts()
      // Remembered across sessions: a reader who turned it off does not want it
      // back on after every reload, and one who left it on expects the board to
      // be current when they return to it.
      const [autoRefresh, setAutoRefresh] = useState(() => {
        try {
          return window.localStorage.getItem('tm-auto-refresh') !== '0'
        } catch {
          return true
        }
      })

      const data = bootstrap.data || {}
      const rows = data.items || []
      const aiAvailable = Boolean(data.ai && data.ai.available)
      const aiReason = (data.ai && data.ai.reason) || null
      const owned = useMemo(() => new Set(rows.map((row) => trackKey(row))), [rows])
      // Cost basis lives on this device, so the brief's own lines cannot carry
      // it; these notes are appended next to the action ideas instead.
      const ownNotes = useMemo(() => positionNotes(rows, costs, t), [rows, costs, lang])
      const [eventCounts, setEventCounts] = useState(null)
      // Only used to mark a brief's action idea as landing on a real position.
      const heldSet = useMemo(() => heldSymbols(rows, costs), [rows, costs])

      const reload = useCallback(() => bootstrap.reload(), [bootstrap])

      useEffect(() => {
        try {
          window.localStorage.setItem('tm-auto-refresh', autoRefresh ? '1' : '0')
        } catch {
          /* storage may be denied; the toggle still works for this session */
        }
      }, [autoRefresh])

      useEffect(() => {
        if (!autoRefresh) return undefined
        const id = window.setInterval(() => {
          // A hidden tab may be a closed laptop lid: waking it with a queue of
          // requests buys nothing the reader can see.
          if (typeof document !== 'undefined' && document.hidden) return
          reload()
        }, AUTO_REFRESH_MS)
        return () => window.clearInterval(id)
      }, [autoRefresh, reload])

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
            const nextBrief = value && value.brief ? value.brief : value && value.headline !== undefined ? value : null
            const nextSectors = value && value.meta && Array.isArray(value.meta.sectors) ? value.meta.sectors : null
            setBrief(nextBrief)
            setBriefSectors(nextSectors)
            writeBriefCache(nextBrief, lang, nextSectors)
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
        h(SearchBox, { onOpen, onAdd: addSymbol, owned, held: (row) => heldSet.has(String(row.symbol || '').toUpperCase()), rows }),
        h(
          'nav',
          { className: 'tm-jump', 'aria-label': t('Jump to') },
          h('span', { className: 'tm-jump__k' }, t('Jump to')),
          JUMP_TARGETS.map(([id, label]) => {
            const badge = id === 'tm-events-card' && eventCounts && eventCounts.soon > 0 ? String(eventCounts.soon) : null
            return h(
              'button',
              {
                key: id,
                type: 'button',
                className: 'tm-jump__btn',
                title: badge ? t('{n} in the next seven days', { n: eventCounts.soon }) : undefined,
                onClick: () => jumpTo(id),
              },
              t(label),
              badge ? h('span', { className: 'tm-jump__n' }, badge) : null,
            )
          }),
        ),
        h(ErrorNote, { error: bootstrap.error, onRetry: reload }),
        h(PulseStrip, { rows, onOpen }),
        h(AlertsBanner, { rows, alerts, costs, onOpen }),
        h(AlertLogCard, { entries: alertLog, onOpen, onClear: clearLog }),
        h(AfterHoursCard, { rows, onOpen }),
        h(EventBoard, { onOpen, rows, costs, onCounts: setEventCounts }),
        h(HeatStrip, { rows, onOpen }),
        h(SectorHeatCard, { onOpen }),
        h(HoldingNewsCard, { rows, costs, onOpen }),
        h(WatchlistCard, {
          rows,
          alerts,
          costs,
          loading: bootstrap.loading,
          error: null,
          onOpen,
          onRemove: removeSymbol,
          onFavorite: favourite,
          onMove: move,
          onRefresh: reload,
          autoRefresh,
          onToggleAutoRefresh: () => setAutoRefresh((on) => !on),
          browseMode: ui.browseMode,
          onToggleBrowse: () => setStore({ browseMode: !ui.browseMode }),
          identity: data.identity || null,
        }),
        h(AccountNotesCard, {
          notes: ownNotes,
          onOpen,
          symbols: rows.map((row) => String(row.symbol || '').toUpperCase()).filter(Boolean),
        }),
        h(MarketOverview, {
          onOpen,
          onAdd: addSymbol,
          owned,
          rows,
          held: heldSet,
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
          positions: ownNotes,
          held: heldSet,
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

      const [help, setHelp] = useState(false)
      useEffect(() => {
        const onKey = (event) => {
          if (wantsHelp(event)) {
            event.preventDefault()
            setHelp((open) => !open)
            return
          }
          if (event.key === 'Escape' && !event.defaultPrevented) setHelp(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [])

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
          h(
            'div',
            { className: 'tm-header__tail' },
            h(MarketClock),
            h(
              'button',
              {
                className: 'tm-iconbtn tm-header__help',
                title: t('Keyboard shortcuts (?)'),
                'aria-expanded': help ? 'true' : 'false',
                onClick: () => setHelp((open) => !open),
              },
              '?',
            ),
            h(ThemeToggle),
            h(LangToggle),
          ),
        ),
        h(
          'div',
          { className: 'tm-body' },
          ui.view === 'detail' && ui.symbol
            ? h(DetailView, { symbol: ui.symbol, market: ui.symbolMarket || null, onBack: () => setStore({ view: 'home' }), aiAvailable, aiReason, onOpen: openDetail })
            : h(HomeView, { onOpen: openDetail }),
        ),
        help
          ? h(
              'div',
              {
                className: 'tm-help',
                role: 'dialog',
                'aria-modal': 'true',
                'aria-label': t('Keyboard shortcuts'),
                onClick: () => setHelp(false),
              },
              h(
                'div',
                { className: 'tm-help__card', onClick: (event) => event.stopPropagation() },
                h(
                  'div',
                  { className: 'tm-help__head' },
                  h('span', { className: 'tm-help__title' }, t('Keyboard shortcuts')),
                  h(
                    'button',
                    { className: 'tm-iconbtn', title: t('Close'), onClick: () => setHelp(false) },
                    h(Icon, { name: 'close' }),
                  ),
                ),
                h(
                  'dl',
                  { className: 'tm-help__list' },
                  SHORTCUTS.map((row) =>
                    h(
                      'div',
                      { className: 'tm-help__row', key: row.keys },
                      h('dt', null, h('kbd', { className: 'tm-kbd' }, row.keys)),
                      h('dd', null, t(row.label)),
                    ),
                  ),
                ),
              ),
            )
          : null,
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
      /* One ring for everything reachable by Tab: the panel carries a lot of
         small buttons, and the browser default is invisible on these surfaces. */
      .tm-page :focus-visible { outline: 2px solid var(--tm-brand, #4b8bf5); outline-offset: 2px; }
      .tm-page :focus:not(:focus-visible) { outline: none; }
      /* Point the host alias names at the panel palette so every rule below
         follows the scheme without a second set of values. */
      .tm-page { --dsw-alias-bg-base: var(--tm-bg); --dsw-alias-bg-layer-1: var(--tm-surface); --dsw-alias-bg-layer-2: var(--tm-surface-2); --dsw-alias-bg-overlay: var(--tm-overlay); --dsw-alias-label-primary: var(--tm-text); --dsw-alias-label-secondary: var(--tm-text-dim); --dsw-alias-border-l1: var(--tm-border-1); --dsw-alias-border-l2: var(--tm-border-2); --dsw-alias-brand-primary: var(--tm-brand); --dsw-alias-brand: var(--tm-brand); --dsw-alias-layer-1: var(--tm-surface); --dsw-alias-layer-2: var(--tm-surface-2); --dsw-alias-text-muted: var(--tm-text-dim); --dsw-alias-state-warn-primary: var(--tm-warn); }

      .tm-themes { display: inline-flex; border: 1px solid var(--tm-border-2, #3a3a46); border-radius: 999px; overflow: hidden; }
      .tm-thm { border: 0; background: transparent; color: var(--tm-text-dim, #b6b6c2); font: inherit; font-size: 11px; padding: 2px 9px; cursor: pointer; line-height: 1.6; }
      .tm-thm + .tm-thm { border-left: 1px solid var(--tm-border-1, #26262e); }
      .tm-thm:hover { background: var(--tm-hover, #191920); color: var(--tm-text, #ffffff); }
      .tm-thm--active { background: var(--tm-brand, #4b8bf5); color: #fff; }

      .tm-session { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--tm-text-dim, #b6b6c2); border: 1px solid var(--tm-border-1, #26262e); border-radius: 999px; padding: 2px 9px; white-space: nowrap; cursor: help; }
      .tm-session__dot { width: 7px; height: 7px; border-radius: 50%; background: var(--tm-text-dim, #b6b6c2); opacity: .45; flex: 0 0 auto; }
      .tm-session--open .tm-session__dot { background: var(--tm-up, #35c98a); opacity: 1; }
      .tm-session--pre .tm-session__dot, .tm-session--post .tm-session__dot { background: var(--tm-warn, #e3b341); opacity: 1; }
      .tm-session__clock { color: var(--tm-text, #ffffff); font-variant-numeric: tabular-nums; }
      .tm-session__note { color: var(--tm-text-dim, #b6b6c2); font-size: 10px; max-width: 12em; overflow: hidden; text-overflow: ellipsis; }
      .tm-session--holiday .tm-session__dot { opacity: 1; }

      .tm-holdings { display: flex; flex-direction: column; gap: 2px; }
      .tm-hold { display: grid; grid-template-columns: 64px minmax(0, 1fr) minmax(56px, 128px) 56px; align-items: center; gap: 8px; padding: 3px 4px; border: 0; background: transparent; text-align: left; font-variant-numeric: tabular-nums; }
      button.tm-hold { cursor: pointer; border-radius: 8px; }
      button.tm-hold:hover { background: var(--tm-border-0, rgba(255, 255, 255, 0.05)); }
      .tm-hold__sym { font-size: 12px; font-weight: 600; color: var(--tm-text, #ffffff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tm-hold__name { font-size: 11.5px; color: var(--tm-text-dim, #b6b6c2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tm-hold__bar { display: block; height: 6px; border-radius: 999px; background: var(--tm-border-1, rgba(255, 255, 255, 0.12)); overflow: hidden; }
      .tm-hold__fill { display: block; height: 100%; border-radius: 999px; background: var(--tm-brand, #4b8bf5); }
      .tm-hold__w { font-size: 11.5px; color: var(--tm-text, #ffffff); text-align: right; }
      .tm-sectors { display: flex; flex-direction: column; gap: 3px; }
      .tm-sector { display: grid; grid-template-columns: minmax(0, 1fr) minmax(80px, 220px) 52px; align-items: center; gap: 10px; padding: 2px 0; font-variant-numeric: tabular-nums; }
      .tm-sector__name { font-size: 11.5px; color: var(--tm-text, #ffffff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tm-sector__bar { display: block; height: 6px; border-radius: 999px; background: var(--tm-border-1, rgba(255, 255, 255, 0.12)); overflow: hidden; }
      .tm-sector__fill { display: block; height: 100%; border-radius: 999px; background: var(--tm-brand, #4b8bf5); }
      .tm-brief__block--own { border-left: 2px solid color-mix(in srgb, var(--tm-brand,#4b8bf5) 45%, transparent); padding-left: 10px; }
    .tm-brief__own-note { margin-left: 8px; font-size: 11px; font-weight: 400; color: var(--tm-muted,#9aa0aa); }
    .tm-news { display: flex; flex-direction: column; gap: 2px; padding: 4px 8px 10px; }
    .tm-news__row + .tm-news__row { border-top: 1px solid var(--tm-border,#2a2a34); }
    .tm-news__row { display: flex; align-items: baseline; gap: 10px; padding: 8px 6px; border-radius: 8px; color: inherit; text-decoration: none; }
    .tm-news__row:hover { background: color-mix(in srgb, var(--tm-brand,#4b8bf5) 8%, transparent); }
    .tm-news__title { flex: 1; min-width: 0; font-size: 13px; line-height: 1.45; color: var(--tm-text,#ffffff); }
    .tm-news__meta { flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px; font-size: 11px; color: var(--tm-muted,#9aa0aa); white-space: nowrap; }
    .tm-news__age { font-variant-numeric: tabular-nums; }
    .tm-news__sym { flex: 0 0 auto; min-width: 46px; padding: 0; border: 0; background: none; text-align: left; cursor: pointer; font-size: 11px; font-weight: 600; color: var(--tm-brand,#4b8bf5); font-variant-numeric: tabular-nums; }
    .tm-news__sym:hover { text-decoration: underline; }
    .tm-news__body { display: flex; flex: 1 1 auto; min-width: 0; align-items: baseline; gap: 10px; color: inherit; text-decoration: none; }
    .tm-news__filter { display: inline-flex; align-items: center; gap: 8px; }
    .tm-news__chip { padding: 2px 9px; border-radius: 999px; font-size: 11px; line-height: 1.5; cursor: pointer; background: transparent; color: var(--tm-muted,#9aa0aa); border: 1px solid color-mix(in srgb, var(--tm-text,#ffffff) 16%, transparent); }
    .tm-news__chip:hover { color: var(--tm-text,#ffffff); }
    .tm-news__chip--on { color: var(--tm-brand,#4b8bf5); border-color: color-mix(in srgb, var(--tm-brand,#4b8bf5) 55%, transparent); }
    .tm-news__empty { margin: 6px 8px 10px; font-size: 12px; color: var(--tm-muted,#9aa0aa); }
    @media (max-width: 620px) {
      .tm-news__row { flex-wrap: nowrap; }
      .tm-news__body { flex-wrap: wrap; }
      .tm-news__meta { flex: 1 0 100%; justify-content: flex-end; margin-top: 2px; }
      .tm-news__title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    }
    .tm-sector__w { font-size: 11.5px; color: var(--tm-text-dim, #b6b6c2); text-align: right; }
      .tm-arb { display: flex; align-items: center; gap: 10px; margin: 2px 0 10px; }
      .tm-arb__cap { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 16%, transparent); color: var(--tm-brand, #4b8bf5); }
      .tm-arb__track { position: relative; flex: 1; height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 16%, transparent); }
      .tm-arb__track--flat { opacity: .45; }
      .tm-arb__mean { position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 999px; background: var(--tm-brand, #4b8bf5); transform: translate(-50%, -50%); }
      .tm-arb__pin { position: absolute; top: -4px; width: 2px; height: 14px; border-radius: 1px; background: var(--tm-text, #ddd); transform: translateX(-50%); }
      .tm-arb__pin--out { background: var(--tm-warn, #e3b341); }
      .tm-rate { margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--tm-border-1, #2a2a33); display: grid; gap: 7px; }
      .tm-rate:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
      .tm-rate__bar { display: flex; height: 7px; border-radius: 999px; overflow: hidden; background: var(--tm-tile, #1a1a21); }
      .tm-rate__seg { display: block; height: 100%; }
      .tm-rate__seg--strongBuy { background: color-mix(in srgb, var(--tm-up, #35c98a) 88%, transparent); }
      .tm-rate__seg--buy { background: color-mix(in srgb, var(--tm-up, #35c98a) 52%, transparent); }
      .tm-rate__seg--hold { background: var(--tm-border-2, #3a3a46); }
      .tm-rate__seg--sell { background: color-mix(in srgb, var(--tm-down, #ff6b5e) 52%, transparent); }
      .tm-rate__seg--strongSell { background: color-mix(in srgb, var(--tm-down, #ff6b5e) 88%, transparent); }
      .tm-rate__legend { display: flex; flex-wrap: wrap; gap: 2px 12px; margin-top: 5px; font-size: 11px; color: var(--tm-muted, #8a8a8a); }
      .tm-rate__list { display: grid; gap: 3px; }
      .tm-rate__head { font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--tm-muted, #8a8a8a); }
      .tm-rate__row { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto auto; gap: 8px; align-items: baseline; font-size: 12px; }
      .tm-rate__when { color: var(--tm-muted, #8a8a8a); font-variant-numeric: tabular-nums; }
      .tm-rate__firm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-rate__action { padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 1.6; border: 1px solid var(--tm-border-2, #3a3a46); color: var(--tm-muted, #8a8a8a); }
      .tm-rate__action--up { color: var(--tm-up, #35c98a); border-color: color-mix(in srgb, var(--tm-up, #35c98a) 45%, transparent); }
      .tm-rate__action--down { color: var(--tm-down, #ff6b5e); border-color: color-mix(in srgb, var(--tm-down, #ff6b5e) 45%, transparent); }
      .tm-rate__grade { color: var(--tm-muted, #8a8a8a); font-size: 11px; text-align: right; }
      .tm-row__flag--ext { border-color: transparent; background: color-mix(in srgb, var(--tm-brand,#4b8bf5) 14%, transparent); color: var(--tm-brand,#4b8bf5); }
      .tm-row__flag--ext.tm-up { color: var(--tm-up,#2fbf71); }
      .tm-row__flag--ext.tm-down { color: var(--tm-down,#e5534b); }
      .tm-detail__ext { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--tm-muted,#9aa0aa); }
      .tm-indexnote { margin: 0 0 10px; font-size: 12px; line-height: 1.5; color: var(--tm-muted, #9aa0aa); }
      .tm-row__flag--pnl { border-color: transparent; background: color-mix(in srgb, var(--tm-line,#e3e3ea) 40%, transparent); font-variant-numeric: tabular-nums; }
      .tm-portfolio { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 14px; margin: 2px 0 6px; font-size: 12px; }
      .tm-portfolio__item { display: inline-flex; align-items: baseline; flex-wrap: wrap; gap: 2px 6px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .tm-portfolio__trend { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
      .tm-portfolio__trend svg { display: block; }
      .tm-portfolio__trend--first { color: var(--tm-muted, #9aa0aa); font-style: italic; }
      .tm-portfolio__trend[role='button'] { cursor: pointer; border-radius: 6px; padding: 1px 4px; margin: -1px -4px; }
      .tm-portfolio__trend[role='button']:hover { background: var(--tm-hover, #1d1d1d); }
      .tm-portfolio__trend--open { flex-basis: 100%; }
      .tm-portfolio__k { font-size: 11px; color: var(--tm-muted,#9aa0aa); }
      .tm-portfolio__v { font-weight: 600; }
      .tm-portfolio__pnl { font-size: 11.5px; }
      .tm-portfolio__today { font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
      .tm-orphan { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; padding: 0 0 8px; font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
      .tm-day { display: flex; flex-wrap: wrap; gap: 4px 10px; padding: 0 0 8px; font-size: 11.5px; color: var(--tm-text-dim, #9aa4b2); }
      .tm-day__k { font-variant-numeric: tabular-nums; }
      .tm-day__item { font-variant-numeric: tabular-nums; opacity: 0.9; }
      .tm-notes { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }
      .tm-notes__row { font-size: 12px; line-height: 1.55; color: var(--tm-text-dim, #9aa4b2); }
      .tm-notes__row::before { content: '·'; margin-right: 6px; opacity: 0.55; }
      .tm-notes__sym { font: inherit; color: var(--tm-brand, #4b8bf5); background: none; border: 0; padding: 0; cursor: pointer; text-decoration: underline dotted; }
      .tm-notes__sym:hover { text-decoration: underline solid; }
      .tm-notes__more { margin: 6px 0 0; font-size: 11px; color: var(--tm-muted, #8a8f98); }
      .tm-orphan__k { letter-spacing: .02em; }
      .tm-orphan__btn { padding: 1px 7px; border-radius: 999px; border: 1px dashed color-mix(in srgb, var(--tm-warn, #c9a227) 55%, transparent); background: transparent; color: var(--tm-warn, #c9a227); font: inherit; font-size: 11px; cursor: pointer; }
      .tm-orphan__btn:hover { border-style: solid; }
      .tm-orphan__btn:focus-visible { outline: 2px solid var(--tm-focus, #4b8bf5); outline-offset: 1px; }
      .tm-row__flag--alert { color: var(--tm-brand, #4b8bf5); border-color: color-mix(in srgb, var(--tm-brand, #4b8bf5) 40%, transparent); }
      .tm-row__flag--hit { color: var(--tm-warn, #e3b341); border-color: color-mix(in srgb, var(--tm-warn, #e3b341) 55%, transparent); }
      .tm-alerts { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 12px; border: 1px solid color-mix(in srgb, var(--tm-warn, #e3b341) 48%, transparent); background: color-mix(in srgb, var(--tm-warn, #e3b341) 10%, transparent); }
      .tm-alerts__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
      .tm-alerts__title { font-size: 12px; font-weight: 600; }
      .tm-alerts__row { display: flex; align-items: center; gap: 8px; }
      .tm-alerts__main { display: flex; align-items: baseline; gap: 8px; flex: 1; min-width: 0; padding: 2px 4px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      .tm-alerts__main:hover { background: color-mix(in srgb, var(--tm-warn, #e3b341) 14%, transparent); }
      .tm-alerts__sym { font-family: var(--tm-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; font-weight: 600; }
      .tm-alerts__last { font-size: 12px; font-variant-numeric: tabular-nums; }
      .tm-alerts__sess { margin-left: 6px; font-size: 10px; color: var(--tm-muted,#9aa0aa); }
.tm-ah { display: flex; flex-direction: column; gap: 2px; }
.tm-ah__row { display: grid; grid-template-columns: 64px 56px minmax(0, 1fr) 72px; align-items: center; gap: 10px; padding: 7px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.tm-ah__row:hover { background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 8%, transparent); }
.tm-ah__sym { font-weight: 600; font-variant-numeric: tabular-nums; }
.tm-ah__sess { font-size: 11px; color: var(--tm-muted, #9aa0aa); }
.tm-ah__last { font-variant-numeric: tabular-nums; text-align: right; }
.tm-ah__pct { font-variant-numeric: tabular-nums; text-align: right; font-weight: 600; }
.tm-ah__note { margin: 6px 0 0; font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
.tm-pulse { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 0 4px; font-size: 12px; color: var(--tm-muted, #9aa0aa); }
.tm-pulse__item { font-variant-numeric: tabular-nums; }
.tm-pulse__lead { display: inline-flex; align-items: center; gap: 6px; padding: 2px 0; border: 0; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.tm-pulse__lead:hover { color: var(--tm-text, #ffffff); }
/* Equal-weight board against the index: one line, no verdict. The gap is
   arithmetic between two different risk profiles, so it stays a number. */
.tm-vs { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; padding: 0 0 9px; font-size: 12px; color: var(--tm-text-dim, #b6b6c2); }
.tm-vs b { font-weight: 600; font-variant-numeric: tabular-nums; }
.tm-vs__meta { color: var(--tm-muted, #8a8a8a); font-size: 11px; }
.tm-vs__sep { color: var(--tm-border-2, #3a3a46); }
.tm-vs__held { color: var(--tm-text, #e8e8ee); }
.tm-jump { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: -2px 0 2px; font-size: 11px; color: var(--tm-muted, #8b93a1); }
.tm-jump__k { letter-spacing: .04em; text-transform: uppercase; opacity: .75; }
.tm-jump__btn { padding: 2px 9px; border-radius: 999px; border: 1px solid var(--tm-border-2, #3a3a46); background: transparent; color: var(--tm-text-dim, #b9c0cc); font: inherit; cursor: pointer; }
.tm-jump__btn:hover { border-color: var(--tm-brand, #4b8bf5); color: var(--tm-text, #ffffff); }
.tm-jump__btn:focus-visible { outline: 2px solid var(--tm-focus, #4b8bf5); outline-offset: 1px; }
.tm-jump__n { margin-left: 5px; padding: 0 5px; border-radius: 999px; background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 24%, transparent); color: var(--tm-text, #ffffff); font-size: 10px; font-variant-numeric: tabular-nums; }
.tm-pulse__pct { font-weight: 600; font-variant-numeric: tabular-nums; }
  .tm-spark { display: inline-flex; align-items: center; margin-left: 2px; }
  .tm-spark svg { display: block; }
      .tm-alerts__what { font-size: 11.5px; color: var(--tm-text-dim, #8a8a8a); }
      .tm-alerts__row--up .tm-alerts__what { color: var(--tm-up, #2fbf71); }
      .tm-alerts__row--down .tm-alerts__what { color: var(--tm-down, #f2545b); }
      .tm-alog { display: flex; flex-direction: column; }
      .tm-alog__row {
        display: grid;
        grid-template-columns: 64px minmax(0, 1fr) 52px;
        align-items: baseline;
        gap: 10px;
        padding: 7px 8px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
      }
      .tm-alog__row:hover { background: var(--tm-hover, #1d1d1d); }
      /* Calendar entries borrow the history list but not its click habit: only
         an earnings row has a page behind it, and the gold tag keeps the two
         kinds of reminder apart at a glance. */
      .tm-alog__row--event { grid-template-columns: 76px minmax(0, 1fr) 52px; }
      .tm-alog__row--event .tm-alog__sym { color: var(--tm-warn, #c9a227); }
      div.tm-alog__row { cursor: default; }
      div.tm-alog__row:hover { background: transparent; }
      .tm-alog__sym { font-size: 12px; font-weight: 600; color: var(--tm-brand, #4b8bf5); font-variant-numeric: tabular-nums; }
      .tm-alog__what { font-size: 12px; color: var(--tm-text-dim, #8a8a8a); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .tm-alog__when { font-size: 11px; color: var(--tm-muted, #9aa0aa); font-variant-numeric: tabular-nums; text-align: right; }
      .tm-alog__filter { display: inline-flex; align-items: center; gap: 8px; }
    .tm-alog__chip { height: 24px; padding: 0 10px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--tm-text,#ffffff) 16%, transparent); background: transparent; color: var(--tm-text-dim,#b6b6c2); font: inherit; font-size: 11.5px; cursor: pointer; }
    .tm-alog__chip:hover { color: var(--tm-text,#ffffff); }
    .tm-alog__chip--on { border-color: color-mix(in srgb, var(--tm-brand,#4b8bf5) 55%, transparent); color: var(--tm-brand,#4b8bf5); }
    .tm-alog__empty { margin: 2px 0 6px; font-size: 12.5px; color: var(--tm-muted,#9aa0aa); }
    .tm-alog__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; margin-top: 6px; font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
    .tm-alog__acts { display: inline-flex; align-items: center; gap: 6px; }
      .tm-detail__alerts { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 14%, transparent); }
      .tm-alertfield { display: inline-flex; align-items: center; gap: 6px; }
      .tm-alertfield__k { font-size: 11.5px; color: var(--tm-text-dim, #8a8a8a); }
      .tm-alertfield__in { width: 96px; padding: 4px 8px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 22%, transparent); background: transparent; color: inherit; font: inherit; font-size: 12px; font-variant-numeric: tabular-nums; }
      .tm-alertstate { font-size: 11.5px; color: var(--tm-text-dim, #8a8a8a); }
      .tm-alertstate--hit { color: var(--tm-warn, #e3b341); font-weight: 600; }
      .tm-arb__ends { flex: 0 0 auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); font-variant-numeric: tabular-nums; }

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
      .tm-card__head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 40px; box-sizing: border-box; padding: 8px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, #242424); }
      .tm-card__title { margin: 0; display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; font-size: 13px; font-weight: 600; letter-spacing: .01em; }
      .tm-card__title svg { flex: 0 0 auto; }
      /* The watchlist toolbar keeps growing; wrapping here rather than at one
         breakpoint keeps it readable at every width between phone and desktop. */
      .tm-card__tools { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; row-gap: 6px; margin-left: auto; }
      .tm-auto--on { color: var(--tm-brand, #4b8bf5); border-color: color-mix(in srgb, var(--tm-brand, #4b8bf5) 55%, transparent); }
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
      /* 1.0.x event strip (goal: 大事件预警提醒). One row per date: which watchlist
         name reports, which macro print lands, which session ends early, all in
         one chronological list (see EventBoard). */
      .tm-list__group { display: block; padding: 8px 8px 2px; margin: 0; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-list__group:first-child { padding-top: 2px; }
      .tm-list__groupbtn { display: flex; align-items: center; gap: 6px; width: 100%; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; }
      .tm-list__groupbtn:hover { color: var(--tm-text, #ffffff); }
      .tm-list__groupbtn--closed { color: var(--tm-text-dim, #8a8a8a); }
      .tm-list__chev { display: inline-block; width: 10px; font-size: 9px; }
      .tm-ev { display: flex; flex-direction: column; gap: 8px; }
      .tm-ev__next { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--tm-brand, #4b8bf5) 34%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 8%, transparent); font-size: 12px; }
      .tm-ev__next--link { width: 100%; text-align: left; font: inherit; color: inherit; cursor: pointer; }
      .tm-ev__next--link:hover { border-color: color-mix(in srgb, var(--tm-brand, #4b8bf5) 60%, transparent); }
      .tm-ev__nextlabel { font-size: 10.5px; letter-spacing: .04em; text-transform: uppercase; color: var(--tm-brand, #4b8bf5); }
      .tm-ev__nextbody { font-weight: 600; }
      .tm-ev__nexthint { color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-ev__controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
      .tm-ev__chips { display: inline-flex; gap: 6px; flex-wrap: wrap; }
      .tm-ev__chips--right { margin-left: auto; }
      .tm-ev__filter { flex: 1 1 160px; min-width: 120px; padding: 4px 9px; border: 1px solid var(--tm-border-1); border-radius: 8px; background: var(--tm-tile); color: var(--tm-fg); font: inherit; font-size: 12px; outline: none; }
      .tm-ev__filter::placeholder { color: var(--tm-muted); }
      .tm-ev__filter:focus { border-color: var(--tm-brand); box-shadow: 0 0 0 3px var(--tm-focus); }
      .tm-ev__meta { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); font-variant-numeric: tabular-nums; }
      .tm-ev__list { display: flex; flex-direction: column; gap: 4px; }
      .tm-ev__more {
        align-self: flex-start;
        margin-top: 2px;
        padding: 3px 9px;
        border-radius: 999px;
        border: 1px dashed var(--tm-border-2, rgba(255, 255, 255, 0.18));
        background: transparent;
        color: var(--tm-text-dim, #a0a0a8);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .tm-ev__more:hover { border-color: var(--tm-brand, #4b8bf5); color: var(--tm-text, #ffffff); }
      .tm-ev__group { margin: 6px 0 2px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-ev__group:first-child { margin-top: 0; }
      .tm-ev__row { display: block; width: 100%; padding: 6px 9px; border: 1px solid var(--dsw-alias-border-l1, #262626); border-radius: 8px; background: var(--tm-tile, #1d1d1d); font: inherit; color: inherit; text-align: left; }
      .tm-ev__row--earnings { cursor: pointer; }
      .tm-ev__row--earnings:hover { background: var(--tm-hover, rgba(255,255,255,.08)); border-color: var(--dsw-alias-border-l2, #3a3a3a); }
      .tm-ev__row--soon { border-color: #c9a227; background: rgba(201, 162, 39, .08); }
      .tm-ev__row--today { border-color: var(--tm-brand, #4b8bf5); }
      .tm-ev__top { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; }
      .tm-ev__date { min-width: 74px; font-size: 11.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-ev__chip { flex: 0 0 auto; padding: 0 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1, #333); font-size: 10px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-ev__chip--earnings { color: var(--tm-brand, #4b8bf5); border-color: color-mix(in srgb, var(--tm-brand, #4b8bf5) 40%, transparent); }
      .tm-ev__chip--macro { color: #c9a227; border-color: color-mix(in srgb, #c9a227 40%, transparent); }
      .tm-ev__name { font-weight: 600; font-size: 12.5px; }
      .tm-ev__detail { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #9a9a9a); }
      .tm-ev__same { flex: 0 0 auto; padding: 0 6px; border-radius: 999px; font-size: 10px; line-height: 1.6; color: var(--tm-warn, #c9a227); border: 1px dashed color-mix(in srgb, var(--tm-warn, #c9a227) 55%, transparent); }
      .tm-ev__when { margin-left: auto; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #8f8f8f); }
      .tm-ev__when--soon { color: #c9a227; font-weight: 600; }
      .tm-ev__impact { display: block; margin-top: 1px; padding-left: 83px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #a0a0a0); }
      .tm-ev__held { font-weight: 600; color: var(--dsw-alias-label-primary, #e6e6e6); }
      .tm-row__weight { font-variant-numeric: tabular-nums; }
      .tm-row__flag--today { font-variant-numeric: tabular-nums; }
      .tm-row__weight--heavy { border-color: var(--tm-warn, #c9a227); color: var(--tm-warn, #c9a227); }
      .tm-ev__hint { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
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

      /* A label is one word or two, never a vertical stack of glyphs: the toolbar
         wraps as a whole instead of squeezing each chip. */
      .tm-btn { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; border: 1px solid var(--tm-border-1, #3a3a3a); background: var(--tm-btn-bg, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-label-primary, #eee); font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 7px; cursor: pointer; }
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
      .tm-result__held {
        flex: 0 0 auto;
        margin-left: 6px;
        padding: 0 5px;
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.7;
        color: var(--tm-warn, #c9a227);
        border: 1px solid color-mix(in srgb, var(--tm-warn, #c9a227) 45%, transparent);
      }
      .tm-result__meta { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-secondary, #888); white-space: nowrap; padding-left: 8px; }
      .tm-result__add { flex: 0 0 36px; display: inline-flex; align-items: center; justify-content: center; border: 0; border-left: 1px solid var(--dsw-alias-border-l1, #222); background: transparent; color: var(--dsw-alias-label-secondary, #8f8f8f); cursor: pointer; }
      .tm-result__add:hover:not(:disabled) { color: var(--dsw-alias-brand-primary, #4b8bf5); background: var(--tm-hover, #262626); }
      .tm-result__add:disabled { cursor: default; color: var(--tm-warn, #e3b341); }

      .tm-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .tm-list--plain { gap: 4px; padding-left: 4px; }
      .tm-list--plain li { font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary, #ddd); }
      .tm-row { display: flex; align-items: center; gap: 10px; padding: 8px 8px; border-radius: 8px; }
      .tm-row:hover { background: var(--tm-hover, #1d1d1d); }
      .tm-row--nav { background: color-mix(in srgb, var(--tm-brand, #4b8bf5) 12%, transparent); box-shadow: inset 2px 0 0 var(--tm-brand, #4b8bf5); }
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
        /* The card-top toolbar gains a chip with every release; on a narrow
           panel it wraps to a second line instead of pushing Export off the
           edge, and stays right-aligned so the title still owns the left. */
        /* The events card packs chips + filter + count on one baseline row; on a
           narrow phone that row overflows, so it wraps and the filter grows. */
        .tm-ev__controls { row-gap: 6px; }
        .tm-ev__impact { padding-left: 0; }
        /* The session chip is a nice-to-have: past 820px the clock text drops,
           past 620px the whole chip does, so it never fights the tabs for room. */
        .tm-session__clock { display: none; }
        /* Tag pills ride inside the fixed-width name column; past 620px the
           card-top filter chips already carry the grouping, so the pills drop
           instead of squeezing the name into a sliver. */
        @media (max-width: 620px) { .tm-row__tag { display: none; } .tm-session { display: none; } }
        /* A rating row's date is the least load-bearing cell; past 620px the
           firm, the action and the grades keep the row readable on their own. */
        @media (max-width: 620px) {
          .tm-rate__row { grid-template-columns: minmax(0, 1fr) auto auto; }
          .tm-rate__when { display: none; }
        }
        /* The date column is the least load-bearing part of a rating row: on a
           phone the firm, the direction and the grade keep the line readable. */
        @media (max-width: 620px) { .tm-rate__row { grid-template-columns: minmax(0, 1fr) auto auto; } .tm-rate__when { display: none; } }
      }

      .tm-detail { display: flex; flex-direction: column; gap: 12px; }
      .tm-detail__head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .tm-detail__actions { display: flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
      .tm-detail__id { display: flex; flex-direction: column; gap: 2px; min-width: 180px; }
      .tm-detail__title { margin: 0; font-size: 17px; }
      .tm-detail__sub { display: flex; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #999); flex-wrap: wrap; }
      .tm-rel { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 7px; margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #999); }
      .tm-rel__k { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; opacity: .8; }
      .tm-rel__v { font-variant-numeric: tabular-nums; }
      .tm-rel__gap { font-variant-numeric: tabular-nums; }
      /* The 20-session figure follows the day figure, separated by a dot so the
         two windows never read as one number. */
      .tm-rel__rs { font-variant-numeric: tabular-nums; }
      .tm-rel__rs::before { content: '·'; margin-right: 6px; opacity: .45; }
      .tm-macro { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 7px; margin-top: 3px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #999); }
      .tm-macro__k { font-size: 10px; letter-spacing: .04em; text-transform: uppercase; opacity: .8; }
      .tm-macro__name { color: var(--tm-warn, #c9a227); }
      .tm-macro__when { font-variant-numeric: tabular-nums; }
      .tm-macro__impact { flex: 1 1 220px; opacity: .9; }
      /* Keyboard affordances in the detail head. Touch devices never get the
         keys, so @media (hover:none) drops the hint entirely. */
      .tm-detail__keys { display: inline-flex; gap: 4px; margin-left: 2px; }
      .tm-detail__kbd { min-width: 18px; padding: 1px 5px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.28)); border-radius: 5px; background: var(--tm-tile, transparent); font-size: 10.5px; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #999); text-align: center; }
      @media (hover: none) { .tm-detail__keys { display: none; } }
      .tm-badge { border: 1px solid var(--dsw-alias-border-l2, #3a3a3a); border-radius: 999px; padding: 1px 7px; font-size: 11px; }
      .tm-badge--held { border-color: color-mix(in srgb, var(--tm-brand, #4b8bf5) 45%, transparent); color: var(--tm-brand, #4b8bf5); font-variant-numeric: tabular-nums; }
      .tm-detail__price { display: flex; flex-direction: column; gap: 2px; margin-left: auto; }
      .tm-detail__last { font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; }
      .tm-detail__chg { font-size: 12.5px; font-variant-numeric: tabular-nums; }

      .tm-ranges { display: flex; gap: 4px; }
      .tm-range { border: 1px solid var(--dsw-alias-border-l2, #333); background: transparent; color: var(--dsw-alias-label-secondary, #999); font: inherit; font-size: 12px; padding: 2px 10px; border-radius: 999px; cursor: pointer; }
      .tm-range:hover { color: var(--dsw-alias-label-primary, #eee); }
      .tm-range--active { background: var(--dsw-alias-brand-primary, #4b8bf5); border-color: transparent; color: #fff; }
      .tm-range__split { display: inline-flex; gap: 2px; margin-left: 8px; padding-left: 8px; border-left: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
      .tm-range--size { padding: 2px 8px; letter-spacing: 0.02em; }

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
      .tm-chart__level { stroke: var(--tm-warn, #c9a227); stroke-width: 1; stroke-dasharray: 4 3; opacity: 0.85; }
      .tm-chart__level-tag { fill: var(--tm-warn, #c9a227); font-size: 11px; letter-spacing: 0.02em; }
      .tm-chart__read { padding: 6px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--tm-text-dim, #9aa4b2); }
      .tm-chart__legend, .tm-chart__footer { display: flex; gap: 12px; font-size: 11px; color: var(--dsw-alias-label-secondary, #8c8c8c); flex-wrap: wrap; }
      .tm-chart__ma-key--ma20 { color: var(--tm-ma20, #e0b64a); } .tm-chart__ma-key--ma50 { color: var(--tm-ma50, #5aa7e0); } .tm-chart__ma-key--ma200 { color: var(--tm-ma200, #b07de0); }

      .tm-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      @media (max-width: 900px) { .tm-columns { grid-template-columns: 1fr; } }
      .tm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 12px; }
      .tm-cell { display: flex; flex-direction: column; gap: 1px; }
      .tm-cell__k { font-size: 11px; color: var(--dsw-alias-label-secondary, #8a8a8a); }
      .tm-cell__v { font-size: 12.5px; font-variant-numeric: tabular-nums; }
      .tm-desc { margin: 8px 0 0; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #a5a5a5); }
    .tm-header__help { width: 24px; height: 24px; font-size: 12px; font-weight: 700; }
    .tm-help { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); }
    .tm-help__card { width: min(420px, calc(100vw - 32px)); padding: 14px 16px 16px; border-radius: 12px; background: var(--tm-surface, #ffffff); color: var(--tm-text, #ffffff); box-shadow: 0 18px 48px rgba(0, 0, 0, 0.35); border: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 12%, transparent); }
    .tm-help__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
    .tm-help__title { font-size: 13px; font-weight: 600; }
    .tm-help__list { margin: 0; }
    .tm-help__row { display: flex; align-items: baseline; gap: 12px; padding: 5px 0; border-top: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 8%, transparent); }
    .tm-help__row:first-child { border-top: 0; }
    .tm-help__row dt { flex: 0 0 72px; margin: 0; }
    .tm-help__row dd { margin: 0; font-size: 12px; color: var(--tm-muted, #9aa0aa); }
    .tm-eps { display: flex; flex-direction: column; gap: 2px; }
    .tm-eps__row { display: grid; grid-template-columns: 72px minmax(96px, 1fr) minmax(48px, 120px) 64px; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--tm-border, #2a2a34); }
    .tm-eps__row:last-child { border-bottom: 0; }
    .tm-eps__q { font-size: 11.5px; color: var(--tm-muted, #9aa0aa); font-variant-numeric: tabular-nums; }
    .tm-eps__nums { font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .tm-eps__bar { height: 6px; border-radius: 999px; background: color-mix(in srgb, var(--tm-text, #ffffff) 10%, transparent); overflow: hidden; }
    .tm-eps__fill { display: block; height: 100%; border-radius: 999px; background: currentColor; }
    .tm-eps__pct { text-align: right; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .tm-sizing { display: flex; flex-wrap: wrap; gap: 10px 14px; margin-bottom: 12px; }
    .tm-sizing__field { display: flex; flex-direction: column; gap: 4px; min-width: 132px; flex: 0 1 auto; }
    .tm-sizing__k { font-size: 11px; color: var(--tm-muted, #9aa0aa); }
    .tm-sizing__in { width: 132px; padding: 5px 8px; border-radius: 8px; font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--tm-text, #ffffff); background: color-mix(in srgb, var(--tm-text, #ffffff) 6%, transparent); border: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 18%, transparent); }
    .tm-sizing__out { display: grid; grid-template-columns: repeat(auto-fit, minmax(104px, 1fr)); gap: 10px 14px; }
    .tm-sizing__cell { display: flex; flex-direction: column; gap: 2px; }
    .tm-sizing__v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
    .tm-sizing__note { margin-top: 8px; font-size: 11.5px; color: var(--tm-muted, #9aa0aa); }
    .tm-kbd { display: inline-block; min-width: 26px; padding: 1px 6px; border-radius: 6px; font: 600 11px/1.7 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; color: var(--tm-text, #ffffff); background: color-mix(in srgb, var(--tm-text, #ffffff) 8%, transparent); border: 1px solid color-mix(in srgb, var(--tm-text, #ffffff) 16%, transparent); }
    .tm-about { margin-top: 10px; }
    .tm-about__facts { display: flex; flex-wrap: wrap; gap: 4px 16px; }
    .tm-about__fact { font-size: 12px; color: var(--tm-text, #ffffff); }
    .tm-about__k { margin-right: 6px; color: var(--tm-muted, #9aa0aa); }
    .tm-about__link { color: var(--tm-brand, #4b8bf5); text-decoration: none; }
    .tm-about__link:hover { text-decoration: underline; }
    .tm-desc--clamp { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .tm-about__more { margin-top: 4px; padding: 0; font-size: 12px; cursor: pointer; background: none; border: 0; color: var(--tm-brand, #4b8bf5); }
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
      /* A rule-written brief is labelled before its numbers, not after them. */
      .tm-brief__local {
        display: inline-block;
        margin: -2px 0 6px;
        padding: 0 6px;
        border-radius: 999px;
        font-size: 10px;
        line-height: 1.7;
        letter-spacing: 0.04em;
        color: var(--tm-warn, #c9a227);
        border: 1px dashed color-mix(in srgb, var(--tm-warn, #c9a227) 55%, transparent);
      }
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
      .tm-brief__more { font-size: 11px; color: var(--tm-muted, #8a8f98); }
      .tm-brief__hold { display: inline-block; margin-right: 6px; padding: 0 5px; border-radius: 999px; font-size: 10px; line-height: 1.7; color: var(--tm-brand, #4b8bf5); border: 1px solid color-mix(in srgb, var(--tm-brand, #4b8bf5) 45%, transparent); }
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
      .tm-brief__age { color: var(--tm-warn, #b78103); }
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
        dateOfUtc,
        relativeDayOf,
        agoOf,
        recentNews,
        alertOf,
        alertHit,
        lossHit,
        alertLevel,
      moveHit,
      afterHoursMovers,
      marketPulse,
      boardVsIndex,
      buildGeometry,
      newsSymbols,
      readBriefCache,
      readBriefSectors,
      writeBriefCache,
      watchlistCsv,
      todayOf,
      AccountNotesCard,
      holdingBadge,
      capPositions,
      noteParts,
      HoldingNewsCard,
      jumpTo,
      JUMP_TARGETS,
      macroWatchNote,
      positionIndex,
      heldSymbols,
      orphanHoldings,
      dayDrivers,
      positionWeight,
      dividendIncome,
      AUTO_REFRESH_MS,
      sparkPoints,
      digestLines,
      briefLines,
      eventDaysOf,
      nextNavIndex,
      notificationText,
      alertReasonLine,
        alertSnoozed,
        appendAlerts,
      alertLogToday,
        alertLogReason,
        AlertLogCard,
      alertLogCsv,
      alertLogText,
      toggleInList,
        ackOf,
        latestPrint,
        alertBoundsText,
        costOf,
        positionOf,
        portfolioTotals,
      recordHistory,
      historyChange,
      historyPoints,
        positionNotes,
      sizeFor,
      suggestStop,
      quarterLabel,
        pnlPercent,
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
        MarketClock,
        usSessionInfo,
        EventBoard,
        mergeEventRows,
        eventReminderSymbolOf,
        eventReminderOf,
      eventPage,
        useEventReminder,
        eventImpactOf,
        eventTitleOf,
        eventDetailOf,
        eventWhenOf,
        EVENT_TYPE_CHIP,
        MACRO_KINDS,
        nextMacro,
        nextEarnings,
        nextEarningsEvent,
        nextExDividend,
        upcomingStrips,
        sectorTileOf,
        relativeStrength,
        SECTOR_ETF,
        ratingMix,
        ratingChanges,
        TradingApp,
        TradingNavIcon,
        PANEL_ID,
        SIDEBAR_ORDER,
        LangToggle,
        HomeView,
        WatchlistCard,
        WatchRow,
        DetailView,
        BriefCard,
        AiAnalysisSection,
        SearchBox,
        SearchRow,
        searchRowsOf,
        trackKey,
        parseWatchlistCsv,
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
      technicalDigest,
        money,
        percent,
        volumeText,
        siteOf,
        SHORTCUTS,
        wantsHelp,
        clockOf,
        nameOf,
      },
    }
    return module.exports
  },
})
