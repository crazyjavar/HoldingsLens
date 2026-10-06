/**
 * db.ts — 数据库与基础功能
 * 技术栈：node:sqlite（Node 22.5+）
 * 功能：
 *   1. SQLite 初始化（db 实例、PRAGMA）
 *   2. 表结构创建（8张表 + 3个索引）
 *   3. 种子数据初始化
 *   4. 汇率缓存管理
 *   5. 工具函数
 */

import { DatabaseSync } from 'node:sqlite';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchHkdCnyRate, sinaSymbol } from './fetcher.js';

import type { BaseHolding, AppMetadata, FxRateResult, SeedHolding, CountRow } from './types.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
export const ROOT = basename(currentDir) === 'dist'
  ? resolve(currentDir, '../..')
  : resolve(currentDir, '..');

// ── SQLite 初始化 ─────────────────────────────────────────
export const DB_PATH = process.env.HOLDINGS_DB_PATH
  ? resolve(process.env.HOLDINGS_DB_PATH)
  : resolve(ROOT, 'holdings.db');
console.log(`[init] 使用 SQLite 数据库: ${DB_PATH}`);
export const db = new DatabaseSync(DB_PATH);

// 优化 SQLite 运行性能与并发模式
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
`);

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

  -- 补齐高频查询索引
  CREATE INDEX IF NOT EXISTS idx_transactions_code ON transactions(code);
  CREATE INDEX IF NOT EXISTS idx_holdings_code_date ON holdings(code, date);
  CREATE INDEX IF NOT EXISTS idx_watchlist_price_code_date ON watchlist_price(code, date);
`);

// ── 持仓基础数据种子（仅用于首次初始化 base_holdings 表）────
// 后续所有修改通过 /api/transactions 完成，此处不再参与计算
export const SEED_HOLDINGS: SeedHolding[] = [
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
  const count = db.prepare<CountRow>('SELECT COUNT(*) AS n FROM base_holdings').get();
  if (!count || count.n === 0) {
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
  const count = db.prepare<CountRow>('SELECT COUNT(*) AS n FROM opening_holdings').get();
  if (!count || count.n === 0) {
    const bases = db.prepare<BaseHolding>('SELECT * FROM base_holdings').all();
    const txCountStmt = db.prepare<CountRow>('SELECT COUNT(*) AS n FROM transactions WHERE code = ?');
    const insert = db.prepare(`
      INSERT INTO opening_holdings (code, name, cost, quantity, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const now = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const h of bases) {
        const seed = SEED_HOLDINGS.find(item => item.code === h.code);
        const txCountRow = txCountStmt.get(h.code);
        const txCount = txCountRow?.n ?? 0;
        const opening = seed || (txCount === 0
          ? { cost: h.cost, quantity: h.quantity }
          : { cost: 0, quantity: 0 });
        insert.run(h.code, h.name, opening.cost, opening.quantity, now);
      }
      db.exec('COMMIT');
      console.log('[init] opening_holdings 期初持仓已迁移到 SQLite');
    } catch (err: unknown) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

// ── HKD → CNY 参考汇率（远程真实汇率 + SQLite 最近成功值降级）──
const storedFxRate = db.prepare<AppMetadata>("SELECT value FROM app_metadata WHERE key = 'hkd_cny_rate'").get();
let cachedFxRate: number = Number(storedFxRate?.value) || 0.9148;
let cachedFxDate: string | null = db.prepare<AppMetadata>("SELECT value FROM app_metadata WHERE key = 'hkd_cny_date'").get()?.value || null;

export function getFxRate(): number { return cachedFxRate; }
export function getFxDate(): string | null { return cachedFxDate; }

export async function refreshFxRate(): Promise<FxRateResult & { fallback: boolean }> {
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
  } catch (err: unknown) {
    console.warn(`[fx] 真实汇率获取失败，使用最近成功值 ${cachedFxRate}: ${(err as Error).message}`);
    return { rate: cachedFxRate, date: cachedFxDate, source: 'cache', fallback: true };
  }
}

/**
 * 将证券代码格式（如 512170.SH）转换为行情符号（sh512170）
 */
export function toSymbol(code: string): string {
  return sinaSymbol(code);
}

/**
 * 北京时间工具。Asia/Shanghai 全年固定 UTC+8（无夏令时），
 * 因此用 Date 的 UTC 字段承载北京时间墙钟，避免依赖服务器本地时区，
 * 以及 \`new Date(toLocaleString(...))\` 对本地化字符串的反向解析。
 */
export function beijingParts(date: Date = new Date()) {
  const t = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return {
    year:    t.getUTCFullYear(),
    month:   t.getUTCMonth() + 1,
    date:    t.getUTCDate(),
    day:     t.getUTCDay(), // 0=周日, 6=周六
    hours:   t.getUTCHours(),
    minutes: t.getUTCMinutes(),
    seconds: t.getUTCSeconds(),
  };
}

/** 北京时间日期字符串 YYYY-MM-DD */
export function beijingDate(date: Date = new Date()): string {
  const p = beijingParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.date).padStart(2, '0')}`;
}

/**
 * 判断当前是否在交易时段（工作日 9:25 - 16:10，同时覆盖 A 股与港股交易时段）
 */
export function isTradingHours(): boolean {
  const p = beijingParts();
  if (p.day === 0 || p.day === 6) return false;
  const total = p.hours * 60 + p.minutes;
  return total >= 9 * 60 + 25 && total <= 16 * 60 + 10;
}
