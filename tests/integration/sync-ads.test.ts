import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createTenant, asUser, type TenantFixture } from "../setup/fixtures";
import { configureAllSources } from "../setup/configure";
import { closePool, withServiceDb } from "@/lib/db/pool";
import { runSync } from "@/lib/sync/runner";
import { setGoogleAdsProvider } from "@/lib/providers/google-ads";
import { MockGoogleAdsProvider } from "@/lib/providers/google-ads/mock";
import { buildReportQuery, ADS_REPORTS } from "@/lib/providers/google-ads/queries";
import { mergeByKey, normalizeAdsRows } from "@/lib/sync/ads-normalize";
import { GoogleApiError } from "@/lib/providers/errors";
import { addDays, todayInTimeZone } from "@/lib/dates";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const FIXED_NOW = new Date("2026-10-06T18:00:00Z");

describe("Google Ads", () => {
  let t: TenantFixture;
  const today = todayInTimeZone("America/New_York", FIXED_NOW);

  beforeAll(async () => {
    process.env.SYNC_BACKFILL_DAYS = "20";
    t = await createTenant("ads");
    await configureAllSources(t);
  });
  afterAll(async () => closePool());
  afterEach(() => setGoogleAdsProvider(undefined));

  it("builds only fixed, date-bounded GAQL and rejects invalid dates", () => {
    for (const r of ADS_REPORTS) {
      const q = buildReportQuery(r, "2026-09-01", "2026-09-30");
      expect(q).toMatch(/^SELECT .* FROM [a-z_]+ WHERE segments\.date BETWEEN '2026-09-01' AND '2026-09-30'$/);
    }
    expect(() => buildReportQuery("campaign", "2026-09-01' OR 1=1 --", "2026-09-30")).toThrow();
    expect(() => buildReportQuery("campaign", "2026-09-30", "2026-09-01")).toThrow();
  });

  it("the provider code contains no mutate endpoints", () => {
    const dir = path.resolve(__dirname, "../../src/lib/providers/google-ads");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src).not.toMatch(/:mutate|Operation|mutate\(/);
    }
  });

  it("normalizes REST JSON rows (int64 strings, camelCase) and rejects malformed rows", () => {
    const rows = normalizeAdsRows("campaign", [{ campaign: { id: "111", name: "C", status: "ENABLED", advertisingChannelType: "SEARCH" }, segments: { date: "2026-09-01" }, metrics: { impressions: "100", clicks: "10", costMicros: "2500000", conversions: 1.5, conversionsValue: 30 } }]);
    expect(rows[0]).toEqual(["2026-09-01", "111", "C", "ENABLED", "SEARCH", 100, 10, 2500000, 1.5, 30, 0]);
    expect(() => normalizeAdsRows("campaign", [{ campaign: { id: "abc" }, segments: { date: "x" }, metrics: {} }])).toThrow(GoogleApiError);
    const merged = mergeByKey("search_term", [
      ["2026-09-01", "1", "2", "shoes", "NONE", 1, 1, 100, 0, 0],
      ["2026-09-01", "1", "2", "shoes", "NONE", 2, 1, 50, 1, 5],
    ]);
    expect(merged).toEqual([["2026-09-01", "1", "2", "shoes", "NONE", 3, 2, 150, 1, 5]]);
  });

  it("backfills all ads tables in the account time zone", async () => {
    setGoogleAdsProvider(new MockGoogleAdsProvider(() => FIXED_NOW));
    const r = await runSync(t.websiteId, "ads", { now: () => FIXED_NOW, budgetMs: 60_000 });
    expect(r.status, r.error).toBe("succeeded");
    expect(r.outcome?.dataThrough).toBe(addDays(today, -1));
    const counts = await withServiceDb(async (db) => {
      const out: Record<string, number> = {};
      for (const tbl of ["ads_campaign_daily", "ads_ad_group_daily", "ads_keyword_daily", "ads_search_term_daily", "ads_device_daily", "ads_conversion_action_daily"]) {
        out[tbl] = Number((await db.query(`select count(*) from public.${tbl} where website_id = $1`, [t.websiteId])).rows[0].count);
      }
      return out;
    });
    expect(counts.ads_campaign_daily).toBe(20 * 3);
    for (const v of Object.values(counts)) expect(v).toBeGreaterThan(0);
    const cost = await withServiceDb((db) => db.query("select sum(cost_micros)::float8 as c from public.ads_campaign_daily where website_id = $1", [t.websiteId]));
    const dev = await withServiceDb((db) => db.query("select sum(cost_micros)::float8 as c from public.ads_device_daily where website_id = $1", [t.websiteId]));
    expect(Math.abs(Number(cost.rows[0].c) - Number(dev.rows[0].c)) / Number(cost.rows[0].c)).toBeLessThan(0.01);
  });

  it("a removed-permission error marks only Ads as failed", async () => {
    const t2 = await createTenant("ads-perm");
    await configureAllSources(t2);
    await withServiceDb((db) => db.query("update public.website_sources set status = 'ok', data_through = '2026-10-01' where website_id = $1 and source in ('gsc','ga4')", [t2.websiteId]));
    setGoogleAdsProvider({
      listAccessibleCustomers: async () => [],
      getCustomer: async () => {
        throw new Error("unused");
      },
      listClientAccounts: async () => [],
      fetchReport: async () => {
        throw new GoogleApiError("permission_denied", "googleads.searchStream: HTTP 403 The caller does not have permission", 403);
      },
    });
    const r = await runSync(t2.websiteId, "ads", { now: () => FIXED_NOW });
    expect(r.status).toBe("failed");
    const rows = await asUser(t2.userId, (db) => db.query("select source, status from public.website_sources where website_id = $1", [t2.websiteId]));
    expect(Object.fromEntries(rows.rows.map((x) => [x.source, x.status]))).toEqual({ gsc: "ok", ga4: "ok", ads: "error" });
  });
});
