package utils

import (
	"encoding/json"
	"os"
	"testing"
)

/*
服务端来源校验的跨语言固定向量验收（与 Node / Worker 读同一份 fixture）。

归一化口径（scheme / 大小写 / 默认端口 / host-only 条目）、判定优先级与 fail-closed 姿态
只要有一端漂移，这里就会立刻失败。

lock 段覆盖「来源域名绑定」（comment_verify_domain_enabled）的判定口径：与 decide 段共用
同一套解析/白名单/来源规则，只有两点不同 —— 白名单不可用（空/空白/*）时不是 skip 而是
deny:no_whitelist（fail-closed），以及判定结果额外给出用于签进挑战/票据的归一化来源。
*/

type originNormalizeVector struct {
	Name string  `json:"name"`
	Raw  string  `json:"raw"`
	Want *string `json:"want"`
}

type originDecideVector struct {
	Name        string `json:"name"`
	AllowOrigin string `json:"allowOrigin"`
	Origin      string `json:"origin"`
	Referer     string `json:"referer"`
	PostURL     string `json:"postUrl"`
	Want        string `json:"want"`
}

// originLockVector lock 段的一条向量：want 同时钉住判定码与用于绑定的来源
type originLockVector struct {
	Name        string `json:"name"`
	AllowOrigin string `json:"allowOrigin"`
	Origin      string `json:"origin"`
	Referer     string `json:"referer"`
	PostURL     string `json:"postUrl"`
	Want        struct {
		Decision string `json:"decision"`
		Origin   string `json:"origin"`
	} `json:"want"`
}

type originFixture struct {
	Decisions struct {
		Skip          string `json:"skip"`
		Allow         string `json:"allow"`
		NoSource      string `json:"noSource"`
		InvalidSource string `json:"invalidSource"`
		NotAllowed    string `json:"notAllowed"`
	} `json:"decisions"`
	Normalize []originNormalizeVector `json:"normalize"`
	Decide    []originDecideVector    `json:"decide"`
	Lock      []originLockVector      `json:"lock"`
}

func loadOriginFixture(t *testing.T) originFixture {
	t.Helper()
	raw, err := os.ReadFile(vectorsPath("origin-v1.json"))
	if err != nil {
		t.Fatalf("读取 doc/vectors/origin-v1.json 失败: %v", err)
	}
	var fixture originFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("解析 doc/vectors/origin-v1.json 失败: %v", err)
	}
	return fixture
}

func TestOriginVectorsDecisionCodes(t *testing.T) {
	fixture := loadOriginFixture(t)

	pairs := []struct {
		name string
		got  string
		want string
	}{
		{"skip", OriginDecisionSkip, fixture.Decisions.Skip},
		{"allow", OriginDecisionAllow, fixture.Decisions.Allow},
		{"noSource", OriginDecisionDenyNoSource, fixture.Decisions.NoSource},
		{"invalidSource", OriginDecisionDenyInvalidSource, fixture.Decisions.InvalidSource},
		{"notAllowed", OriginDecisionDenyNotAllowed, fixture.Decisions.NotAllowed},
	}
	for _, pair := range pairs {
		if pair.got != pair.want {
			t.Errorf("决策码 %s 与 fixture 不一致: %q != %q", pair.name, pair.got, pair.want)
		}
	}
}

func TestOriginVectorsNormalize(t *testing.T) {
	for _, vector := range loadOriginFixture(t).Normalize {
		parsed := ParseOriginLike(vector.Raw)
		var got *string
		if parsed != nil {
			origin := parsed.Origin
			got = &origin
		}
		if vector.Want == nil {
			if got != nil {
				t.Errorf("%s: 期望解析失败，实际得到 %q", vector.Name, *got)
			}
			continue
		}
		if got == nil {
			t.Errorf("%s: 期望 %q，实际解析失败", vector.Name, *vector.Want)
			continue
		}
		if *got != *vector.Want {
			t.Errorf("%s: 期望 %q，实际 %q", vector.Name, *vector.Want, *got)
		}
	}
}

func TestOriginVectorsDecide(t *testing.T) {
	for _, vector := range loadOriginFixture(t).Decide {
		got := CheckRequestSource(RequestSourceInput{
			AllowOrigin: vector.AllowOrigin,
			Origin:      vector.Origin,
			Referer:     vector.Referer,
			PostURL:     vector.PostURL,
		})
		if got != vector.Want {
			t.Errorf("%s: 期望 %q，实际 %q", vector.Name, vector.Want, got)
		}
	}
}

func TestOriginVectorsDenySemantics(t *testing.T) {
	if IsSourceDenied(OriginDecisionSkip) || IsSourceDenied(OriginDecisionAllow) {
		t.Errorf("skip / allow 不应被判为拒绝")
	}
	if !IsSourceDenied(OriginDecisionDenyNoSource) ||
		!IsSourceDenied(OriginDecisionDenyInvalidSource) ||
		!IsSourceDenied(OriginDecisionDenyNotAllowed) {
		t.Errorf("三个 deny 判定都应被判为拒绝")
	}
}

// ---------- 来源域名绑定（lock 段） ----------

// TestOriginVectorsLock 逐条复算 lock 段：判定码与「用于绑定的来源」都必须与 fixture 一致。
//
// 被拒时同样要给出观测到的来源（能解析出来就有值）—— 它正是「哪个域名在尝试」的线索，
// 会被写进认证记录与日志。
func TestOriginVectorsLock(t *testing.T) {
	fixture := loadOriginFixture(t)
	if len(fixture.Lock) == 0 {
		t.Fatalf("fixture 缺少 lock 段（来源域名绑定的向量）")
	}

	for _, vector := range fixture.Lock {
		result := CheckDomainLock(RequestSourceInput{
			AllowOrigin: vector.AllowOrigin,
			Origin:      vector.Origin,
			Referer:     vector.Referer,
			PostURL:     vector.PostURL,
		})
		if result.Decision != vector.Want.Decision {
			t.Errorf("%s: 判定码期望 %q，实际 %q", vector.Name, vector.Want.Decision, result.Decision)
		}
		if result.Origin != vector.Want.Origin {
			t.Errorf("%s: 绑定来源期望 %q，实际 %q", vector.Name, vector.Want.Origin, result.Origin)
		}
		if wantOK := vector.Want.Decision == OriginDecisionAllow; result.OK != wantOK {
			t.Errorf("%s: ok 期望 %v，实际 %v", vector.Name, wantOK, result.OK)
		}
	}
}

// TestOriginVectorsLockNoWhitelist 白名单不可用时**绝不等于放行**（与 decide 段的 skip 形成对照）
func TestOriginVectorsLockNoWhitelist(t *testing.T) {
	if DomainLockDecisionDisabled != "disabled" || DomainLockDecisionDenyNoWhitelist != "deny:no_whitelist" {
		t.Errorf("域名绑定的判定码必须与三端口径逐字一致")
	}

	for _, allowOrigin := range []string{"", "   ", "*", "https://a.com,*"} {
		result := CheckDomainLock(RequestSourceInput{AllowOrigin: allowOrigin, Origin: "https://a.com"})
		if result.OK {
			t.Errorf("allow_origin=%q 时域名绑定必须 fail-closed", allowOrigin)
		}
		if result.Decision != DomainLockDecisionDenyNoWhitelist {
			t.Errorf("allow_origin=%q 时判定码期望 %q，实际 %q",
				allowOrigin, DomainLockDecisionDenyNoWhitelist, result.Decision)
		}
		// 被拒也要保留观测到的来源
		if result.Origin != "https://a.com" {
			t.Errorf("allow_origin=%q 时应保留观测到的来源，实际 %q", allowOrigin, result.Origin)
		}
	}

	// 同一份输入在普通来源校验下是 skip（放行）—— 这正是两个语义的关键差异
	if got := CheckRequestSource(RequestSourceInput{AllowOrigin: "*", Origin: "https://a.com"}); got != OriginDecisionSkip {
		t.Errorf("普通来源校验在 allow_origin=* 时应判为 skip，实际 %q", got)
	}
}

// TestPickBoundOriginPriority 来源选取优先级：Origin → Referer → post_url，
// 且只认 http(s)（其余 scheme 视为不可判定）。
func TestPickBoundOriginPriority(t *testing.T) {
	for _, tc := range []struct {
		name    string
		input   RequestSourceInput
		want    string
		wantNil bool
	}{
		{"三者齐全时取 Origin", RequestSourceInput{
			Origin: "https://a.com", Referer: "https://b.com/x", PostURL: "https://c.com/x",
		}, "https://a.com", false},
		{"缺 Origin 时取 Referer", RequestSourceInput{
			Referer: "https://b.com/x?y=1#f", PostURL: "https://c.com/x",
		}, "https://b.com", false},
		{"只有 post_url 时取 post_url", RequestSourceInput{PostURL: "https://c.com/x"}, "https://c.com", false},
		{"Origin 不可解析时退到 Referer", RequestSourceInput{
			Origin: "null", Referer: "https://b.com/x", PostURL: "https://c.com/x",
		}, "https://b.com", false},
		{"非 http(s) scheme 视为不可判定", RequestSourceInput{
			Origin: "ftp://a.com", PostURL: "https://c.com/x",
		}, "https://c.com", false},
		{"空白来源等同于未声明", RequestSourceInput{
			Origin: "   ", Referer: "\t", PostURL: "",
		}, "", true},
		{"一个来源都没有", RequestSourceInput{}, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			parsed := PickBoundOrigin(tc.input)
			if tc.wantNil {
				if parsed != nil {
					t.Fatalf("期望没有可绑定的来源，实际 %q", parsed.Origin)
				}
				return
			}
			if parsed == nil {
				t.Fatalf("期望绑定 %q，实际解析失败", tc.want)
			}
			if parsed.Origin != tc.want {
				t.Errorf("绑定来源期望 %q，实际 %q", tc.want, parsed.Origin)
			}
		})
	}
}

func TestOriginVectorsEdgeCases(t *testing.T) {
	// 非字符串入参按不可解析处理（Go 侧 HTTP 层不会出现，但与 Node/Worker 口径一致）
	if parsed := ParseOriginLike(42); parsed != nil {
		t.Errorf("非字符串入参应解析失败，实际得到 %q", parsed.Origin)
	}
	if parsed := ParseOriginLike(nil); parsed != nil {
		t.Errorf("nil 入参应解析失败，实际得到 %q", parsed.Origin)
	}
	if list := ParseAllowedOrigins(nil); list.Mode != "off" {
		t.Errorf("nil 的 allow_origin 应视为未配置，实际 mode=%q", list.Mode)
	}
	// 空白的来源等同于未声明
	if got := CheckRequestSource(RequestSourceInput{AllowOrigin: "https://a.com", Origin: "   "}); got != OriginDecisionDenyNoSource {
		t.Errorf("空白来源应判为 %q，实际 %q", OriginDecisionDenyNoSource, got)
	}
	// 白名单全部非法时 fail-closed
	if got := CheckRequestSource(RequestSourceInput{AllowOrigin: "https://", Origin: "https://a.com"}); got != OriginDecisionDenyNotAllowed {
		t.Errorf("白名单全非法时应判为 %q，实际 %q", OriginDecisionDenyNotAllowed, got)
	}
}
