import { Hono } from 'hono';
import { db, beijingParts, isTradingHours, getFxRate, getFxDate } from '../db.js';
import { refreshHoldings, getLastRefreshTime } from '../refresh.js';
import { sendClosingNotification } from '../notifier.js';
const holdings = new Hono();
/** GET /latest — 最新一天的持仓 + 汇总 */
holdings.get('/latest', (c) => {
    const latestDate = db.prepare('SELECT date FROM holdings ORDER BY date DESC LIMIT 1').get();
    if (!latestDate) {
        return c.json({ holdings: [], summary: null, date: null });
    }
    const date = latestDate.date;
    const fxRate = getFxRate();
    const holdingsData = db.prepare('SELECT * FROM holdings WHERE date = ? ORDER BY market DESC').all(date).map(row => ({
        ...row,
        // 港股快照中的 cost 是人民币每股成本；换算成当前汇率下的港币等值，
        // 与以港币报价的现价放在同一货币单位中展示。
        cost_hkd: row.code.endsWith('.HK') && row.cost != null && fxRate > 0
            ? row.cost / fxRate
            : null,
    }));
    const summary = db.prepare('SELECT * FROM daily_summary WHERE date = ?').get(date);
    // ── 计算当月盈亏（本月每日盈亏之和） ────────────────────────
    const monthPrefix = date.slice(0, 7) + '-%';
    const monthPnlRow = db.prepare('SELECT SUM(total_day_pnl) AS month_pnl FROM daily_summary WHERE date LIKE ?').get(monthPrefix);
    const monthPnl = monthPnlRow ? (monthPnlRow.month_pnl ?? 0) : 0;
    // 计算当月期初资产（即上个月最后一天的总市值）
    const firstDayOfMonth = date.slice(0, 7) + '-01';
    const prevMonthLastDay = db.prepare('SELECT total_market FROM daily_summary WHERE date < ? ORDER BY date DESC LIMIT 1').get(firstDayOfMonth);
    let startMarket = 0;
    if (prevMonthLastDay && prevMonthLastDay.total_market > 0) {
        startMarket = prevMonthLastDay.total_market;
    }
    else {
        // 若无上月数据，则取本月第一天的市值和当日盈亏倒推期初资产
        const thisMonthFirstDay = db.prepare('SELECT total_market, total_day_pnl FROM daily_summary WHERE date LIKE ? ORDER BY date ASC LIMIT 1').get(monthPrefix);
        if (thisMonthFirstDay) {
            startMarket = (thisMonthFirstDay.total_market || 0) - (thisMonthFirstDay.total_day_pnl || 0);
        }
    }
    const monthPnlRateVal = startMarket > 0 ? (monthPnl / startMarket * 100) : 0;
    const monthPnlRate = monthPnlRateVal.toFixed(2) + '%';
    // ── 计算最新数据所在自然周的盈亏（周一至最新交易日）──
    const latestDay = new Date(`${date}T00:00:00Z`);
    const latestWeekday = latestDay.getUTCDay();
    const daysFromMonday = latestWeekday === 0 ? 6 : latestWeekday - 1;
    const weekStartDate = new Date(latestDay);
    weekStartDate.setUTCDate(latestDay.getUTCDate() - daysFromMonday);
    const weekStart = weekStartDate.toISOString().slice(0, 10);
    const weekPnlRow = db.prepare(`
    SELECT SUM(total_day_pnl) AS week_pnl
    FROM daily_summary
    WHERE date BETWEEN ? AND ?
  `).get(weekStart, date);
    const weekPnl = weekPnlRow?.week_pnl ?? 0;
    const prevWeekMarket = db.prepare('SELECT total_market FROM daily_summary WHERE date < ? ORDER BY date DESC LIMIT 1').get(weekStart);
    const firstWeekDay = db.prepare(`
    SELECT total_market, total_day_pnl
    FROM daily_summary
    WHERE date BETWEEN ? AND ?
    ORDER BY date ASC LIMIT 1
  `).get(weekStart, date);
    const weekStartMarket = prevWeekMarket?.total_market && prevWeekMarket.total_market > 0
        ? prevWeekMarket.total_market
        : Math.max(0, (firstWeekDay?.total_market || 0) - (firstWeekDay?.total_day_pnl || 0));
    const weekPnlRate = weekStartMarket > 0 ? `${(weekPnl / weekStartMarket * 100).toFixed(2)}%` : '0.00%';
    // 周战报只在当周周五收盘后及紧随的周末开放，避免旧数据误触发。
    const nowBj = beijingParts();
    const todayBj = Date.UTC(nowBj.year, nowBj.month - 1, nowBj.date);
    const daysSinceLatest = Math.round((todayBj - latestDay.getTime()) / 86400000);
    const afterFridayClose = nowBj.hours * 60 + nowBj.minutes >= 15 * 60 + 5;
    const weekReportReady = latestWeekday === 5 && daysSinceLatest >= 0 && daysSinceLatest <= 2
        && (daysSinceLatest > 0 || afterFridayClose);
    const extendedSummary = summary ? {
        ...summary,
        month_pnl: Math.round(monthPnl * 100) / 100,
        month_pnl_pct: monthPnlRate,
        week_pnl: Math.round(weekPnl * 100) / 100,
        week_pnl_pct: weekPnlRate,
        week_start: weekStart,
        week_end: date,
        week_report_ready: weekReportReady,
    } : null;
    return c.json({ date, holdings: holdingsData, summary: extendedSummary });
});
/** GET /history?days=30|all — 历史每日汇总（用于趋势图）*/
holdings.get('/history', (c) => {
    const requestedDays = c.req.query('days') ?? '30';
    const selectSql = `
    SELECT date, total_market, total_day_pnl, total_day_pct, total_pnl, total_pnl_pct
    FROM daily_summary
    ORDER BY date DESC
  `;
    const rows = requestedDays === 'all'
        ? db.prepare(selectSql).all()
        : db.prepare(`${selectSql} LIMIT ?`).all(Math.min(Math.max(parseInt(requestedDays, 10) || 30, 1), 5000));
    return c.json({ history: [...rows].reverse() }); // 升序返回（图表用）
});
/** POST /refresh — 手动触发一次行情抓取（强制重算并同步快照） */
holdings.post('/refresh', async (c) => {
    const result = await refreshHoldings({ force: true });
    return c.json(result, result.ok || result.skipped ? 200 : 500);
});
/** POST /push-test — 手动测试收盘收益系统弹窗通知 */
holdings.post('/push-test', async (c) => {
    const result = await sendClosingNotification({ forceRefresh: false });
    return c.json(result);
});
// ── 通用 / 系统 API 路由（直接挂载在 /api 下）────────────────
export const commonApi = new Hono();
/** GET /api/status — 服务状态 */
commonApi.get('/status', (c) => {
    const count = db.prepare('SELECT COUNT(*) AS n FROM daily_summary').get();
    const n = count?.n ?? 0;
    return c.json({
        status: 'ok',
        lastRefresh: getLastRefreshTime(),
        totalDays: n,
        tradingHours: isTradingHours(),
    });
});
/** GET /api/base-holdings — 获取所有持仓基础数据（含交易笔数）*/
commonApi.get('/base-holdings', (c) => {
    const rows = db.prepare('SELECT * FROM base_holdings ORDER BY code').all();
    const result = rows.map(r => {
        const txCount = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE code = ?').get(r.code);
        return {
            code: r.code,
            name: r.name,
            cost: r.cost,
            quantity: r.quantity,
            updated_at: r.updated_at,
            tx_count: txCount ? txCount.n : 0,
        };
    });
    return c.json({
        holdings: result,
        fx_rate: getFxRate(),
        fx_date: getFxDate(),
        fx_source: 'Frankfurter',
    });
});
export default holdings;
//# sourceMappingURL=holdings.js.map