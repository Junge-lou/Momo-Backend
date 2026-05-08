import { Context } from 'hono';
import { UAParser } from 'ua-parser-js';
import { Bindings } from '../../bindings';
import { sendCommentNotification, sendCommentReplyNotification } from '../../utils/email';
import { isEmailEnabled, getSetting } from '../../utils/settings';
import { parseMarkdown } from '../../utils/markdown';

// 检查内容，删除 XSS 攻击脚本
export function checkContent(content: string): string {
    if (!content) return content;
    return content
        // Remove script/style blocks and their content
        .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '')
        // Remove event handler attributes (onclick, onerror, onload, etc.)
        .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // Remove javascript: and vbscript: links in href/src/action (quoted)
        .replace(/(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, '')
        .replace(/(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, '')
        // Remove javascript: and vbscript: links (unquoted, e.g. href=javascript:alert(1))
        .replace(/(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+/gi, '')
        // Remove standalone javascript: and vbscript: protocol
        .replace(/(?:javascript|vbscript):\s*/gi, '')
        // Remove dangerous embedding tags
        .replace(/<\/?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>/gi, '');
}

// IP CIDR 匹配
function ipInCIDR(ip: string, cidr: string): boolean {
  const [range, bits = "32"] = cidr.split("/");
  const prefixLen = parseInt(bits);
  const mask = ~(2 ** (32 - prefixLen) - 1);
  const ipNum = ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);
  const rangeNum = range.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);
  return (ipNum & mask) >>> 0 === (rangeNum & mask) >>> 0;
}

async function checkIpBlacklist(env: Bindings, ip: string): Promise<boolean> {
  const blacklistStr = await getSetting(env, "ip_blacklist");
  if (!blacklistStr) return false;
  try {
    const blacklist = JSON.parse(blacklistStr);
    if (!Array.isArray(blacklist)) return false;
    return blacklist.some((entry: string) => {
      if (entry.includes("/")) return ipInCIDR(ip, entry);
      return ip === entry;
    });
  } catch {
    return false;
  }
}

async function checkEmailBlacklist(env: Bindings, email: string): Promise<boolean> {
  const blacklistStr = await getSetting(env, "email_blacklist");
  if (!blacklistStr) return false;
  try {
    const blacklist = JSON.parse(blacklistStr);
    return Array.isArray(blacklist) && blacklist.includes(email);
  } catch {
    return false;
  }
}

async function getCommentStatus(env: Bindings): Promise<string> {
  const autoApprove = await getSetting(env, "comment_auto_approve");
  return autoApprove === "false" ? "pending" : "approved";
}

export const postComment = async (c: Context<{ Bindings: Bindings }>) => {
  const data = await c.req.json();
  const userAgent = c.req.header('user-agent') || "";

  // 1. 必填字段校验
  if (!data.post_slug || !data.author || !data.email || !data.content) {
    return c.json({ code: 400, message: "post_slug, author, email, and content are required" }, 400);
  }

  // 2. 获取 IP (Worker 获取 IP 的标准方式)
  const ip = c.req.header('cf-connecting-ip') || "127.0.0.1";

  // 3. 检查评论频率控制
  const lastComment = await c.env.MOMO_DB.prepare(
    "SELECT pub_date FROM Comment WHERE ip_address = ? ORDER BY pub_date DESC LIMIT 1"
  ).bind(ip).first<{ pub_date: string }>();

  if (lastComment) {
    const lastTime = new Date(lastComment.pub_date).getTime();
    if (!isNaN(lastTime) && Date.now() - lastTime < 60 * 1000) {
      return c.json({ code: 429, message: "Time limit exceeded. Please wait." }, 429);
    }
  }

  // 3. 检查 IP 黑名单
  if (await checkIpBlacklist(c.env, ip)) {
    return c.json({ code: 403, message: "Your IP has been blocked" }, 403);
  }

  // 4. 检查邮箱黑名单
  if (data.email && await checkEmailBlacklist(c.env, data.email)) {
    return c.json({ code: 403, message: "Your email has been blocked" }, 403);
  }

  // 5. 管理员评论密钥验证
  const adminEmail = await getSetting(c.env, "admin_email") || "";
  const adminCommentKey = await getSetting(c.env, "admin_comment_key") || "";
  const adminCommentKeyEnabled = await getSetting(c.env, "admin_comment_key_enabled") || "false";
  let isAdminVerified = false;
  if (data.email === adminEmail && adminCommentKey && adminCommentKeyEnabled === "true") {
    if (data.admin_key === adminCommentKey) {
      isAdminVerified = true;
    } else {
      return c.json({ code: 403, message: "Invalid admin key" }, 403);
    }
  }

  // 6. 准备数据 - 对所有用户输入进行 XSS 检查
  const content = checkContent(data.content);
  const author = checkContent(data.author);
  const url = checkContent(data.url || '');
  const postTitle = checkContent(data.post_title || '');
  const postUrl = checkContent(data.post_url || '');
  const uaParser = new UAParser(userAgent);
  const uaResult = uaParser.getResult();
  const status = isAdminVerified ? "approved" : await getCommentStatus(c.env);

  // 6. 写入 D1 数据库
  try {
    const { success } = await c.env.MOMO_DB.prepare(`
      INSERT INTO Comment (
        pub_date, post_slug, author, email, url, ip_address,
        os, browser, device, user_agent, content_text, content_html,
        parent_id, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      new Date().toISOString(),
      data.post_slug,
      author,
      data.email,
      url,
      ip,
      `${uaResult.os.name || ""} ${uaResult.os.version || ""}`.trim(),
      `${uaResult.browser.name || ""} ${uaResult.browser.version || ""}`.trim(),
      uaResult.device.model || uaResult.device.type || "Desktop",
      userAgent,
      content,
      parseMarkdown(content),
      data.parent_id || null,
      status
    ).run();

    if (!success) throw new Error("Database insert failed");

    // 5. 发送邮件通知 (后台异步执行，不阻塞用户响应)
    if (await isEmailEnabled(c.env)) {
      console.log("Sending email notification...");
      c.executionCtx.waitUntil((async () => {
        try {
          if (data.parent_id) {
            // 回复逻辑：查询父评论信息
            const parentComment = await c.env.MOMO_DB.prepare(
              "SELECT author, email, content_text FROM Comment WHERE id = ?"
            ).bind(data.parent_id).first<{ author: string, email: string, content_text: string }>();

            if (parentComment && parentComment.email !== data.email) {
              await sendCommentReplyNotification(c.env, {
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
            // 新评论通知站长
            await sendCommentNotification(c.env, {
              postTitle: postTitle,
              postUrl: postUrl,
              commentAuthor: author,
              commentContent: content
            });
          }
        } catch (mailError) {
          console.error("Mail Notification Failed:", mailError);
        }
      })());
    }else{
      console.log("No SMTP configuration found. Skipping email notification.");
    }

    return c.json({ message: "Comment submitted" });

  } catch (e: any) {
    console.error("Create Comment Error:", e);
    return c.json({ message: "Internal Server Error" }, 500);
  }
};