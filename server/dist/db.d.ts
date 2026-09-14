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
import type { FxRateResult, SeedHolding } from './types.js';
export declare const ROOT: string;
export declare const DB_PATH: string;
export declare const db: DatabaseSync;
export declare const SEED_HOLDINGS: SeedHolding[];
export declare function getFxRate(): number;
export declare function getFxDate(): string | null;
export declare function refreshFxRate(): Promise<FxRateResult & {
    fallback: boolean;
}>;
/**
 * 将证券代码格式（如 512170.SH）转换为行情符号（sh512170）
 */
export declare function toSymbol(code: string): string;
/**
 * 北京时间工具。Asia/Shanghai 全年固定 UTC+8（无夏令时），
 * 因此用 Date 的 UTC 字段承载北京时间墙钟，避免依赖服务器本地时区，
 * 以及 \`new Date(toLocaleString(...))\` 对本地化字符串的反向解析。
 */
export declare function beijingParts(date?: Date): {
    year: number;
    month: number;
    date: number;
    day: number;
    hours: number;
    minutes: number;
    seconds: number;
};
/** 北京时间日期字符串 YYYY-MM-DD */
export declare function beijingDate(date?: Date): string;
/**
 * 判断当前是否在交易时段（工作日 9:25-15:05）
 */
export declare function isTradingHours(): boolean;
