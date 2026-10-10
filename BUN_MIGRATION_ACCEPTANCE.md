# Bun 迁移验收

验收日期：2026-10-10（Asia/Shanghai）。开发基线：68199fa。分支：codex/bun-migration。

## 实现

- 服务入口使用 Bun.serve，启动与开发模式直接运行 TypeScript。
- Hono 路由与静态资源放在 app.ts，启动入口负责监听、行情定时刷新与收盘通知。
- 保留 node:sqlite 和现有表结构、交易回放逻辑，没有数据库格式迁移。
- 使用官方 @hono/bun 静态适配器、bun.lock 和 Bun 类型声明。
- 为可能较慢的行情主备请求设置 120 秒连接空闲超时。
- 保留图表实例复用、未变化数据跳过渲染、合并交易接口与独立指数缓存。

## 验收结果

Bun 1.4.2，Hono 4.13.13，@hono/bun 1.0.1。

| 检查 | 结果 |
| --- | --- |
| bun install --frozen-lockfile | 通过，锁文件无变化 |
| bun run typecheck | 通过，TypeScript 在 Bun 下运行 |
| bun run build | 通过，生产构建已更新 |
| bun run test | 10 项通过、0 项失败 |
| 源码与生产构建真实 HTTP | 均通过，主页、JS、CSS、SVG、中文文件路径及 404 |
| 临时 SQLite 交易写入与撤销 | 均通过，撤销后恢复原持仓数量 |
| GBK 中文解码 | 通过 |
| 通知使用的 execFile 回调接口 | 通过，仅运行 /usr/bin/true，不发送通知 |
| Bun 源码入口启动（19123） | 通过，状态与合并交易接口正常 |
| Bun 生产入口启动（19124） | 通过，状态接口与主页正常 |
| 原 Node 服务（9123） | 仍正常，实际持仓库未用于迁移验收 |

## 验收范围

HTTP 和交易验收使用临时数据库；缓存测试使用模拟行情，未向行情源发出验收请求。源码与生产入口启动检查发生在周六，启动行情刷新按原逻辑跳过。

上述独立验收完成时尚未合并分支或替换 LaunchAgent。未进行真实网络行情或交易日收盘通知的长时间验收，也未声称已取得具体性能倍数。

## 正式服务切换

2026-10-10 已将 Bun 分支合并到主工作区，安装锁定依赖，并将 `com.fei.holdings-server` LaunchAgent 改为 `/opt/homebrew/bin/bun /Users/fei/holdings-analysis/server/server.ts`。实际监听 9123 的进程为 Bun 1.4.2；主页、app.js、状态与最近交易接口均返回 200。

修正验收脚本对中文工作目录的 URL 解码，主工作区类型检查、构建和全部 10 项测试通过。数据库在线备份为 `holdings.db.before_bun_20261010_163104.backup`，旧启动配置备份为 `server/holdings-node-launchagent.plist.backup`。切换后 SQLite 完整性检查为 ok，六张业务表行数与切换前一致。
