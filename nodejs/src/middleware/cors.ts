import { cors } from "hono/cors";
import { getSetting } from "../utils/settings";

const CheckAllowOrigins = async (requestOrigin: string): Promise<string> => {
  if (!requestOrigin) return "";

  const allowOriginStr = await getSetting("allow_origin");
  if (!allowOriginStr) return "";

  const allowedOrigins = allowOriginStr.split(",").map((s) => s.trim()).filter(Boolean);

  if (allowedOrigins.includes("*")) return "*";
  if (allowedOrigins.includes(requestOrigin)) return requestOrigin;
  return "";
};

const corsMiddleware = cors({
  origin: async (origin, c) => {
    return CheckAllowOrigins(origin || "");
  },
  credentials: true,
});

export default corsMiddleware;
