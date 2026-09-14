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
declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export default app;
