import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "@/lib/env";

/**
 * DEVELOPMENT-ONLY authentication: an email-only sign-in that issues an HMAC-signed
 * cookie. getEnv() refuses AUTH_MODE=local when NODE_ENV=production.
 */
export const LOCAL_SESSION_COOKIE = "gaas_dev_session";

export type LocalSession = { id: string; email: string };

function key(): Buffer {
  const env = getEnv();
  if (env.AUTH_MODE !== "local" || !env.TOKEN_ENCRYPTION_KEY) throw new Error("local auth is not enabled");
  return Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64");
}

/** Deterministic UUID derived from the email so re-logins map to the same user. */
export function localUserIdForEmail(email: string): string {
  const h = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function signLocalSession(session: LocalSession): string {
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const mac = createHmac("sha256", key()).update(payload).digest("base64url");
  return `${payload}.${mac}`;
}

export function verifyLocalSession(value: string | undefined): LocalSession | null {
  if (!value) return null;
  const [payload, mac] = value.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", key()).update(payload).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as LocalSession;
    if (typeof parsed.id !== "string" || typeof parsed.email !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
