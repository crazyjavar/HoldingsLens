/**
 * server.ts — 持仓明细服务主入口
 * 技术栈：Hono + @hono/node-server + node:sqlite（Node 22.5+）+ TypeScript
 * 
 * 模块结构：
 *   - db.ts: SQLite 数据库实例、表结构初始化与通用工具
 *   - fetcher.ts: 外部行情源拉取与数据解析
 *   - refresh.ts: 实时行情批量抓取、持仓盈亏计算与自选股快照
 *   - routes/:
 *       - holdings.ts: 持仓最新快照、历史统计、数据刷新与系统状态
 *       - transactions.ts: 交易流水记录、查询与持仓加权成本回放
 *       - watchlist.ts: 自选股管理与股票智能联想搜索
 *       - indices.ts: 大盘指数与现货黄金行情缓存
 */

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { resolve, relative } from 'node:path';
import { readFileSync } from 'node:fs';

import { DB_PATH, ROOT, isTradingHours } from './db.js';
import { refreshHoldings } from './refresh.js';
import { startClosingNotifier } from './notifier.js';
import holdings, { commonApi } from './routes/holdings.js';
import transactions from './routes/transactions.js';
import watchlist, { stockSearch } from './routes/watchlist.js';
import indices from './routes/indices.js';

// ── Hono 实例与路由注册 ─────────────────────────────────────
const app = new Hono();

// 挂载 API 路由
app.route('/api', commonApi);                  // /api/status, /api/base-holdings
app.route('/api/holdings', holdings);          // /api/holdings/latest, history, refresh
app.route('/api/transactions', transactions);  // /api/transactions (CRUD)
app.route('/api/watchlist', watchlist);        // /api/watchlist (CRUD, reorder)
app.route('/api/stocks', stockSearch);         // /api/stocks/search
app.route('/api/indices', indices);            // /api/indices

// ── 静态文件（public/）────────────────────────────────────
// 根路径显式返回主页（文件名含中文，serveStatic 无法自动识别为 index）
const HTML_PATH = resolve(ROOT, 'public', '持仓明细展示.html');
app.get('/', (c) => {
  const html = readFileSync(HTML_PATH, 'utf-8');
  return c.html(html);
});

// serveStatic 要求相对于 cwd 的路径
const PUBLIC_REL = relative(process.cwd(), resolve(ROOT, 'public'));
app.use('/*', serveStatic({ root: PUBLIC_REL }));

// ── 定时抓取（交易时段每 5 分钟）────────────────────────────
const INTERVAL_MS = 5 * 60 * 1000; // 5 分钟

setInterval(async () => {
  if (isTradingHours()) {
    console.log('[scheduler] 交易时段，自动拉取行情...');
    await refreshHoldings();
  }
}, INTERVAL_MS);

// 启动时立即抓取一次（无论是否交易时段，先拿最新数据）
console.log('[startup] 服务启动，立即拉取一次行情...');
refreshHoldings().catch((err: unknown) => {
  console.error('[startup] 初次抓取失败:', (err as Error).message);
});

// ── 启动工作日收盘定时推送（下午 16:10）────────────────────
startClosingNotifier();

// ── 启动服务器 ────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 9123;
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n✅ 持仓明细服务已启动 (TypeScript)`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   数据库: ${DB_PATH}`);
  console.log(`   定时抓取: 每 ${INTERVAL_MS / 60000} 分钟（交易时段）\n`);
});

export default app;
