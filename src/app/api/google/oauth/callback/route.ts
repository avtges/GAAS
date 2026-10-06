import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { GoogleOAuthError, exchangeCodeForTokens, fetchGoogleUserInfo, productsGranted } from "@/lib/google/oauth";
import { OAUTH_FLOW_COOKIE, verifyFlow } from "@/lib/google/oauth-flow";
import { saveConnectionFromOAuth } from "@/lib/google/connections";

function redirectWith(websiteId: string | null, params: Record<string, string>): NextResponse {
  const env = getEnv();
  const url = new URL(websiteId ? `/app/w/${websiteId}/connections` : "/app", env.APP_URL);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_FLOW_COOKIE, "", { maxAge: 0, path: "/api/google/oauth" });
  return res;
}

export async function GET(request: NextRequest) {
  const flow = verifyFlow(request.cookies.get(OAUTH_FLOW_COOKIE)?.value);
  const params = request.nextUrl.searchParams;
  const user = await getCurrentUser();

  if (!flow) return redirectWith(null, { error: "oauth_state" });
  if (!user || user.id !== flow.userId) return redirectWith(flow.websiteId, { error: "oauth_user_mismatch" });
  if (params.get("state") !== flow.state) return redirectWith(flow.websiteId, { error: "oauth_state" });

  const googleError = params.get("error");
  if (googleError) {
    log.warn("google oauth denied", { websiteId: flow.websiteId, error: googleError });
    return redirectWith(flow.websiteId, { error: googleError === "access_denied" ? "oauth_denied" : "oauth_error" });
  }
  const code = params.get("code");
  if (!code) return redirectWith(flow.websiteId, { error: "oauth_error" });

  try {
    const tokens = await exchangeCodeForTokens(code, flow.verifier);
    const info = await fetchGoogleUserInfo(tokens.access_token);
    const grantedScopes = tokens.scope ? tokens.scope.split(" ") : [];
    await saveConnectionFromOAuth({
      userId: user.id,
      websiteId: flow.websiteId,
      googleUserId: info.sub,
      googleEmail: info.email,
      refreshToken: tokens.refresh_token ?? null,
      grantedScopes,
      accessTokenExpiry: new Date(Date.now() + tokens.expires_in * 1000),
    });
    const granted = productsGranted(grantedScopes);
    const missing = flow.products.filter((p) => !granted[p]);
    return redirectWith(flow.websiteId, missing.length ? { connected: "1", partial: missing.join(",") } : { connected: "1" });
  } catch (e) {
    const code = e instanceof GoogleOAuthError ? e.code : "oauth_error";
    log.error("google oauth callback failed", { websiteId: flow.websiteId, code, error: (e as Error).message });
    return redirectWith(flow.websiteId, { error: code === "missing_refresh_token" ? "oauth_no_refresh_token" : "oauth_error" });
  }
}
