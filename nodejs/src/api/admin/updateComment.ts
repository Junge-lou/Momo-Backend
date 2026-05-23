import type koa from "koa";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken, sanitizeHtml } from "../../utils/security";
import { parseMarkdown } from "../../utils/markdown";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const authHeader = ctx.get("Authorization");
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    ctx.status = 401;
    ctx.body = {
      code: 401,
      message: "Invalid token"
    };
    return;
  }

  const body = ctx.request.body as any;
  const id = body?.id;

  if (!id) {
    ctx.status = 400;
    ctx.body = {
      code: 400,
      message: "Invalid request parameters"
    };
    return;
  }

  const allowed = ['author', 'email', 'content_text', 'content_html', 'url'];
  const fields: Record<string, any> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields[key] = body[key];
    }
  }

  if (Object.keys(fields).length === 0) {
    ctx.status = 400;
    ctx.body = {
      code: 400,
      message: "No fields to update"
    };
    return;
  }

  // 只改了 content_text 但没传 content_html 时，自动渲染 markdown
  if (fields.content_text !== undefined && fields.content_html === undefined) {
    fields.content_html = sanitizeHtml(await parseMarkdown(fields.content_text));
  }

  await CommentService.updateComment(id, fields);

  ctx.body = {
    code: 200,
    message: "Comment updated"
  };
};
