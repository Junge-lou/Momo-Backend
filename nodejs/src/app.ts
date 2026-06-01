import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import path from "path";
import fs from "fs";

import corsMiddleware from "./middleware/cors";
import router from "./middleware/routes";
import LogService from "./utils/log";

const app = new Hono();

// 全局错误处理 — 防止内部错误泄露
app.onError((err, c) => {
  LogService.error("Unhandled error", err);
  return c.json({ code: 500, message: "Internal server error" }, 500);
});

// CORS
app.use("*", corsMiddleware);

// 静态文件 — 管理面板构建产物
app.use("/*", serveStatic({ root: "./public" }));

// API 路由（在静态文件之后，优先于 SPA fallback）
app.route("/", router);

// SPA fallback — 管理面板前端路由
app.get("*", async (c) => {
  const htmlPath = path.join(process.cwd(), "public", "index.html");
  if (fs.existsSync(htmlPath)) {
    return c.html(fs.readFileSync(htmlPath, "utf-8"));
  }
  return c.notFound();
});

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port });

console.log(`Server running on http://localhost:${port}`);
