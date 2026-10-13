import type Database from "better-sqlite3";

/**
 * 建表 DDL（新库友好）。
 *
 * 这里是 Node 端**唯一**的建表语句来源：`schema.ts` 只提供 Drizzle 的查询元数据，
 * 不再手写第二份 DDL，避免两份定义漂移（C7）。
 */
const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS "Comment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pub_date" INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
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

  CREATE TABLE IF NOT EXISTS "EmailVerification" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "expires_at" TEXT NOT NULL,
    "verified" INTEGER NOT NULL DEFAULT 0,
    "post_slug" TEXT,
    "post_title" TEXT,
    "created_at" TEXT NOT NULL DEFAULT (datetime('now')),
    "verified_at" TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ev_email ON "EmailVerification"("email");
  CREATE INDEX IF NOT EXISTS idx_ev_token ON "EmailVerification"("token");

  CREATE TABLE IF NOT EXISTS "SchemaMigration" (
    "id" TEXT PRIMARY KEY,
    "description" TEXT NOT NULL DEFAULT '',
    "applied_at" TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 评论无感验证（人机验证）的认证记录，见 doc/data_table.md
  -- 纯新增表：靠 IF NOT EXISTS 在每次启动时补齐，已有数据库无需手工迁移
  CREATE TABLE IF NOT EXISTS "VerifyRecord" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created_at" INTEGER NOT NULL,
    "event" TEXT NOT NULL,
    "reason" TEXT,
    "elapsed_ms" INTEGER,
    "difficulty" INTEGER,
    "challenge_id" TEXT,
    "post_slug" TEXT,
    "ip_address" TEXT,
    "origin" TEXT,
    "country" TEXT,
    "network" TEXT,
    "asn" INTEGER
  );
  -- 写多读少：只建三个真正会被查询命中的索引（时间窗口 / 事件筛选 / 串起同一次认证）
  CREATE INDEX IF NOT EXISTS idx_vr_created ON "VerifyRecord"("created_at");
  CREATE INDEX IF NOT EXISTS idx_vr_event ON "VerifyRecord"("event");
  CREATE INDEX IF NOT EXISTS idx_vr_cid ON "VerifyRecord"("challenge_id");
`;

/**
 * 幂等启动自迁移（C7）。
 *
 * 约定：
 *  - 迁移只在首次出现时执行一次，执行记录写入 `SchemaMigration` 表；
 *  - `id` 一旦发布不可修改（改动等于新增一条迁移）；
 *  - 这里只放**非破坏性**迁移（数据归一化、补索引等）。需要重建表的结构变更
 *    （例如修改列默认值）请见 `doc/migrations/` 下的一次性 SQL 脚本。
 */
type Migration = {
  id: string;
  description: string;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  {
    id: "0001_pub_date_to_millis",
    description: "将 pub_date 从 ISO 字符串统一为毫秒整数（与 Go/Worker 对齐）",
    sql: `
      UPDATE "Comment"
         SET "pub_date" = CASE
             WHEN "pub_date" NOT GLOB '*[^0-9]*' AND CAST("pub_date" AS INTEGER) > 0
               THEN CAST("pub_date" AS INTEGER)
             WHEN CAST(strftime('%s', "pub_date") AS INTEGER) > 0
               THEN CAST(strftime('%s', "pub_date") AS INTEGER) * 1000
             ELSE "pub_date"
           END
         WHERE typeof("pub_date") = 'text';
    `,
  },
  {
    id: "0002_verify_record_origin",
    description: "VerifyRecord 增加 origin 列（来源域名绑定：记录解题/被拒的来源域名）",
    // 纯新增列，旧行为 NULL；新库由 SCHEMA_DDL 直接建出该列
    sql: `ALTER TABLE "VerifyRecord" ADD COLUMN "origin" TEXT;`,
  },
];

/**
 * 初始化数据库：建表 + 执行未应用的自迁移。
 * 单条迁移失败只记录日志、不阻断启动，避免一条坏迁移让服务起不来。
 */
export function initializeDatabase(sqlite: Database.Database): void {
  sqlite.exec(SCHEMA_DDL);

  const appliedRows = sqlite
    .prepare(`SELECT "id" FROM "SchemaMigration"`)
    .all() as { id: string }[];
  const applied = new Set(appliedRows.map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    try {
      const run = sqlite.transaction(() => {
        try {
          sqlite.exec(migration.sql);
        } catch (error) {
          // 新库由 SCHEMA_DDL 一次性建出全部列，随后的「补列」迁移会撞上
          // duplicate column name —— 那说明目标状态已经达成，按已应用处理，
          // 否则每次启动都会重复报错。
          const message = error instanceof Error ? error.message : String(error);
          if (!/duplicate column name/i.test(message)) throw error;
        }
        sqlite
          .prepare(`INSERT INTO "SchemaMigration" ("id", "description") VALUES (?, ?)`)
          .run(migration.id, migration.description);
      });
      run();
      console.log(`[migration] applied ${migration.id}: ${migration.description}`);
    } catch (error) {
      console.error(`[migration] failed ${migration.id}:`, error);
    }
  }
}
