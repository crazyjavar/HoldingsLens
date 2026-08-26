// ── 自选股：列表 / 添加 / 联想搜索 / 拖拽排序 ─────────────────
import { state } from './state.js';
import { toNum, escapeHtml } from './utils.js';

export async function loadWatchlist(isSilent = false) {
  const resp = await fetch('/api/watchlist');
  if (!resp.ok) return;
  const data = await resp.json();
  renderWatchlist(data.watchlist || [], isSilent);
}

function pctBadgeValueOnly(totalPct) {
  if (!totalPct || totalPct === '-') return '0.00%';
  const v = parseFloat(totalPct);
  const prefix = v >= 0 ? '+' : '';
  return `${prefix}${v.toFixed(2)}%`;
}

// 全局自选股列表状态（拖拽用）
let wlList = [];

function marketBadge(code) {
  if (code.endsWith('.HK')) return '<span class="wl-market-badge hk">港</span>';
  if (code.endsWith('.SH')) return '<span class="wl-market-badge sh">沪</span>';
  if (code.endsWith('.SZ')) return '<span class="wl-market-badge sz">深</span>';
  return '';
}

function renderWatchlist(list, isSilent = false) {
  wlList = list;
  const container = document.getElementById('wlTableBody');
  const empty = document.getElementById('wlEmpty');
  if (!list.length) {
    container.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  container.innerHTML = list.map(item => {
    const isHK     = item.code.endsWith('.HK');
    const priceStr = item.current_price != null ? item.current_price.toFixed(3) : '—';
    const dayClass = item.day_pct ? (parseFloat(item.day_pct) >= 0 ? 'positive' : 'negative') : '';
    const dayStr   = item.day_pct || '—';
    const totalPctVal = toNum(item.total_pct);
    const compareClass = totalPctVal >= 0 ? 'positive' : 'negative';
    
    return `
      <div class="wl-item ${isHK ? 'hk-row' : ''}" draggable="true" data-code="${escapeHtml(item.code)}">
        <div class="wl-item-left">
          <span class="wl-drag-handle" title="拖拽排序">⠿</span>
          <div class="wl-name-box">
            <div class="wl-title-row">
              <strong class="wl-name">${escapeHtml(item.name)}</strong>
              ${marketBadge(item.code)}
            </div>
            <span class="wl-code-sub">${escapeHtml(item.code)} ${item.note ? '• ' + escapeHtml(item.note) : ''}</span>
          </div>
        </div>
        <div class="wl-item-right">
          <div class="wl-price-box">
            <div class="wl-current-price">${priceStr}</div>
            <div class="wl-added-compare">比成本 <span class="${compareClass}">${pctBadgeValueOnly(item.total_pct)}</span></div>
          </div>
          <div class="wl-pct-badge-wrapper">
            <span class="wl-pct-badge-pill ${dayClass}">${dayStr}</span>
            <button class="wl-item-delete" data-code="${escapeHtml(item.code)}" onclick="deleteWatchitem(this)" title="删除">×</button>
          </div>
        </div>
      </div>`;
  }).join('');

  // 绑定拖拽事件
  initDragSort(container);

  // 若非静默刷新，执行 GSAP Stagger 入场动效
  if (!isSilent && list.length > 0 && typeof gsap !== 'undefined') {
    gsap.fromTo("#wlTableBody .wl-item", 
      { autoAlpha: 0, x: 15 }, 
      { autoAlpha: 1, x: 0, duration: 0.4, stagger: 0.03, ease: "power2.out", clearProps: "all" }
    );
  }
}

// 供入口模块重绘（隐私模式切换时）使用
export function reRenderWatchlist(isSilent = false) {
  renderWatchlist(wlList, isSilent);
}

// 供内联 onclick="deleteWatchitem(this)" 调用（ES Module 需显式挂到 window）
export async function deleteWatchitem(btn) {
  const code = btn.dataset.code;
  if (!confirm(`确认删除自选股 ${code}？`)) return;
  btn.disabled = true;
  try {
    const resp = await fetch(`/api/watchlist/${encodeURIComponent(code)}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { alert(data.error || '删除失败'); btn.disabled = false; return; }
    await loadWatchlist(false);
  } catch (e) { alert('网络错误'); btn.disabled = false; }
}
window.deleteWatchitem = deleteWatchitem;

// ── 拖拽排序 ──────────────────────────────────────────────
function initDragSort(container) {
  let dragSrc = null;

  container.querySelectorAll('.wl-item').forEach(row => {
    row.addEventListener('dragstart', e => {
      dragSrc = row;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.code);
    });

    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      container.querySelectorAll('.wl-item').forEach(r => r.classList.remove('drag-over'));
    });

    row.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.querySelectorAll('.wl-item').forEach(r => r.classList.remove('drag-over'));
      if (row !== dragSrc) row.classList.add('drag-over');
    });

    row.addEventListener('drop', async e => {
      e.preventDefault();
      if (!dragSrc || dragSrc === row) return;
      row.classList.remove('drag-over');

      // 重排 DOM
      const rows = [...container.querySelectorAll('.wl-item')];
      const srcIdx  = rows.indexOf(dragSrc);
      const destIdx = rows.indexOf(row);
      if (srcIdx < destIdx) {
        row.after(dragSrc);
      } else {
        row.before(dragSrc);
      }

      // 提取新顺序的 code 列表，持久化到后端
      const newOrder = [...container.querySelectorAll('.wl-item')]
        .map(r => r.dataset.code);
      try {
        await fetch('/api/watchlist/reorder', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: newOrder }),
        });
      } catch (_) { /* 静默失败，下次刷新会恢复 */ }
    });
  });
}

document.getElementById('wlAddBtn').addEventListener('click', async () => {
  const raw  = document.getElementById('wlCode').value.trim();
  const nameInput = document.getElementById('wlName').value.trim();
  const note = document.getElementById('wlNote').value.trim();
  const errEl = document.getElementById('wlError');
  const btn   = document.getElementById('wlAddBtn');
  errEl.textContent = '';
  if (!raw) { errEl.textContent = '请输入证券代码或公司名称'; return; }
  
  btn.disabled = true;
  btn.textContent = '智能匹配中...';
  
  let code = normalizeCode(raw.toUpperCase());
  let finalName = nameInput;

  // 若不能解析为常规格式，说明用户输入的是公司名称或拼音，在此通过接口模糊检索
  if (!code) {
    try {
      const resp = await fetch(`/api/stocks/search?q=${encodeURIComponent(raw)}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data.list && data.list.length > 0) {
          code = data.list[0].code;
          finalName = finalName || data.list[0].name;
          document.getElementById('wlCode').value = code;
          document.getElementById('wlName').value = finalName;
        }
      }
    } catch (e) {
      console.error('Submit suggest error:', e);
    }
  }

  if (!code) {
    errEl.textContent = '无法匹配到对应股票：A股请输6位数字或中文名称，港股请输5位数字或中文名称';
    btn.disabled = false;
    btn.textContent = '➕ 确认添加';
    return;
  }

  btn.textContent = '添加中...';
  try {
    const resp = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, name: finalName, note }),
    });
    const data = await resp.json();
    if (!resp.ok) { errEl.textContent = data.error || '添加失败'; btn.disabled = false; btn.textContent = '➕ 确认添加'; return; }
    document.getElementById('wlCode').value = '';
    document.getElementById('wlName').value = '';
    document.getElementById('wlNote').value = '';
    const suggestBox = document.getElementById('wlSuggestBox');
    if (suggestBox) suggestBox.style.display = 'none';
    await loadWatchlist(false);
  } catch (e) {
    errEl.textContent = '网络错误，请稍后重试';
  } finally {
    btn.disabled = false;
    btn.textContent = '➕ 确认添加';
    toggleWlAddPanel(false);
  }
});

// ── 自选添加面板滑动切换动画 ──────────────────────────────────
function toggleWlAddPanel(show) {
  const panel = document.getElementById('wlAddPanel');
  const btn = document.getElementById('wlAddToggleBtn');
  if (!panel || !btn) return;
  if (show) {
    btn.textContent = '－';
    if (typeof gsap !== 'undefined') {
      gsap.set(panel, { display: 'block', height: 0, autoAlpha: 0 });
      gsap.to(panel, {
        height: 'auto',
        autoAlpha: 1,
        duration: 0.35,
        ease: 'power2.out'
      });
    } else {
      panel.style.display = 'block';
    }
  } else {
    btn.textContent = '＋';
    const suggestBox = document.getElementById('wlSuggestBox');
    if (suggestBox) {
      suggestBox.innerHTML = '';
      suggestBox.style.display = 'none';
    }
    if (typeof gsap !== 'undefined') {
      gsap.to(panel, {
        height: 0,
        autoAlpha: 0,
        duration: 0.3,
        ease: 'power2.in',
        onComplete: () => {
          panel.style.display = 'none';
        }
      });
    } else {
      panel.style.display = 'none';
    }
  }
}

// 自选股添加表单展开/收折控制
document.getElementById('wlAddToggleBtn').addEventListener('click', () => {
  const panel = document.getElementById('wlAddPanel');
  const isHidden = panel.style.display === 'none' || panel.style.height === '0px';
  toggleWlAddPanel(isHidden);
});

// ── 自选股代码联想搜索 ─────────────────────────────────────────
let wlSuggestTimer = null;
const wlCodeInput = document.getElementById('wlCode');
const wlSuggestBox = document.getElementById('wlSuggestBox');

if (wlCodeInput && wlSuggestBox) {
  wlCodeInput.addEventListener('input', () => {
    const val = wlCodeInput.value.trim();
    if (wlSuggestTimer) clearTimeout(wlSuggestTimer);

    if (!val) {
      wlSuggestBox.innerHTML = '';
      wlSuggestBox.style.display = 'none';
      return;
    }

    wlSuggestTimer = setTimeout(async () => {
      try {
        const resp = await fetch(`/api/stocks/search?q=${encodeURIComponent(val)}`);
        if (!resp.ok) return;
        const data = await resp.json();
        const list = data.list || [];

        if (list.length === 0) {
          wlSuggestBox.innerHTML = '';
          wlSuggestBox.style.display = 'none';
          return;
        }

        wlSuggestBox.innerHTML = list.map(item => `
          <div class="wl-suggest-item" data-code="${escapeHtml(item.code)}" data-name="${escapeHtml(item.name)}">
            <strong>${escapeHtml(item.name)}</strong>
            <span class="s-code">${escapeHtml(item.code)}</span>
          </div>
        `).join('');
        wlSuggestBox.style.display = 'block';
      } catch (e) {
        console.error('Suggest fetch error:', e);
      }
    }, 150);
  });

  // 绑定点击列表项选择事件（采用事件委托）
  wlSuggestBox.addEventListener('click', e => {
    const item = e.target.closest('.wl-suggest-item');
    if (!item) return;
    
    const code = item.dataset.code;
    const name = item.dataset.name;

    wlCodeInput.value = code;
    document.getElementById('wlName').value = name;
    
    wlSuggestBox.innerHTML = '';
    wlSuggestBox.style.display = 'none';
    
    // 自动聚焦下一个输入框（Note 输入框）
    const noteEl = document.getElementById('wlNote');
    if (noteEl) noteEl.focus();
  });

  // 点击页面其他位置自动隐藏联想提示框
  document.addEventListener('click', e => {
    if (!e.target.closest('#wlCode') && !e.target.closest('#wlSuggestBox')) {
      wlSuggestBox.style.display = 'none';
    }
  });
}

/**
 * 智能补全证券代码格式
 * 000858       → 000858.SZ（0/2/3 开头）
 * 600036       → 600036.SH（6/688 开头）
 * 09626        → 09626.HK（5位纯数字，港股）
 * 已含后缀则原样返回
 */
function normalizeCode(raw) {
  if (!raw) return '';
  // 已包含后缀，直接返回
  if (/\.(SH|SZ|HK)$/i.test(raw)) return raw.toUpperCase();
  // 纯数字判断
  if (/^\d+$/.test(raw)) {
    if (raw.length === 6) {
      const prefix = raw[0];
      if ('69'.includes(prefix)) return raw + '.SH';      // 沪市：6xxxx / 科创：688xxx
      if ('0123'.includes(prefix)) return raw + '.SZ';   // 深市：0xxxx / 创业板：3xxxx
      return '';  // 无法判断
    }
    if (raw.length === 5) return raw + '.HK';            // 港股 5 位
    return '';
  }
  return '';
}

// Enter 快捷提交
['wlCode', 'wlName', 'wlNote'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('wlAddBtn').click();
  });
});

// ── 动态自选股组件位置挂载逻辑 ─────────────────────────────
export function adjustWatchlistPosition() {
  const comp = document.getElementById('watchlistComponent');
  const sidebar = document.getElementById('sidebarArea');
  const mobileContainer = document.getElementById('tab-watchlist');
  if (!comp || !sidebar || !mobileContainer) return;
  
  const isMobile = window.innerWidth <= 900;
  if (isMobile) {
    if (comp.parentElement !== mobileContainer) {
      mobileContainer.appendChild(comp);
    }
  } else {
    if (comp.parentElement !== sidebar) {
      sidebar.appendChild(comp);
    }
  }
}
