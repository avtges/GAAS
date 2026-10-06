import { z } from "zod";
import { withServiceDb, withUserDb, many, one } from "@/lib/db/pool";
import { decryptSecret, encryptSecret } from "@/lib/crypto/tokens";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { forbidden, notFound } from "@/lib/errors";
import { GoogleOAuthError, productsGranted, refreshAccessToken, revokeToken, type GoogleProduct } from "@/lib/google/oauth";
import { requireWebsiteAccess, requireWebsiteAdmin } from "@/lib/websites/service";

export type GoogleConnection = {
  id: string;
  organization_id: string;
  google_user_id: string;
  google_email: string | null;
  granted_scopes: string[];
  status: "active" | "revoked";
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

const SAFE_COLUMNS = "id, organization_id, google_user_id, google_email, granted_scopes, status, last_error, created_at, updated_at";

/** Connection attached to a website, read under RLS (never includes the token). */
export async function getWebsiteConnection(userId: string, websiteId: string): Promise<GoogleConnection | null> {
  const { website } = await requireWebsiteAccess(userId, websiteId);
  if (!website.google_connection_id) return null;
  return withUserDb(userId, (db) => one<GoogleConnection>(db, `select ${SAFE_COLUMNS} from public.google_connections where id = $1`, [website.google_connection_id]));
}

export async function listOrganizationConnections(userId: string, organizationId: string): Promise<GoogleConnection[]> {
  return withUserDb(userId, (db) => many<GoogleConnection>(db, `select ${SAFE_COLUMNS} from public.google_connections where organization_id = $1 order by created_at`, [organizationId]));
}

/**
 * Called by the OAuth callback (service context, after the user has been verified and
 * their admin role on the website checked). Merges scopes with any existing connection
 * for the same Google account in this organization and attaches it to the website.
 */
export async function saveConnectionFromOAuth(input: {
  userId: string;
  websiteId: string;
  googleUserId: string;
  googleEmail: string | null;
  refreshToken: string | null;
  grantedScopes: string[];
  accessTokenExpiry: Date;
}): Promise<GoogleConnection> {
  const website = await requireWebsiteAdmin(input.userId, input.websiteId);
  return withServiceDb(async (db) => {
    const existing = await one<{ id: string; granted_scopes: string[] }>(
      db,
      "select id, granted_scopes from public.google_connections where organization_id = $1 and google_user_id = $2",
      [website.organization_id, input.googleUserId],
    );
    const scopes = [...new Set([...(existing?.granted_scopes ?? []), ...input.grantedScopes])];
    let connectionId: string;
    if (existing) {
      // Google only returns a refresh token on first consent; keep the old one otherwise.
      await db.query(
        `update public.google_connections
           set granted_scopes = $2, google_email = coalesce($3, google_email), status = 'active', last_error = null,
               access_token_expiry = $4,
               encrypted_refresh_token = coalesce($5, encrypted_refresh_token)
         where id = $1`,
        [existing.id, scopes, input.googleEmail, input.accessTokenExpiry, input.refreshToken ? encryptSecret(input.refreshToken) : null],
      );
      connectionId = existing.id;
    } else {
      if (!input.refreshToken) {
        throw new GoogleOAuthError("missing_refresh_token", "Google did not return a refresh token. Reconnect and approve access again.");
      }
      const row = await one<{ id: string }>(
        db,
        `insert into public.google_connections
           (organization_id, google_user_id, google_email, encrypted_refresh_token, granted_scopes, access_token_expiry, created_by)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [website.organization_id, input.googleUserId, input.googleEmail, encryptSecret(input.refreshToken), scopes, input.accessTokenExpiry, input.userId],
      );
      connectionId = row!.id;
    }
    await db.query("update public.websites set google_connection_id = $2 where id = $1 and organization_id = $3", [website.id, connectionId, website.organization_id]);
    // Sources that were disconnected/revoked become configurable again.
    await db.query(
      `update public.website_sources set status = 'not_configured', last_error = null
       where website_id = $1 and status in ('disconnected','revoked')`,
      [website.id],
    );
    const conn = await one<GoogleConnection>(db, `select ${SAFE_COLUMNS} from public.google_connections where id = $1`, [connectionId]);
    log.info("google connection saved", { organizationId: website.organization_id, websiteId: website.id, connectionId, scopes });
    return conn!;
  });
}

type CachedToken = { accessToken: string; expiresAt: number };
const tokenCache = new Map<string, CachedToken>();

/**
 * Returns a valid access token for a connection, refreshing with the stored refresh token
 * when needed. Service context only: callers must already have authorised the user or be
 * a sync worker acting on a specific website. Marks the connection revoked on invalid_grant.
 */
export async function getAccessTokenForConnection(connectionId: string): Promise<{ accessToken: string; grantedScopes: string[] }> {
  if (!z.string().uuid().safeParse(connectionId).success) throw notFound("Connection");
  const env = getEnv();
  const row = await withServiceDb((db) =>
    one<{ encrypted_refresh_token: string; granted_scopes: string[]; status: string; organization_id: string }>(
      db,
      "select encrypted_refresh_token, granted_scopes, status, organization_id from public.google_connections where id = $1",
      [connectionId],
    ),
  );
  if (!row) throw notFound("Connection");
  if (row.status === "revoked") throw new GoogleOAuthError("invalid_grant", "Google access was revoked. Reconnect Google.");

  const cached = tokenCache.get(connectionId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return { accessToken: cached.accessToken, grantedScopes: row.granted_scopes };

  if (env.GOOGLE_PROVIDER_MODE === "mock") {
    tokenCache.set(connectionId, { accessToken: `mock-access-token-${connectionId}`, expiresAt: Date.now() + 3600_000 });
    return { accessToken: `mock-access-token-${connectionId}`, grantedScopes: row.granted_scopes };
  }

  const refreshToken = decryptSecret(row.encrypted_refresh_token);
  try {
    const tokens = await refreshAccessToken(refreshToken);
    const expiresAt = Date.now() + tokens.expires_in * 1000;
    tokenCache.set(connectionId, { accessToken: tokens.access_token, expiresAt });
    const scopes = tokens.scope ? tokens.scope.split(" ") : row.granted_scopes;
    await withServiceDb((db) =>
      db.query("update public.google_connections set access_token_expiry = $2, granted_scopes = $3, last_error = null where id = $1", [
        connectionId,
        new Date(expiresAt),
        scopes,
      ]),
    );
    return { accessToken: tokens.access_token, grantedScopes: scopes };
  } catch (e) {
    if (e instanceof GoogleOAuthError && e.isRevoked) {
      await markConnectionRevoked(connectionId, e.message);
    }
    throw e;
  }
}

export async function markConnectionRevoked(connectionId: string, reason: string): Promise<void> {
  tokenCache.delete(connectionId);
  await withServiceDb(async (db) => {
    await db.query("update public.google_connections set status = 'revoked', last_error = $2 where id = $1", [connectionId, reason]);
    await db.query(
      `update public.website_sources s set status = 'revoked', last_error = $2, next_sync_at = null
       from public.websites w where w.id = s.website_id and w.google_connection_id = $1 and s.status <> 'not_configured'`,
      [connectionId, "Google access was revoked or expired. Reconnect Google."],
    );
  });
  log.warn("google connection revoked", { connectionId });
}

/**
 * Disconnect Google for a website: revoke the refresh token at Google (best effort),
 * delete the connection (the website's reference is nulled by FK) and stop syncs.
 * Imported analytics data is kept until the user explicitly deletes it.
 */
export async function disconnectGoogle(userId: string, websiteId: string): Promise<void> {
  const website = await requireWebsiteAdmin(userId, websiteId);
  if (!website.google_connection_id) return;
  const connectionId = website.google_connection_id;
  const env = getEnv();
  const row = await withServiceDb((db) =>
    one<{ encrypted_refresh_token: string; organization_id: string }>(db, "select encrypted_refresh_token, organization_id from public.google_connections where id = $1", [connectionId]),
  );
  if (!row) return;
  if (row.organization_id !== website.organization_id) throw forbidden();
  if (env.GOOGLE_PROVIDER_MODE === "live") {
    try {
      await revokeToken(decryptSecret(row.encrypted_refresh_token));
    } catch (e) {
      log.warn("revoke failed; deleting local connection anyway", { connectionId, error: (e as Error).message });
    }
  }
  tokenCache.delete(connectionId);
  await withServiceDb(async (db) => {
    await db.query(
      `update public.website_sources s set status = 'disconnected', next_sync_at = null, last_error = 'Google disconnected'
       from public.websites w where w.id = s.website_id and w.google_connection_id = $1 and w.organization_id = $2
         and s.status <> 'not_configured'`,
      [connectionId, website.organization_id],
    );
    await db.query("delete from public.google_connections where id = $1 and organization_id = $2", [connectionId, website.organization_id]);
  });
  log.info("google disconnected", { organizationId: website.organization_id, websiteId, connectionId });
}

export function connectionProducts(conn: GoogleConnection | null): Record<GoogleProduct, boolean> {
  return conn && conn.status === "active" ? productsGranted(conn.granted_scopes) : { gsc: false, ga4: false, ads: false };
}

/** Test helper. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
