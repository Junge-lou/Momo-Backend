import type koa from "koa";
import { UAParser } from "ua-parser-js";
import CommentService  from "../../orm/commentService";
import { Comment, CreateCommentInput } from "../../type/prisma"
import { sendCommentReplyNotification, sendCommentNotification, isEmailServiceAvailable } from "../../utils/email";
import { canPostComment, checkContent, sanitizeHtml, checkIpBlacklist, checkEmailBlacklist, getCommentStatus } from "../../utils/security"
import { parseMarkdown } from "../../utils/markdown"
import LogService from "../../utils/log";

export default async (ctx: koa.Context, next: koa.Next): Promise<void> => {
  const data = ctx.request.body;
  const ip = ctx.request.headers['cf-connecting-ip'] as string || ctx.request.headers['x-real-ip'] as string || 
            (ctx.request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || 
            ctx.ip;
  // 检查评论时间
  if(!await canPostComment(ip)) {
    ctx.status = 429;
    ctx.body = {
      code: 429,
      message: "Time limit exceeded"
    };
    return;
  }

  // 检查 IP 黑名单
  if (await checkIpBlacklist(ip)) {
    ctx.status = 403;
    ctx.body = { code: 403, message: "Your IP has been blocked" };
    return;
  }

  // 检查邮箱黑名单
  if (data.email && await checkEmailBlacklist(data.email)) {
    ctx.status = 403;
    ctx.body = { code: 403, message: "Your email has been blocked" };
    return;
  }

  // 对所有用户输入进行 XSS 检查
    const content = checkContent(data.content);
    const author = checkContent(data.author);
    const url = checkContent(data.url || '');
    const postTitle = checkContent(data.post_title || '');
    const postUrl = checkContent(data.post_url || '');
    const uaParser = new UAParser(ctx.request.header['user-agent'] ?? "");
    const uaResult = uaParser.getResult();
    const commentData: CreateCommentInput = {
      pub_date: (new Date()).toISOString(),
      post_slug: data.post_slug,
      author: author,
      email: data.email,
      url: url,
      ip_address: ip,
      os: (uaResult.os.name || "") + " " + (uaResult.os.version || ""),
      browser: (uaResult.browser.name || "") + " " + (uaResult.browser.version || ""),
      device: uaResult.device.model || uaResult.device.type || uaResult.device.vendor || "",
      user_agent: ctx.request.header['user-agent'] || "",
      content_text: content,
      content_html: sanitizeHtml(parseMarkdown(content)),
      parent_id: data.parent_id ?? null,
      status: await getCommentStatus()
    }
    const comment = await CommentService.createComment(commentData);
    // 发送邮件通知（不影响评论结果）
    try {
      if(await isEmailServiceAvailable()) {
        if(data.parent_id) {
          LogService.info("Reply comment", { Name: comment.author, Email: comment.email})
          const parentComment = await CommentService.getCommentById(data.parent_id);
          if(parentComment && parentComment.email !== data.email) {
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
          LogService.info("New comment", { Name: comment.author, Email: comment.email})
          await sendCommentNotification({
            postTitle: postTitle,
            postUrl: postUrl,
            commentAuthor: author,
            commentContent: content
          });
        }
      }
    } catch (e) {
      LogService.error('邮件发送失败（不影响评论提交）:', e);
    }
    ctx.body = {
      code: 200,
      message: "Comment submitted successfully",
    };
}
