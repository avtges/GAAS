import { z } from "zod";
import { defineTool, freshnessFor } from "@/lib/ai/tools/registry";
import { DateRangeInput, change, comparisonRange, parseRange, round, safeDiv, smallSampleWarning } from "@/lib/analytics/common";
import { addDays } from "@/lib/dates";
import { withUserDb, one } from "@/lib/db/pool";
import { getGa4Totals, ga4Metrics } from "@/lib/analytics/ga4";
import { getAdsTotals } from "@/lib/analytics/ads";
import { SOURCE_MEASUREMENT } from "@/lib/analytics/status";
import type { Source } from "@/lib/websites/service";
import type { ToolContext } from "@/lib/ai/tools/registry";

async function gscTotals(ctx: ToolContext, range: { start: string; end: string }) {
  const r = await withUserDb(ctx.userId, (db) =>
    one<{ clicks: number; impressions: number; pi: number }>(db, "select coalesce(sum(clicks),0)::float8 as clicks, coalesce(sum(impressions),0)::float8 as impressions, coalesce(sum(position_impressions),0)::float8 as pi from public.gsc_daily_totals where website_id = $1 and date between $2 and $3", [ctx.website.id, range.start, range.end]),
  );
  const clicks = Number(r?.clicks ?? 0);
  const impressions = Number(r?.impressions ?? 0);
  return { clicks, impressions, ctr: round(safeDiv(clicks, impressions), 4), position: round(safeDiv(Number(r?.pi ?? 0), impressions), 1) };
}

async function ga4Channel(ctx: ToolContext, range: { start: string; end: string }, channel: string) {
  const r = await withUserDb(ctx.userId, (db) =>
    one(
      db,
      `select coalesce(sum(sessions),0)::float8 as sessions, coalesce(sum(total_users),0)::float8 as total_users, coalesce(sum(new_users),0)::float8 as new_users,
        coalesce(sum(engaged_sessions),0)::float8 as engaged_sessions, coalesce(sum(key_events),0)::float8 as key_events, coalesce(sum(purchases),0)::float8 as purchases,
        coalesce(sum(purchase_revenue),0)::float8 as purchase_revenue
       from public.ga4_acquisition_daily where website_id = $1 and date between $2 and $3 and session_default_channel_group = $4`,
      [ctx.website.id, range.start, range.end, channel],
    ),
  );
  return ga4Metrics(r);
}

const configured = (ctx: ToolContext, s: Source) => ctx.freshness.find((f) => f.source === s)?.configured === true;

export const compareChannelsTool = defineTool({
  name: "compare_channels",
  description:
    "Side-by-side paid search vs organic search for a period: GA4 sessions/key events/revenue for the 'Paid Search' and 'Organic Search' channel groups, Search Console organic clicks/impressions, and Google Ads clicks/cost/conversions. Each block is labeled with its measurement system; numbers from different systems must not be added together.",
  sources: ["ga4", "gsc", "ads"],
  schema: z.object({ ...DateRangeInput.shape, compare_with_previous_period: z.boolean() }),
  async execute(ctx, args) {
    const range = parseRange(args);
    const prev = comparisonRange(range);
    const warnings = ["These blocks come from different measurement systems (GA4 sessions, Search Console clicks, Google Ads clicks/conversions) with different definitions and attribution. Compare trends within a system; do not add or subtract across systems."];
    const out: Record<string, unknown> = {};
    const sourcesUsed: Source[] = [];
    const dataThrough: Record<string, string | null> = {};
    if (configured(ctx, "ga4")) {
      const f = freshnessFor(ctx, "ga4");
      dataThrough.ga4 = f.data_through;
      sourcesUsed.push("ga4");
      const paid = await ga4Channel(ctx, range, "Paid Search");
      const organic = await ga4Channel(ctx, range, "Organic Search");
      const block: Record<string, unknown> = { measurement: SOURCE_MEASUREMENT.ga4, paid_search: paid, organic_search: organic };
      if (args.compare_with_previous_period) {
        const pp = await ga4Channel(ctx, prev, "Paid Search");
        const po = await ga4Channel(ctx, prev, "Organic Search");
        block.changes = { paid_search_sessions: change(paid.sessions, pp.sessions, 0), organic_search_sessions: change(organic.sessions, po.sessions, 0), paid_search_key_events: change(paid.key_events, pp.key_events, 1), organic_search_key_events: change(organic.key_events, po.key_events, 1) };
      }
      const total = await getGa4Totals(ctx.userId, ctx.website.id, range);
      block.share_of_all_sessions = { paid_search: round(safeDiv(paid.sessions, total.sessions), 4), organic_search: round(safeDiv(organic.sessions, total.sessions), 4) };
      out.ga4 = block;
      if (f.note) warnings.push(f.note);
    } else warnings.push("GA4 is not connected; on-site paid vs organic sessions are unavailable.");
    if (configured(ctx, "gsc")) {
      const f = freshnessFor(ctx, "gsc");
      dataThrough.gsc = f.data_through;
      sourcesUsed.push("gsc");
      const cur = await gscTotals(ctx, range);
      out.search_console_organic = { measurement: SOURCE_MEASUREMENT.gsc, ...cur, ...(args.compare_with_previous_period ? { clicks_change: change(cur.clicks, (await gscTotals(ctx, prev)).clicks, 0) } : {}) };
      if (f.note) warnings.push(f.note);
    } else warnings.push("Search Console is not connected; organic search clicks from Google are unavailable.");
    if (configured(ctx, "ads")) {
      const f = freshnessFor(ctx, "ads");
      dataThrough.ads = f.data_through;
      sourcesUsed.push("ads");
      const cur = await getAdsTotals(ctx.userId, ctx.website.id, range);
      const block: Record<string, unknown> = { measurement: SOURCE_MEASUREMENT.ads, currency: ctx.website.currency, ...cur };
      if (args.compare_with_previous_period) {
        const p = await getAdsTotals(ctx.userId, ctx.website.id, prev);
        block.changes = { clicks: change(cur.clicks, p.clicks, 0), cost: change(cur.cost, p.cost, 2), conversions: change(cur.conversions, p.conversions, 2) };
      }
      out.google_ads_paid = block;
      if (f.note) warnings.push(f.note);
    } else warnings.push("Google Ads is not connected; paid clicks and cost are unavailable.");
    return { source: "multiple", sources_used: sourcesUsed, source_label: "Paid vs organic (multiple sources)", date_range: range, comparison_range: args.compare_with_previous_period ? prev : null, data_through: dataThrough, warnings, ...out };
  },
});

export const compareDateRangesTool = defineTool({
  name: "compare_date_ranges",
  description:
    "Headline metrics for every connected source in one period compared with either the previous period of equal length or the average of the previous four equal-length periods (e.g. 'this week vs the previous four weeks'). Use for 'what changed' questions; follow up with source-specific tools to explain movements.",
  sources: ["gsc", "ga4", "ads"],
  schema: z.object({ ...DateRangeInput.shape, compare_with: z.enum(["previous_period", "previous_four_periods_average"]) }),
  async execute(ctx, args) {
    const range = parseRange(args);
    const n = Math.round((Date.parse(range.end) - Date.parse(range.start)) / 86_400_000) + 1;
    const periods = args.compare_with === "previous_period" ? 1 : 4;
    const baselineRanges = Array.from({ length: periods }, (_, i) => ({ start: addDays(range.start, -n * (i + 1)), end: addDays(range.start, -n * i - 1) }));
    const comparison = { start: baselineRanges[periods - 1].start, end: baselineRanges[0].end };
    const warnings: string[] = ["Each source is measured differently; compare movements within a source, not absolute numbers across sources."];
    const dataThrough: Record<string, string | null> = {};
    const sourcesUsed: Source[] = [];
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const result: Record<string, unknown> = {};

    if (configured(ctx, "gsc")) {
      const f = freshnessFor(ctx, "gsc");
      dataThrough.gsc = f.data_through;
      sourcesUsed.push("gsc");
      const cur = await gscTotals(ctx, range);
      const base = await Promise.all(baselineRanges.map((r) => gscTotals(ctx, r)));
      result.search_console = { clicks: change(cur.clicks, avg(base.map((b) => b.clicks)), 0), impressions: change(cur.impressions, avg(base.map((b) => b.impressions)), 0), ctr: { current: cur.ctr, baseline: round(avg(base.map((b) => b.ctr ?? 0)), 4) }, position: { current: cur.position, baseline: round(avg(base.map((b) => b.position ?? 0)), 1) } };
      if (f.data_through && range.end > f.data_through) warnings.push(`Search Console data is complete only through ${f.data_through}; the current period is partially missing, which biases it downward.`);
    }
    if (configured(ctx, "ga4")) {
      const f = freshnessFor(ctx, "ga4");
      dataThrough.ga4 = f.data_through;
      sourcesUsed.push("ga4");
      const cur = await getGa4Totals(ctx.userId, ctx.website.id, range);
      const base = await Promise.all(baselineRanges.map((r) => getGa4Totals(ctx.userId, ctx.website.id, r)));
      result.ga4 = { sessions: change(cur.sessions, avg(base.map((b) => b.sessions)), 0), total_users: change(cur.total_users, avg(base.map((b) => b.total_users)), 0), key_events: change(cur.key_events, avg(base.map((b) => b.key_events)), 1), purchases: change(cur.purchases, avg(base.map((b) => b.purchases)), 1), purchase_revenue: change(cur.purchase_revenue, avg(base.map((b) => b.purchase_revenue)), 2) };
      const w = smallSampleWarning("GA4 purchases", cur.purchases, avg(base.map((b) => b.purchases)));
      if (w) warnings.push(w);
      if (f.data_through && range.end > f.data_through) warnings.push(`GA4 data is complete only through ${f.data_through}.`);
    }
    if (configured(ctx, "ads")) {
      const f = freshnessFor(ctx, "ads");
      dataThrough.ads = f.data_through;
      sourcesUsed.push("ads");
      const cur = await getAdsTotals(ctx.userId, ctx.website.id, range);
      const base = await Promise.all(baselineRanges.map((r) => getAdsTotals(ctx.userId, ctx.website.id, r)));
      const bCost = avg(base.map((b) => b.cost));
      const bConv = avg(base.map((b) => b.conversions));
      result.google_ads = { cost: change(cur.cost, bCost, 2), clicks: change(cur.clicks, avg(base.map((b) => b.clicks)), 0), conversions: change(cur.conversions, bConv, 2), cpa: { current: cur.cpa, baseline: round(safeDiv(bCost, bConv), 2) }, roas: { current: cur.roas, baseline: round(safeDiv(avg(base.map((b) => b.conversions_value)), bCost), 2) } };
      warnings.push("Recent Google Ads conversions can still increase as conversions inside the attribution window are reported.");
      const w = smallSampleWarning("Google Ads conversions", cur.conversions, bConv);
      if (w) warnings.push(w);
    }
    if (sourcesUsed.length === 0) warnings.push("No sources are connected for this website.");
    return { source: "multiple", sources_used: sourcesUsed, source_label: "All connected sources", date_range: range, comparison_range: comparison, baseline: args.compare_with === "previous_period" ? "previous period" : "average of previous four periods", baseline_ranges: baselineRanges, data_through: dataThrough, warnings, ...result };
  },
});
