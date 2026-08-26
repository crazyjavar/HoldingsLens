// app.js — 入口模块：负责跨模块的页面调度（页签 / 刷新 / 隐私 / 启动轮询）
// 按职责拆分的功能模块位于 js/ 目录：
//   state.js / utils.js / effects.js / indices.js / history.js
//   rendering.js / transactions.js / watchlist.js
import { state } from './js/state.js';
import { loadLatest, render } from './js/rendering.js';
import { loadHistory, renderHistoryChart, resizeHistoryChart } from './js/history.js';
import { loadIndices } from './js/indices.js';
import { loadMgmt } from './js/transactions.js';
import { loadWatchlist, reRenderWatchlist, adjustWatchlistPosition } from './js/watchlist.js';

// ── 手动刷新按钮 ─────────────────────────────────────────
const refreshBtn = document.getElementById('refreshBtn');
refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('loading');
  refreshBtn.textContent = '⟳ 刷新中...';
  try {
    await fetch('/api/holdings/refresh', { method: 'POST' });
    await Promise.all([
      loadLatest(),
      loadHistory(state.historyDays),
      loadIndices()
    ]);
  } finally {
    refreshBtn.classList.remove('loading');
    refreshBtn.textContent = '⟳ 立即刷新';
  }
});

// ── 标签页 (Tab) 切换控制 ─────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const tabName = btn.dataset.tab;
    
    // 激活按钮样式
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    
    // 激活内容展示
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    const activeTab = document.getElementById(`tab-${tabName}`);
    activeTab.classList.add('active');

    // 执行 GSAP Tab 内容入场动画
    if (typeof gsap !== 'undefined') {
      const children = activeTab.children;
      if (children.length > 0) {
        gsap.fromTo(children,
          { autoAlpha: 0, y: 15 },
          { autoAlpha: 1, y: 0, duration: 0.45, stagger: 0.05, ease: "power2.out", clearProps: "all" }
        );
      }
    }
    
    // 如果切回 overview 重新 resize 图表以防 canvas 宽度变为 0
    if (tabName === 'overview') {
      setTimeout(() => {
        resizeHistoryChart();
      }, 50);
    }
    // 如果切到交易记录页，加载/刷新数据
    if (tabName === 'transactions') {
      loadMgmt();
    }
  });
});

// ── 窗口尺寸变化 ─────────────────────────────────────────
window.addEventListener('resize', adjustWatchlistPosition);
window.addEventListener('resize', () => {
  resizeHistoryChart();
});

// ── 隐私数值显示与隐藏控制 ────────────────────────────────────
document.getElementById('privacyBtn').addEventListener('click', () => {
  state.hideValues = !state.hideValues;
  const btn = document.getElementById('privacyBtn');
  if (state.hideValues) {
    btn.innerHTML = '🙈 显示数值';
    btn.title = '显示敏感数值';
  } else {
    btn.innerHTML = '👁 隐藏数值';
    btn.title = '隐藏敏感数值';
  }
  // 重绘页面，采用静默刷新避免数字动画闪烁
  render(true);
  reRenderWatchlist(true);
  if (state.historyData) renderHistoryChart(state.historyData);
});

// ── 启动 ──────────────────────────────────────────────────
async function boot() {
  adjustWatchlistPosition();
  try {
    await Promise.all([
      loadLatest(false),
      loadHistory(state.historyDays),
      loadWatchlist(false),
      loadMgmt(),
      loadIndices(),
    ]);
  } catch (err) {
    document.getElementById('sourceState').textContent = `加载失败: ${err.message}`;
    document.getElementById('subtitle').textContent = '无法连接到数据服务，请确认 Node 服务已启动';
  }
}

boot();

// 每 60 秒自动重新拉取（非阻塞，静默刷新）
setInterval(async () => {
  try {
    await Promise.all([
      loadLatest(true),
      loadHistory(state.historyDays),
      loadWatchlist(true),
      loadIndices(),
    ]);
  } catch (_) {}
}, 60 * 1000);
