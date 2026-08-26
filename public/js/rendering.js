// ── KPI / 仓位结构 / 表格渲染与持仓数据加载 ──────────────────
import { state } from './state.js';
import {
  toNum, formatPercent, formatDayPercent, moneyFormatter,
  priceFormatter, numberFormatter, escapeHtml, classify
} from './utils.js';
import { animateNumericKpi, renderEffect } from './effects.js';
import { renderComparePanel } from './indices.js';

export async function loadLatest(isSilent = false) {
  const resp = await fetch('/api/holdings/latest');
  if (!resp.ok) throw new Error(`API ${resp.status}`);
  const data = await resp.json();

  state.holdings = (data.holdings || []).map(row => ({
    date:        row.date,
    name:        row.name,
    code:        row.code,
    marketValue: row.market,
    costPrice:   row.cost ?? '-',
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

  state.summary = data.summary;
  document.getElementById('sourceState').textContent = 'API 实时数据';
  render(isSilent);
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
  const top3   = sorted.slice(0, 3).reduce((a, x) => a + x.weight, 0);
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
    document.getElementById('top3Weight').textContent = formatPercent(top3);
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
    document.getElementById('top3Weight').textContent = formatPercent(top3);
  } else {
    // 使用 GSAP 数字滚动动画
    const prev = state.prevValues || {
      totalMarket: 0, totalPnl: 0, totalPnlRate: 0,
      dayPnl: 0, dayPnlRate: 0, monthPnl: 0, monthPnlRate: 0,
      topWeight: 0, top3Weight: 0
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
    animateNumericKpi('top3Weight', top3, prev.top3Weight, true);
  }

  // 无论静默与否，直接渲染非数字滚动内容及保存状态
  document.getElementById('holdingCount').textContent = `${h.length} 个持仓标的`;
  document.getElementById('topHolding').textContent = top.name;
  document.getElementById('gainCount').textContent  = `${gains} 个`;
  document.getElementById('lossCount').textContent  = `${h.length - gains} 个`;

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
    top3Weight: top3
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
    'weight-desc':  (a, b) => b.weight - a.weight,
    'pnl-asc':      (a, b) => a.pnl - b.pnl,
    'pnl-desc':     (a, b) => b.pnl - a.pnl,
    'market-desc':  (a, b) => b.marketValue - a.marketValue,
    'rate-asc':     (a, b) => a.pnlRate - b.pnlRate,
    'rate-desc':    (a, b) => b.pnlRate - a.pnlRate,
  };
  return filtered.sort(sorters[state.sort]);
}

function renderTable(isSilent = false) {
  const rows  = currentRows();
  const tbody = document.getElementById('holdingTable');
  const empty = document.getElementById('emptyState');
  empty.hidden = rows.length > 0;
  tbody.innerHTML = rows.map(x => `
    <tr class="${x.code.endsWith('.HK') ? 'portfolio-hk-row' : ''}">
      <td>
        <div class="name-cell">
          <strong>${escapeHtml(x.name)}${x.code.endsWith('.HK') ? '<span class="portfolio-market-badge">港股</span>' : ''}</strong>
          <span class="code">${escapeHtml(x.code)}</span>
        </div>
      </td>
      <td><span class="tag">${escapeHtml(x.category)}</span></td>
      <td>${state.hideValues ? '****' : moneyFormatter.format(x.marketValue)}</td>
      <td>${state.hideValues ? '****' : (x.costPrice === '-' ? '-' : priceFormatter.format(toNum(x.costPrice)))}</td>
      <td>${state.hideValues ? '****' : (x.currentPrice === '-' ? '-' : priceFormatter.format(toNum(x.currentPrice)))}</td>
      <td class="${x.dayPnlRate >= 0 ? 'positive' : 'negative'}">${formatDayPercent(x.dayPnlRate)}</td>
      <td>${state.hideValues ? '****' : numberFormatter.format(x.quantity)}</td>
      <td class="${x.pnl >= 0 ? 'positive' : 'negative'}">${state.hideValues ? '****' : moneyFormatter.format(x.pnl)}</td>
      <td><span class="tag ${x.pnl >= 0 ? 'gain' : 'loss'}">${formatPercent(x.pnlRate)}</span></td>
      <td>${formatPercent(x.weight)}</td>
      <td>${escapeHtml(x.change)}</td>
    </tr>`).join('');

  // 若非静默刷新，执行 GSAP 行错开渐显位移动画
  if (!isSilent && rows.length > 0 && typeof gsap !== 'undefined') {
    gsap.fromTo("#holdingTable tr", 
      { autoAlpha: 0, y: 10 }, 
      { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.02, ease: "power2.out", clearProps: "all" }
    );
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
  renderTable();
});
document.getElementById('sortSelect').addEventListener('change', e => {
  state.sort = e.target.value;
  renderTable();
});
document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.segmented[aria-label="盈亏筛选"] button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.filter = btn.dataset.filter;
    renderTable();
  });
});
