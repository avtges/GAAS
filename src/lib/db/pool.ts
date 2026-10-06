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

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const SSL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat", "ssl"];

/**
 * TLS settings for the database connection.
 * - Local hosts: no TLS.
 * - DATABASE_SSL_CA set (PEM, or base64 of PEM): TLS with full certificate verification.
 *   Supabase signs database certificates with its own CA; download it from
 *   Project Settings → Database → SSL Configuration.
 * - Otherwise for remote hosts: TLS without certificate verification (traffic is encrypted
 *   but the server identity is not checked). A warning is logged once.
 * SSL parameters in the URL are removed because node-postgres lets them override these
 * options (and treats sslmode=require as verify-full, which fails against Supabase's CA).
 */
export function pgConnectionConfig(databaseUrl: string, caInput?: string): { connectionString: string; ssl: false | { rejectUnauthorized: boolean; ca?: string } } {
  const url = new URL(databaseUrl);
  if (LOCAL_HOSTS.has(url.hostname)) return { connectionString: databaseUrl, ssl: false };
  for (const k of SSL_PARAMS) url.searchParams.delete(k);
  const connectionString = url.toString();
  if (caInput && caInput.trim()) {
    const ca = caInput.includes("BEGIN CERTIFICATE") ? caInput : Buffer.from(caInput, "base64").toString("utf8");
    if (!ca.includes("BEGIN CERTIFICATE")) throw new Error("DATABASE_SSL_CA must be a PEM certificate (or base64 of one).");
    return { connectionString, ssl: { rejectUnauthorized: true, ca } };
  }
  return { connectionString, ssl: { rejectUnauthorized: false } };
}

export function getPool(): Pool {
  if (!pool) {
    const env = getEnv();
    const conn = pgConnectionConfig(env.DATABASE_URL, env.DATABASE_SSL_CA);
    if (conn.ssl && !conn.ssl.ca) {
      console.warn(JSON.stringify({ level: "warn", msg: "database TLS is encrypted but the server certificate is not verified; set DATABASE_SSL_CA to verify it" }));
    }
    pool = new Pool({
      connectionString: conn.connectionString,
      ssl: conn.ssl,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
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
