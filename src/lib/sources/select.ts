import { after } from "next/server";
import { z } from "zod";
import { withServiceDb, withUserDb, many } from "@/lib/db/pool";
import { badRequest, forbidden } from "@/lib/errors";
import { getAccessTokenForConnection, getWebsiteConnection, connectionProducts } from "@/lib/google/connections";
import { getSearchConsoleProvider, type SiteEntry } from "@/lib/providers/search-console";
import { requireWebsiteAccess, requireWebsiteAdmin, type Source } from "@/lib/websites/service";
import { runSync } from "@/lib/sync/runner";
import { log } from "@/lib/logger";

const SOURCE_TABLES: Record<Source, string[]> = {
  gsc: ["gsc_daily_totals", "gsc_query_daily", "gsc_page_daily", "gsc_device_daily", "gsc_country_daily"],
  ga4: ["ga4_daily_totals", "ga4_acquisition_daily", "ga4_landing_page_daily", "ga4_device_daily", "ga4_event_daily"],
  ads: ["ads_campaign_daily", "ads_ad_group_daily", "ads_keyword_daily", "ads_search_term_daily", "ads_device_daily", "ads_conversion_action_daily"],
};

async function connectionForProduct(userId: string, websiteId: string, product: Source): Promise<string> {
  await requireWebsiteAdmin(userId, websiteId);
  const conn = await getWebsiteConnection(userId, websiteId);
  if (!conn || conn.status !== "active") throw badRequest("Connect Google first.");
  if (!connectionProducts(conn)[product]) throw badRequest("Access for this product has not been granted. Use “Grant access” on the Connections page.");
  return conn.id;
}

export async function listAvailableGscProperties(userId: string, websiteId: string): Promise<SiteEntry[]> {
  const connectionId = await connectionForProduct(userId, websiteId, "gsc");
  const { accessToken } = await getAccessTokenForConnection(connectionId);
  const sites = await getSearchConsoleProvider().listSites({ accessToken });
  return sites.filter((s) => s.permissionLevel !== "SITE_UNVERIFIED_USER").sort((a, b) => a.siteUrl.localeCompare(b.siteUrl));
}

/** Clears imported rows for a source and resets its sync state (used when the selection changes). */
export async function resetSourceData(organizationId: string, websiteId: string, source: Source, nextStatus: "ok" | "not_configured"): Promise<void> {
  await withServiceDb(async (db) => {
    for (const t of SOURCE_TABLES[source]) {
      await db.query(`delete from public.${t} where website_id = $1 and organization_id = $2`, [websiteId, organizationId]);
    }
    await db.query(
      `update public.website_sources set status = $3, backfill_done = false, backfill_cursor = null, data_through = null,
         last_error = null, last_sync_succeeded_at = null, limitations = '{}'::jsonb,
         next_sync_at = case when $3 = 'ok' then now() else null end
       where website_id = $1 and organization_id = $2 and source = $4`,
      [websiteId, organizationId, nextStatus, source],
    );
  });
}

export async function selectGscProperty(userId: string, websiteId: string, input: unknown): Promise<void> {
  const parsed = z.object({ siteUrl: z.string().min(1).max(500) }).safeParse(input);
  if (!parsed.success) throw badRequest("Choose a property.");
  const website = await requireWebsiteAdmin(userId, websiteId);
  // Only accept a property the connected account can actually see.
  const available = await listAvailableGscProperties(userId, websiteId);
  if (!available.some((s) => s.siteUrl === parsed.data.siteUrl)) throw forbidden("That property is not available to the connected Google account.");
  await withServiceDb((db) => db.query("update public.websites set gsc_property = $3 where id = $1 and organization_id = $2", [websiteId, website.organization_id, parsed.data.siteUrl]));
  await resetSourceData(website.organization_id, websiteId, "gsc", "ok");
  log.info("gsc property selected", { organizationId: website.organization_id, websiteId, property: parsed.data.siteUrl });
  scheduleImmediateSync(websiteId, "gsc");
}

/** Kick off a sync after the response is sent (bounded by the function's time budget). */
export function scheduleImmediateSync(websiteId: string, source: Source): void {
  try {
    after(async () => {
      await runSync(websiteId, source, { budgetMs: 50_000 });
    });
  } catch {
    // Outside a request scope (e.g. tests): the cron picks it up via next_sync_at.
  }
}

export async function requestSyncNow(userId: string, websiteId: string, source: Source): Promise<{ status: string; error?: string }> {
  await requireWebsiteAdmin(userId, websiteId);
  const r = await runSync(websiteId, source, { budgetMs: 50_000, force: true });
  return { status: r.status, error: r.error };
}

export type SyncJobRow = { id: string; source: Source; kind: string; status: string; started_at: string; finished_at: string | null; rows_written: number; error_message: string | null; data_through: string | null; duration_ms: number | null };

export async function listRecentSyncJobs(userId: string, websiteId: string, limit = 10): Promise<SyncJobRow[]> {
  await requireWebsiteAccess(userId, websiteId);
  return withUserDb(userId, (db) =>
    many<SyncJobRow>(
      db,
      `select id, source, kind, status, started_at, finished_at, rows_written, error_message, data_through::text as data_through, duration_ms
       from public.sync_jobs where website_id = $1 order by started_at desc limit $2`,
      [websiteId, limit],
    ),
  );
}
