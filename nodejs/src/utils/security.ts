import CommentService   from "../orm/commentService"
import crypto from "crypto";

// 存储临时密钥的Map，包含密钥和过期时间
const tempKeys = new Map<string, { key: string; expiresAt: number }>();

export async function canPostComment(ip: string): Promise<boolean> {
    const lastComment = await CommentService.getlastCommentByIP(ip);
    // 如果没有找到评论或返回为空，则允许发布
    if (!lastComment || lastComment.length === 0) return true;

    // 确保有评论后再检查时间
    const comment = lastComment[0];
    if (!comment || !comment.pub_date) return true; // 防止 comment 或 pub_date 不存在的情况

    return Date.now() - comment.pub_date.getTime() > 60 * 1000;
}

// 使用 DOMPurify 进行 XSS 过滤（用于纯文本字段）
export function checkContent(content: string): string {
    if (!content) return content;
    return content
        // Remove script/style blocks and their content
        .replace(/<(?:script|style)[\s\S]*?<\/(?:script|style)>/gi, '')
        // Remove event handler attributes (onclick, onerror, onload, etc.)
        .replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        // Remove javascript: and vbscript: links in href/src/action (all quote forms)
        .replace(/(?:href|src|action|formaction)\s*=\s*"(?:javascript|vbscript):[^"]*"/gi, '')
        .replace(/(?:href|src|action|formaction)\s*=\s*'(?:javascript|vbscript):[^']*'/gi, '')
        .replace(/(?:href|src|action|formaction)\s*=\s*(?:javascript|vbscript):[^\s>"]+/gi, '')
        // Remove standalone javascript: protocol
        .replace(/(?:javascript|vbscript):\s*/gi, '')
        // Remove dangerous embedding tags
        .replace(/<\/?(?:iframe|object|embed|frame|meta|link|base|form|input)\b[^>]*>/gi, '');
}

// 使用 DOMPurify 过滤已渲染的 HTML 内容（Markdown 输出后使用）
import DOMPurify from 'isomorphic-dompurify';

export function sanitizeHtml(dirty: string): string {
    return DOMPurify.sanitize(dirty, {
        ALLOWED_TAGS: [
            'p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code',
            'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'del', 'img',
            'span', 'div'
        ],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'target', 'rel'],
        ALLOW_DATA_ATTR: false,
    });
}

// 生成基于随机 UUID 的临时密钥
export async function generateTempKey(username: string): Promise<string> {
    const tempKey = crypto.randomUUID();
    const expiresAt = Date.now() + 20 * 60 * 1000; // 20分钟后过期

    tempKeys.set(username, { key: tempKey, expiresAt });

    return tempKey;
}

// 检查密钥是否有效
export function checkKey(key: string): boolean {

    // 检查是否是有效的临时密钥
    const now = Date.now();
    const entries = Array.from(tempKeys.entries());
    for (let i = 0; i < entries.length; i++) {
        const [username, tempKey] = entries[i];
        // 检查密钥是否匹配且未过期
        if (tempKey.key === key && tempKey.expiresAt > now) {
            return true;
        }
        // 清除过期密钥
        if (tempKey.expiresAt <= now) {
            tempKeys.delete(username);
        }
    }

    return false;
}

/**
 * 从 Authorization header 中提取 token
 * 支持格式：Bearer <token> 或直接返回 token
 */
export function extractToken(authHeader: string): string {
    if (!authHeader) return "";

    // 如果是 "Bearer <token>" 格式，提取 token
    if (authHeader.startsWith("Bearer ")) {
        return authHeader.substring(7);
    }

    // 否则直接返回 header 值
    return authHeader;
}

// ---- IP 黑名单和评论审核 ----
import { getSetting } from "./settings";

function ipInCIDR(ip: string, cidr: string): boolean {
  const [range, bits = "32"] = cidr.split("/");
  const prefixLen = parseInt(bits);
  const mask = ~(2 ** (32 - prefixLen) - 1);

  const ipNum = ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);
  const rangeNum = range.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct), 0);

  return (ipNum & mask) >>> 0 === (rangeNum & mask) >>> 0;
}

export async function checkIpBlacklist(ip: string): Promise<boolean> {
  const blacklistStr = await getSetting("ip_blacklist");
  if (!blacklistStr) return false;
  try {
    const blacklist = JSON.parse(blacklistStr);
    if (!Array.isArray(blacklist)) return false;
    return blacklist.some((entry: string) => {
      if (entry.includes("/")) {
        return ipInCIDR(ip, entry);
      }
      return ip === entry;
    });
  } catch {
    return false;
  }
}

export async function checkEmailBlacklist(email: string): Promise<boolean> {
  const blacklistStr = await getSetting("email_blacklist");
  if (!blacklistStr) return false;
  try {
    const blacklist = JSON.parse(blacklistStr);
    return Array.isArray(blacklist) && blacklist.includes(email);
  } catch {
    return false;
  }
}

export async function getCommentStatus(): Promise<string> {
  const autoApprove = await getSetting("comment_auto_approve");
  return autoApprove === "false" ? "pending" : "approved";
}
