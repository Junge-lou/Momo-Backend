import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryNumber } from "../../utils/url";
import { checkKey, extractToken } from "../../utils/security";

export default async (c: Context): Promise<Response> => {
  const deleteId = getQueryNumber(c.req.query("id"), 0);
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  await CommentService.deleteComment(deleteId);

  return c.json({ message: "Comment deleted, id: " + deleteId + "." });
};
