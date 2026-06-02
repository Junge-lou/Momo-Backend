import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { approvePendingComments } from '../../utils/email';

interface VerifRecord {
  id: number;
  email: string;
  token: string;
  expires_at: string;
  verified: number;
  post_slug?: string;
  post_title?: string;
  created_at: string;
  verified_at?: string;
}

export const verifyEmail = async (c: Context<{ Bindings: Bindings }>) => {
  const token = c.req.query('token');
  const email = c.req.query('email');

  if (!token || !email) {
    return c.html(verificationResultPage(false, '缺少验证参数'));
  }

  try {
    // 查找验证记录
    const record = await c.env.MOMO_DB.prepare(
      'SELECT * FROM EmailVerification WHERE token = ? AND email = ?'
    ).bind(token, email).first<VerifRecord>();

    if (!record) {
      return c.html(verificationResultPage(false, '验证链接无效'));
    }

    // 检查是否已验证
    if (record.verified === 1) {
      return c.html(verificationResultPage(true, '该邮箱已验证通过'));
    }

    // 检查过期
    const now = new Date();
    const expiresAt = new Date(record.expires_at);
    if (now > expiresAt) {
      return c.html(verificationResultPage(false, '验证链接已过期，请重新提交评论以获取新的验证邮件'));
    }

    // 标记为已验证
    await c.env.MOMO_DB.prepare(
      "UPDATE EmailVerification SET verified = 1, verified_at = datetime('now') WHERE id = ?"
    ).bind(record.id).run();

    // 批准该邮箱的所有待审核评论
    const approvedCount = await approvePendingComments(c.env, email);

    const msg = approvedCount > 0
      ? `邮箱验证成功！共 ${approvedCount} 条评论已通过审核。`
      : '邮箱验证成功！';

    return c.html(verificationResultPage(true, msg));
  } catch (error) {
    console.error('邮箱验证失败:', error);
    return c.html(verificationResultPage(false, '验证处理失败，请稍后重试'));
  }
};

function verificationResultPage(success: boolean, message: string): string {
  const icon = success ? '&#10003;' : '&#10007;';
  const color = success ? '#28a745' : '#dc3545';
  const title = success ? '验证成功' : '验证失败';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - 邮箱验证</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f0f2f5;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
    }
    .card {
      background: #fff;
      border-radius: 12px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.08);
      padding: 48px 40px;
      max-width: 420px;
      width: 90%;
      text-align: center;
    }
    .icon {
      font-size: 64px;
      color: ${color};
      margin-bottom: 16px;
    }
    h1 {
      font-size: 24px;
      color: #1a1a1a;
      margin: 0 0 12px 0;
    }
    p {
      font-size: 15px;
      color: #555;
      line-height: 1.6;
      margin: 0 0 24px 0;
    }
    .footer {
      font-size: 12px;
      color: #999;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="footer">此页面由系统自动生成</div>
  </div>
</body>
</html>`;
}
