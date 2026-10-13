package utils

import (
	"strconv"
	"strings"
)

/*
评论提交的服务端来源校验（Origin / Referer / post_url）。

背景：CORS 是**浏览器机制**，allow_origin 过去只决定要不要下发
Access-Control-Allow-Origin，请求本身照样会被处理。于是「fork 一份前端 + 在自己的
Worker 里把 /api/comments 转发到别人的后端」这种用法完全绕开 CORS：对方站点照样落库，
还会用后端配置的 SMTP 账号发通知信（消耗配额、冒用发件身份）。

因此 allow_origin 非空且不含 * 时，写接口自己做一次来源校验：请求**声明的所有来源**
（Origin 头 / Referer 头 / 请求体 post_url）都必须落在白名单内，且至少要有一个来源可判定；
一个都拿不到、或拿到的值无法解析，一律拒绝（fail-closed），这样服务端转发
（无 Origin/Referer，只有 post_url）也在覆盖范围内。

口径由 doc/vectors/origin-v1.json 在 Node / Go / Worker 三端钉死。

注意：Origin / Referer / post_url 都是请求方可伪造的字段，这道校验抬高的是
「直接 fork 前端 + 服务器转发」的成本，不是密码学边界；真正的边界需要站点级令牌。

同一份口径还被无感验证复用：comment_verify_domain_enabled 开启时，挑战签发、
答案兑换与评论提交三处都要求来源命中白名单（CheckDomainLock），并把来源哈希签进
挑战与票据，见 doc/api.md 的「来源域名绑定」。差别只有一处：白名单不可用时
普通来源校验会 skip，而域名绑定 **fail-closed**。
*/

// 来源校验的判定结果（三端必须逐字一致，见 doc/vectors/origin-v1.json 的 decisions）
const (
	// OriginDecisionSkip 未启用服务端校验（allow_origin 未配置，或配置了 *）
	OriginDecisionSkip = "skip"
	// OriginDecisionAllow 通过
	OriginDecisionAllow = "allow"
	// OriginDecisionDenyNoSource 请求没有声明任何可判定的来源
	OriginDecisionDenyNoSource = "deny:no_source"
	// OriginDecisionDenyInvalidSource 声明了来源但无法解析（Origin: null、相对路径的 post_url、非 http(s) scheme…）
	OriginDecisionDenyInvalidSource = "deny:invalid_source"
	// OriginDecisionDenyNotAllowed 来源可解析但不在白名单内
	OriginDecisionDenyNotAllowed = "deny:not_allowed"
)

// ParsedOrigin 解析成功后的来源：scheme + host + 归一化后的默认端口
type ParsedOrigin struct {
	Scheme string
	Host   string
	Port   string
	Origin string
}

// AllowedOriginEntry 白名单条目：HostOnly 表示未写 scheme（只比主机名，忽略 scheme 与端口）
type AllowedOriginEntry struct {
	HostOnly bool
	Scheme   string
	Host     string
	Port     string
}

// AllowedOriginList 解析后的 allow_origin 设置
type AllowedOriginList struct {
	// Mode：off = 未配置；all = 配置了 *；list = 白名单
	Mode    string
	Entries []AllowedOriginEntry
}

// RequestSourceInput 一次写请求声明的来源（空串表示该来源不存在）
type RequestSourceInput struct {
	AllowOrigin string
	Origin      string
	Referer     string
	PostURL     string
}

var defaultPorts = map[string]string{"http": "80", "https": "443"}

func hasForbiddenChars(value string) bool {
	for i := 0; i < len(value); i++ {
		b := value[i]
		if b <= 0x20 || b == 0x7f {
			return true
		}
	}
	return false
}

// isASCII 主机名必须是纯 ASCII（IDN 由浏览器转成 punycode 后才会出现在 Origin 里）
func isASCII(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] > 0x7f {
			return false
		}
	}
	return true
}

// isDigits 等价于 /^\d+$/
func isDigits(value string) bool {
	if value == "" {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// isPositivePortDigits 等价于 /^[1-9]\d*$/（拒绝 0 与前导零）
func isPositivePortDigits(value string) bool {
	if value == "" || value[0] < '1' || value[0] > '9' {
		return false
	}
	for i := 1; i < len(value); i++ {
		if value[i] < '0' || value[i] > '9' {
			return false
		}
	}
	return true
}

// isValidScheme 等价于 /^[a-z][a-z0-9+.-]*$/
func isValidScheme(scheme string) bool {
	if scheme == "" {
		return false
	}
	if scheme[0] < 'a' || scheme[0] > 'z' {
		return false
	}
	for i := 1; i < len(scheme); i++ {
		c := scheme[i]
		switch {
		case c >= 'a' && c <= 'z':
		case c >= '0' && c <= '9':
		case c == '+' || c == '.' || c == '-':
		default:
			return false
		}
	}
	return true
}

// ParseOriginLike 把 URL / Origin / Referer 字符串解析成归一化的来源。
// 解析失败返回 nil（调用方按 fail-closed 处理）。
func ParseOriginLike(value any) *ParsedOrigin {
	raw, ok := value.(string)
	if !ok {
		return nil
	}
	raw = strings.TrimSpace(raw)
	if raw == "" || hasForbiddenChars(raw) {
		return nil
	}

	sep := strings.Index(raw, "://")
	if sep <= 0 {
		return nil
	}

	rawScheme := raw[:sep]
	if !isASCII(rawScheme) {
		return nil
	}
	scheme := strings.ToLower(rawScheme)
	if !isValidScheme(scheme) {
		return nil
	}

	// 路径 / 查询串 / 片段对「来源」判定没有意义，先截掉
	rest := raw[sep+3:]
	if cut := strings.IndexAny(rest, "/?#"); cut != -1 {
		rest = rest[:cut]
	}

	// 丢弃 userinfo（https://user:pw@host/…）
	if at := strings.LastIndex(rest, "@"); at != -1 {
		rest = rest[at+1:]
	}

	var host, port string
	if strings.HasPrefix(rest, "[") {
		end := strings.Index(rest, "]")
		if end == -1 {
			return nil
		}
		host = rest[:end+1]
		after := rest[end+1:]
		if after != "" {
			if !strings.HasPrefix(after, ":") {
				return nil
			}
			port = after[1:]
		}
	} else {
		idx := strings.LastIndex(rest, ":")
		switch {
		case idx == -1:
			host = rest
		case isDigits(rest[idx+1:]):
			host = rest[:idx]
			port = rest[idx+1:]
		case strings.Index(rest, ":") != idx:
			// 无方括号的多冒号：裸 IPv6 或畸形输入
			return nil
		default:
			host = rest
		}
		if strings.Contains(host, ":") {
			return nil
		}
	}

	if host == "" {
		return nil
	}
	if port != "" {
		// 同时拒绝 0、前导零与越界端口（三端同一口径）
		if !isPositivePortDigits(port) {
			return nil
		}
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber > 65535 {
			return nil
		}
	}
	if !isASCII(host) {
		return nil
	}

	host = strings.ToLower(host)
	if defaultPorts[scheme] == port {
		port = ""
	}

	origin := scheme + "://" + host
	if port != "" {
		origin += ":" + port
	}
	return &ParsedOrigin{Scheme: scheme, Host: host, Port: port, Origin: origin}
}

// ParseAllowedOrigins 解析 allow_origin 设置。
//   - 未配置（空串 / 只有空白）→ Mode = "off"：不启用服务端校验（行为与旧版本一致）
//   - 含 * → Mode = "all"：允许任意来源，同时不启用校验
//   - 其余 → Mode = "list"：白名单；条目解析失败会被丢弃，若一条都不剩则等价于「全部拒绝」
func ParseAllowedOrigins(raw any) AllowedOriginList {
	value, _ := raw.(string)

	parts := make([]string, 0, 4)
	for _, part := range strings.Split(value, ",") {
		if part = strings.TrimSpace(part); part != "" {
			parts = append(parts, part)
		}
	}

	if len(parts) == 0 {
		return AllowedOriginList{Mode: "off"}
	}
	for _, part := range parts {
		if part == "*" {
			return AllowedOriginList{Mode: "all"}
		}
	}

	entries := make([]AllowedOriginEntry, 0, len(parts))
	for _, part := range parts {
		if strings.Contains(part, "://") {
			if parsed := ParseOriginLike(part); parsed != nil {
				entries = append(entries, AllowedOriginEntry{
					Scheme: parsed.Scheme,
					Host:   parsed.Host,
					Port:   parsed.Port,
				})
			}
			continue
		}
		// 不带 scheme 的条目按主机名匹配（忽略 scheme 与端口），便于「只填域名」的写法
		if hasForbiddenChars(part) || !isASCII(part) {
			continue
		}
		host := strings.ToLower(part)
		if strings.ContainsAny(host, "/?#") {
			continue
		}
		entries = append(entries, AllowedOriginEntry{HostOnly: true, Host: host})
	}

	return AllowedOriginList{Mode: "list", Entries: entries}
}

// MatchesAllowedOrigin 候选项是否命中白名单（不带 scheme 的条目只比主机名）
func MatchesAllowedOrigin(entries []AllowedOriginEntry, candidate *ParsedOrigin) bool {
	if candidate == nil {
		return false
	}
	for _, entry := range entries {
		if entry.HostOnly {
			if entry.Host == candidate.Host {
				return true
			}
			continue
		}
		if entry.Scheme == candidate.Scheme && entry.Host == candidate.Host && entry.Port == candidate.Port {
			return true
		}
	}
	return false
}

// CheckRequestSource 判定一次写请求的来源。
//
// 规则（三端一致）：
//  1. 白名单未启用 → skip；
//  2. 任一存在的来源无法解析 → deny:invalid_source（fail-closed）；
//  3. 一个来源都没有 → deny:no_source；
//  4. 任一存在的来源不在白名单内 → deny:not_allowed；
//  5. 其余 → allow。
func CheckRequestSource(in RequestSourceInput) string {
	list := ParseAllowedOrigins(in.AllowOrigin)
	if list.Mode != "list" {
		return OriginDecisionSkip
	}

	candidates := make([]*ParsedOrigin, 0, 3)
	invalid := false

	for _, value := range []string{in.Origin, in.Referer, in.PostURL} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		parsed := ParseOriginLike(value)
		// 只有 HTTP(S) 才算「网页来源」；其余 scheme（ftp/file/javascript…）一律视为不可判定
		if parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			invalid = true
			continue
		}
		candidates = append(candidates, parsed)
	}

	if invalid {
		return OriginDecisionDenyInvalidSource
	}
	if len(candidates) == 0 {
		return OriginDecisionDenyNoSource
	}
	for _, candidate := range candidates {
		if !MatchesAllowedOrigin(list.Entries, candidate) {
			return OriginDecisionDenyNotAllowed
		}
	}
	return OriginDecisionAllow
}

// IsSourceDenied 该判定是否应当直接拒绝请求（三个后端统一调用，避免各自写反）
func IsSourceDenied(decision string) bool {
	return decision != OriginDecisionSkip && decision != OriginDecisionAllow
}

/* ------------------------------------------------------------------ *
 * 无感验证的「来源域名绑定」（comment_verify_domain_enabled）
 * ------------------------------------------------------------------ */

// 域名绑定的判定码。
//
// 比 CheckRequestSource 多一个 deny:no_whitelist：普通来源校验在 allow_origin
// 未配置或为 * 时会 skip（放行），而域名绑定要求**必须**有一份可用白名单 ——
// 否则「开启域名校验」等于空转，这正是要拦住的形态（CORS 放开 * 的站点过去
// 完全没有来源约束）。因此这里 fail-closed。
const (
	// DomainLockDecisionDisabled 未开启域名绑定（设置项关闭时由调用方直接短路，不会走到这里）
	DomainLockDecisionDisabled = "disabled"
	// DomainLockDecisionDenyNoWhitelist 没有可用的白名单（allow_origin 为空、只有空白、或含 *）
	DomainLockDecisionDenyNoWhitelist = "deny:no_whitelist"
)

// DomainLockResult 一次域名绑定的判定结果
type DomainLockResult struct {
	OK bool
	// Decision 为 allow 或 deny:*，用于日志 / 认证记录的 reason 与向量断言
	Decision string
	// Origin 归一化后的来源（判定通过时必有值；被拒时尽量给出，便于排查是哪个域名在试）
	Origin string
}

// PickBoundOrigin 选出「本次请求代表的来源」，优先级 Origin → Referer → post_url。
//
// 三者都必须命中白名单（由 CheckRequestSource 保证），这里只是挑一个用于绑定与记录：
// 浏览器直连时 Origin 最准；服务端转发或极少数不发送 Origin 的客户端退到 Referer / post_url。
func PickBoundOrigin(in RequestSourceInput) *ParsedOrigin {
	for _, value := range []string{in.Origin, in.Referer, in.PostURL} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		parsed := ParseOriginLike(value)
		// 只有 HTTP(S) 才算「网页来源」；其余 scheme（ftp/file/javascript…）一律视为不可判定
		if parsed != nil && (parsed.Scheme == "http" || parsed.Scheme == "https") {
			return parsed
		}
	}
	return nil
}

// CheckDomainLock 判定一次请求是否满足「来源域名绑定」。
//
// 规则（三端一致）：
//  1. 白名单不可用（模式不是 list）→ deny:no_whitelist（fail-closed）；
//  2. 其余复用 CheckRequestSource：任一来源不可解析 → deny:invalid_source；
//     无来源 → deny:no_source；任一来源不命中 → deny:not_allowed；
//  3. 全部命中 → allow，并给出用于绑定的归一化来源。
//
// 被拒时同样尽量给出归一化来源（能解析出来就有值）：它正是「哪个域名在尝试」的线索，
// 会被写进认证记录与日志，因此不能因为判定失败就丢掉。
func CheckDomainLock(in RequestSourceInput) DomainLockResult {
	observed := PickBoundOrigin(in)
	origin := ""
	if observed != nil {
		origin = observed.Origin
	}

	if ParseAllowedOrigins(in.AllowOrigin).Mode != "list" {
		return DomainLockResult{OK: false, Decision: DomainLockDecisionDenyNoWhitelist, Origin: origin}
	}

	decision := CheckRequestSource(in)
	if IsSourceDenied(decision) {
		return DomainLockResult{OK: false, Decision: decision, Origin: origin}
	}
	if origin == "" {
		return DomainLockResult{OK: false, Decision: OriginDecisionDenyNoSource, Origin: ""}
	}

	return DomainLockResult{OK: true, Decision: OriginDecisionAllow, Origin: origin}
}
