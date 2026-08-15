import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting } from '../../utils/settings';

export const userList = async (c: Context<{ Bindings: Bindings }>) => {
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '20');
  const search = (c.req.query('search') || '').trim();
  const offset = (page - 1) * limit;

  // 按昵称/邮箱搜索（不区分大小写）
  const whereClause = search ? "WHERE LOWER(author) LIKE ? OR LOWER(email) LIKE ?" : "";
  const like = `%${search.toLowerCase()}%`;
  const searchArgs = search ? [like, like] : [];

  const totalCount = await c.env.MOMO_DB.prepare(
    `SELECT COUNT(*) as count FROM (SELECT DISTINCT author, email FROM Comment ${whereClause})`
  ).bind(...searchArgs).first<{ count: number }>();

  const { results } = await c.env.MOMO_DB.prepare(`
    SELECT
      author, email,
      COUNT(*) as commentCount,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) as approvedCount,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pendingCount,
      COALESCE(SUM(CASE WHEN status = 'deleted' THEN 1 ELSE 0 END), 0) as deletedCount,
      MIN(pub_date) as firstCommentDate,
      MAX(pub_date) as lastCommentDate
    FROM Comment
    ${whereClause}
    GROUP BY author, email
    ORDER BY commentCount DESC
    LIMIT ? OFFSET ?
  `).bind(...searchArgs, limit, offset).all();

  // 加载邮箱黑名单，标记用户是否已被拉黑
  let blacklistSet = new Set<string>();
  const blacklistStr = await getSetting(c.env, "email_blacklist");
  if (blacklistStr) {
    try {
      const list = JSON.parse(blacklistStr);
      if (Array.isArray(list)) {
        blacklistSet = new Set(list.map((e: string) => String(e).toLowerCase()));
      }
    } catch {
      // 忽略无效的黑名单数据
    }
  }

  const users = (results || []).map((u: any) => ({
    ...u,
    blacklisted: blacklistSet.has(String(u.email).toLowerCase()),
  }));

  return c.json({
    code: 200,
    message: "Users fetched successfully",
    data: {
      users,
      pagination: {
        page,
        limit,
        totalPage: Math.ceil((totalCount?.count || 0) / limit)
      }
    }
  });
};
