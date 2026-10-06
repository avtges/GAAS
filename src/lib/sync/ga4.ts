import { withServiceDb, one } from "@/lib/db/pool";
import { getEnv } from "@/lib/env";
import { addDays, chunkRange, maxIso, minIso, todayInTimeZone, isValidTimeZone } from "@/lib/dates";
import { log } from "@/lib/logger";
import { getAccessTokenForConnection } from "@/lib/google/connections";
import { getGa4Provider } from "@/lib/providers/ga4";
import { GA4_DIMENSIONS as D, GA4_METRICS as M, GA4_SESSION_METRICS, validateGa4Schema } from "@/lib/providers/ga4/schema";
import type { RunReportResponse } from "@/lib/providers/ga4/types";
import { GoogleApiError } from "@/lib/providers/errors";
import { upsertRows } from "@/lib/sync/upsert";
import type { SyncContext, SyncOutcome } from "@/lib/sync/types";

const CHUNK_DAYS = 31;
const PAGE_LIMIT = 100_000;

function isoFromGa4Date(v: string): string {
  // GA4 returns YYYYMMDD for the `date` dimension.
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}

type Flags = { sampled: boolean; thresholded: boolean; data_loss_from_other_row: boolean };

async function runPaged(
  provider: ReturnType<typeof getGa4Provider>,
  accessToken: string,
  propertyId: string,
  dims: string[],
  mets: string[],
  range: { start: string; end: string },
  flags: Flags,
): Promise<Array<{ d: string[]; m: number[] }>> {
  const out: Array<{ d: string[]; m: number[] }> = [];
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const res: RunReportResponse = await provider.runReport({ accessToken }, propertyId, {
      dateRanges: [{ startDate: range.start, endDate: range.end }],
      dimensions: dims.map((name) => ({ name })),
      metrics: mets.map((name) => ({ name })),
      limit: PAGE_LIMIT,
      offset,
      keepEmptyRows: false,
    });
    if (res.metadata?.samplingMetadatas?.length) flags.sampled = true;
    if (res.metadata?.subjectToThresholding) flags.thresholded = true;
    if (res.metadata?.dataLossFromOtherRow) flags.data_loss_from_other_row = true;
    const rows = res.rows ?? [];
    for (const r of rows) {
      const d = (r.dimensionValues ?? []).map((v) => v.value ?? "(not set)");
      const m = (r.metricValues ?? []).map((v) => Number(v.value ?? 0));
      if (d.length !== dims.length || m.length !== mets.length) throw new GoogleApiError("malformed", "analyticsdata.runReport: row shape does not match the request");
      out.push({ d, m });
    }
    offset += rows.length;
    if (rows.length < PAGE_LIMIT || (res.rowCount !== undefined && offset >= res.rowCount)) break;
  }
  return out;
}

export async function syncGa4(ctx: SyncContext): Promise<SyncOutcome> {
  const env = getEnv();
  const site = await withServiceDb((db) =>
    one<{ ga4_property_id: string | null; google_connection_id: string | null; timezone: string; backfill_cursor: string | null; data_through: string | null; limitations: Record<string, unknown> }>(
      db,
      `select w.ga4_property_id, w.google_connection_id, w.timezone, s.backfill_cursor::text, s.data_through::text, s.limitations
       from public.websites w join public.website_sources s on s.website_id = w.id and s.source = 'ga4'
       where w.id = $1 and w.organization_id = $2`,
      [ctx.websiteId, ctx.organizationId],
    ),
  );
  if (!site?.ga4_property_id) throw new GoogleApiError("invalid_request", "No GA4 property selected for this website.");
  if (!site.google_connection_id) throw new GoogleApiError("unauthenticated", "Google is not connected for this website.");
  const propertyId = site.ga4_property_id;
  const { accessToken } = await getAccessTokenForConnection(site.google_connection_id);
  const provider = getGa4Provider();

  // Runtime guard against guessed dimension/metric names (docs/integration-verification.md U1).
  if (!site.limitations?.schema_validated_at) {
    const meta = await provider.getMetadata({ accessToken }, propertyId);
    const v = validateGa4Schema(meta);
    if (!v.ok) {
      throw new GoogleApiError(
        "invalid_request",
        `GA4 schema check failed: this property's metadata does not list ${[...v.missingDimensions.map((d) => `dimension ${d}`), ...v.missingMetrics.map((m) => `metric ${m}`)].join(", ")}. Update src/lib/providers/ga4/schema.ts.`,
      );
    }
  }

  // GA4 reports in the property's time zone; use it for "today" when it is known.
  const property = await provider.getProperty({ accessToken }, propertyId).catch(() => null);
  const tz = property?.timeZone && isValidTimeZone(property.timeZone) ? property.timeZone : isValidTimeZone(site.timezone) ? site.timezone : "UTC";
  const today = todayInTimeZone(tz, ctx.now());
  const yesterday = addDays(today, -1);
  let rangeStart = ctx.kind === "backfill" ? (site.backfill_cursor ?? addDays(today, -env.SYNC_BACKFILL_DAYS)) : site.data_through ? addDays(site.data_through, -env.RECONCILIATION_DAYS_GA4) : addDays(today, -env.SYNC_BACKFILL_DAYS);
  const rangeEnd = yesterday;
  if (rangeStart > rangeEnd) rangeStart = rangeEnd;

  const flags: Flags = { sampled: false, thresholded: false, data_loss_from_other_row: false };
  let rowsWritten = 0;
  let maxDateSeen: string | null = null;
  let complete = true;
  const sessionMetrics = [...GA4_SESSION_METRICS];
  const W = ctx.websiteId;
  const O = ctx.organizationId;

  for (const chunk of chunkRange(rangeStart, rangeEnd, CHUNK_DAYS)) {
    if (Date.now() > ctx.deadline) {
      complete = false;
      break;
    }
    const totals = await runPaged(provider, accessToken, propertyId, [D.date], [...sessionMetrics, M.screenPageViews], chunk, flags);
    const totalRows = totals.map(({ d, m }) => {
      const date = isoFromGa4Date(d[0]);
      maxDateSeen = maxDateSeen ? maxIso(maxDateSeen, date) : date;
      return [W, O, date, m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7]];
    });
    const acq = await runPaged(provider, accessToken, propertyId, [D.date, D.sessionSource, D.sessionMedium, D.sessionCampaignName, D.sessionDefaultChannelGroup], sessionMetrics, chunk, flags);
    const acqRows = acq.map(({ d, m }) => [W, O, isoFromGa4Date(d[0]), d[1], d[2], d[3], d[4], m[0], m[1], m[2], m[3], m[4], m[5], m[6]]);
    const lp = await runPaged(provider, accessToken, propertyId, [D.date, D.landingPage], sessionMetrics, chunk, flags);
    const lpRows = lp.map(({ d, m }) => [W, O, isoFromGa4Date(d[0]), d[1], m[0], m[1], m[2], m[3], m[4], m[5], m[6]]);
    const dev = await runPaged(provider, accessToken, propertyId, [D.date, D.deviceCategory], sessionMetrics, chunk, flags);
    const devRows = dev.map(({ d, m }) => [W, O, isoFromGa4Date(d[0]), d[1], m[0], m[1], m[2], m[3], m[4], m[5], m[6]]);
    const ev = await runPaged(provider, accessToken, propertyId, [D.date, D.eventName], [M.eventCount, M.keyEvents], chunk, flags);
    const evRows = ev.map(({ d, m }) => [W, O, isoFromGa4Date(d[0]), d[1], m[0], m[1]]);

    rowsWritten += await withServiceDb(async (db) => {
      let n = 0;
      const sm = ["sessions", "total_users", "new_users", "engaged_sessions", "key_events", "purchases", "purchase_revenue"];
      n += await upsertRows(db, "ga4_daily_totals", ["website_id", "organization_id", "date", ...sm, "screen_page_views"], ["website_id", "date"], totalRows);
      n += await upsertRows(db, "ga4_acquisition_daily", ["website_id", "organization_id", "date", "session_source", "session_medium", "session_campaign", "session_default_channel_group", ...sm], ["website_id", "date", "session_source", "session_medium", "session_campaign", "session_default_channel_group"], acqRows);
      n += await upsertRows(db, "ga4_landing_page_daily", ["website_id", "organization_id", "date", "landing_page", ...sm], ["website_id", "date", "landing_page"], lpRows);
      n += await upsertRows(db, "ga4_device_daily", ["website_id", "organization_id", "date", "device_category", ...sm], ["website_id", "date", "device_category"], devRows);
      n += await upsertRows(db, "ga4_event_daily", ["website_id", "organization_id", "date", "event_name", "event_count", "key_events"], ["website_id", "date", "event_name"], evRows);
      if (ctx.kind === "backfill") {
        await db.query("update public.website_sources set backfill_cursor = $3 where website_id = $1 and source = 'ga4' and organization_id = $2", [W, O, addDays(chunk.end, 1)]);
      }
      return n;
    });
    log.info("ga4 chunk synced", { websiteId: W, organizationId: O, source: "ga4", chunk, rows: rowsWritten });
  }

  // GA4 does not flag incomplete days; recent days are re-fetched via the reconciliation window.
  let dataThrough = maxDateSeen ? minIso(maxDateSeen, rangeEnd) : null;
  if (dataThrough && site.data_through && ctx.kind === "incremental") dataThrough = maxIso(dataThrough, site.data_through);

  return {
    rowsWritten,
    dataThrough,
    rangeStart,
    rangeEnd,
    complete,
    limitations: { ...site.limitations, ...flags, schema_validated_at: site.limitations?.schema_validated_at ?? ctx.now().toISOString(), reporting_time_zone: tz },
  };
}
