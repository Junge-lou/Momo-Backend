import "dotenv/config";
import Koa from "koa";
import bodyParser from "@koa/bodyparser"
import serve from "koa-static";
import path from "path";

import corsMiddleware  from "./middleware/cors";
import routerMiddleware from "./middleware/routes";

const app = new Koa();
app.use(serve(path.join(__dirname, "../public")));

app.use(corsMiddleware)
   .use(bodyParser())
   .use(routerMiddleware.routes())
   .use(routerMiddleware.allowedMethods());

const port = process.env.PORT || '3000';
app.listen(port);

console.log(`Server running on http://localhost:${port}`);
