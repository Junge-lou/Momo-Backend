import type koa from "koa";
import { CommentsModel } from "../../orm/prisma";
import { setSetting } from "../../utils/settings";
import { checkKey, extractToken } from "../../utils/security";
import LogService from "../../utils/log";

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

// 导入评论数据
export async function importComments(ctx: koa.Context) {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as { comments: Record<string, any>[] };
  if (!body?.comments || !Array.isArray(body.comments)) {
    ctx.status = 400;
    ctx.body = { code: 400, message: "请求体须包含 comments 数组" };
    return;
  }

  let imported = 0;
  const errors: string[] = [];

  for (let i = 0; i < body.comments.length; i++) {
    const c = body.comments[i];
    try {
      if (!c.postSlug && !c.post_slug) { errors.push(`第 ${i + 1} 条缺少 postSlug`); continue; }
      if (!c.author) { errors.push(`第 ${i + 1} 条缺少 author`); continue; }
      if (!c.email) { errors.push(`第 ${i + 1} 条缺少 email`); continue; }
      if (!c.contentText && !c.content_text) { errors.push(`第 ${i + 1} 条缺少 contentText`); continue; }

      const data: Record<string, any> = {
        post_slug: c.postSlug || c.post_slug,
        author: c.author,
        email: c.email,
        content_text: c.contentText || c.content_text,
        content_html: c.contentHtml || c.content_html || c.contentText || c.content_text,
      };

      if (c.url) data.url = c.url;
      if (c.ip_address || c.ipAddress) data.ip_address = c.ip_address || c.ipAddress;
      if (c.os) data.os = c.os;
      if (c.browser) data.browser = c.browser;
      if (c.user_agent) data.user_agent = c.user_agent;
      if (c.parent_id || c.parentId) data.parent_id = c.parent_id || c.parentId;
      if (c.status) data.status = c.status;
      if (c.pub_date || c.pubDate) data.pub_date = new Date(c.pub_date || c.pubDate);

      await (CommentsModel as any).create({ data });
      imported++;
    } catch (e: any) {
      LogService.error(`Import failed for comment #${i + 1}`, e);
      errors.push(`第 ${i + 1} 条导入失败，请检查数据格式`);
    }
  }

  LogService.info(`Data import completed: ${imported} comments imported`);

  ctx.body = {
    code: 200,
    message: `导入完成，成功 ${imported} 条${errors.length ? `，失败 ${errors.length} 条` : ''}`,
    data: { imported, errors: errors.length > 0 ? errors : undefined },
  };
}

// 导入系统设置
export async function importSettings(ctx: koa.Context) {
  if (!checkAuth(ctx)) return;

  const body = ctx.request.body as Record<string, string>;
  if (!body || typeof body !== "object") {
    ctx.status = 400;
    ctx.body = { code: 400, message: "请提供有效的设置数据" };
    return;
  }

  const allowedSettings = new Set([
    "site_name", "admin_email", "admin_name",
    "smtp_host", "smtp_port", "email_user", "email_password", "email_secure",
    "allow_origin", "email_enabled",
    "reply_template", "notification_template",
  ]);

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (allowedSettings.has(key) && value !== undefined && value !== null) {
      await setSetting(key, String(value));
      updated.push(key);
    }
  }

  LogService.info("Settings imported", updated);

  ctx.body = {
    code: 200,
    message: `设置导入完成，已更新 ${updated.length} 项`,
    data: { updated },
  };
}
