import { z } from "zod";
import { withUserDb, many, one } from "@/lib/db/pool";
import { badRequest } from "@/lib/errors";

export const OrgRole = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRole>;

export type Organization = { id: string; name: string; role: OrgRole; created_at: string };

export async function listOrganizations(userId: string): Promise<Organization[]> {
  return withUserDb(userId, (db) =>
    many<Organization>(
      db,
      `select o.id, o.name, m.role, o.created_at
       from public.organizations o
       join public.organization_members m on m.organization_id = o.id and m.user_id = $1
       order by o.created_at`,
      [userId],
    ),
  );
}

export const CreateOrganizationInput = z.object({ name: z.string().trim().min(1).max(120) });

export async function createOrganization(userId: string, input: unknown): Promise<Organization> {
  const parsed = CreateOrganizationInput.safeParse(input);
  if (!parsed.success) throw badRequest("Organization name is required (max 120 characters).");
  return withUserDb(userId, async (db) => {
    const org = await one<{ id: string; name: string; created_at: string }>(
      db,
      "insert into public.organizations (name, created_by) values ($1, $2) returning id, name, created_at",
      [parsed.data.name, userId],
    );
    if (!org) throw new Error("organization insert failed");
    await db.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [org.id, userId]);
    return { ...org, role: "owner" as const };
  });
}

/** Membership lookup under RLS; returns null when the user is not a member. */
export async function getMembership(userId: string, organizationId: string): Promise<OrgRole | null> {
  if (!z.string().uuid().safeParse(organizationId).success) return null;
  const row = await withUserDb(userId, (db) =>
    one<{ role: OrgRole }>(db, "select role from public.organization_members where organization_id = $1 and user_id = $2", [organizationId, userId]),
  );
  return row?.role ?? null;
}

/** Ensures the user has at least one organization; creates a personal one otherwise. */
export async function ensureDefaultOrganization(userId: string, email: string | null): Promise<Organization> {
  const orgs = await listOrganizations(userId);
  if (orgs.length > 0) return orgs[0];
  return createOrganization(userId, { name: email ? `${email.split("@")[0]}'s workspace` : "My workspace" });
}
