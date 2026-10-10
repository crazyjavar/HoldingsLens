/** 独立缓存：合并并发请求，刷新失败保留有效值，辅助数据支持后台刷新。 */
export declare function createCachedResource<T>(name: string, load: () => Promise<T>, fallback: T): (ttl: number, key: string, waitForFresh?: boolean) => Promise<T>;
