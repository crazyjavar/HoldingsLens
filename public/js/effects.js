// ── 动画化工具与 AI 助理效果卡片 ──────────────────────────
import { state } from './state.js';
import { toNum, formatPercent, formatDayPercent, moneyFormatter } from './utils.js';

// ── 动画化工具 ───────────────────────────────────────────
export function animateNumericKpi(elementId, targetVal, startVal = 0, isPercent = false, prefix = '', isDayPercent = false) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const formatFn = isPercent ? (isDayPercent ? formatDayPercent : formatPercent) : moneyFormatter.format.bind(moneyFormatter);
  if (typeof gsap === 'undefined') {
    const valStr = formatFn(targetVal);
    el.textContent = prefix + valStr;
    return;
  }
  if (Math.abs(targetVal - startVal) < 0.001 && targetVal !== 0 && startVal !== 0) {
    const valStr = formatFn(targetVal);
    el.textContent = prefix + valStr;
    return;
  }
  const obj = { value: startVal };
  gsap.to(obj, {
    value: targetVal,
    duration: 0.8,
    ease: "power2.out",
    overwrite: "auto",
    onUpdate: () => {
      const valStr = formatFn(obj.value);
      el.textContent = prefix + valStr;
    }
  });
}

// ── AI 助理效果 ───────────────────────────────────────────
const cutePhrases = [
  '主人不要灰心嘛~ 贴贴你~ (｡♥‿♥｡)',
  '喵呜~ 虽然这次跌了，但本喵会一直陪着你的！',
  '摸摸头，仓位稳住，我们下次一定会涨回来！',
  '哼，市场坏坏！不哭不哭，有我给你抱抱！(つ✧ω✧)つ',
  '主人最棒啦，本小动物给你打气，加把劲呀！',
];
const dominatePhrases = [
  '至高主宰！收益率制霸全场，顺我者涨！',
  '雄霸天下，无可匹敌！整个市场都在为我颤抖！',
  '哈哈，本座的账户大刀早已饥渴难耐了！',
  '看我气吞万里如虎，这点涨幅只是开始！',
  '主宰一切！让利润如狂澜般飞舞吧！',
];

let canvasAnimationId = null;
let textBubbleInterval = null;

export function animateEffectSwitch() {
  if (typeof gsap === 'undefined' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  gsap.fromTo(
    ['#effectStage', '#effectBubble'],
    { autoAlpha: 0, y: 8 },
    { autoAlpha: 1, y: 0, duration: 0.35, stagger: 0.06, ease: 'power2.out', overwrite: 'auto', clearProps: 'all' }
  );
}

export function renderEffect(totalRate, dayPnl, summary) {
  const isWinning = dayPnl >= 0;
  const titleEl   = document.getElementById('effectTitle');
  const noteEl    = document.getElementById('effectNote');
  const bubbleEl  = document.getElementById('effectBubble');
  const animalEl  = document.getElementById('cuteAnimalContainer');
  const winningImg = document.getElementById('winningImg');
  const switchEl = document.getElementById('effectSwitch');
  const weeklyEl = document.getElementById('weeklyReport');
  const weekReady = Boolean(summary?.week_report_ready);

  switchEl.hidden = !weekReady;
  if (weekReady && !state.weekModeInitialized) {
    state.effectMode = 'weekly';
    state.weekModeInitialized = true;
  } else if (!weekReady) {
    state.effectMode = 'daily';
    state.weekModeInitialized = false;
  }
  switchEl.querySelectorAll('button').forEach(button => {
    button.classList.toggle('active', button.dataset.effectMode === state.effectMode);
  });

  if (textBubbleInterval) clearInterval(textBubbleInterval);
  if (canvasAnimationId)  cancelAnimationFrame(canvasAnimationId);

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];

  if (state.effectMode === 'weekly' && weekReady) {
    const weekPnl = Number(summary.week_pnl) || 0;
    const weekRate = toNum(summary.week_pnl_pct);
    const weekWinning = weekPnl >= 0;
    titleEl.textContent = weekWinning ? '本周战报：红盘收官' : '本周战报：逆风复盘';
    noteEl.textContent = `${summary.week_start.slice(5)} — ${summary.week_end.slice(5)}`;
    animalEl.classList.add('hidden');
    winningImg.style.display = 'none';
    weeklyEl.hidden = false;
    weeklyEl.className = `weekly-report ${weekWinning ? 'positive' : 'negative'}`;
    document.getElementById('weeklyReportValue').textContent = state.hideValues ? '¥****' : moneyFormatter.format(weekPnl);
    document.getElementById('weeklyReportRate').textContent = `本周收益 ${formatPercent(weekRate)}`;
    bubbleEl.textContent = weekWinning
      ? `本周累计盈利 ${state.hideValues ? '****' : moneyFormatter.format(weekPnl)}，周末好好奖励一下自己。`
      : `本周累计回撤 ${state.hideValues ? '****' : moneyFormatter.format(Math.abs(weekPnl))}，周末复盘，下周再战。`;
    return;
  }

  weeklyEl.hidden = true;

  if (isWinning) {
    titleEl.textContent = '势能：雄霸天下';
    noteEl.textContent  = '今日盈利中';
    animalEl.classList.add('hidden');
    winningImg.style.display = 'block';
    bubbleEl.textContent = pick(dominatePhrases);
    textBubbleInterval = setInterval(() => { bubbleEl.textContent = pick(dominatePhrases); }, 4000);
  } else {
    titleEl.textContent = '势能：治愈贴贴';
    noteEl.textContent  = '回撤抚慰中';
    animalEl.classList.remove('hidden');
    winningImg.style.display = 'none';
    bubbleEl.textContent = pick(cutePhrases);
    textBubbleInterval = setInterval(() => { bubbleEl.textContent = pick(cutePhrases); }, 4000);
  }
}

document.getElementById('effectSwitch').addEventListener('click', event => {
  const button = event.target.closest('[data-effect-mode]');
  if (!button) return;
  state.effectMode = button.dataset.effectMode;
  const s = state.summary;
  renderEffect(s ? toNum(s.total_pnl_pct) : 0, s ? s.total_day_pnl : 0, s);
  animateEffectSwitch();
});
