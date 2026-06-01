import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "path";
import fs from "fs";

// 解析数据库路径
const DATABASE_URL = process.env.DATABASE_URL || "file:./data/dev.db";
let dbPath = DATABASE_URL.replace(/^file:/, "");

// 如果是相对路径，相对于项目根目录解析
if (!path.isAbsolute(dbPath)) {
  dbPath = path.resolve(process.cwd(), dbPath);
}

// 确保 data 目录存在
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const sqlite = new Database(dbPath);

// 启用 WAL 模式提升并发性能
sqlite.pragma("journal_mode = WAL");

// 确保表结构存在（对新部署友好）
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS "Comment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pub_date" TEXT NOT NULL DEFAULT (datetime('now')),
    "post_slug" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "url" TEXT,
    "ip_address" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "content_text" TEXT NOT NULL,
    "content_html" TEXT NOT NULL,
    "parent_id" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "os" TEXT,
    "user_agent" TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_post_slug ON "Comment"("post_slug");
  CREATE INDEX IF NOT EXISTS idx_status ON "Comment"("status");

  CREATE TABLE IF NOT EXISTS "Settings" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updated_at" TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

export const db = drizzle(sqlite, { schema });
export { schema };
