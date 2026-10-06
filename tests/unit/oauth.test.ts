import { describe, it, expect } from "vitest";
import { buildAuthorizationUrl, generatePkce, productsGranted, scopesFor } from "@/lib/google/oauth";
import { signFlow, verifyFlow, OAUTH_FLOW_MAX_AGE_SECONDS } from "@/lib/google/oauth-flow";
import { redact } from "@/lib/logger";

describe("google oauth helpers", () => {
  it("requests least-privilege scopes per product", () => {
    expect(scopesFor(["gsc"])).toEqual(["openid", "email", "https://www.googleapis.com/auth/webmasters.readonly"]);
    expect(scopesFor(["gsc", "ga4", "ads"])).toContain("https://www.googleapis.com/auth/adwords");
    expect(scopesFor(["gsc", "ga4", "ads"])).toContain("https://www.googleapis.com/auth/analytics.readonly");
  });

  it("derives product grants from granted scopes, including partial grants", () => {
    expect(productsGranted(["openid", "https://www.googleapis.com/auth/webmasters.readonly"])).toEqual({ gsc: true, ga4: false, ads: false });
    expect(productsGranted(["https://www.googleapis.com/auth/analytics"])).toEqual({ gsc: false, ga4: true, ads: false });
  });

  it("builds an authorization URL with PKCE, state, offline access and incremental auth", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    const { challenge } = generatePkce();
    const url = new URL(buildAuthorizationUrl({ state: "abc", codeChallenge: challenge, scopes: scopesFor(["gsc"]), forceConsent: true }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("include_granted_scopes")).toBe("true");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/api\/google\/oauth\/callback$/);
  });

  it("signs and verifies the flow cookie, rejecting tampering and expiry", () => {
    const payload = {
      state: "s".repeat(20),
      verifier: "v".repeat(40),
      websiteId: "11111111-1111-4111-8111-111111111111",
      products: ["gsc" as const],
      userId: "22222222-2222-4222-8222-222222222222",
      issuedAt: Date.now(),
    };
    const cookie = signFlow(payload);
    expect(verifyFlow(cookie)).toEqual(payload);
    expect(verifyFlow(cookie.slice(0, -2) + "zz")).toBeNull();
    expect(verifyFlow(cookie, Date.now() + (OAUTH_FLOW_MAX_AGE_SECONDS + 1) * 1000)).toBeNull();
    expect(verifyFlow(undefined)).toBeNull();
  });

  it("logger redacts tokens and secret-looking keys", () => {
    const out = redact({ refresh_token: "1//abc", nested: { authorization: "Bearer x" }, msg: "token ya29.abc-def and Bearer zzz" }) as Record<string, unknown>;
    expect(out.refresh_token).toBe("[redacted]");
    expect((out.nested as Record<string, unknown>).authorization).toBe("[redacted]");
    expect(out.msg).toBe("token [redacted] and Bearer [redacted]");
  });
});
