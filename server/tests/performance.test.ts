import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCachedResource } from '../cache.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('缓存合并请求、后台更新、失败保留和跨日刷新', async () => {
  const originalNow = Date.now;
  let time = originalNow();
  Date.now = () => time;
  try {
    let calls = 0;
    let resolve!: (value: number) => void;
    let reject!: (reason: Error) => void;
    const get = createCachedResource('test', () => {
      calls++;
      return new Promise<number>((res, rej) => { resolve = res; reject = rej; });
    }, 0);
    const first = get(1000, 'day1');
    const concurrent = get(1000, 'day1');
    await tick();
    assert.equal(calls, 1);
    resolve(10);
    assert.deepEqual(await Promise.all([first, concurrent]), [10, 10]);
    assert.equal(await get(1000, 'day1'), 10);
    time += 1001;
    assert.equal(await get(1000, 'day1'), 10);
    await tick();
    assert.equal(calls, 2);
    resolve(20);
    await tick();
    assert.equal(await get(1000, 'day1'), 20);
    time += 1001;
    assert.equal(await get(1000, 'day1'), 20);
    await tick();
    reject(new Error('模拟断网'));
    await tick();
    assert.equal(await get(1000, 'day1'), 20);
    assert.equal(calls, 3);
    time += 30001;
    const nextDay = get(1000, 'day2');
    await tick();
    resolve(30);
    assert.equal(await nextDay, 30);
  } finally { Date.now = originalNow; }
});

test('最近交易单次查询，指数辅助刷新不阻塞有效实时行情', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'holdings-performance-'));
  const previousPath = process.env.HOLDINGS_DB_PATH;
  process.env.HOLDINGS_DB_PATH = join(folder, 'test.db');
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  let time = originalNow();
  Date.now = () => time;
  const { db, beijingParts } = await import('../db.js');
  try {
    const { default: tx } = await import('../routes/transactions.js');
    const insert = db.prepare(`INSERT INTO transactions
      (code,type,trade_date,price,quantity,amount_cny,fx_rate,note,created_at)
      VALUES (?,'buy','2026-10-09',1,1,1,1,'test','2026-10-09')`);
    for (let i = 0; i < 60; i++) insert.run(i % 2 ? '03690.HK' : '512170.SH');
    const result = await (await tx.request('/?limit=50')).json();
    assert.equal(result.transactions.length, 50);
    assert.deepEqual(result.transactions.map((row: { id: number }) => row.id),
      Array.from({ length: 50 }, (_, i) => 60 - i));
    assert.ok(result.transactions.every((row: { name: string; code: string }) => row.name && row.name !== row.code));
    assert.equal((await (await tx.request('/?limit=bad')).json()).transactions.length, 50);
    assert.equal((await (await tx.request('/?limit=1')).json()).transactions.length, 1);
    assert.equal((await tx.request('/03690.HK')).status, 200);

    let liveCalls = 0, goldCalls = 0, klineCalls = 0;
    let finishGold!: (response: Response) => void;
    let finishKlines: ((response: Response) => void)[] = [];
    const p = beijingParts();
    const previousMonth = new Date(Date.UTC(p.year, p.month - 2, 1)).toISOString().slice(0, 7);
    const currentMonth = `${p.year}-${String(p.month).padStart(2, '0')}`;
    const klines = [{ day: `${previousMonth}-28`, open: '100', close: '100' },
      { day: `${currentMonth}-01`, open: '100', close: '110' }];
    const klineResponse = () => Response.json(klines);
    const goldResponse = () => new Response('var hq_str_SGE_AU9999="gold,0,0,700,0,0,0,0,0,690";');
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes('getKLineData')) {
        klineCalls++;
        if (klineCalls > 3) return new Promise<Response>(resolve => finishKlines.push(resolve));
        return klineResponse();
      }
      if (url.includes('SGE_AU9999')) {
        goldCalls++;
        if (goldCalls > 1) return new Promise<Response>(resolve => { finishGold = resolve; });
        return goldResponse();
      }
      liveCalls++;
      return new Response(['sh000001','sz399001','sz399006'].map(sym => {
        const fields = Array(33).fill('0'); fields[1] = sym; fields[3] = '110'; fields[31] = '10'; fields[32] = '10';
        return `v_${sym}="${fields.join('~')}";`;
      }).join('\n'));
    }) as typeof fetch;
    const { default: indices } = await import('../routes/indices.js');
    const first = await (await indices.request('/')).json();
    assert.equal(first.indices.length, 4);
    assert.equal(first.month_change.sh000001, 10);
    assert.deepEqual([liveCalls, goldCalls, klineCalls], [1, 1, 3]);
    // 超过所有缓存 TTL，让辅助数据保持未完成；API 必须仍能立即返回。
    time += 3_600_001;
    let timeout: ReturnType<typeof setTimeout>;
    const second = await Promise.race([
      Promise.resolve(indices.request('/')).then(response => response.json()),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('辅助请求阻塞了 API')), 500); })
    ]).finally(() => clearTimeout(timeout!));
    assert.equal(second.indices.length, 4);
    assert.equal(second.month_change.sh000001, 10);
    assert.deepEqual([liveCalls, goldCalls, klineCalls], [2, 2, 6]);
    await indices.request('/');
    assert.deepEqual([liveCalls, goldCalls, klineCalls], [2, 2, 6]);
    finishGold(goldResponse()); finishKlines.forEach(resolve => resolve(klineResponse()));
    await tick();
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    db.close();
    if (previousPath === undefined) delete process.env.HOLDINGS_DB_PATH;
    else process.env.HOLDINGS_DB_PATH = previousPath;
    rmSync(folder, { recursive: true, force: true });
  }
});
