import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTenant, asUser, type TenantFixture } from "../setup/fixtures";
import { closePool, withServiceDb } from "@/lib/db/pool";
import { saveConnectionFromOAuth } from "@/lib/google/connections";
import { scopesFor } from "@/lib/google/oauth";
import { resetSourceData } from "@/lib/sources/select";
import { runSync } from "@/lib/sync/runner";
import { setSearchConsoleProvider } from "@/lib/providers/search-console";
import { MockSearchConsoleProvider } from "@/lib/providers/search-console/mock";
import { GoogleApiError } from "@/lib/providers/errors";
import { addDays, todayInTimeZone } from "@/lib/dates";

const FIXED_NOW = new Date("2026-10-06T18:00:00Z"); // 11:00 PDT

async function configureGsc(t: TenantFixture) {
  await saveConnectionFromOAuth({
    userId: t.userId,
    websiteId: t.websiteId,
    googleUserId: `g-${t.userId}`,
    googleEmail: "x@example.test",
    refreshToken: "1//mock",
    grantedScopes: scopesFor(["gsc"]),
    accessTokenExpiry: new Date(),
  });
  await withServiceDb((db) => db.query("update public.websites set gsc_property = 'sc-domain:acme.example' where id = $1", [t.websiteId]));
  await resetSourceData(t.orgId, t.websiteId, "gsc", "ok");
}

describe("Search Console sync (mock provider)", () => {
  let t: TenantFixture;
  const today = todayInTimeZone("America/Los_Angeles", FIXED_NOW);

  beforeAll(async () => {
    process.env.SYNC_BACKFILL_DAYS = "20";
    t = await createTenant("gsc");
    await configureGsc(t);
  });
  afterAll(async () => {
    await closePool();
  });
  afterEach(() => setSearchConsoleProvider(undefined));

  it("backfills ~N days into all gsc tables and sets data_through from firstIncompleteDate", async () => {
    setSearchConsoleProvider(new MockSearchConsoleProvider(() => FIXED_NOW));
    const r = await runSync(t.websiteId, "gsc", { now: () => FIXED_NOW, budgetMs: 60_000 });
    expect(r.status).toBe("succeeded");
    expect(r.outcome?.complete).toBe(true);
    expect(r.outcome?.rangeStart).toBe(addDays(today, -20));
    expect(r.outcome?.rangeEnd).toBe(addDays(today, -1));
    // Mock marks the last 2 PST days incomplete → data_through = today - 3
    expect(r.outcome?.dataThrough).toBe(addDays(today, -3));

    const counts = await withServiceDb(async (db) => {
      const q = async (table: string) => Number((await db.query(`select count(*) from public.${table} where website_id = $1`, [t.websiteId])).rows[0].count);
      return { totals: await q("gsc_daily_totals"), queries: await q("gsc_query_daily"), pages: await q("gsc_page_daily"), devices: await q("gsc_device_daily"), countries: await q("gsc_country_daily") };
    });
    expect(counts.totals).toBe(20); // every day in range has data (incomplete days included with partial values)
    expect(counts.queries).toBeGreaterThan(20 * 20);
    expect(counts.pages).toBeGreaterThan(20 * 5);
    expect(counts.devices).toBeGreaterThanOrEqual(20 * 2);
    expect(counts.devices).toBeLessThanOrEqual(20 * 3);
    expect(counts.countries).toBeGreaterThan(20 * 4);

    const src = await asUser(t.userId, (db) => db.query("select status, backfill_done, backfill_cursor, data_through::text as data_through, next_sync_at from public.website_sources where website_id = $1 and source = 'gsc'", [t.websiteId]));
    expect(src.rows[0]).toMatchObject({ status: "ok", backfill_done: true, backfill_cursor: null, data_through: addDays(today, -3) });
    expect(src.rows[0].next_sync_at).not.toBeNull();

    const jobs = await asUser(t.userId, (db) => db.query("select kind, status, rows_written from public.sync_jobs where website_id = $1", [t.websiteId]));
    expect(jobs.rows).toEqual([expect.objectContaining({ kind: "backfill", status: "succeeded" })]);
    expect(jobs.rows[0].rows_written).toBeGreaterThan(0);
  });

  it("stores impression-weighted position so averages can be recomputed", async () => {
    const row = await withServiceDb((db) =>
      db.query<{ clicks: string; impressions: string; position_impressions: number }>(
        "select clicks, impressions, position_impressions from public.gsc_daily_totals where website_id = $1 order by date limit 1",
        [t.websiteId],
      ),
    );
    const r = row.rows[0];
    expect(Number(r.impressions)).toBeGreaterThan(0);
    const avgPosition = r.position_impressions / Number(r.impressions);
    expect(avgPosition).toBeGreaterThan(1);
    expect(avgPosition).toBeLessThan(60);
  });

  it("incremental sync re-fetches the reconciliation window and keeps data_through monotonic", async () => {
    setSearchConsoleProvider(new MockSearchConsoleProvider(() => FIXED_NOW));
    const r = await runSync(t.websiteId, "gsc", { now: () => FIXED_NOW, force: true });
    expect(r.status).toBe("succeeded");
    expect(r.outcome?.rangeStart).toBe(addDays(addDays(today, -3), -3)); // data_through - RECONCILIATION_DAYS_GSC(3)
    expect(r.outcome?.dataThrough).toBe(addDays(today, -3));
    const jobs = await asUser(t.userId, (db) => db.query("select kind from public.sync_jobs where website_id = $1 order by started_at", [t.websiteId]));
    expect(jobs.rows.map((j) => j.kind)).toEqual(["backfill", "incremental"]);
  });

  it("a backfill interrupted by the time budget resumes from its cursor", async () => {
    const t2 = await createTenant("gsc-resume");
    await configureGsc(t2);
    setSearchConsoleProvider(new MockSearchConsoleProvider(() => FIXED_NOW));
    const first = await runSync(t2.websiteId, "gsc", { now: () => FIXED_NOW, budgetMs: 0 });
    expect(first.status).toBe("succeeded");
    expect(first.outcome?.complete).toBe(false);
    const mid = await withServiceDb((db) => db.query("select backfill_done, backfill_cursor::text as c, next_sync_at from public.website_sources where website_id = $1 and source = 'gsc'", [t2.websiteId]));
    expect(mid.rows[0].backfill_done).toBe(false);
    expect(mid.rows[0].c).toBeNull(); // nothing processed yet with a zero budget
    const second = await runSync(t2.websiteId, "gsc", { now: () => FIXED_NOW, budgetMs: 60_000 });
    expect(second.outcome?.complete).toBe(true);
    const done = await withServiceDb((db) => db.query("select backfill_done from public.website_sources where website_id = $1 and source = 'gsc'", [t2.websiteId]));
    expect(done.rows[0].backfill_done).toBe(true);
  });

  it("a permission error marks only this source as error, with the Google message", async () => {
    const t3 = await createTenant("gsc-perm");
    await configureGsc(t3);
    setSearchConsoleProvider({
      listSites: async () => [],
      query: async () => {
        throw new GoogleApiError("permission_denied", "searchconsole: HTTP 403 User does not have sufficient permission for site", 403);
      },
    });
    const r = await runSync(t3.websiteId, "gsc", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    const rows = await asUser(t3.userId, (db) => db.query("select source, status, last_error from public.website_sources where website_id = $1 order by source", [t3.websiteId]));
    const bydSource = Object.fromEntries(rows.rows.map((r) => [r.source, r]));
    expect(bydSource.gsc.status).toBe("error");
    expect(bydSource.gsc.last_error).toMatch(/denied access/);
    expect(bydSource.ga4.status).toBe("not_configured");
    expect(bydSource.ads.status).toBe("not_configured");
    const job = await asUser(t3.userId, (db) => db.query("select status, error_message from public.sync_jobs where website_id = $1", [t3.websiteId]));
    expect(job.rows[0].status).toBe("failed");
  });

  it("an unauthenticated error marks the connection revoked and stops future syncs", async () => {
    const t4 = await createTenant("gsc-auth");
    await configureGsc(t4);
    setSearchConsoleProvider({
      listSites: async () => [],
      query: async () => {
        throw new GoogleApiError("unauthenticated", "searchconsole: HTTP 401", 401);
      },
    });
    const r = await runSync(t4.websiteId, "gsc", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    const src = await asUser(t4.userId, (db) => db.query("select status, next_sync_at from public.website_sources where website_id = $1 and source = 'gsc'", [t4.websiteId]));
    expect(src.rows[0]).toMatchObject({ status: "revoked", next_sync_at: null });
    const conn = await asUser(t4.userId, (db) => db.query("select status from public.google_connections"));
    expect(conn.rows[0].status).toBe("revoked");
    // A revoked source cannot be claimed again.
    const again = await runSync(t4.websiteId, "gsc", { now: () => FIXED_NOW });
    expect(again.status).toBe("skipped");
  });

  it("malformed provider responses are reported, not stored", async () => {
    const t5 = await createTenant("gsc-malformed");
    await configureGsc(t5);
    setSearchConsoleProvider({
      listSites: async () => [],
      query: async () => {
        throw new GoogleApiError("malformed", "searchconsole.searchanalytics.query: unexpected response shape (rows.0.clicks)");
      },
    });
    const r = await runSync(t5.websiteId, "gsc", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/unexpected response/);
    const n = await withServiceDb((db) => db.query("select count(*) from public.gsc_daily_totals where website_id = $1", [t5.websiteId]));
    expect(Number(n.rows[0].count)).toBe(0);
  });
});
