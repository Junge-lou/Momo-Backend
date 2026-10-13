/**
 * 评论提交的服务端来源校验（Origin / Referer / post_url）。
 *
 * 背景：CORS 是**浏览器机制**，`allow_origin` 过去只决定要不要下发
 * `Access-Control-Allow-Origin`，请求本身照样会被处理。于是「fork 一份前端 + 在自己的
 * Worker 里把 /api/comments 转发到别人的后端」这种用法完全绕开 CORS：对方站点照样落库，
 * 还会用后端配置的 SMTP 账号发通知信（消耗配额、冒用发件身份）。
 *
 * 因此 `allow_origin` 非空且不含 `*` 时，写接口自己做一次来源校验：
 * 请求**声明的所有来源**（Origin 头 / Referer 头 / 请求体 post_url）都必须落在白名单内，
 * 且至少要有一个来源可判定；一个都拿不到、或拿到的值无法解析，一律拒绝（fail-closed），
 * 这样服务端转发（无 Origin/Referer，只有 post_url）也在覆盖范围内。
 *
 * 口径由 `doc/vectors/origin-v1.json` 在 Node / Go / Worker 三端钉死。
 *
 * 注意：Origin / Referer / post_url 都是请求方可伪造的字段，这道校验抬高的是
 * 「直接 fork 前端 + 服务器转发」的成本，不是密码学边界；真正的边界需要站点级令牌。
 */

/** 来源校验的判定结果（三端必须逐字一致，见 doc/vectors/origin-v1.json 的 decisions） */
export const ORIGIN_DECISION = {
  /** 未启用服务端校验（allow_origin 未配置，或配置了 *） */
  SKIP: 'skip',
  /** 通过 */
  ALLOW: 'allow',
  /** 请求没有声明任何可判定的来源 */
  DENY_NO_SOURCE: 'deny:no_source',
  /** 声明了来源但无法解析（Origin: null、相对路径的 post_url、非 http(s) scheme…） */
  DENY_INVALID_SOURCE: 'deny:invalid_source',
  /** 来源可解析但不在白名单内 */
  DENY_NOT_ALLOWED: 'deny:not_allowed',
} as const;

export type OriginDecision = (typeof ORIGIN_DECISION)[keyof typeof ORIGIN_DECISION];

/** 解析成功后的来源：scheme + host + 归一化后的默认端口 */
export interface ParsedOrigin {
  scheme: string;
  host: string;
  port: string;
  origin: string;
}

/** 白名单条目：hostOnly 表示未写 scheme（只比主机名，忽略 scheme 与端口） */
export interface AllowedOriginEntry {
  hostOnly: boolean;
  scheme: string;
  host: string;
  port: string;
}

export interface AllowedOriginList {
  /** off = 未配置；all = 配置了 *；list = 白名单 */
  mode: 'off' | 'all' | 'list';
  entries: AllowedOriginEntry[];
}

export interface RequestSourceInput {
  allowOrigin?: unknown;
  origin?: unknown;
  referer?: unknown;
  postUrl?: unknown;
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' };
/** 只有 HTTP(S) 才算「网页来源」；其余 scheme（ftp/file/javascript…）一律视为不可判定 */
const CANDIDATE_SCHEMES = ['http', 'https'];

function hasForbiddenChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 主机名必须是纯 ASCII（IDN 由浏览器转成 punycode 后才会出现在 Origin 里） */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * 把 URL / Origin / Referer 字符串解析成归一化的来源。
 * 解析失败返回 null（调用方按 fail-closed 处理）。
 */
export function parseOriginLike(value: unknown): ParsedOrigin | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || hasForbiddenChars(raw)) return null;

  const sep = raw.indexOf('://');
  if (sep <= 0) return null;

  const rawScheme = raw.slice(0, sep);
  // scheme 必须是 ASCII（避免各语言 Unicode 大小写映射差异把口径带偏）
  if (!isAscii(rawScheme)) return null;
  const scheme = rawScheme.toLowerCase();
  if (!/^[a-z][a-z0-9+.-]*$/.test(scheme)) return null;

  // 路径 / 查询串 / 片段对「来源」判定没有意义，先截掉
  let rest = raw.slice(sep + 3);
  const cut = rest.search(/[/?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);

  // 丢弃 userinfo（https://user:pw@host/…）
  const at = rest.lastIndexOf('@');
  if (at !== -1) rest = rest.slice(at + 1);

  let host: string;
  let port = '';
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end === -1) return null;
    host = rest.slice(0, end + 1);
    const after = rest.slice(end + 1);
    if (after) {
      if (!after.startsWith(':')) return null;
      port = after.slice(1);
    }
  } else {
    const idx = rest.lastIndexOf(':');
    if (idx === -1) {
      host = rest;
    } else {
      const tail = rest.slice(idx + 1);
      if (/^\d+$/.test(tail)) {
        host = rest.slice(0, idx);
        port = tail;
      } else if (rest.indexOf(':') !== idx) {
        // 无方括号的多冒号：裸 IPv6 或畸形输入
        return null;
      } else {
        host = rest;
      }
    }
    if (host.includes(':')) return null;
  }

  if (!host) return null;
  if (port) {
    // 同时拒绝 0、前导零与越界端口（三端同一口径）
    if (!/^[1-9]\d*$/.test(port)) return null;
    if (Number(port) > 65535) return null;
  }
  if (!isAscii(host)) return null;

  host = host.toLowerCase();
  if (DEFAULT_PORTS[scheme] === port) port = '';

  return { scheme, host, port, origin: `${scheme}://${host}${port ? ':' + port : ''}` };
}

/**
 * 解析 `allow_origin` 设置。
 * - 未配置（空串 / 只有空白）→ mode = "off"：不启用服务端校验（行为与旧版本一致）
 * - 含 `*` → mode = "all"：允许任意来源，同时不启用校验
 * - 其余 → mode = "list"：白名单；条目解析失败会被丢弃，若一条都不剩则等价于「全部拒绝」
 */
export function parseAllowedOrigins(raw: unknown): AllowedOriginList {
  const value = typeof raw === 'string' ? raw : '';
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) return { mode: 'off', entries: [] };
  if (parts.includes('*')) return { mode: 'all', entries: [] };

  const entries: AllowedOriginEntry[] = [];
  for (const part of parts) {
    if (part.includes('://')) {
      const parsed = parseOriginLike(part);
      if (parsed) {
        entries.push({ hostOnly: false, scheme: parsed.scheme, host: parsed.host, port: parsed.port });
      }
      continue;
    }
    // 不带 scheme 的条目按主机名匹配（忽略 scheme 与端口），便于「只填域名」的写法
    if (hasForbiddenChars(part) || !isAscii(part)) continue;
    const host = part.toLowerCase();
    if (host.includes('/') || host.includes('?') || host.includes('#')) continue;
    entries.push({ hostOnly: true, scheme: '', host, port: '' });
  }

  return { mode: 'list', entries };
}

/** 候选项是否命中白名单（不带 scheme 的条目只比主机名） */
export function matchesAllowedOrigin(entries: AllowedOriginEntry[], candidate: ParsedOrigin): boolean {
  return entries.some((entry) =>
    entry.hostOnly
      ? entry.host === candidate.host
      : entry.scheme === candidate.scheme && entry.host === candidate.host && entry.port === candidate.port
  );
}

/**
 * 判定一次写请求的来源。
 *
 * 规则（三端一致）：
 * 1. 白名单未启用 → skip；
 * 2. 任一存在的来源无法解析 → deny:invalid_source（fail-closed）；
 * 3. 一个来源都没有 → deny:no_source；
 * 4. 任一存在的来源不在白名单内 → deny:not_allowed；
 * 5. 其余 → allow。
 */
export function checkRequestSource(params: RequestSourceInput): OriginDecision {
  const { mode, entries } = parseAllowedOrigins(params.allowOrigin);
  if (mode !== 'list') return ORIGIN_DECISION.SKIP;

  const candidates: ParsedOrigin[] = [];
  let invalid = false;

  for (const value of [params.origin, params.referer, params.postUrl]) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') {
      invalid = true;
      continue;
    }
    if (!value.trim()) continue;

    const parsed = parseOriginLike(value);
    if (!parsed || !CANDIDATE_SCHEMES.includes(parsed.scheme)) {
      invalid = true;
      continue;
    }
    candidates.push(parsed);
  }

  if (invalid) return ORIGIN_DECISION.DENY_INVALID_SOURCE;
  if (candidates.length === 0) return ORIGIN_DECISION.DENY_NO_SOURCE;

  for (const candidate of candidates) {
    if (!matchesAllowedOrigin(entries, candidate)) return ORIGIN_DECISION.DENY_NOT_ALLOWED;
  }
  return ORIGIN_DECISION.ALLOW;
}

/** 该判定是否应当直接拒绝请求（三个后端统一调用，避免各自写反） */
export function isSourceDenied(decision: OriginDecision): boolean {
  return decision !== ORIGIN_DECISION.SKIP && decision !== ORIGIN_DECISION.ALLOW;
}
