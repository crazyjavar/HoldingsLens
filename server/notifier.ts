/**
 * notifier.ts — 收盘收益定时推送与系统通知模块
 * 
 * 功能：
 *   1. 每天工作日（周一至周五）下午 16:10 自动触发收盘终盘结算并推送今日收益；
 *   2. 发送 macOS 系统原生桌面通知弹窗（带提示音）；
 *   3. 可选支持 Webhook / Bark 手机推送（通过环境变量配置）；
 *   4. 持久化记录 last_push_date 到 SQLite app_metadata，防止重复推送并具备重启自愈能力。
 */

import { execFile } from 'node:child_process';
import { db, beijingParts, beijingDate } from './db.js';
import { refreshHoldings } from './refresh.js';
import type { DailySummary, HoldingRow, SumRow, AppMetadata } from './types.js';

interface PushSummaryInfo {
  date: string;
  totalMarket: number;
  totalDayPnl: number;
  totalDayPct: string;
  totalPnl: number;
  totalPnlPct: string;
  monthPnl: number;
  topWinner?: { name: string; dayPnl: number; pct: string };
  topLoser?: { name: string; dayPnl: number; pct: string };
}

/** 格式化金额显示，如 +¥3,151.28 或 -¥1,200.50 */
function formatMoney(num: number): string {
  const sign = num > 0 ? '+' : (num < 0 ? '-' : '');
  const absStr = Math.abs(num).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}¥${absStr}`;
}

/** 获取最新或当天的收益汇总数据 */
export function getPushSummaryData(dateStr?: string): PushSummaryInfo | null {
  const targetDate = dateStr || beijingDate();
  
  // 查找当天的 daily_summary，若当天还没有则取历史最新一天
  let summary = db.prepare<DailySummary>('SELECT * FROM daily_summary WHERE date = ?').get(targetDate);
  let effectiveDate = targetDate;
  if (!summary) {
    const latestRow = db.prepare<{ date: string }>('SELECT date FROM daily_summary ORDER BY date DESC LIMIT 1').get();
    if (latestRow) {
      effectiveDate = latestRow.date;
      summary = db.prepare<DailySummary>('SELECT * FROM daily_summary WHERE date = ?').get(effectiveDate);
    }
  }

  if (!summary) return null;

  // 当月盈亏汇总
  const monthPrefix = effectiveDate.slice(0, 7) + '-%';
  const monthPnlRow = db.prepare<SumRow>(
    'SELECT SUM(total_day_pnl) AS month_pnl FROM daily_summary WHERE date LIKE ?'
  ).get(monthPrefix);
  const monthPnl = monthPnlRow?.month_pnl ?? 0;

  // 查询当天各持仓盈亏贡献排名
  const holdings = db.prepare<HoldingRow>(
    'SELECT * FROM holdings WHERE date = ? ORDER BY day_pnl DESC'
  ).all(effectiveDate);

  let topWinner: PushSummaryInfo['topWinner'];
  let topLoser: PushSummaryInfo['topLoser'];

  if (holdings.length > 0) {
    const first = holdings[0];
    const last = holdings[holdings.length - 1];
    if (first && (first.day_pnl ?? 0) > 0) {
      topWinner = {
        name: first.name,
        dayPnl: first.day_pnl ?? 0,
        pct: first.day_pnl_pct || '0.00%',
      };
    }
    if (last && (last.day_pnl ?? 0) < 0) {
      topLoser = {
        name: last.name,
        dayPnl: last.day_pnl ?? 0,
        pct: last.day_pnl_pct || '0.00%',
      };
    }
  }

  return {
    date: effectiveDate,
    totalMarket: summary.total_market ?? 0,
    totalDayPnl: summary.total_day_pnl ?? 0,
    totalDayPct: summary.total_day_pct || '0.00%',
    totalPnl: summary.total_pnl ?? 0,
    totalPnlPct: summary.total_pnl_pct || '0.00%',
    monthPnl: Math.round(monthPnl * 100) / 100,
    topWinner,
    topLoser,
  };
}

/** 发送 macOS 桌面原生弹窗通知 */
export function sendMacOSNotification(info: PushSummaryInfo): Promise<void> {
  return new Promise((resolve) => {
    const pnlSign = info.totalDayPnl >= 0 ? '🔴' : '🟢';
    const dayPnlStr = formatMoney(info.totalDayPnl);
    const dayPctStr = info.totalDayPct.startsWith('-') || info.totalDayPct.startsWith('+')
      ? info.totalDayPct
      : (info.totalDayPnl >= 0 ? `+${info.totalDayPct}` : `-${info.totalDayPct}`);

    const title = '📈 HoldingsLens 收盘战报';
    const subtitle = `${pnlSign} 今日盈亏: ${dayPnlStr} (${dayPctStr})`;

    let msgLines = [
      `总市值: ${formatMoney(info.totalMarket).replace('+', '')} | 本月: ${formatMoney(info.monthPnl)}`,
    ];
    if (info.topWinner) {
      msgLines.push(`领涨: ${info.topWinner.name} (${info.topWinner.pct})`);
    } else if (info.topLoser) {
      msgLines.push(`回撤: ${info.topLoser.name} (${info.topLoser.pct})`);
    }

    const message = msgLines.join('  ');

    // 转义双引号避免 AppleScript 语法注入
    const cleanSubtitle = subtitle.replace(/"/g, '\\"');
    const cleanMessage = message.replace(/"/g, '\\"');
    const script = `display notification "${cleanMessage}" with title "${title}" subtitle "${cleanSubtitle}" sound name "Glass"`;

    execFile('osascript', ['-e', script], (err) => {
      if (err) {
        console.warn('[notifier] macOS 原生桌面通知发送失败:', err.message);
      } else {
        console.log('[notifier] ✅ macOS 原生桌面通知已弹出:', subtitle);
      }
      resolve();
    });
  });
}

/** 可选发送外部 Webhook 推送（支持 Bark、飞书、企业微信等） */
export async function sendWebhookNotification(info: PushSummaryInfo): Promise<void> {
  const webhookUrl = process.env.PUSH_WEBHOOK_URL || process.env.BARK_URL;
  if (!webhookUrl) return;

  const dayPnlStr = formatMoney(info.totalDayPnl);
  const title = `📈 今日收盘战报: ${dayPnlStr} (${info.totalDayPct})`;
  const body = [
    `日期: ${info.date}`,
    `总市值: ${formatMoney(info.totalMarket).replace('+', '')}`,
    `今日盈亏: ${dayPnlStr} (${info.totalDayPct})`,
    `本月盈亏: ${formatMoney(info.monthPnl)}`,
    `累计盈亏: ${formatMoney(info.totalPnl)} (${info.totalPnlPct})`,
    info.topWinner ? `领涨标的: ${info.topWinner.name} (${info.topWinner.pct})` : '',
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        body,
        // Bark 兼容字段
        group: 'HoldingsLens',
        sound: 'glass',
      }),
    });
    console.log(`[notifier] Webhook 推送完成，响应状态: ${res.status}`);
  } catch (err: unknown) {
    console.warn('[notifier] Webhook 推送失败:', (err as Error).message);
  }
}

/** 核心：执行收盘推送流程 */
export async function sendClosingNotification(options: { forceRefresh?: boolean } = {}): Promise<{ ok: boolean; info?: PushSummaryInfo; message?: string }> {
  const { forceRefresh = true } = options;

  try {
    // 1. 如果需要，强制刷新一次最新终盘行情并写库
    if (forceRefresh) {
      console.log('[notifier] 开始执行收盘终盘行情拉取与快照更新...');
      await refreshHoldings({ force: true });
    }

    // 2. 获取汇总数据
    const info = getPushSummaryData();
    if (!info) {
      console.warn('[notifier] 未获取到当天的收盘汇总数据，取消推送');
      return { ok: false, message: '未获取到收盘数据' };
    }

    // 3. 发送 macOS 桌面通知
    await sendMacOSNotification(info);

    // 4. 发送 Webhook（如果配置）
    await sendWebhookNotification(info);

    return { ok: true, info };
  } catch (err: unknown) {
    const errMsg = (err as Error).message;
    console.error('[notifier] 收盘推送执行异常:', errMsg);
    return { ok: false, message: errMsg };
  }
}

/** 检查数据库中记录的今天是否已推送 */
function hasPushedToday(dateStr: string): boolean {
  const row = db.prepare<AppMetadata>("SELECT value FROM app_metadata WHERE key = 'last_closing_push_date'").get();
  return row?.value === dateStr;
}

/** 记录今日已推送标记 */
function markPushedToday(dateStr: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO app_metadata (key, value, updated_at) VALUES ('last_closing_push_date', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(dateStr, now);
}

/**
 * 启动工作日下午 16:10 收盘定时调度器
 * 每 30 秒进行一次轻量级北京时间时钟扫描
 */
export function startClosingNotifier(): void {
  console.log('[notifier] ⏰ 收盘收益定时推送守护器已启动 (工作日 16:10 自动触发)');

  setInterval(async () => {
    const bj = beijingParts();
    // 0=周日, 6=周六
    const isWeekday = bj.day >= 1 && bj.day <= 5;
    if (!isWeekday) return;

    // 工作日下午 16:10 触发（在 16:10 ~ 16:20 窗口内检查）
    const totalMinutes = bj.hours * 60 + bj.minutes;
    const isTargetTime = totalMinutes >= 16 * 60 + 10 && totalMinutes <= 16 * 60 + 20;

    if (!isTargetTime) return;

    const today = beijingDate();
    if (hasPushedToday(today)) return;

    // 标记已推送，防止并发或下个 30 秒重复触发
    markPushedToday(today);
    console.log(`[notifier] 🔔 工作日收盘时间到达 (16:10)，触发今日 (${today}) 收益推送！`);

    await sendClosingNotification({ forceRefresh: true });
  }, 30 * 1000);
}
