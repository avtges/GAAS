import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { getEnv, requireEnv } from "@/lib/env";
import { log } from "@/lib/logger";

/**
 * Google OAuth 2.0 (web server flow). Endpoints verified against
 * https://accounts.google.com/.well-known/openid-configuration (2026-10-06).
 */
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleProduct = "gsc" | "ga4" | "ads";

/** Least-privilege scopes per product (see docs/integration-verification.md). */
export const PRODUCT_SCOPES: Record<GoogleProduct, string[]> = {
  gsc: ["https://www.googleapis.com/auth/webmasters.readonly"],
  ga4: ["https://www.googleapis.com/auth/analytics.readonly"],
  ads: ["https://www.googleapis.com/auth/adwords"], // no read-only scope exists for Google Ads
};
export const IDENTITY_SCOPES = ["openid", "email"];

export function scopesFor(products: GoogleProduct[]): string[] {
  const set = new Set<string>(IDENTITY_SCOPES);
  for (const p of products) for (const s of PRODUCT_SCOPES[p]) set.add(s);
  return [...set];
}

export function productsGranted(grantedScopes: string[]): Record<GoogleProduct, boolean> {
  const has = (s: string) => grantedScopes.includes(s);
  return {
    gsc: PRODUCT_SCOPES.gsc.every(has) || has("https://www.googleapis.com/auth/webmasters"),
    ga4: PRODUCT_SCOPES.ga4.every(has) || has("https://www.googleapis.com/auth/analytics"),
    ads: PRODUCT_SCOPES.ads.every(has),
  };
}

export function redirectUri(): string {
  return `${getEnv().APP_URL.replace(/\/$/, "")}/api/google/oauth/callback`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function generateState(): string {
  return randomBytes(24).toString("base64url");
}

export function buildAuthorizationUrl(opts: {
  state: string;
  codeChallenge: string;
  scopes: string[];
  loginHint?: string | null;
  forceConsent?: boolean;
}): string {
  const clientId = requireEnv("GOOGLE_CLIENT_ID", "Google OAuth client id");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: opts.scopes.join(" "),
    access_type: "offline",
    include_granted_scopes: "true",
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  // A refresh token is only issued on the first consent (or with prompt=consent).
  if (opts.forceConsent) params.set("prompt", "consent");
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

const TokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  token_type: z.string(),
  id_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

const TokenError = z.object({ error: z.string(), error_description: z.string().optional() });

export class GoogleOAuthError extends Error {
  constructor(
    public readonly code: string,
    description?: string,
  ) {
    super(description ? `${code}: ${description}` : code);
    this.name = "GoogleOAuthError";
  }
  /** True when Google says the grant is gone for good (user revoked, expired, etc.). */
  get isRevoked(): boolean {
    return this.code === "invalid_grant";
  }
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const json: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = TokenError.safeParse(json);
    throw new GoogleOAuthError(err.success ? err.data.error : `http_${res.status}`, err.success ? err.data.error_description : undefined);
  }
  const parsed = TokenResponse.safeParse(json);
  if (!parsed.success) throw new GoogleOAuthError("malformed_token_response");
  return parsed.data;
}

export async function exchangeCodeForTokens(code: string, codeVerifier: string): Promise<TokenResponse> {
  return tokenRequest({
    code,
    client_id: requireEnv("GOOGLE_CLIENT_ID", "Google OAuth client id"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET", "Google OAuth client secret"),
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: codeVerifier,
  });
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({
    refresh_token: refreshToken,
    client_id: requireEnv("GOOGLE_CLIENT_ID", "Google OAuth client id"),
    client_secret: requireEnv("GOOGLE_CLIENT_SECRET", "Google OAuth client secret"),
    grant_type: "refresh_token",
  });
}

/** Best-effort revocation; Google returns 200 on success and 400 if already invalid. */
export async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" });
    return res.ok;
  } catch (e) {
    log.warn("google token revocation failed", { error: (e as Error).message });
    return false;
  }
}

const UserInfo = z.object({ sub: z.string(), email: z.string().optional(), email_verified: z.boolean().optional() });

export async function fetchGoogleUserInfo(accessToken: string): Promise<{ sub: string; email: string | null }> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new GoogleOAuthError(`userinfo_http_${res.status}`);
  const parsed = UserInfo.safeParse(await res.json());
  if (!parsed.success) throw new GoogleOAuthError("malformed_userinfo");
  return { sub: parsed.data.sub, email: parsed.data.email ?? null };
}
