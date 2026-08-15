import type { Context } from "hono";
import { checkKey, extractToken } from "../../utils/security";
import { getSetting, setSetting } from "../../utils/settings";
import LogService from "../../utils/log";

// 读取邮箱黑名单（JSON 数组），小写归一化用于去重和匹配
async function getEmailBlacklist(): Promise<string[]> {
  const raw = await getSetting("email_blacklist");
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
  } catch {
    return [];
  }
}

function checkAuth(c: Context): boolean {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);
  return !!key && checkKey(key);
}

/**
 * 一键将用户（按邮箱）加入黑名单
 * POST /admin/users/blacklist  body: { email }
 */
export async function addUserToBlacklist(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  if (!email) {
    return c.json({ code: 400, message: "email is required" }, 400);
  }

  const list = await getEmailBlacklist();
  if (list.includes(email)) {
    return c.json({
      code: 200,
      message: "User is already in blacklist",
      data: { email, blacklisted: true },
    });
  }

  list.push(email);
  await setSetting("email_blacklist", JSON.stringify(list));
  LogService.warn("User added to email blacklist", { email });

  return c.json({
    code: 200,
    message: "User added to blacklist",
    data: { email, blacklisted: true },
  });
}

/**
 * 将用户（按邮箱）移出黑名单
 * DELETE /admin/users/blacklist?email=xxx
 */
export async function removeUserFromBlacklist(c: Context): Promise<Response> {
  if (!checkAuth(c)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const email = String(c.req.query("email") || "").trim().toLowerCase();
  if (!email) {
    return c.json({ code: 400, message: "email is required" }, 400);
  }

  const list = await getEmailBlacklist();
  const index = list.indexOf(email);
  if (index === -1) {
    return c.json({
      code: 200,
      message: "User is not in blacklist",
      data: { email, blacklisted: false },
    });
  }

  list.splice(index, 1);
  await setSetting("email_blacklist", JSON.stringify(list));
  LogService.info("User removed from email blacklist", { email });

  return c.json({
    code: 200,
    message: "User removed from blacklist",
    data: { email, blacklisted: false },
  });
}
