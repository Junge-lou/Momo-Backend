import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { parseMarkdown } from '../../utils/markdown';

export const updateComment = async (c: Context<{ Bindings: Bindings }>) => {
  const body = await c.req.json();
  const { id, ...fields } = body;

  if (!id) {
    return c.json({
      code: 400,
      message: "Invalid request parameters"
    }, 400);
  }

  // 只改了 content_text 但没传 content_html 时，自动渲染 markdown
  if (fields.content_text !== undefined && fields.content_html === undefined) {
    fields.content_html = parseMarkdown(fields.content_text);
  }

  const allowed = ['author', 'email', 'content_text', 'content_html', 'url'];
  const sets: string[] = [];
  const values: any[] = [];

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }

  if (sets.length === 0) {
    return c.json({
      code: 400,
      message: "No fields to update"
    }, 400);
  }

  values.push(id);
  const query = `UPDATE Comment SET ${sets.join(', ')} WHERE id = ?`;
  const { success } = await c.env.MOMO_DB.prepare(query).bind(...values).run();

  if (!success) {
    return c.json({
      code: 500,
      message: "Update failed"
    }, 500);
  }

  return c.json({
    code: 200,
    message: "Comment updated"
  });
};
