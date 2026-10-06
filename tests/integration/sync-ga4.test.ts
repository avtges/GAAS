import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTenant, asUser, type TenantFixture } from "../setup/fixtures";
import { closePool, withServiceDb } from "@/lib/db/pool";
import { saveConnectionFromOAuth } from "@/lib/google/connections";
import { scopesFor } from "@/lib/google/oauth";
import { resetSourceData } from "@/lib/sources/select";
import { runSync } from "@/lib/sync/runner";
import { setGa4Provider } from "@/lib/providers/ga4";
import { MockGa4Provider } from "@/lib/providers/ga4/mock";
import { validateGa4Schema } from "@/lib/providers/ga4/schema";
import { addDays, todayInTimeZone } from "@/lib/dates";

const FIXED_NOW = new Date("2026-10-06T18:00:00Z");

async function configureGa4(t: TenantFixture) {
  await saveConnectionFromOAuth({ userId: t.userId, websiteId: t.websiteId, googleUserId: `g-${t.userId}`, googleEmail: null, refreshToken: "1//mock", grantedScopes: scopesFor(["ga4"]), accessTokenExpiry: new Date() });
  await withServiceDb((db) => db.query("update public.websites set ga4_property_id = '123456789' where id = $1", [t.websiteId]));
  await resetSourceData(t.orgId, t.websiteId, "ga4", "ok");
}

describe("GA4 sync (mock provider)", () => {
  let t: TenantFixture;
  const today = todayInTimeZone("America/New_York", FIXED_NOW);

  beforeAll(async () => {
    process.env.SYNC_BACKFILL_DAYS = "20";
    t = await createTenant("ga4");
    await configureGa4(t);
  });
  afterAll(async () => closePool());
  afterEach(() => setGa4Provider(undefined));

  it("schema validation reports missing names", () => {
    expect(validateGa4Schema({ dimensions: [{ apiName: "date" }], metrics: [{ apiName: "sessions" }] })).toMatchObject({ ok: false, missingDimensions: expect.arrayContaining(["landingPage"]), missingMetrics: expect.arrayContaining(["keyEvents"]) });
  });

  it("backfills all GA4 tables with consistent totals in the property time zone", async () => {
    setGa4Provider(new MockGa4Provider(() => FIXED_NOW));
    const r = await runSync(t.websiteId, "ga4", { now: () => FIXED_NOW, budgetMs: 60_000 });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.outcome?.rangeEnd).toBe(addDays(today, -1));
    expect(r.outcome?.dataThrough).toBe(addDays(today, -1));
    const sums = await withServiceDb(async (db) => {
      const q = async (sql: string) => Number((await db.query(sql, [t.websiteId])).rows[0].v);
      return {
        totals: await q("select sum(sessions) as v from public.ga4_daily_totals where website_id = $1"),
        acq: await q("select sum(sessions) as v from public.ga4_acquisition_daily where website_id = $1"),
        lp: await q("select sum(sessions) as v from public.ga4_landing_page_daily where website_id = $1"),
        dev: await q("select sum(sessions) as v from public.ga4_device_daily where website_id = $1"),
        days: await q("select count(*) as v from public.ga4_daily_totals where website_id = $1"),
        events: await q("select count(distinct event_name) as v from public.ga4_event_daily where website_id = $1"),
      };
    });
    expect(sums.days).toBe(20);
    expect(sums.totals).toBeGreaterThan(0);
    expect(sums.acq).toBe(sums.totals);
    expect(sums.lp).toBe(sums.totals);
    expect(sums.dev).toBe(sums.totals);
    expect(sums.events).toBe(7);
    const src = await asUser(t.userId, (db) => db.query("select status, limitations from public.website_sources where website_id = $1 and source = 'ga4'", [t.websiteId]));
    expect(src.rows[0].status).toBe("ok");
    expect(src.rows[0].limitations.schema_validated_at).toBeTruthy();
    expect(src.rows[0].limitations.reporting_time_zone).toBe("America/New_York");
  });

  it("fails clearly when the property's metadata lacks a required metric", async () => {
    const t2 = await createTenant("ga4-schema");
    await configureGa4(t2);
    const mock = new MockGa4Provider(() => FIXED_NOW);
    mock.getMetadata = async () => ({ dimensions: [{ apiName: "date" }], metrics: [{ apiName: "sessions" }] });
    setGa4Provider(mock);
    const r = await runSync(t2.websiteId, "ga4", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/schema check failed/);
    expect(r.error).toMatch(/metric keyEvents/);
  });

  it("a failing GA4 sync does not affect Search Console status", async () => {
    const t3 = await createTenant("ga4-isolation");
    await configureGa4(t3);
    await withServiceDb((db) => db.query("update public.website_sources set status = 'ok', data_through = '2026-10-01' where website_id = $1 and source = 'gsc'", [t3.websiteId]));
    const mock = new MockGa4Provider(() => FIXED_NOW);
    mock.runReport = async () => {
      throw new (await import("@/lib/providers/errors")).GoogleApiError("not_found", "analyticsdata.runReport: HTTP 404 Property not found", 404);
    };
    setGa4Provider(mock);
    const r = await runSync(t3.websiteId, "ga4", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    const rows = await asUser(t3.userId, (db) => db.query("select source, status, last_error from public.website_sources where website_id = $1", [t3.websiteId]));
    const by = Object.fromEntries(rows.rows.map((x) => [x.source, x]));
    expect(by.ga4.status).toBe("error");
    expect(by.ga4.last_error).toMatch(/not found/);
    expect(by.gsc.status).toBe("ok");
  });
});
