# 范围：只做美股

这个仓库是 [YuumaKobayashi/dsh-trading-mode](https://github.com/YuumaKobayashi/dsh-trading-mode) 的 fork，
产品定位从「多市场行情面板」收窄为「美股研究面板」。

## 目标

- 标的：美股个股 + 美股 ETF（含 ETF 的行业/宽基/债券分类）。
- 数据：报价、日线/K 线、技术指标、基本面快照、SEC 财报、分析师评级。
- 分析：基于当前数据快照的 AI 简报（走 DSH 的 `llm` 服务）。

## 不做

- 不接券商、不下单、不托管资金。
- 不做期权、做空、杠杆 ETF 的专门策略界面。
- 不做港股、A 股、日股、加密货币。

## 当前状态

界面层已收窄：`lib/client.js:482` 的 `MARKET_ORDER` 只剩 `['US']`，浏览清单和指数条不再出现
HK / CN / JP / 加密 的市场切换。

引擎层仍然是上游的多市场结构，下面这些还带着非美股的代码，按依赖顺序逐步删除：

1. **provider**：`lib/trading/providers/` 下的 `eastmoney.js`、`tencent.js`、`sina.js`（CN/HK/JP）、
   `binance.js`、`gate.js`、`coinlore.js`（加密）。保留 `yahoo.js`（主源）、`stooq.js`、`nasdaq.js`。
2. **市场词表**：`lib/trading/config.js:15` `MARKETS = ['US','HK','CN','JP','CRYPTO']`、
   `:16 STOCK_MARKETS`，以及 provider 注册表里按市场挂的链。
3. **代码解析**：`lib/trading/symbols.js` 里的 `.HK` / `.SH` / `.SZ` / `.BJ` / `.T` 后缀分支。
4. **指数清单**：`lib/trading/indices.js` 的 HK / CN / JP / CRYPTO 分组。
5. **测试**：`tests/offline/` 里断言上述市场行为的用例。

每删一层都要跑 `node tests/offline/run.mjs`，保持 0 failed。

## 与上游的关系

- `origin` = 本 fork，`upstream` = 作者仓库。
- 上游的 bug 修复按需 `git cherry-pick`；界面风格与市场范围不再跟随上游。
