// ── KPI / 仓位结构 / 表格渲染与持仓数据加载 ──────────────────
import { state } from './state.js';
import {
  toNum, formatPercent, formatDayPercent, moneyFormatter,
  priceFormatter, numberFormatter, escapeHtml, classify
} from './utils.js';
import { animateNumericKpi, renderEffect } from './effects.js';
import { renderComparePanel } from './indices.js';

let latestRenderSnapshot = null;

export async function loadLatest(isSilent = false, forceRender = false) {
  const resp = await fetch('/api/holdings/latest');
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();

  const holdings = (data.holdings || []).map(row => ({
    date:        row.date,
    name:        row.name,
    code:        row.code,
    marketValue: row.market,
    costPrice:   row.code.endsWith('.HK') ? (row.cost_hkd ?? '-') : (row.cost ?? '-'),
    previousClose: row.prev_close ?? '-',
    currentPrice: row.price,
    quantity:    row.quantity,
    dayPnl:      row.day_pnl ?? 0,
    dayPnlRate:  toNum(row.day_pnl_pct),
    pnl:         row.total_pnl ?? 0,
    pnlRate:     toNum(row.total_pnl_pct),
    weight:      toNum(row.weight),
    category:    classify(row.name, row.code),
    change:      row.change_pct || '-',
  }));

  // updated_at 只是抓取时间；周战报可用状态等展示字段仍参与比较。
  const { updated_at, ...summaryFields } = data.summary || {};
  const snapshot = JSON.stringify([holdings, data.summary ? summaryFields : null]);
  state.summary = data.summary;
  if (!forceRender && snapshot === latestRenderSnapshot) return;
  state.holdings = holdings;
  document.getElementById('sourceState').textContent = 'API 实时数据';
  render(isSilent);
  latestRenderSnapshot = snapshot;
}

// ── KPI 渲染 ──────────────────────────────────────────────
function renderKpis(isSilent = false) {
  const h = state.holdings;
  const s = state.summary;

  const totalMarket  = s ? s.total_market  : h.reduce((a, x) => a + x.marketValue, 0);
  const totalDayPnl  = s ? s.total_day_pnl : h.reduce((a, x) => a + x.dayPnl, 0);
  const totalDayRate = s ? toNum(s.total_day_pct) : 0;
  const totalPnl     = s ? s.total_pnl     : h.reduce((a, x) => a + x.pnl, 0);
  const totalRate    = s ? toNum(s.total_pnl_pct) : 0;

  const sorted = [...h].sort((a, b) => b.weight - a.weight);
  const top    = sorted[0] || { weight: 0, name: '-' };
  const top4   = sorted.slice(0, 4).reduce((a, x) => a + x.weight, 0);
  const gains  = h.filter(x => x.pnl >= 0).length;

  // 如果是隐藏数值模式
  if (state.hideValues) {
    document.getElementById('totalMarket').textContent = '¥****';
    
    const pnlEl = document.getElementById('totalPnl');
    pnlEl.textContent = '¥****';
    pnlEl.className   = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('totalPnlRate').textContent = `组合收益率 ${formatPercent(totalRate)}`;

    const dayEl = document.getElementById('dayPnl');
    dayEl.textContent = '¥****';
    dayEl.className   = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('dayPnlRate').textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;

    const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
    const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
    const monthEl = document.getElementById('monthPnl');
    monthEl.textContent = '¥****';
    monthEl.className   = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('monthPnlRate').textContent = `本月累计 ${formatPercent(monthPnlRate)}`;

    document.getElementById('topWeight').textContent  = formatPercent(top.weight);
    const top4El = document.getElementById('top4Weight') || document.getElementById('top3Weight');
    if (top4El) top4El.textContent = formatPercent(top4);

    // 持仓明细 4 大核心指标脱敏
    const pfMarketEl = document.getElementById('pfTotalMarket');
    if (pfMarketEl) pfMarketEl.textContent = '¥****';

    const pfPnlEl = document.getElementById('pfTotalPnl');
    if (pfPnlEl) {
      pfPnlEl.textContent = '¥****';
      pfPnlEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    }

    const pfRateEl = document.getElementById('pfTotalRate');
    if (pfRateEl) {
      pfRateEl.textContent = `${totalRate >= 0 ? '+' : ''}${formatPercent(totalRate)}`;
      pfRateEl.className = `kpi-value ${totalRate >= 0 ? 'positive' : 'negative'}`;
    }

    const pfDayEl = document.getElementById('pfDayPnl');
    if (pfDayEl) {
      pfDayEl.textContent = '¥****';
      pfDayEl.className = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    }
    const pfDayRateEl = document.getElementById('pfDayPnlRate');
    if (pfDayRateEl) {
      pfDayRateEl.textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;
    }
  } else if (isSilent) {
    // 如果是静默更新
    document.getElementById('totalMarket').textContent = moneyFormatter.format(totalMarket);
    
    const pnlEl = document.getElementById('totalPnl');
    pnlEl.textContent = moneyFormatter.format(totalPnl);
    pnlEl.className   = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('totalPnlRate').textContent = `组合收益率 ${formatPercent(totalRate)}`;

    const dayEl = document.getElementById('dayPnl');
    dayEl.textContent = moneyFormatter.format(totalDayPnl);
    dayEl.className   = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('dayPnlRate').textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;

    const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
    const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
    const monthEl = document.getElementById('monthPnl');
    monthEl.textContent = moneyFormatter.format(monthPnl);
    monthEl.className   = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
    document.getElementById('monthPnlRate').textContent = `本月累计 ${formatPercent(monthPnlRate)}`;

    document.getElementById('topWeight').textContent  = formatPercent(top.weight);
    const top4El = document.getElementById('top4Weight') || document.getElementById('top3Weight');
    if (top4El) top4El.textContent = formatPercent(top4);

    // 持仓明细 4 大核心指标静默渲染
    const pfMarketEl = document.getElementById('pfTotalMarket');
    if (pfMarketEl) pfMarketEl.textContent = moneyFormatter.format(totalMarket);

    const pfPnlEl = document.getElementById('pfTotalPnl');
    if (pfPnlEl) {
      pfPnlEl.textContent = moneyFormatter.format(totalPnl);
      pfPnlEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    }

    const pfRateEl = document.getElementById('pfTotalRate');
    if (pfRateEl) {
      pfRateEl.textContent = `${totalRate >= 0 ? '+' : ''}${formatPercent(totalRate)}`;
      pfRateEl.className = `kpi-value ${totalRate >= 0 ? 'positive' : 'negative'}`;
    }

    const pfDayEl = document.getElementById('pfDayPnl');
    if (pfDayEl) {
      pfDayEl.textContent = moneyFormatter.format(totalDayPnl);
      pfDayEl.className = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    }
    const pfDayRateEl = document.getElementById('pfDayPnlRate');
    if (pfDayRateEl) {
      pfDayRateEl.textContent = `相对昨收 ${formatDayPercent(totalDayRate)}`;
    }
  } else {
    // 使用 GSAP 数字滚动动画
    const prev = state.prevValues || {
      totalMarket: 0, totalPnl: 0, totalPnlRate: 0,
      dayPnl: 0, dayPnlRate: 0, monthPnl: 0, monthPnlRate: 0,
      topWeight: 0, top4Weight: 0,
      pfTotalMarket: 0, pfTotalPnl: 0, pfTotalRate: 0,
      pfDayPnl: 0, pfDayPnlRate: 0
    };
    
    animateNumericKpi('totalMarket', totalMarket, prev.totalMarket);
    
    const pnlEl = document.getElementById('totalPnl');
    pnlEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('totalPnl', totalPnl, prev.totalPnl);
    animateNumericKpi('totalPnlRate', totalRate, prev.totalPnlRate, true, '组合收益率 ');

    const dayEl = document.getElementById('dayPnl');
    dayEl.className = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('dayPnl', totalDayPnl, prev.dayPnl);
    animateNumericKpi('dayPnlRate', totalDayRate, prev.dayPnlRate, true, '相对昨收 ', true);

    const monthPnl     = s ? (s.month_pnl ?? 0) : 0;
    const monthPnlRate = s ? toNum(s.month_pnl_pct) : 0;
    const monthEl = document.getElementById('monthPnl');
    monthEl.className = `kpi-value ${monthPnl >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('monthPnl', monthPnl, prev.monthPnl);
    animateNumericKpi('monthPnlRate', monthPnlRate, prev.monthPnlRate, true, '本月累计 ');

    animateNumericKpi('topWeight', top.weight, prev.topWeight, true);
    animateNumericKpi('top4Weight', top4, prev.top4Weight ?? prev.top3Weight ?? 0, true);

    // 持仓明细 4 大核心指标动画
    animateNumericKpi('pfTotalMarket', totalMarket, prev.pfTotalMarket ?? prev.totalMarket);

    const pfPnlEl = document.getElementById('pfTotalPnl');
    if (pfPnlEl) pfPnlEl.className = `kpi-value ${totalPnl >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('pfTotalPnl', totalPnl, prev.pfTotalPnl ?? prev.totalPnl);

    const pfRateEl = document.getElementById('pfTotalRate');
    if (pfRateEl) pfRateEl.className = `kpi-value ${totalRate >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('pfTotalRate', totalRate, prev.pfTotalRate ?? prev.totalPnlRate, true, totalRate >= 0 ? '+' : '');

    const pfDayEl = document.getElementById('pfDayPnl');
    if (pfDayEl) pfDayEl.className = `kpi-value ${totalDayPnl >= 0 ? 'positive' : 'negative'}`;
    animateNumericKpi('pfDayPnl', totalDayPnl, prev.pfDayPnl ?? prev.dayPnl);
    animateNumericKpi('pfDayPnlRate', totalDayRate, prev.pfDayPnlRate ?? prev.dayPnlRate, true, '相对昨收 ', true);
  }

  // 无论静默与否，直接渲染非数字滚动内容及保存状态
  document.getElementById('holdingCount').textContent = `${h.length} 个持仓标的`;
  document.getElementById('topHolding').textContent = top.name;
  const gainEl = document.getElementById('gainCount');
  if (gainEl) gainEl.textContent = `${gains} 个`;
  const lossEl = document.getElementById('lossCount');
  if (lossEl) lossEl.textContent = `${h.length - gains} 个`;

  const pfCountEl = document.getElementById('pfHoldingCount');
  if (pfCountEl) pfCountEl.textContent = `${h.length} 个持仓标的`;

  const pfPnlFootEl = document.getElementById('pfPnlFoot');
  if (pfPnlFootEl) pfPnlFootEl.textContent = `${gains} 只盈利 / ${h.length - gains} 只亏损`;

  const date = h[0]?.date || '--';
  document.getElementById('asOf').textContent    = date;
  document.getElementById('subtitle').textContent = state.hideValues ?
    `截至 ${date}，组合总市值 ****，当日盈亏 ****，累计盈亏 ****。` :
    `截至 ${date}，组合总市值 ${moneyFormatter.format(totalMarket)}，当日盈亏 ${moneyFormatter.format(totalDayPnl)}，累计盈亏 ${moneyFormatter.format(totalPnl)}。`;

  // 保存本次的值供下次作为起点
  state.prevValues = {
    totalMarket,
    totalPnl,
    totalPnlRate: totalRate,
    dayPnl: totalDayPnl,
    dayPnlRate: totalDayRate,
    monthPnl: s ? (s.month_pnl ?? 0) : 0,
    monthPnlRate: s ? toNum(s.month_pnl_pct) : 0,
    topWeight: top.weight,
    top4Weight: top4,
    pfTotalMarket: totalMarket,
    pfTotalPnl: totalPnl,
    pfTotalRate: totalRate,
    pfDayPnl: totalDayPnl,
    pfDayPnlRate: totalDayRate,
  };

  renderEffect(totalRate, totalDayPnl, s);
  renderComparePanel();
}

// ── 仓位结构渲染 ──────────────────────────────────────────
function renderAllocation() {
  const max = Math.max(...state.holdings.map(x => x.weight), 1);
  document.getElementById('allocationList').innerHTML = [...state.holdings]
    .sort((a, b) => b.weight - a.weight)
    .map(x => `
      <div class="bar-row">
        <div class="bar-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
        <div class="track"><div class="fill" style="width:${(x.weight / max * 100).toFixed(2)}%"></div></div>
        <div class="bar-value">${formatPercent(x.weight)}</div>
      </div>`).join('');
}

// ── 盈亏分布渲染 ──────────────────────────────────────────
function renderPnl() {
  const maxAbs = Math.max(...state.holdings.map(x => Math.abs(x.pnl)), 1);
  document.getElementById('pnlList').innerHTML = [...state.holdings]
    .sort((a, b) => a.pnl - b.pnl)
    .map(x => `
      <div class="bar-row">
        <div class="bar-name" title="${escapeHtml(x.name)}">${escapeHtml(x.name)}</div>
        <div class="track"><div class="fill ${x.pnl >= 0 ? 'gain' : 'loss'}" style="width:${(Math.abs(x.pnl) / maxAbs * 100).toFixed(2)}%"></div></div>
        <div class="bar-value ${x.pnl >= 0 ? 'positive' : 'negative'}">${moneyFormatter.format(x.pnl)}</div>
      </div>`).join('');
}

// ── 表格渲染 ──────────────────────────────────────────────
function currentRows() {
  const kw = state.search.trim().toLowerCase();
  const filtered = state.holdings.filter(x => {
    const matchKw = !kw || `${x.name} ${x.code} ${x.category}`.toLowerCase().includes(kw);
    const matchFilter = state.filter === 'all' || (state.filter === 'gain' ? x.pnl >= 0 : x.pnl < 0);
    return matchKw && matchFilter;
  });
  const sorters = {
    'weight-desc':   (a, b) => b.weight - a.weight,
    'weight-asc':    (a, b) => a.weight - b.weight,
    'day-pnl-desc':  (a, b) => b.dayPnl - a.dayPnl,
    'day-pnl-asc':   (a, b) => a.dayPnl - b.dayPnl,
    'pnl-asc':       (a, b) => a.pnl - b.pnl,
    'pnl-desc':      (a, b) => b.pnl - a.pnl,
    'market-desc':   (a, b) => b.marketValue - a.marketValue,
    'market-asc':    (a, b) => a.marketValue - b.marketValue,
    'rate-asc':      (a, b) => a.pnlRate - b.pnlRate,
    'rate-desc':     (a, b) => b.pnlRate - a.pnlRate,
  };
  return filtered.sort(sorters[state.sort]);
}

function formatAppMarket(val) {
  if (val >= 100000) {
    return `${(val / 10000).toFixed(2)}万`;
  }
  return val.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatAppPnl(val) {
  return val.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTable(isSilent = false) {
  const rows  = currentRows();
  const tbody = document.getElementById('holdingTable');
  const empty = document.getElementById('emptyState');
  empty.hidden = rows.length > 0;

  // 构建表格 HTML：包含主行和可能展开的详情子行（华宝证券风格双行排版 + 仓位占比）
  const htmlParts = [];
  for (const x of rows) {
    const isExpanded = state.expandedHoldingCode === x.code;
    const isHK = x.code.endsWith('.HK');

    // 格式化各列数值
    const marketText = state.hideValues ? '****' : formatAppMarket(x.marketValue);
    const dayPnlAmtText = state.hideValues ? '****' : formatAppPnl(x.dayPnl);
    const dayRateVal = Number(x.dayPnlRate);
    const dayRateSign = dayRateVal > 0 ? '+' : '';
    const dayRateText = state.hideValues ? '****' : (dayRateVal !== 0 ? `${dayRateSign}${formatDayPercent(dayRateVal)}` : '0.000%');
    const dayPnlColorClass = x.dayPnl > 0 ? 'pnl-gain' : (x.dayPnl < 0 ? 'pnl-loss' : 'pnl-flat');

    const pnlAmtText = state.hideValues ? '****' : formatAppPnl(x.pnl);
    const pnlRateText = state.hideValues ? '****' : `${Number(x.pnlRate).toFixed(3)}%`;
    const qtyText = state.hideValues ? '****' : String(Math.round(x.quantity));
    const costText = state.hideValues ? '****' : (
      x.costPrice === '-' ? '-' : (isHK ? `HK$${toNum(x.costPrice).toFixed(3)}` : toNum(x.costPrice).toFixed(3))
    );
    const priceText = state.hideValues ? '****' : (
      x.currentPrice === '-' ? '-' : (isHK ? `HK$${toNum(x.currentPrice).toFixed(3)}` : toNum(x.currentPrice).toFixed(3))
    );
    const weightText = state.hideValues ? '****' : formatPercent(x.weight);
    const weightNum = toNum(x.weight);

    // 整行颜色类：盈利整行红、亏损整行蓝
    const isProfit = x.pnl > 0;
    const isLoss = x.pnl < 0;
    const rowColorClass = isProfit ? 'row-gain' : (isLoss ? 'row-loss' : 'row-flat');

    htmlParts.push(`
      <tr class="holding-row ${rowColorClass} ${isExpanded ? 'holding-row-active' : ''}" data-code="${escapeHtml(x.code)}">
        <td class="col-stock-market">
          <div class="cell-top stock-name-row">
            ${isHK ? '<span class="badge-hk-tag">沪港</span>' : ''}
            <span class="stock-name">${escapeHtml(x.name)}</span>
          </div>
          <div class="cell-bottom stock-market-val">${marketText}</div>
        </td>
        <td class="col-day-pnl-cell ${dayPnlColorClass}">
          <div class="cell-top day-pnl-amt">${dayPnlAmtText}</div>
          <div class="cell-bottom day-pnl-rate">${dayRateText}</div>
        </td>
        <td class="col-pnl-cell">
          <div class="cell-top pnl-amt">${pnlAmtText}</div>
          <div class="cell-bottom pnl-rate">${pnlRateText}</div>
        </td>
        <td class="col-qty-cell">
          <div class="cell-top qty-hold">${qtyText}</div>
          <div class="cell-bottom qty-avail">${qtyText}</div>
        </td>
        <td class="col-price-cell">
          <div class="cell-top price-cost">${costText}</div>
          <div class="cell-bottom price-cur">${priceText}</div>
        </td>
        <td class="col-weight-cell">
          <div class="cell-top weight-val">${weightText}</div>
          <div class="cell-bottom weight-bar-wrap">
            <div class="weight-mini-track">
              <div class="weight-mini-bar" style="width: ${Math.min(100, Math.max(0, weightNum))}%"></div>
            </div>
          </div>
        </td>
      </tr>
    `);

    // 如果当前行已展开，插入详情子行（跨 6 列全宽）
    if (isExpanded) {
      const safeId = x.code.replace(/[^a-zA-Z0-9]/g, '_');
      htmlParts.push(`
        <tr class="holding-detail-row" data-detail-code="${escapeHtml(x.code)}">
          <td colspan="6">
            <div class="holding-detail-card" id="detailCard_${safeId}">
              <div class="detail-loading">
                <span>⏳ 正在拉取【${escapeHtml(x.name)}】的交易记录...</span>
              </div>
            </div>
          </td>
        </tr>
      `);
    }
  }

  tbody.innerHTML = htmlParts.join('');

  // 渲染表格底部汇总行（总市值、累计盈亏、当日盈亏、持仓占比小计/合计）
  const tfoot = document.getElementById('holdingTableFoot');
  if (tfoot) {
    if (rows.length === 0) {
      tfoot.innerHTML = '';
    } else {
      const isFiltered = rows.length !== state.holdings.length;
      const curMarket = rows.reduce((a, x) => a + x.marketValue, 0);
      const curPnl = rows.reduce((a, x) => a + x.pnl, 0);
      const curDayPnl = rows.reduce((a, x) => a + x.dayPnl, 0);
      const curWeight = rows.reduce((a, x) => a + x.weight, 0);
      const baseCapital = curMarket - curPnl;
      const curPnlRate = baseCapital > 0 ? (curPnl / baseCapital * 100) : 0;

      const marketText = state.hideValues ? '****' : formatAppMarket(curMarket);
      const pnlAmtText = state.hideValues ? '****' : formatAppPnl(curPnl);
      const pnlRateText = state.hideValues ? '****' : `${curPnlRate >= 0 ? '+' : ''}${curPnlRate.toFixed(3)}%`;
      const weightText = state.hideValues ? '****' : formatPercent(curWeight);

      const isProfit = curPnl > 0;
      const isLoss = curPnl < 0;
      const rowColorClass = isProfit ? 'row-gain' : (isLoss ? 'row-loss' : 'row-flat');

      const totalDayRateVal = curMarket > 0 ? (curDayPnl / (curMarket - curDayPnl) * 100) : 0;
      const dayPnlText = state.hideValues ? '****' : formatAppPnl(curDayPnl);
      const dayRateText = state.hideValues ? '****' : `${totalDayRateVal >= 0 ? '+' : ''}${formatDayPercent(totalDayRateVal)}`;
      const dayRowColorClass = curDayPnl > 0 ? 'pnl-gain' : (curDayPnl < 0 ? 'pnl-loss' : 'pnl-flat');

      tfoot.innerHTML = `
        <tr class="holding-total-row ${rowColorClass}">
          <td class="col-stock-market">
            <div class="cell-top stock-name-row">
              <span class="stock-name">${isFiltered ? `小计 (${rows.length}只)` : `合计 (${rows.length}只)`}</span>
            </div>
            <div class="cell-bottom stock-market-val">${marketText}</div>
          </td>
          <td class="col-day-pnl-cell ${dayRowColorClass}">
            <div class="cell-top day-pnl-amt">${dayPnlText}</div>
            <div class="cell-bottom day-pnl-rate">${dayRateText}</div>
          </td>
          <td class="col-pnl-cell">
            <div class="cell-top pnl-amt">${pnlAmtText}</div>
            <div class="cell-bottom pnl-rate">${pnlRateText}</div>
          </td>
          <td class="col-qty-cell">
            <div class="cell-top qty-hold">--</div>
            <div class="cell-bottom qty-avail">--</div>
          </td>
          <td class="col-price-cell">
            <div class="cell-top price-cost">标的数</div>
            <div class="cell-bottom price-cur">${rows.length} 只</div>
          </td>
          <td class="col-weight-cell">
            <div class="cell-top weight-val">${weightText}</div>
            <div class="cell-bottom weight-bar-wrap">
              <div class="weight-mini-track">
                <div class="weight-mini-bar" style="width: ${Math.min(100, Math.max(0, curWeight))}%"></div>
              </div>
            </div>
          </td>
        </tr>
      `;
    }
  }

  // 若存在展开项，异步加载详情
  if (state.expandedHoldingCode) {
    const activeHolding = rows.find(r => r.code === state.expandedHoldingCode);
    const safeId = state.expandedHoldingCode.replace(/[^a-zA-Z0-9]/g, '_');
    const cardEl = document.getElementById(`detailCard_${safeId}`);
    if (cardEl) {
      loadHoldingDetail(state.expandedHoldingCode, activeHolding ? activeHolding.name : state.expandedHoldingCode, cardEl);
    }
  }

  // 若非静默刷新，执行 GSAP 行错开渐显位移动画
  if (!isSilent && rows.length > 0 && typeof gsap !== 'undefined') {
    gsap.fromTo("#holdingTable tr.holding-row", 
      { autoAlpha: 0, y: 10 }, 
      { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.02, ease: "power2.out", clearProps: "all" }
    );
  }
}

function getOrCreateTxTooltip() {
  let tip = document.getElementById('txFloatingTooltip');
  if (!tip) {
    tip = document.createElement('div');
    tip.id = 'txFloatingTooltip';
    document.body.appendChild(tip);
  }
  return tip;
}

function positionTxTooltip(e, tip) {
  const offset = 14;
  let x = e.clientX + offset;
  let y = e.clientY + offset;
  const tipWidth = tip.offsetWidth || 220;
  const tipHeight = tip.offsetHeight || 50;
  if (x + tipWidth > window.innerWidth - 10) {
    x = e.clientX - tipWidth - 10;
  }
  if (y + tipHeight > window.innerHeight - 10) {
    y = e.clientY - tipHeight - 10;
  }
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}

function showTxTooltip(e, content) {
  const tip = getOrCreateTxTooltip();
  tip.innerHTML = content;
  tip.classList.add('visible');
  positionTxTooltip(e, tip);
}

function hideTxTooltip() {
  const tip = document.getElementById('txFloatingTooltip');
  if (tip) tip.classList.remove('visible');
}

function updateBannerActive(bannerEl, txData, currentPrice, isHK) {
  if (!bannerEl) return;
  const { isBuy, tradeDate, quantity, price, pctChange, profitCny } = txData;
  const isUp = pctChange >= 0;
  const isProfit = profitCny >= 0;
  const unit = isHK ? ' HKD' : ' 元';

  bannerEl.className = `detail-calc-banner active ${isUp ? 'positive' : 'negative'}`;
  bannerEl.innerHTML = `
    <div class="calc-banner-active">
      <div class="calc-active-left">
        <span class="calc-tx-badge ${isBuy ? 'buy' : 'sell'}">${isBuy ? '买入' : '卖出'}</span>
        <span class="calc-tx-date">${escapeHtml(tradeDate)}</span>
        <span class="calc-tx-desc">${numberFormatter.format(quantity)} 股 @ ${price.toFixed(4)}${unit}</span>
        <span class="calc-tx-arrow">➔ 实时股价 <strong>${currentPrice.toFixed(4)}${unit}</strong></span>
      </div>
      <div class="calc-active-right">
        <span class="calc-val-rate ${isUp ? 'positive' : 'negative'}">
          ${isUp ? '▲ 上涨' : '▼ 下跌'} ${Math.abs(pctChange).toFixed(2)}%
        </span>
        <span class="calc-val-profit ${isProfit ? 'positive' : 'negative'}">
          ${isBuy ? (isProfit ? '卖出可获利' : '卖出亏损') : (isProfit ? '现价高于卖出' : '现价低于卖出')}
          <strong>${isProfit ? '+' : '-'}${moneyFormatter.format(Math.abs(profitCny))}</strong>
        </span>
      </div>
    </div>
  `;
}

function resetBanner(bannerEl, currentPrice, isHK) {
  if (!bannerEl) return;
  bannerEl.className = 'detail-calc-banner';
  bannerEl.innerHTML = `
    <div class="calc-banner-default">
      <span class="calc-icon">💡</span>
      <span>悬停或点击任意一行流水，测算对比实时股价（<strong class="live-price-val">${currentPrice ? currentPrice.toFixed(4) + (isHK ? ' HKD' : ' 元') : '—'}</strong>）的涨跌幅与卖出收益</span>
    </div>
  `;
}

/** 异步加载并渲染某只股票的交易历史与期初信息 */
async function loadHoldingDetail(code, name, cardEl) {
  try {
    const resp = await fetch(`/api/transactions/${encodeURIComponent(code)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const txList = data.transactions || [];
    const opening = data.opening;
    const base = data.base;
    const isHK = code.endsWith('.HK');
    const safeId = code.replace(/[^a-zA-Z0-9]/g, '_');

    // 获取当前持仓实时股价与有效折算汇率
    const holding = state.holdings.find(h => h.code === code);
    const currentPrice = holding && holding.currentPrice !== '-' && !isNaN(Number(holding.currentPrice))
      ? Number(holding.currentPrice)
      : null;
    const fxRate = isHK
      ? (data.fx_rate || (holding && holding.quantity > 0 && currentPrice ? holding.marketValue / (holding.quantity * currentPrice) : 0.9148))
      : 1.0;

    // 当前持仓基准提示（港股展示人民币成本及原币参考成本）
    let basePill = '';
    if (base) {
      if (isHK) {
        const hkdPart = base.cost_hkd ? ` (原币 HK$${priceFormatter.format(toNum(base.cost_hkd))})` : '';
        basePill = `<span class="detail-opening-pill" title="当前持仓与成本">当前持仓: ${numberFormatter.format(base.quantity)} 股 | 人民币成本 ¥${priceFormatter.format(toNum(base.cost))}${hkdPart}</span>`;
      } else {
        basePill = `<span class="detail-opening-pill" title="当前持仓与成本">当前持仓: ${numberFormatter.format(base.quantity)} 股 | 加权成本 ${priceFormatter.format(toNum(base.cost))}</span>`;
      }
    }

    // 顶部实时收益测算 Banner
    const bannerHtml = `
      <div class="detail-calc-banner" id="calcBanner_${safeId}">
        <div class="calc-banner-default">
          <span class="calc-icon">💡</span>
          <span>悬停或点击任意一行流水，测算对比实时股价（<strong class="live-price-val">${currentPrice ? currentPrice.toFixed(4) + (isHK ? ' HKD' : ' 元') : '—'}</strong>）的涨跌幅与卖出收益</span>
        </div>
      </div>
    `;

    // 交易记录表格或空状态
    let contentHtml = '';
    if (txList.length === 0) {
      contentHtml = `
        <div class="detail-empty">
          <span>📝 暂无交易记录流水</span>
        </div>
      `;
    } else {
      contentHtml = `
        <div class="detail-table-wrap">
          <table class="detail-tx-table">
            <thead>
              <tr>
                <th>交易日期</th>
                <th>操作方向</th>
                <th>成交单价</th>
                <th>数量</th>
                <th>发生金额 (CNY)</th>
                ${isHK ? '<th class="detail-tx-fx">参考汇率</th>' : ''}
                <th>备注说明</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${txList.map(tx => {
                const isBuy = tx.type === 'buy';
                const isDiv = tx.type === 'dividend';
                const isInit = tx.note === '初始持仓';

                // 计算实时涨跌幅与卖出收益（分红记录不参与实时测算）
                let pctChange = null;
                let profitCny = null;
                let diffTagHtml = '';
                let calcSummary = '';

                if (!isDiv && currentPrice && tx.price > 0 && tx.quantity > 0) {
                  pctChange = ((currentPrice - tx.price) / tx.price) * 100;
                  const currentValCny = tx.quantity * currentPrice * fxRate;
                  profitCny = currentValCny - (tx.amount_cny || 0);

                  const isUp = pctChange >= 0;
                  const pctSign = isUp ? '+' : '';
                  const upDownText = isUp ? '上涨' : '下跌';
                  const pctStr = `${upDownText} ${Math.abs(pctChange).toFixed(2)}%`;

                  let profitText = '';
                  const absProfitFormatted = moneyFormatter.format(Math.abs(profitCny));
                  if (isBuy) {
                    profitText = profitCny >= 0
                      ? `卖出可获利 +${absProfitFormatted}`
                      : `卖出亏损 -${absProfitFormatted}`;
                  } else {
                    profitText = profitCny >= 0
                      ? `现价高于卖出价 +${absProfitFormatted}`
                      : `现价低于卖出价 -${absProfitFormatted}`;
                  }
                  calcSummary = `${pctStr} · ${profitText}`;

                  diffTagHtml = `
                    <span class="detail-tx-diff-tag ${isUp ? 'positive' : 'negative'}" title="${escapeHtml(calcSummary)}">
                      ${pctSign}${pctChange.toFixed(2)}%
                    </span>
                  `;
                }

                const tagClass = isBuy ? 'buy' : (isDiv ? 'dividend' : 'sell');
                const tagLabel = isBuy ? '买入' : (isDiv ? '分红' : '卖出');
                const priceDisplay = isDiv ? (tx.price > 0 ? `${tx.price.toFixed(3)}${isHK ? ' HKD' : ' 元'}` : '—') : `${tx.price.toFixed(4)}${isHK ? ' HKD' : ' 元'}`;
                const qtyDisplay = isDiv && tx.quantity === 0 ? '—' : numberFormatter.format(tx.quantity);

                return `
                  <tr class="detail-tx-item-row"
                      data-tx-id="${tx.id}"
                      data-tx-type="${tx.type}"
                      data-trade-date="${escapeHtml(tx.trade_date)}"
                      data-price="${tx.price}"
                      data-quantity="${tx.quantity}"
                      data-amount-cny="${tx.amount_cny}"
                      data-pct="${pctChange !== null ? pctChange.toFixed(4) : ''}"
                      data-profit="${profitCny !== null ? profitCny.toFixed(2) : ''}"
                      data-calc-summary="${escapeHtml(calcSummary)}"
                      title="${escapeHtml(calcSummary ? `【实时测算】${calcSummary}` : (isDiv ? '现金分红冲减持仓成本' : ''))}">
                    <td>${escapeHtml(tx.trade_date)}</td>
                    <td><span class="detail-tx-tag ${tagClass}">${tagLabel}</span></td>
                    <td>
                      <div class="tx-price-cell-wrap">
                        <span>${priceDisplay}</span>
                        ${diffTagHtml}
                      </div>
                    </td>
                    <td>${qtyDisplay}</td>
                    <td title="¥${tx.amount_cny.toFixed(2)}" style="${isDiv ? 'color:var(--gold,#f59e0b);font-weight:600;' : ''}">${isDiv ? `-${moneyFormatter.format(tx.amount_cny)}` : moneyFormatter.format(tx.amount_cny)}</td>
                    ${isHK ? `<td class="detail-tx-fx" style="color:var(--muted)">${tx.fx_rate ? tx.fx_rate.toFixed(4) : '1.0000'}</td>` : ''}
                    <td style="color:var(--muted);max-width:240px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(tx.note || '')}">${escapeHtml(tx.note || '—')}</td>
                    <td>${isInit ? '<span style="color:var(--muted);font-size:11px;">初始</span>' : `<button class="tx-undo-btn" data-id="${tx.id}" onclick="undoTx(this)">撤销</button>`}</td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      `;
    }

    cardEl.innerHTML = `
      <div class="detail-header">
        <div class="detail-title">
          <span>📈</span>
          <strong>${escapeHtml(base?.name || name)}</strong>
          <span class="detail-code">${escapeHtml(code)}</span>
          <span class="detail-badge">${isHK ? '港股' : 'A股'}</span>
          ${basePill}
        </div>
        <div class="detail-actions">
          <button class="detail-close-btn" type="button" data-close-code="${escapeHtml(code)}" title="收起交易明细">✕ 收起</button>
        </div>
      </div>
      ${bannerHtml}
      ${contentHtml}
    `;

    // 绑定流水行悬停与点击交互事件
    const bannerEl = cardEl.querySelector(`#calcBanner_${safeId}`);
    const rows = cardEl.querySelectorAll('tr.detail-tx-item-row');
    let selectedRow = null;

    rows.forEach(r => {
      const isBuy = r.dataset.txType === 'buy';
      const tradeDate = r.dataset.tradeDate;
      const quantity = Number(r.dataset.quantity);
      const price = Number(r.dataset.price);
      const pctChange = r.dataset.pct !== '' ? Number(r.dataset.pct) : null;
      const profitCny = r.dataset.profit !== '' ? Number(r.dataset.profit) : null;

      if (pctChange === null || profitCny === null || !currentPrice) return;

      const txData = { isBuy, tradeDate, quantity, price, pctChange, profitCny };
      const isUp = pctChange >= 0;
      const isProfit = profitCny >= 0;

      const tooltipContent = `
        <div class="tip-line-primary">
          <span>${isBuy ? '🛒 买入记录' : '💰 卖出记录'}</span>
          <span style="color:var(--muted);font-size:11px;">(${escapeHtml(tradeDate)})</span>
        </div>
        <div class="tip-line-calc">
          <span style="color:${isUp ? 'var(--red)' : 'var(--green)'};">${isUp ? '▲ 上涨' : '▼ 下跌'} ${Math.abs(pctChange).toFixed(2)}%</span>
          <span style="color:${isProfit ? 'var(--red)' : 'var(--green)'};">
            ${isBuy ? (isProfit ? '卖出获利' : '卖出亏损') : (isProfit ? '现价高于卖出' : '现价低于卖出')}
            ${isProfit ? '+' : '-'}${moneyFormatter.format(Math.abs(profitCny))}
          </span>
        </div>
      `;

      r.addEventListener('mouseenter', (e) => {
        rows.forEach(other => other.classList.remove('row-hovered'));
        r.classList.add('row-hovered');
        updateBannerActive(bannerEl, txData, currentPrice, isHK);
        showTxTooltip(e, tooltipContent);
      });

      r.addEventListener('mousemove', (e) => {
        const tip = getOrCreateTxTooltip();
        positionTxTooltip(e, tip);
      });

      r.addEventListener('mouseleave', () => {
        r.classList.remove('row-hovered');
        hideTxTooltip();
        if (selectedRow && selectedRow._txData) {
          updateBannerActive(bannerEl, selectedRow._txData, currentPrice, isHK);
        } else {
          resetBanner(bannerEl, currentPrice, isHK);
        }
      });

      r._txData = txData;
      r.addEventListener('click', (e) => {
        if (e.target.closest('.tx-undo-btn')) return;
        if (selectedRow === r) {
          selectedRow.classList.remove('row-selected');
          selectedRow = null;
          resetBanner(bannerEl, currentPrice, isHK);
        } else {
          if (selectedRow) selectedRow.classList.remove('row-selected');
          selectedRow = r;
          selectedRow.classList.add('row-selected');
          updateBannerActive(bannerEl, txData, currentPrice, isHK);
        }
      });
    });
  } catch (err) {
    cardEl.innerHTML = `
      <div class="detail-empty" style="color:var(--red);">
        <span>⚠️ 获取交易记录失败: ${escapeHtml(err.message)}</span>
        <button class="detail-close-btn" type="button" data-close-code="${escapeHtml(code)}">关闭</button>
      </div>
    `;
  }
}

export function render(isSilent = false) {
  renderKpis(isSilent);
  renderAllocation();
  renderPnl();
  renderTable(isSilent);
}

// ── 持仓表搜索 / 排序 / 盈亏筛选事件 ─────────────────────────
document.getElementById('searchInput').addEventListener('input', e => {
  state.search = e.target.value;
  renderTable(true);
});
document.getElementById('sortSelect').addEventListener('change', e => {
  state.sort = e.target.value;
  updateSortIcons();
  renderTable(true);
});
document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderTable(true);
  });
});

// ── 持仓行点击展开交易明细事件（事件委托）──────────────────────
document.getElementById('holdingTable').addEventListener('click', e => {
  // 若点击了收起按钮
  const closeBtn = e.target.closest('.detail-close-btn');
  if (closeBtn) {
    e.stopPropagation();
    state.expandedHoldingCode = null;
    hideTxTooltip();
    renderTable(true);
    return;
  }

  // 若点击了详情卡片内的其他可交互元素（如撤销按钮），不要触发折叠
  if (e.target.closest('.holding-detail-card')) {
    return;
  }

  // 点击了主行或行内的明细按钮
  const row = e.target.closest('tr.holding-row');
  if (!row) return;

  const code = row.dataset.code;
  if (!code) return;

  hideTxTooltip();
  if (state.expandedHoldingCode === code) {
    state.expandedHoldingCode = null;
  } else {
    state.expandedHoldingCode = code;
  }

  renderTable(true);

  // 若展开了某一行，轻柔滚动至可见视野
  if (state.expandedHoldingCode) {
    setTimeout(() => {
      const detailRow = document.querySelector(`tr.holding-detail-row[data-detail-code="${code}"]`);
      if (detailRow) {
        detailRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 50);
  }
});

// ── 表头点击排序联动 ─────────────────────────────────────────
const thMarket = document.querySelector('.th-market');
const thDayPnl = document.querySelector('.th-day-pnl');
const thPnl = document.querySelector('.th-pnl');
const thWeight = document.querySelector('.th-weight');
const marketSortIcon = document.getElementById('marketSortIcon');
const dayPnlSortIcon = document.getElementById('dayPnlSortIcon');
const pnlSortIcon = document.getElementById('pnlSortIcon');
const weightSortIcon = document.getElementById('weightSortIcon');

function updateSortIcons() {
  if (marketSortIcon) marketSortIcon.hidden = true;
  if (dayPnlSortIcon) dayPnlSortIcon.hidden = true;
  if (pnlSortIcon) pnlSortIcon.hidden = true;
  if (weightSortIcon) weightSortIcon.hidden = true;

  if (state.sort === 'market-desc') {
    if (marketSortIcon) { marketSortIcon.hidden = false; marketSortIcon.textContent = '▼'; }
  } else if (state.sort === 'market-asc') {
    if (marketSortIcon) { marketSortIcon.hidden = false; marketSortIcon.textContent = '▲'; }
  } else if (state.sort === 'day-pnl-desc') {
    if (dayPnlSortIcon) { dayPnlSortIcon.hidden = false; dayPnlSortIcon.textContent = '▼'; }
  } else if (state.sort === 'day-pnl-asc') {
    if (dayPnlSortIcon) { dayPnlSortIcon.hidden = false; dayPnlSortIcon.textContent = '▲'; }
  } else if (state.sort === 'pnl-desc') {
    if (pnlSortIcon) { pnlSortIcon.hidden = false; pnlSortIcon.textContent = '▼'; }
  } else if (state.sort === 'pnl-asc') {
    if (pnlSortIcon) { pnlSortIcon.hidden = false; pnlSortIcon.textContent = '▲'; }
  } else if (state.sort === 'weight-desc') {
    if (weightSortIcon) { weightSortIcon.hidden = false; weightSortIcon.textContent = '▼'; }
  } else if (state.sort === 'weight-asc') {
    if (weightSortIcon) { weightSortIcon.hidden = false; weightSortIcon.textContent = '▲'; }
  }
}

if (thMarket) {
  thMarket.addEventListener('click', () => {
    state.sort = state.sort === 'market-desc' ? 'market-asc' : 'market-desc';
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = state.sort;
    updateSortIcons();
    renderTable(true);
  });
}

if (thDayPnl) {
  thDayPnl.addEventListener('click', () => {
    state.sort = state.sort === 'day-pnl-desc' ? 'day-pnl-asc' : 'day-pnl-desc';
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = state.sort;
    updateSortIcons();
    renderTable(true);
  });
}

if (thPnl) {
  thPnl.addEventListener('click', () => {
    state.sort = state.sort === 'pnl-desc' ? 'pnl-asc' : 'pnl-desc';
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = state.sort;
    updateSortIcons();
    renderTable(true);
  });
}

if (thWeight) {
  thWeight.addEventListener('click', () => {
    state.sort = state.sort === 'weight-desc' ? 'weight-asc' : 'weight-desc';
    const sel = document.getElementById('sortSelect');
    if (sel) sel.value = state.sort;
    updateSortIcons();
    renderTable(true);
  });
}

updateSortIcons();

