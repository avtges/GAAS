import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/session";
import { getEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { buildAuthorizationUrl, generatePkce, generateState, scopesFor, type GoogleProduct } from "@/lib/google/oauth";
import { OAUTH_FLOW_COOKIE, OAUTH_FLOW_MAX_AGE_SECONDS, signFlow } from "@/lib/google/oauth-flow";
import { getWebsiteConnection, saveConnectionFromOAuth } from "@/lib/google/connections";
import { requireWebsiteAdmin } from "@/lib/websites/service";
import { rateLimit } from "@/lib/ratelimit";

const Query = z.object({
  websiteId: z.string().uuid(),
  products: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",") : ["gsc", "ga4", "ads"]))
    .pipe(z.array(z.enum(["gsc", "ga4", "ads"])).min(1)),
});

/**
 * Starts the Google OAuth flow for a website. Requires an authenticated owner/admin.
 * In mock mode it short-circuits and creates a fake connection with all scopes.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url));
  const parsed = Query.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid parameters" }, { status: 400 });
  const { websiteId, products } = parsed.data;
  const limit = rateLimit(`oauth:${user.id}`, { capacity: 10, refillPerSecond: 10 / 60 });
  if (!limit.ok) return NextResponse.json({ error: "Too many requests" }, { status: 429 });

  try {
    await requireWebsiteAdmin(user.id, websiteId);
  } catch (e) {
    if (e instanceof AppError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const env = getEnv();
  const back = new URL(`/app/w/${websiteId}/connections`, env.APP_URL);

  if (env.GOOGLE_PROVIDER_MODE === "mock") {
    await saveConnectionFromOAuth({
      userId: user.id,
      websiteId,
      googleUserId: `mock-google-user-${user.id.slice(0, 8)}`,
      googleEmail: user.email ? `mock+${user.email}` : "mock-user@example.com",
      refreshToken: "mock-refresh-token",
      grantedScopes: scopesFor(products as GoogleProduct[]),
      accessTokenExpiry: new Date(Date.now() + 3600_000),
    });
    back.searchParams.set("connected", "1");
    return NextResponse.redirect(back);
  }

  const existing = await getWebsiteConnection(user.id, websiteId);
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const url = buildAuthorizationUrl({
    state,
    codeChallenge: challenge,
    scopes: scopesFor(products as GoogleProduct[]),
    loginHint: existing?.google_email ?? null,
    // Force consent when there is no usable refresh token yet (new or revoked connection).
    forceConsent: !existing || existing.status === "revoked",
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_FLOW_COOKIE, signFlow({ state, verifier, websiteId, products: products as GoogleProduct[], userId: user.id, issuedAt: Date.now() }), {
    httpOnly: true,
    sameSite: "lax",
    secure: env.APP_URL.startsWith("https://"),
    path: "/api/google/oauth",
    maxAge: OAUTH_FLOW_MAX_AGE_SECONDS,
  });
  return res;
}
