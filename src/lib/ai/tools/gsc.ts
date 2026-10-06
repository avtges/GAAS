import { z } from "zod";
import { defineTool, clampRangeToDataThrough, freshnessFor } from "@/lib/ai/tools/registry";
import { DateRangeInput, parseRange } from "@/lib/analytics/common";
import { getSearchPages, getSearchPerformance, getSearchQueries, QuerySort } from "@/lib/analytics/gsc";
import { SOURCE_LABELS, SOURCE_MEASUREMENT } from "@/lib/analytics/status";

const RangeArgs = DateRangeInput.shape;

export const getSearchPerformanceTool = defineTool({
  name: "get_search_performance",
  description:
    "Google Search Console totals (clicks, impressions, CTR, average position) for a date range, optionally compared with the previous period of equal length and broken down by date, device or country. Use for organic search traffic trends.",
  sources: ["gsc"],
  schema: z.object({
    ...RangeArgs,
    compare_with_previous_period: z.boolean().describe("Also return the immediately preceding period of equal length and the changes"),
    breakdown: z.enum(["none", "date", "device", "country"]).describe("Optional breakdown of the current period"),
  }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "gsc");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const r = await getSearchPerformance(ctx.userId, ctx.website.id, range, { compare: args.compare_with_previous_period, breakdown: args.breakdown, brandQueries: ctx.website.brand_queries });
    if (f.note) warnings.push(f.note);
    return {
      source: "gsc",
      source_label: SOURCE_LABELS.gsc,
      measurement: SOURCE_MEASUREMENT.gsc,
      date_range: r.date_range,
      comparison_range: r.comparison_range,
      data_through: { gsc: f.data_through },
      filters: { breakdown: args.breakdown },
      warnings: [...warnings, ...r.warnings],
      totals: r.totals,
      previous_totals: r.previous_totals,
      changes: r.changes,
      breakdown: r.breakdown,
      brand_split: r.brand_split,
      brand_queries_configured: ctx.website.brand_queries,
    };
  },
});

export const getSearchQueriesTool = defineTool({
  name: "get_search_queries",
  description:
    "Top Google Search Console queries for a date range with clicks, impressions, CTR, average position, change vs the previous period and an opportunity score (high impressions, weak CTR for the position). Use for questions about keywords, queries, SEO opportunities, brand vs non-brand.",
  sources: ["gsc"],
  schema: z.object({
    ...RangeArgs,
    limit: z.number().int().min(1).max(50).describe("Max rows to return (1-50)"),
    sort_by: QuerySort.describe("Ranking: clicks, impressions, ctr, position (best first), clicks_change (biggest losers first), impressions_change (biggest gainers first), opportunity"),
    min_impressions: z.number().int().min(0).describe("Ignore rows with fewer impressions in the current period (e.g. 100)"),
    brand_filter: z.enum(["all", "brand", "non_brand"]).describe("Requires brand_queries to be configured for the website"),
    contains: z.string().nullable().describe("Only queries containing this text, or null"),
  }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "gsc");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    if (args.brand_filter !== "all" && ctx.website.brand_queries.length === 0) {
      warnings.push("brand_queries is not configured for this website, so brand/non-brand filtering was not applied.");
    }
    const r = await getSearchQueries(ctx.userId, ctx.website.id, range, {
      limit: args.limit,
      sort: args.sort_by,
      minImpressions: args.min_impressions,
      brand: args.brand_filter,
      brandQueries: ctx.website.brand_queries,
      contains: args.contains,
    });
    if (f.note) warnings.push(f.note);
    if (r.rows.length === 0) warnings.push("No queries matched in this date range.");
    return {
      source: "gsc",
      source_label: SOURCE_LABELS.gsc,
      measurement: SOURCE_MEASUREMENT.gsc,
      date_range: r.date_range,
      comparison_range: r.comparison_range,
      data_through: { gsc: f.data_through },
      filters: { sort_by: args.sort_by, min_impressions: args.min_impressions, brand_filter: args.brand_filter, contains: args.contains },
      warnings,
      rows: r.rows,
      total_rows_considered: r.total_rows_considered,
      notes: r.notes,
    };
  },
});

export const getSearchPagesTool = defineTool({
  name: "get_search_pages",
  description: "Top landing pages in Google Search Console (organic search) for a date range with clicks, impressions, CTR, position and change vs the previous period. Use for 'which pages are gaining/losing organic traffic'.",
  sources: ["gsc"],
  schema: z.object({
    ...RangeArgs,
    limit: z.number().int().min(1).max(50),
    sort_by: QuerySort,
    min_impressions: z.number().int().min(0),
    contains: z.string().nullable().describe("Only pages whose URL contains this text, or null"),
  }),
  async execute(ctx, args) {
    const warnings: string[] = [];
    const f = freshnessFor(ctx, "gsc");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    const r = await getSearchPages(ctx.userId, ctx.website.id, range, { limit: args.limit, sort: args.sort_by, minImpressions: args.min_impressions, brand: "all", brandQueries: [], contains: args.contains });
    if (f.note) warnings.push(f.note);
    if (r.rows.length === 0) warnings.push("No pages matched in this date range.");
    return {
      source: "gsc",
      source_label: SOURCE_LABELS.gsc,
      measurement: SOURCE_MEASUREMENT.gsc,
      date_range: r.date_range,
      comparison_range: r.comparison_range,
      data_through: { gsc: f.data_through },
      filters: { sort_by: args.sort_by, min_impressions: args.min_impressions, contains: args.contains },
      warnings,
      rows: r.rows,
      total_rows_considered: r.total_rows_considered,
      notes: r.notes,
    };
  },
});
