import { describe, it, expect } from "vitest";
import {
  DOMAIN_LOCK_DECISION,
  ORIGIN_DECISION,
  checkDomainLock,
  pickBoundOrigin,
} from "../src/utils/origin";

/**
 * src/utils/origin.ts —— 无感验证「来源域名绑定」的判定口径（纯函数，无数据库）。
 *
 * 与 vectors.origin-v1.test.ts 的分工：那边读 doc/vectors/origin-v1.json 做跨语言固定向量
 * 验收，这里补的是向量之外仍然要钉住的边界（来源选取优先级、被拒时保留观测来源、
 * fail-closed 的适用范围）。
 */

const A = "https://a.com";

describe("DOMAIN_LOCK_DECISION —— 判定码", () => {
  it("与调用方/向量约定的字符串逐字一致", () => {
    expect(DOMAIN_LOCK_DECISION.DISABLED).toBe("disabled");
    expect(DOMAIN_LOCK_DECISION.ALLOW).toBe("allow");
    expect(DOMAIN_LOCK_DECISION.DENY_NO_WHITELIST).toBe("deny:no_whitelist");
  });
});

describe("pickBoundOrigin —— 来源选取优先级", () => {
  it("Origin → Referer → post_url，取第一个可解析者", () => {
    expect(
      pickBoundOrigin({
        origin: "https://origin.example",
        referer: "https://referer.example/x",
        postUrl: "https://post.example/y",
      })?.origin
    ).toBe("https://origin.example");

    expect(
      pickBoundOrigin({ referer: "https://referer.example/x", postUrl: "https://post.example/y" })?.origin
    ).toBe("https://referer.example");

    expect(pickBoundOrigin({ postUrl: "https://post.example/y?q=1#f" })?.origin).toBe("https://post.example");
  });

  it("不可解析 / 非 http(s) / 空白 / 非字符串的来源被跳过", () => {
    expect(pickBoundOrigin({ origin: "null", referer: "   ", postUrl: 42 })).toBeNull();
    expect(pickBoundOrigin({ origin: "ftp://a.com", postUrl: "/blog/x" })).toBeNull();
    expect(pickBoundOrigin({ origin: "", referer: null, postUrl: undefined })).toBeNull();
    // 前一个不可解析时退到下一个可解析的来源
    expect(pickBoundOrigin({ origin: "not a url", referer: "https://a.com/x" })?.origin).toBe(A);
  });

  it("归一化口径与 checkRequestSource 完全一致（默认端口 / 大小写 / IPv6）", () => {
    expect(pickBoundOrigin({ origin: "HTTPS://A.com:443/" })?.origin).toBe(A);
    expect(pickBoundOrigin({ origin: "http://[::1]:17171" })?.origin).toBe("http://[::1]:17171");
  });
});

describe("checkDomainLock —— fail-closed 与观测来源", () => {
  it("白名单不可用（空 / 空白 / 含 * / 未配置）时一律 deny:no_whitelist，但仍给出观测来源", () => {
    for (const allowOrigin of ["", "   ", "*", "https://a.com,*", undefined, null]) {
      const result = checkDomainLock({ allowOrigin, origin: A });
      expect(result.ok).toBe(false);
      expect(result.decision).toBe(DOMAIN_LOCK_DECISION.DENY_NO_WHITELIST);
      expect(result.origin).toBe(A);
    }
  });

  it("全部来源命中白名单才放行，并绑定优先级最高的那个来源", () => {
    const result = checkDomainLock({
      allowOrigin: `${A},https://www.a.com`,
      origin: "https://www.a.com",
      referer: `${A}/blog/x`,
      postUrl: `${A}/blog/x`,
    });
    expect(result).toEqual({ ok: true, decision: ORIGIN_DECISION.ALLOW, origin: "https://www.a.com" });
  });

  it("任一来源不命中即拒绝，且 reason 是 deny:not_allowed", () => {
    const result = checkDomainLock({ allowOrigin: A, origin: A, referer: "https://evil.example/x" });
    expect(result.ok).toBe(false);
    expect(result.decision).toBe(ORIGIN_DECISION.DENY_NOT_ALLOWED);
    // 被拒时保留观测到的来源（排查「哪个域名在试」），而不是丢掉
    expect(result.origin).toBe(A);
  });

  it("无来源时 deny:no_source 且没有可绑定的域名", () => {
    expect(checkDomainLock({ allowOrigin: A })).toEqual({
      ok: false,
      decision: ORIGIN_DECISION.DENY_NO_SOURCE,
      origin: "",
    });
  });

  it("来源不可解析时 deny:invalid_source", () => {
    expect(checkDomainLock({ allowOrigin: A, origin: "null", postUrl: `${A}/x` })).toEqual({
      ok: false,
      decision: ORIGIN_DECISION.DENY_INVALID_SOURCE,
      origin: A,
    });
    expect(checkDomainLock({ allowOrigin: A, postUrl: "/blog/x" })).toEqual({
      ok: false,
      decision: ORIGIN_DECISION.DENY_INVALID_SOURCE,
      origin: "",
    });
  });

  it("判定码集合里没有 skip（域名绑定与普通来源校验的关键差异）", () => {
    const decision = checkDomainLock({ allowOrigin: "", origin: A }).decision;
    expect(decision).not.toBe(ORIGIN_DECISION.SKIP);
    expect(decision).not.toBe(ORIGIN_DECISION.ALLOW);
  });
});
