/**
 * fetcher.ts — 行情抓取模块
 * 移植自 update_holdings.py，使用 Node 内置 fetch
 * 支持腾讯行情（主）和新浪行情（备用）
 */
import type { QuoteResult, FxRateResult } from './types.js';
/**
 * 将证券代码转换为新浪格式（如 512170.SH → sh512170）
 */
export declare function sinaSymbol(code: string): string;
/**
 * 拉取行情：股票走腾讯主/新浪备；公募基金走新浪实时估值主/腾讯备
 * @param symbols - 新浪格式的证券符号列表
 * @returns Promise<Record<string, QuoteResult>>
 */
export declare function fetchPrices(symbols: string[]): Promise<Record<string, QuoteResult>>;
/**
 * 获取最新 HKD → CNY 参考汇率。
 * Frankfurter 提供无需 API Key 的央行参考汇率聚合接口。
 */
export declare function fetchHkdCnyRate(): Promise<FxRateResult>;
/**
 * 拉取单只证券行情，包含标的名称（自选股添加专用）
 * @param symbol - 新浪格式符号（如 sh600036、of002708）
 * @returns Promise<QuoteResult>
 */
export declare function fetchPriceWithName(symbol: string): Promise<QuoteResult>;
