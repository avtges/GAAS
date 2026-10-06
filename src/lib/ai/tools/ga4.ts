import { z } from "zod";
import { defineTool, clampRangeToDataThrough, freshnessFor } from "@/lib/ai/tools/registry";
import { DateRangeInput, change, comparisonRange, parseRange, safeDiv, round, smallSampleWarning } from "@/lib/analytics/common";
import { getEventCounts, getGa4Acquisition, getGa4Devices, getGa4LandingPages, getGa4Totals, listObservedEvents } from "@/lib/analytics/ga4";
import { SOURCE_LABELS, SOURCE_MEASUREMENT } from "@/lib/analytics/status";

const base = (dataThrough: string | null) => ({ source: "ga4" as const, source_label: SOURCE_LABELS.ga4, measurement: SOURCE_MEASUREMENT.ga4, data_through: { ga4: dataThrough } });

export const getGa4AcquisitionTool = defineTool({
  name: "get_ga4_acquisition",
  description:
    "Google Analytics 4 website traffic by acquisition: sessions, users, new users, engaged sessions, engagement rate, key events (GA4's platform metric), purchases and purchase revenue, grouped by default channel group, source/medium or campaign, with optional comparison to the previous period. Use for 'what happened to traffic', channel mix, campaign traffic.",
  sources: ["ga4"],
  schema: z.object({
    ...DateRangeInput.shape,
    compare_with_previous_period: z.boolean(),
    group_by: z.enum(["channel_group", "source_medium", "campaign"]),
    channel_group: z.string().nullable().describe("Restrict to one GA4 default channel group, e.g. 'Organic Search' or 'Paid Search'; null for all"),
    limit: z.number().int().min(1).max(30),
  }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "ga4");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const r = await getGa4Acquisition(ctx.userId, ctx.website.id, range, { groupBy: args.group_by, limit: args.limit, compare: args.compare_with_previous_period, channelGroup: args.channel_group });
    if (f.note) warnings.push(f.note);
    return { ...base(f.data_through), date_range: r.date_range, comparison_range: r.comparison_range, filters: { group_by: args.group_by, channel_group: args.channel_group }, warnings: [...warnings, ...r.warnings], totals: r.totals, previous_totals: r.previous_totals, changes: r.changes, rows: r.rows, total_groups: r.total_groups, currency: ctx.website.currency };
  },
});

export const getGa4LandingPagesTool = defineTool({
  name: "get_ga4_landing_pages",
  description: "GA4 landing pages (first page of a session) with sessions, engagement rate, key events, purchases and revenue, and change vs the previous period. Use for 'which landing pages produce the strongest traffic / are improving'. Covers all channels.",
  sources: ["ga4"],
  schema: z.object({
    ...DateRangeInput.shape,
    sort_by: z.enum(["sessions", "sessions_change", "key_events", "engagement_rate", "purchase_revenue"]),
    min_sessions: z.number().int().min(0).describe("Ignore pages with fewer sessions in both periods (e.g. 30)"),
    limit: z.number().int().min(1).max(30),
  }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "ga4");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const r = await getGa4LandingPages(ctx.userId, ctx.website.id, range, { limit: args.limit, sortBy: args.sort_by, minSessions: args.min_sessions });
    if (f.note) warnings.push(f.note);
    if (r.rows.length === 0) warnings.push("No landing pages matched in this date range.");
    return { ...base(f.data_through), date_range: r.date_range, comparison_range: r.comparison_range, filters: { sort_by: args.sort_by, min_sessions: args.min_sessions }, warnings, rows: r.rows, total_pages: r.total_pages, notes: r.notes };
  },
});

export const getGa4DevicesTool = defineTool({
  name: "get_ga4_devices",
  description: "GA4 sessions, engagement, key events and revenue by device category (desktop, mobile, tablet) with change vs the previous period.",
  sources: ["ga4"],
  schema: z.object({ ...DateRangeInput.shape, compare_with_previous_period: z.boolean() }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "ga4");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const r = await getGa4Devices(ctx.userId, ctx.website.id, range);
    if (f.note) warnings.push(f.note);
    return { ...base(f.data_through), date_range: r.date_range, comparison_range: args.compare_with_previous_period ? r.comparison_range : null, warnings, rows: r.rows };
  },
});

export const getGa4BusinessConversionsTool = defineTool({
  name: "get_ga4_business_conversions",
  description:
    "Business conversions as defined by the website's semantic configuration (business_conversion_event and revenue_event, which are GA4 event names), with comparison to the previous period. If the configuration is missing, returns which GA4 events exist instead of guessing. Use for questions about conversions, sign-ups, subscriptions, leads, customers or purchases as business outcomes.",
  sources: ["ga4"],
  schema: z.object({ ...DateRangeInput.shape, compare_with_previous_period: z.boolean() }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "ga4");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const prev = comparisonRange(range);
    if (f.note) warnings.push(f.note);
    const conv = ctx.website.business_conversion_event;
    const rev = ctx.website.revenue_event;
    const observed = await listObservedEvents(ctx.userId, ctx.website.id, range);
    if (!conv) {
      warnings.push("business_conversion_event is NOT CONFIGURED for this website, so business conversions cannot be reported. GA4 key events and events are listed for reference only; they are platform metrics, not confirmed business outcomes.");
      return { ...base(f.data_through), date_range: range, comparison_range: null, warnings, configured: false, observed_events: observed, how_to_fix: "Set the business conversion event in Settings → Semantic configuration." };
    }
    const totals = await getGa4Totals(ctx.userId, ctx.website.id, range);
    const cur = await getEventCounts(ctx.userId, ctx.website.id, range, conv);
    const before = args.compare_with_previous_period ? await getEventCounts(ctx.userId, ctx.website.id, prev, conv) : null;
    const prevTotals = args.compare_with_previous_period ? await getGa4Totals(ctx.userId, ctx.website.id, prev) : null;
    if (cur.days_with_data === 0) warnings.push(`No '${conv}' events were recorded in this date range. Check that the event name is correct and still sent by the site.`);
    if (before) {
      const w = smallSampleWarning(`'${conv}' comparison`, cur.event_count, before.event_count);
      if (w) warnings.push(w);
    }
    let revenue: Record<string, unknown> | null = null;
    if (rev) {
      if (rev === "purchase") {
        revenue = { event: rev, purchase_revenue: totals.purchase_revenue, previous_purchase_revenue: prevTotals?.purchase_revenue ?? null, change: prevTotals ? change(totals.purchase_revenue, prevTotals.purchase_revenue, 2) : null, currency: ctx.website.currency, note: "GA4 purchaseRevenue (ecommerce purchase events)." };
      } else {
        warnings.push(`revenue_event is '${rev}', but only GA4 ecommerce purchase revenue is imported; revenue for other events is not available.`);
      }
    } else {
      warnings.push("revenue_event is not configured; revenue is not reported as a business metric.");
    }
    return {
      ...base(f.data_through),
      date_range: range,
      comparison_range: before ? prev : null,
      filters: { business_conversion_event: conv, revenue_event: rev },
      warnings,
      configured: true,
      business_conversion_event: conv,
      business_conversions: cur.event_count,
      previous_business_conversions: before?.event_count ?? null,
      change: before ? change(cur.event_count, before.event_count, 0) : null,
      sessions: totals.sessions,
      conversion_rate_per_session: round(safeDiv(cur.event_count, totals.sessions), 4),
      previous_conversion_rate_per_session: prevTotals && before ? round(safeDiv(before.event_count, prevTotals.sessions), 4) : null,
      revenue,
      definition: `Business conversions = count of GA4 '${conv}' events (eventCount).`,
    };
  },
});
