/** Bun 服务入口；业务路由和 SQLite 数据模型保持一致。 */
import app from './app.js';
import { DB_PATH, isTradingHours } from './db.js';
import { refreshHoldings } from './refresh.js';
import { startClosingNotifier } from './notifier.js';
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
refreshHoldings().catch((err) => {
    console.error('[startup] 初次抓取失败:', err.message);
});
// ── 启动工作日收盘定时推送（下午 16:10）────────────────────
startClosingNotifier();
// ── 启动服务器 ────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 9123;
// 行情主备源可能连续等待多个超时，保留足够的连接空闲时间。
const server = Bun.serve({ fetch: app.fetch, port: PORT, idleTimeout: 120 });
console.log(`\n✅ 持仓明细服务已启动 (Bun ${Bun.version})`);
console.log(`   http://localhost:${server.port}`);
console.log(`   数据库: ${DB_PATH}`);
console.log(`   定时抓取: 每 ${INTERVAL_MS / 60000} 分钟（交易时段）\n`);
//# sourceMappingURL=server.js.map