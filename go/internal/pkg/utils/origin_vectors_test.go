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
