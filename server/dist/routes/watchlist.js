import { Hono } from 'hono';
import { db, beijingDate } from '../db.js';
import { fetchPriceWithName, sinaSymbol } from '../fetcher.js';
export const stockSearch = new Hono();
/** GET /search?q=... — 股票拼音/代码/中文智能联想搜索 */
stockSearch.get('/search', async (c) => {
    const q = c.req.query('q') || '';
    if (!q.trim())
        return c.json({ list: [] });
    try {
        const resp = await fetch(`https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(q)}`);
        if (!resp.ok)
            return c.json({ list: [] });
        // 新浪接口返回的是 GBK 编码，使用 TextDecoder('gbk') 原生解码
        const arrayBuffer = await resp.arrayBuffer();
        const text = new TextDecoder('gbk').decode(arrayBuffer);
        const match = text.match(/var suggestvalue="([^"]*)"/);
        if (!match)
            return c.json({ list: [] });
        const items = match[1].split(';').filter(Boolean);
        const list = items.map((item) => {
            const parts = item.split(',');
            if (parts.length < 5)
                return null;
            const type = parts[1];
            const fullCode = parts[3].toLowerCase();
            const name = parts[4];
            let normCode = '';
            if (type === '11') { // A股
                if (fullCode.startsWith('sz')) {
                    normCode = fullCode.slice(2).toUpperCase() + '.SZ';
                }
                else if (fullCode.startsWith('sh')) {
                    normCode = fullCode.slice(2).toUpperCase() + '.SH';
                }
            }
            else if (type === '31') { // 港股
                let rawNum = fullCode.startsWith('hk') ? fullCode.slice(2) : parts[2];
                if (rawNum.length === 4) {
                    rawNum = '0' + rawNum;
                }
                normCode = rawNum.toUpperCase() + '.HK';
            }
            else {
                return null;
            }
            return { code: normCode, name };
        }).filter(Boolean);
        return c.json({ list });
    }
    catch (err) {
        console.error('Search stock error:', err);
        return c.json({ list: [] });
    }
});
const watchlist = new Hono();
/** GET / — 获取全部自选股 + 最新价格快照 */
watchlist.get('/', (c) => {
    const items = db.prepare('SELECT * FROM watchlist ORDER BY sort_order ASC, created_at ASC').all();
    const holdingCodes = new Set(db.prepare('SELECT DISTINCT code FROM base_holdings WHERE quantity > 0').all().map(r => r.code));
    // 持仓明细当前展示的快照（与 /api/holdings/latest 同一口径：最新一天）。
    // 自选股里若包含持仓股，现价/昨收/今日涨跌一律以该快照为准，
    // 保证同一只股票在“持仓明细”与“自选”里显示的涨跌幅完全一致，而不是各取自选快照重算。
    const latestDateRow = db.prepare('SELECT date FROM holdings ORDER BY date DESC LIMIT 1').get();
    const portfolioSnapByCode = new Map();
    if (latestDateRow) {
        for (const row of db.prepare('SELECT code, price, prev_close, day_pnl_pct FROM holdings WHERE date = ?').all(latestDateRow.date)) {
            portfolioSnapByCode.set(row.code, row);
        }
    }
    const result = items.map(item => {
        const code = item.code;
        const inHoldings = holdingCodes.has(code);
        const portfolioSnap = portfolioSnapByCode.get(code);
        // 持仓股：直接采用持仓快照（同一行数据），避免二次抓取或重算产生口径差异。
        if (inHoldings && portfolioSnap) {
            const addedPrice = item.added_price;
            const hpPrice = portfolioSnap.price;
            const totalPct = (hpPrice > 0 && addedPrice > 0)
                ? `${((hpPrice - addedPrice) / addedPrice * 100).toFixed(2)}%`
                : '0.00%';
            return {
                code,
                name: item.name,
                added_date: item.added_date,
                added_price: addedPrice,
                note: item.note,
                current_price: hpPrice,
                prev_close: portfolioSnap.prev_close,
                day_pct: portfolioSnap.day_pnl_pct, // 与持仓明细“今日涨跌”同一字符串，显示逐字一致
                total_pct: totalPct,
                in_holdings: true,
                snap_date: latestDateRow.date,
            };
        }
        // 非持仓股：取自选行情快照（当日优先，否则取最近一条）
        const snap = db.prepare('SELECT * FROM watchlist_price WHERE code = ? ORDER BY date DESC LIMIT 1').get(code);
        const currentPrice = snap ? snap.price : null;
        const prevClose = snap ? snap.prev_close : null;
        const pctVsAdded = snap ? snap.pct_vs_added : null;
        const dayPct = (currentPrice && prevClose && prevClose > 0)
            ? `${((currentPrice - prevClose) / prevClose * 100).toFixed(2)}%`
            : null;
        return {
            code,
            name: item.name,
            added_date: item.added_date,
            added_price: item.added_price,
            note: item.note,
            current_price: currentPrice,
            prev_close: prevClose,
            day_pct: dayPct,
            total_pct: pctVsAdded,
            in_holdings: inHoldings,
            snap_date: snap ? snap.date : null,
        };
    });
    return c.json({ watchlist: result });
});
/** POST / — 添加自选股 */
watchlist.post('/', async (c) => {
    let body;
    try {
        body = await c.req.json();
    }
    catch {
        return c.json({ error: '请求体解析失败' }, 400);
    }
    const code = String(body.code || '').trim().toUpperCase();
    if (!code)
        return c.json({ error: '证券代码不能为空' }, 400);
    // 检查是否已在自选中
    const exists = db.prepare('SELECT 1 AS n FROM watchlist WHERE code = ? LIMIT 1').get(code);
    if (exists)
        return c.json({ error: `${code} 已在自选股列表中` }, 409);
    // 拉取行情 + 名称
    let quote;
    try {
        quote = await fetchPriceWithName(sinaSymbol(code));
    }
    catch (err) {
        return c.json({ error: `无法获取行情: ${err.message}` }, 502);
    }
    // 名称：前端覆盖 > 行情自动获取
    const name = String(body.name || '').trim() || quote.name || code;
    const note = String(body.note || '').trim();
    const today = beijingDate();
    // 新加入的自选默认排在最上面：取当前最小 sort_order − 1（表为空时从 0 开始），
    // 列表按 sort_order 升序展示；手动拖拽排序时仍会按新顺序重排为 0..n-1。
    const minOrder = db.prepare('SELECT MIN(sort_order) AS m FROM watchlist').get();
    const sortOrder = ((minOrder && minOrder.m) ?? 1) - 1;
    db.exec('BEGIN');
    try {
        db.prepare(`
      INSERT INTO watchlist (code, name, added_date, added_price, note, sort_order, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(code, name, today, quote.current, note, sortOrder, new Date().toISOString());
        // 立即写入当日快照
        db.prepare(`
      INSERT INTO watchlist_price (code, date, price, prev_close, pct_vs_added)
      VALUES (?, ?, ?, ?, '0.00%')
      ON CONFLICT(code, date) DO NOTHING
    `).run(code, today, quote.current, quote.previousClose);
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        return c.json({ error: `自选股保存失败: ${err.message}` }, 500);
    }
    console.log(`[watchlist] 添加: ${code} ${name} @${quote.current}`);
    return c.json({ ok: true, code, name, added_price: quote.current, added_date: today });
});
/** DELETE /:code — 删除自选股 */
watchlist.delete('/:code', (c) => {
    const code = c.req.param('code').toUpperCase();
    const exists = db.prepare('SELECT 1 AS n FROM watchlist WHERE code = ?').get(code);
    if (!exists)
        return c.json({ error: `${code} 不在自选股列表中` }, 404);
    db.exec('BEGIN');
    try {
        db.prepare('DELETE FROM watchlist WHERE code = ?').run(code);
        db.prepare('DELETE FROM watchlist_price WHERE code = ?').run(code);
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        return c.json({ error: `删除失败: ${err.message}` }, 500);
    }
    console.log(`[watchlist] 删除: ${code}`);
    return c.json({ ok: true, code });
});
/** PATCH /reorder — 更新排列顺序 */
watchlist.patch('/reorder', async (c) => {
    let data;
    try {
        data = await c.req.json();
    }
    catch {
        return c.json({ error: '请求体解析失败' }, 400);
    }
    const codes = Array.isArray(data?.codes) ? data.codes : [];
    if (!codes.length)
        return c.json({ error: 'codes 不能为空' }, 400);
    const update = db.prepare('UPDATE watchlist SET sort_order = ? WHERE code = ?');
    db.exec('BEGIN');
    try {
        codes.forEach((code, idx) => update.run(idx, code.toUpperCase()));
        db.exec('COMMIT');
    }
    catch (e) {
        db.exec('ROLLBACK');
        return c.json({ error: e.message }, 500);
    }
    return c.json({ ok: true });
});
export default watchlist;
//# sourceMappingURL=watchlist.js.map