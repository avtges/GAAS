import { Pool, type PoolClient, type QueryResultRow } from "pg";
import { getEnv } from "@/lib/env";

/**
 * Database access layer.
 *
 * - withUserDb(userId, fn): every statement runs as the Postgres role `authenticated`
 *   with `request.jwt.claims.sub = userId`, so Row Level Security policies apply exactly
 *   as they do for Supabase's PostgREST. This is the ONLY way application code may read
 *   tenant data on behalf of a user.
 * - withServiceDb(fn): runs as the connection's own role (the migration owner), used by
 *   sync workers and OAuth callbacks. Callers MUST scope every statement by
 *   organization_id / website_id explicitly.
 */

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const env = getEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30_000,
      // Supabase requires TLS; local Postgres does not. The URL's sslmode decides.
    });
    pool.on("error", (err) => {
      console.error(JSON.stringify({ level: "error", msg: "pg pool error", error: err.message }));
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type DbClient = PoolClient;

export async function withServiceDb<T>(fn: (db: DbClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function withUserDb<T>(userId: string, fn: (db: DbClient) => Promise<T>): Promise<T> {
  if (!UUID_RE.test(userId)) throw new Error("withUserDb: userId must be a UUID");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE authenticated");
    const claims = JSON.stringify({ sub: userId, role: "authenticated" });
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [claims]);
    await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [userId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

/** Small typed helpers. */
export async function one<T extends QueryResultRow>(db: DbClient, text: string, params: unknown[] = []): Promise<T | null> {
  const r = await db.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T extends QueryResultRow>(db: DbClient, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query<T>(text, params);
  return r.rows;
}
