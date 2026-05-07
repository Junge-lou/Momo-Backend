import { Context } from 'hono';
import { Bindings } from '../../bindings';
import { checkAdminCredentials, changeAdminPassword } from '../../utils/settings';

export const changePassword = async (c: Context<{ Bindings: Bindings }>) => {
  const { old_name, old_password, new_name, new_password } = await c.req.json() as Record<string, string>;

  if (!old_name || !old_password || !new_name || !new_password) {
    return c.json({ code: 400, message: "old_name, old_password, new_name, new_password are required" }, 400);
  }

  if (new_password.length < 4) {
    return c.json({ code: 400, message: "New password must be at least 4 characters" }, 400);
  }

  const valid = await checkAdminCredentials(c.env, old_name, old_password);
  if (!valid) {
    return c.json({ code: 401, message: "Current credentials are incorrect" }, 401);
  }

  await changeAdminPassword(c.env, new_name, new_password);

  console.log(`Admin credentials changed: ${old_name} -> ${new_name}`);

  return c.json({
    code: 200,
    message: "Admin credentials updated successfully. Please login again.",
  });
};
