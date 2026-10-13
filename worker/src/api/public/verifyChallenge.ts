import { Context } from 'hono';
import { Bindings } from '../../bindings';
import {
  checkVerifyDomain,
  createChallenge,
  getDifficulty,
  isVerifyEnabled,
  VERIFY_PROTOCOL_VERSION,
} from '../../utils/verify';
import { sanitizePostSlug } from '../../utils/security';
import { extractCfGeo, recordVerifyEvent, resolveWaitUntil } from '../../utils/verifyRecord';

/**
 * 签发无感验证挑战（POST /api/verify/challenge）
 *
 * 请求体: { post_slug?: string, post_url?: string }
 * 关闭验证时返回 enabled: false，前端据此不渲染验证框。
 *
 * 协议 v2：data.pow 为 HashWX 挑战参数（c/d/n/count），开启第二层时另有 data.instr。
 * v1 前端读不到 POW 参数，会在提交答案时收到 PROTOCOL_OUTDATED，
 * 因此响应里同时给出 version，便于前端做前后端配套判断。
 *
 * post_slug 会被**签进挑战载荷**（challenge 绑定到这篇文章），因此净化口径
 * 必须与 /api/verify/solution 完全一致 —— 两处都调用 sanitizePostSlug。
 *
 * 来源域名绑定（comment_verify_domain_enabled）：开启后本接口只接受来自
 * `allow_origin` 白名单站点的请求（白名单不可用时 fail-closed），并把来源哈希签进
 * 挑战载荷；未通过时返回 403 + reason: DOMAIN_NOT_ALLOWED，不签发任何挑战。
 */
export const verifyChallenge = async (c: Context<{ Bindings: Bindings }>) => {
  try {
    let postSlug = '';
    let postUrl: unknown = undefined;
    try {
      const data = await c.req.json();
      postSlug = sanitizePostSlug(data?.post_slug);
      postUrl = data?.post_url;
    } catch {
      // 无请求体也允许，仅用于探测开关状态
    }

    if (!(await isVerifyEnabled(c.env))) {
      return c.json({
        code: 200,
        message: 'Verification disabled',
        data: { enabled: false, version: VERIFY_PROTOCOL_VERSION },
      });
    }

    const ip = c.req.header('cf-connecting-ip') || c.req.header('x-real-ip') || '127.0.0.1';
    const waitUntil = resolveWaitUntil(c);

    // 来源域名绑定：白名单外的站点连挑战都不该拿到
    const domain = await checkVerifyDomain(c.env, {
      origin: c.req.header('origin'),
      referer: c.req.header('referer'),
      postUrl,
    });
    if (!domain.ok) {
      console.warn(`[security] 拒绝来源未授权的验证挑战签发：${domain.decision}`, domain.origin);
      await recordVerifyEvent(
        c.env,
        {
          event: 'fail',
          reason: `domain:${domain.decision}`,
          postSlug,
          ip,
          origin: domain.origin,
          geo: extractCfGeo(c.req.raw.cf),
        },
        waitUntil
      );
      return c.json(
        {
          code: 403,
          message: 'Request source is not allowed. Add this site to the allow-origin list in the dashboard.',
          reason: 'DOMAIN_NOT_ALLOWED',
        },
        403
      );
    }

    const challenge = await createChallenge(c.env, ip, postSlug, domain.orgHash);

    // 认证记录：签发事件。写入是尽力而为的（内部已吞掉异常），不影响签发结果；
    // country / network / asn 只有 Cloudflare 环境才有值，见 extractCfGeo。
    await recordVerifyEvent(
      c.env,
      {
        event: 'challenge',
        challengeId: challenge.challenge_id,
        // 记录的是**总期望哈希次数**（而非响应里 pow.d 的单子挑战难度），
        // 与 solution 侧记录的口径一致，否则两边的 difficulty 无法比较
        difficulty: await getDifficulty(c.env),
        postSlug,
        ip,
        origin: domain.origin,
        geo: extractCfGeo(c.req.raw.cf),
      },
      waitUntil
    );

    return c.json({
      code: 200,
      message: 'Challenge issued',
      data: {
        enabled: true,
        version: VERIFY_PROTOCOL_VERSION,
        post_slug: postSlug,
        ...challenge,
      },
    });
  } catch (e: any) {
    console.error('verifyChallenge error:', e);
    return c.json({ code: 500, message: 'Internal server error' }, 500);
  }
};
