import crypto from "crypto";
import { getSetting, setSetting } from "./settings";
import LogService from "./log";
import { checkDomainLock, pickBoundOrigin } from "./origin";
import {
  HASHWX_DEFAULT_CHALLENGE_COUNT,
  HASHWX_DEFAULT_DIFFICULTY,
  HASHWX_DEFAULT_NONCES_PER_HASH,
  HASHWX_MAX_DIFFICULTY,
  mintHashwxSpec,
  verifyHashwxSolutions,
  type HashwxSpec,
} from "./hashwx";
import {
  createInstrumentationChallenge,
  verifyInstrumentation,
} from "./instrumentation";

/**
 * 评论区「无感验证」（Turnstile 风格）— 协议 v2
 *
 * v2 与 v1 的区别（破坏性）：
 * - 第一层工作量证明由 SHA-256 前导零比特换成 HashWX（抗 GPU 吞吐，见 utils/hashwx.ts）
 * - 难度语义由「前导 0 比特数」变为「总期望哈希次数」，旧值自动按 2^值 迁移
 * - 答案由单个 nonce 变为 nonces 数组（默认 4 个子挑战，压平解题耗时长尾）
 * - 票据版本号升为 2，v1 票据一律拒绝
 *
 * 保留的设计（未变）：
 * - 零数据库结构改动：只复用 Settings 表存放自动生成的签名密钥
 * - 无状态：挑战参数由（密钥, 挑战 id）与设置项确定性派生，服务端不存挑战内容
 * - 票据自带 IP 绑定 + 有效期，靠 HMAC 签名保证不可伪造
 *
 * v2 之上的向后兼容扩展（非破坏性）：
 * - `comment_verify_domain_enabled` 开启时，挑战与票据载荷**末尾追加** `org`（来源域名哈希），
 *   由 `checkVerifyDomain` / `checkDomainLock` 判定来源；关闭时该字段整个缺席，形状与旧版一致。
 *   详见 utils/origin.ts 与 doc/api.md 的「来源域名绑定」。
 */

/** 协议版本，供前端判断前后端是否配套 */
export const VERIFY_PROTOCOL_VERSION = 2;

// 设置项 key
const SETTING_ENABLED = "comment_verify_enabled";
const SETTING_DIFFICULTY = "comment_verify_difficulty";
const SETTING_SECRET = "comment_verify_secret";
// 第二层（Instrumentation 质询）
const SETTING_INSTR_ENABLED = "comment_verify_instr_enabled";
const SETTING_BLOCK_AUTOMATED = "comment_verify_block_automated";
// 来源域名绑定（复用 allow_origin 白名单）
const SETTING_DOMAIN_ENABLED = "comment_verify_domain_enabled";

// 难度：总期望哈希次数
const MIN_TOTAL_WORK = 1000;
// 旧语义（前导 0 比特数）的上界，用于识别并迁移历史配置值
const LEGACY_DIFFICULTY_MAX = 26;
/**
 * 旧值迁移后的上限（= dashboard「高」档 20 位对应的 2^20）。
 *
 * v1 的 21–26 换算过来是 209 万–6710 万次哈希，即便在 v1 时代那也是分钟级的谜题
 * （纯 JS 挖 6710 万次 SHA-256），对访客是灾难。dashboard 只提供 16/18/20 三档，
 * 所以能落到 21–26 的只有手工改库的情况；这里统一钳到最高档，
 * 宁可把这种「配置事故」拉回可用区间，也不要让升级后的访客卡分钟级。
 */
const LEGACY_MIGRATION_CAP = 2 ** 20; // 1_048_576

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 挑战有效期 10 分钟
const TICKET_TTL_MS = 5 * 60 * 1000; // 票据有效期 5 分钟
/**
 * 最小解题耗时。
 *
 * v1 用 300ms 判定「太快即脚本」，但 HashWX 的总工作量固定，
 * 高端多核机器（16 核以上）可能在 300ms 内合法完成，会误伤真人，
 * 因此这里只保留一个「物理上不可能」的下限用于拦截预置答案/缓存响应。
 */
const MIN_SOLVE_MS = 50;
const MAX_SOLVE_MS = 10 * 60 * 1000; // 超过挑战有效期即无效

// 已兑换的挑战（单次使用），惰性清理
const usedChallenges = new Map<string, number>();

let cachedSecret: string | null = null;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function hmac(data: string, secret: string): string {
  return base64url(crypto.createHmac("sha256", secret).update(data, "utf8").digest());
}

/** 常数时间比较，避免签名被逐字节爆破 */
function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 获取签名密钥，首次使用时自动生成并持久化到 Settings 表。
 * 这样无需任何环境变量配置，重启后票据依旧可校验。
 */
async function getSecret(): Promise<string> {
  if (cachedSecret) return cachedSecret;

  const existing = await getSetting(SETTING_SECRET);
  if (existing && existing.length > 0) {
    cachedSecret = existing;
    return existing;
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    await setSetting(SETTING_SECRET, generated);
  } catch (e) {
    LogService.error("无法持久化验证密钥，本次将使用临时密钥:", e);
  }
  cachedSecret = generated;
  return generated;
}

/**
 * IP 加盐哈希，用于把挑战/票据绑定到来源 IP，避免明文留存 IP。
 * 使用 SHA256("ip:" + secret + ":" + ip)，三套后端算法完全一致。
 */
export function hashIp(ip: string, secret: string): string {
  return crypto.createHash("sha256").update(`ip:${secret}:${ip}`, "utf8").digest("hex").slice(0, 16);
}

/**
 * 来源域名加盐哈希，用于把挑战/票据绑定到签发它的站点域名。
 *
 * 与 hashIp 同构：SHA256("org:" + secret + ":" + 归一化来源) 取前 16 位十六进制。
 * 三端必须完全一致（doc/vectors/verify-v2.json 的 originHash）。
 */
export function hashOrigin(origin: string, secret: string): string {
  return crypto.createHash("sha256").update(`org:${secret}:${origin}`, "utf8").digest("hex").slice(0, 16);
}

/** 按文章派生的蜜罐字段名，避免全站固定字段被脚本识别 */
export function honeypotField(postSlug: string, secret: string): string {
  return `v_${crypto.createHash("sha256").update(`hp:${secret}:${postSlug}`, "utf8").digest("hex").slice(0, 10)}`;
}

/** 是否开启人机验证 */
export async function isVerifyEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_ENABLED)) === "true";
}

/**
 * 是否开启第二层 Instrumentation 质询，**默认关闭**。
 *
 * 关闭时协议退化为单层 HashWX：挑战不下发程序，答案也不校验环境向量。
 * 这样只想用工作量证明的部署可以完全避开第二层可能带来的兼容性风险。
 */
export async function isInstrumentationEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_INSTR_ENABLED)) === "true";
}

/**
 * 命中自动化特征时是否直接拒绝，**默认关闭**。
 *
 * 关闭时只把 blockedBy / riskFlags 写进日志（便于博主观察自己站点的访客构成），
 * 不拦截任何人。开启前请先看日志确认没有误伤（例如 Tor Browser 的字体整数量化、
 * 混合 DPI 多显示器环境）。
 */
export async function shouldBlockAutomated(): Promise<boolean> {
  return (await getSetting(SETTING_BLOCK_AUTOMATED)) === "true";
}

/**
 * 是否开启「来源域名绑定」，**默认关闭**。
 *
 * 开启后：挑战签发、答案兑换、评论提交三处都要求请求来源命中 `allow_origin` 白名单
 * （白名单不可用时 fail-closed），并把来源哈希签进挑战与票据 —— 为 A 域名签发的凭证
 * 无法在 B 域名使用，纯浏览器侧的跨域调用也彻底走不通（页面无法伪造 Origin）。
 */
export async function isDomainLockEnabled(): Promise<boolean> {
  return (await getSetting(SETTING_DOMAIN_ENABLED)) === "true";
}

export interface DomainCheckResult {
  /** 是否开启了域名绑定（关闭时 ok 恒为 true，其余字段为占位值） */
  enabled: boolean;
  ok: boolean;
  /** 归一化来源（被拒时尽量给出，便于日志与认证记录） */
  origin: string;
  /** `disabled` / `allow` / `deny:*` */
  decision: string;
  /** 归一化来源的加盐哈希；未开启或来源不可判定时为空串 */
  orgHash: string;
}

/**
 * 按设置项做一次「来源域名绑定」判定（三端一致）。
 *
 * 调用方拿到 `ok === false` 时必须直接拒绝（403），不要继续签发挑战或兑换票据。
 */
export async function checkVerifyDomain(params: {
  origin?: unknown;
  referer?: unknown;
  postUrl?: unknown;
}): Promise<DomainCheckResult> {
  if (!(await isDomainLockEnabled())) {
    return { enabled: false, ok: true, origin: "", decision: "disabled", orgHash: "" };
  }

  const input = {
    allowOrigin: await getSetting("allow_origin"),
    origin: params.origin,
    referer: params.referer,
    postUrl: params.postUrl,
  };
  const result = checkDomainLock(input);
  const observed = pickBoundOrigin(input);
  const origin = observed ? observed.origin : "";
  const orgHash = origin ? hashOrigin(origin, await getSecret()) : "";

  return { enabled: true, ok: result.ok, origin, decision: result.decision, orgHash };
}

/**
 * 读取总期望哈希次数，做上下限保护，并兼容 v1 的历史配置值。
 *
 * 迁移规则：值 ≤ 26 视为 v1 的「前导 0 比特数」，换算为 2^值 后按
 * LEGACY_MIGRATION_CAP 钳制；否则直接当作期望哈希次数。
 * 这样老部署升级后无需手工改配置，也不会因为历史上的极值配置卡死访客。
 */
export async function getDifficulty(): Promise<number> {
  const raw = await getSetting(SETTING_DIFFICULTY);
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return HASHWX_DEFAULT_DIFFICULTY;

  const total =
    parsed <= LEGACY_DIFFICULTY_MAX
      ? Math.min(2 ** parsed, LEGACY_MIGRATION_CAP)
      : parsed;
  if (total < MIN_TOTAL_WORK) return MIN_TOTAL_WORK;
  return Math.min(HASHWX_MAX_DIFFICULTY, total);
}

/**
 * 由（密钥, 挑战 id）确定性派生 HashWX 挑战。
 *
 * 派生而非随机的好处：签名载荷不必携带挑战本身，校验时也能独立重算；
 * 客户端拿到的 c 不参与签名，但用错 c 会直接被服务端重算的结果拒绝。
 */
function deriveHashwxChallenge(challengeId: string, secret: string): Buffer {
  return crypto
    .createHash("sha256")
    .update(`hashwx:C:${secret}:${challengeId}`, "utf8")
    .digest();
}

/** 由设置项与挑战 id 组装 HashWX 挑战参数（签发与校验共用，保证口径一致） */
async function buildHashwxSpec(challengeId: string, secret: string): Promise<HashwxSpec> {
  return mintHashwxSpec({
    challenge: deriveHashwxChallenge(challengeId, secret),
    difficulty: await getDifficulty(),
    noncesPerHash: HASHWX_DEFAULT_NONCES_PER_HASH,
    count: HASHWX_DEFAULT_CHALLENGE_COUNT,
  });
}

/** 供评论列表接口下发给前端的信息 */
export async function getPublicVerifyConfig(postSlug: string): Promise<{
  verify_enabled: string;
  verify_honeypot: string;
  verify_version: string;
}> {
  // 关闭时直接返回，不做任何密钥生成/写库，保证「默认关闭」零副作用
  if (!(await isVerifyEnabled())) {
    return { verify_enabled: "false", verify_honeypot: "", verify_version: String(VERIFY_PROTOCOL_VERSION) };
  }
  const secret = await getSecret();
  return {
    verify_enabled: "true",
    verify_honeypot: honeypotField(postSlug, secret),
    verify_version: String(VERIFY_PROTOCOL_VERSION),
  };
}

interface ChallengePayload {
  v: number;
  cid: string;
  iph: string;
  /**
   * 挑战所属文章。
   *
   * 必须放进被签名的载荷：否则挑战与文章没有任何绑定，一次工作量证明可以在同一 IP 上
   * 换成任意文章的票据（`/api/verify/solution` 的 post_slug 来自请求体，是未签名的），
   * 跨文章防护形同不存在。字段顺序固定为 v / cid / iph / slug / iat。
   */
  slug: string;
  iat: number;
  /**
   * 来源域名哈希（可选，仅 comment_verify_domain_enabled 为 true 时存在）。
   *
   * 必须追加在**末尾**：前面的字段顺序是三端共用的签名口径，插在中间会让新旧载荷互不认可。
   * 兑换时用「本次请求观测到的来源」重新计算并要求常数时间相等 —— 为 A 域名签发的挑战
   * 无法在 B 域名兑换。
   */
  org?: string;
}

export interface ChallengeResult {
  challenge_id: string;
  prefix: string;
  sig: string;
  expires_in: number;
  pow: {
    algo: "hashwx";
    c: string;
    d: number;
    n: number;
    count: number;
  };
  /** 第二层质询：开启 comment_verify_instr_enabled 时才存在 */
  instr?: {
    ops: number[];
    /** 需要采集的字体度量条数 */
    fonts: number;
  };
}

/**
 * 签发挑战。
 *
 * postSlug 必须与调用方在提交答案时传入的完全一致（同一套净化规则），
 * 因为挑战被签名绑定到这篇文章，只有同一篇文章才能兑换票据。
 *
 * orgHash 为空串表示未开启域名绑定（载荷里不出现 `org` 字段，形状与旧版本完全一致）。
 */
export async function createChallenge(
  ip: string,
  postSlug: string,
  orgHash = ""
): Promise<ChallengeResult> {
  const secret = await getSecret();
  const now = Date.now();

  const payload: ChallengePayload = {
    v: VERIFY_PROTOCOL_VERSION,
    cid: base64url(crypto.randomBytes(16)),
    iph: hashIp(ip, secret),
    slug: postSlug,
    iat: now,
  };
  if (orgHash) payload.org = orgHash;

  const prefix = base64url(JSON.stringify(payload));
  const spec = await buildHashwxSpec(payload.cid, secret);
  const instrumentation = await createInstrumentationChallenge(payload.cid, secret);

  const result: ChallengeResult = {
    challenge_id: payload.cid,
    prefix,
    sig: hmac(prefix, secret),
    expires_in: Math.floor(CHALLENGE_TTL_MS / 1000),
    pow: {
      algo: "hashwx",
      c: spec.c,
      d: spec.d,
      n: spec.n,
      count: spec.count,
    },
  };

  // 关闭第二层时不下发程序：少一次派生，也让「不开启就零开销」
  if (await isInstrumentationEnabled()) {
    result.instr = { ops: instrumentation.ops, fonts: instrumentation.fonts };
  }

  return result;
}

function pruneChallenges(now: number): void {
  const cutoff = now - CHALLENGE_TTL_MS;
  usedChallenges.forEach((ts, key) => {
    if (ts < cutoff) usedChallenges.delete(key);
  });
}

export type SolutionCheck = { ok: true } | { ok: false; reason: string };

/** 校验挑战答案（签名 + 协议版本 + 文章绑定 + 来源域名 + 时效 + IP 绑定 + 时序 + HashWX + 第二层 + 防重放） */
export async function verifySolution(params: {
  prefix: string;
  sig: string;
  nonces: unknown;
  elapsedMs: number;
  ip: string;
  /** 本次提交声明的文章，必须与挑战签发时签进去的一致 */
  postSlug: string;
  /** 本次请求观测到的来源域名哈希；空串表示未开启域名绑定 */
  orgHash?: string;
  /** 第二层答案：{ regs, env, lw, lh, tm }；开启第二层时必填 */
  instr?: unknown;
}): Promise<SolutionCheck> {
  const { prefix, sig, nonces, elapsedMs, ip, postSlug, orgHash = "", instr } = params;
  const secret = await getSecret();
  const now = Date.now();

  if (!prefix || !sig) return { ok: false, reason: "missing challenge" };

  // 1. 签名校验（先验签，避免解析不可信数据）
  const expected = hmac(prefix, secret);
  if (!timingSafeEqual(expected, sig)) return { ok: false, reason: "bad signature" };

  // 2. 解析载荷
  let payload: ChallengePayload;
  try {
    payload = JSON.parse(fromBase64url(prefix).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed prefix" };
  }

  // 3. 必须是一个对象。反序列化出来的 null / 数字 / 字符串都是畸形载荷，
  //    不能因为「没有 v 字段」就被归到协议版本问题上。
  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "malformed payload" };
  }

  // 4. 协议版本：必须**先于**字段形状校验。
  //    v1 的载荷里没有 v 也没有 slug，若先校验形状会把它误判成 malformed payload，
  //    让「前后端不配套」这个最需要被明确识别的故障退化成含糊原因。
  if (payload.v !== VERIFY_PROTOCOL_VERSION) {
    return { ok: false, reason: "PROTOCOL_OUTDATED" };
  }

  // 5. 载荷字段形状
  if (
    typeof payload.cid !== "string" ||
    typeof payload.iat !== "number" ||
    typeof payload.iph !== "string" ||
    typeof payload.slug !== "string"
  ) {
    return { ok: false, reason: "malformed payload" };
  }
  // org 是可选的：未开启域名绑定时整个字段缺席。出现了就必须是字符串，
  // 否则视为畸形载荷（而不是退化成「域名不匹配」，那样会掩盖实现缺陷）。
  if (payload.org !== undefined && typeof payload.org !== "string") {
    return { ok: false, reason: "malformed payload" };
  }

  // 6. 文章绑定：挑战只能兑换签发它的那篇文章的票据。
  //    给出专属 reason 而不是含糊的算力不足，便于排障与前端提示。
  if (!timingSafeEqual(payload.slug, postSlug)) {
    return { ok: false, reason: "slug mismatch" };
  }

  // 6.5 来源域名绑定（仅开启 comment_verify_domain_enabled 时生效）。
  //     两个专属 reason 分开：domain required 说明挑战签发时该开关还没开（重新验证即可），
  //     domain mismatch 说明有人拿别的域名的挑战来兑换。
  if (orgHash) {
    if (typeof payload.org !== "string" || payload.org.length === 0) {
      return { ok: false, reason: "domain required" };
    }
    if (!timingSafeEqual(payload.org, orgHash)) {
      return { ok: false, reason: "domain mismatch" };
    }
  }

  // 7. 时效
  const age = now - payload.iat;
  if (age > CHALLENGE_TTL_MS) return { ok: false, reason: "challenge expired" };
  if (age < -60 * 1000) return { ok: false, reason: "challenge from the future" };

  // 8. IP 绑定
  if (!timingSafeEqual(hashIp(ip, secret), payload.iph)) {
    return { ok: false, reason: "ip mismatch" };
  }

  // 9. 时序下限（见 MIN_SOLVE_MS 的说明）
  if (!Number.isFinite(elapsedMs) || elapsedMs < MIN_SOLVE_MS || elapsedMs > MAX_SOLVE_MS) {
    return { ok: false, reason: "implausible timing" };
  }

  // 10. HashWX 校验：用服务端自己派生的 spec，绝不采信客户端提交的难度。
  //     这一步里有 await（读设置项），所以必须排在防重放检查之前 —— 见下一步。
  const spec = await buildHashwxSpec(payload.cid, secret);

  // 11. 防重放 + 工作量校验 + 标记已用。
  //     这三步**全程同步、中间不出现 await**：否则并发提交同一个挑战时，
  //     两个请求会先后通过「未使用」检查、再都标记成功，各自换到一张票据。
  pruneChallenges(now);
  if (usedChallenges.has(payload.cid)) return { ok: false, reason: "challenge already used" };

  const check = verifyHashwxSolutions(spec, nonces);
  if (!check.ok) return check;

  // 12. 挑战在第二层校验之前就标记为已用（有意的）：否则攻击者可以用同一个
  //     已通过算力证明的挑战反复提交不同的环境向量，直到凑出一个能通过自动化检测的组合。
  usedChallenges.set(payload.cid, now);

  if (await isInstrumentationEnabled()) {
    const verdict = verifyInstrumentation(payload.cid, secret, instr as any, await shouldBlockAutomated());

    if (verdict.riskFlags.length > 0 || verdict.blockedBy.length > 0) {
      LogService.warn("第二层质询命中自动化特征:", {
        ip,
        blockedBy: verdict.blockedBy,
        riskFlags: verdict.riskFlags,
        blocked: !verdict.ok,
      });
    }

    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason };
    }
  }

  return { ok: true };
}

interface TicketPayload {
  v: number;
  iph: string;
  slug: string;
  iat: number;
  exp: number;
  jti: string;
  /**
   * 来源域名哈希（可选，仅 comment_verify_domain_enabled 为 true 时存在）。
   *
   * 与挑战同构、同样追加在末尾：票据也只能在签发它的域名下使用，
   * 这样 挑战 → 票据 → 评论提交 是**同一条域名链**。
   */
  org?: string;
}

/** 签发通过验证的票据 */
export async function createTicket(ip: string, postSlug: string, orgHash = ""): Promise<string> {
  const secret = await getSecret();
  const now = Date.now();
  const payload: TicketPayload = {
    v: VERIFY_PROTOCOL_VERSION,
    iph: hashIp(ip, secret),
    slug: postSlug,
    iat: now,
    exp: now + TICKET_TTL_MS,
    jti: base64url(crypto.randomBytes(8)),
  };
  if (orgHash) payload.org = orgHash;
  const body = base64url(JSON.stringify(payload));
  return `${body}.${hmac(body, secret)}`;
}

export const TICKET_TTL_SECONDS = Math.floor(TICKET_TTL_MS / 1000);

/** 校验票据（供提交评论时调用） */
export async function verifyTicket(
  ticket: string | undefined,
  ip: string,
  postSlug: string,
  orgHash = ""
): Promise<boolean> {
  if (!ticket || typeof ticket !== "string") return false;

  const secret = await getSecret();
  const dot = ticket.lastIndexOf(".");
  if (dot <= 0) return false;

  const body = ticket.slice(0, dot);
  const sig = ticket.slice(dot + 1);
  if (!timingSafeEqual(hmac(body, secret), sig)) return false;

  let payload: TicketPayload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8"));
  } catch {
    return false;
  }
  if (!payload || payload.v !== VERIFY_PROTOCOL_VERSION) return false;
  if (typeof payload.exp !== "number" || Date.now() > payload.exp) return false;
  if (payload.slug !== postSlug) return false;

  // 域名绑定：开启时必须同时满足「票据里有 org」且「与本次请求的来源一致」。
  // 票据只在签发它的域名下可用；开关刚打开时旧票据没有 org，会被判失败并触发前端重新验证。
  //
  // 与 verifySolution 的检查顺序保持一致（文章绑定 → 来源域名 → IP）：三端若顺序不同，
  // 虽然布尔结果等价，但排障时「先看到哪条判据」会不一样，容易被误读成口径漂移。
  if (orgHash) {
    if (typeof payload.org !== "string" || payload.org.length === 0) return false;
    if (!timingSafeEqual(payload.org, orgHash)) return false;
  }

  if (!timingSafeEqual(hashIp(ip, secret), String(payload.iph))) return false;

  return true;
}
