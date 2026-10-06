import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTenant, type TenantFixture } from "../setup/fixtures";
import { configureAllSources } from "../setup/configure";
import { closePool, withServiceDb } from "@/lib/db/pool";
import { runSync } from "@/lib/sync/runner";
import { setSearchConsoleProvider } from "@/lib/providers/search-console";
import { MockSearchConsoleProvider } from "@/lib/providers/search-console/mock";
import { setGa4Provider } from "@/lib/providers/ga4";
import { MockGa4Provider } from "@/lib/providers/ga4/mock";
import { setGoogleAdsProvider } from "@/lib/providers/google-ads";
import { MockGoogleAdsProvider } from "@/lib/providers/google-ads/mock";
import { getToolRegistry } from "@/lib/ai/tools";
import type { ToolContext } from "@/lib/ai/tools/registry";
import { getSourceFreshness } from "@/lib/analytics/status";
import { requireWebsiteAccess } from "@/lib/websites/service";
import { addDays, todayInTimeZone } from "@/lib/dates";
import { runChatTurn, setChatClient } from "@/lib/ai/engine";
import { MockChatClient } from "@/lib/ai/mock-client";
import { sendMessage } from "@/lib/chat/service";

const FIXED_NOW = new Date("2026-10-06T18:00:00Z");
const today = todayInTimeZone("America/New_York", FIXED_NOW);
const range = { start_date: addDays(today, -14), end_date: addDays(today, -1) };

async function ctxFor(t: TenantFixture, websiteId = t.websiteId): Promise<ToolContext> {
  const { website } = await requireWebsiteAccess(t.userId, websiteId);
  return { userId: t.userId, website, freshness: await getSourceFreshness(t.userId, websiteId), now: () => FIXED_NOW, today };
}

async function call(t: TenantFixture, name: string, args: Record<string, unknown>, websiteId?: string) {
  const tool = getToolRegistry().get(name)!;
  return tool.execute(await ctxFor(t, websiteId), tool.schema.parse(args));
}

describe("AI tools over all three sources", () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    process.env.SYNC_BACKFILL_DAYS = "40";
    setSearchConsoleProvider(new MockSearchConsoleProvider(() => FIXED_NOW));
    setGa4Provider(new MockGa4Provider(() => FIXED_NOW));
    setGoogleAdsProvider(new MockGoogleAdsProvider(() => FIXED_NOW));
    a = await createTenant("tools-a");
    b = await createTenant("tools-b");
    for (const t of [a, b]) {
      await configureAllSources(t);
      for (const s of ["gsc", "ga4", "ads"] as const) {
        const r = await runSync(t.websiteId, s, { now: () => FIXED_NOW, budgetMs: 120_000 });
        expect(r.status, `${s}: ${r.error}`).toBe("succeeded");
      }
    }
    setChatClient(new MockChatClient(() => today));
  }, 180_000);

  afterAll(async () => {
    setChatClient(undefined);
    await closePool();
  });

  it("every tool schema is valid for OpenAI strict mode", () => {
    const tools = getToolRegistry().openAITools();
    expect(tools.length).toBe(14);
    const check = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(check);
      if (node && typeof node === "object") {
        const o = node as Record<string, unknown>;
        if (o.type === "object") {
          expect(o.additionalProperties).toBe(false);
          expect(new Set(o.required as string[])).toEqual(new Set(Object.keys((o.properties as object) ?? {})));
        }
        for (const k of ["minimum", "maximum", "pattern", "format", "default", "$schema"]) expect(o[k]).toBeUndefined();
        Object.values(o).forEach(check);
      }
    };
    for (const t of tools) {
      expect(t.strict).toBe(true);
      check(t.parameters);
    }
  });

  it("every registered tool executes against real synced data", async () => {
    const args: Record<string, Record<string, unknown>> = {
      get_sync_status: {},
      get_search_performance: { ...range, compare_with_previous_period: true, breakdown: "device" },
      get_search_queries: { ...range, limit: 5, sort_by: "clicks", min_impressions: 0, brand_filter: "all", contains: null },
      get_search_pages: { ...range, limit: 5, sort_by: "clicks", min_impressions: 0, contains: null },
      get_ga4_acquisition: { ...range, compare_with_previous_period: true, group_by: "channel_group", channel_group: null, limit: 10 },
      get_ga4_landing_pages: { ...range, sort_by: "sessions_change", min_sessions: 10, limit: 5 },
      get_ga4_devices: { ...range, compare_with_previous_period: true },
      get_ga4_business_conversions: { ...range, compare_with_previous_period: true },
      get_ads_campaign_performance: { ...range, compare_with_previous_period: true, sort_by: "cost", limit: 5 },
      get_ads_ad_group_performance: { ...range, sort_by: "cost", campaign_id: null, limit: 5 },
      get_ads_keyword_performance: { ...range, sort_by: "cpa", limit: 5 },
      get_ads_search_terms: { ...range, sort_by: "cost", min_cost: 0, limit: 5 },
      compare_date_ranges: { ...range, compare_with: "previous_period" },
      compare_channels: { ...range, compare_with_previous_period: false },
    };
    for (const tool of getToolRegistry().list()) {
      expect(args[tool.name], `missing args for ${tool.name}`).toBeDefined();
      const r = await call(a, tool.name, args[tool.name]);
      expect(Array.isArray(r.warnings)).toBe(true);
      if (Array.isArray(r.rows)) expect((r.rows as unknown[]).length, tool.name).toBeGreaterThan(0);
    }
    const ag = await call(a, "get_ads_ad_group_performance", { ...range, sort_by: "cost", campaign_id: "222", limit: 5 });
    expect((ag.rows as Array<{ campaign_id: string; ad_group_name: string }>).every((r) => r.campaign_id === "222" && r.ad_group_name)).toBe(true);
  });

  it("highest-CPA campaigns are calculated server-side, with zero-conversion guards", async () => {
    const r = await call(a, "get_ads_campaign_performance", { ...range, compare_with_previous_period: true, sort_by: "cpa", limit: 10 });
    const rows = r.rows as Array<{ campaign_name: string; cost: number; conversions: number; cpa: number | null }>;
    expect(rows.length).toBe(3);
    for (const row of rows) {
      if (row.conversions > 0) expect(row.cpa).toBeCloseTo(row.cost / row.conversions, 1);
      else expect(row.cpa).toBeNull();
    }
    const cpas = rows.map((x) => x.cpa ?? Infinity);
    expect(cpas).toEqual([...cpas].sort((x, y) => y - x));
    expect(r.source).toBe("ads");
    expect(r.warnings.join(" ")).toMatch(/Google Ads conversion tracking/);
  });

  it("wasted spend lists only zero-conversion search terms", async () => {
    const r = await call(a, "get_ads_search_terms", { ...range, sort_by: "wasted_spend", min_cost: 0, limit: 20 });
    const rows = r.rows as Array<{ search_term: string; conversions: number; cost: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.conversions === 0 && x.cost > 0)).toBe(true);
    expect(rows.map((x) => x.search_term)).toEqual(expect.arrayContaining(["free running shoes"]));
    expect((r.summary as { zero_conversion_cost: number }).zero_conversion_cost).toBeGreaterThan(0);
  });

  it("weak-CTR queries come from Search Console only", async () => {
    const r = await call(a, "get_search_queries", { ...range, limit: 10, sort_by: "opportunity", min_impressions: 100, brand_filter: "all", contains: null });
    expect(r.source).toBe("gsc");
    const rows = r.rows as Array<{ opportunity_score: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.opportunity_score > 0)).toBe(true);
  });

  it("business conversions disclose missing configuration instead of using key events", async () => {
    const r = await call(a, "get_ga4_business_conversions", { ...range, compare_with_previous_period: true });
    expect(r.configured).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/NOT CONFIGURED/);
    expect(r).not.toHaveProperty("business_conversions");
    await withServiceDb((db) => db.query("update public.websites set business_conversion_event = 'sign_up', revenue_event = 'purchase' where id = $1", [a.websiteId]));
    const r2 = await call(a, "get_ga4_business_conversions", { ...range, compare_with_previous_period: true });
    expect(r2.configured).toBe(true);
    expect(r2.business_conversions).toBeGreaterThan(0);
    expect(r2.definition).toMatch(/sign_up/);
  });

  it("compare_channels labels each measurement system and never sums across them", async () => {
    const r = await call(a, "compare_channels", { ...range, compare_with_previous_period: true });
    expect(r.sources_used).toEqual(["ga4", "gsc", "ads"]);
    expect(r.warnings[0]).toMatch(/different measurement systems/);
    for (const k of ["ga4", "search_console_organic", "google_ads_paid"]) expect((r[k] as { measurement: string }).measurement).toBeTruthy();
    expect(JSON.stringify(r)).not.toMatch(/combined|total_traffic/);
  });

  it("compare_date_ranges supports a four-period baseline", async () => {
    const r = await call(a, "compare_date_ranges", { start_date: addDays(today, -7), end_date: addDays(today, -1), compare_with: "previous_four_periods_average" });
    expect((r.baseline_ranges as unknown[]).length).toBe(4);
    expect(r.comparison_range).toEqual({ start: addDays(today, -35), end: addDays(today, -8) });
    expect(r).toHaveProperty("search_console");
    expect(r).toHaveProperty("ga4");
    expect(r).toHaveProperty("google_ads");
  });

  it("SECURITY: a tool executed with user A's context against user B's website fails", async () => {
    await expect(ctxFor(a, b.websiteId)).rejects.toThrow(/not found/);
    // Even if a context object were forged, RLS returns no rows for B's data.
    const { website } = await requireWebsiteAccess(b.userId, b.websiteId);
    const forged: ToolContext = { userId: a.userId, website, freshness: [], now: () => FIXED_NOW, today };
    const tool = getToolRegistry().get("get_ads_campaign_performance")!;
    const r = await tool.execute(forged, tool.schema.parse({ ...range, compare_with_previous_period: false, sort_by: "cost", limit: 10 }));
    expect(r.rows).toEqual([]);
    expect((r.totals as { cost: number }).cost).toBe(0);
  });

  it("SECURITY: chat rejects a forged website id and a foreign thread id", async () => {
    await expect(sendMessage(a.userId, b.websiteId, null, { message: "What changed?" })).rejects.toThrow(/not found/);
    const own = await sendMessage(b.userId, b.websiteId, null, { message: "status" });
    await expect(sendMessage(a.userId, a.websiteId, own.threadId, { message: "hi" })).rejects.toThrow(/not found/);
  });

  it("tool arguments are validated: the model cannot pass unknown fields or bad dates", async () => {
    const tool = getToolRegistry().get("get_search_queries")!;
    expect(tool.schema.safeParse({ ...range, limit: 500, sort_by: "clicks", min_impressions: 0, brand_filter: "all", contains: null }).success).toBe(false);
    await expect(call(a, "get_search_performance", { start_date: "2026-13-01", end_date: "2026-10-01", compare_with_previous_period: false, breakdown: "none" })).rejects.toThrow(/valid/);
    expect(tool.schema.safeParse({ ...range, limit: 5, sort_by: "clicks", min_impressions: 0, brand_filter: "all", contains: null, organization_id: "x" }).success).toBe(true); // stripped
    const parsed = tool.schema.parse({ ...range, limit: 5, sort_by: "clicks", min_impressions: 0, brand_filter: "all", contains: null, organization_id: "x" });
    expect(parsed).not.toHaveProperty("organization_id");
  });

  describe("AI behaviour (mock model, deterministic)", () => {
    const pick = async (q: string) => (await runChatTurn({ userId: a.userId, website: (await requireWebsiteAccess(a.userId, a.websiteId)).website, history: [], message: q })).executed.map((e) => e.name);

    it("routes representative questions to the right source", async () => {
      expect(await pick("Which search queries have lots of impressions but weak CTR?")).toContain("get_search_queries");
      expect(await pick("Which Google Ads campaigns have the highest CPA?")).toContain("get_ads_campaign_performance");
      expect(await pick("What Google Ads search terms are wasting money?")).toContain("get_ads_search_terms");
      expect(await pick("Compare paid and organic traffic over the last 30 days")).toContain("compare_channels");
      expect(await pick("What changed over the last 30 days?")).toContain("compare_date_ranges");
    });

    it("grounding metadata reflects executed tools, not model text", async () => {
      const { website } = await requireWebsiteAccess(a.userId, a.websiteId);
      const r = await runChatTurn({ userId: a.userId, website, history: [], message: "Compare paid and organic traffic over the last 30 days" });
      expect(r.grounding.sources.sort()).toEqual(["ads", "ga4", "gsc"]);
      expect(r.grounding.date_ranges.length).toBeGreaterThan(0);
      expect(Object.keys(r.grounding.data_through).sort()).toEqual(["ads", "ga4", "gsc"]);
      expect(r.grounding.warnings.join(" ")).toMatch(/different measurement systems/);
    });

    it("answers never contain numbers that are absent from tool outputs", async () => {
      const { website } = await requireWebsiteAccess(a.userId, a.websiteId);
      const r = await runChatTurn({ userId: a.userId, website, history: [], message: "Which Google Ads campaigns have the highest CPA in the last 14 days?" });
      const toolText = JSON.stringify(r.executed.map((e) => e.envelope));
      const numbers = r.content.match(/\d+(\.\d+)?/g) ?? [];
      for (const n of numbers) expect(toolText.includes(n), `number ${n} not in tool output`).toBe(true);
    });

    it("discloses when a source is not connected", async () => {
      const c = await createTenant("tools-c"); // nothing connected
      const { website } = await requireWebsiteAccess(c.userId, c.websiteId);
      const r = await runChatTurn({ userId: c.userId, website, history: [], message: "Which Google Ads campaigns have the highest CPA?" });
      expect(r.content + JSON.stringify(r.grounding)).toMatch(/not connected|No campaigns/i);
    });
  });
});
