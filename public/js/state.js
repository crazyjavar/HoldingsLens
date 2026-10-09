// ── 状态 ────────────────────────────────────────────────
export const state = {
  holdings: [],
  summary: null,
  filter: 'all',
  search: '',
  sort: 'weight-desc',
  expandedHoldingCode: null, // 当前展开交易记录的持仓股票代码
  // 使用足够大的数值保持与旧版后端兼容：旧版会截断为 365，新版可返回完整多年数据。
  historyDays: 5000,
  historyGranularity: 'day',
  historyPnlMode: 'amt',
  historyViewMode: 'calendar',
  historyData: null,
  comparePeriod: 'day',
  indicesMonthChange: null,
  indicesLive: [],
  hideValues: false,
  effectMode: 'daily',
  weekModeInitialized: false,
  prevValues: {
    totalMarket: 0,
    totalPnl: 0,
    totalPnlRate: 0,
    dayPnl: 0,
    dayPnlRate: 0,
    monthPnl: 0,
    monthPnlRate: 0,
    topWeight: 0,
    top4Weight: 0
  }
};
