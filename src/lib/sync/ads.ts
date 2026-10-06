import { withServiceDb, one } from "@/lib/db/pool";
import { getEnv } from "@/lib/env";
import { addDays, chunkRange, isValidTimeZone, maxIso, minIso, todayInTimeZone } from "@/lib/dates";
import { log } from "@/lib/logger";
import { getAccessTokenForConnection } from "@/lib/google/connections";
import { getGoogleAdsProvider } from "@/lib/providers/google-ads";
import { ADS_REPORTS } from "@/lib/providers/google-ads/queries";
import { GoogleApiError } from "@/lib/providers/errors";
import { upsertRows } from "@/lib/sync/upsert";
import { ADS_TABLES, mergeByKey, normalizeAdsRows } from "@/lib/sync/ads-normalize";
import type { SyncContext, SyncOutcome } from "@/lib/sync/types";

const CHUNK_DAYS = 15;
const SEARCH_TERM_CAP_PER_DAY = 2000;

export async function syncGoogleAds(ctx: SyncContext): Promise<SyncOutcome> {
  const env = getEnv();
  const site = await withServiceDb((db) =>
    one<{ google_ads_customer_id: string | null; google_ads_login_customer_id: string | null; google_connection_id: string | null; timezone: string; backfill_cursor: string | null; data_through: string | null; limitations: Record<string, unknown> }>(
      db,
      `select w.google_ads_customer_id, w.google_ads_login_customer_id, w.google_connection_id, w.timezone, s.backfill_cursor::text, s.data_through::text, s.limitations
       from public.websites w join public.website_sources s on s.website_id = w.id and s.source = 'ads'
       where w.id = $1 and w.organization_id = $2`,
      [ctx.websiteId, ctx.organizationId],
    ),
  );
  if (!site?.google_ads_customer_id) throw new GoogleApiError("invalid_request", "No Google Ads account selected for this website.");
  if (!site.google_connection_id) throw new GoogleApiError("unauthenticated", "Google is not connected for this website.");
  const { accessToken } = await getAccessTokenForConnection(site.google_connection_id);
  const provider = getGoogleAdsProvider();
  const customerId = site.google_ads_customer_id;
  const login = site.google_ads_login_customer_id;

  const accountTz = typeof site.limitations?.account_time_zone === "string" ? (site.limitations.account_time_zone as string) : null;
  const tz = accountTz && isValidTimeZone(accountTz) ? accountTz : isValidTimeZone(site.timezone) ? site.timezone : "UTC";
  const today = todayInTimeZone(tz, ctx.now());
  const rangeEnd = addDays(today, -1);
  let rangeStart = ctx.kind === "backfill" ? (site.backfill_cursor ?? addDays(today, -env.SYNC_BACKFILL_DAYS)) : site.data_through ? addDays(site.data_through, -env.RECONCILIATION_DAYS_ADS) : addDays(today, -env.SYNC_BACKFILL_DAYS);
  if (rangeStart > rangeEnd) rangeStart = rangeEnd;

  let rowsWritten = 0;
  let maxDateSeen: string | null = null;
  let complete = true;
  let searchTermsTruncated = false;

  for (const chunk of chunkRange(rangeStart, rangeEnd, CHUNK_DAYS)) {
    if (Date.now() > ctx.deadline) {
      complete = false;
      break;
    }
    const perReport: Record<string, unknown[][]> = {};
    for (const report of ADS_REPORTS) {
      const raw = await provider.fetchReport({ accessToken }, { customerId, loginCustomerId: login, report, start: chunk.start, end: chunk.end });
      let tuples = mergeByKey(report, normalizeAdsRows(report, raw));
      if (report === "search_term") {
        const byDay = new Map<string, unknown[][]>();
        for (const t of tuples) byDay.set(String(t[0]), [...(byDay.get(String(t[0])) ?? []), t]);
        tuples = [];
        for (const rows of byDay.values()) {
          // keep the highest-cost terms per day (cost_micros is column 7)
          rows.sort((a, b) => Number(b[7]) - Number(a[7]) || Number(b[5]) - Number(a[5]));
          if (rows.length > SEARCH_TERM_CAP_PER_DAY) searchTermsTruncated = true;
          tuples.push(...rows.slice(0, SEARCH_TERM_CAP_PER_DAY));
        }
      }
      if (report === "campaign") for (const t of tuples) maxDateSeen = maxDateSeen ? maxIso(maxDateSeen, String(t[0])) : String(t[0]);
      perReport[report] = tuples;
    }
    rowsWritten += await withServiceDb(async (db) => {
      let n = 0;
      for (const report of ADS_REPORTS) {
        const spec = ADS_TABLES[report];
        n += await upsertRows(db, spec.table, ["website_id", "organization_id", ...spec.columns], spec.key, perReport[report].map((t) => [ctx.websiteId, ctx.organizationId, ...t]));
      }
      if (ctx.kind === "backfill") {
        await db.query("update public.website_sources set backfill_cursor = $3 where website_id = $1 and source = 'ads' and organization_id = $2", [ctx.websiteId, ctx.organizationId, addDays(chunk.end, 1)]);
      }
      return n;
    });
    log.info("ads chunk synced", { websiteId: ctx.websiteId, organizationId: ctx.organizationId, source: "ads", chunk, rows: rowsWritten });
  }

  // An account with no spend returns no rows; then the range end is still the last complete day.
  let dataThrough: string | null = maxDateSeen ? minIso(maxDateSeen, rangeEnd) : rangeEnd;
  if (site.data_through && ctx.kind === "incremental") dataThrough = maxIso(dataThrough, site.data_through);
  return {
    rowsWritten,
    dataThrough,
    rangeStart,
    rangeEnd,
    complete,
    limitations: { ...site.limitations, reporting_time_zone: tz, search_terms_capped_per_day: searchTermsTruncated ? SEARCH_TERM_CAP_PER_DAY : null, conversions_change_with_attribution_window: true },
  };
}
