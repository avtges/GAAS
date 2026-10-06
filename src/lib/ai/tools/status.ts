import { z } from "zod";
import { defineTool } from "@/lib/ai/tools/registry";
import { SOURCE_LABELS } from "@/lib/analytics/status";

export const getSyncStatusTool = defineTool({
  name: "get_sync_status",
  description: "Which data sources are connected for this website, when they last synced, the last date with complete data for each, and the website's semantic configuration (business conversion event, brand queries, time zone, currency). Call this when unsure what data exists or how fresh it is.",
  sources: [],
  schema: z.object({}),
  async execute(ctx) {
    return {
      source: "system",
      source_label: "Sync status",
      warnings: [],
      today: ctx.today,
      timezone: ctx.website.timezone,
      currency: ctx.website.currency,
      sources: ctx.freshness.map((f) => ({
        source: f.source,
        label: SOURCE_LABELS[f.source],
        configured: f.configured,
        status: f.status,
        last_sync_succeeded_at: f.last_sync_succeeded_at,
        data_through: f.data_through,
        last_error: f.last_error,
        limitations: f.limitations,
      })),
      semantic_configuration: {
        business_conversion_event: ctx.website.business_conversion_event,
        revenue_event: ctx.website.revenue_event,
        primary_google_ads_conversion: ctx.website.primary_google_ads_conversion,
        brand_queries: ctx.website.brand_queries,
      },
    };
  },
});
