/**
 * notifier.ts — 收盘收益定时推送与系统通知模块
 *
 * 功能：
 *   1. 每天工作日（周一至周五）下午 16:10 自动触发收盘终盘结算并推送今日收益；
 *   2. 发送 macOS 系统原生桌面通知弹窗（带提示音）；
 *   3. 可选支持 Webhook / Bark 手机推送（通过环境变量配置）；
 *   4. 持久化记录 last_push_date 到 SQLite app_metadata，防止重复推送并具备重启自愈能力。
 */
interface PushSummaryInfo {
    date: string;
    totalMarket: number;
    totalDayPnl: number;
    totalDayPct: string;
    totalPnl: number;
    totalPnlPct: string;
    monthPnl: number;
    topWinner?: {
        name: string;
        dayPnl: number;
        pct: string;
    };
    topLoser?: {
        name: string;
        dayPnl: number;
        pct: string;
    };
}
/** 获取最新或当天的收益汇总数据 */
export declare function getPushSummaryData(dateStr?: string): PushSummaryInfo | null;
/** 发送 macOS 桌面原生弹窗通知 */
export declare function sendMacOSNotification(info: PushSummaryInfo): Promise<void>;
/** 可选发送外部 Webhook 推送（支持 Bark、飞书、企业微信等） */
export declare function sendWebhookNotification(info: PushSummaryInfo): Promise<void>;
/** 核心：执行收盘推送流程 */
export declare function sendClosingNotification(options?: {
    forceRefresh?: boolean;
}): Promise<{
    ok: boolean;
    info?: PushSummaryInfo;
    message?: string;
}>;
/**
 * 启动工作日下午 16:10 收盘定时调度器
 * 每 30 秒进行一次轻量级北京时间时钟扫描
 */
export declare function startClosingNotifier(): void;
export {};
