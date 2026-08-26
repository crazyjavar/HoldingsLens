// ── 大盘指数与跑赢对比卡片 ─────────────────────────────────
import { state } from './state.js';
import { toNum, escapeHtml } from './utils.js';

// ── 加载并渲染大盘指数 ───────────────────────────────────────
export async function loadIndices() {
  const indexBar = document.getElementById('indexBar');
  if (!indexBar) return;
  try {
    const resp = await fetch('/api/indices');
    if (!resp.ok) throw new Error(`API ${resp.status}`);
    const data = await resp.json();
    const indices = data.indices || [];
    
    // 缓存数据
    state.indicesLive = indices;
    state.indicesMonthChange = data.month_change || null;
    
    // 渲染对比大盘卡片
    renderComparePanel();

    if (indices.length === 0) {
      indexBar.innerHTML = '';
      return;
    }
    indexBar.innerHTML = indices.map(idx => {
      const isUp = idx.changeVal > 0;
      const isDown = idx.changeVal < 0;
      const sign = isUp ? '+' : '';
      const changeClass = isUp ? 'positive' : (isDown ? 'negative' : 'flat');
      // 精准保留两位小数
      const currentStr = idx.current.toFixed(2);
      const valStr = idx.changeVal.toFixed(2);
      const pctStr = idx.changePct.toFixed(2);
      
      return `
        <div class="index-card">
          <div class="index-card-header">
            <span class="index-name">${escapeHtml(idx.name)}</span>
          </div>
          <div class="index-value">${currentStr}</div>
          <div class="index-change-row ${changeClass}">
            <span>${sign}${valStr}</span>
            <span>${sign}${pctStr}%</span>
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    console.error('Failed to load indices:', err);
  }
}

// ── 渲染跑赢大盘对比卡片 ──────────────────────────────────────────
export function renderComparePanel() {
  const live = state.indicesLive || [];
  const monthChange = state.indicesMonthChange || {};
  const isDay = state.comparePeriod === 'day';

  // 1. 获取“我”的收益率
  let myVal = 0.0;
  if (isDay) {
    myVal = state.summary ? toNum(state.summary.total_day_pct) : 0;
  } else {
    myVal = state.summary ? toNum(state.summary.month_pnl_pct) : 0;
  }

  // 2. 获取大盘三指数收益率
  const getLivePct = sym => {
    const found = live.find(x => x.symbol === sym);
    return found ? found.changePct : 0.0;
  };
  
  const shVal = isDay ? getLivePct('sh000001') : (monthChange['sh000001'] ?? 0.0);
  const szVal = isDay ? getLivePct('sz399001') : (monthChange['sz399001'] ?? 0.0);
  const cyVal = isDay ? getLivePct('sz399006') : (monthChange['sz399006'] ?? 0.0);

  // 3. 计算跑赢幅度 (对比上证)
  const diff = myVal - shVal;
  const sign = diff >= 0 ? '+' : '';
  const heroValEl = document.getElementById('compareHeroValue');
  const heroLabelEl = document.getElementById('compareHeroLabel');

  if (heroLabelEl) {
    heroLabelEl.textContent = isDay ? '今日跑赢上证指数' : '本月跑赢上证指数';
  }
  if (heroValEl) {
    heroValEl.textContent = `${sign}${diff.toFixed(3)}%`;
    heroValEl.className = `compare-hero-value ${diff >= 0 ? 'positive' : 'negative'}`;
  }

  // 4. 计算对称双向条形图进度条宽度
  const vals = [myVal, shVal, szVal, cyVal];
  const maxAbs = Math.max(...vals.map(Math.abs), 1.0); // 确定最大绝对值上限

  const updateBar = (barId, valId, val) => {
    const bar = document.getElementById(barId);
    const valText = document.getElementById(valId);
    if (!bar || !valText) return;

    const ratio = (val / maxAbs) * 100; // 范围 [-100, 100]
    const width = Math.abs(ratio) / 2; // 正中 0 点，最大占 50% 宽度

    if (ratio >= 0) {
      bar.style.left = '50%';
      bar.style.width = `${width}%`;
      bar.className = 'bar-fill positive';
    } else {
      bar.style.left = `${50 - width}%`;
      bar.style.width = `${width}%`;
      bar.className = 'bar-fill negative';
    }

    const vSign = val >= 0 ? '+' : '';
    valText.textContent = `${vSign}${val.toFixed(2)}%`;
    valText.className = `bar-value ${val >= 0 ? 'positive' : 'negative'}`;
  };

  updateBar('myBar', 'myValue', myVal);
  updateBar('shBar', 'shValue', shVal);
  updateBar('szBar', 'szValue', szVal);
  updateBar('cyBar', 'cyValue', cyVal);
}

// 对比时段切换 (当日 / 本月)
document.querySelectorAll('.compare-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.compare-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.comparePeriod = btn.dataset.period;
    renderComparePanel();
  });
});
