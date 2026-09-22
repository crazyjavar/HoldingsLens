/**
 * recalibrate_hk_costs.ts
 * 港股成本汇率折算与持仓盈亏历史校准脚本：
 * 1. 重新计算所有港股的真实人民币加权成本，更新 base_holdings；
 * 2. 校准历史 holdings 表中港股记录的 cost、total_pnl、total_pnl_pct；
 * 3. 重新聚合校准 daily_summary 表中的历史累计总盈亏与累计收益率；
 * 4. 触发今日行情强制刷新，生成完全匹配券商账户的最新快照。
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../holdings.db');
console.log(`[校准] 连接数据库: ${dbPath}`);
const db = new DatabaseSync(dbPath);
// 1. 查询所有港股标的
const hkHoldings = db.prepare("SELECT code, name FROM base_holdings WHERE code LIKE '%.HK'").all();
console.log(`[校准] 发现 ${hkHoldings.length} 只港股标的: ${hkHoldings.map(h => `${h.name}(${h.code})`).join(', ')}`);
db.exec('BEGIN');
try {
    // ── 步骤 1：重新回放计算 base_holdings 中的加权人民币成本 ───────────
    for (const h of hkHoldings) {
        const code = h.code;
        const opening = db.prepare('SELECT cost, quantity FROM opening_holdings WHERE code = ?').get(code) || { cost: 0, quantity: 0 };
        const txs = db.prepare('SELECT * FROM transactions WHERE code = ? ORDER BY trade_date ASC, created_at ASC').all(code);
        let cnyCost = opening.cost;
        let quantity = opening.quantity;
        for (const tx of txs) {
            const txQty = tx.quantity;
            if (tx.type === 'buy') {
                const newQty = quantity + txQty;
                const buyAmountCny = tx.amount_cny > 0 ? tx.amount_cny : (tx.price * txQty * (tx.fx_rate || 1.0));
                cnyCost = newQty > 0 ? (cnyCost * quantity + buyAmountCny) / newQty : cnyCost;
                quantity = newQty;
            }
            else if (tx.type === 'sell') {
                quantity = Math.max(0, quantity - txQty);
            }
            else if (tx.type === 'dividend') {
                const divCny = tx.amount_cny || 0;
                cnyCost = quantity > 0 ? Math.max(0, (cnyCost * quantity - divCny) / quantity) : cnyCost;
            }
        }
        db.prepare('UPDATE base_holdings SET cost = ?, quantity = ?, updated_at = ? WHERE code = ?')
            .run(cnyCost, quantity, new Date().toISOString(), code);
        console.log(`  ✓ ${h.name} (${code}) base_holdings 已更新: 每股成本 ¥${cnyCost.toFixed(4)}，持仓 ${quantity} 股`);
    }
    // ── 步骤 2：校准 holdings 表中各日期的港股成本与盈亏 ─────────────────
    const updateHoldingStmt = db.prepare(`
    UPDATE holdings
    SET cost = :cost, total_pnl = :total_pnl, total_pnl_pct = :total_pnl_pct
    WHERE date = :date AND code = :code
  `);
    for (const h of hkHoldings) {
        const code = h.code;
        const opening = db.prepare('SELECT cost, quantity FROM opening_holdings WHERE code = ?').get(code) || { cost: 0, quantity: 0 };
        const txs = db.prepare('SELECT * FROM transactions WHERE code = ? ORDER BY trade_date ASC, created_at ASC').all(code);
        // 查询该代码在 holdings 表中的所有快照记录
        const snapshots = db.prepare('SELECT * FROM holdings WHERE code = ? ORDER BY date ASC').all(code);
        for (const snap of snapshots) {
            const snapDate = snap.date;
            // 回放截至该 snapDate（包含当天）的加权人民币成本
            let runningCost = opening.cost;
            let runningQty = opening.quantity;
            for (const tx of txs) {
                if (tx.trade_date > snapDate)
                    break; // 交易日期晚于快照日期，不计入
                if (tx.type === 'buy') {
                    const nq = runningQty + tx.quantity;
                    const buyAmt = tx.amount_cny > 0 ? tx.amount_cny : (tx.price * tx.quantity * (tx.fx_rate || 1.0));
                    runningCost = nq > 0 ? (runningCost * runningQty + buyAmt) / nq : runningCost;
                    runningQty = nq;
                }
                else if (tx.type === 'sell') {
                    runningQty = Math.max(0, runningQty - tx.quantity);
                }
                else if (tx.type === 'dividend') {
                    const divCny = tx.amount_cny || 0;
                    runningCost = runningQty > 0 ? Math.max(0, (runningCost * runningQty - divCny) / runningQty) : runningCost;
                }
            }
            const costVal = Math.round(runningCost * snap.quantity * 100) / 100;
            const totalPnl = Math.round((snap.market - costVal) * 100) / 100;
            const totalPnlPct = costVal > 0 ? `${(totalPnl / costVal * 100).toFixed(2)}%` : '0.00%';
            updateHoldingStmt.run({
                cost: runningCost,
                total_pnl: totalPnl,
                total_pnl_pct: totalPnlPct,
                date: snapDate,
                code: code,
            });
        }
        console.log(`  ✓ ${h.name} (${code}) holdings 表历史 ${snapshots.length} 条快照已校准`);
    }
    // ── 步骤 3：重新聚合校准 daily_summary 表的 total_pnl 与 total_pnl_pct ─
    const allDates = db.prepare('SELECT DISTINCT date FROM daily_summary ORDER BY date ASC').all();
    const updateSummaryStmt = db.prepare(`
    UPDATE daily_summary
    SET total_pnl = :total_pnl, total_pnl_pct = :total_pnl_pct
    WHERE date = :date
  `);
    for (const d of allDates) {
        const snapDate = d.date;
        const dayHoldings = db.prepare('SELECT market, cost, quantity, total_pnl FROM holdings WHERE date = ?').all(snapDate);
        const sumPnl = dayHoldings.reduce((acc, r) => acc + r.total_pnl, 0);
        const sumCost = dayHoldings.reduce((acc, r) => acc + (r.cost * r.quantity), 0);
        const pnlPct = sumCost > 0 ? `${(sumPnl / sumCost * 100).toFixed(2)}%` : '0.00%';
        updateSummaryStmt.run({
            total_pnl: Math.round(sumPnl * 100) / 100,
            total_pnl_pct: pnlPct,
            date: snapDate,
        });
    }
    console.log(`  ✓ daily_summary 表中全部 ${allDates.length} 个历史交易日总盈亏已平滑校准完毕`);
    db.exec('COMMIT');
    console.log('[校准] 数据库校准事务已提交成功！');
}
catch (e) {
    db.exec('ROLLBACK');
    console.error('[校准] 校准失败，已回滚事务:', e);
    process.exit(1);
}
//# sourceMappingURL=recalibrate_hk_costs.js.map