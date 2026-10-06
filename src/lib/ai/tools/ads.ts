import { z } from "zod";
import { defineTool, clampRangeToDataThrough, freshnessFor } from "@/lib/ai/tools/registry";
import { DateRangeInput, parseRange } from "@/lib/analytics/common";
import { getAdsAdGroups, getAdsCampaigns, getAdsKeywords, getAdsSearchTerms } from "@/lib/analytics/ads";
import { SOURCE_LABELS, SOURCE_MEASUREMENT } from "@/lib/analytics/status";

const SortEnum = z.enum(["cost", "conversions", "cpa", "roas", "clicks", "cost_change"]);
const base = (dt: string | null, currency: string) => ({ source: "ads" as const, source_label: SOURCE_LABELS.ads, measurement: SOURCE_MEASUREMENT.ads, data_through: { ads: dt }, currency });
const ATTRIBUTION = "Google Ads conversions use Google Ads conversion tracking and attribution; they will not match GA4 key events or business conversions.";

export const getAdsCampaignPerformanceTool = defineTool({
  name: "get_ads_campaign_performance",
  description:
    "Google Ads campaign performance (read-only): cost, impressions, clicks, CTR, average CPC, conversions, conversion value, conversion rate, CPA and ROAS, all calculated server-side, optionally vs the previous period. If a primary Google Ads conversion action is configured, also reports it per campaign. Use for 'highest CPA', 'ROAS', 'ad spend', campaign comparisons.",
  sources: ["ads"],
  schema: z.object({ ...DateRangeInput.shape, compare_with_previous_period: z.boolean(), sort_by: SortEnum.describe("cpa sorts highest CPA first; campaigns with spend but zero conversions rank first"), limit: z.number().int().min(1).max(30) }),
  async execute(ctx, args) {
    const warnings: string[] = [ATTRIBUTION];
    const f = freshnessFor(ctx, "ads");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    if (f.note) warnings.push(f.note);
    const r = await getAdsCampaigns(ctx.userId, ctx.website.id, range, { sortBy: args.sort_by, limit: args.limit, compare: args.compare_with_previous_period, primaryConversion: ctx.website.primary_google_ads_conversion });
    if (r.rows.length === 0) warnings.push("No campaigns had impressions or cost in this date range.");
    if (!ctx.website.primary_google_ads_conversion) warnings.push("primary_google_ads_conversion is not configured; 'conversions' includes every conversion action counted in the Google Ads Conversions column.");
    for (const row of r.rows) if (row.sample_warning) warnings.push(`${row.campaign_name}: ${row.sample_warning}`);
    return { ...base(f.data_through, ctx.website.currency), date_range: r.date_range, comparison_range: r.comparison_range, filters: { sort_by: args.sort_by }, warnings, totals: r.totals, previous_totals: r.previous_totals, changes: r.changes, rows: r.rows, total_campaigns: r.total_campaigns };
  },
});

export const getAdsAdGroupPerformanceTool = defineTool({
  name: "get_ads_ad_group_performance",
  description: "Google Ads ad group performance with cost, clicks, conversions, CPA and ROAS calculated server-side, optionally filtered to one campaign id.",
  sources: ["ads"],
  schema: z.object({ ...DateRangeInput.shape, sort_by: SortEnum, campaign_id: z.string().nullable().describe("Numeric campaign id from get_ads_campaign_performance, or null"), limit: z.number().int().min(1).max(30) }),
  async execute(ctx, args) {
    const warnings: string[] = [ATTRIBUTION];
    const f = freshnessFor(ctx, "ads");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    if (f.note) warnings.push(f.note);
    const r = await getAdsAdGroups(ctx.userId, ctx.website.id, range, { sortBy: args.sort_by, limit: args.limit, campaignId: args.campaign_id && /^\d+$/.test(args.campaign_id) ? args.campaign_id : null });
    return { ...base(f.data_through, ctx.website.currency), date_range: r.date_range, comparison_range: r.comparison_range, filters: { sort_by: args.sort_by, campaign_id: args.campaign_id }, warnings, rows: r.rows };
  },
});

export const getAdsKeywordPerformanceTool = defineTool({
  name: "get_ads_keyword_performance",
  description: "Google Ads keyword (targeting criterion) performance with match type, cost, clicks, conversions, CPA and ROAS.",
  sources: ["ads"],
  schema: z.object({ ...DateRangeInput.shape, sort_by: SortEnum, limit: z.number().int().min(1).max(30) }),
  async execute(ctx, args) {
    const warnings: string[] = [ATTRIBUTION];
    const f = freshnessFor(ctx, "ads");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    if (f.note) warnings.push(f.note);
    const r = await getAdsKeywords(ctx.userId, ctx.website.id, range, { sortBy: args.sort_by, limit: args.limit });
    return { ...base(f.data_through, ctx.website.currency), date_range: r.date_range, comparison_range: r.comparison_range, filters: { sort_by: args.sort_by }, warnings, rows: r.rows };
  },
});

export const getAdsSearchTermsTool = defineTool({
  name: "get_ads_search_terms",
  description: "Google Ads search terms (the actual searches that triggered ads) with cost, clicks and conversions. sort_by=wasted_spend lists terms with cost but zero conversions, plus a summary of how much spend had no conversions. Use for 'where are we wasting ad spend'.",
  sources: ["ads"],
  schema: z.object({ ...DateRangeInput.shape, sort_by: z.enum(["cost", "conversions", "wasted_spend", "clicks"]), min_cost: z.number().min(0).describe("Ignore terms with less cost than this in the account currency"), limit: z.number().int().min(1).max(40) }),
  async execute(ctx, args) {
    const warnings: string[] = [ATTRIBUTION];
    const f = freshnessFor(ctx, "ads");
    const range = clampRangeToDataThrough(parseRange(args), f.data_through, warnings);
    if (f.note) warnings.push(f.note);
    const r = await getAdsSearchTerms(ctx.userId, ctx.website.id, range, { sortBy: args.sort_by, limit: args.limit, minCost: args.min_cost });
    if (r.rows.length === 0) warnings.push("No search terms matched. Performance Max and some other campaign types do not report search terms here.");
    return { ...base(f.data_through, ctx.website.currency), date_range: r.date_range, comparison_range: r.comparison_range, filters: { sort_by: args.sort_by, min_cost: args.min_cost }, warnings, rows: r.rows, summary: r.summary, definition: r.definition };
  },
});
