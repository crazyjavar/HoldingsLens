/**
 * types.ts — 持仓服务核心类型定义
 * 涵盖数据库表行类型、外部行情接口类型、API 响应类型。
 */
/** 期初持仓（不可变的基线数据） */
export interface OpeningHolding {
    code: string;
    name: string;
    cost: number;
    quantity: number;
    created_at: string;
}
/** 当前持仓基础数据（经交易回放计算得到） */
export interface BaseHolding {
    code: string;
    name: string;
    cost: number;
    quantity: number;
    updated_at: string;
}
/** 每日持仓快照行 */
export interface HoldingRow {
    id: number;
    date: string;
    code: string;
    name: string;
    market: number;
    cost: number;
    prev_close: number;
    price: number;
    quantity: number;
    day_pnl: number;
    day_pnl_pct: string;
    total_pnl: number;
    total_pnl_pct: string;
    weight: string;
    change_pct: string;
}
/** 每日组合汇总 */
export interface DailySummary {
    date: string;
    total_market: number;
    total_day_pnl: number;
    total_day_pct: string;
    total_pnl: number;
    total_pnl_pct: string;
    updated_at: string;
}
/** 交易流水 */
export interface Transaction {
    id: number;
    code: string;
    type: string;
    trade_date: string;
    price: number;
    quantity: number;
    amount_cny: number;
    fx_rate: number;
    note: string;
    created_at: string;
}
/** 自选股元数据 */
export interface WatchlistItem {
    id: number;
    code: string;
    name: string;
    added_date: string;
    added_price: number;
    note: string;
    sort_order: number;
    created_at: string;
}
/** 自选股每日价格快照 */
export interface WatchlistPrice {
    id: number;
    code: string;
    date: string;
    price: number;
    prev_close: number;
    pct_vs_added: string;
}
/** 应用元数据（如汇率缓存） */
export interface AppMetadata {
    key: string;
    value: string;
    updated_at: string;
}
/** 行情查询结果（单只证券） */
export interface QuoteResult {
    current: number;
    previousClose: number;
    lastTradeDate: string | null;
    name?: string;
}
/** 汇率查询结果 */
export interface FxRateResult {
    rate: number;
    date: string | null;
    source: string;
    fallback?: boolean;
}
/** 行情刷新结果 */
export interface RefreshResult {
    ok?: boolean;
    skipped?: boolean;
    reason?: string;
    error?: string;
    date?: string;
    count?: number;
    quoteDates?: string[];
}
/** 种子持仓条目 */
export interface SeedHolding {
    code: string;
    name: string;
    cost: number;
    quantity: number;
}
/** 大盘指数条目 */
export interface IndexItem {
    symbol: string;
    name: string;
    current: number;
    changeVal: number;
    changePct: number;
}
/** 大盘指数 API 响应 */
export interface IndicesData {
    indices: IndexItem[];
    month_change: Record<string, number>;
}
/** 简易计数行（用于 COUNT(*) 查询） */
export interface CountRow {
    n: number;
}
/** 简易求和行（用于 SUM() 查询） */
export interface SumRow {
    [key: string]: number | null;
}
/** 日 K 线数据行（新浪 K 线接口返回） */
export interface KlineRow {
    day: string;
    open: string;
    close: string;
    high: string;
    low: string;
    volume: string;
}
/** 构建中的持仓快照行（写入 holdings 表前的中间结构） */
export interface HoldingSnapshotRow {
    date: string;
    code: string;
    name: string;
    market: number;
    cost: number;
    prev_close: number;
    price: number;
    quantity: number;
    day_pnl: number;
    day_pnl_pct: string;
    total_pnl: number;
    total_pnl_pct: string;
    weight: string | null;
    change_pct: string;
}
