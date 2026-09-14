import { db, getFxRate, refreshFxRate, toSymbol, beijingParts, beijingDate } from './db.js';
import { fetchPrices, sinaSymbol } from './fetcher.js';
/** 核心：拉取行情并写入 SQLite */
let lastRefreshTime = null;
let refreshLock = false;
export function getLastRefreshTime() {
    return lastRefreshTime;
}
export async function refreshHoldings(options = {}) {
    const { force = false } = options;
    // 周末没有行情数据，无论是否手动强制刷新都直接跳过，防止写入周末静止快照。
    const day = beijingParts().day; // 0=周日, 6=周六
    if (day === 0 || day === 6) {
        console.log('[refresh] 周末不开盘，跳过行情抓取');
        return { skipped: true, reason: 'weekend' };
    }
    if (refreshLock) {
        console.log('[refresh] 上一次抓取仍在进行，跳过');
        return { skipped: true };
    }
    refreshLock = true;
    const startedAt = new Date().toISOString();
    console.log(`[refresh] 开始抓取行情 ${startedAt}${force ? ' (手动/强制执行)' : ''}`);
    try {
        // 从 DB 读取持仓（取代硬编码 SEED_HOLDINGS）。
        // 只读取当前仍有持仓数量的标的，清仓（quantity=0）的标的不再进入组合展示与快照。
        const baseHoldings = db.prepare('SELECT * FROM base_holdings WHERE quantity > 0').all();
        const today = beijingDate(); // YYYY-MM-DD
        // 持仓与自选一次抓取同一份行情（取并集）：同一标的的现价/昨收/涨跌幅必须来自同一时刻。
        // 此前“先抓持仓行情、再单独抓一次自选行情”会在两次请求之间产生价格跳动，
        // 导致同一只股票（如美团）在持仓明细与自选里显示不同的今日涨跌，且每次刷新都无法对齐。
        const wlSymbols = db.prepare('SELECT code FROM watchlist').all()
            .map(r => sinaSymbol(r.code));
        const symbols = [...new Set([
                ...baseHoldings.map(h => toSymbol(h.code)),
                ...wlSymbols,
            ])];
        const [quotes] = await Promise.all([
            fetchPrices(symbols),
            refreshFxRate(),
        ]);
        // 开盘前或 A/H 股同时休市时，行情源只会返回上一交易日。
        // 当所有可判定的行情日期都不是今天且非强制刷新时，不写入今日快照。
        const quoteDates = Object.values(quotes).map(q => q.lastTradeDate).filter((d) => d !== null);
        if (!force && quoteDates.length > 0 && !quoteDates.includes(today)) {
            const uniqueDates = [...new Set(quoteDates)];
            console.log(`[refresh] 当前无已开盘市场（行情日期: ${uniqueDates.join(', ')}），跳过写入`);
            return { skipped: true, reason: 'no_market_open', quoteDates: uniqueDates };
        }
        let totalMarket = 0;
        let totalCostValue = 0;
        let totalDayPnl = 0;
        let totalPrevMarket = 0;
        let totalPnl = 0;
        const rows = [];
        for (const holding of baseHoldings) {
            const sym = toSymbol(holding.code);
            const quote = quotes[sym];
            if (!quote)
                continue;
            const { current, previousClose, lastTradeDate } = quote;
            const code = holding.code;
            const name = holding.name;
            const cost = holding.cost;
            const quantity = holding.quantity;
            // 查询今天以前的最新历史记录，用作昨收价锚定
            const latestRow = db.prepare('SELECT market, price, quantity FROM holdings WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1').get(code, today);
            // 港股使用已获取并持久化的真实参考汇率
            const isHK = code.endsWith('.HK');
            const fx = isHK ? getFxRate() : 1.0;
            // 重要判定：该标的今天是否交易（只有当行情拉取的最后交易日期明确且不等于今天，才判定为休市）
            const isClosedToday = !!(lastTradeDate && lastTradeDate !== today);
            // 确定今天计算所用的“昨收价”
            // 1. 如果今天休市，为了将其当日盈亏归零，优先使用数据库历史最新收盘价（latestRow.price），无历史记录时回退使用行情接口昨收
            // 2. 如果今天正常交易，为了采用最权威的数据并具备自愈校正能力，直接使用行情源返回的官方昨收价 previousClose！
            const prevCloseToUse = isClosedToday
                ? ((latestRow && latestRow.price > 0) ? latestRow.price : previousClose)
                : previousClose;
            let market, prevMkt, dayPnl, dayRate;
            if (isClosedToday) {
                // 如果今天休市，现价强制等于昨收价，使单只标的的日盈亏与涨跌幅归零
                const priceToUse = prevCloseToUse;
                market = Math.round(priceToUse * quantity * fx * 100) / 100;
                prevMkt = Math.round(prevCloseToUse * quantity * fx * 100) / 100;
                dayPnl = 0.0;
                dayRate = '0.00%';
                console.log(`[refresh] 标的 ${name} (${code}) 今天休市 (最后交易日 ${lastTradeDate})，当日盈亏归零`);
            }
            else {
                market = Math.round(current * quantity * fx * 100) / 100;
                prevMkt = prevCloseToUse > 0 ? Math.round(prevCloseToUse * quantity * fx * 100) / 100 : 0;
                dayPnl = Math.round((market - prevMkt) * 100) / 100;
                dayRate = prevCloseToUse > 0
                    ? `${(Math.trunc(((current - prevCloseToUse) / prevCloseToUse * 100) * 1000) / 1000).toFixed(3)}%`
                    : '0.000%';
            }
            const costVal = Math.round(cost * quantity * fx * 100) / 100;
            const pnl = Math.round((market - costVal) * 100) / 100;
            // 休市标的现价统一取 prevCloseToUse，与 market 保持同一口径，避免金额与比例不一致。
            const effectivePrice = isClosedToday ? prevCloseToUse : current;
            const pnlRate = cost > 0
                ? `${((effectivePrice - cost) / cost * 100).toFixed(2)}%`
                : '0.00%';
            totalMarket += market;
            totalCostValue += costVal;
            // 只有当标的今天没有休市，才将其盈亏和市值累加进“今日盈亏”与“当日收益率除数”
            if (!isClosedToday) {
                totalDayPnl += dayPnl;
                if (prevMkt > 0)
                    totalPrevMarket += prevMkt;
            }
            totalPnl += pnl;
            rows.push({ date: today, code, name, market, cost, prev_close: prevCloseToUse,
                price: effectivePrice, quantity, day_pnl: dayPnl, day_pnl_pct: dayRate,
                total_pnl: pnl, total_pnl_pct: pnlRate, weight: null, change_pct: '-' });
        }
        // 计算仓位占比
        for (const row of rows) {
            row.weight = totalMarket > 0
                ? `${(row.market / totalMarket * 100).toFixed(2)}%`
                : '0.00%';
        }
        // 写入 holdings 表（UPSERT），使用手动事务
        const upsert = db.prepare(`
      INSERT INTO holdings
        (date, code, name, market, cost, prev_close, price, quantity,
         day_pnl, day_pnl_pct, total_pnl, total_pnl_pct, weight, change_pct)
      VALUES
        (:date, :code, :name, :market, :cost, :prev_close, :price, :quantity,
         :day_pnl, :day_pnl_pct, :total_pnl, :total_pnl_pct, :weight, :change_pct)
      ON CONFLICT(date, code) DO UPDATE SET
        market=excluded.market, cost=excluded.cost, prev_close=excluded.prev_close,
        price=excluded.price, quantity=excluded.quantity,
        day_pnl=excluded.day_pnl, day_pnl_pct=excluded.day_pnl_pct,
        total_pnl=excluded.total_pnl, total_pnl_pct=excluded.total_pnl_pct,
        weight=excluded.weight
    `);
        db.exec('BEGIN');
        try {
            // 清理当天残留的 0 仓位快照，避免清仓标的一直出现在最新持仓里。
            db.prepare('DELETE FROM holdings WHERE date = ? AND quantity = 0').run(today);
            for (const row of rows)
                upsert.run(row);
            db.exec('COMMIT');
        }
        catch (txErr) {
            db.exec('ROLLBACK');
            throw txErr;
        }
        // 写入 daily_summary 表
        const totalDayRate = totalPrevMarket > 0
            ? `${(Math.trunc((totalDayPnl / totalPrevMarket * 100) * 1000) / 1000).toFixed(3)}%`
            : '0.000%';
        const totalPnlRate = totalCostValue > 0
            ? `${(totalPnl / totalCostValue * 100).toFixed(2)}%`
            : '0.00%';
        db.prepare(`
      INSERT INTO daily_summary (date, total_market, total_day_pnl, total_day_pct, total_pnl, total_pnl_pct, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        total_market=excluded.total_market,
        total_day_pnl=excluded.total_day_pnl,
        total_day_pct=excluded.total_day_pct,
        total_pnl=excluded.total_pnl,
        total_pnl_pct=excluded.total_pnl_pct,
        updated_at=excluded.updated_at
    `).run(today, Math.round(totalMarket * 100) / 100, Math.round(totalDayPnl * 100) / 100, totalDayRate, Math.round(totalPnl * 100) / 100, totalPnlRate, new Date().toISOString());
        lastRefreshTime = new Date().toISOString();
        console.log(`[refresh] 完成，${rows.length} 条持仓写入 SQLite`);
        // ── 顺带写入自选股行情快照（复用同一份 quotes）──────────────
        await refreshWatchlistPrices(today, quotes).catch((e) => console.warn('[watchlist] 快照写入失败:', e.message));
        return { ok: true, date: today, count: rows.length };
    }
    catch (err) {
        console.error('[refresh] 抓取失败:', err.message);
        return { ok: false, error: err.message };
    }
    finally {
        refreshLock = false;
    }
}
/**
 * 写入自选股行情快照（watchlist_price）。
 * 行情复用 refreshHoldings 主流程已抓取的 quotes（同一时刻同一份数据），不再二次联网抓取。
 * @param {string} today - YYYY-MM-DD
 * @param {Record<string, QuoteResult>} quotes - 主流程已抓取的行情
 */
async function refreshWatchlistPrices(today, quotes) {
    const items = db.prepare('SELECT code, added_price FROM watchlist').all();
    if (items.length === 0)
        return;
    const upsert = db.prepare(`
    INSERT INTO watchlist_price (code, date, price, prev_close, pct_vs_added)
    VALUES (:code, :date, :price, :prev_close, :pct_vs_added)
    ON CONFLICT(code, date) DO UPDATE SET
      price=excluded.price,
      prev_close=excluded.prev_close,
      pct_vs_added=excluded.pct_vs_added
  `);
    db.exec('BEGIN');
    try {
        for (const item of items) {
            const sym = sinaSymbol(item.code);
            const q = quotes[sym];
            if (!q)
                continue;
            const addedPrice = item.added_price;
            const pct = addedPrice > 0
                ? `${((q.current - addedPrice) / addedPrice * 100).toFixed(2)}%`
                : '0.00%';
            upsert.run({
                code: item.code,
                date: today,
                price: q.current,
                prev_close: q.previousClose,
                pct_vs_added: pct,
            });
        }
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        throw e;
    }
}
//# sourceMappingURL=refresh.js.map