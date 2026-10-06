import { z } from "zod";
import { withUserDb, many, one } from "@/lib/db/pool";
import { badRequest, forbidden, notFound } from "@/lib/errors";
import { getMembership } from "@/lib/orgs/service";

export const Source = z.enum(["gsc", "ga4", "ads"]);
export type Source = z.infer<typeof Source>;

export type Website = {
  id: string;
  organization_id: string;
  domain: string;
  display_name: string;
  timezone: string;
  currency: string;
  google_connection_id: string | null;
  gsc_property: string | null;
  ga4_property_id: string | null;
  google_ads_customer_id: string | null;
  google_ads_login_customer_id: string | null;
  business_conversion_event: string | null;
  revenue_event: string | null;
  primary_google_ads_conversion: string | null;
  brand_queries: string[];
  created_at: string;
};

export type WebsiteSource = {
  website_id: string;
  source: Source;
  status: "not_configured" | "ok" | "syncing" | "error" | "revoked" | "disconnected";
  backfill_done: boolean;
  last_sync_started_at: string | null;
  last_sync_succeeded_at: string | null;
  data_through: string | null;
  last_error: string | null;
  next_sync_at: string | null;
  limitations: Record<string, unknown>;
};

const WEBSITE_COLUMNS = `id, organization_id, domain, display_name, timezone, currency, google_connection_id,
  gsc_property, ga4_property_id, google_ads_customer_id, google_ads_login_customer_id,
  business_conversion_event, revenue_event, primary_google_ads_conversion, brand_queries, created_at`;

export async function listWebsites(userId: string): Promise<Website[]> {
  return withUserDb(userId, (db) => many<Website>(db, `select ${WEBSITE_COLUMNS} from public.websites order by created_at`));
}

const uuid = z.string().uuid();

/**
 * Loads a website the user can access. RLS already hides other tenants' rows; we still
 * validate the id shape and translate "no row" to 404 so callers never need to think
 * about it. Returns the membership role so write paths can check it.
 */
export async function requireWebsiteAccess(userId: string, websiteId: string): Promise<{ website: Website; role: "owner" | "admin" | "member" }> {
  if (!uuid.safeParse(websiteId).success) throw notFound("Website");
  const website = await withUserDb(userId, (db) => one<Website>(db, `select ${WEBSITE_COLUMNS} from public.websites where id = $1`, [websiteId]));
  if (!website) throw notFound("Website");
  const role = await getMembership(userId, website.organization_id);
  if (!role) throw forbidden();
  return { website, role };
}

export async function requireWebsiteAdmin(userId: string, websiteId: string): Promise<Website> {
  const { website, role } = await requireWebsiteAccess(userId, websiteId);
  if (role !== "owner" && role !== "admin") throw forbidden("Only organization owners or admins can change this website.");
  return website;
}

export const CreateWebsiteInput = z.object({
  organizationId: z.string().uuid(),
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .min(1)
    .max(253)
    .regex(/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.[a-z0-9-]{1,63})+$/, "Enter a bare domain such as example.com"),
  displayName: z.string().trim().min(1).max(120),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
});

export async function createWebsite(userId: string, input: unknown): Promise<Website> {
  const parsed = CreateWebsiteInput.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => i.message).join("; "));
  const { organizationId, domain, displayName, timezone } = parsed.data;
  const role = await getMembership(userId, organizationId);
  if (!role) throw forbidden();
  if (role === "member") throw forbidden("Only owners or admins can add websites.");
  return withUserDb(userId, async (db) => {
    const site = await one<Website>(
      db,
      `insert into public.websites (organization_id, domain, display_name, timezone)
       values ($1, $2, $3, $4) returning ${WEBSITE_COLUMNS}`,
      [organizationId, domain, displayName, timezone],
    );
    if (!site) throw new Error("website insert failed");
    for (const source of Source.options) {
      await db.query("insert into public.website_sources (website_id, organization_id, source) values ($1, $2, $3)", [site.id, organizationId, source]);
    }
    return site;
  });
}

export async function listWebsiteSources(userId: string, websiteId: string): Promise<WebsiteSource[]> {
  await requireWebsiteAccess(userId, websiteId);
  return withUserDb(userId, (db) =>
    many<WebsiteSource>(
      db,
      `select website_id, source, status, backfill_done, last_sync_started_at, last_sync_succeeded_at,
              data_through::text as data_through, last_error, next_sync_at, limitations
       from public.website_sources where website_id = $1
       order by case source when 'gsc' then 1 when 'ga4' then 2 else 3 end`,
      [websiteId],
    ),
  );
}

export const SemanticConfigInput = z.object({
  timezone: z.string().trim().min(1).max(64),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/),
  businessConversionEvent: z.string().trim().max(120).nullable(),
  revenueEvent: z.string().trim().max(120).nullable(),
  primaryGoogleAdsConversion: z.string().trim().max(200).nullable(),
  brandQueries: z.array(z.string().trim().min(1).max(120)).max(100),
});

export async function updateSemanticConfig(userId: string, websiteId: string, input: unknown): Promise<Website> {
  await requireWebsiteAdmin(userId, websiteId);
  const parsed = SemanticConfigInput.safeParse(input);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const c = parsed.data;
  const site = await withUserDb(userId, (db) =>
    one<Website>(
      db,
      `update public.websites set timezone = $2, currency = $3, business_conversion_event = $4, revenue_event = $5,
         primary_google_ads_conversion = $6, brand_queries = $7
       where id = $1 returning ${WEBSITE_COLUMNS}`,
      [websiteId, c.timezone, c.currency, c.businessConversionEvent || null, c.revenueEvent || null, c.primaryGoogleAdsConversion || null, c.brandQueries],
    ),
  );
  if (!site) throw notFound("Website");
  return site;
}
