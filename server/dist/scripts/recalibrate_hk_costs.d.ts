/**
 * recalibrate_hk_costs.ts
 * 港股成本汇率折算与持仓盈亏历史校准脚本：
 * 1. 重新计算所有港股的真实人民币加权成本，更新 base_holdings；
 * 2. 校准历史 holdings 表中港股记录的 cost、total_pnl、total_pnl_pct；
 * 3. 重新聚合校准 daily_summary 表中的历史累计总盈亏与累计收益率；
 * 4. 触发今日行情强制刷新，生成完全匹配券商账户的最新快照。
 */
export {};
