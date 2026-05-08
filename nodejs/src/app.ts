import "dotenv/config";
import Koa from "koa";
import bodyParser from "@koa/bodyparser"
import serve from "koa-static";
import path from "path";

import corsMiddleware  from "./middleware/cors";
import routerMiddleware from "./middleware/routes";
import LogService from "./utils/log";

const app = new Koa();
app.use(serve(path.join(__dirname, "../public")));

// 全局错误处理 — 防止内部错误泄露
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err: any) {
    LogService.error("Unhandled error", err);
    ctx.status = err.status || 500;
    ctx.body = { code: ctx.status, message: "Internal server error" };
  }
});

app.use(corsMiddleware)
   .use(bodyParser())
   .use(routerMiddleware.routes())
   .use(routerMiddleware.allowedMethods());

const port = process.env.PORT || '3000';
app.listen(port);

console.log(`Server running on http://localhost:${port}`);
