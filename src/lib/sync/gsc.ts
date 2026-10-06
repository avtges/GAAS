import { withServiceDb, one } from "@/lib/db/pool";
import { getEnv } from "@/lib/env";
import { addDays, chunkRange, eachDay, maxIso, minIso, todayInTimeZone } from "@/lib/dates";
import { log } from "@/lib/logger";
import { getAccessTokenForConnection } from "@/lib/google/connections";
import { getSearchConsoleProvider } from "@/lib/providers/search-console";
import type { ApiDataRow } from "@/lib/providers/search-console/types";
import { upsertRows } from "@/lib/sync/upsert";
import type { SyncContext, SyncOutcome } from "@/lib/sync/types";
import { GoogleApiError } from "@/lib/providers/errors";

/**
 * Search Console sync. Dates are PST days (the API's reporting day).
 *
 * Per chunk of days:
 *  - totals, device and country breakdowns: one request each over the chunk (grouped by
 *    date), dataState=ALL so recent partial days are included and firstIncompleteDate is
 *    reported;
 *  - queries and pages: one request per day with rowLimit = GSC_ROW_CAP_PER_DAY, which
 *    gives the top-N rows for that day (the API orders by clicks desc by default).
 * Rows are upserted on their natural keys, so re-fetching a window overwrites partial
 * values with final ones.
 */
const CHUNK_DAYS = 10;

type Totals = { clicks: number; impressions: number; positionImpressions: number };

function acc(row: ApiDataRow): Totals {
  return { clicks: row.clicks, impressions: row.impressions, positionImpressions: row.position * row.impressions };
}

export async function syncSearchConsole(ctx: SyncContext): Promise<SyncOutcome> {
  const env = getEnv();
  const site = await withServiceDb((db) =>
    one<{ gsc_property: string | null; google_connection_id: string | null; backfill_cursor: string | null; data_through: string | null; backfill_done: boolean }>(
      db,
      `select w.gsc_property, w.google_connection_id, s.backfill_cursor::text, s.data_through::text, s.backfill_done
       from public.websites w join public.website_sources s on s.website_id = w.id and s.source = 'gsc'
       where w.id = $1 and w.organization_id = $2`,
      [ctx.websiteId, ctx.organizationId],
    ),
  );
  if (!site?.gsc_property) throw new GoogleApiError("invalid_request", "No Search Console property selected for this website.");
  if (!site.google_connection_id) throw new GoogleApiError("unauthenticated", "Google is not connected for this website.");

  const { accessToken } = await getAccessTokenForConnection(site.google_connection_id);
  const provider = getSearchConsoleProvider();
  const property = site.gsc_property;
  const today = todayInTimeZone("America/Los_Angeles", ctx.now());
  const yesterday = addDays(today, -1);

  let rangeStart: string;
  if (ctx.kind === "backfill") {
    rangeStart = site.backfill_cursor ?? addDays(today, -env.SYNC_BACKFILL_DAYS);
  } else {
    rangeStart = site.data_through ? addDays(site.data_through, -env.RECONCILIATION_DAYS_GSC) : addDays(today, -env.SYNC_BACKFILL_DAYS);
  }
  const rangeEnd = yesterday; // today is always incomplete; it is re-fetched tomorrow
  if (rangeStart > rangeEnd) rangeStart = rangeEnd;

  let rowsWritten = 0;
  let firstIncompleteDate: string | null = null;
  let maxDateSeen: string | null = null;
  let complete = true;

  for (const chunk of chunkRange(rangeStart, rangeEnd, CHUNK_DAYS)) {
    if (Date.now() > ctx.deadline) {
      complete = false;
      break;
    }
    const base = { startDate: chunk.start, endDate: chunk.end, type: "WEB" as const, dataState: "ALL" as const, rowLimit: 25000 };

    const totals = await provider.query({ accessToken }, property, { ...base, dimensions: ["date"] });
    if (totals.metadata?.firstIncompleteDate) {
      firstIncompleteDate = firstIncompleteDate ? minIso(firstIncompleteDate, totals.metadata.firstIncompleteDate) : totals.metadata.firstIncompleteDate;
    }
    const totalRows = (totals.rows ?? []).map((r) => {
      const t = acc(r);
      maxDateSeen = maxDateSeen ? maxIso(maxDateSeen, r.keys![0]) : r.keys![0];
      return [ctx.websiteId, ctx.organizationId, r.keys![0], "WEB", t.clicks, t.impressions, t.positionImpressions];
    });

    const devices = await provider.query({ accessToken }, property, { ...base, dimensions: ["date", "device"] });
    const deviceRows = (devices.rows ?? []).map((r) => {
      const t = acc(r);
      return [ctx.websiteId, ctx.organizationId, r.keys![0], r.keys![1], t.clicks, t.impressions, t.positionImpressions];
    });

    const countries = await paged(provider, accessToken, property, { ...base, dimensions: ["date", "country"] });
    const countryRows = countries.map((r) => {
      const t = acc(r);
      return [ctx.websiteId, ctx.organizationId, r.keys![0], r.keys![1], t.clicks, t.impressions, t.positionImpressions];
    });

    const queryRows: unknown[][] = [];
    const pageRows: unknown[][] = [];
    for (const day of eachDay(chunk.start, chunk.end)) {
      const dayReq = { startDate: day, endDate: day, type: "WEB" as const, dataState: "ALL" as const, rowLimit: env.GSC_ROW_CAP_PER_DAY };
      const q = await provider.query({ accessToken }, property, { ...dayReq, dimensions: ["query"] });
      for (const r of q.rows ?? []) {
        const t = acc(r);
        queryRows.push([ctx.websiteId, ctx.organizationId, day, r.keys![0], t.clicks, t.impressions, t.positionImpressions]);
      }
      const p = await provider.query({ accessToken }, property, { ...dayReq, dimensions: ["page"] });
      for (const r of p.rows ?? []) {
        const t = acc(r);
        pageRows.push([ctx.websiteId, ctx.organizationId, day, r.keys![0], t.clicks, t.impressions, t.positionImpressions]);
      }
    }

    rowsWritten += await withServiceDb(async (db) => {
      let n = 0;
      n += await upsertRows(db, "gsc_daily_totals", ["website_id", "organization_id", "date", "search_type", "clicks", "impressions", "position_impressions"], ["website_id", "search_type", "date"], totalRows);
      n += await upsertRows(db, "gsc_device_daily", ["website_id", "organization_id", "date", "device", "clicks", "impressions", "position_impressions"], ["website_id", "date", "device"], deviceRows);
      n += await upsertRows(db, "gsc_country_daily", ["website_id", "organization_id", "date", "country", "clicks", "impressions", "position_impressions"], ["website_id", "date", "country"], countryRows);
      n += await upsertRows(db, "gsc_query_daily", ["website_id", "organization_id", "date", "query", "clicks", "impressions", "position_impressions"], ["website_id", "date", "query"], queryRows);
      n += await upsertRows(db, "gsc_page_daily", ["website_id", "organization_id", "date", "page", "clicks", "impressions", "position_impressions"], ["website_id", "date", "page"], pageRows);
      if (ctx.kind === "backfill") {
        await db.query("update public.website_sources set backfill_cursor = $3 where website_id = $1 and source = 'gsc' and organization_id = $2", [ctx.websiteId, ctx.organizationId, addDays(chunk.end, 1)]);
      }
      return n;
    });
    log.info("gsc chunk synced", { websiteId: ctx.websiteId, organizationId: ctx.organizationId, source: "gsc", chunk, rows: rowsWritten });
  }

  // data_through: the day before the first incomplete day when the API reports one;
  // otherwise the last day we actually received. Never later than the range end.
  let dataThrough: string | null = null;
  if (firstIncompleteDate) dataThrough = addDays(firstIncompleteDate, -1);
  else if (maxDateSeen) dataThrough = maxDateSeen;
  if (dataThrough && dataThrough > rangeEnd) dataThrough = rangeEnd;
  if (dataThrough && site.data_through && ctx.kind === "incremental") dataThrough = maxIso(dataThrough, site.data_through);

  return { rowsWritten, dataThrough, rangeStart, rangeEnd, complete, limitations: { query_row_cap_per_day: env.GSC_ROW_CAP_PER_DAY, anonymized_queries_excluded: true } };
}

async function paged(
  provider: ReturnType<typeof getSearchConsoleProvider>,
  accessToken: string,
  property: string,
  req: Parameters<ReturnType<typeof getSearchConsoleProvider>["query"]>[2],
): Promise<ApiDataRow[]> {
  const out: ApiDataRow[] = [];
  let startRow = 0;
  const limit = req.rowLimit ?? 25000;
  for (let page = 0; page < 20; page++) {
    const res = await provider.query({ accessToken }, property, { ...req, startRow });
    const rows = res.rows ?? [];
    out.push(...rows);
    if (rows.length < limit) break;
    startRow += limit;
  }
  return out;
}
