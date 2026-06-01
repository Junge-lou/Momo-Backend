import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { getQueryNumber, getQueryString } from "../../utils/url";
import { checkKey, extractToken } from "../../utils/security";

export default async (c: Context): Promise<Response> => {
  const commentId = getQueryNumber(c.req.query("id"), 0);
  const status = getQueryString(c.req.query("status"), "pending");
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  await CommentService.updateCommentStatus(commentId, status);

  return c.json({ code: 200, message: `Comment status updated` });
};
