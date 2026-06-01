import type { Context } from "hono";
import { UAParser } from "ua-parser-js";
import CommentService from "../../orm/commentService";
import { CreateCommentInput } from "../../type/prisma";
import { sendCommentReplyNotification, sendCommentNotification, isEmailServiceAvailable } from "../../utils/email";
import { canPostComment, checkContent, sanitizeHtml, checkIpBlacklist, checkEmailBlacklist, getCommentStatus } from "../../utils/security";
import { getSetting } from "../../utils/settings";
import { parseMarkdown } from "../../utils/markdown";
import { getClientIP } from "../../utils/ip";
import LogService from "../../utils/log";

export default async (c: Context): Promise<Response> => {
  const data = await c.req.json();
  const ip = getClientIP(c);

  // 必填字段校验
  if (!data.post_slug || !data.author || !data.email || !data.content) {
    return c.json(
      { code: 400, message: "post_slug, author, email, and content are required" },
      400
    );
  }

  // 检查评论时间
  if (!(await canPostComment(ip))) {
    return c.json({ code: 429, message: "Time limit exceeded" }, 429);
  }

  // 检查 IP 黑名单
  if (await checkIpBlacklist(ip)) {
    return c.json({ code: 403, message: "Your IP has been blocked" }, 403);
  }

  // 检查邮箱黑名单
  if (data.email && (await checkEmailBlacklist(data.email))) {
    return c.json({ code: 403, message: "Your email has been blocked" }, 403);
  }

  // 管理员评论密钥验证
  const adminEmail = (await getSetting("admin_email")) || "";
  const adminCommentKey = (await getSetting("admin_comment_key")) || "";
  const adminCommentKeyEnabled =
    (await getSetting("admin_comment_key_enabled")) || "false";
  let isAdminVerified = false;
  if (data.email === adminEmail && adminCommentKey && adminCommentKeyEnabled === "true") {
    if (data.admin_key === adminCommentKey) {
      isAdminVerified = true;
    } else {
      return c.json({ code: 403, message: "Invalid admin key" }, 403);
    }
  }

  // 对所有用户输入进行 XSS 检查
  const content = checkContent(data.content);
  const author = checkContent(data.author);
  const url = checkContent(data.url || "");
  const postTitle = checkContent(data.post_title || "");
  const postUrl = checkContent(data.post_url || "");
  const uaParser = new UAParser(c.req.header("user-agent") ?? "");
  const uaResult = uaParser.getResult();
  const commentData: CreateCommentInput = {
    pub_date: new Date().toISOString(),
    post_slug: data.post_slug,
    author: author,
    email: data.email,
    url: url,
    ip_address: ip,
    os: (uaResult.os.name || "") + " " + (uaResult.os.version || ""),
    browser: (uaResult.browser.name || "") + " " + (uaResult.browser.version || ""),
    device: uaResult.device.model || uaResult.device.type || uaResult.device.vendor || "",
    user_agent: c.req.header("user-agent") || "",
    content_text: content,
    content_html: sanitizeHtml(await parseMarkdown(content)),
    parent_id: data.parent_id ?? null,
    status: isAdminVerified ? "approved" : await getCommentStatus(),
  };
  const comment = await CommentService.createComment(commentData);

  // 发送邮件通知（不影响评论结果）
  try {
    if (await isEmailServiceAvailable()) {
      if (data.parent_id) {
        LogService.info("Reply comment", { Name: comment.author, Email: comment.email });
        const parentComment = await CommentService.getCommentById(data.parent_id);
        if (parentComment && parentComment.email !== data.email) {
          await sendCommentReplyNotification({
            toEmail: parentComment.email,
            toName: parentComment.author,
            postTitle: postTitle,
            parentComment: parentComment.content_text,
            replyAuthor: author,
            replyContent: content,
            postUrl: postUrl,
          });
        }
      } else {
        LogService.info("New comment", { Name: comment.author, Email: comment.email });
        await sendCommentNotification({
          postTitle: postTitle,
          postUrl: postUrl,
          commentAuthor: author,
          commentContent: content,
        });
      }
    }
  } catch (e) {
    LogService.error("邮件发送失败（不影响评论提交）:", e);
  }

  return c.json({
    code: 200,
    message: "Comment submitted successfully",
  });
};
