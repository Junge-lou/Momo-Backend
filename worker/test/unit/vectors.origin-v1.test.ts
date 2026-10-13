import { describe, it, expect } from 'vitest';
import fixture from '../../../doc/vectors/origin-v1.json';
import {
	ORIGIN_DECISION,
	parseOriginLike,
	checkRequestSource,
	isSourceDenied,
} from '../../src/utils/origin';

/**
 * 服务端来源校验的跨语言固定向量验收（与 Node / Go 读同一份 fixture）。
 *
 * 归一化口径（scheme/大小写/默认端口/host-only 条目）、判定优先级与 fail-closed 姿态
 * 只要有一端漂移，这里就会立刻失败。
 * 用 import 而不是 node:fs —— 测试跑在 workerd 里，没有文件系统，vitest 会把 JSON 打包进来。
 */

describe('vectors/origin-v1 — 决策码', () => {
	it('决策码与 fixture 一致', () => {
		expect(ORIGIN_DECISION.SKIP).toBe(fixture.decisions.skip);
		expect(ORIGIN_DECISION.ALLOW).toBe(fixture.decisions.allow);
		expect(ORIGIN_DECISION.DENY_NO_SOURCE).toBe(fixture.decisions.noSource);
		expect(ORIGIN_DECISION.DENY_INVALID_SOURCE).toBe(fixture.decisions.invalidSource);
		expect(ORIGIN_DECISION.DENY_NOT_ALLOWED).toBe(fixture.decisions.notAllowed);
	});
});

describe('vectors/origin-v1 — 来源归一化', () => {
	for (const vector of fixture.normalize) {
		it(vector.name, () => {
			const parsed = parseOriginLike(vector.raw);
			expect(parsed ? parsed.origin : null).toBe(vector.want);
		});
	}
});

describe('vectors/origin-v1 — 请求来源判定', () => {
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

describe('vectors/origin-v1 — 拒绝语义', () => {
	it('只有 skip / allow 不算拒绝', () => {
		expect(isSourceDenied(ORIGIN_DECISION.SKIP)).toBe(false);
		expect(isSourceDenied(ORIGIN_DECISION.ALLOW)).toBe(false);
	});

	it('三个 deny 判定都算拒绝', () => {
		expect(isSourceDenied(ORIGIN_DECISION.DENY_NO_SOURCE)).toBe(true);
		expect(isSourceDenied(ORIGIN_DECISION.DENY_INVALID_SOURCE)).toBe(true);
		expect(isSourceDenied(ORIGIN_DECISION.DENY_NOT_ALLOWED)).toBe(true);
	});

	it('非字符串的 post_url 按不可解析处理（fail-closed）', () => {
		expect(
			checkRequestSource({ allowOrigin: 'https://a.com', origin: 'https://a.com', postUrl: { evil: true } })
		).toBe(ORIGIN_DECISION.DENY_INVALID_SOURCE);
	});

	it('空白的来源等同于未声明', () => {
		expect(
			checkRequestSource({ allowOrigin: 'https://a.com', origin: '   ', referer: null, postUrl: undefined })
		).toBe(ORIGIN_DECISION.DENY_NO_SOURCE);
	});
});
