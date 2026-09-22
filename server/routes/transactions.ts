import { Hono } from 'hono';
import { db, getFxRate, refreshFxRate, toSymbol } from '../db.js';
import { fetchPriceWithName } from '../fetcher.js';
import type { BaseHolding, OpeningHolding, Transaction, CountRow } from '../types.js';

const transactions = new Hono();

/**
 * POST / — 新增一笔交易（买入/卖出/现金分红）
 * body: { code, type:'buy'|'sell'|'dividend', trade_date, quantity, amount_cny, price?, note? }
 * 分红记录 quantity 可为 0（数量不变），price 可选；amount_cny > 0 表示分红金额，回放时冲减持仓成本。
 */
transactions.post('/', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: '请求体解析失败' }, 400); }

  const code      = String(body.code || '').trim().toUpperCase();
  const type      = String(body.type || '').trim().toLowerCase();
  const tradeDate = String(body.trade_date || '').trim();
  const quantity  = Number(body.quantity);
  const amountCny = Number(body.amount_cny);
  const note      = String(body.note || '').trim();

  if (!code)              return c.json({ error: '证券代码不能为空' }, 400);
  if (!['buy','sell','dividend'].includes(type)) return c.json({ error: 'type 必须为 buy, sell 或 dividend' }, 400);
  if (!tradeDate)         return c.json({ error: '交易日期不能为空' }, 400);
  if (type !== 'dividend' && !(quantity > 0)) return c.json({ error: '买卖股数必须大于0' }, 400);
  if (!(amountCny > 0))   return c.json({ error: '金额必须大于0' }, 400);

  // 查当前持仓；新标的先获取名称，数据库写入稍后统一进入事务
  let bh = db.prepare<BaseHolding>('SELECT * FROM base_holdings WHERE code = ?').get(code);
  let isNewHolding = false;
  if (!bh) {
    if (type !== 'buy') {
      return c.json({ error: `无法操作未持仓的证券 ${code}` }, 400);
    }

    // 自动获取新买入证券的中文名称
    let nameFromQuote = code;
    try {
      const sym = toSymbol(code);
      const quote = await fetchPriceWithName(sym);
      if (quote && quote.name) {
        nameFromQuote = quote.name;
      }
    } catch (err: unknown) {
      console.warn(`[tx] 无法获取证券 ${code} 的官方名称，将使用代码替代:`, (err as Error).message);
    }

    bh = { code, name: nameFromQuote, cost: 0.0, quantity: 0.0, updated_at: '' };
    isNewHolding = true;
  }

  // 卖出不超过持仓
  if (type === 'sell' && quantity > bh.quantity) {
    return c.json({
      error: `卖出 ${quantity} 股超过当前持仓 ${bh.quantity} 股`
    }, 400);
  }

  // 推算成交价（原始货币）
  const isHK  = code.endsWith('.HK');
  if (isHK) await refreshFxRate();
  const fxRate = isHK ? getFxRate() : 1.0;
  // 港股: CNY / 汇率 / 股数 = HKD 每股; A股: CNY / 股数 = CNY 每股; 分红时若数量为0则单价取0或传入price
  const price = (quantity > 0)
    ? Math.round((amountCny / fxRate / quantity) * 10000) / 10000
    : Number(body.price || 0);

  // 新增流水、创建新标的、回放持仓必须全部成功或全部回滚
  db.exec('BEGIN');
  try {
    const now = new Date().toISOString();
    if (isNewHolding && bh) {
      db.prepare(`
        INSERT INTO opening_holdings (code, name, cost, quantity, created_at)
        VALUES (?, ?, 0.0, 0.0, ?)
      `).run(code, bh.name, now);
      db.prepare(`
        INSERT INTO base_holdings (code, name, cost, quantity, updated_at)
        VALUES (?, ?, 0.0, 0.0, ?)
      `).run(code, bh.name, now);
    }
    db.prepare(`
      INSERT INTO transactions (code, type, trade_date, price, quantity, amount_cny, fx_rate, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, type, tradeDate, price, quantity, amountCny, fxRate, note, now);
    replayHolding(code);
    db.exec('COMMIT');
  } catch (err: unknown) {
    db.exec('ROLLBACK');
    return c.json({ error: `交易写入失败: ${(err as Error).message}` }, 500);
  }

  const updated = db.prepare<BaseHolding>('SELECT * FROM base_holdings WHERE code = ?').get(code);
  console.log(`[tx] ${type} ${code} ×${quantity} @¥${amountCny} → 新成本 ${updated?.cost.toFixed(4)}, 持仓 ${updated?.quantity}`);

  return c.json({
    ok: true,
    code,
    type,
    price: Math.round(price * 10000) / 10000,
    quantity,
    amount_cny: amountCny,
    new_cost:   updated?.cost,
    new_quantity: updated?.quantity,
  });
});

/**
 * 回放重算某只股票的 base_holdings
 * 从 SQLite 期初持仓出发，按时间顺序叠加所有交易记录
 * 对于港股（.HK），买入时以实际结算扣除的人民币金额 amount_cny 累加均摊，
 * 从而确保 base_holdings.cost 记录的是真实的人民币每股成本（RMB/股）。
 */
function replayHolding(code: string): void {
  const opening = db.prepare<OpeningHolding>('SELECT cost, quantity FROM opening_holdings WHERE code = ?').get(code);
  if (!opening) throw new Error(`${code} 缺少期初持仓记录`);
  let cost     = opening.cost;
  let quantity = opening.quantity;

  const isHK = code.endsWith('.HK');

  // 按交易日期升序回放所有交易
  const txList = db.prepare<Transaction>(
    'SELECT * FROM transactions WHERE code = ? ORDER BY trade_date ASC, created_at ASC'
  ).all(code);

  for (const tx of txList) {
    const txQty   = tx.quantity;
    const txPrice = tx.price;
    if (tx.type === 'buy') {
      const newQty  = quantity + txQty;
      if (isHK) {
        // 港股：加权平均每股人民币成本
        // 真实买入金额：优先使用当时券商结算扣款的 amount_cny；若没有则回退为 price * quantity * fx_rate
        const buyAmountCny = tx.amount_cny > 0 ? tx.amount_cny : (txPrice * txQty * (tx.fx_rate || 1.0));
        cost = newQty > 0 ? (cost * quantity + buyAmountCny) / newQty : cost;
      } else {
        // A 股/基金：人民币加权
        cost = newQty > 0 ? (cost * quantity + txPrice * txQty) / newQty : cost;
      }
      quantity = newQty;
    } else if (tx.type === 'sell') {
      // 卖出：数量减少，每股成本保持不变
      quantity = Math.max(0, quantity - txQty);
    } else if (tx.type === 'dividend') {
      // 现金分红：冲减持仓人民币成本本金（数量不变）
      const divCny = tx.amount_cny || 0;
      cost = quantity > 0 ? Math.max(0, (cost * quantity - divCny) / quantity) : cost;
    }
  }

  db.prepare(`
    UPDATE base_holdings SET cost = ?, quantity = ?, updated_at = ? WHERE code = ?
  `).run(cost, quantity, new Date().toISOString(), code);
}

/**
 * 判断某标的是否已成为“空占位”持仓：
 * 基础持仓与期初持仓都为 0 且没有任何交易记录（例如撤销了唯一一笔建仓买入）。
 * 这种占位行没有任何数据价值，可在撤销后直接清理，避免积累孤儿记录。
 */
function isPlaceholderHolding(code: string): boolean {
  const bh = db.prepare<{ quantity: number, cost: number }>('SELECT quantity, cost FROM base_holdings WHERE code = ?').get(code);
  if (!bh || bh.quantity !== 0 || bh.cost !== 0) return false;
  const opening = db.prepare<{ quantity: number, cost: number }>('SELECT quantity, cost FROM opening_holdings WHERE code = ?').get(code);
  if (!opening || opening.quantity !== 0 || opening.cost !== 0) return false;
  const txCount = db.prepare<CountRow>('SELECT COUNT(*) AS n FROM transactions WHERE code = ?').get(code);
  return (txCount?.n ?? 0) === 0;
}

/** GET /:code — 查询某只股票的交易历史与期初/基础持仓 */
transactions.get('/:code', (c) => {
  const code = c.req.param('code').toUpperCase();
  const rows = db.prepare<Transaction>(
    'SELECT * FROM transactions WHERE code = ? ORDER BY trade_date DESC, created_at DESC'
  ).all(code);
  const opening = db.prepare<{ cost: number, quantity: number, created_at: string }>(
    'SELECT cost, quantity, created_at FROM opening_holdings WHERE code = ?'
  ).get(code) || null;
  const base = db.prepare<{ name: string, cost: number, quantity: number, updated_at: string }>(
    'SELECT name, cost, quantity, updated_at FROM base_holdings WHERE code = ?'
  ).get(code) || null;

  // 针对港股，额外计算港币原币加权成本（cost_hkd），供前端双币展示
  let costHkd: number | null = null;
  if (code.endsWith('.HK')) {
    let hkdQty = opening?.quantity || 0;
    let hkdCost = opening?.cost || 0;
    const ascTxs = [...rows].reverse();
    for (const tx of ascTxs) {
      if (tx.type === 'buy') {
        const nq = hkdQty + tx.quantity;
        hkdCost = nq > 0 ? (hkdCost * hkdQty + tx.price * tx.quantity) / nq : hkdCost;
        hkdQty = nq;
      } else if (tx.type === 'sell') {
        hkdQty = Math.max(0, hkdQty - tx.quantity);
      }
    }
    costHkd = Math.round(hkdCost * 10000) / 10000;
  }

  return c.json({
    code,
    base: base ? { ...base, cost_hkd: costHkd } : null,
    opening,
    transactions: rows,
    fx_rate: getFxRate(),
  });
});

/** DELETE /:id — 撤销一笔交易（回放重算）*/
transactions.delete('/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tx = db.prepare<Transaction>('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!tx) return c.json({ error: `交易记录 #${id} 不存在` }, 404);
  if (tx.note === '初始持仓') return c.json({ error: '初始持仓记录不可撤销，请通过调整持仓操作修改' }, 400);

  const code = tx.code;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    replayHolding(code);
    // 若撤销后变成“无持仓、无期初、无流水”的空占位行，则一并清理。
    if (isPlaceholderHolding(code)) {
      db.prepare('DELETE FROM base_holdings WHERE code = ?').run(code);
      db.prepare('DELETE FROM opening_holdings WHERE code = ?').run(code);
    }
    db.exec('COMMIT');
  } catch (err: unknown) {
    db.exec('ROLLBACK');
    return c.json({ error: `撤销失败: ${(err as Error).message}` }, 500);
  }

  const updated = db.prepare<BaseHolding>('SELECT * FROM base_holdings WHERE code = ?').get(code);
  if (!updated) {
    console.log(`[tx] 撤销 #${id}，${code} 已无持仓与流水，占位记录已清理`);
    return c.json({ ok: true, deleted_id: id, code, new_cost: 0, new_quantity: 0, removed: true });
  }

  console.log(`[tx] 撤销 #${id}，${code} 回放后: 成本 ${updated.cost.toFixed(4)}, 持仓 ${updated.quantity}`);
  return c.json({
    ok: true,
    deleted_id: id,
    code,
    new_cost:     updated.cost,
    new_quantity: updated.quantity,
    removed:      false,
  });
});

export default transactions;
