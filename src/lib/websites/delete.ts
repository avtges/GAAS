import { withServiceDb, many } from "@/lib/db/pool";
import { log } from "@/lib/logger";
import { disconnectGoogle } from "@/lib/google/connections";
import { requireWebsiteAdmin } from "@/lib/websites/service";

const ANALYTICS_TABLES = [
  "gsc_daily_totals", "gsc_query_daily", "gsc_page_daily", "gsc_device_daily", "gsc_country_daily",
  "ga4_daily_totals", "ga4_acquisition_daily", "ga4_landing_page_daily", "ga4_device_daily", "ga4_event_daily",
  "ads_campaign_daily", "ads_ad_group_daily", "ads_keyword_daily", "ads_search_term_daily", "ads_device_daily", "ads_conversion_action_daily",
];

/**
 * Deletes all imported analytics data, sync history and chats for a website, clears the
 * source selections, and removes the Google credentials if no other website in the
 * organization uses them. The website itself remains so it can be reconnected.
 */
export async function deleteWebsiteData(userId: string, websiteId: string): Promise<{ rowsDeleted: number; credentialsRemoved: boolean }> {
  const website = await requireWebsiteAdmin(userId, websiteId);
  const credentialsRemoved = await removeCredentialsIfUnused(userId, websiteId, website.google_connection_id, website.organization_id);
  const rowsDeleted = await withServiceDb(async (db) => {
    let n = 0;
    for (const t of ANALYTICS_TABLES) {
      const r = await db.query(`delete from public.${t} where website_id = $1 and organization_id = $2`, [websiteId, website.organization_id]);
      n += r.rowCount ?? 0;
    }
    n += (await db.query("delete from public.sync_jobs where website_id = $1 and organization_id = $2", [websiteId, website.organization_id])).rowCount ?? 0;
    n += (await db.query("delete from public.chat_threads where website_id = $1 and organization_id = $2", [websiteId, website.organization_id])).rowCount ?? 0;
    await db.query(
      `update public.websites set gsc_property = null, ga4_property_id = null, google_ads_customer_id = null, google_ads_login_customer_id = null
       where id = $1 and organization_id = $2`,
      [websiteId, website.organization_id],
    );
    await db.query(
      `update public.website_sources set status = 'not_configured', backfill_done = false, backfill_cursor = null, data_through = null,
         last_sync_started_at = null, last_sync_succeeded_at = null, last_error = null, next_sync_at = null, limitations = '{}'::jsonb
       where website_id = $1 and organization_id = $2`,
      [websiteId, website.organization_id],
    );
    return n;
  });
  log.info("website data deleted", { organizationId: website.organization_id, websiteId, rowsDeleted, credentialsRemoved });
  return { rowsDeleted, credentialsRemoved };
}

/** Deletes the website and everything attached to it (cascades), plus unused credentials. */
export async function deleteWebsite(userId: string, websiteId: string): Promise<void> {
  const website = await requireWebsiteAdmin(userId, websiteId);
  await removeCredentialsIfUnused(userId, websiteId, website.google_connection_id, website.organization_id);
  await withServiceDb((db) => db.query("delete from public.websites where id = $1 and organization_id = $2", [websiteId, website.organization_id]));
  log.info("website deleted", { organizationId: website.organization_id, websiteId });
}

async function removeCredentialsIfUnused(userId: string, websiteId: string, connectionId: string | null, organizationId: string): Promise<boolean> {
  if (!connectionId) return false;
  const others = await withServiceDb((db) =>
    many<{ id: string }>(db, "select id from public.websites where google_connection_id = $1 and organization_id = $2 and id <> $3", [connectionId, organizationId, websiteId]),
  );
  if (others.length > 0) {
    // Another website still uses this Google connection: only detach it from this one.
    await withServiceDb((db) => db.query("update public.websites set google_connection_id = null where id = $1 and organization_id = $2", [websiteId, organizationId]));
    return false;
  }
  await disconnectGoogle(userId, websiteId); // revokes at Google and deletes the encrypted token
  return true;
}
