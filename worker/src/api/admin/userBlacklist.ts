import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { getSetting, setSetting } from '../../utils/settings';

// 读取邮箱黑名单（JSON 数组），小写归一化用于去重和匹配
async function getEmailBlacklist(env: Bindings): Promise<string[]> {
  const raw = await getSetting(env, "email_blacklist");
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((e: string) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 一键将用户（按邮箱）加入黑名单
 * POST /admin/users/blacklist  body: { email }
 */
export const addUserToBlacklist = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) {
    return c.json({ code: 400, message: "email is required" }, 400);
  }

  const list = await getEmailBlacklist(c.env);
  if (list.includes(email)) {
    return c.json({
      code: 200,
      message: "User is already in blacklist",
      data: { email, blacklisted: true },
    });
  }

  list.push(email);
  await setSetting(c.env, "email_blacklist", JSON.stringify(list));
  console.log(`[WARN] User added to email blacklist: ${email}`);

  return c.json({
    code: 200,
    message: "User added to blacklist",
    data: { email, blacklisted: true },
  });
};

/**
 * 将用户（按邮箱）移出黑名单
 * DELETE /admin/users/blacklist?email=xxx
 */
export const removeUserFromBlacklist = async (c: Context<{ Bindings: Bindings }>) => {
  const email = String(c.req.query('email') || "").trim().toLowerCase();
  if (!email) {
    return c.json({ code: 400, message: "email is required" }, 400);
  }

  const list = await getEmailBlacklist(c.env);
  const index = list.indexOf(email);
  if (index === -1) {
    return c.json({
      code: 200,
      message: "User is not in blacklist",
      data: { email, blacklisted: false },
    });
  }

  list.splice(index, 1);
  await setSetting(c.env, "email_blacklist", JSON.stringify(list));
  console.log(`[INFO] User removed from email blacklist: ${email}`);

  return c.json({
    code: 200,
    message: "User removed from blacklist",
    data: { email, blacklisted: false },
  });
};
