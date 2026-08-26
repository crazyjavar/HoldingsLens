// ── 持仓管理与交易记录 ──────────────────────────────────────
import { state } from './state.js';
import { toNum, formatDayPercent, escapeHtml } from './utils.js';
import { loadLatest } from './rendering.js';

let mgmtHoldingsList = [];  // 所有持仓加载后存入，供汇率提示用
let cachedFxRateFE   = 0.9148; // 前端缓存汇率

export async function loadMgmt() {
  const resp = await fetch('/api/base-holdings');
  if (!resp.ok) return;
  const data = await resp.json();
  mgmtHoldingsList = data.holdings || [];
  if (data.fx_rate) cachedFxRateFE = data.fx_rate;

  // 填充下拉菜单
  const sel = document.getElementById('mgmtCode');
  const cur = sel.value;
  sel.innerHTML = '<option value="">请选择持仓股票</option>' +
    mgmtHoldingsList.map(h =>
      `<option value="${escapeHtml(h.code)}">${escapeHtml(h.name)}  ${escapeHtml(h.code)}</option>`
    ).join('');
  if (cur) sel.value = cur;

  // 加载全部交易记录
  await loadAllTx();
}

async function loadAllTx() {
  const codes = mgmtHoldingsList.map(h => h.code);
  const allTx = [];
  await Promise.all(codes.map(async code => {
    const r = await fetch(`/api/transactions/${encodeURIComponent(code)}`);
    if (!r.ok) return;
    const d = await r.json();
    (d.transactions || []).forEach(t => allTx.push(t));
  }));
  // 按交易日降序排序
  allTx.sort((a, b) => b.trade_date.localeCompare(a.trade_date) || b.id - a.id);
  renderTxList(allTx.slice(0, 20)); // 最近20条
}

function renderTxList(list) {
  const tbody = document.getElementById('txTableBody');
  const empty = document.getElementById('txEmpty');
  if (!list.length) { tbody.innerHTML = ''; empty.hidden = false; return; }
  empty.hidden = true;
  const nameMap = Object.fromEntries(mgmtHoldingsList.map(h => [h.code, h.name]));
  tbody.innerHTML = list.map(tx => {
    const cls     = tx.type === 'buy' ? 'tx-buy' : 'tx-sell';
    const label   = tx.type === 'buy' ? '买入' : '卖出';
    const priceStr = tx.price.toFixed(4);
    
    // 查找该股票的今日涨跌
    const holding = state.holdings.find(h => h.code === tx.code);
    let dayPnlStr = '—';
    let dayClass = '';
    if (holding) {
      dayPnlStr = formatDayPercent(holding.dayPnlRate);
      dayClass = holding.dayPnlRate >= 0 ? 'positive' : 'negative';
    }

    return `<tr>
      <td>${escapeHtml(tx.trade_date)}</td>
      <td><span class="${cls}">${escapeHtml(nameMap[tx.code] || tx.code)}</span><br><span style="color:var(--muted);font-size:11px">${escapeHtml(tx.code)}</span></td>
      <td class="${dayClass}">${dayPnlStr}</td>
      <td class="${cls}">${label}</td>
      <td>${tx.quantity}</td>
      <td>${priceStr}</td>
      <td>¥${tx.amount_cny.toFixed(2)}</td>
      <td style="color:var(--muted)">${escapeHtml(tx.note || '—')}</td>
      <td><button class="tx-undo-btn" data-id="${tx.id}" onclick="undoTx(this)">撤销</button></td>
    </tr>`;
  }).join('');
}

// 供内联 onclick="undoTx(this)" 调用（ES Module 需显式挂到 window）
export async function undoTx(btn) {
  const id = btn.dataset.id;
  const bh = mgmtHoldingsList.find(h => {
    // 通过表格行找 code
    const row = btn.closest('tr');
    const codeTd = row.cells[1].innerText.split('\n')[1];
    return h.code === codeTd;
  });
  const label = bh ? bh.name : '该股票';
  if (!confirm(`确认撤销这笔交易？持仓数据将回放重算。`)) return;
  btn.disabled = true;
  try {
    const resp = await fetch(`/api/transactions/${id}`, { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) { alert(data.error || '撤销失败'); btn.disabled = false; return; }
    await Promise.all([loadMgmt(), loadLatest()]);
  } catch (e) { alert('网络错误'); btn.disabled = false; }
}
window.undoTx = undoTx;

// 实时换算提示
function updateMgmtHint() {
  const code = document.getElementById('mgmtCode').value;
  const qty  = parseFloat(document.getElementById('mgmtQty').value);
  const amt  = parseFloat(document.getElementById('mgmtAmt').value);
  const hint = document.getElementById('mgmtHint');
  if (!code || !(qty > 0) || !(amt > 0)) { hint.textContent = ''; return; }
  if (code.endsWith('.HK')) {
    const priceHKD = amt / cachedFxRateFE / qty;
    hint.textContent = `≈ ${priceHKD.toFixed(3)} HKD/股（汇率 ${cachedFxRateFE.toFixed(4)}）`;
  } else {
    const priceCNY = amt / qty;
    hint.textContent = `= ${priceCNY.toFixed(3)} 元/股`;
  }
}
['mgmtCode','mgmtQty','mgmtAmt'].forEach(id =>
  document.getElementById(id).addEventListener('input', updateMgmtHint)
);

// 默认日期 = 今天
document.getElementById('mgmtDate').value = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });

// 提交交易
document.getElementById('mgmtSubmit').addEventListener('click', async () => {
  const code = document.getElementById('mgmtCode').value;
  const type = document.getElementById('mgmtType').value;
  const date = document.getElementById('mgmtDate').value;
  const qty  = document.getElementById('mgmtQty').value;
  const amt  = document.getElementById('mgmtAmt').value;
  const note = document.getElementById('mgmtNote').value.trim();
  const errEl = document.getElementById('mgmtErr');
  const btn   = document.getElementById('mgmtSubmit');
  errEl.textContent = '';
  if (!code) { errEl.textContent = '请选择证券'; return; }
  if (!date) { errEl.textContent = '请选择交易日期'; return; }
  if (!(Number(qty) > 0)) { errEl.textContent = '股数必须大于 0'; return; }
  if (!(Number(amt) > 0)) { errEl.textContent = '金额必须大于 0'; return; }
  btn.disabled = true; btn.textContent = '提交中...';
  try {
    const resp = await fetch('/api/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, type, trade_date: date, quantity: Number(qty), amount_cny: Number(amt), note }),
    });
    const data = await resp.json();
    if (!resp.ok) { errEl.textContent = data.error || '提交失败'; return; }
    // 清空输入
    document.getElementById('mgmtQty').value  = '';
    document.getElementById('mgmtAmt').value  = '';
    document.getElementById('mgmtNote').value = '';
    document.getElementById('mgmtHint').textContent = '';
    // 刷新持仓 + 交易记录
    await Promise.all([loadMgmt(), loadLatest()]);
  } catch (e) {
    errEl.textContent = '网络错误';
  } finally {
    btn.disabled = false; btn.textContent = '✓ 确认记录';
  }
});
