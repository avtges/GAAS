import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTenant, seedGscTotals, asUser, type TenantFixture } from "../setup/fixtures";
import { closePool, withServiceDb } from "@/lib/db/pool";

/**
 * Cross-tenant isolation at the database layer. Every query runs under the
 * `authenticated` role with the user's JWT claims, exactly as the app does.
 */
describe("Row Level Security: tenant isolation", () => {
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    a = await createTenant("alpha");
    b = await createTenant("bravo");
    await seedGscTotals(a, 3);
    await seedGscTotals(b, 3, 99);
  });

  afterAll(async () => {
    await closePool();
  });

  it("user A sees only their own organization", async () => {
    const rows = await asUser(a.userId, (db) => db.query("select id from public.organizations").then((r) => r.rows));
    expect(rows.map((r) => r.id)).toEqual([a.orgId]);
  });

  it("user A cannot retrieve user B's website by id", async () => {
    const rows = await asUser(a.userId, (db) => db.query("select id from public.websites where id = $1", [b.websiteId]).then((r) => r.rows));
    expect(rows).toHaveLength(0);
  });

  it("user A cannot retrieve user B's analytics rows even with the right website id", async () => {
    const rows = await asUser(a.userId, (db) =>
      db.query("select clicks from public.gsc_daily_totals where website_id = $1", [b.websiteId]).then((r) => r.rows),
    );
    expect(rows).toHaveLength(0);
    const own = await asUser(a.userId, (db) =>
      db.query("select clicks from public.gsc_daily_totals where website_id = $1", [a.websiteId]).then((r) => r.rows),
    );
    expect(own).toHaveLength(3);
  });

  it("aggregate queries without a website filter only include the caller's tenants", async () => {
    const total = await asUser(a.userId, (db) =>
      db.query<{ clicks: string }>("select coalesce(sum(clicks),0)::text as clicks from public.gsc_daily_totals").then((r) => r.rows[0].clicks),
    );
    expect(Number(total)).toBe(30);
  });

  it("user A cannot update or delete user B's website", async () => {
    const updated = await asUser(a.userId, (db) => db.query("update public.websites set display_name = 'pwned' where id = $1", [b.websiteId]));
    expect(updated.rowCount).toBe(0);
    const deleted = await asUser(a.userId, (db) => db.query("delete from public.websites where id = $1", [b.websiteId]));
    expect(deleted.rowCount).toBe(0);
  });

  it("user A cannot insert a website into user B's organization (forged organization id)", async () => {
    await expect(
      asUser(a.userId, (db) =>
        db.query("insert into public.websites (organization_id, domain, display_name) values ($1, 'x.test', 'x')", [b.orgId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("user A cannot add themselves to user B's organization", async () => {
    await expect(
      asUser(a.userId, (db) =>
        db.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [b.orgId, a.userId]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("user A cannot read user B's chat threads or messages", async () => {
    const threadId = await withServiceDb(async (db) => {
      const t = await db.query<{ id: string }>(
        "insert into public.chat_threads (organization_id, website_id, created_by) values ($1, $2, $3) returning id",
        [b.orgId, b.websiteId, b.userId],
      );
      await db.query("insert into public.chat_messages (thread_id, organization_id, role, content) values ($1, $2, 'user', 'secret')", [t.rows[0].id, b.orgId]);
      return t.rows[0].id;
    });
    const threads = await asUser(a.userId, (db) => db.query("select id from public.chat_threads where id = $1", [threadId]).then((r) => r.rows));
    const messages = await asUser(a.userId, (db) => db.query("select content from public.chat_messages where thread_id = $1", [threadId]).then((r) => r.rows));
    expect(threads).toHaveLength(0);
    expect(messages).toHaveLength(0);
    const ownView = await asUser(b.userId, (db) => db.query("select content from public.chat_messages where thread_id = $1", [threadId]).then((r) => r.rows));
    expect(ownView).toHaveLength(1);
  });

  it("the encrypted refresh token column is not readable under the user role", async () => {
    await withServiceDb((db) =>
      db.query(
        `insert into public.google_connections (organization_id, google_user_id, google_email, encrypted_refresh_token, granted_scopes, created_by)
         values ($1, 'g-1', 'g@example.test', 'v1:secret', '{}', $2)`,
        [a.orgId, a.userId],
      ),
    );
    const safe = await asUser(a.userId, (db) => db.query("select id, google_email from public.google_connections").then((r) => r.rows));
    expect(safe).toHaveLength(1);
    await expect(asUser(a.userId, (db) => db.query("select encrypted_refresh_token from public.google_connections"))).rejects.toThrow(/permission denied/);
  });

  it("a brand-new user can bootstrap exactly one owner membership for an org they created, and nothing else", async () => {
    const newUser = await withServiceDb(async (db) => {
      const id = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
      await db.query("insert into auth.users (id) values ($1)", [id]);
      return id;
    });
    const orgId = await asUser(newUser, async (db) => {
      const r = await db.query<{ id: string }>("insert into public.organizations (name, created_by) values ('mine', $1) returning id", [newUser]);
      await db.query("insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'owner')", [r.rows[0].id, newUser]);
      return r.rows[0].id;
    });
    expect(orgId).toBeTruthy();
    // Cannot create an org on someone else's behalf.
    await expect(
      asUser(newUser, (db) => db.query("insert into public.organizations (name, created_by) values ('theirs', $1)", [a.userId])),
    ).rejects.toThrow(/row-level security/);
  });
});
