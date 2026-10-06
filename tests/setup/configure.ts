import { withServiceDb } from "@/lib/db/pool";
import { saveConnectionFromOAuth } from "@/lib/google/connections";
import { scopesFor } from "@/lib/google/oauth";
import { resetSourceData } from "@/lib/sources/select";
import type { TenantFixture } from "./fixtures";

/** Connects mock Google with all scopes and selects the mock properties for all three sources. */
export async function configureAllSources(t: TenantFixture): Promise<void> {
  await saveConnectionFromOAuth({ userId: t.userId, websiteId: t.websiteId, googleUserId: `g-${t.userId}`, googleEmail: null, refreshToken: "1//mock", grantedScopes: scopesFor(["gsc", "ga4", "ads"]), accessTokenExpiry: new Date() });
  await withServiceDb((db) =>
    db.query("update public.websites set gsc_property = 'sc-domain:acme.example', ga4_property_id = '123456789', google_ads_customer_id = '9876543210', google_ads_login_customer_id = '1234567890' where id = $1", [t.websiteId]),
  );
  for (const s of ["gsc", "ga4", "ads"] as const) await resetSourceData(t.orgId, t.websiteId, s, "ok");
  await withServiceDb((db) => db.query("update public.website_sources set limitations = '{\"account_time_zone\":\"America/New_York\"}'::jsonb where website_id = $1 and source = 'ads'", [t.websiteId]));
}
