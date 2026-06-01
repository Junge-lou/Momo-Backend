import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken, sanitizeHtml } from "../../utils/security";
import { parseMarkdown } from "../../utils/markdown";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const body = await c.req.json();
  const id = body?.id;

  if (!id) {
    return c.json({ code: 400, message: "Invalid request parameters" }, 400);
  }

  const allowed = ["author", "email", "content_text", "content_html", "url"];
  const fields: Record<string, any> = {};
  for (const key of allowed) {
    if (body[key] !== undefined) {
      fields[key] = body[key];
    }
  }

  if (Object.keys(fields).length === 0) {
    return c.json({ code: 400, message: "No fields to update" }, 400);
  }

  // 只改了 content_text 但没传 content_html 时，自动渲染 markdown
  if (fields.content_text !== undefined && fields.content_html === undefined) {
    fields.content_html = sanitizeHtml(await parseMarkdown(fields.content_text));
  }

  await CommentService.updateComment(id, fields);

  return c.json({ code: 200, message: "Comment updated" });
};
