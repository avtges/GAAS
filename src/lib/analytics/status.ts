import { withUserDb, many } from "@/lib/db/pool";
import type { Source } from "@/lib/websites/service";

export type SourceFreshness = {
  source: Source;
  status: string;
  configured: boolean;
  last_sync_succeeded_at: string | null;
  data_through: string | null;
  last_error: string | null;
  limitations: Record<string, unknown>;
};

export async function getSourceFreshness(userId: string, websiteId: string): Promise<SourceFreshness[]> {
  return withUserDb(userId, (db) =>
    many<SourceFreshness>(
      db,
      `select source, status, status <> 'not_configured' as configured, last_sync_succeeded_at, data_through::text as data_through, last_error, limitations
       from public.website_sources where website_id = $1 order by case source when 'gsc' then 1 when 'ga4' then 2 else 3 end`,
      [websiteId],
    ),
  );
}

export const SOURCE_LABELS: Record<Source, string> = { gsc: "Google Search Console", ga4: "Google Analytics 4", ads: "Google Ads" };

export const SOURCE_MEASUREMENT: Record<Source, string> = {
  gsc: "Google Search Console: clicks and impressions on Google Search results as reported by Google; query-level rows exclude anonymized queries; dates are Pacific time days.",
  ga4: "Google Analytics 4: sessions and users measured by the GA4 tag with GA4's session attribution (last non-direct click by default); dates are in the property's reporting time zone.",
  ads: "Google Ads: impressions, clicks and cost as billed by Google Ads; conversions use Google Ads conversion tracking and attribution windows and can change for several days; dates are in the account's time zone.",
};
