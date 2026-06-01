import type { Context } from "hono";
import CommentService from "../../orm/commentService";
import { checkKey, extractToken } from "../../utils/security";

export default async (c: Context): Promise<Response> => {
  const authHeader = c.req.header("Authorization") || "";
  const key = extractToken(authHeader);

  if (!key || !checkKey(key)) {
    return c.json({ code: 401, message: "Invalid token" }, 401);
  }

  const rawRange = c.req.query("range");
  let range = 7;
  if (rawRange !== undefined && rawRange !== "") {
    range = parseInt(rawRange);
    if (isNaN(range)) range = 7;
  }
  const stats = await CommentService.getStatsOverview(range);

  return c.json({
    code: 200,
    message: "Stats fetched successfully",
    data: stats,
  });
};
