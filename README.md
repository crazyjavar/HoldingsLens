# 持仓明细展示系统

个人投资组合实时监控工具，支持 A 股、港股 ETF 及个股的持仓展示、盈亏分析与历史趋势追踪。

## 技术栈

### 后端

| 技术 | 版本 | 用途 |
|------|------|------|
| [Node.js](https://nodejs.org/) | v22.5+ | 运行时（使用内置 `node:sqlite` 模块） |
| [Hono](https://hono.dev/) | ^4.7 | Web 框架，提供路由与中间件 |
| [@hono/node-server](https://github.com/honojs/node-server) | ^1.13 | Hono 的 Node.js 适配器 |
| [node:sqlite](https://nodejs.org/api/sqlite.html) | 内置 | SQLite 数据库驱动（零依赖） |
| [pm2](https://pm2.keymetrics.io/) | 全局安装 | 进程守护与自动重启 |

### 前端

| 技术 | 用途 |
|------|------|
| 原生 HTML + CSS + JavaScript | 页面结构与交互逻辑 |
| [Chart.js](https://www.chartjs.org/) v4（CDN） | 历史趋势折线图（总市值 / 累计盈亏） |
| [Google Fonts](https://fonts.google.com/)（CDN） | Space Grotesk、Inter、Orbitron 字体 |

### 数据源

| 来源 | 说明 |
|------|------|
| 腾讯行情（`qt.gtimg.cn`） | 主数据源，支持 A 股 + 港股实时行情 |
| 新浪行情（`hq.sinajs.cn`） | 备用数据源，主源失败时自动切换 |

### 数据存储

使用 **SQLite**（`holdings.db`），包含两张表：

- `holdings` — 每日持仓快照（每条记录对应某天某只证券的详细数据）
- `daily_summary` — 每日组合汇总（总市值、当日盈亏、累计盈亏等，用于历史趋势图）

## 项目结构

```
analysis/
├── server/
│   ├── package.json        # 项目依赖
│   ├── server.js           # 主服务：Hono 路由 + SQLite + 定时抓取
│   └── fetcher.js          # 行情抓取模块（腾讯/新浪双源）
├── public/
│   ├── 持仓明细展示.html   # 前端页面
│   └── favicon.svg
├── holdings.db             # SQLite 数据库（自动生成）
└── README.md
```

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/holdings/latest` | 最新一天的持仓列表 + 汇总 |
| GET | `/api/holdings/history?days=30` | 过去 N 天每日汇总（趋势图数据）|
| POST | `/api/holdings/refresh` | 手动触发一次行情抓取 |
| GET | `/api/status` | 服务状态与最后更新时间 |

## 启动与管理

```bash
# 安装依赖
cd server && npm install

# pm2 启动（生产环境）
pm2 start server.js --name holdings-server
pm2 save

# 常用命令
pm2 ps                          # 查看进程状态
pm2 logs holdings-server        # 实时日志
pm2 restart holdings-server     # 重启服务

# 手动触发行情抓取
curl -X POST http://localhost:8123/api/holdings/refresh
```

服务默认监听 **http://localhost:8123**

## 运行机制

- 服务启动时立即抓取一次行情
- 交易时段（工作日 09:25–15:05 北京时间）每 **5 分钟**自动刷新
- 前端页面每 **60 秒**静默重新拉取 API 数据
- 港股汇率通过 `市值 / (现价 × 数量)` 从历史数据反推，无需手动配置
