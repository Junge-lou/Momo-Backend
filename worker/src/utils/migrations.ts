import { Bindings } from '../bindings';

/**
 * 幂等启动自迁移（C7）。
 *
 * 约定：
 *  - 迁移只在首次出现时执行一次，执行记录写入 `SchemaMigration` 表；
 *  - `id` 一旦发布不可修改（改动等于新增一条迁移）；
 *  - 这里只放**非破坏性**迁移（数据归一化、补索引等）。
 *    需要重建表的结构变更（例如修改列默认值）请在 `doc/migrations/` 下提供一次性 SQL 脚本，
 *    由部署者按文档手工执行。
 */
type Migration = {
  id: string;
  description: string;
  statements: string[];
};

const MIGRATIONS: Migration[] = [
  {
    id: '0001_pub_date_to_millis',
    description: '将 pub_date 从 ISO 字符串统一为毫秒整数（与 Node/Go 对齐）',
    statements: [
      `UPDATE Comment
         SET pub_date = CASE
             WHEN pub_date NOT GLOB '*[^0-9]*' AND CAST(pub_date AS INTEGER) > 0
               THEN CAST(pub_date AS INTEGER)
             WHEN CAST(strftime('%s', pub_date) AS INTEGER) > 0
               THEN CAST(strftime('%s', pub_date) AS INTEGER) * 1000
             ELSE pub_date
           END
         WHERE typeof(pub_date) = 'text'`,
    ],
  },
  {
    /**
     * 认证记录表（VerifyRecord）。
     *
     * 与 schemas/comment.sql 里的定义逐字一致：新库用那份建表，已部署的 D1
     * 靠这条迁移补齐。纯 CREATE ... IF NOT EXISTS，非破坏性，可安全自动执行。
     */
    id: '0002_verify_record_table',
    description: '新增 VerifyRecord 表：评论无感验证的认证记录',
    statements: [
      `CREATE TABLE IF NOT EXISTS VerifyRecord (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         created_at INTEGER NOT NULL,
         event TEXT NOT NULL,
         reason TEXT,
         elapsed_ms INTEGER,
         difficulty INTEGER,
         challenge_id TEXT,
         post_slug TEXT,
         ip_address TEXT,
         country TEXT,
         network TEXT,
         asn INTEGER
       )`,
      `CREATE INDEX IF NOT EXISTS idx_vr_created ON VerifyRecord(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_vr_event ON VerifyRecord(event)`,
      `CREATE INDEX IF NOT EXISTS idx_vr_cid ON VerifyRecord(challenge_id)`,
    ],
  },
  {
    /**
     * 来源域名绑定：认证明细增加来源域名列。
     *
     * 与 schemas/comment.sql 里的定义一致：新库由那份 DDL 直接建出该列，
     * 已部署的 D1 靠这条迁移补齐。纯新增列，旧行为 NULL。
     */
    id: '0003_verify_record_origin',
    description: 'VerifyRecord 增加 origin 列（来源域名绑定：记录解题/被拒的来源域名）',
    statements: [`ALTER TABLE VerifyRecord ADD COLUMN origin TEXT`],
  },
];

const SCHEMA_MIGRATION_DDL = `
  CREATE TABLE IF NOT EXISTS SchemaMigration (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`;

// 同一 isolate 内只跑一次；失败后置空，下个请求重试
let migrationPromise: Promise<void> | null = null;

async function runMigrations(env: Bindings): Promise<void> {
  // Worker 的表结构需要部署者先执行 schemas/comment.sql。
  // 表还不存在时直接跳过，避免每个请求都跑一遍注定失败的批量语句。
  const commentTable = await env.MOMO_DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'Comment'"
  ).first<{ name: string }>();
  if (!commentTable) {
    console.warn('[migration] Comment 表不存在，请先执行 schemas/comment.sql；本次跳过迁移');
    return;
  }

  await env.MOMO_DB.prepare(SCHEMA_MIGRATION_DDL).run();

  const { results } = await env.MOMO_DB.prepare(
    'SELECT id FROM SchemaMigration'
  ).all<{ id: string }>();
  const applied = new Set((results || []).map((row) => row.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    const record = env.MOMO_DB.prepare(
      'INSERT INTO SchemaMigration (id, description) VALUES (?, ?)'
    ).bind(migration.id, migration.description);

    try {
      // D1 batch 是事务性的：迁移语句与记录要么全部生效，要么全部回滚
      await env.MOMO_DB.batch([
        ...migration.statements.map((sql) => env.MOMO_DB.prepare(sql)),
        record,
      ]);
    } catch (e) {
      // 新库由 schemas/comment.sql 一次性建出全部列，随后的「补列」迁移会撞上
      // duplicate column name —— 那说明目标状态已经达成，按已应用处理，
      // 否则每个 isolate 都会重复报错、永远记不上这条迁移。
      // 此时改用逐条执行并容忍该错误（batch 是事务性的，整体回滚后重来一次即可）。
      if (!isDuplicateColumnError(e)) throw e;
      for (const sql of migration.statements) {
        try {
          await env.MOMO_DB.prepare(sql).run();
        } catch (inner) {
          if (!isDuplicateColumnError(inner)) throw inner;
        }
      }
      await record.run();
    }

    console.log(`[migration] applied ${migration.id}: ${migration.description}`);
  }
}

/** 是否是「列已存在」错误（SQLite / D1 的文案：duplicate column name: xxx） */
function isDuplicateColumnError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /duplicate column name/i.test(message);
}

/**
 * 确保迁移已执行。失败不阻断请求（记录日志并在下个请求重试），
 * 避免一条坏迁移让整站不可用。
 */
export function ensureMigrated(env: Bindings): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = runMigrations(env).catch((e) => {
      console.error('[migration] failed, will retry on next request:', e);
      migrationPromise = null;
    });
  }
  return migrationPromise;
}
