# HoldingsLens

HoldingsLens 是一个本地运行的 A 股、港股和 ETF 持仓分析面板。它会定时拉取行情，将持仓快照、交易流水和自选股保存在 SQLite，并通过单页网页展示组合市值、盈亏和历史趋势。

## 功能

- 持仓市值、当日盈亏、累计盈亏和本月盈亏
- 周五收盘后可在情绪卡片中切换查看本周盈亏战报
- 每日组合快照与 7/30/90/365 日历史趋势
- 买入、卖出、交易撤销和加权成本回放
- 自选股搜索、行情跟踪与拖拽排序
- 上证、深证、创业板、恒生等指数行情
- 港股使用 HKD → CNY 参考汇率折算
- 隐私数值隐藏和桌面/移动端响应式布局

## 技术栈

- Node.js 22.5+（使用内置 `node:sqlite`）
- Hono + `@hono/node-server`
- SQLite
- 原生 HTML/CSS/JavaScript
- Chart.js + GSAP（页面通过 CDN 加载）

## 启动

```bash
cd server
npm ci
npm start
```

浏览器访问 [http://localhost:8123](http://localhost:8123)。开发时可以使用：

```bash
npm run dev
```

如需指定端口或数据库路径，可使用 `PORT` 和 `HOLDINGS_DB_PATH` 环境变量。

启动时会立即尝试刷新行情，交易时段内每 5 分钟自动刷新。周末、节假日或开盘前行情日期仍是上一交易日时，不会写入新的每日快照。

## 数据与行情来源

- 持仓、交易、历史和自选数据：项目根目录的 `holdings.db`
- 股票行情：腾讯行情为主，新浪行情为备用
- HKD/CNY 参考汇率：[Frankfurter](https://frankfurter.dev/)
- Chart.js 和 GSAP：公共 CDN

汇率获取成功后会写入 `app_metadata`。外部汇率服务暂时不可用时，服务会使用 SQLite 中最近一次成功值；新库首次获取失败时才会回退到内置参考值。

## 数据模型

| 表 | 用途 |
| --- | --- |
| `opening_holdings` | 不可变的期初持仓，作为交易回放基线 |
| `base_holdings` | 回放交易后的当前持仓和加权成本 |
| `transactions` | 买入、卖出流水和成交时汇率 |
| `holdings` | 每个交易日的单只持仓快照 |
| `daily_summary` | 每个交易日的组合汇总 |
| `watchlist` | 自选股元数据与排序 |
| `watchlist_price` | 自选股每日价格快照 |
| `app_metadata` | 汇率等可持久化的运行元数据 |

旧版数据库首次使用新版服务时，会自动创建 `opening_holdings` 并迁移现有期初持仓。后续交易回放只依赖 SQLite，不再依赖代码中的种子常量。

## 备份

停止服务后备份数据库：

```bash
cp holdings.db holdings.db.backup
```

若在服务运行中备份，建议使用 SQLite 的在线备份命令：

```bash
sqlite3 holdings.db ".backup 'holdings.db.backup'"
```

## 项目结构

```text
.
├── holdings.db
├── public/
│   ├── 持仓明细展示.html
│   └── winning_character.png
├── server/
│   ├── fetcher.js
│   ├── package.json
│   └── server.js
└── README.md
```

## 注意事项

- 项目以个人本地使用为目标，交易修改接口没有登录鉴权，不要直接暴露到公网。
- 行情和汇率均来自第三方参考数据，不应当作交易所或券商结算数据。
- 页面依赖公共 CDN，完全离线时图表和动画库不会加载。

## License

[MIT](LICENSE)
