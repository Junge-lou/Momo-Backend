import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken } from "../../utils/security";
import { getQueryNumber } from "../../utils/url";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const page = getQueryNumber(c.req.query("page"), 1);
  const limit = getQueryNumber(c.req.query("limit"), 20);

  const result = await CommentService.getUserList(page, limit);

  return c.json({
    code: 200,
    message: "Users fetched successfully",
    data: result,
  });
};
