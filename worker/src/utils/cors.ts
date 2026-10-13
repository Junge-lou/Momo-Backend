import { Context, Next } from 'hono'
import { cors } from 'hono/cors'
import { Bindings } from '../bindings'
import { getSetting } from './settings'

// 将 allow_origin 设置解析为去空格、去空项的来源数组（精确匹配：大小写与末尾斜杠均视为不同来源）
export const parseAllowedOrigins = (allowOriginStr: string | undefined): string[] =>
  allowOriginStr
    ? allowOriginStr.split(',').map(origin => origin.trim()).filter(Boolean)
    : []

export const customCors = (allowOriginStr: string | undefined) => {
  // 1. 将环境变量字符串解析为数组
  // 如果环境变量不存在，则默认为空数组（即拒绝所有跨域请求）
  const allowedOrigins = parseAllowedOrigins(allowOriginStr)

  // 显式配置 * 时按通配处理
  const allowAll = allowedOrigins.includes('*')

  return cors({
    origin: (origin) => {
      if (!origin) return origin
      if (allowAll) return '*'
      // 精确匹配白名单
      if (allowedOrigins.includes(origin)) return origin
      return undefined
    },
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['Content-Length'],
    maxAge: 600,
    // 不启用 credentials：管理接口一律使用 Authorization: Bearer，
    // 同时下发 Allow-Origin: * 与 Allow-Credentials: true 在浏览器中本就是无效组合。
    credentials: false,
  })
}

/**
 * 服务端来源校验（与 customCors 共用 allow_origin 白名单）。
 *
 * CORS 只是浏览器机制：白名单外的 Origin 只是拿不到 ACAO 响应头，请求本身
 * 依旧会被执行——第三方站点完全可以绕过浏览器（例如用自己的 Worker 做
 * 服务器对服务器转发）来冒用公开写接口。此校验在服务端直接拒绝这类请求：
 *
 * - allow_origin 未配置（空）或配置为 *：不限制（前者保持历史开放行为，
 *   未配置时跨域读取在浏览器侧本就未被放行）；
 * - 否则：Origin 须与白名单精确匹配（协议 + 域名 + 端口）；无 Origin 时取
 *   Referer 的 origin 部分匹配，无法解析的 Referer 直接拒绝；
 * - Origin/Referer 皆无（curl、服务端集成等非浏览器客户端）：放行。
 */
export async function isRequestOriginAllowed(
  env: Bindings,
  origin: string | undefined,
  referer: string | undefined
): Promise<boolean> {
  const allowed = parseAllowedOrigins((await getSetting(env, 'allow_origin')) ?? undefined)
  if (allowed.length === 0 || allowed.includes('*')) return true
  if (origin) return allowed.includes(origin)
  if (referer) {
    try {
      return allowed.includes(new URL(referer).origin)
    } catch {
      return false
    }
  }
  return true
}

// 公开写接口的来源校验中间件：Origin/Referer 存在且不在 allow_origin 白名单 → 403
export const originGuard = async (c: Context<{ Bindings: Bindings }>, next: Next) => {
  if (!(await isRequestOriginAllowed(c.env, c.req.header('origin'), c.req.header('referer')))) {
    return c.json({ code: 403, message: 'Origin not allowed' }, 403)
  }
  await next()
}
