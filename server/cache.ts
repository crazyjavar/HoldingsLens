/** 独立缓存：合并并发请求，刷新失败保留有效值，辅助数据支持后台刷新。 */
export function createCachedResource<T>(name: string, load: () => Promise<T>, fallback: T) {
  let value = fallback;
  let hasValue = false;
  let fetchedAt = 0;
  let valueKey = '';
  let retryAt = 0;
  let pending: Promise<T> | null = null;

  return async (ttl: number, key: string, waitForFresh = false): Promise<T> => {
    const now = Date.now();
    if (hasValue && valueKey === key && now - fetchedAt < ttl) return value;
    if (!pending && now >= retryAt) {
      pending = Promise.resolve().then(load).then(result => {
        value = result;
        hasValue = true;
        valueKey = key;
        fetchedAt = Date.now();
        retryAt = 0;
        return value;
      }).catch((err: unknown) => {
        // 失败不更新成功时间，短暂退避避免每次请求都重试失败的数据源。
        retryAt = Date.now() + 30_000;
        console.warn(`[${name}] 抓取失败，保留最近有效缓存: ${(err as Error).message}`);
        return value;
      }).finally(() => { pending = null; });
    }
    // 冷启动、跨日和实时行情等待本次结果；已有辅助缓存则直接返回。
    if (pending && (!hasValue || valueKey !== key || waitForFresh)) return pending;
    return value;
  };
}
