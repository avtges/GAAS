import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createTenant, asUser, type TenantFixture } from "../setup/fixtures";
import { closePool, withServiceDb } from "@/lib/db/pool";
import { resetEnvCache } from "@/lib/env";
import {
  clearTokenCache,
  disconnectGoogle,
  getAccessTokenForConnection,
  getWebsiteConnection,
  saveConnectionFromOAuth,
} from "@/lib/google/connections";
import { decryptSecret } from "@/lib/crypto/tokens";

describe("google connections", () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    a = await createTenant("conn-a");
    b = await createTenant("conn-b");
  });
  afterAll(async () => {
    await closePool();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetEnvCache();
    clearTokenCache();
  });

  it("stores an encrypted refresh token, merges scopes on reconnect, and attaches to the website", async () => {
    const conn = await saveConnectionFromOAuth({
      userId: a.userId,
      websiteId: a.websiteId,
      googleUserId: "google-sub-1",
      googleEmail: "a@gmail.test",
      refreshToken: "1//first",
      grantedScopes: ["openid", "email", "https://www.googleapis.com/auth/webmasters.readonly"],
      accessTokenExpiry: new Date(),
    });
    const stored = await withServiceDb((db) => db.query<{ encrypted_refresh_token: string }>("select encrypted_refresh_token from public.google_connections where id = $1", [conn.id]));
    expect(stored.rows[0].encrypted_refresh_token).not.toContain("1//first");
    expect(decryptSecret(stored.rows[0].encrypted_refresh_token)).toBe("1//first");

    // Incremental grant without a new refresh token keeps the old one and merges scopes.
    const again = await saveConnectionFromOAuth({
      userId: a.userId,
      websiteId: a.websiteId,
      googleUserId: "google-sub-1",
      googleEmail: "a@gmail.test",
      refreshToken: null,
      grantedScopes: ["https://www.googleapis.com/auth/adwords"],
      accessTokenExpiry: new Date(),
    });
    expect(again.id).toBe(conn.id);
    expect(again.granted_scopes).toEqual(expect.arrayContaining(["https://www.googleapis.com/auth/webmasters.readonly", "https://www.googleapis.com/auth/adwords"]));
    const site = await getWebsiteConnection(a.userId, a.websiteId);
    expect(site?.id).toBe(conn.id);
  });

  it("refuses to create a brand-new connection without a refresh token", async () => {
    await expect(
      saveConnectionFromOAuth({
        userId: b.userId,
        websiteId: b.websiteId,
        googleUserId: "google-sub-2",
        googleEmail: null,
        refreshToken: null,
        grantedScopes: ["openid"],
        accessTokenExpiry: new Date(),
      }),
    ).rejects.toThrow(/refresh token/);
  });

  it("user B cannot attach a connection to user A's website", async () => {
    await expect(
      saveConnectionFromOAuth({
        userId: b.userId,
        websiteId: a.websiteId,
        googleUserId: "google-sub-3",
        googleEmail: null,
        refreshToken: "1//x",
        grantedScopes: ["openid"],
        accessTokenExpiry: new Date(),
      }),
    ).rejects.toThrow(/not found/);
  });

  it("marks the connection and its sources revoked when Google answers invalid_grant", async () => {
    process.env.GOOGLE_PROVIDER_MODE = "live";
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    resetEnvCache();
    const conn = (await getWebsiteConnection(a.userId, a.websiteId))!;
    await withServiceDb((db) => db.query("update public.website_sources set status = 'ok', next_sync_at = now() where website_id = $1 and source = 'gsc'", [a.websiteId]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 })),
    );
    await expect(getAccessTokenForConnection(conn.id)).rejects.toThrow(/invalid_grant/);
    const after = await getWebsiteConnection(a.userId, a.websiteId);
    expect(after?.status).toBe("revoked");
    const src = await asUser(a.userId, (db) => db.query<{ status: string; next_sync_at: string | null }>("select status, next_sync_at from public.website_sources where website_id = $1 and source = 'gsc'", [a.websiteId]));
    expect(src.rows[0].status).toBe("revoked");
    expect(src.rows[0].next_sync_at).toBeNull();
    // Subsequent calls short-circuit without calling Google again.
    await expect(getAccessTokenForConnection(conn.id)).rejects.toThrow(/revoked/);
  });

  it("refreshes successfully and caches the access token", async () => {
    process.env.GOOGLE_PROVIDER_MODE = "live";
    process.env.GOOGLE_CLIENT_ID = "cid";
    process.env.GOOGLE_CLIENT_SECRET = "csecret";
    resetEnvCache();
    const conn = await saveConnectionFromOAuth({
      userId: a.userId,
      websiteId: a.websiteId,
      googleUserId: "google-sub-1",
      googleEmail: "a@gmail.test",
      refreshToken: "1//fresh",
      grantedScopes: ["openid"],
      accessTokenExpiry: new Date(),
    });
    expect(conn.status).toBe("active");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "ya29.new", expires_in: 3600, token_type: "Bearer", scope: "openid" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const t1 = await getAccessTokenForConnection(conn.id);
    const t2 = await getAccessTokenForConnection(conn.id);
    expect(t1.accessToken).toBe("ya29.new");
    expect(t2.accessToken).toBe("ya29.new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disconnect revokes at Google, deletes the connection and marks sources disconnected", async () => {
    process.env.GOOGLE_PROVIDER_MODE = "live";
    resetEnvCache();
    const revoke = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", revoke);
    await withServiceDb((db) => db.query("update public.website_sources set status = 'ok' where website_id = $1 and source = 'gsc'", [a.websiteId]));
    await expect(disconnectGoogle(b.userId, a.websiteId)).rejects.toThrow(/not found/); // cross-tenant
    await disconnectGoogle(a.userId, a.websiteId);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(String((revoke.mock.calls[0] as unknown[])[0])).toContain("https://oauth2.googleapis.com/revoke");
    expect(await getWebsiteConnection(a.userId, a.websiteId)).toBeNull();
    const src = await asUser(a.userId, (db) =>
      db.query<{ source: string; status: string }>("select source, status from public.website_sources where website_id = $1 order by source", [a.websiteId]),
    );
    // Only sources that had been configured are marked disconnected; the rest stay not_configured.
    expect(Object.fromEntries(src.rows.map((r) => [r.source, r.status]))).toEqual({ ads: "not_configured", ga4: "not_configured", gsc: "disconnected" });
  });
});

describe("delete website data", () => {
  it("removes analytics, chats and credentials; refuses other tenants", async () => {
    const { createTenant: ct, seedGscTotals } = await import("../setup/fixtures");
    const { deleteWebsiteData } = await import("@/lib/websites/delete");
    const t = await ct("delete-me");
    const other = await ct("other");
    await seedGscTotals(t, 5);
    await saveConnectionFromOAuth({ userId: t.userId, websiteId: t.websiteId, googleUserId: "del-g", googleEmail: null, refreshToken: "1//del", grantedScopes: ["openid"], accessTokenExpiry: new Date() });
    await withServiceDb((db) => db.query("insert into public.chat_threads (organization_id, website_id, created_by) values ($1, $2, $3)", [t.orgId, t.websiteId, t.userId]));
    await expect(deleteWebsiteData(other.userId, t.websiteId)).rejects.toThrow(/not found/);
    const r = await deleteWebsiteData(t.userId, t.websiteId);
    expect(r.credentialsRemoved).toBe(true);
    const left = await withServiceDb(async (db) => ({
      gsc: Number((await db.query("select count(*) from public.gsc_daily_totals where website_id = $1", [t.websiteId])).rows[0].count),
      chats: Number((await db.query("select count(*) from public.chat_threads where website_id = $1", [t.websiteId])).rows[0].count),
      conns: Number((await db.query("select count(*) from public.google_connections where organization_id = $1", [t.orgId])).rows[0].count),
    }));
    expect(left).toEqual({ gsc: 0, chats: 0, conns: 0 });
  });
});
