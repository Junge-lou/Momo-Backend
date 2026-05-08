import type koa from "koa";
import { getAllSettings, getSetting, setSetting } from "../../utils/settings";
import { sendTestEmail } from "../../utils/email";
import { checkKey, extractToken } from "../../utils/security";
import LogService from "../../utils/log";

const SENSITIVE_KEYS = ["admin_password", "email_password", "admin_comment_key"];

// 可配置的字段白名单
const ALLOWED_SETTINGS = [
  "site_name", "admin_email", "admin_name",
  "smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
  "allow_origin", "email_enabled",
  "reply_template", "notification_template",
  "comment_auto_approve",
  "ip_blacklist",
  "email_blacklist",
  "blogger_badge_enabled",
  "blogger_badge_text",
  "placeholder_name",
  "placeholder_email",
  "placeholder_content",
  "placeholder_url",
  "admin_comment_key",
  "admin_comment_key_enabled",
];

// 按模块分组的设置键
const SETTINGS_GROUPS: Record<string, string[]> = {
  basic: ["site_name", "admin_email", "comment_auto_approve", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"],
  email: ["smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "reply_template", "notification_template"],
  security: ["allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist"],
  account: ["admin_name"],
};

function checkAuth(ctx: koa.Context): boolean {
  const authHeader = ctx.get("Authorization");
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    ctx.status = 401;
    ctx.body = { code: 401, message: "Invalid token" };
    return false;
  }
  return true;
}

export async function getSettings(ctx: koa.Context) {
  if (!checkAuth(ctx)) return;
  const all = await getAllSettings();
  const type = ctx.query.type as string | undefined;

  // 确定要返回的键列表
  let keys: string[];
  if (type && type in SETTINGS_GROUPS) {
    keys = SETTINGS_GROUPS[type];
  } else {
    keys = ALLOWED_SETTINGS;
  }

  // 只返回白名单内的，且屏蔽敏感字段
  const filtered: Record<string, string> = {};
  for (const key of keys) {
    if (key in all) {
      filtered[key] = SENSITIVE_KEYS.includes(key) ? "" : all[key];
    }
  }
  // 始终返回 email_enabled 的默认值
  if (!("email_enabled" in filtered)) {
    filtered.email_enabled = "true";
  }

  ctx.body = { code: 200, message: "Settings fetched", data: filtered };
}

export async function updateSettings(ctx: koa.Context) {
  if (!checkAuth(ctx)) return;
  const body = ctx.request.body as Record<string, string>;
  if (!body || typeof body !== "object") {
    ctx.status = 400;
    ctx.body = { code: 400, message: "Invalid request body" };
    return;
  }

  for (const key of Object.keys(body)) {
    if (!ALLOWED_SETTINGS.includes(key) && key !== "admin_password") {
      ctx.status = 400;
      ctx.body = { code: 400, message: `Setting "${key}" is not allowed` };
      return;
    }
  }

  const smtpChanged =
    ("smtp_host" in body) || ("smtp_port" in body) ||
    ("email_user" in body) || ("email_password" in body);

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      // Bug fix: 邮箱密码为空时不覆盖已有密码
      if (key === "email_password" && String(value) === "") continue;
      await setSetting(key, String(value));
    }
  }

  LogService.info("Settings updated", Object.keys(body));

  ctx.body = {
    code: 200,
    message: "Settings updated. Some changes may require a restart to take full effect.",
    smtpChanged,
  };
}

export async function testEmail(ctx: koa.Context) {
  if (!checkAuth(ctx)) return;

  const all = await getAllSettings();
  const adminEmail = all["admin_email"] || '';
  if (!adminEmail) {
    ctx.status = 400;
    ctx.body = { code: 400, message: 'Admin email is not configured. ' };
    return;
  }

  try {
    await sendTestEmail(adminEmail);
    ctx.body = { code: 200, message: 'A test email has been sent' };
  } catch (e: any) {
    ctx.status = 400;
    ctx.body = { code: 400, message: '邮件发送失败，请检查 SMTP 配置' };
  }
}
