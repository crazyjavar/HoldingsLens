import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// 执行实际加载函数，替换网络和渲染边界；不访问用户服务或数据库。
function loader(file: string, start: string, end: string, context: Record<string, unknown>, name: string) {
  const source = readFileSync(new URL(`../../public/js/${file}`, import.meta.url), 'utf8');
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin);
  assert.ok(begin >= 0 && finish > begin);
  const sandbox = createContext(context);
  runInContext(source.slice(begin, finish).replace(/export /g, '') + `\nglobalThis.run = ${name};`, sandbox);
  return sandbox.run as (silent?: boolean, force?: boolean) => Promise<void>;
}

test('持仓跳过相同数据与时间戳更新，周战报状态变化仍渲染', async () => {
  let payload = { holdings: [{ code: '512170.SH', name: 'ETF', market: 100, price: 1, quantity: 100 }],
    summary: { total_market: 100, updated_at: 'first', week_report_ready: false } };
  let renders = 0;
  const state = {};
  const run = loader('rendering.js', 'let latestRenderSnapshot', '// ── KPI', {
    state, fetch: async () => Response.json(payload), render: () => renders++,
    document: { getElementById: () => ({ textContent: '' }) },
    toNum: (v: unknown) => Number(v) || 0, classify: () => 'ETF'
  }, 'loadLatest');
  await run();
  for (let i = 0; i < 10; i++) await run();
  assert.equal(renders, 1);
  payload.summary.updated_at = 'second'; await run(); assert.equal(renders, 1);
  payload.summary.week_report_ready = true; await run(); assert.equal(renders, 2);
  payload.holdings[0].price = 2; await run(); assert.equal(renders, 3);
  await run(false, true); assert.equal(renders, 4);
});

test('历史相同数据跳过渲染，变化、清空、CDN恢复正常更新', async () => {
  let history = [{ date: '2026-10-09', total_day_pnl: 10 }];
  let renders = 0;
  const context: Record<string, unknown> = {
    state: {}, fetch: async () => Response.json({ history }),
    renderHistoryChart: () => renders++, echarts: {}
  };
  const run = loader('history.js', 'let historyRenderSnapshot', '// ── 历史趋势图渲染', context, 'loadHistory');
  await run(); for (let i = 0; i < 10; i++) await run(); assert.equal(renders, 1);
  history[0].total_day_pnl = 20; await run(); assert.equal(renders, 2);
  history = []; await run(); assert.equal(renders, 3);
  delete context.echarts; await run(); assert.equal(renders, 4);
  context.echarts = {}; await run(); assert.equal(renders, 5);
});

test('自选相同列表跳过渲染，价格与拖拽顺序变化触发更新', async () => {
  let list = [{ code: 'A', current_price: 1 }, { code: 'B', current_price: 2 }];
  let renders = 0;
  const context: Record<string, unknown> = { wlList: [], fetch: async () => Response.json({ watchlist: list }) };
  context.renderWatchlist = (next: unknown) => { context.wlList = next; renders++; };
  const run = loader('watchlist.js', 'let watchlistLoaded', 'function pctBadgeValueOnly', context, 'loadWatchlist');
  await run(); for (let i = 0; i < 10; i++) await run(); assert.equal(renders, 1);
  list[0].current_price = 3; await run(); assert.equal(renders, 2);
  context.wlList = [...context.wlList as unknown[]].reverse();
  await run(); assert.equal(renders, 3);
});

test('指数相同数据跳过 DOM 更新，月收益变化仍更新', async () => {
  let changes = 0, comparisons = 0;
  const indexBar = { set innerHTML(_: string) { changes++; } };
  let payload = { indices: [{ name: 'Index', current: 100, changeVal: 1, changePct: 1 }], month_change: { sh000001: 1 } };
  const run = loader('indices.js', 'let indicesRenderSnapshot', '// ── 渲染跑赢', {
    state: {}, fetch: async () => Response.json(payload),
    document: { getElementById: () => indexBar }, escapeHtml: (v: string) => v,
    renderComparePanel: () => comparisons++, console
  }, 'loadIndices');
  await run(); for (let i = 0; i < 10; i++) await run();
  assert.equal(changes, 1); assert.equal(comparisons, 1);
  payload.month_change.sh000001 = 2; await run();
  assert.equal(changes, 2); assert.equal(comparisons, 2);
});
