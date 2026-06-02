package model

import (
	"time"
)

// EmailVerification 邮箱验证记录
type EmailVerification struct {
	ID         int64   `db:"id" json:"id"`
	Email      string  `db:"email" json:"email"`
	Token      string  `db:"token" json:"token"`
	ExpiresAt  string  `db:"expires_at" json:"expiresAt"`
	Verified   int     `db:"verified" json:"verified"`
	PostSlug   *string `db:"post_slug" json:"postSlug,omitempty"`
	PostTitle  *string `db:"post_title" json:"postTitle,omitempty"`
	CreatedAt  string  `db:"created_at" json:"createdAt"`
	VerifiedAt *string `db:"verified_at" json:"verifiedAt,omitempty"`
}

// Comment 对应数据库中的 Comment 表
type Comment struct {
	ID          int64   `db:"id" json:"id"`
	PubDate     int64   `db:"pub_date" json:"-"` // Unix 时间戳（秒），不直接返回
	PostSlug    string  `db:"post_slug" json:"-"`
	Author      string  `db:"author" json:"author"`
	Email       string  `db:"email" json:"email"`
	URL         *string `db:"url" json:"url,omitempty"`
	Avatar      string  `json:"avatar,omitempty"`
	IPAddress   *string `db:"ip_address" json:"ipAddress,omitempty"`
	Device      *string `db:"device" json:"device,omitempty"`
	OS          *string `db:"os" json:"os,omitempty"`
	Browser     *string `db:"browser" json:"browser,omitempty"`
	UserAgent   *string `db:"user_agent" json:"userAgent,omitempty"`
	ContentText string  `db:"content_text" json:"contentText"`
	ContentHTML string  `db:"content_html" json:"contentHtml"`
	ParentID    *int64  `db:"parent_id" json:"parentId,omitempty"`
	Status      string  `db:"status" json:"status"`

	// 业务逻辑字段：用于构建树状结构
	Replies []*Comment `db:"-" json:"replies,omitempty"`
}

// SetPubDate 设置发布时间并转换为 RFC3339 格式
func (c *Comment) SetPubDate(timestamp int64) {
	c.PubDate = timestamp
}

// GetPubDate 获取格式化后的发布时间（YYYY-MM-DD HH:MM:SS）
func (c *Comment) GetPubDate() string {
	return time.Unix(c.PubDate, 0).Format("2006-01-02 15:04:05")
}

// GetPubDateRFC3339 获取 RFC3339 格式的发布时间
func (c *Comment) GetPubDateRFC3339() string {
	return time.Unix(c.PubDate, 0).Format(time.RFC3339)
}
