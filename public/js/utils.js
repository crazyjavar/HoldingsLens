// ── 格式化工具 ─────────────────────────────────────────
import { state } from './state.js';

export const numberFormatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });
export const moneyFormatter  = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', maximumFractionDigits: 2 });
export const priceFormatter  = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 4 });

export function formatPercent(value) {
  return `${Number(value).toFixed(2)}%`;
}

export function formatDayPercent(value) {
  const num = typeof value === 'string' ? toNum(value) : Number(value);
  const factor = 1000;
  const truncated = Math.trunc(num * factor) / factor;
  return `${truncated.toFixed(3)}%`;
}

export function toNum(str) {
  if (!str || str === '-') return 0;
  return parseFloat(String(str).replace(/[%,]/g, '')) || 0;
}

// 所有写入 innerHTML 的外部数据必须先转义，同时适用于文本和引号包裹的属性值。
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

export function classify(name, code) {
  if (name.includes('医疗') || name.includes('医药')) return '医药健康';
  if (name.includes('互联') || name.includes('互联网') || name.includes('恒指科技')) return '互联网科技ETF';
  if (code.endsWith('.HK') || name.includes('-W')) return '港股个股';
  if (name.includes('证券')) return '金融ETF';
  return '其他';
}

// ── 历史日期工具（收益日历只处理 YYYY-MM-DD）─────────────────
// 统一使用 UTC 日历坐标，避免浏览器所在时区将东八区零点解析成前一天。
export function ymdToUtcDate(dateText) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function utcDateToYmd(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

export function addCalendarDays(dateText, days) {
  const date = ymdToUtcDate(dateText);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateToYmd(date);
}

export function mondayIndex(dateText) {
  return (ymdToUtcDate(dateText).getUTCDay() + 6) % 7;
}

export function weekStartKey(dateText) {
  return addCalendarDays(dateText, -mondayIndex(dateText));
}

export function monthEndKey(monthKey) {
  const [year, month] = monthKey.split('-').map(Number);
  return utcDateToYmd(new Date(Date.UTC(year, month, 0)));
}

export function historyValueDisplay(value, isAmt) {
  if (isAmt && state.hideValues) return '¥****';
  return isAmt
    ? `${value >= 0 ? '+' : ''}${Math.round(value).toLocaleString('zh-CN')}`
    : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function historyValueTitle(label, value, isAmt, prefix = '盈亏') {
  if (isAmt && state.hideValues) return `${label} ${prefix} ¥****`;
  const display = historyValueDisplay(value, isAmt);
  return `${label} ${isAmt ? `${prefix} ${display} 元` : `收益率 ${display}`}`;
}
