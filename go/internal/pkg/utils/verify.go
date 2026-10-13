package utils

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
)

/*
评论区「无感验证」（Turnstile 风格）— Go 实现 · 协议 v2

v2 与 v1 的区别（破坏性，见 doc/api.md 的「版本与兼容性」）：
  - 第一层工作量证明由 SHA-256 前导零比特换成 HashWX（抗 GPU 吞吐，见 utils/hashwx.go）
  - 难度语义由「前导 0 比特数」变为「总期望哈希次数」，旧值自动按 2^值 迁移
  - 答案由单个 nonce 变为 nonces 数组（默认 4 个子挑战，压平解题耗时长尾）
  - 票据版本号升为 2，v1 票据一律拒绝

保留的设计（未变）：
  - 零数据库结构改动：只复用 Settings 表存放自动生成的签名密钥
  - 无状态：挑战参数由（密钥, 挑战 id）与设置项确定性派生，服务端不存挑战内容
  - 票据自带 IP 绑定 + 有效期，靠 HMAC 签名保证不可伪造

跨语言一致性约定：
  - base64url 使用无填充（RawURLEncoding）
  - 哈希/签名的输入串与 JSON 字段名、字段顺序必须与 Node 版本逐字节相同
    （Go 的 map 遍历顺序是随机的，因此所有被签名的载荷都必须用 struct 定义顺序）
*/

// VerifyProtocolVersion 协议版本，供前端判断前后端是否配套
const VerifyProtocolVersion = 2

const (
	settingVerifyEnabled        = "comment_verify_enabled"
	settingVerifyDifficulty     = "comment_verify_difficulty"
	settingVerifySecret         = "comment_verify_secret"
	settingVerifyInstrEnabled   = "comment_verify_instr_enabled"
	settingVerifyBlockAutomated = "comment_verify_block_automated"
	// settingVerifyDomainEnabled 来源域名绑定（复用 allow_origin 白名单）
	settingVerifyDomainEnabled = "comment_verify_domain_enabled"

	// defaultVerifyDifficulty 难度：总期望哈希次数
	defaultVerifyDifficulty = HashwxDefaultDifficulty
	// minTotalWork 总工作量下限
	minTotalWork = 1000
	// legacyDifficultyMax 旧语义（前导 0 比特数）的上界，用于识别并迁移历史配置值
	legacyDifficultyMax = 26
	// legacyMigrationCap 旧值迁移后的上限（= dashboard「高」档 20 位对应的 2^20）。
	//
	// v1 的 21–26 换算过来是 209 万–6710 万次哈希，即便在 v1 时代那也是分钟级的谜题
	// （纯 JS 挖 6710 万次 SHA-256），对访客是灾难。dashboard 只提供 16/18/20 三档，
	// 所以能落到 21–26 的只有手工改库的情况；这里统一钳到最高档。
	legacyMigrationCap = 1 << 20
	// maxVerifyDifficulty 总工作量上限
	maxVerifyDifficulty = HashwxMaxDifficulty

	challengeTTL     = 10 * time.Minute
	ticketTTL        = 5 * time.Minute
	minSolveDuration = 50 * time.Millisecond
	maxSolveDuration = 10 * time.Minute
)

// TicketTTLSeconds 票据有效期（秒），供接口返回值使用
const TicketTTLSeconds = int(ticketTTL / time.Second)

var (
	verifySecretOnce sync.Once
	verifySecretVal  string

	usedChallengesMu sync.Mutex
	usedChallenges   = make(map[string]int64)
)

// ---------- 编解码辅助 ----------

// b64urlEncode 无填充 base64url 编码，与 JS 端的 base64url 输出一致
func b64urlEncode(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// b64urlDecode 容忍带填充/不带填充的 base64url 输入
func b64urlDecode(s string) ([]byte, error) {
	s = strings.TrimRight(s, "=")
	return base64.RawURLEncoding.DecodeString(s)
}

// hmacSHA256 b64url(HMAC-SHA256(data, secret))
func hmacSHA256(data, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return b64urlEncode(mac.Sum(nil))
}

// constantTimeEqual 常数时间比较两个字符串
func constantTimeEqual(a, b string) bool {
	return hmac.Equal([]byte(a), []byte(b))
}

// sha256Hex 十六进制 SHA-256
func sha256Hex(data string) string {
	sum := sha256.Sum256([]byte(data))
	return hex.EncodeToString(sum[:])
}

// ---------- 密钥 ----------

// getVerifySecret 获取签名密钥，首次调用时自动生成并持久化到 Settings 表
func getVerifySecret() string {
	verifySecretOnce.Do(func() {
		if existing := GetSetting(settingVerifySecret); existing != "" {
			verifySecretVal = existing
			return
		}
		random := make([]byte, 32)
		if _, err := rand.Read(random); err != nil {
			// 极端情况下退化为时间派生，仍然可用但不理想
			verifySecretVal = sha256Hex(fmt.Sprintf("fallback:%d", time.Now().UnixNano()))
			return
		}
		generated := hex.EncodeToString(random)
		if err := SetSetting(settingVerifySecret, generated); err != nil {
			// 持久化失败不影响本次运行
			verifySecretVal = generated
			return
		}
		verifySecretVal = generated
	})
	return verifySecretVal
}

// ---------- 对外配置 ----------

// IsVerifyEnabled 是否开启人机验证
func IsVerifyEnabled() bool {
	return GetSetting(settingVerifyEnabled) == "true"
}

// IsInstrumentationEnabled 是否开启第二层 Instrumentation 质询，**默认关闭**。
//
// 关闭时协议退化为单层 HashWX：挑战不下发程序，答案也不校验环境向量。
func IsInstrumentationEnabled() bool {
	return GetSetting(settingVerifyInstrEnabled) == "true"
}

// ShouldBlockAutomated 命中自动化特征时是否直接拒绝，**默认关闭**。
//
// 关闭时只把 blockedBy / riskFlags 写进日志，不拦截任何人。
func ShouldBlockAutomated() bool {
	return GetSetting(settingVerifyBlockAutomated) == "true"
}

// IsDomainLockEnabled 是否开启「来源域名绑定」，**默认关闭**。
//
// 开启后：挑战签发、答案兑换、评论提交三处都要求请求来源命中 allow_origin 白名单
// （白名单不可用时 fail-closed），并把来源哈希签进挑战与票据 —— 为 A 域名签发的凭证
// 无法在 B 域名使用，纯浏览器侧的跨域调用也彻底走不通（页面无法伪造 Origin）。
func IsDomainLockEnabled() bool {
	return GetSetting(settingVerifyDomainEnabled) == "true"
}

// DomainCheckResult 一次「来源域名绑定」判定的结果
type DomainCheckResult struct {
	// Enabled 是否开启了域名绑定（关闭时 OK 恒为 true，其余字段为占位值）
	Enabled bool
	OK      bool
	// Origin 归一化来源（被拒时尽量给出，便于日志与认证记录）
	Origin string
	// Decision 为 disabled / allow / deny:*
	Decision string
	// OrgHash 归一化来源的加盐哈希；未开启或来源不可判定时为空串
	OrgHash string
}

// CheckVerifyDomain 按设置项做一次「来源域名绑定」判定（三端一致）。
//
// 调用方拿到 OK == false 时必须直接拒绝（403），不要继续签发挑战或兑换票据。
func CheckVerifyDomain(origin, referer, postURL string) DomainCheckResult {
	if !IsDomainLockEnabled() {
		return DomainCheckResult{Enabled: false, OK: true, Decision: DomainLockDecisionDisabled}
	}

	input := RequestSourceInput{
		AllowOrigin: GetSetting("allow_origin"),
		Origin:      origin,
		Referer:     referer,
		PostURL:     postURL,
	}
	result := CheckDomainLock(input)

	observed := PickBoundOrigin(input)
	observedOrigin := ""
	if observed != nil {
		observedOrigin = observed.Origin
	}
	orgHash := ""
	if observedOrigin != "" {
		orgHash = hashOrigin(observedOrigin, getVerifySecret())
	}

	return DomainCheckResult{
		Enabled:  true,
		OK:       result.OK,
		Origin:   observedOrigin,
		Decision: result.Decision,
		OrgHash:  orgHash,
	}
}

// parseIntJS 复刻 JavaScript 的 parseInt(raw, 10)：
// 跳过前导空白，接受可选正负号，只取十进制数字前缀；没有数字则为 NaN。
func parseIntJS(raw string) (float64, bool) {
	s := strings.TrimLeftFunc(raw, unicode.IsSpace)
	start := 0
	if start < len(s) && (s[start] == '+' || s[start] == '-') {
		start++
	}
	end := start
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	if end == start {
		return 0, false
	}
	value, err := strconv.ParseFloat(s[:end], 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// GetVerifyDifficulty 读取总期望哈希次数，做上下限保护，并兼容 v1 的历史配置值。
//
// 迁移规则：值 ≤ 26 视为 v1 的「前导 0 比特数」，换算为 2^值 后按 legacyMigrationCap
// 钳制；否则直接当作期望哈希次数。
func GetVerifyDifficulty() int {
	parsed, ok := parseIntJS(GetSetting(settingVerifyDifficulty))
	if !ok || parsed < 1 {
		return defaultVerifyDifficulty
	}

	total := parsed
	if parsed <= legacyDifficultyMax {
		total = math.Min(math.Pow(2, parsed), legacyMigrationCap)
	}
	if total < minTotalWork {
		return minTotalWork
	}
	return int(math.Min(maxVerifyDifficulty, total))
}

// hashVerifyIP IP 加盐哈希，避免明文留存 IP。
// 算法：hex(SHA256("ip:" + secret + ":" + ip)) 取前 16 位
func hashVerifyIP(ip, secret string) string {
	return sha256Hex("ip:" + secret + ":" + ip)[:16]
}

// hashOrigin 来源域名加盐哈希，用于把挑战/票据绑定到签发它的站点域名。
//
// 与 hashVerifyIP 同构：SHA256("org:" + secret + ":" + 归一化来源) 取前 16 位十六进制。
// 三端必须完全一致（doc/vectors/verify-v2.json 的 originHash）。
func hashOrigin(origin, secret string) string {
	return sha256Hex("org:" + secret + ":" + origin)[:16]
}

// honeypotFieldName 按文章派生的蜜罐字段名
func honeypotFieldName(postSlug, secret string) string {
	return "v_" + sha256Hex("hp:" + secret + ":" + postSlug)[:10]
}

// GetPublicVerifyConfig 供评论列表接口下发给前端的信息
func GetPublicVerifyConfig(postSlug string) (enabled, honeypot, version string) {
	// 关闭时直接返回，不做任何密钥生成/写库，保证「默认关闭」零副作用
	if !IsVerifyEnabled() {
		return "false", "", strconv.Itoa(VerifyProtocolVersion)
	}
	return "true", honeypotFieldName(postSlug, getVerifySecret()), strconv.Itoa(VerifyProtocolVersion)
}

// ---------- 挑战 ----------

// verifyChallengePayload 被签名的挑战载荷。
//
// 字段顺序固定为 v / cid / iph / slug / iat —— 改动会让三端签发的 prefix 互不认可。
//
// Slug（挑战所属文章）必须放进被签名的载荷：否则挑战与文章没有任何绑定，
// 一次工作量证明可以在同一 IP 上换成任意文章的票据（/api/verify/solution 的
// post_slug 来自请求体，是**未签名**的），跨文章防护形同不存在。
//
// iat 用指针：Node 侧要求 `typeof payload.iat === "number"`，缺失必须判为
// malformed payload，而不是退化成 0（那会被当成「1970 年的过期挑战」）。
//
// 注意：校验侧刻意**不**直接反序列化到本结构体 —— 需要区分「JSON 语法错误」
// （malformed prefix）与「解析成功但不是对象」（malformed payload），并且协议
// 版本检查必须早于字段形状检查。本结构体只用于确定性地序列化载荷。
type verifyChallengePayload struct {
	V    int    `json:"v"`
	Cid  string `json:"cid"`
	Iph  string `json:"iph"`
	Slug string `json:"slug"`
	Iat  *int64 `json:"iat"`
	// Org 来源域名哈希（可选，仅 comment_verify_domain_enabled 为 true 时存在）。
	//
	// 必须追加在**末尾**：前面的字段顺序是三端共用的签名口径，插在中间会让新旧载荷互不认可。
	// 兑换时用「本次请求观测到的来源」重新计算并要求常数时间相等 —— 为 A 域名签发的挑战
	// 无法在 B 域名兑换。用 omitempty 保证未开启时整个字段缺席，形状与旧版本完全一致。
	Org string `json:"org,omitempty"`
}

// firstOrgHash 取可选的来源域名哈希。
//
// Node 侧形参写作 `orgHash = ""`（可选、默认空串），Go 用变长参数表达同一语义，
// 既保留旧调用点，也允许多传时以第一个为准。
func firstOrgHash(values []string) string {
	if len(values) == 0 {
		return ""
	}
	return values[0]
}

// VerifyPowSpec HashWX 挑战参数（响应里的 pow 字段）
type VerifyPowSpec struct {
	Algo  string `json:"algo"`
	C     string `json:"c"`
	D     int    `json:"d"`
	N     int    `json:"n"`
	Count int    `json:"count"`
}

// VerifyChallenge 下发给前端的挑战
type VerifyChallenge struct {
	ChallengeID string                    `json:"challenge_id"`
	Prefix      string                    `json:"prefix"`
	Sig         string                    `json:"sig"`
	ExpiresIn   int                       `json:"expires_in"`
	Pow         VerifyPowSpec             `json:"pow"`
	Instr       *InstrumentationChallenge `json:"instr,omitempty"`
}

// deriveHashwxChallenge 由（密钥, 挑战 id）确定性派生 HashWX 挑战。
//
// 派生而非随机的好处：签名载荷不必携带挑战本身，校验时也能独立重算；
// 客户端拿到的 c 不参与签名，但用错 c 会直接被服务端重算的结果拒绝。
func deriveHashwxChallenge(challengeID, secret string) []byte {
	sum := sha256.Sum256([]byte("hashwx:C:" + secret + ":" + challengeID))
	return sum[:]
}

// buildHashwxSpec 由设置项与挑战 id 组装 HashWX 挑战参数（签发与校验共用，保证口径一致）
func buildHashwxSpec(challengeID, secret string) (HashwxSpec, error) {
	return MintHashwxSpec(HashwxMintOptions{
		Challenge:     deriveHashwxChallenge(challengeID, secret),
		Difficulty:    GetVerifyDifficulty(),
		NoncesPerHash: HashwxDefaultNoncesPerHash,
		Count:         HashwxDefaultChallengeCount,
	})
}

// CreateVerifyChallenge 签发挑战。
//
// postSlug 必须与调用方在提交答案时传给 VerifySolution 的完全一致（同一套净化规则），
// 因为挑战被签名绑定到这篇文章，只有同一篇文章才能兑换票据。
//
// orgHash 为空串表示未开启域名绑定（载荷里不出现 org 字段，形状与旧版本完全一致）。
func CreateVerifyChallenge(ip, postSlug string, orgHash ...string) (*VerifyChallenge, error) {
	secret := getVerifySecret()

	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return nil, err
	}

	iat := time.Now().UnixMilli()
	payload := verifyChallengePayload{
		V:    VerifyProtocolVersion,
		Cid:  b64urlEncode(random),
		Iph:  hashVerifyIP(ip, secret),
		Slug: postSlug,
		Iat:  &iat,
	}
	if org := firstOrgHash(orgHash); org != "" {
		payload.Org = org
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}

	spec, err := buildHashwxSpec(payload.Cid, secret)
	if err != nil {
		return nil, err
	}

	prefix := b64urlEncode(raw)
	challenge := &VerifyChallenge{
		ChallengeID: payload.Cid,
		Prefix:      prefix,
		Sig:         hmacSHA256(prefix, secret),
		ExpiresIn:   int(challengeTTL / time.Second),
		Pow: VerifyPowSpec{
			Algo:  "hashwx",
			C:     spec.C,
			D:     spec.D,
			N:     spec.N,
			Count: spec.Count,
		},
	}

	// 关闭第二层时不下发程序：少一次派生，也让「不开启就零开销」
	if IsInstrumentationEnabled() {
		instrumentation := CreateInstrumentationChallenge(payload.Cid, secret)
		challenge.Instr = &instrumentation
	}

	return challenge, nil
}

func pruneUsedChallenges(now int64) {
	cutoff := now - int64(challengeTTL/time.Millisecond)
	for key, ts := range usedChallenges {
		if ts < cutoff {
			delete(usedChallenges, key)
		}
	}
}

// VerifySolutionInput 校验挑战答案的入参。
//
// Nonces / ElapsedMs 用 json.RawMessage 承载：Node 侧对它们做的是
// 「Array.isArray」与「Number()」这类宽松判定，先按字符串/结构体绑定会在
// 类型不符时提前 400，破坏 reason 的可比性。
type VerifySolutionInput struct {
	Prefix    string
	Sig       string
	Nonces    json.RawMessage
	ElapsedMs json.RawMessage
	IP        string
	// PostSlug 本次提交声明的文章，必须与挑战签发时签进载荷的 slug 一致
	PostSlug string
	// OrgHash 本次请求观测到的来源域名哈希；空串表示未开启域名绑定
	OrgHash string
	// Instr 第二层答案：{ regs, env, lw, lh, tm }；开启第二层时必填
	Instr map[string]any
}

// jsNumber 复刻 `Number(x)`：不是数值（含缺失/JSON 解析失败）时返回 false。
//
// 注意字符串：Node 侧是 `Number(data?.elapsed_ms)`，因此 `"elapsed_ms": "500"`
// 这类数字字符串是**合法**的（同理 `""` 是 0）。这里保持同样的宽松度，
// 否则前端只要把数字序列化成字符串就会被判成「不可信时序」。
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return 0, false
	}
	var value float64
	if err := json.Unmarshal(raw, &value); err == nil {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	}
	// 兼容数字字符串（与 JS 的 Number("1e3") === 1000 一致）
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, false
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return 0, true // Number("") === 0
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
		return 0, false
	}
	return parsed, true
}

// VerifySolution 校验挑战答案
// （签名 + 协议版本 + 文章绑定 + 来源域名 + 时效 + IP 绑定 + 时序 + HashWX + 第二层 + 防重放）
//
// 校验顺序与 Node 的 verifySolution 逐条一致 —— 顺序决定了返回的 reason，
// 客户端与跨语言测试都依赖它：
//  1. 签名 2. 解析 JSON 3. 必须是对象 4. 协议版本 5. 字段形状
//  6. 文章绑定 6.5 来源域名绑定 7. 时效 8. IP 绑定 9. 时序下限
//  10. HashWX spec 派生（读设置项，不能放进临界区）
//  11. 防重放 + 工作量校验 + 标记已用（同一段同步临界区）
//  12. 第二层 Instrumentation（在挑战标记为已用之后）
//
// 返回 ok=false 时 reason 为拒绝原因（不对外暴露细节）
func VerifySolution(input VerifySolutionInput) (bool, string) {
	secret := getVerifySecret()
	now := time.Now().UnixMilli()

	if input.Prefix == "" || input.Sig == "" {
		return false, "missing challenge"
	}

	// 1. 签名校验（先验签，避免解析不可信数据）
	if !constantTimeEqual(hmacSHA256(input.Prefix, secret), input.Sig) {
		return false, "bad signature"
	}

	// 2. 解析载荷
	raw, err := b64urlDecode(input.Prefix)
	if err != nil {
		return false, "malformed prefix"
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		// 与 Node 的 JSON.parse 抛错同义：载荷根本不是合法 JSON
		return false, "malformed prefix"
	}

	// 3. 必须是一个对象。null / 数字 / 字符串都是畸形载荷，
	//    不能因为「没有 v 字段」就被归到协议版本问题上。
	//    数组在 JS 里 typeof 同样是 "object"，因此这里也放行，
	//    交给下一步的 v 检查（payload.v 为 undefined !== 2）拒绝。
	var fields map[string]any
	switch value := decoded.(type) {
	case map[string]any:
		fields = value
	case []any:
		// 与 Node 一致：空数组/数组没有 v 字段 => PROTOCOL_OUTDATED
	default:
		return false, "malformed payload"
	}

	// 4. 协议版本：必须**先于**字段形状校验。
	//    v1 的载荷里没有 v 也没有 slug，若先校验形状会把它误判成 malformed payload，
	//    让「前后端不配套」这个最需要被明确识别的故障退化成含糊原因。
	//    （`v !== 2` 对缺失/字符串/布尔等一切非数字 2 的值都成立。）
	version, isNumber := fields["v"].(float64)
	if !isNumber || version != float64(VerifyProtocolVersion) {
		return false, "PROTOCOL_OUTDATED"
	}

	// 5. 载荷字段形状（与 Node 的四个 typeof 判断逐条对应）
	cid, cidOK := fields["cid"].(string)
	iph, iphOK := fields["iph"].(string)
	slug, slugOK := fields["slug"].(string)
	iat, iatOK := fields["iat"].(float64)
	if !cidOK || !iphOK || !slugOK || !iatOK {
		return false, "malformed payload"
	}
	// org 是可选的：未开启域名绑定时整个字段缺席。出现了就必须是字符串，
	// 否则视为畸形载荷（而不是退化成「域名不匹配」，那样会掩盖实现缺陷）。
	if value, exists := fields["org"]; exists {
		if _, isString := value.(string); !isString {
			return false, "malformed payload"
		}
	}

	// 6. 文章绑定：挑战只能兑换签发它的那篇文章的票据。
	//    给出专属 reason 而不是含糊的算力不足，便于排障与前端提示。
	if !constantTimeEqual(slug, input.PostSlug) {
		return false, "slug mismatch"
	}

	// 6.5 来源域名绑定（仅开启 comment_verify_domain_enabled 时生效）。
	//     两个专属 reason 分开：domain required 说明挑战签发时该开关还没开（重新验证即可），
	//     domain mismatch 说明有人拿别的域名的挑战来兑换。
	//     这一步在防重放的临界区**之前**：域名不匹配不得消耗挑战。
	if input.OrgHash != "" {
		org, orgOK := fields["org"].(string)
		if !orgOK || org == "" {
			return false, "domain required"
		}
		if !constantTimeEqual(org, input.OrgHash) {
			return false, "domain mismatch"
		}
	}

	// 7. 时效
	age := float64(now) - iat
	if age > float64(challengeTTL/time.Millisecond) {
		return false, "challenge expired"
	}
	if age < -60*1000 {
		return false, "challenge from the future"
	}

	// 8. IP 绑定
	if !constantTimeEqual(hashVerifyIP(input.IP, secret), iph) {
		return false, "ip mismatch"
	}

	// 9. 时序下限（minSolveDuration 的说明见常量定义）
	elapsedMs, ok := jsNumber(input.ElapsedMs)
	if !ok || elapsedMs < float64(minSolveDuration/time.Millisecond) ||
		elapsedMs > float64(maxSolveDuration/time.Millisecond) {
		return false, "implausible timing"
	}

	// 10. HashWX 校验用的 spec 与 nonces 先准备好：spec 派生要读设置项，
	//     不能放进下面的临界区（会白白拉长持锁时间）。
	spec, err := buildHashwxSpec(cid, secret)
	if err != nil {
		return false, "malformed spec"
	}
	nonces, _ := hashwxParseNoncesJSON(input.Nonces)

	// 11. 防重放 + HashWX 校验必须在**同一段临界区**内完成。
	//
	// 若写成「先查重、放开锁、再校验、最后标记」，两个并发提交同一挑战的请求会
	// 都通过「未使用」检查，然后各自换到一张票据 —— 挑战「单次使用」的保证
	// 在并发下就失效了（Node 的单线程模型掩盖了这个竞态）。算力校验只有约 150µs，
	// 持锁代价可以接受。
	usedChallengesMu.Lock()
	pruneUsedChallenges(now)
	if _, exists := usedChallenges[cid]; exists {
		usedChallengesMu.Unlock()
		return false, "challenge already used"
	}
	if check := VerifyHashwxSolutions(spec, nonces); !check.OK {
		// 算力不达标不消耗挑战（真人可能只是重试）
		usedChallengesMu.Unlock()
		return false, check.Reason
	}
	usedChallenges[cid] = now
	usedChallengesMu.Unlock()

	// 12. 第二层严格发生在挑战被标记为已用**之后**。
	//     顺序很关键：否则攻击者可以用同一个已通过 PoW 的挑战反复提交不同的
	//     环境向量，直到凑出一个能通过自动化检测的组合。
	if IsInstrumentationEnabled() {
		verdict := VerifyInstrumentation(cid, secret, input.Instr, ShouldBlockAutomated())

		if len(verdict.RiskFlags) > 0 || len(verdict.BlockedBy) > 0 {
			log.Printf("[WARN] 第二层质询命中自动化特征: ip=%s blockedBy=%v riskFlags=%v blocked=%v",
				input.IP, verdict.BlockedBy, verdict.RiskFlags, !verdict.OK)
		}

		if !verdict.OK {
			return false, verdict.Reason
		}
	}

	return true, ""
}

// ---------- 票据 ----------

// verifyTicketPayload 票据载荷，字段顺序固定为 v / iph / slug / iat / exp / jti / org
type verifyTicketPayload struct {
	V    int    `json:"v"`
	Iph  string `json:"iph"`
	Slug string `json:"slug"`
	Iat  int64  `json:"iat"`
	Exp  int64  `json:"exp"`
	Jti  string `json:"jti"`
	// Org 来源域名哈希（可选，仅 comment_verify_domain_enabled 为 true 时存在）。
	//
	// 与挑战同构、同样追加在末尾：票据也只能在签发它的域名下使用，
	// 这样 挑战 → 票据 → 评论提交 是**同一条域名链**。
	Org string `json:"org,omitempty"`
}

// CreateVerifyTicket 签发通过验证的票据。
//
// orgHash 为空串表示未开启域名绑定（载荷里不出现 org 字段）。
func CreateVerifyTicket(ip, postSlug string, orgHash ...string) (string, error) {
	secret := getVerifySecret()

	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}

	now := time.Now().UnixMilli()
	payload := verifyTicketPayload{
		V:    VerifyProtocolVersion,
		Iph:  hashVerifyIP(ip, secret),
		Slug: postSlug,
		Iat:  now,
		Exp:  now + int64(ticketTTL/time.Millisecond),
		Jti:  b64urlEncode(random),
	}
	if org := firstOrgHash(orgHash); org != "" {
		payload.Org = org
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	body := b64urlEncode(raw)
	return body + "." + hmacSHA256(body, secret), nil
}

// VerifyTicket 校验票据（供提交评论时调用）。
//
// orgHash 为空串表示未开启域名绑定；开启时必须同时满足「票据里有 org」且
// 「与本次请求的来源一致」，否则一律 false。
func VerifyTicket(ticket, ip, postSlug string, orgHash ...string) bool {
	if ticket == "" {
		return false
	}

	secret := getVerifySecret()
	dot := strings.LastIndex(ticket, ".")
	if dot <= 0 {
		return false
	}

	body := ticket[:dot]
	sig := ticket[dot+1:]
	if !constantTimeEqual(hmacSHA256(body, secret), sig) {
		return false
	}

	raw, err := b64urlDecode(body)
	if err != nil {
		return false
	}
	var payload verifyTicketPayload
	if err := json.Unmarshal(raw, &payload); err != nil {
		return false
	}

	if payload.V != VerifyProtocolVersion {
		return false
	}
	if payload.Exp == 0 || time.Now().UnixMilli() > payload.Exp {
		return false
	}
	if payload.Slug != postSlug {
		return false
	}

	// 域名绑定：开启时必须同时满足「票据里有 org」且「与本次请求的来源一致」。
	// 票据只在签发它的域名下可用；开关刚打开时旧票据没有 org，会被判失败并触发前端重新验证。
	if org := firstOrgHash(orgHash); org != "" {
		if payload.Org == "" {
			return false
		}
		if !constantTimeEqual(payload.Org, org) {
			return false
		}
	}

	if !constantTimeEqual(hashVerifyIP(ip, secret), payload.Iph) {
		return false
	}

	return true
}
