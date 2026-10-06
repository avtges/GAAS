import { randomUUID } from "node:crypto";
import { withServiceDb, withUserDb, type DbClient } from "@/lib/db/pool";

export type TenantFixture = {
  userId: string;
  orgId: string;
  websiteId: string;
};

/** Creates a user, organization (owner membership) and website in service context. */
export async function createTenant(label: string): Promise<TenantFixture> {
  const userId = randomUUID();
  return withServiceDb(async (db) => {
    await db.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [userId, `${label}-${userId.slice(0, 8)}@example.test`]);
    await db.query("insert into public.users (id, email) values ($1, $2)", [userId, `${label}@example.test`]);
    const org = await db.query<{ id: string }>(
      "insert into public.organizations (name, created_by) values ($1, $2) returning id",
      [`${label} org`, userId],
    );
    const orgId = org.rows[0].id;
    await db.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [orgId, userId]);
    const site = await db.query<{ id: string }>(
      "insert into public.websites (organization_id, domain, display_name) values ($1, $2, $3) returning id",
      [orgId, `${label}.example.test`, `${label} site`],
    );
    const websiteId = site.rows[0].id;
    for (const source of ["gsc", "ga4", "ads"]) {
      await db.query("insert into public.website_sources (website_id, organization_id, source) values ($1, $2, $3)", [websiteId, orgId, source]);
    }
    return { userId, orgId, websiteId };
  });
}

export async function seedGscTotals(t: TenantFixture, days: number, clicksPerDay = 10): Promise<void> {
  await withServiceDb(async (db) => {
    for (let i = 0; i < days; i++) {
      const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
      await db.query(
        `insert into public.gsc_daily_totals (website_id, organization_id, date, clicks, impressions, position_impressions)
         values ($1, $2, $3, $4, $5, $6)`,
        [t.websiteId, t.orgId, d, clicksPerDay, clicksPerDay * 20, clicksPerDay * 20 * 8.5],
      );
    }
  });
}

export const asUser = withUserDb;
export type { DbClient };
