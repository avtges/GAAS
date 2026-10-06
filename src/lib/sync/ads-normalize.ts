import { z } from "zod";
import { GoogleApiError } from "@/lib/providers/errors";
import { idString, numeric, type AdsRow } from "@/lib/providers/google-ads/types";
import type { AdsReport } from "@/lib/providers/google-ads/queries";

/** Parses REST JSON rows for each fixed report into table tuples (minus website/org ids). */
const Metrics = z.object({
  impressions: numeric.optional(),
  clicks: numeric.optional(),
  costMicros: numeric.optional(),
  conversions: numeric.optional(),
  conversionsValue: numeric.optional(),
  allConversions: numeric.optional(),
});
const Date_ = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });

const SCHEMAS = {
  campaign: z.object({ campaign: z.object({ id: idString, name: z.string(), status: z.string(), advertisingChannelType: z.string().optional() }), segments: Date_, metrics: Metrics }),
  ad_group: z.object({ campaign: z.object({ id: idString, name: z.string() }), adGroup: z.object({ id: idString, name: z.string(), status: z.string() }), segments: Date_, metrics: Metrics }),
  keyword: z.object({ campaign: z.object({ id: idString }), adGroup: z.object({ id: idString }), adGroupCriterion: z.object({ criterionId: idString, keyword: z.object({ text: z.string(), matchType: z.string() }) }), segments: Date_, metrics: Metrics }),
  search_term: z.object({ campaign: z.object({ id: idString }), adGroup: z.object({ id: idString }), searchTermView: z.object({ searchTerm: z.string(), status: z.string().optional() }), segments: Date_, metrics: Metrics }),
  device: z.object({ campaign: z.object({ id: idString }), segments: Date_.extend({ device: z.string() }), metrics: Metrics }),
  conversion_action: z.object({ campaign: z.object({ id: idString }), segments: Date_.extend({ conversionActionName: z.string() }), metrics: Metrics }),
} satisfies Record<AdsReport, z.ZodTypeAny>;

const n = (v: number | undefined) => v ?? 0;

export function normalizeAdsRows(report: AdsReport, rows: AdsRow[]): unknown[][] {
  const schema = SCHEMAS[report];
  return rows.map((raw, i) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new GoogleApiError("malformed", `googleads.searchStream ${report} row ${i}: unexpected shape at ${parsed.error.issues[0]?.path.join(".")}`);
    }
    const r = parsed.data as z.infer<(typeof SCHEMAS)["campaign"]> & z.infer<(typeof SCHEMAS)["ad_group"]> & z.infer<(typeof SCHEMAS)["keyword"]> & z.infer<(typeof SCHEMAS)["search_term"]> & z.infer<(typeof SCHEMAS)["device"]> & z.infer<(typeof SCHEMAS)["conversion_action"]>;
    const mt = r.metrics;
    const base5 = [n(mt.impressions), n(mt.clicks), n(mt.costMicros), n(mt.conversions), n(mt.conversionsValue)];
    switch (report) {
      case "campaign":
        return [r.segments.date, r.campaign.id, r.campaign.name, r.campaign.status, r.campaign.advertisingChannelType ?? "UNSPECIFIED", ...base5, n(mt.allConversions)];
      case "ad_group":
        return [r.segments.date, r.campaign.id, r.campaign.name, r.adGroup.id, r.adGroup.name, r.adGroup.status, ...base5];
      case "keyword":
        return [r.segments.date, r.campaign.id, r.adGroup.id, r.adGroupCriterion.criterionId, r.adGroupCriterion.keyword.text, r.adGroupCriterion.keyword.matchType, ...base5];
      case "search_term":
        return [r.segments.date, r.campaign.id, r.adGroup.id, r.searchTermView.searchTerm, r.searchTermView.status ?? "UNKNOWN", ...base5];
      case "device":
        return [r.segments.date, r.campaign.id, r.segments.device, ...base5];
      case "conversion_action":
        return [r.segments.date, r.campaign.id, r.segments.conversionActionName, n(mt.conversions), n(mt.conversionsValue), n(mt.allConversions)];
    }
  });
}

/** Column lists / natural keys per table, aligned with normalizeAdsRows output. */
export const ADS_TABLES: Record<AdsReport, { table: string; columns: string[]; key: string[] }> = {
  campaign: { table: "ads_campaign_daily", columns: ["date", "campaign_id", "campaign_name", "campaign_status", "channel_type", "impressions", "clicks", "cost_micros", "conversions", "conversions_value", "all_conversions"], key: ["website_id", "date", "campaign_id"] },
  ad_group: { table: "ads_ad_group_daily", columns: ["date", "campaign_id", "campaign_name", "ad_group_id", "ad_group_name", "ad_group_status", "impressions", "clicks", "cost_micros", "conversions", "conversions_value"], key: ["website_id", "date", "ad_group_id"] },
  keyword: { table: "ads_keyword_daily", columns: ["date", "campaign_id", "ad_group_id", "criterion_id", "keyword_text", "match_type", "impressions", "clicks", "cost_micros", "conversions", "conversions_value"], key: ["website_id", "date", "ad_group_id", "criterion_id"] },
  search_term: { table: "ads_search_term_daily", columns: ["date", "campaign_id", "ad_group_id", "search_term", "targeting_status", "impressions", "clicks", "cost_micros", "conversions", "conversions_value"], key: ["website_id", "date", "ad_group_id", "search_term"] },
  device: { table: "ads_device_daily", columns: ["date", "campaign_id", "device", "impressions", "clicks", "cost_micros", "conversions", "conversions_value"], key: ["website_id", "date", "campaign_id", "device"] },
  conversion_action: { table: "ads_conversion_action_daily", columns: ["date", "campaign_id", "conversion_action_name", "conversions", "conversions_value", "all_conversions"], key: ["website_id", "date", "campaign_id", "conversion_action_name"] },
};

/** Sums duplicate natural keys (e.g. a search term matched by two keywords in one ad group). */
export function mergeByKey(report: AdsReport, tuples: unknown[][]): unknown[][] {
  const spec = ADS_TABLES[report];
  const keyIdx = spec.key.filter((k) => k !== "website_id").map((k) => spec.columns.indexOf(k));
  const numericStart = spec.columns.findIndex((c) => ["impressions", "conversions"].includes(c));
  const map = new Map<string, unknown[]>();
  for (const t of tuples) {
    const k = keyIdx.map((i) => String(t[i])).join("\u0001");
    const existing = map.get(k);
    if (!existing) map.set(k, [...t]);
    else for (let i = numericStart; i < t.length; i++) existing[i] = Number(existing[i]) + Number(t[i]);
  }
  return [...map.values()];
}
