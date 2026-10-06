import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireEnv } from "@/lib/env";
import type { GoogleProduct } from "@/lib/google/oauth";

/**
 * The OAuth "in-flight" state lives in a short-lived, HMAC-signed, httpOnly cookie:
 * { state, verifier, websiteId, products, userId, issuedAt }. The callback verifies the
 * signature, the state parameter, the user, and the age.
 */
export const OAUTH_FLOW_COOKIE = "gaas_google_oauth";
export const OAUTH_FLOW_MAX_AGE_SECONDS = 10 * 60;

export const FlowPayload = z.object({
  state: z.string().min(16),
  verifier: z.string().min(32),
  websiteId: z.string().uuid(),
  products: z.array(z.enum(["gsc", "ga4", "ads"])).min(1),
  userId: z.string().uuid(),
  issuedAt: z.number().int(),
});
export type FlowPayload = z.infer<typeof FlowPayload>;

function key(): Buffer {
  return Buffer.from(requireEnv("TOKEN_ENCRYPTION_KEY", "signs the OAuth state cookie"), "base64");
}

export function signFlow(payload: FlowPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

export function verifyFlow(cookie: string | undefined, now = Date.now()): FlowPayload | null {
  if (!cookie) return null;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return null;
  const expected = createHmac("sha256", key()).update(body).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = FlowPayload.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success) return null;
    if (now - parsed.data.issuedAt > OAUTH_FLOW_MAX_AGE_SECONDS * 1000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export const ProductsParam = z
  .string()
  .default("gsc,ga4,ads")
  .transform((s) => [...new Set(s.split(",").map((p) => p.trim()).filter(Boolean))])
  .pipe(z.array(z.enum(["gsc", "ga4", "ads"])).min(1)) as unknown as z.ZodType<GoogleProduct[], string | undefined>;
