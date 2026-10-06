import { after } from "next/server";
import { z } from "zod";
import { withServiceDb, withUserDb, many } from "@/lib/db/pool";
import { badRequest, forbidden } from "@/lib/errors";
import { getAccessTokenForConnection, getWebsiteConnection, connectionProducts } from "@/lib/google/connections";
import { getSearchConsoleProvider, type SiteEntry } from "@/lib/providers/search-console";
import { getGa4Provider, type KeyEvent } from "@/lib/providers/ga4";
import { getGoogleAdsProvider, type AdsAccount } from "@/lib/providers/google-ads";
import { GoogleApiError } from "@/lib/providers/errors";
import { isValidTimeZone } from "@/lib/dates";
import { requireWebsiteAccess, requireWebsiteAdmin, type Source } from "@/lib/websites/service";
import { runUntilComplete } from "@/lib/sync/runner";
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
      // Within Vercel's 300s Fluid-compute limit; anything left resumes on the next run.
      await runUntilComplete(websiteId, source, { totalBudgetMs: 240_000 });
    });
  } catch {
    // Outside a request scope (e.g. tests): the cron picks it up via next_sync_at.
  }
}

/** Starts a sync in the background and returns immediately; the status bar shows progress. */
export async function requestSyncNow(userId: string, websiteId: string, source: Source): Promise<{ status: string }> {
  await requireWebsiteAdmin(userId, websiteId);
  try {
    after(async () => {
      await runUntilComplete(websiteId, source, { totalBudgetMs: 240_000, force: true });
    });
    return { status: "started" };
  } catch {
    // Outside a request scope (tests/scripts): run inline.
    const r = await runUntilComplete(websiteId, source, { totalBudgetMs: 240_000, force: true });
    return { status: r.status };
  }
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

export type Ga4PropertyOption = { propertyId: string; displayName: string; account: string; propertyType: string };

export async function listAvailableGa4Properties(userId: string, websiteId: string): Promise<Ga4PropertyOption[]> {
  const connectionId = await connectionForProduct(userId, websiteId, "ga4");
  const { accessToken } = await getAccessTokenForConnection(connectionId);
  const summaries = await getGa4Provider().listAccountSummaries({ accessToken });
  const out: Ga4PropertyOption[] = [];
  for (const a of summaries) {
    for (const p of a.propertySummaries ?? []) {
      const id = p.property.replace(/^properties\//, "");
      if (!/^\d+$/.test(id)) continue;
      out.push({ propertyId: id, displayName: p.displayName ?? id, account: a.displayName ?? a.account, propertyType: p.propertyType ?? "PROPERTY_TYPE_UNSPECIFIED" });
    }
  }
  return out;
}

export async function selectGa4Property(userId: string, websiteId: string, input: unknown): Promise<void> {
  const parsed = z.object({ propertyId: z.string().regex(/^\d{1,20}$/) }).safeParse(input);
  if (!parsed.success) throw badRequest("Choose a GA4 property.");
  const website = await requireWebsiteAdmin(userId, websiteId);
  const available = await listAvailableGa4Properties(userId, websiteId);
  if (!available.some((p) => p.propertyId === parsed.data.propertyId)) throw forbidden("That GA4 property is not available to the connected Google account.");
  const connectionId = await connectionForProduct(userId, websiteId, "ga4");
  const { accessToken } = await getAccessTokenForConnection(connectionId);
  // Default the website's time zone / currency from the property when still at defaults.
  const prop = await getGa4Provider().getProperty({ accessToken }, parsed.data.propertyId).catch(() => null);
  const tz = prop?.timeZone && isValidTimeZone(prop.timeZone) ? prop.timeZone : null;
  const currency = prop?.currencyCode && /^[A-Z]{3}$/.test(prop.currencyCode) ? prop.currencyCode : null;
  await withServiceDb((db) =>
    db.query(
      `update public.websites set ga4_property_id = $3,
         timezone = case when timezone = 'UTC' and $4::text is not null then $4 else timezone end,
         currency = case when currency = 'USD' and $5::text is not null then $5 else currency end
       where id = $1 and organization_id = $2`,
      [websiteId, website.organization_id, parsed.data.propertyId, tz, currency],
    ),
  );
  await resetSourceData(website.organization_id, websiteId, "ga4", "ok");
  log.info("ga4 property selected", { organizationId: website.organization_id, websiteId, propertyId: parsed.data.propertyId });
  scheduleImmediateSync(websiteId, "ga4");
}

/** Key events configured in the selected GA4 property (for the semantic-configuration form). */
export async function listGa4KeyEvents(userId: string, websiteId: string): Promise<KeyEvent[]> {
  const { website } = await requireWebsiteAccess(userId, websiteId);
  if (!website.ga4_property_id || !website.google_connection_id) return [];
  const { accessToken } = await getAccessTokenForConnection(website.google_connection_id);
  return getGa4Provider().listKeyEvents({ accessToken }, website.ga4_property_id);
}

/**
 * Google Ads accounts the user can report on: every directly accessible account, plus the
 * direct client accounts of accessible manager accounts (reached via login-customer-id).
 * Manager accounts themselves have no campaigns and are not selectable.
 */
export async function listAvailableAdsAccounts(userId: string, websiteId: string): Promise<{ accounts: AdsAccount[]; errors: string[] }> {
  const connectionId = await connectionForProduct(userId, websiteId, "ads");
  const { accessToken } = await getAccessTokenForConnection(connectionId);
  const provider = getGoogleAdsProvider();
  const ids = (await provider.listAccessibleCustomers({ accessToken })).slice(0, 50);
  const accounts = new Map<string, AdsAccount>();
  const errors: string[] = [];
  for (const id of ids) {
    try {
      const c = await provider.getCustomer({ accessToken }, id);
      if (c.manager) {
        for (const child of await provider.listClientAccounts({ accessToken }, id)) {
          if (!child.manager && !accounts.has(child.customerId)) accounts.set(child.customerId, child);
        }
      } else {
        accounts.set(c.customerId, c);
      }
    } catch (e) {
      // e.g. a cancelled account or one the developer token level cannot access
      errors.push(`${id}: ${e instanceof GoogleApiError ? e.message : (e as Error).message}`);
    }
  }
  return { accounts: [...accounts.values()].sort((a, b) => a.descriptiveName.localeCompare(b.descriptiveName)), errors };
}

export async function selectAdsAccount(userId: string, websiteId: string, input: unknown): Promise<void> {
  const parsed = z.object({ customerId: z.string().regex(/^\d{10}$/) }).safeParse(input);
  if (!parsed.success) throw badRequest("Choose a Google Ads account.");
  const website = await requireWebsiteAdmin(userId, websiteId);
  const { accounts } = await listAvailableAdsAccounts(userId, websiteId);
  const account = accounts.find((a) => a.customerId === parsed.data.customerId);
  if (!account) throw forbidden("That Google Ads account is not available to the connected Google account.");
  await withServiceDb((db) =>
    db.query("update public.websites set google_ads_customer_id = $3, google_ads_login_customer_id = $4 where id = $1 and organization_id = $2", [websiteId, website.organization_id, account.customerId, account.loginCustomerId]),
  );
  await resetSourceData(website.organization_id, websiteId, "ads", "ok");
  await withServiceDb((db) =>
    db.query("update public.website_sources set limitations = $3::jsonb where website_id = $1 and organization_id = $2 and source = 'ads'", [
      websiteId,
      website.organization_id,
      JSON.stringify({ account_time_zone: account.timeZone, account_currency: account.currencyCode, account_name: account.descriptiveName }),
    ]),
  );
  log.info("ads account selected", { organizationId: website.organization_id, websiteId, customerId: account.customerId, viaManager: account.loginCustomerId });
  scheduleImmediateSync(websiteId, "ads");
}
