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
        // 从 DB 读取当前仍有持仓数量的标的（quantity > 0）
        const baseHoldings = db.prepare('SELECT * FROM base_holdings WHERE quantity > 0').all();
        const today = beijingDate(); // YYYY-MM-DD
        // 区分港股与 A 股标的
        const hkHoldings = baseHoldings.filter(h => h.code.endsWith('.HK'));
        const cnHoldings = baseHoldings.filter(h => !h.code.endsWith('.HK'));
        // 自选股按市场分组
        const wlRows = db.prepare('SELECT code FROM watchlist').all();
        const hkWlSymbols = wlRows.filter(r => r.code.endsWith('.HK')).map(r => sinaSymbol(r.code));
        const cnWlSymbols = wlRows.filter(r => !r.code.endsWith('.HK')).map(r => sinaSymbol(r.code));
        // 港股所有标的（持仓 + 自选）
        const hkSymbols = [...new Set([
                ...hkHoldings.map(h => toSymbol(h.code)),
                ...hkWlSymbols,
            ])];
        // A 股探针标的（优先使用持仓中的 A 股，另外加上证指数 sh000001 作为权威参考）
        const cnProbeSymbols = [
            'sh000001',
            ...(cnHoldings.length > 0 ? [toSymbol(cnHoldings[0].code)] : []),
        ];
        // 第一步：并发拉取汇率、港股全量行情以及 A 股探针行情
        // 港股 + A 股探针走腾讯接口，耗时极短（<100ms），不涉及休市基金，极其稳定
        const probeSymbols = [...new Set([...hkSymbols, ...cnProbeSymbols])];
        const [probeQuotes] = await Promise.all([
            fetchPrices(probeSymbols),
            refreshFxRate(),
        ]);
        // 判定港股与 A 股开市状态
        // 港股开市：港股标的中有任意一个的 lastTradeDate === today
        const isHkOpen = hkSymbols.some(s => probeQuotes[s]?.lastTradeDate === today);
        // A 股开市：A 股探针标的中任意一个的 lastTradeDate === today
        const isCnOpen = cnProbeSymbols.some(s => probeQuotes[s]?.lastTradeDate === today);
        console.log(`[refresh] 市场开市状态探测: 港股开市=${isHkOpen}, A股开市=${isCnOpen} (今日: ${today})`);
        // 若两市均未开盘（如早盘 09:15 盘前，或元旦/春节两市同休）
        if (!force && !isHkOpen && !isCnOpen) {
            console.log(`[refresh] 当前港股与 A 股均未开盘（今日 ${today}），跳过写入`);
            return { skipped: true, reason: 'no_market_open' };
        }
        let quotes = { ...probeQuotes };
        // 确定当前更新模式：
        // 'HK_ONLY': 大 A 关门，港股开盘 -> 仅更新港股
        // 'CN_ONLY': 大 A 开盘，港股关门 -> 仅更新 A 股
        // 'ALL': 两市均开盘，或强制刷新
        let updateMode = 'ALL';
        if (!isCnOpen && isHkOpen) {
            updateMode = 'HK_ONLY';
            console.log('[refresh] 命中状态：大 A 闭市，港股开市。仅更新港股的个股与自选，跳过 A 股及基金拉取。');
        }
        else if (isCnOpen && !isHkOpen) {
            updateMode = 'CN_ONLY';
            console.log('[refresh] 命中状态：大 A 开市，港股休市。仅更新 A 股标的。');
        }
        // 若需要更新 A 股（非 HK_ONLY 模式），且 A 股持仓/自选有未拉取的标的，补全拉取 A 股行情
        if (updateMode !== 'HK_ONLY') {
            const cnSymbols = [...new Set([
                    ...cnHoldings.map(h => toSymbol(h.code)),
                    ...cnWlSymbols,
                ])];
            const remainingCn = cnSymbols.filter(s => !quotes[s]);
            if (remainingCn.length > 0) {
                try {
                    const cnQuotes = await fetchPrices(remainingCn);
                    Object.assign(quotes, cnQuotes);
                }
                catch (e) {
                    console.warn('[refresh] A 股/基金行情补拉出现异常:', e.message);
                }
            }
        }
        let totalMarket = 0;
        let totalCostValue = 0;
        let totalDayPnl = 0;
        let totalPrevMarket = 0;
        let totalPnl = 0;
        const rows = [];
        for (const holding of baseHoldings) {
            const code = holding.code;
            const name = holding.name;
            const cost = holding.cost;
            const quantity = holding.quantity;
            const isHK = code.endsWith('.HK');
            const sym = toSymbol(code);
            const quote = quotes[sym];
            // 查询今天以前的最新历史记录，用作休市锚定与昨收价基准
            const latestRow = db.prepare('SELECT market, price, quantity FROM holdings WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1').get(code, today);
            const fx = isHK ? getFxRate() : 1.0;
            // 判定该标的今天是否参与实时行情更新：
            // - 港股：在 HK_ONLY 或 ALL 模式下，且港股今日开盘且有行情
            // - A 股：在 CN_ONLY 或 ALL 模式下，且 A 股今日开盘且有行情
            const shouldUpdate = isHK
                ? (updateMode === 'HK_ONLY' || isHkOpen || force) && !!quote
                : (updateMode !== 'HK_ONLY' && (isCnOpen || force)) && !!quote;
            let market, prevMkt, dayPnl, dayRate;
            let effectivePrice, prevCloseToUse;
            if (!shouldUpdate) {
                // 休市或跳过更新的标的：平盘处理，当日盈亏归零，现价与市值沿用上一交易日收盘
                const fallbackPrice = (latestRow && latestRow.price > 0)
                    ? latestRow.price
                    : (quote?.previousClose || quote?.current || cost);
                effectivePrice = fallbackPrice;
                prevCloseToUse = fallbackPrice;
                market = (latestRow && latestRow.market > 0)
                    ? latestRow.market
                    : Math.round(fallbackPrice * quantity * fx * 100) / 100;
                prevMkt = market;
                dayPnl = 0.0;
                dayRate = '0.00%';
                console.log(`[refresh] 标的 ${name} (${code}) 休市，保持上一交易日收盘市值 ${market}，当日盈亏归零`);
            }
            else {
                // 正常更新标的
                const { current, previousClose } = quote;
                effectivePrice = current;
                prevCloseToUse = previousClose > 0 ? previousClose : (latestRow?.price || current);
                market = Math.round(current * quantity * fx * 100) / 100;
                prevMkt = prevCloseToUse > 0 ? Math.round(prevCloseToUse * quantity * fx * 100) / 100 : market;
                dayPnl = Math.round((market - prevMkt) * 100) / 100;
                dayRate = prevCloseToUse > 0
                    ? `${(Math.trunc(((current - prevCloseToUse) / prevCloseToUse * 100) * 1000) / 1000).toFixed(3)}%`
                    : '0.000%';
            }
            // base_holdings 中的 cost 为每股人民币成本（RMB/股），因此成本直接为 cost * quantity
            const costVal = Math.round(cost * quantity * 100) / 100;
            const pnl = Math.round((market - costVal) * 100) / 100;
            const pnlRate = costVal > 0 ? `${(pnl / costVal * 100).toFixed(2)}%` : '0.00%';
            totalMarket += market;
            totalCostValue += costVal;
            totalDayPnl += dayPnl;
            totalPrevMarket += prevMkt; // 休市标的与开市标的的基准市值均计入组合总昨收市值
            totalPnl += pnl;
            rows.push({
                date: today, code, name, market, cost, prev_close: prevCloseToUse,
                price: effectivePrice, quantity, day_pnl: dayPnl, day_pnl_pct: dayRate,
                total_pnl: pnl, total_pnl_pct: pnlRate, weight: null, change_pct: '-'
            });
        }
        // 计算仓位占比
        for (const row of rows) {
            row.weight = totalMarket > 0
                ? `${(row.market / totalMarket * 100).toFixed(2)}%`
                : '0.00%';
        }
        // 写入 holdings 表（UPSERT）
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
        console.log(`[refresh] 完成，${rows.length} 条持仓写入 SQLite (模式: ${updateMode})`);
        // 自选股快照写入：大 A 闭市时只更新港股自选
        const onlyHkWatchlist = (updateMode === 'HK_ONLY');
        await refreshWatchlistPrices(today, quotes, onlyHkWatchlist).catch((e) => console.warn('[watchlist] 快照写入失败:', e.message));
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
 * @param {boolean} onlyHK - 是否仅写入港股自选（当大 A 休市时）
 */
async function refreshWatchlistPrices(today, quotes, onlyHK = false) {
    const items = db.prepare('SELECT code, added_price FROM watchlist').all();
    if (items.length === 0)
        return;
    const targetItems = onlyHK ? items.filter(it => it.code.endsWith('.HK')) : items;
    if (targetItems.length === 0)
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
        for (const item of targetItems) {
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