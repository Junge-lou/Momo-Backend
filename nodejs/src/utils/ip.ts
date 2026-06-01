import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

/**
 * 获取客户端真实 IP 地址
 *
 * 优先级:
 * 1. Cloudflare CDN IP (cf-connecting-ip)
 * 2. Nginx 反向代理 IP (x-real-ip)
 * 3. 负载均衡转发 IP 列表 (x-forwarded-for)，取第一个
 * 4. 直接连接 IP (getConnInfo)
 */
export const getClientIP = (c: Context): string => {
  // Cloudflare CDN IP
  const cfConnectingIP = c.req.header("cf-connecting-ip");
  if (cfConnectingIP) {
    return cfConnectingIP;
  }

  // Nginx 反向代理 IP
  const xRealIP = c.req.header("x-real-ip");
  if (xRealIP) {
    return xRealIP;
  }

  // 负载均衡或代理转发的 IP 列表，取第一个
  const xForwardedFor = c.req.header("x-forwarded-for");
  if (xForwardedFor) {
    const ip = xForwardedFor.split(",")[0]?.trim();
    if (ip) {
      return ip;
    }
  }

  // 默认使用 Hono 提供的 IP
  return getConnInfo(c).remote.address || "Unknown";
};
