import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Comment 表 — 与 Prisma 生成的表结构保持一致
 * 表名 "Comment" 必须加引号（SQLite 大小写敏感）
 */
export const comments = sqliteTable(
  "Comment",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    pub_date: text("pub_date").notNull().default("datetime('now')"),
    post_slug: text("post_slug").notNull(),
    author: text("author").notNull(),
    email: text("email").notNull(),
    url: text("url"),
    ip_address: text("ip_address"),
    device: text("device"),
    browser: text("browser"),
    os: text("os"),
    user_agent: text("user_agent"),
    content_text: text("content_text").notNull(),
    content_html: text("content_html").notNull(),
    parent_id: integer("parent_id"),
    status: text("status").notNull().default("pending"),
  },
  (table) => ({
    postSlugIdx: index("idx_post_slug").on(table.post_slug),
    statusIdx: index("idx_status").on(table.status),
  })
);

/**
 * Settings 表 — 键值对配置存储
 */
export const settings = sqliteTable("Settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updated_at: text("updated_at").notNull().default("datetime('now')"),
});
