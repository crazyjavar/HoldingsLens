/**
 * server.js — 持仓明细服务主入口
 * 技术栈：Hono + @hono/node-server + node:sqlite（Node 22.5+）
 * 功能：
 *   1. 静态文件服务（public/）
 *   2. REST API（/api/*）
 *   3. 行情定时抓取（交易时段每 5 分钟）
 */

import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { serve } from '@hono/node-server';
import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { fetchPrices, fetchPriceWithName, fetchHkdCnyRate, sinaSymbol } from './fetcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── SQLite 初始化 ─────────────────────────────────────────
const DB_PATH = process.env.HOLDINGS_DB_PATH
  ? resolve(process.env.HOLDINGS_DB_PATH)
  : resolve(ROOT, 'holdings.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS holdings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    date          TEXT    NOT NULL,
    code          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    market        REAL    NOT NULL,
    cost          REAL,
    prev_close    REAL,
    price         REAL    NOT NULL,
    quantity      REAL    NOT NULL,
    day_pnl       REAL,
    day_pnl_pct   TEXT,
    total_pnl     REAL,
    total_pnl_pct TEXT,
    weight        TEXT,
    change_pct    TEXT,
    UNIQUE(date, code)
  );

  CREATE TABLE IF NOT EXISTS daily_summary (
    date          TEXT PRIMARY KEY,
    total_market  REAL,
    total_day_pnl REAL,
    total_day_pct TEXT,
    total_pnl     REAL,
    total_pnl_pct TEXT,
    updated_at    TEXT
  );

  CREATE TABLE IF NOT EXISTS base_holdings (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cost       REAL NOT NULL,
    quantity   REAL NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS opening_holdings (
    code       TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cost       REAL NOT NULL,
    quantity   REAL NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS app_metadata (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL,
    type       TEXT NOT NULL,
    trade_date TEXT NOT NULL,
    price      REAL NOT NULL,
    quantity   REAL NOT NULL,
    amount_cny REAL NOT NULL,
    fx_rate    REAL NOT NULL DEFAULT 1.0,
    note       TEXT DEFAULT '',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    added_date  TEXT NOT NULL,
    added_price REAL NOT NULL,
    note        TEXT DEFAULT '',
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS watchlist_price (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    code       TEXT NOT NULL,
    date       TEXT NOT NULL,
    price      REAL NOT NULL,
    prev_close REAL,
    pct_vs_added TEXT,
    UNIQUE(code, date)
  );
`);

// ── 持仓基础数据种子（仅用于首次初始化 base_holdings 表）────
// 后续所有修改通过 /api/transactions 完成，此处不再参与计算
const SEED_HOLDINGS = [
  { code: '512170.SH', name: '医疗ETF',          cost: 0.334,    quantity: 444700 },
  { code: '159938.SZ', name: '医药ETF广发',       cost: 0.591,    quantity: 118600 },
  { code: '03690.HK',  name: '美团-W',            cost: 106.846,  quantity: 700    },
  { code: '513180.SH', name: '恒指科技',          cost: 0.754,    quantity: 49600  },
  { code: '513050.SH', name: '中概互联',          cost: 0.972,    quantity: 25500  },
  { code: '09988.HK',  name: '阿里巴巴-W',        cost: 139.333,  quantity: 200    },
  { code: '01024.HK',  name: '快手-W',            cost: 47.194,   quantity: 200    },
  { code: '06865.HK',  name: '福莱特玻璃',        cost: 10.14,    quantity: 1000   },
  { code: '512880.SH', name: '证券ETF',           cost: 0.889,    quantity: 5000   },
  { code: '513040.SH', name: '港股通互联网ETF',   cost: 1.297,    quantity: 45700  },
];

// 启动时：若 base_holdings 为空则将种子数据写入
{
  const count = db.prepare('SELECT COUNT(*) AS n FROM base_holdings').get();
  if (!count || count['n'] === 0) {
    const insert = db.prepare(
      'INSERT OR IGNORE INTO base_holdings (code, name, cost, quantity, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = new Date().toISOString();
    db.exec('BEGIN');
    for (const h of SEED_HOLDINGS) insert.run(h.code, h.name, h.cost, h.quantity, now);
    db.exec('COMMIT');
    console.log('[init] base_holdings 已从种子数据初始化');
  }
}

// 一次性将原先依赖代码常量的期初持仓迁移到 SQLite。
// 已有种子标的按旧期初值迁移；无交易的手工持仓以当前值作为期初值；
// 由交易新增的非种子标的以 0 作为期初值。
{
  const count = db.prepare('SELECT COUNT(*) AS n FROM opening_holdings').get();
  if (!count || count['n'] === 0) {
    const bases = db.prepare('SELECT * FROM base_holdings').all();
    const txCountStmt = db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE code = ?');
    const insert = db.prepare(`
      INSERT INTO opening_holdings (code, name, cost, quantity, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const h of bases) {
        const seed = SEED_HOLDINGS.find(item => item.code === h['code']);
        const txCount = txCountStmt.get(h['code'])?.['n'] ?? 0;
        const opening = seed || (txCount === 0
          ? { cost: h['cost'], quantity: h['quantity'] }
          : { cost: 0, quantity: 0 });
        insert.run(h['code'], h['name'], opening.cost, opening.quantity, now);
      }
      db.exec('COMMIT');
      console.log('[init] opening_holdings 期初持仓已迁移到 SQLite');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ── HKD → CNY 参考汇率（远程真实汇率 + SQLite 最近成功值降级）──
const storedFxRate = db.prepare("SELECT value FROM app_metadata WHERE key = 'hkd_cny_rate'").get();
let cachedFxRate = Number(storedFxRate?.value) || 0.9148;
let cachedFxDate = db.prepare("SELECT value FROM app_metadata WHERE key = 'hkd_cny_date'").get()?.value || null;

async function refreshFxRate() {
  try {
    const result = await fetchHkdCnyRate();
    cachedFxRate = result.rate;
    cachedFxDate = result.date;
    const upsert = db.prepare(`
      INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `);
    const now = new Date().toISOString();
    upsert.run('hkd_cny_rate', String(result.rate), now);
    upsert.run('hkd_cny_date', result.date || '', now);
    return { ...result, fallback: false };
  } catch (err) {
    console.warn(`[fx] 真实汇率获取失败，使用最近成功值 ${cachedFxRate}: ${err.message}`);
    return { rate: cachedFxRate, date: cachedFxDate, source: 'cache', fallback: true };
  }
}

/**
 * 将证券代码格式（如 512170.SH）转换为行情符号（sh512170）
 */
function toSymbol(code) {
  return sinaSymbol(code);
}

/**
 * 判断当前是否在交易时段（工作日 9:25-15:05）
 */
function isTradingHours() {
  const now = new Date();
  // 转换为北京时间
  const bj = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = bj.getDay(); // 0=周日, 6=周六
  if (day === 0 || day === 6) return false;
  const h = bj.getHours();
  const m = bj.getMinutes();
  const total = h * 60 + m;
  return total >= 9 * 60 + 25 && total <= 15 * 60 + 5;
}

/** 核心：拉取行情并写入 SQLite */
let lastRefreshTime = null;
let refreshLock = false;

export async function refreshHoldings() {
  // 增加周末过滤防御，防止生成周末静止的历史数据行
  const bj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const day = bj.getDay(); // 0=周日, 6=周六
  if (day === 0 || day === 6) {
    console.log('[refresh] 周末不开盘，跳过行情抓取及写入');
    return { skipped: true, reason: 'weekend' };
  }

  if (refreshLock) {
    console.log('[refresh] 上一次抓取仍在进行，跳过');
    return { skipped: true };
  }
  refreshLock = true;
  const startedAt = new Date().toISOString();
  console.log(`[refresh] 开始抓取行情 ${startedAt}`);

  try {
    // 从 DB 读取持仓（取代硬编码 SEED_HOLDINGS）
    const baseHoldings = db.prepare('SELECT * FROM base_holdings').all();
    const symbols = baseHoldings.map(h => toSymbol(h['code']));
    const today = new Date().toLocaleString('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).slice(0, 10); // YYYY-MM-DD
    const [quotes] = await Promise.all([
      fetchPrices(symbols),
      refreshFxRate(),
    ]);

    // 开盘前或 A/H 股同时休市时，行情源只会返回上一交易日。
    // 当所有可判定的行情日期都不是今天时，不写入今日快照。
    const quoteDates = Object.values(quotes).map(q => q.lastTradeDate).filter(Boolean);
    if (quoteDates.length > 0 && !quoteDates.includes(today)) {
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
      if (!quote) continue;

      const { current, previousClose, lastTradeDate } = quote;
      const code     = holding['code'];
      const name     = holding['name'];
      const cost     = holding['cost'];
      const quantity = holding['quantity'];

      // 查询今天以前的最新历史记录，用作昨收价锚定
      const latestRow = db.prepare(
        'SELECT market, price, quantity FROM holdings WHERE code = ? AND date < ? ORDER BY date DESC LIMIT 1'
      ).get(code, today);

      // 港股使用已获取并持久化的真实参考汇率
      const isHK = code.endsWith('.HK');
      const fx = isHK ? cachedFxRate : 1.0;

      // 确定今天计算所用的“昨收价”（优先使用数据库中历史最后一天的实际价格，若无，则回退使用行情接口昨收价）
      const prevCloseToUse = (latestRow && latestRow.price > 0) ? latestRow.price : previousClose;

      // 重要判定：该标的今天是否交易（只有当行情拉取的最后交易日期明确且不等于今天，才判定为休市）
      const isClosedToday = (lastTradeDate && lastTradeDate !== today);

      let market, prevMkt, dayPnl, dayRate;

      if (isClosedToday) {
        // 如果今天休市，现价强制等于昨收价，使单只标的的日盈亏与涨跌幅归零
        const priceToUse = prevCloseToUse;
        market   = Math.round(priceToUse * quantity * fx * 100) / 100;
        prevMkt  = Math.round(prevCloseToUse * quantity * fx * 100) / 100;
        dayPnl   = 0.0;
        dayRate  = '0.00%';
        console.log(`[refresh] 标的 ${name} (${code}) 今天休市 (最后交易日 ${lastTradeDate})，当日盈亏归零`);
      } else {
        market   = Math.round(current * quantity * fx * 100) / 100;
        prevMkt  = prevCloseToUse > 0 ? Math.round(prevCloseToUse * quantity * fx * 100) / 100 : 0;
        dayPnl   = Math.round((market - prevMkt) * 100) / 100;
        dayRate  = prevCloseToUse > 0
          ? `${((current - prevCloseToUse) / prevCloseToUse * 100).toFixed(2)}%`
          : '0.00%';
      }

      const costVal  = Math.round(cost * quantity * fx * 100) / 100;
      const pnl      = Math.round((market - costVal) * 100) / 100;
      const pnlRate  = cost > 0
        ? `${((current - cost) / cost * 100).toFixed(2)}%`
        : '0.00%';

      totalMarket    += market;
      totalCostValue += costVal;
      
      // 只有当标的今天没有休市，才将其盈亏和市值累加进“今日盈亏”与“当日收益率除数”
      if (!isClosedToday) {
        totalDayPnl    += dayPnl;
        if (prevMkt > 0) totalPrevMarket += prevMkt;
      }
      
      totalPnl       += pnl;

      rows.push({ date: today, code, name, market, cost, prev_close: prevCloseToUse,
        price: isClosedToday ? prevCloseToUse : current, quantity, day_pnl: dayPnl, day_pnl_pct: dayRate,
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
      for (const row of rows) upsert.run(row);
      db.exec('COMMIT');
    } catch (txErr) {
      db.exec('ROLLBACK');
      throw txErr;
    }

    // 写入 daily_summary 表
    const totalDayRate = totalPrevMarket > 0
      ? `${(totalDayPnl / totalPrevMarket * 100).toFixed(2)}%`
      : '0.00%';
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
    `).run(today, Math.round(totalMarket * 100) / 100, Math.round(totalDayPnl * 100) / 100,
      totalDayRate, Math.round(totalPnl * 100) / 100, totalPnlRate, new Date().toISOString());

    lastRefreshTime = new Date().toISOString();
    console.log(`[refresh] 完成，${rows.length} 条持仓写入 SQLite`);

    // ── 顺带刷新自选股行情快照 ────────────────────────────────
    await refreshWatchlistPrices(today).catch(e =>
      console.warn('[watchlist] 快照写入失败:', e.message)
    );

    return { ok: true, date: today, count: rows.length };
  } catch (err) {
    console.error('[refresh] 抓取失败:', err.message);
    return { ok: false, error: err.message };
  } finally {
    refreshLock = false;
  }
}

/**
 * 刷新自选股行情快照（写入 watchlist_price）
 */
async function refreshWatchlistPrices(today) {
  const items = db.prepare('SELECT code, added_price FROM watchlist').all();
  if (items.length === 0) return;

  const symbols = items.map(r => sinaSymbol(r['code']));
  let quotes;
  try {
    quotes = await fetchPrices(symbols);
  } catch (err) {
    console.warn('[watchlist] 行情抓取失败:', err.message);
    return;
  }

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
      const sym = sinaSymbol(item['code']);
      const q = quotes[sym];
      if (!q) continue;
      const addedPrice = item['added_price'];
      const pct = addedPrice > 0
        ? `${((q.current - addedPrice) / addedPrice * 100).toFixed(2)}%`
        : '0.00%';
      upsert.run({
        code: item['code'],
        date: today,
        price: q.current,
        prev_close: q.previousClose,
        pct_vs_added: pct,
      });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ── Hono 应用 ─────────────────────────────────────────────
const app = new Hono();

// ── API 路由 ──────────────────────────────────────────────

/** GET /api/holdings/latest — 最新一天的持仓 + 汇总 */
app.get('/api/holdings/latest', (c) => {
  const latestDate = db.prepare(
    'SELECT date FROM holdings ORDER BY date DESC LIMIT 1'
  ).get();
  if (!latestDate) {
    return c.json({ holdings: [], summary: null, date: null });
  }
  const date = latestDate['date'];
  const holdings = db.prepare(
    'SELECT * FROM holdings WHERE date = ? ORDER BY market DESC'
  ).all(date);
  const summary = db.prepare(
    'SELECT * FROM daily_summary WHERE date = ?'
  ).get(date);

  // ── 计算当月盈亏（本月每日盈亏之和） ────────────────────────
  const monthPrefix = date.slice(0, 7) + '-%';
  const monthPnlRow = db.prepare(
    'SELECT SUM(total_day_pnl) AS month_pnl FROM daily_summary WHERE date LIKE ?'
  ).get(monthPrefix);
  const monthPnl = monthPnlRow ? (monthPnlRow['month_pnl'] ?? 0) : 0;

  // 计算当月期初资产（即上个月最后一天的总市值）
  const firstDayOfMonth = date.slice(0, 7) + '-01';
  const prevMonthLastDay = db.prepare(
    'SELECT total_market FROM daily_summary WHERE date < ? ORDER BY date DESC LIMIT 1'
  ).get(firstDayOfMonth);

  let startMarket = 0;
  if (prevMonthLastDay && prevMonthLastDay['total_market'] > 0) {
    startMarket = prevMonthLastDay['total_market'];
  } else {
    // 若无上月数据，则取本月第一天的市值和当日盈亏倒推期初资产
    const thisMonthFirstDay = db.prepare(
      'SELECT total_market, total_day_pnl FROM daily_summary WHERE date LIKE ? ORDER BY date ASC LIMIT 1'
    ).get(monthPrefix);
    if (thisMonthFirstDay) {
      startMarket = (thisMonthFirstDay['total_market'] || 0) - (thisMonthFirstDay['total_day_pnl'] || 0);
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
  const weekPnl = weekPnlRow?.['week_pnl'] ?? 0;
  const prevWeekMarket = db.prepare(
    'SELECT total_market FROM daily_summary WHERE date < ? ORDER BY date DESC LIMIT 1'
  ).get(weekStart);
  const firstWeekDay = db.prepare(`
    SELECT total_market, total_day_pnl
    FROM daily_summary
    WHERE date BETWEEN ? AND ?
    ORDER BY date ASC LIMIT 1
  `).get(weekStart, date);
  const weekStartMarket = prevWeekMarket?.['total_market'] > 0
    ? prevWeekMarket['total_market']
    : Math.max(0, (firstWeekDay?.['total_market'] || 0) - (firstWeekDay?.['total_day_pnl'] || 0));
  const weekPnlRate = weekStartMarket > 0 ? `${(weekPnl / weekStartMarket * 100).toFixed(2)}%` : '0.00%';

  // 周战报只在当周周五收盘后及紧随的周末开放，避免旧数据误触发。
  const nowBj = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
  const todayBj = new Date(Date.UTC(nowBj.getFullYear(), nowBj.getMonth(), nowBj.getDate()));
  const daysSinceLatest = Math.round((todayBj.getTime() - latestDay.getTime()) / 86400000);
  const afterFridayClose = nowBj.getHours() * 60 + nowBj.getMinutes() >= 15 * 60 + 5;
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

  return c.json({ date, holdings, summary: extendedSummary });
});

/** GET /api/holdings/history?days=30 — 过去 N 天每日汇总（用于趋势图）*/
app.get('/api/holdings/history', (c) => {
  const days = Math.min(parseInt(c.req.query('days') ?? '30', 10), 365);
  const rows = db.prepare(`
    SELECT date, total_market, total_day_pnl, total_day_pct, total_pnl, total_pnl_pct
    FROM daily_summary
    ORDER BY date DESC
    LIMIT ?
  `).all(days);
  return c.json({ history: [...rows].reverse() }); // 升序返回（图表用）
});

/** POST /api/holdings/refresh — 手动触发一次行情抓取 */
app.post('/api/holdings/refresh', async (c) => {
  const result = await refreshHoldings();
  return c.json(result, result.ok || result.skipped ? 200 : 500);
});

/** GET /api/status — 服务状态 */
app.get('/api/status', (c) => {
  const count = db.prepare('SELECT COUNT(*) AS n FROM daily_summary').get();
  const n = count ? count['COUNT(*) AS n'] ?? count['n'] ?? 0 : 0;
  return c.json({
    status: 'ok',
    lastRefresh: lastRefreshTime,
    totalDays: n,
    tradingHours: isTradingHours(),
  });
});

// ── 持仓管理 API ──────────────────────────────────────────

/** GET /api/base-holdings — 获取所有持仓基础数据（含交易笔数）*/
app.get('/api/base-holdings', (c) => {
  const rows = db.prepare('SELECT * FROM base_holdings ORDER BY code').all();
  const result = rows.map(r => {
    const txCount = db.prepare(
      'SELECT COUNT(*) AS n FROM transactions WHERE code = ?'
    ).get(r['code']);
    return {
      code:       r['code'],
      name:       r['name'],
      cost:       r['cost'],
      quantity:   r['quantity'],
      updated_at: r['updated_at'],
      tx_count:   txCount ? txCount['n'] : 0,
    };
  });
  return c.json({
    holdings: result,
    fx_rate: cachedFxRate,
    fx_date: cachedFxDate,
    fx_source: 'Frankfurter',
  });
});

/**
 * POST /api/transactions — 新增一笔交易（买入/卖出）
 * body: { code, type:'buy'|'sell', trade_date, quantity, amount_cny, note? }
 */
app.post('/api/transactions', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: '请求体解析失败' }, 400); }

  const code      = (body.code || '').trim().toUpperCase();
  const type      = (body.type || '').trim().toLowerCase();
  const tradeDate = (body.trade_date || '').trim();
  const quantity  = Number(body.quantity);
  const amountCny = Number(body.amount_cny);
  const note      = (body.note || '').trim();

  if (!code)              return c.json({ error: '证券代码不能为空' }, 400);
  if (!['buy','sell'].includes(type)) return c.json({ error: 'type 必须为 buy 或 sell' }, 400);
  if (!tradeDate)         return c.json({ error: '交易日期不能为空' }, 400);
  if (!(quantity > 0))    return c.json({ error: '股数必须大于0' }, 400);
  if (!(amountCny > 0))   return c.json({ error: '金额必须大于0' }, 400);

  // 查当前持仓；新标的先获取名称，数据库写入稍后统一进入事务
  let bh = db.prepare('SELECT * FROM base_holdings WHERE code = ?').get(code);
  let isNewHolding = false;
  if (!bh) {
    if (type !== 'buy') {
      return c.json({ error: `无法卖出未持仓的证券 ${code}` }, 400);
    }

    // 自动获取新买入证券的中文名称
    let nameFromQuote = code;
    try {
      const sym = toSymbol(code);
      const quote = await fetchPriceWithName(sym);
      if (quote && quote.name) {
        nameFromQuote = quote.name;
      }
    } catch (err) {
      console.warn(`[tx] 无法获取证券 ${code} 的官方名称，将使用代码替代:`, err.message);
    }

    bh = { code, name: nameFromQuote, cost: 0.0, quantity: 0.0 };
    isNewHolding = true;
  }

  // 卖出不超过持仓
  if (type === 'sell' && quantity > bh['quantity']) {
    return c.json({
      error: `卖出 ${quantity} 股超过当前持仓 ${bh['quantity']} 股`
    }, 400);
  }

  // 推算成交价（原始货币）
  const isHK  = code.endsWith('.HK');
  if (isHK) await refreshFxRate();
  const fxRate = isHK ? cachedFxRate : 1.0;
  // 港股: CNY / 汇率 / 股数 = HKD 每股; A股: CNY / 股数 = CNY 每股
  const price = amountCny / fxRate / quantity;

  // 新增流水、创建新标的、回放持仓必须全部成功或全部回滚
  db.exec('BEGIN');
  try {
    const now = new Date().toISOString();
    if (isNewHolding) {
      db.prepare(`
        INSERT INTO opening_holdings (code, name, cost, quantity, created_at)
        VALUES (?, ?, 0.0, 0.0, ?)
      `).run(code, bh['name'], now);
      db.prepare(`
        INSERT INTO base_holdings (code, name, cost, quantity, updated_at)
        VALUES (?, ?, 0.0, 0.0, ?)
      `).run(code, bh['name'], now);
    }
    db.prepare(`
      INSERT INTO transactions (code, type, trade_date, price, quantity, amount_cny, fx_rate, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(code, type, tradeDate, price, quantity, amountCny, fxRate, note, now);
    replayHolding(code);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return c.json({ error: `交易写入失败: ${err.message}` }, 500);
  }

  const updated = db.prepare('SELECT * FROM base_holdings WHERE code = ?').get(code);
  console.log(`[tx] ${type} ${code} ×${quantity} @¥${amountCny} → 新成本 ${updated['cost'].toFixed(4)}, 持仓 ${updated['quantity']}`);

  return c.json({
    ok: true,
    code,
    type,
    price: Math.round(price * 10000) / 10000,
    quantity,
    amount_cny: amountCny,
    new_cost:   updated['cost'],
    new_quantity: updated['quantity'],
  });
});

/**
 * 回放重算某只股票的 base_holdings
 * 从 SQLite 期初持仓出发，按时间顺序叠加所有交易记录
 */
function replayHolding(code) {
  const opening = db.prepare('SELECT cost, quantity FROM opening_holdings WHERE code = ?').get(code);
  if (!opening) throw new Error(`${code} 缺少期初持仓记录`);
  let cost     = opening['cost'];
  let quantity = opening['quantity'];

  // 按交易日期升序回放所有交易
  const txList = db.prepare(
    'SELECT * FROM transactions WHERE code = ? ORDER BY trade_date ASC, created_at ASC'
  ).all(code);

  for (const tx of txList) {
    const txQty   = tx['quantity'];
    const txPrice = tx['price'];
    if (tx['type'] === 'buy') {
      // 加权平均成本
      const newQty  = quantity + txQty;
      cost     = newQty > 0 ? (cost * quantity + txPrice * txQty) / newQty : cost;
      quantity = newQty;
    } else {
      // 卖出：数量减少，成本不变
      quantity = Math.max(0, quantity - txQty);
    }
  }

  db.prepare(`
    UPDATE base_holdings SET cost = ?, quantity = ?, updated_at = ? WHERE code = ?
  `).run(cost, quantity, new Date().toISOString(), code);
}

/** GET /api/transactions/:code — 查询某只股票的交易历史 */
app.get('/api/transactions/:code', (c) => {
  const code = c.req.param('code').toUpperCase();
  const rows = db.prepare(
    'SELECT * FROM transactions WHERE code = ? ORDER BY trade_date DESC, created_at DESC'
  ).all(code);
  return c.json({ code, transactions: rows });
});

/** DELETE /api/transactions/:id — 撤销一笔交易（回放重算）*/
app.delete('/api/transactions/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!tx) return c.json({ error: `交易记录 #${id} 不存在` }, 404);

  const code = tx['code'];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    replayHolding(code);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return c.json({ error: `撤销失败: ${err.message}` }, 500);
  }

  const updated = db.prepare('SELECT * FROM base_holdings WHERE code = ?').get(code);
  console.log(`[tx] 撤销 #${id}，${code} 回放后: 成本 ${updated['cost'].toFixed(4)}, 持仓 ${updated['quantity']}`);

  return c.json({
    ok: true,
    deleted_id: id,
    code,
    new_cost:     updated['cost'],
    new_quantity: updated['quantity'],
  });
});

// ── 自选股 API ────────────────────────────────────────────

/** GET /api/stocks/search?q=... — 股票拼音/代码/中文智能联想搜索 */
app.get('/api/stocks/search', async (c) => {
  const q = c.req.query('q') || '';
  if (!q.trim()) return c.json({ list: [] });

  try {
    const resp = await fetch(`https://suggest3.sinajs.cn/suggest/key=${encodeURIComponent(q)}`);
    if (!resp.ok) return c.json({ list: [] });

    // 新浪接口返回的是 GBK 编码，使用 TextDecoder('gbk') 原生解码
    const arrayBuffer = await resp.arrayBuffer();
    const text = new TextDecoder('gbk').decode(arrayBuffer);
    
    const match = text.match(/var suggestvalue="([^"]*)"/);
    if (!match) return c.json({ list: [] });

    const items = match[1].split(';').filter(Boolean);
    const list = items.map(item => {
      const parts = item.split(',');
      if (parts.length < 5) return null;
      
      const type = parts[1];
      const fullCode = parts[3].toLowerCase();
      const name = parts[4];
      
      let normCode = '';
      if (type === '11') { // A股
        if (fullCode.startsWith('sz')) {
          normCode = fullCode.slice(2).toUpperCase() + '.SZ';
        } else if (fullCode.startsWith('sh')) {
          normCode = fullCode.slice(2).toUpperCase() + '.SH';
        }
      } else if (type === '31') { // 港股
        let rawNum = fullCode.startsWith('hk') ? fullCode.slice(2) : parts[2];
        if (rawNum.length === 4) {
          rawNum = '0' + rawNum;
        }
        normCode = rawNum.toUpperCase() + '.HK';
      } else {
        return null;
      }
      
      return { code: normCode, name };
    }).filter(Boolean);

    return c.json({ list });
  } catch (err) {
    console.error('Search stock error:', err);
    return c.json({ list: [] });
  }
});

/** GET /api/indices — 获取大盘指数行情（上证、深证、创业板、恒生科技） */
app.get('/api/indices', async (c) => {
  const symbols = [
    'sh000001', 'sz399001', 'sz399006', 
    'hkHSI', 'hkHSTECH', 'sh518880', 
    'sh000510', 'sh000852', 'sh000688', 'bj899050'
  ];
  try {
    const url = `https://qt.gtimg.cn/q=${symbols.join(',')}`;
    const resp = await fetch(url, {
      headers: {
        Referer: 'https://gu.qq.com/',
        'User-Agent': 'Mozilla/5.0',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return c.json({ indices: [] });

    const buf = await resp.arrayBuffer();
    const body = new TextDecoder('gbk').decode(buf);

    const result = [];
    for (const entry of body.split(';')) {
      const e = entry.trim();
      if (!e || !e.includes('="')) continue;
      const eqIdx = e.indexOf('="');
      const left = e.slice(0, eqIdx);
      const right = e.slice(eqIdx + 2).replace(/";?\s*$/, '');
      const symbol = left.split('_').pop();
      const fields = right.split('~');
      if (fields.length <= 32) continue;

      let name = fields[1].trim();
      if (symbol === 'sh518880') {
        name = '黄金基金';
      } else if (symbol === 'sh000510') {
        name = '中证A500';
      } else if (symbol === 'sh000852') {
        name = '中证1000';
      } else if (symbol === 'sh000688') {
        name = '科创50';
      } else if (symbol === 'bj899050') {
        name = '北证50';
      }
      const current = parseFloat(fields[3]) || 0;
      const changeVal = parseFloat(fields[31]) || 0;
      const changePct = parseFloat(fields[32]) || 0;

      result.push({
        symbol,
        name,
        current,
        changeVal,
        changePct,
      });
    }

    return c.json({ indices: result });
  } catch (err) {
    console.error('Fetch indices error:', err);
    return c.json({ indices: [] });
  }
});

/** GET /api/watchlist — 获取全部自选股 + 最新价格快照 */
app.get('/api/watchlist', (c) => {
  const items = db.prepare('SELECT * FROM watchlist ORDER BY sort_order ASC, created_at ASC').all();
  const holdingCodes = new Set(
    db.prepare('SELECT DISTINCT code FROM holdings').all().map(r => r['code'])
  );
  const today = new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).slice(0, 10);

  const result = items.map(item => {
    const code = item['code'];
    // 取最新快照（当日优先，否则取最近一条）
    const snap = db.prepare(
      'SELECT * FROM watchlist_price WHERE code = ? ORDER BY date DESC LIMIT 1'
    ).get(code);
    const currentPrice = snap ? snap['price'] : null;
    const prevClose   = snap ? snap['prev_close'] : null;
    const pctVsAdded  = snap ? snap['pct_vs_added'] : null;
    const dayPct = (currentPrice && prevClose && prevClose > 0)
      ? `${((currentPrice - prevClose) / prevClose * 100).toFixed(2)}%`
      : null;
    return {
      code,
      name:        item['name'],
      added_date:  item['added_date'],
      added_price: item['added_price'],
      note:        item['note'],
      current_price: currentPrice,
      prev_close:    prevClose,
      day_pct:       dayPct,
      total_pct:     pctVsAdded,
      in_holdings:   holdingCodes.has(code),
      snap_date:     snap ? snap['date'] : null,
    };
  });
  return c.json({ watchlist: result });
});

/** POST /api/watchlist — 添加自选股 */
app.post('/api/watchlist', async (c) => {
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: '请求体解析失败' }, 400); }

  const code = (body.code || '').trim().toUpperCase();
  if (!code) return c.json({ error: '证券代码不能为空' }, 400);

  // 检查是否已在持仓中
  const inHoldings = db.prepare('SELECT 1 FROM holdings WHERE code = ? LIMIT 1').get(code);
  if (inHoldings) return c.json({ error: `${code} 已在持仓中，无需重复追踪` }, 409);

  // 检查是否已在自选中
  const exists = db.prepare('SELECT 1 FROM watchlist WHERE code = ? LIMIT 1').get(code);
  if (exists) return c.json({ error: `${code} 已在自选股列表中` }, 409);

  // 拉取行情 + 名称
  let quote;
  try {
    quote = await fetchPriceWithName(sinaSymbol(code));
  } catch (err) {
    return c.json({ error: `无法获取行情: ${err.message}` }, 502);
  }

  // 名称：前端覆盖 > 行情自动获取
  const name = (body.name || '').trim() || quote.name || code;
  const note = (body.note || '').trim();
  const today = new Date().toLocaleString('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).slice(0, 10);

  // sort_order = 当前最大序号 + 1，新入尾部
  const maxOrder = db.prepare('SELECT MAX(sort_order) AS m FROM watchlist').get();
  const sortOrder = ((maxOrder && maxOrder['m']) ?? -1) + 1;

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

  console.log(`[watchlist] 添加: ${code} ${name} @${quote.current}`);
  return c.json({ ok: true, code, name, added_price: quote.current, added_date: today });
});

/** DELETE /api/watchlist/:code — 删除自选股 */
app.delete('/api/watchlist/:code', (c) => {
  const code = c.req.param('code').toUpperCase();
  const exists = db.prepare('SELECT 1 FROM watchlist WHERE code = ?').get(code);
  if (!exists) return c.json({ error: `${code} 不在自选股列表中` }, 404);
  db.prepare('DELETE FROM watchlist WHERE code = ?').run(code);
  db.prepare('DELETE FROM watchlist_price WHERE code = ?').run(code);
  console.log(`[watchlist] 删除: ${code}`);
  return c.json({ ok: true, code });
});

/** PATCH /api/watchlist/reorder — 更新排列顺序 */
app.patch('/api/watchlist/reorder', (c) => {
  let body;
  try { body = c.req.raw; } catch { return c.json({ error: '解析失败' }, 400); }
  return c.req.json().then(data => {
    const codes = Array.isArray(data.codes) ? data.codes : [];
    if (!codes.length) return c.json({ error: 'codes 不能为空' }, 400);
    const update = db.prepare('UPDATE watchlist SET sort_order = ? WHERE code = ?');
    db.exec('BEGIN');
    try {
      codes.forEach((code, idx) => update.run(idx, code.toUpperCase()));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      return c.json({ error: e.message }, 500);
    }
    return c.json({ ok: true });
  }).catch(() => c.json({ error: '请求体无法解析' }, 400));
});

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
refreshHoldings().catch(err => console.error('[startup] 初次抓取失败:', err.message));

// ── 启动服务器 ────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 8123;
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`\n✅ 持仓明细服务已启动`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   数据库: ${DB_PATH}`);
  console.log(`   定时抓取: 每 ${INTERVAL_MS / 60000} 分钟（交易时段）\n`);
});
