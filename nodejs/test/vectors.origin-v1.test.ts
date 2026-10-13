import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  ORIGIN_DECISION,
  DOMAIN_LOCK_DECISION,
  parseOriginLike,
  checkRequestSource,
  checkDomainLock,
  isSourceDenied,
} from "../src/utils/origin";

/**
 * 服务端来源校验的跨语言固定向量验收（与 Worker / Go 读同一份 fixture）。
 *
 * 归一化口径（scheme/大小写/默认端口/host-only 条目）、判定优先级与 fail-closed 姿态
 * 只要有一端漂移，这里就会立刻失败。
 */

const FIXTURE_PATH = path.resolve(__dirname, "..", "..", "doc", "vectors", "origin-v1.json");
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

describe("vectors/origin-v1 — 决策码", () => {
  it("决策码与 fixture 一致", () => {
    expect(ORIGIN_DECISION.SKIP).toBe(fixture.decisions.skip);
    expect(ORIGIN_DECISION.ALLOW).toBe(fixture.decisions.allow);
    expect(ORIGIN_DECISION.DENY_NO_SOURCE).toBe(fixture.decisions.noSource);
    expect(ORIGIN_DECISION.DENY_INVALID_SOURCE).toBe(fixture.decisions.invalidSource);
    expect(ORIGIN_DECISION.DENY_NOT_ALLOWED).toBe(fixture.decisions.notAllowed);
  });
});

describe("vectors/origin-v1 — 来源归一化", () => {
  for (const vector of fixture.normalize) {
    it(vector.name, () => {
      const parsed = parseOriginLike(vector.raw);
      expect(parsed ? parsed.origin : null).toBe(vector.want);
    });
  }
});

describe("vectors/origin-v1 — 请求来源判定", () => {
  for (const vector of fixture.decide) {
    it(vector.name, () => {
      const decision = checkRequestSource({
        allowOrigin: vector.allowOrigin,
        origin: vector.origin,
        referer: vector.referer,
        postUrl: vector.postUrl,
      });
      expect(decision).toBe(vector.want);
    });
  }
});

describe("vectors/origin-v1 — 拒绝语义", () => {
  it("只有 skip / allow 不算拒绝", () => {
    expect(isSourceDenied(ORIGIN_DECISION.SKIP)).toBe(false);
    expect(isSourceDenied(ORIGIN_DECISION.ALLOW)).toBe(false);
  });

  it("三个 deny 判定都算拒绝", () => {
    expect(isSourceDenied(ORIGIN_DECISION.DENY_NO_SOURCE)).toBe(true);
    expect(isSourceDenied(ORIGIN_DECISION.DENY_INVALID_SOURCE)).toBe(true);
    expect(isSourceDenied(ORIGIN_DECISION.DENY_NOT_ALLOWED)).toBe(true);
  });

  it("非字符串的 post_url 按不可解析处理（fail-closed）", () => {
    expect(
      checkRequestSource({ allowOrigin: "https://a.com", origin: "https://a.com", postUrl: { evil: true } })
    ).toBe(ORIGIN_DECISION.DENY_INVALID_SOURCE);
  });

  it("空白的来源等同于未声明", () => {
    expect(
      checkRequestSource({ allowOrigin: "https://a.com", origin: "   ", referer: null, postUrl: undefined })
    ).toBe(ORIGIN_DECISION.DENY_NO_SOURCE);
  });
});

/**
 * 域名绑定（comment_verify_domain_enabled）与普通来源校验共用解析/白名单口径，
 * 但白名单不可用时不是 skip 而是 fail-closed，并额外给出用于签进挑战/票据的来源。
 */
describe("vectors/origin-v1 — 来源域名绑定（lock）", () => {
  it("fixture 含 lock 段", () => {
    expect(Array.isArray(fixture.lock)).toBe(true);
    expect(fixture.lock.length).toBeGreaterThan(0);
  });

  for (const vector of fixture.lock ?? []) {
    it(vector.name, () => {
      const result = checkDomainLock({
        allowOrigin: vector.allowOrigin,
        origin: vector.origin,
        referer: vector.referer,
        postUrl: vector.postUrl,
      });
      expect(result.decision).toBe(vector.want.decision);
      expect(result.origin).toBe(vector.want.origin);
      expect(result.ok).toBe(vector.want.decision === ORIGIN_DECISION.ALLOW);
    });
  }

  it("allow_origin 不可用时绝不等于放行（与 decide 段的 skip 形成对照）", () => {
    for (const allowOrigin of ["", "   ", "*", "https://a.com,*"]) {
      const result = checkDomainLock({ allowOrigin, origin: "https://a.com" });
      expect(result.ok).toBe(false);
      expect(result.decision).toBe(DOMAIN_LOCK_DECISION.DENY_NO_WHITELIST);
    }
  });
});
