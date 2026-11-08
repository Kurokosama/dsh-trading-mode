# dsh-trading-mode（美股 fork）

一个运行在 [DSH（DeepSeek Harness）](https://github.com/YuumaKobayashi/dsh-trading-mode) 里的美股研究面板。

> 本仓库是 [YuumaKobayashi/dsh-trading-mode](https://github.com/YuumaKobayashi/dsh-trading-mode) 的 fork，
> 只做**美股个股与美股 ETF**。港股、A 股、日股、加密货币不在范围内，正在从代码里移除，进度见
> [docs/SCOPE.md](docs/SCOPE.md)。

可以查报价、看 K 线和技术指标、浏览标的资料，也可以调用 DSH 的 `llm` 服务生成一份基于当前数据快照的分析。

**它不做的事**：不支持下单与券商账户接入，不提供投资建议（详见「当前没有做的功能」一节）。

当前版本为 **0.9.2（Beta）**。实际版本以 `package.json` 为准，也可以通过 `GET /api/trading/health` 查看。

## 与上游的差异

- **报价涨跌幅**：上游的 Yahoo 请求带了 `fields=regularMarketPrice`，响应被截断后算不出涨跌，整列显示「—」；
  本 fork 去掉该参数并在缺字段时回落到 chart 的 `chartPreviousClose`。
- **引擎**：市场范围收窄到美股。行情链只剩 `yahoo → stooq`，全量清单只剩 Nasdaq，指数目录改为 7 条美股指数
  （含罗素 2000 与费城半导体），代码解析只接受美股标的（其余报 `UNSUPPORTED_MARKET`）。
- **界面**：自选表改成单行 + 固定列宽 + 表头，市场指数改成等高卡片条，AI 简报改成带分节的结构，
  头部状态条改成两行网格；默认主题改为浅色。
- **1.0 轮新增能力**（详见 [CHANGELOG.md](CHANGELOG.md)）：首页事件提醒卡（30 天财报日历）、
  AI 简报的行动建议/板块语境/加载骨架、自选标签分组与三列排序、CSV/JSON 导入导出、
  自选热度条与板块温度计、搜索最近记录与本地标签匹配、详情页键盘巡览与 52 周位置条等。
  K 线图下方另有一行「指标说了什么」：均线排列、RSI 位置、离 52 周高多远、成交量放大还是缩量，
  一句话读完，并明说不构成买卖建议。
- **其后追加的能力**：交易所日历（NYSE 休市、提前收盘、月度期权到期）、盘前盘后价格与
  「盘后异动」卡、相关新闻与首页持仓新闻（可只看今天）、分析师共识与评级分布/评级变动、
  财报惊喜、ETF 行业分布与前十大持仓、持股与做空数据、本地价格提醒（价位/回撤/单日波动、
  桌面通知、提醒记录）、本机持仓成本与浮动盈亏、每日总值快照与 30 天走势线、仓位与风险计算器、
  图表日线/周线切换、`?` 快捷键一览。首页把财报、宏观发布、期权到期与休市合成一张按日期
  升序的「接下来有什么事」总表（按类型/代码/窗口筛选，每行一句影响说明）；今天/明天的事件在面板
  处于后台时会发成一条桌面通知（权限在自选卡上开），发过的提醒在「提醒记录」里留一行；填过成本价的
  标的，财报那行直接写出你持有的金额，让「下周三财报」变成「下周三这笔仓位要过一遍」。同一张表还带一个「只看持仓」开关：只留下你持仓的财报日，
  宏观与休市不筛（它们落在整个账户上）。简报的建议列表里，凡是以代码开头且该代码确有持仓的条目， 
  前面会带一枚「持仓」标记——同一句话对着已有仓位和对着观察名单，是完全不同的指令。会话里没有可用模型时，「生成简报」改用规则写一份同样的内容（计数、涨跌榜、放量、关键观察与推导建议），并在卡片上标「仅为规则生成建议里的参考位（52 周高低、均线、目标价）都直接标出确切价格。个股页把
  下一个财报与除息日按到达顺序排在一起（带倒计时和「想拿分红要在这天之前持有」这类规则说明），
  并且只向服务端要这一只票的日历窗口；分析师卡画出评级分布，并列出近半年的评级上调/下调；
  市场总览补一行自选等权与标普 500 的当日对比（含两者相差的 pp，只做算术不给结论）；
  搜索框除代码与英文名外也认中文名（内置名录覆盖 55 只美股与 26 只 ETF，「可口可乐」「摩根大通」
  这类常用叫法直接可搜，「苹果公司」也能命中名录里的「苹果」）。个股页在标题下把当天涨跌和它所属
  板块的 ETF 并排放（「强于板块 1.20pp」这种写法），只看一只票的百分比分不出抗跌还是拖累；
  同一行后半段还给 20 个交易日的相对强弱（「近 20 日相对板块 +3.4pp」），当天弱、近月强的回调
  与当天强、近月弱的反抽因此能分开；任一侧日线不足 21 根就整段不显示。事件卡的窗口分「今明 / 7 天 /
  30 天」三档：前两档是每天开盘前要看的，第三档用来排期。搜索框下面还有一条「跳到 自选 / 事件 / 简报」
  导航，省掉在长页面里往下翻。持仓新闻卡取的是**仓位最大**的六只票，不是自选顺序里的前六只。自选卡
  有「自动刷新」开关：开着时面板在前台每分钟重取一次行情，切到后台就不跑，开关记在本机；填过成本价的
  行还带一枚占比 chip（`25.0%`，超过 40% 转琥珀色），集中度不用翻计算器就能看见。个股页还会
  在标题下点出两天内的宏观发布（口径、时间、一句影响说明），免得只盯形态忘了今天有数据。填了持仓的
  标的会把分红换算成年化金额与成本收益率，而不是只显示每股分红。
  事件卡默认只铺开最近的八行，其余收在「展开另外 N 件」后面。
这些本地数据只存在浏览器 `localStorage`，不上传。

上游修复仍可按需 cherry-pick：`git remote add upstream https://github.com/YuumaKobayashi/dsh-trading-mode.git`。

> 这是研究工具，不是交易客户端。插件不接券商、不下单，也不提供投资建议。行情可能延迟，使用前请留意数据时间。

## 安装

插件必须由 DSH 加载，不能单独启动。需要 Node.js 20 或更高版本；目前实际测试的版本是 Node.js 24.15.0，宿主是 DSH `0.2.0-rc.2` 和 `0.2.1-rc.2`。其他环境见[兼容性](#兼容性)。

安装前先确认 DSH 正在使用哪个 profile。插件只会装进当前运行的 profile；如果装完找不到按钮，这是最值得先检查的一项。

### 1. 选择安装来源

在 DSH 的 **设置 → 插件 → 添加插件 → 安装第三方插件** 中，可以填以下任意一种来源。

| 来源 | 填入内容 | 适合场景 |
| --- | --- | --- |
| Git 仓库（推荐） | `github:Kurokosama/dsh-trading-mode#main` | 已安装 git 的机器 |
| 本地目录 | 插件源码所在的**绝对路径** | 离线安装、开发调试 |

本 fork 尚未发布 Release 包，也**没有**发布到 npm registry；上游那个 `dsh-trading-mode`
包名装的是作者版本，不是这个仓库。

Git 地址也可以写成 `https://github.com/Kurokosama/dsh-trading-mode#main`。本地路径中的 `~` 不会自动展开。

### 2. 在 DSH 中安装

将地址粘贴到 **Package name or address**，点击 **Install plugin**，按提示批准安装。

如果通过 DSH 助手执行插件管理操作，可以使用：

```text
plugin_manager({ action: "install_bundle", target: "github:Kurokosama/dsh-trading-mode#main" })
```

`plugin_manager(...)` 是 DSH 内部操作，不是需要复制到终端执行的 shell 命令。安装过程中 DSH 会更新当前 profile 的配置；不需要手动修改 `cordis.yml`、profile 的 `package.json` 或 `dsh.profile.bundles`。

安装完成后**重启 DSH**。宿主侧代码只在进程启动时加载；浏览器端刷新页面即可。

### 3. 检查是否安装成功

1. `plugin_manager({ action: "list_bundles" })` 中能看到 `dsh-trading-mode`，Loader 中有 `include:trading-mode`。
2. 刷新页面后，左侧栏（插件 / 插件市场 / 自动化任务 / 技能中心 那一列）能看到 **Trading Mode** 图标行；点击即可进入，不需要先打开会话。
3. 查看 `GET /api/trading/health`。它会返回插件版本、API、请求围栏和身份状态。

如果手边有源码副本，还可以运行：

```bash
npm run inspect:profile
npm run verify:install
```

前者只读检查哪些 profile 安装了插件，后者检查已安装副本和当前源码是否一致。详细说明在 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

### 升级、禁用和卸载

升级时改用新版本的 tag 或 `.tgz` 地址重新安装，再重启 DSH。自选、偏好和缓存放在 bundle 外，不会因为替换 bundle 而删除。

```text
plugin_manager({ action: "set_bundle", target: "dsh-trading-mode", enabled: false })
plugin_manager({ action: "remove_bundle", target: "dsh-trading-mode" })
```

第一行用于禁用，第二行用于卸载。卸载后也需要重启 DSH。

**卸载不会清除本地数据。** 数据默认放在 `<DSH_HOME>/trading-mode/`，其中 `DSH_HOME` 的解析顺序是 `$DSH_HOME`、`$DSH_DIR`、`~/.dsh`（见 `lib/index.js` 的 `resolveHomeDir()`）。需要彻底清理时，请自行删除该目录，或按照 [隐私文档](docs/PRIVACY.md) 处理。备份和迁移也可以复制这个目录，但数据仍与对应 DSH profile 和用户身份有关，不会自动跨设备同步。

## 开始使用

生成简报时，面板会随请求带上你的持仓清单（代码、股数、成本、市值），服务端逐行清洗后才交给模型；不填持仓时，简报对你的账户一无所知建议里出现的参考位（52 周高低、均线、目标价）都直接写明确切价格。建议条目自带「i」提示，悬停可见这条建议当时读到的数字（涨跌、52 周位置、RSI、量能、财报倒计时）。
今天一条建议都没触发时，建议区不会静默——会明确写「按兵不动就是今天的方案」，空列表是答复，不是坏了。以代码开头的建议若指向一只不在你自选里的代码，会带「不在你的列表」标记；在你列表上的不加标记，已持仓的标「持仓」——只标例外。持仓够大（占本币种账本 2% 以上）而且三天内要出财报的持仓，会在「账户笔记」里被点名：还有几天、占你仓位百分之几；小仓位和远处的财报不提。成本价直接在自选行里填：点行上的盈亏标记就展开买入价与股数，边填边显示这样值多少、盈亏多少，Enter 保存、Esc 关闭；没填过的行有一个「记持仓」入口。价格提醒同理：点行上的提醒标记就展开上破 / 下破 / 最大回撤 / 单日波动四个框（只填一个也算一条），没设过的行有一个「设提醒」入口。列表与个股页写的是同一份本地存储，两处不会给出两套答案。价格图下面还有一条与板块 ETF 同窗对比的线：两边收盘价按共同日期逐日相除、起点归一为 100，虚线是两者涨跌相同的位置；只画双方都有收盘的日期，共同日期不足 15 个交易日就不画。面板里的框统一按 border-box 度量，仓位占比是一条固定长度的轨道（其中的填充才是占比），不会随面板变宽而变长。列表的列宽是固定的：名称过长会截断，数字不会被挤到下一行，表头始终在它管的那一列上方；「记持仓」「设提醒」两个入口在鼠标移到行上或键盘聚焦时出现；仓位占比是名称下方的一条线，长度就是占比。

主面板通过宿主的 `main` 槽位挂载，侧栏入口单独注册。

主面板与侧栏入口分开注册：侧栏槽位缺失时页面照样能渲染。

如果宿主给面板的位置高度是 0，页面会在最上层显示一条固定提示，而不是留一片空白。

自选卡和简报卡对老数据也稳：早前版本存进本地缓存的简报如果缺了新的列表字段，卡片照样渲染，缺的整段不画。 首页在宽面板上把「板块热力 + 市场总览」「盘后异动 + 持仓新闻」排成左右两列，窄面板自动整行堆叠。事件表默认「重点」读法：只保留你的持仓、巨型公司财报与宏观、休市这类全市场行；点「全部」才铺开全市场财报日历，选择会记住。
整体版式走紧凑路线：卡片间距、标题条高度与字号层级统一（13px 基准、1.45 行高、抗锯齿），追求信息密度而不牺牲可读性。

简报生成后可以复制成文字，也可以直接存成 `brief-YYYY-MM-DD.txt`：剪贴板会被下一次复制覆盖，文件不会。

按 `?` 除了快捷键，还能看到「标记说明」：星标、持仓、今天、自上次打开、七天、同日各自是什么意思。

面板会记住上次打开时的价格；回来时若有仓位变动超过 0.5%，会在汇总下点名最多三只（相对「你上次看的时候」，不是相对昨收）。

K 线图带 aria-label（根数、起止日期、最新收盘），读屏软件能读出走势窗口。

自选汇总下面还有一句「今天是谁干的」：按金额点名贡献最大与拖累最大的两只，省去逐行找原因。

提醒记录可以下载成 CSV（时间/代码/类型/说明/key），与卡片里看到的是同一句话。

首页「跳到」导航的「事件」会显示未来七天的件数，数字来自事件卡本身。
事件表里的宏观数据与提前收盘若已过官方发布时间，会标成「已公布」或「已收盘」并转淡，也不再先出现在「接下来」横幅里、不再触发桌面提醒；财报没有公布钟点，因此永不被判为已结束。

账户笔记里「该做个决定」那句按金额筛：市值不到同币种账单 2% 的小仓位不会占用它。

简报的持仓小节最多列五条，更多只报数量；复制文本与导出保持同一口径（全量在 CSV 里）。

个股页标题行会标出「持仓 N 股 · 成本 X」，从搜索直接进来也能一眼看出这是不是已有仓位。

市场总览那一行里，若已有持仓，会再接一段「持仓等权」——用同一个指数说明钱是不是压在了涨的那一半。

填过成本价之后，自选卡片下方会直接列出账户笔记（集中度、今日贡献、仓位漂移），不必先写简报；笔记里出现的代码可以直接点进该标的。个股页的 52 周刻度也会把成本价画成一颗琥珀色空心的点，和现价落点同轴对照（成本不在区间内时不出现）。

搜索结果里，已经持有（填过成本价）的代码会带一枚「持仓」标，和「已在自选」的星标是两回事。

最后一次生成的简报（连同它依据的板块上下文）存在浏览器本机，关掉面板再打开仍在；按语言分别存，且 12 小时后自动作废——对着旧价格的建议不重复端出来。生成过的简报还会留一个小小的历史圈（最新 10 份），卡片右上角 ‹ n / m › 可以翻回上一份对照措辞；历史同样按语言分开、只存本机。

填过成本价的标的，K 线图上会多一条虚线标出成本价；成本价落在可视区间外时不画，避免暗示不存在的刻度。
自选里填过成本价的行还会带一枚当日金额，标出这一天给这笔持仓带来了多少（涨跌着色，不足 1 美元不显示）。 事件卡还能一键把当前清单导出成 .ics 日历文件，导入你自己的日历就能获得这些日期的提醒，宏观数据行还会带上公布时刻（08:30/14:00 ET，日历里是定时提醒而不是全天）。
列表还能按这枚当日金额排序（「按今日」chip），一屏就能看出今天谁在拖累账户。

自选卡上方会点名「持仓不在自选里」的代码：简报只读自选，漏在列表外的仓位不会被任何建议提到，点代码可以直接进详情加回来。
导出的 CSV 除代码与行情外还带持仓市值、浮盈亏与当日盈亏三列（按本机成本表算），可以直接当账户快照用。 最后一列会原样带上同行设过的价格提醒，导入时按这一列恢复到本机（老文件无此列，照常可读）。

在左侧栏点击 **Trading Mode** 进入，这是唯一入口（不需要先打开会话，会话标题栏也不再放按钮）。首次打开时，面板会从 `GET /api/trading`（也就是 `/api/trading/bootstrap`）读取自选列表、报价、推荐池、状态和偏好。某条报价获取失败时，该行会返回 `quote: null` 和错误码，不会拖垮整个面板。

面板支持中文和英文（`zh` / `en`），其他语言参数会得到 `400 BAD_REQUEST`。可以在面板头部切换深色和浅色主题；如果宿主提供 `theme` 服务，选择会通过 DSH 的主题偏好保存，否则只在当前会话生效。

行情不是实时推送。正常报价旁会显示 `Updated HH:MM:SS` 和 `Data may be delayed`；使用过期缓存时改为 `Last available data`，不会同时显示两种时间状态。具体时效分为：
| 状态 | 数据年龄 |
| --- | --- |
| `fresh` | 不超过 5 分钟 |
| `delayed` | 不超过 30 分钟 |
| `stale` | 不超过 24 小时 |
| `historical` | 超过 24 小时 |

面板不标注 Live、Real-time 或 Tick-level，也不提供 Level-2 行情。指数点位不代表可交易价格；
点击指数卡片打开的是最接近的可交易 ETF（例如标普 500 打开 SPY），恐慌指数不提供入口。

### AI 分析怎么工作

报价和成交量来自第三方数据源，经过插件校验、归一化后放入快照；SMA、EMA、RSI、MACD、ATR、枢轴等指标由插件本地计算。AI 只接收整理好的快照，通过 DSH 的 `llm` 服务分析，**不会自己访问财经网站取价**。

AI 是可选能力。即使宿主没配模型，行情面板仍可以使用；AI 区域会显示 `AI_UNAVAILABLE`，具体原因在 `GET /api/trading/status` 的 `ai.reason` 中。没有可用报价时，分析也会失败，不会生成一个看似完整但没有价格依据的结论。数据不够新时，AI 卡片会显示时效提示，并避免把旧数据描述成当前实时情况。

## 各市场支持情况

本 fork 只支持美股（US）。数据链路与实测结论如下：

| 能力 | 数据来源和限制 |
| --- | --- |
| 报价 | Yahoo Finance 优先，Stooq 兜底（Stooq 只出日 K，不能报价） |
| K 线 | Yahoo 日/周线（1d–1mo 分钟上限约 6 个月），分钟级粒度受上游限制，可能返回 `partial history` |
| 技术指标 | 插件本地计算（SMA/EMA/RSI/MACD/ATR 枢轴等），依赖 K 线长度，长周期指标在历史不足时省略 |
| 公司档案 | 仅 Yahoo 一条链路，失败时该 tile 显示错误码而不是合成档案 |
| 全量清单 | Nasdaq 官方清单（NASDAQ / NYSE / AMEX 全部板块），单失败自动回落 US-ALL 大表 |
| 财报日历 | Nasdaq 日历接口（非浏览器 User-Agent 会被拒，请求统一使用 `HTTP_POLICY.userAgent`），按日缓存 6 小时 |
| 基本面 | SEC EDGAR `companyfacts`（免密钥，`data.sec.gov`），ETF/基金无 XBRL 数据，不显示该卡 |
| 搜索 | 目录搜索 + 目录别名（中文别名、ETF 全称）；上线后自选行的本地标签与中文名也会参与匹配 |

线外说明：行情上游可能限频或限流，进程内缓存（报价短缓存、日历/基本面数小时）与逐 provider 健康采样
就是为此设计；`GET /api/trading/status` 可查看 provider 健康与当前缓存命中。

可以浏览的板块是 US 的 NASDAQ / NYSE / AMEX（`lib/trading/config.js` 的 `UNIVERSE_BOARDS`；
市场级配置见同文件的 `MARKET_DATA_CONFIG`）。搜索单次最多返回 100 条；类型配置见 `SEARCH_SECURITY_TYPES`。

### 当前没有做的功能

插件不支持下单、券商账户、持仓核算、盈亏、投资组合分析或回测；也没有公告流、新闻流、盘中估值刷新、tick 行情或全市场实时覆盖。自选和偏好只在当前 DSH profile 的本地存储中保存，不承诺跨设备同步。

## 配置

默认配置即可使用行情功能。以下都是可选项，配置位置是 profile patch 中 loader id 为 `trading-mode` 的插件 entry。修改前建议先参考 [开发文档](docs/DEVELOPMENT.md)；不要为了安装插件手动编辑 profile 配置。

```yaml
- id: trading-mode
  config:
    networkMode: auto  # auto | standard | compatibility
    providers:         # 示例：覆盖默认数据源顺序（只有 US 一个市场）
      US: ['stooq', 'yahoo']
    identity:
      localBucket: my-single-user-box  # 只适用于单用户部署
    security:
      allowUnfencedLoopback: false    # 默认关闭
```

`networkMode` 默认是 `auto`：平时使用 Node.js 标准 HTTP(S) 网络行为，只有某个 host 真正发生传输层失败时才切到兼容模式。`standard` 始终使用默认 DNS/连接策略；`compatibility` 会记录上次可用的地址族，并在重试时尝试固定或翻转。非法值会报配置错误。

`providers` 可以为市场指定有序的数据源列表（本 fork 只接受 `US`，链路顺序实际行走）。可用 id：`yahoo`、`stooq`、`nasdaq`。未知市场、未知 provider、重复项、空数组或非数组都不会覆盖默认配置，日志会说明原因。

`identity.localBucket` 只能用于你明确知道 **DSH 部署只有一个用户** 的场景。共享部署不要设置，否则不同用户会进入同一个存储桶。

`security.allowUnfencedLoopback` 是缺少宿主请求围栏时的本机调试例外，默认 `false`。仅在显式设置为 `true` 后允许回环来源（`127.0.0.1` / `::1`）绕过围栏；远端请求仍被拒绝。启动及每次实际放行都会写 error 级 `SECURITY` 日志。正常使用不建议开启。

AI 模型路由优先使用 `AI_CONFIG` 中可用的 `provider` / `model`，然后尝试 DSH 当前默认模型，最后寻找 `llm.listProviders()` 中第一个匹配 `/deepseek/i` 的模型。默认 `maxTokens` 为 2400、`temperature` 为 0.2、超时 120 秒。插件只调用宿主的 `ctx.get('llm').stream({...})`，不保存 API Key；鉴权和计费由 DSH 处理。

## 安全、存储和请求限制

### 请求围栏

插件依赖 DSH 的 `connection.requestRejection(req)` 检查 `/api/trading/*` 请求，与宿主 API 网关使用同一套判断，不另行实现 Origin/Host 检查或 IP 白名单。

如果围栏缺失或调用失败，除 `GET /api/trading/health` 外的路由都返回 **503 `HOST_SECURITY_UNAVAILABLE`**。这是有意设计的默认拒绝行为。`health` 是唯一例外：不读取用户配置、不访问上游、不返回用户数据，只返回 `{plugin, version, api, fence, identity, note}`。

如果使用反向代理，请确保它正确转发 `Host`、`Origin` 和浏览器会话，也不要将 `/api/trading` 暴露给未认证来源。

### 用户身份与本地数据

插件按以下顺序确定身份：

1. 宿主提供的 `@deepseek-ai/dsh-anonymous-user-id`。
2. 操作者显式配置的 `identity.localBucket`（仅单用户部署）。
3. 两者都没有时视为无身份。

没有可信身份仍可读取行情，但自选、偏好写入和按用户计量的路径会返回 **503 `NO_IDENTITY`**。插件不会默认为所有访问者共用同一份用户数据。当前身份来源可以在 `GET /api/trading/status` 或启动日志中查看。

可选的 `@deepseek-ai/dsh-storage-domain` 缺失时，本地存储会回落到 JSON 文件。卸载后存储文件仍保留在 `<DSH_HOME>/trading-mode/`。

### 速率限制与长任务

默认使用滑动 60 秒窗口：每身份 240 次请求/分钟、全局 1200 次/分钟。开销较大的接口有单独额度：

| 接口 | 每身份 / 全局额度 |
| --- | --- |
| `analyze` | 20 / 60 |
| `brief` | 6 / 30 |
| `universeRefresh` | 2 / 4 |

同时运行的 AI 分析每身份最多 2 个、全局最多 4 个。超限返回 `429 RATE_LIMITED` 和 `Retry-After`，被拒请求不会再访问上游或消耗配额。规则见 `API_POLICY` 和 `lib/trading/limits.js`。

全市场目录扫描最多运行 15 分钟。超过预算会停止翻页，返回 `complete: false`、`reason: "budget"`；也可以调用 `DELETE /api/trading/universe` 取消扫描。

## 出问题时先看这里

优先检查 `GET /api/trading/status`，其中包含各数据源的健康状态、AI 原因和配额余量；诊断字段已经脱敏，适合贴到 issue。只想看插件版本、围栏和身份状态，则用 `GET /api/trading/health`。

| 现象 | 排查方向 |
| --- | --- |
| 左侧栏没有 Trading Mode 行 | 刷新页面；确认当前 profile、`list_bundles`、Loader 的 `include:trading-mode`，运行 `npm run inspect:profile`。宿主过旧、没有 `sidebar.panellist` slot 时该插件没有入口可用 |
| 所有 API 返回 `503 HOST_SECURITY_UNAVAILABLE` | 宿主没有提供可用的 `connection.requestRejection`。不要直接对外暴露端口；优先修复宿主围栏 |
| 自选或偏好写入返回 `503 NO_IDENTITY` | 检查匿名用户 ID 服务；确认单用户部署后才考虑 `identity.localBucket` |
| 数据源返回 403 / `UPSTREAM_BLOCKED` | 上游可能屏蔽当前网络。插件会尝试备用源；可检查网络或调整 `providers` 顺序 |
| 返回 `429 RATE_LIMITED` | 触发插件入站配额，按 `Retry-After` 头提示稍后再试 |
| AI 显示 `AI_UNAVAILABLE` | 查看 `/api/trading/status` 中的 `ai.reason`，确认 DSH 已加载 `llm` 服务并有可用模型路由 |
| 图表显示历史数据不完整 | K 线根数不够，JP 尤其常见。少于 200 根时部分指标不能计算，不会用 0 冒充结果 |

历史数据的指标可用性分为 `full`（≥200 根）、`partial`（≥50）、`limited`（≥20）和 `insufficient`（<20）；无法计算的指标会进入 `unavailable`。

公司网络和代理环境里的连接失败，先区分两种情况：

- **证书问题**：如 `SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`CERT_HAS_EXPIRED`。应让启动 DSH 的 Node.js 进程信任企业根证书，例如配置 `NODE_EXTRA_CA_CERTS` 指向 PEM 文件。
- **DNS / socket 问题**：如 `EAI_AGAIN`、`ECONNRESET`、`ETIMEDOUT`、`socket hang up`。可以对比 `networkMode: standard` 与 `compatibility`，通常先保持 `auto` 即可。

不要用 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过证书验证。这会关闭 TLS 证书校验，不是本插件支持的解决方式。

完整的故障排查见 [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)。

## 兼容性

目前实际验证的环境：

| 项目 | 已测试版本 |
| --- | --- |
| 操作系统 | Windows 11 x64（`win32` x64，`Microsoft Windows NT 10.0.26300.0`） |
| Node.js / npm | `24.15.0` / `11.12.1` |
| DSH 桌面宿主 | `0.2.0-rc.2`（Cordis `4.0.4`）、`0.2.1-rc.2`（Cordis `4.0.5`） |
| AI 路由 | `deepseek-official/deepseek-flash` |

两个宿主版本的离线测试结果均为 **13 passed、0 failed、0 skipped**（153 项检查），`npm run test:release` 通过；安装检查为 `6/6 install checks passed`。在 `0.2.1-rc.2` 上，`/api/trading/health` 返回 `api: "ready"`，两个客户端 slot 均为 `active: true`。

`package.json` 声明 `engines.node: ">=20"`，但这不代表所有 Node 20+ 环境都经过测试。Node 20–23、25，macOS、Linux、WSL、Windows ARM64、其他 DSH 版本和各类企业代理/VPN 网络均未验证，不作兼容性保证。详见 [docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)。

宿主需要 `connection`、`webServer` 和客户端 `ui-slots`。唯一非可选 peer 是 `@deepseek-ai/cordis`（`^4.0.1`）；`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-storage-domain` 和 `@deepseek-ai/dsh-anonymous-user-id` 都是可选 peer，缺失时对应功能会降级。运行时 `dependencies` 为空；`react`、`react-dom`、`zod` 只用于开发和测试。

## 开发和测试

从源码开发时，先安装依赖：

```bash
npm ci --legacy-peer-deps
```

仓库提交了 `package-lock.json`。这里使用 `--legacy-peer-deps` 是因为 Cordis 和部分 DSH peer 应由宿主提供，不需要 npm 在开发环境另装。`npm install` / `npm ci` **不是插件安装步骤**。

常用命令：

```bash
npm test                 # 离线测试
npm run test:release     # 发布门禁；不能失败，也不能跳过
npm run test:offline     # 等价于 npm test
npm run test:config      # 只跑配置测试；其他 test:* 脚本可单独运行
npm run test:network     # 在线探针，不纳入发布门禁
npm run check            # 语法检查
npm run inspect:profile  # 只读查看 profile 安装情况
npm run verify:install   # 检查当前 profile 的插件副本
npm run smoke:artifact   # 打包审计、检查文件和机器路径
```

离线测试包括 syntax、config、transport、limits、router、api、fence、identity、watchlist、ai、client、release-scripts、repo，共 13 套。退出码为 `0`（PASS）、`1`（FAIL）、`3`（SKIP）。普通 `npm test` 容许因为缺少可选前置条件而跳过，`test:release` 不允许跳过。例如未安装 React 开发依赖时，客户端测试可能 SKIP，发布门禁会失败。

在线探针依赖第三方网站，失败时会记录 DEGRADED，并检查插件能否正确返回有类型的 `TradingError`，不会把外部服务临时不可用当成发布阻断。

打包前可以运行：

```bash
npm pack --dry-run --json
npm run smoke:artifact
```

Release `.tgz` 是 `npm pack` 产物，当前版本包含 74 个文件、纯 JavaScript，无额外构建步骤。打包检查会审计文件白名单、机器本地路径并输出 SHA-256 和体积。源码联调、profile 链接和安装校验见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 文档

- [架构](docs/ARCHITECTURE.md) · [HTTP API](docs/API.md) · [数据源](docs/DATA_SOURCES.md)
- [开发](docs/DEVELOPMENT.md) · [排障](docs/TROUBLESHOOTING.md) · [兼容性](docs/COMPATIBILITY.md)
- [隐私](docs/PRIVACY.md) · [数据合规](docs/DATA_COMPLIANCE.md) · [安全](SECURITY.md)
- [路线图](docs/ROADMAP.md) · [变更记录](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md)
- [发布模板](docs/RELEASE_TEMPLATE.md) · [发布清单](docs/RELEASE_CHECKLIST.md) · [Round-3 审计](docs/AUDIT-ROUND3.md)

### 截图

目前仓库还没有可用的真实产品截图，因此 README 暂时不放图片或占位图。截图收录规则见 [docs/screenshots/README.md](docs/screenshots/README.md)。

## License 与数据使用

项目源码采用 [MIT License](LICENSE)，但 MIT 只覆盖本仓库的源码，不代表上游行情数据、商标或第三方嵌入内容也采用 MIT。

TradingView 内容由浏览器直接通过 `s.tradingview.com` 加载，插件不代理或修改其内容，也不移除其品牌和署名。当前 [数据合规文档](docs/DATA_COMPLIANCE.md) 对九家上游和 TradingView 的条款均标记为 `not verified`，不据此宣称取得数据使用或再分发授权。

本项目面向本地个人研究使用。不绕过上游鉴权、不抓取登录页，也不重新分发行情数据。使用前请自行确认适用的数据源条款。
首页排列上，市场总览整行铺开，盘后异动有内容时才与板块热力并排。个股相关的新闻留在详情页，跟着标的读，不在首页汇总。
