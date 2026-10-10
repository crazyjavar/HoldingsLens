/** Hono 应用：仅注册路由，不启动监听、定时刷新或通知。 */
import { Hono } from 'hono';
import { serveStatic } from '@hono/bun';
import { resolve, relative } from 'node:path';
import { ROOT } from './db.js';
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
// 根路径显式返回中文文件名的主页。
const HTML_PATH = resolve(ROOT, 'public', '持仓明细展示.html');
app.get('/', () => {
  return new Response(Bun.file(HTML_PATH), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
});

// serveStatic 要求相对于 cwd 的路径
const PUBLIC_REL = relative(process.cwd(), resolve(ROOT, 'public'));
app.use('/*', serveStatic({ root: PUBLIC_REL }));

export default app;
