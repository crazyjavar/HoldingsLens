/**
 * node:sqlite 类型声明
 * 保留项目使用的泛型查询接口；Bun 通过 Node 兼容层运行此模块。
 * 行类型由调用方指定，运行时仍执行原有 SQLite SQL。
 */
declare module 'node:sqlite' {
  export interface RunResult {
    /** 受影响的行数 */
    changes: number;
    /** 最后插入行的 ROWID */
    lastInsertRowid: number | bigint;
  }

  export class StatementSync<T = Record<string, unknown>> {
    /** 执行语句并返回第一行结果，无结果返回 undefined */
    get(...params: unknown[]): T | undefined;
    /** 执行语句并返回所有结果行 */
    all(...params: unknown[]): T[];
    /** 执行语句（INSERT/UPDATE/DELETE 等）并返回执行结果 */
    run(...params: unknown[]): RunResult;
  }

  export class DatabaseSync {
    constructor(path: string);
    /** 执行一条或多条 SQL 语句（不返回结果） */
    exec(sql: string): void;
    /** 编译 SQL 语句为可复用的 Prepared Statement */
    prepare<T = Record<string, unknown>>(sql: string): StatementSync<T>;
    /** 关闭数据库连接 */
    close(): void;
  }
}
