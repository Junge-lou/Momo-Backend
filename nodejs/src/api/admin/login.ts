import type { Context } from "hono";
import { checkKey, generateTempKey } from "../../utils/security";
import { checkAdminCredentials, isDefaultAdmin } from "../../utils/settings";
import { getClientIP } from "../../utils/ip";
import LogService from "../../utils/log";
import { isIPBlocked, recordFailedAttempt, recordSuccessfulLogin } from "../../utils/ipSecurity";

export default async (c: Context): Promise<Response> => {
  const data = await c.req.json();
  const ip = getClientIP(c);

  // 检查IP是否被阻止
  if (isIPBlocked(ip)) {
    LogService.warn("Blocked IP attempted to login", { ip });
    return c.json(
      {
        code: 403,
        message: "IP is blocked due to multiple failed login attempts",
      },
      403
    );
  }

  if (!(await checkAdminCredentials(data.name, data.password))) {
    const isBlocked = recordFailedAttempt(ip);
    LogService.warn("Login failed", { ip, failedAttempts: isBlocked });
    if (isBlocked) {
      return c.json(
        {
          code: 403,
          message: "IP is blocked due to multiple failed login attempts",
        },
        403
      );
    }
    return c.json({ code: 401, message: "Invalid username or password" }, 401);
  }

  // 登录成功后清除失败尝试记录
  recordSuccessfulLogin(ip);
  LogService.info("Login successful", { ip });

  // 生成临时密钥
  const tempKey = await generateTempKey(data.name);
  const needChangePassword = await isDefaultAdmin();

  return c.json({
    code: 200,
    message: "Login successful",
    token: tempKey,
    needChangePassword,
  });
};
