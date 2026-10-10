/** Hono 应用：仅注册路由，不启动监听、定时刷新或通知。 */
import { Hono } from 'hono';
declare const app: Hono<import("hono/types").BlankEnv, import("hono/types").BlankSchema, "/">;
export default app;
