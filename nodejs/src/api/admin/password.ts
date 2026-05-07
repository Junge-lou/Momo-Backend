import type koa from "koa";
import { checkAdminCredentials, changeAdminPassword } from "../../utils/settings";
import { checkKey, extractToken } from "../../utils/security";
import LogService from "../../utils/log";

export default async (ctx: koa.Context) => {
  const authHeader = ctx.get("Authorization");
  const key = extractToken(authHeader);
  if (!key || !checkKey(key)) {
    ctx.status = 401;
    ctx.body = { code: 401, message: "Invalid token" };
    return;
  }

  const { old_name, old_password, new_name, new_password } = ctx.request.body as Record<string, string>;

  if (!old_name || !old_password || !new_name || !new_password) {
    ctx.status = 400;
    ctx.body = { code: 400, message: "old_name, old_password, new_name, new_password are required" };
    return;
  }

  if (new_password.length < 4) {
    ctx.status = 400;
    ctx.body = { code: 400, message: "New password must be at least 4 characters" };
    return;
  }

  // 验证旧凭据
  const valid = await checkAdminCredentials(old_name, old_password);
  if (!valid) {
    ctx.status = 401;
    ctx.body = { code: 401, message: "Current credentials are incorrect" };
    return;
  }

  // 更新密码
  await changeAdminPassword(new_name, new_password);

  LogService.info("Admin credentials changed", { oldName: old_name, newName: new_name });

  ctx.body = {
    code: 200,
    message: "Admin credentials updated successfully. Please login again.",
  };
};
