import { isIsoDate } from "@/lib/dates";

/**
 * The ONLY GAQL the application ever sends. Fixed strings; the sole interpolations are two
 * validated YYYY-MM-DD dates. Field names verified against the official google-ads 33.0.0
 * library protos for API v25 (docs/integration-verification.md §5). No mutate calls exist.
 */
export const ADS_REPORTS = ["campaign", "ad_group", "keyword", "search_term", "device", "conversion_action"] as const;
export type AdsReport = (typeof ADS_REPORTS)[number];

const METRICS = "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value";

const TEMPLATES: Record<AdsReport, string> = {
  campaign: `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, segments.date, ${METRICS}, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '{start}' AND '{end}'`,
  ad_group: `SELECT campaign.id, campaign.name, ad_group.id, ad_group.name, ad_group.status, segments.date, ${METRICS} FROM ad_group WHERE segments.date BETWEEN '{start}' AND '{end}'`,
  keyword: `SELECT campaign.id, ad_group.id, ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, segments.date, ${METRICS} FROM keyword_view WHERE segments.date BETWEEN '{start}' AND '{end}'`,
  search_term: `SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status, segments.date, ${METRICS} FROM search_term_view WHERE segments.date BETWEEN '{start}' AND '{end}'`,
  device: `SELECT campaign.id, segments.date, segments.device, ${METRICS} FROM campaign WHERE segments.date BETWEEN '{start}' AND '{end}'`,
  conversion_action: `SELECT campaign.id, segments.date, segments.conversion_action_name, metrics.conversions, metrics.conversions_value, metrics.all_conversions FROM campaign WHERE segments.date BETWEEN '{start}' AND '{end}'`,
};

export const CUSTOMER_QUERY = "SELECT customer.id, customer.descriptive_name, customer.manager, customer.test_account, customer.currency_code, customer.time_zone, customer.status FROM customer";
export const CUSTOMER_CLIENT_QUERY =
  "SELECT customer_client.client_customer, customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level, customer_client.status, customer_client.currency_code, customer_client.time_zone, customer_client.test_account FROM customer_client WHERE customer_client.level <= 1";

export function buildReportQuery(report: AdsReport, start: string, end: string): string {
  if (!isIsoDate(start) || !isIsoDate(end) || start > end) throw new Error("buildReportQuery: invalid date range");
  return TEMPLATES[report].replace("{start}", start).replace("{end}", end);
}
