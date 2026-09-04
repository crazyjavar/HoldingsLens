// ── 历史趋势图与收益日历 ────────────────────────────────────
import { state } from './state.js';
import {
  toNum, addCalendarDays, weekStartKey, mondayIndex,
  historyValueDisplay
} from './utils.js';

export async function loadHistory(days = 5000) {
  const resp = await fetch(`/api/holdings/history?days=${days}`);
  if (!resp.ok) return;
  const data = await resp.json();
  state.historyData = data.history || [];
  renderHistoryChart(state.historyData);
}

// ── 历史趋势图渲染 ────────────────────────────────────────
let historyChartInstance = null;

// 收益日历只处理 YYYY-MM-DD。统一使用 UTC 日历坐标，
// 避免浏览器所在时区将东八区零点解析成前一天。
export function resizeHistoryChart() {
  if (historyChartInstance) historyChartInstance.resize();
}

function renderIncomeCalendar(history) {
  const calendarDom = document.getElementById('incomeCalendar');
  const summary = document.getElementById('calendarSummary');
  if (!calendarDom || !summary) return;
  if (!history.length) {
    summary.textContent = '暂无收益数据';
    return;
  }

  const isAmt = state.historyPnlMode !== 'pct';
  const rows = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const granularity = state.historyGranularity;

  if (historyChartInstance) {
    historyChartInstance.dispose();
    historyChartInstance = null;
  }

  // ECharts 依赖公共 CDN，离线/加载失败时给出降级提示而非抛错。
  if (typeof echarts === 'undefined') {
    calendarDom.innerHTML = '';
    summary.textContent = '图表库未加载，请联网后刷新页面';
    return;
  }

  historyChartInstance = echarts.init(calendarDom);

  if (granularity === 'day') {
    renderDayHeatmap(historyChartInstance, rows, isAmt, summary);
  } else {
    renderPeriodHeatmap(historyChartInstance, rows, isAmt, granularity, summary);
  }
}

function renderDayHeatmap(chart, rows, isAmt, summary) {
  const latestDate = rows.at(-1)?.date || '';
  const firstDate = rows[0]?.date || latestDate;
  // 默认滚动 12 个月；若总数据不足 12 个月，则从最早有数据的日期开始，避免大量空白格子。
  const idealStart = latestDate ? addCalendarDays(latestDate, -364) : firstDate;
  const startDate = firstDate > idealStart ? firstDate : idealStart;
  const endDate = latestDate;
  const windowRows = rows.filter(row => row.date >= startDate && row.date <= endDate);

  const data = windowRows.map(row => [
    row.date,
    isAmt ? toNum(row.total_day_pnl) : toNum(row.total_day_pct)
  ]);
  const values = data.map(d => d[1]);
  const maxAbs = Math.max(...values.map(Math.abs), 0.0001);

  summary.textContent = `${startDate.slice(0, 7)} — ${endDate.slice(0, 7)} 收益热力图`;

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10, 15, 30, 0.92)',
      borderColor: 'rgba(51, 65, 85, 0.5)',
      borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
      formatter: params => {
        const date = params.data[0];
        const value = params.data[1];
        if (isAmt && state.hideValues) return `${date}<br/>当日盈亏：¥****`;
        const display = historyValueDisplay(value, isAmt);
        return `${date}<br/>${isAmt ? '当日盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
      }
    },
    visualMap: {
      show: false,
      min: -maxAbs,
      max: maxAbs,
      calculable: false,
      inRange: { color: ['#10b981', '#0f172a', '#f43f5e'] }
    },
    calendar: {
      top: 18,
      left: 44,
      right: 20,
      bottom: 10,
      cellSize: ['auto', 14],
      range: startDate && endDate ? [startDate, endDate] : latestDate,
      itemStyle: {
        color: 'rgba(15, 23, 42, 0.6)',
        borderColor: 'rgba(51, 65, 85, 0.35)',
        borderWidth: 1,
        borderRadius: 2
      },
      splitLine: { show: false },
      yearLabel: { show: false },
      monthLabel: { color: '#64748b', fontSize: 11, nameMap: 'cn' },
      dayLabel: { color: '#64748b', fontSize: 10, firstDay: 1, nameMap: 'cn' }
    },
    series: {
      type: 'heatmap',
      coordinateSystem: 'calendar',
      data: data,
      itemStyle: { borderRadius: 2 }
    }
  });
}

function renderPeriodHeatmap(chart, rows, isAmt, granularity, summary) {
  const grouped = new Map();
  rows.forEach(row => {
    const key = granularity === 'year' ? row.date.slice(0, 4)
      : granularity === 'month' ? row.date.slice(0, 7)
      : weekStartKey(row.date);
    const current = grouped.get(key) || { total_day_pnl: 0, total_day_pct_factor: 1 };
    current.total_day_pnl += toNum(row.total_day_pnl);
    current.total_day_pct_factor *= 1 + toNum(row.total_day_pct) / 100;
    grouped.set(key, current);
  });

  const points = [...grouped.entries()].map(([key, row]) => {
    const value = isAmt ? row.total_day_pnl : (row.total_day_pct_factor - 1) * 100;
    const label = granularity === 'week'
      ? `${key.slice(5)}—${addCalendarDays(key, 4).slice(5)}`
      : granularity === 'month'
        ? `${Number(key.slice(5, 7))}月`
        : key;
    return { key, label, value };
  });

  const values = points.map(p => p.value);
  const maxAbs = Math.max(...values.map(Math.abs), 0.0001);
  const periodText = granularity === 'week' ? '周' : granularity === 'month' ? '月' : '年';
  summary.textContent = `${points[0]?.key || ''} — ${points.at(-1)?.key || ''} · 共${points.length}${periodText}`;

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: {
      trigger: 'item',
      backgroundColor: 'rgba(10, 15, 30, 0.92)',
      borderColor: 'rgba(51, 65, 85, 0.5)',
      borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
      formatter: params => {
        const point = points[params.data[0]];
        if (!point) return '';
        if (isAmt && state.hideValues) return `${point.label}<br/>盈亏：¥****`;
        const display = historyValueDisplay(point.value, isAmt);
        return `${point.label}<br/>${isAmt ? '盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
      }
    },
    grid: { top: 10, left: 0, right: 20, bottom: 30, containLabel: true },
    xAxis: {
      type: 'category',
      data: points.map((_, i) => i),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#64748b',
        fontSize: 11,
        interval: 0,
        formatter: value => points[value]?.label || ''
      }
    },
    yAxis: {
      type: 'category',
      data: ['盈亏'],
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false }
    },
    visualMap: {
      show: false,
      min: -maxAbs,
      max: maxAbs,
      inRange: { color: ['#10b981', '#0f172a', '#f43f5e'] }
    },
    series: {
      type: 'heatmap',
      data: points.map((p, i) => [i, 0, p.value]),
      itemStyle: {
        borderRadius: 4,
        borderColor: 'rgba(51, 65, 85, 0.35)',
        borderWidth: 1
      },
      label: {
        show: points.length <= 24,
        color: '#e2e8f0',
        fontSize: 11,
        formatter: params => {
          if (isAmt && state.hideValues) return '****';
          return historyValueDisplay(params.data[2], isAmt);
        }
      }
    }
  });
}

export function renderHistoryChart(history) {
  const isAmt = state.historyPnlMode !== 'pct';
  const granularity = state.historyGranularity;
  const sortedHistory = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const latestDate = sortedHistory.at(-1)?.date || '';

  // 日视图日历按滚动窗口展示；柱状图保持原有切片逻辑
  const recentWeekStart = latestDate ? weekStartKey(addCalendarDays(latestDate, -29)) : '';
  const barHistory = granularity === 'day' && latestDate
    ? sortedHistory.filter(row => row.date.slice(0, 7) === latestDate.slice(0, 7))
    : granularity === 'week' && recentWeekStart
      ? sortedHistory.filter(row => row.date >= recentWeekStart && mondayIndex(row.date) <= 4)
      : sortedHistory;
  const calendarHistory = sortedHistory;

  const chartView = document.getElementById('historyChartView');
  const calendarView = document.getElementById('incomeCalendarView');
  if (chartView) chartView.hidden = state.historyViewMode !== 'bar';
  if (calendarView) calendarView.hidden = state.historyViewMode !== 'calendar';

  if (historyChartInstance) {
    historyChartInstance.dispose();
    historyChartInstance = null;
  }

  if (state.historyViewMode === 'calendar') {
    renderIncomeCalendar(calendarHistory);
  } else {
    renderHistoryBarChart(barHistory);
  }
}

function renderHistoryBarChart(history) {
  const isAmt = state.historyPnlMode !== 'pct';
  const granularity = state.historyGranularity;

  const grouped = new Map();
  history.forEach(row => {
    const key = granularity === 'year' ? row.date.slice(0, 4)
      : granularity === 'month' ? row.date.slice(0, 7)
      : granularity === 'week' ? weekStartKey(row.date)
      : row.date;
    const current = grouped.get(key) || { total_day_pnl: 0, total_day_pct_factor: 1 };
    current.total_day_pnl += toNum(row.total_day_pnl);
    current.total_day_pct_factor *= 1 + toNum(row.total_day_pct) / 100;
    grouped.set(key, current);
  });

  const points = [...grouped.entries()].map(([key, row]) => {
    const value = isAmt ? row.total_day_pnl : (row.total_day_pct_factor - 1) * 100;
    const label = granularity === 'week'
      ? `${key.slice(5)}—${addCalendarDays(key, 4).slice(5)}`
      : key;
    return { key, label, value };
  });

  const labels = points.map(p => p.label);
  const values = points.map(p => p.value);

  const chartDom = document.getElementById('historyChart');
  if (!chartDom) return;

  // ECharts 依赖公共 CDN，离线/加载失败时给出降级提示而非抛错。
  if (typeof echarts === 'undefined') {
    chartDom.innerHTML = '<div style="padding:24px;color:#64748b;text-align:center;font-size:13px;">图表库未加载，请联网后刷新页面</div>';
    return;
  }

  historyChartInstance = echarts.init(chartDom);

  historyChartInstance.setOption({
    backgroundColor: 'transparent',
    animationDuration: 700,
    animationEasing: 'cubicOut',
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,0.05)' } },
      backgroundColor: 'rgba(10, 15, 30, 0.92)',
      borderColor: 'rgba(51, 65, 85, 0.5)',
      borderWidth: 1,
      textStyle: { color: '#e2e8f0', fontSize: 12 },
      extraCssText: 'backdrop-filter: blur(8px); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);',
      formatter: params => {
        const p = params[0];
        const val = p.value;
        if (isAmt && state.hideValues) return `${p.name}<br/>盈亏：¥****`;
        const display = historyValueDisplay(val, isAmt);
        return `${p.name}<br/>${isAmt ? '盈亏' : '收益率'}：${display}${isAmt ? ' 元' : ''}`;
      }
    },
    grid: { top: 30, left: 12, right: 12, bottom: 24, containLabel: true },
    xAxis: {
      type: 'category',
      data: labels,
      axisLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.5)' } },
      axisTick: { show: false },
      axisLabel: {
        color: '#64748b',
        fontSize: 11,
        interval: 'auto',
        rotate: labels.length > 12 ? 45 : 0
      }
    },
    yAxis: {
      type: 'value',
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: isAmt ? '#00f0ff' : '#10b981',
        fontSize: 11,
        formatter: v => {
          if (isAmt && state.hideValues) return '****';
          return isAmt
            ? (v >= 0 ? '+' : '') + (v / 10000).toFixed(1) + 'w'
            : (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
        }
      },
      splitLine: { lineStyle: { color: 'rgba(51, 65, 85, 0.2)' } }
    },
    series: {
      type: 'bar',
      data: values,
      barWidth: '60%',
      itemStyle: {
        borderRadius: params => {
          const v = params.value;
          return v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4];
        },
        color: params => {
          const v = params.value;
          if (v >= 0) {
            return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: '#fb7185' },
              { offset: 1, color: 'rgba(244, 63, 94, 0.2)' }
            ]);
          }
          return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(16, 185, 129, 0.2)' },
            { offset: 1, color: '#34d399' }
          ]);
        }
      }
    }
  });
}

// 历史粒度切换（日 / 周 / 月 / 年）
document.querySelectorAll('.history-controls .segmented[aria-label="时间粒度"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.history-controls .segmented[aria-label="时间粒度"] button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.historyGranularity = btn.dataset.granularity;
    if (state.historyData) {
      renderHistoryChart(state.historyData);
    } else {
      loadHistory(state.historyDays);
    }
  });
});

// 盈亏模式切换 (金额 / 百分比)
document.querySelectorAll('.history-controls .segmented[aria-label="展示模式"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.history-controls .segmented[aria-label="展示模式"] button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.historyPnlMode = btn.dataset.mode;
    if (state.historyData) {
      renderHistoryChart(state.historyData);
    } else {
      loadHistory(state.historyDays);
    }
  });
});

// 历史展示方式切换（日历 / 柱状图）
document.querySelectorAll('.history-controls .segmented[aria-label="视图"] button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.history-controls .segmented[aria-label="视图"] button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.historyViewMode = btn.dataset.view;
    if (state.historyData) renderHistoryChart(state.historyData);
  });
});
